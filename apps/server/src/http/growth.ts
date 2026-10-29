import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { feedSchema } from '@aquarium/protocol';
import { basePower, levelFromXp, seasonKey, weekStartDate } from '@aquarium/core';
import { pool } from '../persistence/db';
import { claimDailySupply } from '../services/growth';
import { Ecosystem } from '../simulation/ecosystem';
import type { World } from '../simulation/world';
import { assert } from './errors';

export function registerGrowthRoutes(app:FastifyInstance,world:World) {
  const ecosystem=new Ecosystem(world);world.ecosystem=ecosystem;
  const auth=(request:FastifyRequest)=>{assert(request.userId,'AUTH_REQUIRED','请先进入游戏',401);return request.userId;};
  const key=(request:FastifyRequest)=>String(request.headers['idempotency-key']??'');
  app.post('/api/v1/rewards/daily',async request=>{
    z.object({}).strict().parse(request.body??{});const userId=auth(request);
    const data=await claimDailySupply(userId,key(request));await world.refreshPlayer(userId);world.invalidate(userId,['fish','wallet','daily']);
    return {data,requestId:request.id};
  });
  app.post('/api/v1/tank/feed',async request=>({data:await ecosystem.feed(auth(request),key(request),feedSchema.parse(request.body)),requestId:request.id}));
  app.get('/api/v1/leaderboards',async request=>{
    const userId=auth(request);
    const query=z.object({kind:z.enum(['current','growth','guild']).default('current'),scope:z.enum(['members','guests']).default('members'),seasonId:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),limit:z.coerce.number().int().min(1).max(100).default(20),cursor:z.string().optional()}).parse(request.query);
    const offset=query.cursor?Math.max(0,Number(query.cursor)||0):0;
    if(query.kind==='guild'){
      const selectedSeason=query.seasonId??seasonKey();
      const result=await pool.query(`SELECT g.id,g.name,g.badge,g.color,COALESCE(s.points,0) AS points,COALESCE(s.wins,0) AS wins,
        COALESCE(s.draws,0) AS draws,COALESCE(s.losses,0) AS losses FROM guilds g LEFT JOIN guild_season_stats s ON s.guild_id=g.id AND s.season_id=$1
        WHERE g.status='ACTIVE' ORDER BY COALESCE(s.points,0) DESC,COALESCE(s.wins,0) DESC,
        CASE WHEN COALESCE(s.wins+s.draws+s.losses,0)=0 THEN 0 ELSE s.wins::float/(s.wins+s.draws+s.losses) END DESC,g.id`,[selectedSeason]);
      const membership=await pool.query('SELECT guild_id FROM guild_members WHERE user_id=$1',[userId]);
      const ranked=result.rows.map((row,index)=>({...row,guildId:row.id,rank:index+1}));
      const myIndex=ranked.findIndex(row=>row.id===membership.rows[0]?.guild_id);
      return {data:{entries:ranked.slice(offset,offset+query.limit),myRank:myIndex>=0?myIndex+1:null,nearby:myIndex>=0?ranked.slice(Math.max(0,myIndex-2),myIndex+3):[],seasonId:selectedSeason,nextCursor:offset+query.limit<ranked.length?String(offset+query.limit):null},requestId:request.id};
    }
    const roleCondition=query.scope==='guests'?"u.role='GUEST'":"u.role IN ('MEMBER','ADMIN')";
    const value=query.kind==='growth'?"COALESCE((SELECT sum(r.xp_delta)::int FROM reward_events r WHERE r.fish_id=f.id AND r.business_date>=$1::date),0)":"w.balance";
    // Level is derived from the exact cumulative thresholds in the shared rules.
    const rows=await pool.query(`SELECT u.id AS user_id,f.id AS fish_id,f.nickname,f.total_xp,f.appearance_json,w.balance,${value} AS rank_value FROM users u JOIN fish f ON f.user_id=u.id JOIN wallets w ON w.owner_user_id=u.id WHERE ${roleCondition}`,
      query.kind==='growth'?[weekStartDate()]:[]);
    const all=rows.rows.map(row=>({userId:row.user_id,fishId:row.fish_id,nickname:row.nickname,appearance:row.appearance_json,level:levelFromXp(row.total_xp),totalPower:basePower(levelFromXp(row.total_xp))+row.balance,value:query.kind==='growth'?row.rank_value:basePower(levelFromXp(row.total_xp))+row.balance}))
      .sort((a,b)=>b.value-a.value||b.level-a.level||a.userId.localeCompare(b.userId));
    const ranked=all.map((row,index)=>({...row,rank:index+1})),myIndex=ranked.findIndex(row=>row.userId===userId);
    return {data:{entries:ranked.slice(offset,offset+query.limit),myRank:myIndex>=0?myIndex+1:null,nearby:myIndex>=0?ranked.slice(Math.max(0,myIndex-2),myIndex+3):[],nextCursor:offset+query.limit<ranked.length?String(offset+query.limit):null},requestId:request.id};
  });
  return ecosystem;
}
