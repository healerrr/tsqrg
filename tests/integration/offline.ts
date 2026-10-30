/** Creates a separate database on the explicitly configured development PostgreSQL host. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { businessDate, config } from '../../packages/game-core/src/index';
import type { ConnectionRuntime } from '../../apps/server/src/simulation/world';
import type { Ecosystem } from '../../apps/server/src/simulation/ecosystem';

if (!process.env.DATABASE_URL) throw new Error('请显式提供本地开发 DATABASE_URL；脚本会创建隔离验收库');
const base = new URL(process.env.DATABASE_URL);
if (!['127.0.0.1', 'localhost'].includes(base.hostname)) throw new Error('离线验收只允许本地 PostgreSQL');
const name = `aquarium_offline_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const requireServer = createRequire(new URL('../../apps/server/package.json', import.meta.url));
const { Client } = requireServer('pg') as typeof import('pg');
const admin = new Client({ connectionString: base.href }); await admin.connect();
try { await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`); } finally { await admin.end(); }
base.pathname = `/${name}`; process.env.DATABASE_URL = base.href;
process.env.PORT = process.env.OFFLINE_TEST_PORT ?? '3101'; process.env.NODE_ENV = 'development';
process.env.LOG_LEVEL = 'silent'; process.env.SHUTDOWN_DRAIN_MS = '0';

const { pool, tx } = await import('../../apps/server/src/persistence/db');
const { migrate } = await import('../../apps/server/src/persistence/migrate');
const { seed } = await import('../../apps/server/src/persistence/seed');
const { createGuest, createFish, selfView } = await import('../../apps/server/src/services/identity');
const { ensureDaily, personalWalletId, transfer } = await import('../../apps/server/src/services/economy');
const { grantReward } = await import('../../apps/server/src/services/growth');
const { World } = await import('../../apps/server/src/simulation/world');
const { createApp } = await import('../../apps/server/src/http/app');
const requireWeb = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { io } = requireWeb('socket.io-client') as typeof import('../../apps/web/node_modules/socket.io-client');
const checks: string[] = [];
const wait = async (condition: () => boolean) => { const until = Date.now() + 15000; while (!condition()) { if (Date.now() > until) throw new Error('等待权威状态超时'); await new Promise(resolve => setTimeout(resolve, 20)); } };
await migrate(); await seed();
const fixtures = [];
for (let index = 0; index < 14; index++) {
  const guest = await createGuest();
  await createFish(guest.userId, randomUUID(), { nickname: `偶遇验证${index}`, appearance: { presetId: 'goldfish', bodyColor: '#ffaa45', finColor: '#539bec', patternId: 'none', skinAssetId: null, equipped: {}, version: 1 } });
  fixtures.push(guest);
}
const server = await createApp(); let socket: ReturnType<typeof io> | null = null;
const originalRandom = Math.random;
try {
  await server.start(); server.world.stop();
  const world = server.world, eco = world.ecosystem as Ecosystem;
  await wait(() => eco.pending.size === 0);
  assert.equal(world.players.size, 14);
  for (const room of world.roomEpochs.keys()) assert([...world.players.values()].filter(p => p.roomId === room).length <= config.tank.maxIdleDisplays);
  assert([...world.players.values()].every(p => world.isOfflineRoaming(p)));
  checks.push('启动从真实数据库恢复全部14条离线鱼，超过12条自动分缸且不删除资格');

  const a = world.players.get(fixtures[0]!.userId)!, b = world.players.get(fixtures[1]!.userId)!, capped = world.players.get(fixtures[2]!.userId)!;
  world.players.clear(); for (const p of [a, b, capped]) { p.roomId = 'tank:1'; p.fish.position = { x: 1750, y: 800 }; world.players.set(p.self.userId, p); }
  world.roomEpochs.clear(); world.roomEpochs.set('tank:1', randomUUID());
  eco.food.clear(); eco.npc.clear();
  for (let index = 0; index < config.tank.maxNpc; index++) eco.npc.set(`placeholder-${index}`, { id: `placeholder-${index}`, roomId: 'tank:1', tier: 'silver', position: { x: 1700, y: 800 }, velocity: { x: 0, y: 0 }, relativeSize: .45, state: 'CLAIM_PENDING', turnAt: 0 });
  Math.random = () => .5;
  a.fish.position = { x: 400, y: 300 };
  const initial = await selfView(a.self.userId), now = Date.now();
  const food = (id: string, x: number, y: number) => { eco.food.set(id, { id, roomId: 'tank:1', position: { x, y }, state: 'AVAILABLE', expiresAtServerMs: now + 60000 }); };
  const away = `away:${randomUUID()}`; food(away, 100, 100); world.step(.1);
  assert(a.fish.position.x > 400); assert.equal(eco.food.get(away)?.state, 'AVAILABLE');
  assert.equal((await selfView(a.self.userId)).wallet.powerBalance, initial.wallet.powerBalance);
  checks.push('随机路径背离附近食物，不追食；未碰到不产生收益');
  const hit = `offline-food:${randomUUID()}`; food(hit, a.fish.position.x, a.fish.position.y);
  eco.step(now + 200, 0); await wait(() => eco.pending.size === 0);
  assert.equal((await selfView(a.self.userId)).totalXp, initial.totalXp + 4);
  assert.equal((await selfView(a.self.userId)).wallet.powerBalance, initial.wallet.powerBalance + 1);
  checks.push('没有连接且活跃窗口已过的鱼碰到鱼粮，真实数据库增加4XP/1战力');

  b.fish.position = { ...a.fish.position }; b.disconnectedAt = null; b.controlSocketId = 'online-peer'; b.pageVisible = true; b.lastActivityAt = now; b.leaseUntil = now + 60000;
  world.connections.set('online-peer', { userId: b.self.userId, sceneEpoch: randomUUID(), socket: { id: 'online-peer', connected: true, emit() {} } } as unknown as ConnectionRuntime);
  const contested = `offline-contest:${randomUUID()}`, sumBefore = (await selfView(a.self.userId)).wallet.powerBalance + (await selfView(b.self.userId)).wallet.powerBalance;
  food(contested, a.fish.position.x, a.fish.position.y); eco.step(now + 400, 0); await wait(() => eco.pending.size === 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM reward_events WHERE source_id=$1', [contested])).rows[0].n, 1);
  await Promise.all(Array.from({ length: 10 }, () => grantReward(a.self.userId, 'FOOD', contested, 4, 1)));
  assert.equal((await selfView(a.self.userId)).wallet.powerBalance + (await selfView(b.self.userId)).wallet.powerBalance, sumBefore + 1);
  checks.push('在线与离线同帧竞争只奖一份，重复提交十次不增发');
  b.fish.position = { x: 1750, y: 800 };
  await tx(async client => {
    await ensureDaily(client, capped.self.userId, businessDate());
    await client.query("UPDATE daily_counters SET used=CASE counter_key WHEN 'xp' THEN 295 WHEN 'power' THEN 79 ELSE used END WHERE owner_id=$1", [capped.self.userId]);
    await client.query('UPDATE fish SET total_xp=295 WHERE user_id=$1', [capped.self.userId]);
    await transfer(client, `fixture:${randomUUID()}`, 'TEST_FIXTURE', capped.self.userId, [{ walletId: personalWalletId(capped.self.userId), amount: 79 }, { walletId: 'system:MINT', amount: -79 }]);
  });
  await world.refreshPlayer(capped.self.userId); capped.fish.position = { x: 800, y: 400 };
  const npcId = `offline-npc:${randomUUID()}`; eco.npc.delete('placeholder-0');
  eco.npc.set(npcId, { id: npcId, roomId: 'tank:1', tier: 'silver', relativeSize: .45, position: { ...capped.fish.position }, velocity: { x: 0, y: 0 }, state: 'AVAILABLE', turnAt: now + 60000 });
  eco.step(now + 600, 0); await wait(() => eco.pending.size === 0);
  const cappedSelf = await selfView(capped.self.userId);
  assert.equal(cappedSelf.daily.xpMinted, 300); assert.equal(cappedSelf.daily.powerMinted, 80);
  assert.equal(cappedSelf.totalXp, 300); assert.equal(cappedSelf.wallet.powerBalance, 180);
  checks.push('离线偶遇小鱼也入账，295XP/79战力只补5XP/1战力，与在线共用上限');
  const tooBig = `offline-big:${randomUUID()}`;
  eco.npc.set(tooBig, { id: tooBig, roomId: 'tank:1', tier: 'rare', relativeSize: .7, position: { ...a.fish.position }, velocity: { x: 0, y: 0 }, state: 'AVAILABLE', turnAt: now + 60000 });
  eco.step(now + 800, 0); assert.equal(eco.npc.get(tooBig)?.state, 'AVAILABLE');
  checks.push('离线鱼不能吞食体型超过限制的小鱼');

  const watcher = { userId: a.self.userId, socket: { id: 'observer', connected: true, emit() {} } } as unknown as ConnectionRuntime;
  world.connections.set('observer', watcher); const observed = `observed:${randomUUID()}`; food(observed, a.fish.position.x, a.fish.position.y);
  eco.step(now + 1000, 0); assert.equal(eco.food.get(observed)?.state, 'AVAILABLE');
  world.connections.delete('observer'); a.self.currentMatchId = randomUUID(); eco.step(now + 1200, 0);
  assert.equal(eco.food.get(observed)?.state, 'AVAILABLE'); a.self.currentMatchId = null;
  checks.push('仍有观察连接或进入比赛准备时不进行离线进食');

  world.connections.delete('online-peer'); b.disconnectedAt = now;
  socket = io(`http://127.0.0.1:${process.env.PORT}/game`, { autoConnect: false, transports: ['websocket'], reconnection: false, extraHeaders: { Cookie: `aquarium_session=${server.app.signCookie(fixtures[0]!.token)}`, Origin: 'http://127.0.0.1:5173' } });
  await new Promise<void>((resolve, reject) => { socket!.once('connect_error', reject); socket!.once('connect', () => socket!.timeout(5000).emit('session:hello', { protocolVersion: 1, clientInstanceId: randomUUID() }, (error: Error | null, result: { error?: { message: string } }) => error || result.error ? reject(error ?? new Error(result.error!.message)) : resolve())); socket!.connect(); });
  assert.equal(world.isOfflineRoaming(a), false); assert.equal(a.controlSocketId, socket.id); assert.deepEqual(a.fish.velocity, { x: 0, y: 0 });
  socket.disconnect(); await wait(() => world.isOfflineRoaming(a)); socket = null;
  checks.push('独立Socket.IO连接重新上线取得控制，断开后重新进入随机托管');

  const restored = new World({} as ConstructorParameters<typeof World>[0]); await restored.restoreOfflinePlayers();
  assert.equal(restored.players.size, 14); assert.equal(restored.players.get(capped.self.userId)!.self.wallet.powerBalance, 180);
  assert.equal(restored.players.get(capped.self.userId)!.self.totalXp, 300);
  assert.equal((await pool.query('SELECT transaction_id FROM ledger_entries GROUP BY transaction_id HAVING sum(amount)<>0')).rowCount, 0);
  assert.equal((await pool.query('SELECT 1 FROM daily_counters WHERE used+reserved>limit_value')).rowCount, 0);
  checks.push('重新从数据库载入后离线经验/战力保留，全部流水守恒且日额度不越界');
  await wait(() => !(eco as unknown as { syncing: boolean }).syncing && eco.pending.size === 0);
  const report = { recordedAt: new Date().toISOString(), rulesVersion: config.rulesVersion, database: name, passed: checks, note: '确定性碰撞验收不保证实际每条鱼都能随机吃到；独立测试库保留供核对，无生产账号被修改。' };
  await mkdir('artifacts/offline', { recursive: true }); await writeFile('artifacts/offline/integration-results.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { Math.random = originalRandom; socket?.disconnect(); await server.close(); }
