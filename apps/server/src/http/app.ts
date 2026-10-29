import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { Server } from 'socket.io';
import { ZodError } from 'zod';
import { claimInviteSchema, createFishSchema } from '@aquarium/protocol';
import { config } from '@aquarium/core';
import { pool, ready, setReady, acquireMainInstance, releaseMainInstance, ownerEpoch } from '../persistence/db';
import { createGuest, createFish, claimInvite, selfView, userFromToken } from '../services/identity';
import { durable, hash } from '../services/economy';
import { World } from '../simulation/world';
import { AppError, assert } from './errors';
import { registerGrowthRoutes } from './growth';
import { registerShopRoutes } from './shop';
import { registerMatchRoutes } from './matches';
import { registerGuildRoutes } from './guilds';
import { installBattles } from '../simulation/battle';

declare module 'fastify' { interface FastifyRequest { userId: string | null } }
export async function createApp() {
  const production = process.env.NODE_ENV === 'production';
  if (production && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length<32 || !process.env.DATABASE_URL || !process.env.APP_ORIGIN)) throw new Error('生产环境必须配置DATABASE_URL、APP_ORIGIN与至少32字符SESSION_SECRET');
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.cookie','req.headers.authorization','req.body.inviteCode','res.headers.set-cookie'] }, bodyLimit: config.upload.maxBytes+65536 });
  const origins = production ? [process.env.APP_ORIGIN!] : [process.env.APP_ORIGIN ?? 'http://localhost:5173', 'http://127.0.0.1:5173','http://localhost:3000','http://127.0.0.1:3000'];
  await app.register(cookie, { secret: process.env.SESSION_SECRET ?? 'development-only-aquarium-cookie-secret-please-replace', hook: 'onRequest' });
  await app.register(cors, { origin: origins, credentials: true });
  app.decorateRequest('userId', null);
  const tokenFrom = (header: string | undefined) => {
    const parsed = app.parseCookie(header ?? '');
    if (!parsed.aquarium_session) return undefined;
    const unsigned = app.unsignCookie(parsed.aquarium_session);
    return unsigned.valid ? unsigned.value! : undefined;
  };
  app.addHook('onRequest', async request => {
    if (request.method!=='GET' && request.method!=='HEAD' && request.method!=='OPTIONS' && request.headers.origin) assert(origins.includes(request.headers.origin), 'AUTH_REQUIRED', '请求来源不受信任',403);
    request.userId = await userFromToken(tokenFrom(request.headers.cookie));
  });
  app.addHook('onSend', async (request, reply) => { if(request.url.startsWith('/api/v1/'))reply.header('Cache-Control','no-store'); });
  app.setErrorHandler((error, request, reply) => {
    const validationMessage=error instanceof ZodError && /[\u3400-\u9fff]/.test(error.issues[0]?.message??'')?error.issues[0].message:'请求参数无效，请检查输入内容';
    const e = error instanceof AppError ? error : error instanceof ZodError ? new AppError('VERSION_CONFLICT',validationMessage,400) : new AppError('VERSION_CONFLICT','服务暂时不可用，请稍后重试',500);
    if (e.status>=500) request.log.error({err:error,requestId:request.id},'请求失败');
    reply.status(e.status).send({error:{code:e.code,message:e.message},requestId:request.id});
  });
  const io = new Server(app.server,{cors:{origin:origins,credentials:true},maxHttpBufferSize:65536,allowRequest:(req,callback)=>callback(null,!req.headers.origin || origins.includes(req.headers.origin))});
  const world = new World(io);
  const auth = (request: {userId:string|null}):string => { assert(request.userId,'AUTH_REQUIRED','请先进入游戏',401); return request.userId; };
  const key = (request:{headers:Record<string,unknown>}):string => String(request.headers['idempotency-key'] ?? '');
  const ok = (data:unknown,requestId:string)=>({data,requestId});
  const { matches, battle } = await installBattles(world);
  registerGrowthRoutes(app,world);
  await registerShopRoutes(app,world);
  registerGuildRoutes(app,world);
  registerMatchRoutes({app,auth,key,ok,matches});
  io.of('/game').use(async (socket,next)=>{
    try { const userId = await userFromToken(tokenFrom(socket.request.headers.cookie)); assert(userId,'AUTH_REQUIRED','会话已失效，请重新进入',401); socket.data.userId=userId; next(); }
    catch { next(new Error('会话已失效，请重新进入')); }
  });
  io.of('/game').on('connection',socket=>{ void world.connect(socket,socket.data.userId).catch(error=>{app.log.error(error);socket.disconnect(true);}); });
  app.post('/api/v1/auth/guest',async(request,reply)=>{
    if (!request.userId) {
      const guest = await createGuest(); request.userId=guest.userId;
      reply.setCookie('aquarium_session',guest.token,{path:'/',httpOnly:true,secure:production,sameSite:'lax',maxAge:90*86400,signed:true});
    }
    return ok(await selfView(request.userId),request.id);
  });
  app.get('/api/v1/me',async request=>ok(await selfView(auth(request)),request.id));
  app.post('/api/v1/fish',async request=>{
    const userId=auth(request), payload=createFishSchema.parse(request.body);
    const data=await createFish(userId,key(request),payload); await world.refreshPlayer(userId); world.invalidate(userId); return ok(data,request.id);
  });
  app.post('/api/v1/auth/claim',async request=>{
    const userId=auth(request),payload=claimInviteSchema.parse(request.body);
    const data=await claimInvite(userId,key(request),payload.inviteCode); await world.refreshPlayer(userId); world.invalidate(userId); return ok(data,request.id);
  });
  app.post('/api/v1/auth/logout',async(request,reply)=>{
    const userId=auth(request); const token=tokenFrom(request.headers.cookie);
    const data=await durable(userId,'auth:logout',key(request),{},async client=>{
      if(token) await client.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1',[hash(token)]);
      return {loggedOut:true};
    });
    for(const c of world.connections.values()) if(c.userId===request.userId) c.socket.disconnect(true);
    reply.clearCookie('aquarium_session',{path:'/'}); return ok(data,request.id);
  });
  app.get('/api/v1/health/live',async request=>ok({status:'alive'},request.id));
  app.get('/api/v1/health/ready',async(request,reply)=>{
    let database=false;try {await pool.query('SELECT 1');database=true;}catch{setReady(false);}
    if(!ready || !database)reply.status(503);
    return ok({status:ready&&database?'ready':'unavailable',database,rulesVersion:config.rulesVersion,protocolVersion:1},request.id);
  });
  app.get('/health/live',async()=>({status:'alive'}));
  app.get('/health/ready',async(_request,reply)=>{try{await pool.query('SELECT 1');if(!ready)reply.status(503);}catch{reply.status(503);}return {ready};});
  app.get('/api/v1/metrics',async request=>{
    auth(request);const times=[...world.tickTimes].sort((a,b)=>a-b);
    return ok({instanceId:ownerEpoch,uptimeSeconds:process.uptime(),connections:world.connections.size,rooms:world.roomEpochs.size,serverTick:world.serverTick,tickP95Ms:times[Math.floor(times.length*.95)]??0,memory:process.memoryUsage()},request.id);
  });
  app.get('/api/v1/players',async request=>{
    const userId=auth(request),p=world.players.get(userId);
    return ok([...world.players.entries()].filter(([,other])=>other.roomId===p?.roomId && other.disconnectedAt===null).map(([id,other])=>({userId:id,fishId:other.fish.id,nickname:other.self.nickname,role:other.self.role,guildId:other.self.guildId,totalPower:other.self.wallet.totalPower,currentMatchId:other.self.currentMatchId})),request.id);
  });
  let outboxTimer:ReturnType<typeof setInterval>|null=null;
  let authoritativeStarted=false;
  async function start() {
    await pool.query('SELECT 1 FROM schema_migrations LIMIT 1');
    await acquireMainInstance();
    authoritativeStarted=true;
    // Readiness must stay closed until old-instance matches have released holds and quotas.
    await matches.recoverOldMatches();
    matches.start();world.start();setReady(true);
    outboxTimer=setInterval(()=>{
      void pool.query('SELECT * FROM outbox_events WHERE published_at IS NULL ORDER BY created_at LIMIT 100').then(async result=>{
        for(const event of result.rows){world.invalidate(event.aggregate_id,event.payload.domains);await pool.query('UPDATE outbox_events SET published_at=now(),attempts=attempts+1 WHERE id=$1',[event.id]);}
      }).catch(error=>app.log.error(error));
    },500);
    await app.listen({port:Number(process.env.PORT??3000),host:process.env.HOST??'127.0.0.1'});
  }
  async function close() {
    setReady(false);
    if(authoritativeStarted){await battle.close();world.stop();authoritativeStarted=false;}
    if(outboxTimer)clearInterval(outboxTimer);
    io.close();await app.close();await releaseMainInstance();await pool.end();
  }
  return {app,io,world,matches,battle,start,close,auth,key,ok};
}
