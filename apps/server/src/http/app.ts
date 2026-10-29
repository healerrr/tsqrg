import { timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { Server } from 'socket.io';
import { ZodError } from 'zod';
import { claimInviteSchema, createFishSchema, uuidSchema, type MatchMode, type MatchResultView, type PublicPlayerCard } from '@aquarium/protocol';
import { basePower, config, levelFromXp } from '@aquarium/core';
import { pool, ready, setReady, acquireMainInstance, releaseMainInstance, ownerEpoch } from '../persistence/db';
import { createGuest, createFish, claimInvite, selfView, userFromToken } from '../services/identity';
import { durable, hash } from '../services/economy';
import { databaseMetrics, enforceReconciliation, reconcile } from '../services/operations';
import { assertAssetWritesAllowed, pauseAssetWrites, resumeAssetWrites } from '../services/write-guard';
import { World } from '../simulation/world';
import { AppError, assert } from './errors';
import { registerGrowthRoutes } from './growth';
import { registerShopRoutes } from './shop';
import { registerMatchRoutes } from './matches';
import { registerGuildRoutes } from './guilds';
import { registerAdminRoutes } from './admin';
import { installBattles } from '../simulation/battle';

declare module 'fastify' { interface FastifyRequest { userId: string | null } }

export async function createApp() {
  const production = process.env.NODE_ENV === 'production';
  const metricsToken = process.env.OPS_METRICS_TOKEN ?? '';
  if (production && (
    !process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32 ||
    !process.env.DATABASE_URL || !process.env.APP_ORIGIN || metricsToken.length < 24
  )) throw new Error('生产环境必须配置 DATABASE_URL、APP_ORIGIN、至少32字符 SESSION_SECRET 与至少24字符 OPS_METRICS_TOKEN');

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: ['req.headers.cookie', 'req.headers.authorization', 'req.body.inviteCode', 'res.headers.set-cookie'],
    },
    bodyLimit: config.upload.maxBytes + 65536,
  });
  const origins = production
    ? [process.env.APP_ORIGIN!]
    : [process.env.APP_ORIGIN ?? 'http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:3000', 'http://127.0.0.1:3000'];
  await app.register(cookie, { secret: process.env.SESSION_SECRET ?? 'development-only-aquarium-cookie-secret-please-replace', hook: 'onRequest' });
  await app.register(cors, { origin: origins, credentials: true });
  app.decorateRequest('userId', null);

  const tokenFrom = (header: string | undefined) => {
    const parsed = app.parseCookie(header ?? '');
    if (!parsed.aquarium_session) return undefined;
    const unsigned = app.unsignCookie(parsed.aquarium_session);
    return unsigned.valid ? unsigned.value! : undefined;
  };
  const mutationBuckets = new Map<string, { second: number; count: number }>();
  let failedPurchaseCount = 0, httpRequestsTotal = 0, httpErrorResponsesTotal = 0;
  app.addHook('onRequest', async request => {
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS' && request.headers.origin) {
      assert(origins.includes(request.headers.origin), 'AUTH_REQUIRED', '请求来源不受信任', 403);
    }
    request.userId = await userFromToken(tokenFrom(request.headers.cookie));
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS' && request.url.startsWith('/api/v1/')) {
      const bucketKey = request.userId ?? `ip:${request.ip}`;
      const limit = request.userId ? 5 : 30;
      const second = Math.floor(Date.now() / 1000);
      const bucket = mutationBuckets.get(bucketKey);
      if (!bucket || bucket.second !== second) mutationBuckets.set(bucketKey, { second, count: 1 });
      else {
        bucket.count++;
        assert(bucket.count <= limit, 'RATE_LIMITED', '操作过于频繁，请稍后再试', 429);
      }
    }
  });
  app.addHook('onSend', async (request, reply) => {
    if (request.url.startsWith('/api/v1/')) reply.header('Cache-Control', 'no-store');
  });
  app.addHook('onResponse', async (request, reply) => {
    if (!request.url.startsWith('/api/v1/') && request.url !== '/metrics') return;
    httpRequestsTotal++;
    if (reply.statusCode >= 400) httpErrorResponsesTotal++;
    const route = request.routeOptions.url ?? request.url.split('?')[0];
    request.log.info({
      requestId: request.id,
      userId: request.userId,
      matchId: (request.params as { id?: string } | null)?.id,
      operationSource: `${request.method}:${route}`,
      statusCode: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime * 100) / 100,
    }, 'API 请求完成');
  });
  app.setErrorHandler((error, request, reply) => {
    const validationMessage = error instanceof ZodError && /[\u3400-\u9fff]/.test(error.issues[0]?.message ?? '')
      ? error.issues[0].message
      : '请求参数无效，请检查输入内容';
    const e = error instanceof AppError
      ? error
      : error instanceof ZodError
        ? new AppError('VERSION_CONFLICT', validationMessage, 400)
        : new AppError('VERSION_CONFLICT', '服务暂时不可用，请稍后重试', 500);
    if (request.url.includes('/shop/') && request.method !== 'GET') failedPurchaseCount++;
    const detail = { err: error, requestId: request.id, userId: request.userId, matchId: (request.params as { id?: string } | null)?.id, errorCode: e.code };
    if (e.status >= 500) request.log.error(detail, '请求失败'); else request.log.warn(detail, '请求被拒绝');
    reply.status(e.status).send({ error: { code: e.code, message: e.message }, requestId: request.id });
  });

  const io = new Server(app.server, {
    cors: { origin: origins, credentials: true },
    maxHttpBufferSize: 65536,
    allowRequest: (req, callback) => callback(null, !req.headers.origin || origins.includes(req.headers.origin)),
  });
  const world = new World(io);
  let socketConnectionsTotal = 0, socketDisconnectsTotal = 0;
  const auth = (request: { userId: string | null }): string => {
    assert(request.userId, 'AUTH_REQUIRED', '请先进入游戏', 401);
    return request.userId;
  };
  const key = (request: { headers: Record<string, unknown> }): string => String(request.headers['idempotency-key'] ?? '');
  const ok = (data: unknown, requestId: string) => ({ data, requestId });
  const { matches, battle } = await installBattles(world);

  const runtimeOverview = async () => {
    const times = [...world.tickTimes].sort((a, b) => a - b);
    return {
      instanceId: ownerEpoch,
      uptimeSeconds: process.uptime(),
      connections: world.connections.size,
      rooms: world.roomEpochs.size,
      serverTick: world.serverTick,
      tickP95Ms: times[Math.min(times.length - 1, Math.floor(times.length * 0.95))] ?? 0,
      memory: process.memoryUsage(),
      failedPurchaseCount,
      httpRequestsTotal,
      httpErrorResponsesTotal,
      socketConnectionsTotal,
      socketDisconnectsTotal,
      database: await databaseMetrics(),
    };
  };

  registerGrowthRoutes(app, world);
  await registerShopRoutes(app, world);
  registerGuildRoutes(app, world);
  registerMatchRoutes({ app, auth, key, ok, matches });
  registerAdminRoutes(app, world, runtimeOverview);

  io.of('/game').use(async (socket, next) => {
    try {
      const userId = await userFromToken(tokenFrom(socket.request.headers.cookie));
      assert(userId, 'AUTH_REQUIRED', '会话已失效，请重新进入', 401);
      socket.data.userId = userId;
      next();
    } catch { next(new Error('会话已失效，请重新进入')); }
  });
  io.of('/game').on('connection', socket => {
    socketConnectionsTotal++;
    socket.once('disconnect', () => { socketDisconnectsTotal++; });
    void world.connect(socket, socket.data.userId).catch(error => { app.log.error(error); socket.disconnect(true); });
  });

  app.post('/api/v1/auth/guest', async (request, reply) => {
    if (!request.userId) {
      assertAssetWritesAllowed();
      const guest = await createGuest();
      request.userId = guest.userId;
      reply.setCookie('aquarium_session', guest.token, { path: '/', httpOnly: true, secure: production, sameSite: 'lax', maxAge: 90 * 86400, signed: true });
    }
    return ok(await selfView(request.userId), request.id);
  });
  app.get('/api/v1/me', async request => ok(await selfView(auth(request)), request.id));
  app.post('/api/v1/fish', async request => {
    const userId = auth(request), payload = createFishSchema.parse(request.body);
    const data = await createFish(userId, key(request), payload);
    await world.refreshPlayer(userId); world.invalidate(userId);
    return ok(data, request.id);
  });
  app.post('/api/v1/auth/claim', async request => {
    const userId = auth(request), payload = claimInviteSchema.parse(request.body);
    const data = await claimInvite(userId, key(request), payload.inviteCode);
    await world.refreshPlayer(userId); world.invalidate(userId);
    return ok(data, request.id);
  });
  app.post('/api/v1/auth/logout', async (request, reply) => {
    const userId = auth(request), token = tokenFrom(request.headers.cookie);
    const data = await durable(userId, 'auth:logout', key(request), {}, async client => {
      if (token) await client.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1', [hash(token)]);
      return { loggedOut: true };
    }, { allowWhenPaused: true });
    for (const connection of world.connections.values()) if (connection.userId === request.userId) connection.socket.disconnect(true);
    reply.clearCookie('aquarium_session', { path: '/' });
    return ok(data, request.id);
  });

  app.get('/api/v1/health/live', async request => ok({ status: 'alive' }, request.id));
  app.get('/api/v1/health/ready', async (request, reply) => {
    let database = false;
    try { await pool.query('SELECT 1'); database = true; }
    catch {
      pauseAssetWrites('database', '数据库健康检查失败');
      setReady(false);
    }
    if (!ready || !database) reply.status(503);
    return ok({ status: ready && database ? 'ready' : 'unavailable', database, rulesVersion: config.rulesVersion, protocolVersion: 1 }, request.id);
  });
  app.get('/health/live', async () => ({ status: 'alive' }));
  app.get('/health/ready', async (_request, reply) => {
    try { await pool.query('SELECT 1'); if (!ready) reply.status(503); }
    catch { pauseAssetWrites('database', '数据库健康检查失败'); setReady(false); reply.status(503); }
    return { ready };
  });
  app.get('/api/v1/metrics', async request => {
    auth(request);
    const overview = await runtimeOverview();
    const { database: _database, failedPurchaseCount: _failed, ...basic } = overview;
    return ok(basic, request.id);
  });
  app.get('/metrics', async (request, reply) => {
    const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
    const expected = Buffer.from(metricsToken), actual = Buffer.from(supplied);
    assert(expected.length > 0 && expected.length === actual.length && timingSafeEqual(expected, actual), 'AUTH_REQUIRED', '监控凭据无效', 401);
    const overview = await runtimeOverview();
    const db = overview.database as Awaited<ReturnType<typeof databaseMetrics>>;
    const lines = [
      '# HELP aquarium_connections Current Socket.IO connections',
      '# TYPE aquarium_connections gauge',
      `aquarium_connections ${overview.connections}`,
      '# TYPE aquarium_tick_p95_ms gauge',
      `aquarium_tick_p95_ms ${overview.tickP95Ms}`,
      '# TYPE aquarium_process_resident_memory_bytes gauge',
      `aquarium_process_resident_memory_bytes ${overview.memory.rss}`,
      '# TYPE aquarium_failed_purchases_total counter',
      `aquarium_failed_purchases_total ${overview.failedPurchaseCount}`,
      '# TYPE aquarium_http_requests_total counter',
      `aquarium_http_requests_total ${overview.httpRequestsTotal}`,
      '# TYPE aquarium_http_error_responses_total counter',
      `aquarium_http_error_responses_total ${overview.httpErrorResponsesTotal}`,
      '# TYPE aquarium_socket_connections_total counter',
      `aquarium_socket_connections_total ${overview.socketConnectionsTotal}`,
      '# TYPE aquarium_socket_disconnects_total counter',
      `aquarium_socket_disconnects_total ${overview.socketDisconnectsTotal}`,
      '# TYPE aquarium_frozen_power gauge',
      `aquarium_frozen_power ${db.held_power}`,
      '# TYPE aquarium_active_matches gauge',
      `aquarium_active_matches ${db.active_matches}`,
      '# TYPE aquarium_pending_settlements gauge',
      `aquarium_pending_settlements ${db.pending_settlements}`,
      '# TYPE aquarium_oldest_settlement_seconds gauge',
      `aquarium_oldest_settlement_seconds ${db.oldest_settlement_seconds}`,
      '# TYPE aquarium_outbox_pending gauge',
      `aquarium_outbox_pending ${db.outbox_pending}`,
      '# TYPE aquarium_oldest_outbox_seconds gauge',
      `aquarium_oldest_outbox_seconds ${db.oldest_outbox_seconds}`,
      '# TYPE aquarium_db_pool_waiting gauge',
      `aquarium_db_pool_waiting ${db.pool.waiting}`,
      '',
    ];
    reply.type('text/plain; version=0.0.4; charset=utf-8');
    return lines.join('\n');
  });
  app.get('/api/v1/players', async request => {
    const userId = auth(request), player = world.players.get(userId);
    return ok([...world.players.entries()]
      .filter(([, other]) => other.roomId === player?.roomId && other.disconnectedAt === null)
      .map(([id, other]) => ({ userId: id, fishId: other.fish.id, nickname: other.self.nickname, role: other.self.role, guildId: other.self.guildId, totalPower: other.self.wallet.totalPower, currentMatchId: other.self.currentMatchId })), request.id);
  });
  app.get<{Params:{fishId:string}}>('/api/v1/players/:fishId/card', async request => {
    auth(request);
    const fishId=uuidSchema.parse(request.params.fishId);
    const player=await pool.query(`SELECT u.id AS user_id,u.role,f.id AS fish_id,f.nickname,f.total_xp,w.balance,
      g.id AS guild_id,g.name AS guild_name,g.badge AS guild_badge,g.color AS guild_color,
      (SELECT m.id FROM matches m JOIN match_participants mp ON mp.match_id=m.id WHERE mp.user_id=u.id
        AND m.status IN ('INVITED','READY_CHECK','COUNTDOWN','RUNNING','OVERTIME','SETTLING') ORDER BY m.created_at DESC LIMIT 1) AS current_match_id
      FROM fish f JOIN users u ON u.id=f.user_id JOIN wallets w ON w.owner_user_id=u.id
      LEFT JOIN guild_members gm ON gm.user_id=u.id LEFT JOIN guilds g ON g.id=gm.guild_id AND g.status='ACTIVE'
      WHERE f.id=$1`,[fishId]);
    assert(player.rowCount,'FISH_NOT_OWNED','角色不存在',404);
    const row=player.rows[0],level=levelFromXp(row.total_xp);
    const recent=await pool.query(`SELECT r.result_json,p.team FROM match_results r JOIN match_participants p ON p.match_id=r.match_id
      WHERE p.user_id=$1 ORDER BY r.created_at DESC,r.match_id DESC LIMIT 5`,[row.user_id]);
    const data:PublicPlayerCard={
      userId:row.user_id,fishId:row.fish_id,nickname:row.nickname,role:row.role,level,totalPower:basePower(level)+row.balance,
      guild:row.guild_id?{id:row.guild_id,name:row.guild_name,badge:row.guild_badge,color:row.guild_color}:null,
      currentMatchId:row.current_match_id??null,
      recentMatches:recent.rows.map(entry=>{
        const result=entry.result_json as MatchResultView;
        const outcome=result.phase==='ABORTED'?'ABORTED':result.winnerTeam===null?'DRAW':result.winnerTeam===entry.team?'WIN':'LOSS';
        return {matchId:result.matchId,mode:result.mode as MatchMode,outcome,reason:result.reason,committedAt:result.committedAt};
      }),
    };
    return ok(data,request.id);
  });

  let outboxTimer: ReturnType<typeof setInterval> | null = null;
  let operationsTimer: ReturnType<typeof setInterval> | null = null;
  let outboxRunning = false, operationsRunning = false, authoritativeStarted = false;
  async function drainOutbox() {
    if (outboxRunning) return;
    outboxRunning = true;
    try {
      const result = await pool.query('SELECT * FROM outbox_events WHERE published_at IS NULL ORDER BY created_at LIMIT 100');
      for (const event of result.rows) {
        world.invalidate(event.aggregate_id, event.payload.domains);
        await pool.query('UPDATE outbox_events SET published_at=now(),attempts=attempts+1 WHERE id=$1 AND published_at IS NULL', [event.id]);
      }
    } catch (error) { app.log.error({ err: error }, 'outbox 发布失败'); }
    finally { outboxRunning = false; }
  }
  async function operationalCheck() {
    if (operationsRunning) return;
    operationsRunning = true;
    try {
      await pool.query('SELECT 1');
      const report = await reconcile();
      await enforceReconciliation(report);
      resumeAssetWrites('database');
      if (authoritativeStarted) setReady(true);
      for (const [bucketKey, bucket] of mutationBuckets) if (bucket.second < Math.floor(Date.now() / 1000) - 60) mutationBuckets.delete(bucketKey);
    } catch (error) {
      pauseAssetWrites('database', '数据库探测或对账执行失败');
      setReady(false);
      app.log.error({ err: error }, '运维探测失败，readiness 与资产写入已关闭');
    } finally { operationsRunning = false; }
  }

  async function start() {
    await pool.query('SELECT 1 FROM schema_migrations LIMIT 1');
    await acquireMainInstance();
    authoritativeStarted = true;
    await matches.recoverOldMatches();
    const initialReport = await reconcile();
    await enforceReconciliation(initialReport);
    resumeAssetWrites('database');
    matches.start(); world.start();
    outboxTimer = setInterval(() => { void drainOutbox(); }, 500);
    const operationsInterval = Math.max(10000, Number(process.env.OPERATIONS_CHECK_INTERVAL_MS ?? 60000));
    operationsTimer = setInterval(() => { void operationalCheck(); }, operationsInterval);
    await app.listen({ port: Number(process.env.PORT ?? 3000), host: process.env.HOST ?? '127.0.0.1' });
    setReady(true);
  }

  let closePromise: Promise<void> | null = null;
  function close(): Promise<void> {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      const shouldFlushOutbox = authoritativeStarted || outboxTimer !== null;
      setReady(false);
      pauseAssetWrites('maintenance', '服务器正在有界排空并停止');
      matches.beginDrain();
      if (operationsTimer) { clearInterval(operationsTimer); operationsTimer = null; }
      const drainMs = Math.max(0, Math.min(60000, Number(process.env.SHUTDOWN_DRAIN_MS ?? 35000)));
      const deadline = Date.now() + drainMs;
      if (authoritativeStarted) {
        while (Date.now() < deadline) {
          const active = await pool.query("SELECT count(*)::int AS count FROM matches WHERE status IN ('COUNTDOWN','RUNNING','OVERTIME','SETTLING')").catch(error => { app.log.error({ err: error }, '排空期间数据库不可用，立即进入本地关闭'); return null; });
          if (!active) break;
          if (active.rows[0].count === 0) break;
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        await battle.close().catch(error => app.log.error({ err: error }, '剩余比赛系统中止失败，将由下次启动恢复'));
        world.stop();
        authoritativeStarted = false;
      }
      if (outboxTimer) { clearInterval(outboxTimer); outboxTimer = null; }
      if (shouldFlushOutbox) await drainOutbox();
      io.close();
      await app.close();
      await releaseMainInstance();
      await pool.end();
    })();
    return closePromise;
  }
  return { app, io, world, matches, battle, start, close, auth, key, ok };
}
