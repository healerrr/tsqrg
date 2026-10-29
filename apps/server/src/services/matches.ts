import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { basePower, businessDate, combatStats, config, levelFromXp, quoteStake, seasonKey, settlementDeltas } from '@aquarium/core';
import type { MatchMode, MatchPhase, MatchResultView, Appearance } from '@aquarium/protocol';
import { pool, ownerEpoch, tx } from '../persistence/db';
import { assert, AppError } from '../http/errors';
import { durable, ensureDaily, personalWalletId, transfer } from './economy';
import type { World } from '../simulation/world';

export interface LockedFighter { userId: string; fishId: string; nickname: string; team: 'A'|'B'; level: number; appearance: Appearance; stats: ReturnType<typeof combatStats> }
export interface MatchView {
  id: string; mode: MatchMode; phase: MatchPhase; status: MatchPhase; stake: number; quoteVersion: number; version: number;
  deadlineAtServerMs: number; guildA: string|null; guildB: string|null;
  participants: Array<{ userId: string; fishId: string; nickname: string; team: 'A'|'B'; ready: boolean; withdrawn: boolean }>;
  result: MatchResultView|null;
}
export interface MatchDecision { winnerTeam: 'A'|'B'|null; reason: MatchResultView['reason']; scoreA: number; scoreB: number }
interface QuotaRef { ownerType: string; ownerId: string; key: string; limit: number }
interface MatchPayload { quotaRefs?: QuotaRef[]; quotaConsumed?: boolean; inviterId?: string; withdrawals?: Record<string,'FORFEIT'|'DISCONNECT'>; [key: string]: unknown }
export interface StoredMatch { id: string; mode: MatchMode; status: MatchPhase; stake: number; quote_version: number; version: number; rules_version: string; guild_a: string|null; guild_b: string|null; business_date: string|null; season_id: string|null; deadline_at: Date|null; payload: MatchPayload }
const activePhases = ['INVITED','READY_CHECK','COUNTDOWN','RUNNING','OVERTIME','SETTLING'];
const formal = (mode: string) => mode.endsWith('_FORMAL');
const teamMode = (mode: string) => mode.startsWith('TEAM_');
type Queryable = Pick<PoolClient,'query'>;

/** All durable match transitions share the same transaction and wallet locking service. */
export class MatchService {
  allowTeam = true;
  changed: ((matchId: string) => void)|null = null;
  private maintenanceTimer: ReturnType<typeof setInterval>|null = null;
  private expiring = false;
  private decisions = new Map<string,MatchDecision>();
  private draining = false;
  constructor(public world: World) {}
  beginDrain() { this.draining = true; }
  private assertAccepting() { assert(!this.draining,'MATCH_STATE_INVALID','服务器正在维护，当前比赛结束后再试'); }
  start() {
    this.maintenanceTimer = setInterval(() => {
      if (this.expiring) return; this.expiring = true;
      void this.expireDue().catch(error => console.error('比赛邀请过期处理失败', error)).finally(() => { this.expiring = false; });
    }, 500);
  }
  stop() { if (this.maintenanceTimer) clearInterval(this.maintenanceTimer); this.maintenanceTimer = null; }
  private isOnline(userId: string): boolean {
    const player = this.world.players.get(userId);
    return !!player?.controlSocketId && player.disconnectedAt === null && player.leaseUntil > Date.now() && !!this.world.connections.get(player.controlSocketId)?.socket.connected;
  }
  private async assertFree(client: Queryable, userIds: string[], except?: string) {
    const busy = await client.query('SELECT p.user_id FROM match_participants p JOIN matches m ON m.id=p.match_id WHERE p.user_id=ANY($1::uuid[]) AND m.status=ANY($2::text[]) AND ($3::uuid IS NULL OR m.id<>$3)', [userIds,activePhases,except??null]);
    assert(!busy.rowCount,'MATCH_STATE_INVALID','有玩家正处于另一场邀请、准备或比赛');
  }
  private async participantRows(client: Queryable, matchId: string, lock = false): Promise<any[]> {
    if(lock) {
      const participants=await client.query('SELECT user_id,fish_id FROM match_participants WHERE match_id=$1 ORDER BY user_id FOR UPDATE',[matchId]);
      const userIds=participants.rows.map(p=>p.user_id),fishIds=participants.rows.map(p=>p.fish_id);
      // Keep the same category and UUID order as every asset-writing service.
      await client.query('SELECT id FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[userIds]);
      await client.query('SELECT id FROM wallets WHERE owner_user_id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[userIds]);
      await client.query('SELECT id FROM fish WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[fishIds]);
    }
    const result = await client.query(`SELECT p.*,f.nickname,f.total_xp,f.appearance_json,u.role,gm.guild_id,w.balance,w.held
      FROM match_participants p JOIN users u ON u.id=p.user_id JOIN fish f ON f.id=p.fish_id
      JOIN wallets w ON w.owner_user_id=p.user_id LEFT JOIN guild_members gm ON gm.user_id=p.user_id
      WHERE p.match_id=$1 ORDER BY p.user_id`, [matchId]);
    return result.rows;
  }
  private async matchRow(client: Queryable, id: string, lock = false): Promise<StoredMatch> {
    const result = await client.query(`SELECT *,business_date::text FROM matches WHERE id=$1 ${lock?'FOR UPDATE':''}`, [id]);
    assert(result.rowCount,'MATCH_STATE_INVALID','比赛不存在'); return result.rows[0];
  }
  private async lockGuilds(client:Queryable,match:StoredMatch) {
    if(teamMode(match.mode)) {
      const guilds=await client.query('SELECT id,status FROM guilds WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[[match.guild_a,match.guild_b].sort()]);
      assert(guilds.rowCount===2 && guilds.rows.every(guild=>guild.status==='ACTIVE'),'MATCH_STATE_INVALID','参赛组织状态已经变化');
    }
  }
  async hasAccess(userId: string, match: StoredMatch, client: Queryable = pool): Promise<boolean> {
    const own = await client.query('SELECT 1 FROM match_participants WHERE match_id=$1 AND user_id=$2', [match.id,userId]);
    if (own.rowCount) return true;
    if (teamMode(match.mode)) {
      const guild = await client.query('SELECT guild_id FROM guild_members WHERE user_id=$1 AND guild_id=ANY($2::uuid[])', [userId,[match.guild_a,match.guild_b].filter(Boolean)]);
      return !!guild.rowCount;
    }
    return false;
  }
  async view(userId: string, id: string, client: Queryable = pool): Promise<MatchView> {
    const match = await this.matchRow(client,id);
    assert(await this.hasAccess(userId,match,client),'FISH_NOT_OWNED','没有访问这场比赛的权限',403);
    return this.publicView(match,client);
  }
  private async publicView(match: StoredMatch, client: Queryable): Promise<MatchView> {
    const participants = await client.query('SELECT p.user_id,p.fish_id,p.team,p.ready,f.nickname FROM match_participants p JOIN fish f ON f.id=p.fish_id WHERE p.match_id=$1 ORDER BY p.team,p.user_id', [match.id]);
    const result = await client.query('SELECT result_json FROM match_results WHERE match_id=$1',[match.id]);
    return { id:match.id,mode:match.mode,phase:match.status,status:match.status,stake:match.stake,quoteVersion:match.quote_version,version:match.version,
      deadlineAtServerMs:match.deadline_at?new Date(match.deadline_at).getTime():0,guildA:match.guild_a,guildB:match.guild_b,
      participants:participants.rows.map(p=>({userId:p.user_id,fishId:p.fish_id,nickname:p.nickname,team:p.team,ready:p.ready,withdrawn:!!match.payload.withdrawals?.[p.user_id]})),result:result.rows[0]?.result_json??null };
  }
  async history(userId: string, limit = 20) {
    const results = await pool.query('SELECT r.result_json FROM match_results r JOIN match_participants p ON p.match_id=r.match_id WHERE p.user_id=$1 ORDER BY r.created_at DESC,r.match_id LIMIT $2', [userId,Math.min(100,Math.max(1,limit))]);
    return results.rows.map(r=>r.result_json as MatchResultView);
  }
  private async sync(id: string) {
    const participants = await pool.query('SELECT user_id FROM match_participants WHERE match_id=$1',[id]);
    for (const p of participants.rows) { await this.world.refreshPlayer(p.user_id); this.world.invalidate(p.user_id,['match','wallet','daily']); }
    this.changed?.(id);
  }
  async invite(userId: string, key: string, payload: { mode: MatchMode; targetUserId?: string; targetGuildId?: string; roster?: string[] }): Promise<MatchView> {
    this.assertAccepting();
    assert(!teamMode(payload.mode)||this.allowTeam,'MATCH_STATE_INVALID','组织团战尚未开放');
    if (teamMode(payload.mode)) return this.inviteTeam(userId,key,payload);
    assert(payload.targetUserId && payload.targetUserId!==userId,'PEER_NOT_ELIGIBLE','请选择另一位在线玩家');
    const result = await durable(userId,'matches:invite',key,payload,async client=>{
      const ids = [userId,payload.targetUserId!].sort();
      await client.query('SELECT id FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[ids]);
      const users = await client.query('SELECT u.id,u.role,f.id AS fish_id FROM users u JOIN fish f ON f.user_id=u.id WHERE u.id=ANY($1::uuid[]) ORDER BY u.id',[ids]);
      assert(users.rowCount===2 && ids.every(id=>this.isOnline(id)),'PEER_NOT_ELIGIBLE','双方必须有角色且保持在线');
      if(formal(payload.mode))assert(users.rows.every(u=>u.role!=='GUEST'),'MEMBER_REQUIRED','正式赛要求双方绑定同事身份',403);
      await this.assertFree(client,ids);
      const id=randomUUID();
      await client.query("INSERT INTO matches(id,mode,status,rules_version,owner_epoch,deadline_at,payload) VALUES ($1,$2,'INVITED',$3,$4,$5,$6)",[id,payload.mode,config.rulesVersion,ownerEpoch,new Date(Date.now()+config.battle.inviteExpirySeconds*1000),JSON.stringify({inviterId:userId})]);
      for(const row of users.rows)await client.query('INSERT INTO match_participants(match_id,user_id,fish_id,team) VALUES ($1,$2,$3,$4)',[id,row.id,row.fish_id,row.id===userId?'A':'B']);
      return this.publicView(await this.matchRow(client,id),client);
    });
    await this.sync(result.id);return result;
  }
  private async inviteTeam(userId:string,key:string,payload:{mode:MatchMode;targetGuildId?:string;roster?:string[]}):Promise<MatchView> {
    const roster=[...new Set(payload.roster??[])].sort();
    assert(payload.targetGuildId && roster.length===config.battle.teamSize,'MATCH_STATE_INVALID','请选择本组织三名在线成员');
    const result=await durable(userId,'matches:invite',key,payload,async client=>{
      const ownMembership=await client.query('SELECT gm.guild_id,gm.role FROM guild_members gm JOIN guilds g ON g.id=gm.guild_id WHERE gm.user_id=$1 AND g.status=$2',[userId,'ACTIVE']);
      assert(ownMembership.rowCount && ['LEADER','ADMIN'].includes(ownMembership.rows[0].role),'MEMBER_REQUIRED','只有组织长或管理员可以发起团战',403);
      const guildA=ownMembership.rows[0].guild_id as string,guildB=payload.targetGuildId!;
      assert(guildA!==guildB,'PEER_NOT_ELIGIBLE','请选择另一个组织');
      const guildIds=[guildA,guildB].sort();
      const guilds=await client.query('SELECT id,leader_user_id,status FROM guilds WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[guildIds]);
      assert(guilds.rowCount===2 && guilds.rows.every(g=>g.status==='ACTIVE'),'PEER_NOT_ELIGIBLE','对方组织不存在或已归档');
      const currentMembership=await client.query('SELECT role FROM guild_members WHERE user_id=$1 AND guild_id=$2',[userId,guildA]);
      assert(currentMembership.rowCount && ['LEADER','ADMIN'].includes(currentMembership.rows[0].role),'MEMBER_REQUIRED','组织权限已经变化，请重新查看',403);
      const managers=await client.query("SELECT gm.user_id,gm.role,f.id AS fish_id FROM guild_members gm JOIN fish f ON f.user_id=gm.user_id WHERE gm.guild_id=$1 AND gm.role IN ('LEADER','ADMIN') ORDER BY CASE gm.role WHEN 'LEADER' THEN 0 ELSE 1 END,gm.joined_at,gm.user_id",[guildB]);
      const invitedCaptain=managers.rows.find(manager=>this.isOnline(manager.user_id));
      assert(invitedCaptain,'PEER_NOT_ELIGIBLE','对方组织没有在线的组织长或管理员');
      const lockUsers=[...new Set([...roster,invitedCaptain.user_id,userId])].sort();
      await client.query('SELECT id FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[lockUsers]);
      const teamA=await client.query('SELECT u.id,u.role,f.id AS fish_id,gm.guild_id FROM users u JOIN fish f ON f.user_id=u.id JOIN guild_members gm ON gm.user_id=u.id WHERE u.id=ANY($1::uuid[]) ORDER BY u.id',[roster]);
      assert(teamA.rowCount===config.battle.teamSize && teamA.rows.every(row=>row.guild_id===guildA && row.role!=='GUEST'),'MEMBER_REQUIRED','A 队名单必须是本组织三名同事',403);
      assert(roster.every(id=>this.isOnline(id)),'PEER_NOT_ELIGIBLE','A 队三名成员必须保持在线');
      await this.assertFree(client,lockUsers);
      const id=randomUUID();
      await client.query("INSERT INTO matches(id,mode,status,rules_version,owner_epoch,deadline_at,guild_a,guild_b,payload) VALUES ($1,$2,'INVITED',$3,$4,$5,$6,$7,$8)",[id,payload.mode,config.rulesVersion,ownerEpoch,new Date(Date.now()+config.battle.inviteExpirySeconds*1000),guildA,guildB,JSON.stringify({inviterId:userId,invitedCaptainId:invitedCaptain.user_id})]);
      for(const row of teamA.rows)await client.query("INSERT INTO match_participants(match_id,user_id,fish_id,team) VALUES ($1,$2,$3,'A')",[id,row.id,row.fish_id]);
      await client.query("INSERT INTO match_participants(match_id,user_id,fish_id,team) VALUES ($1,$2,$3,'B')",[id,invitedCaptain.user_id,invitedCaptain.fish_id]);
      return this.publicView(await this.matchRow(client,id),client);
    });
    await this.sync(result.id);return result;
  }
  private async ensureQuota(client: PoolClient, ref: QuotaRef, date: string) {
    await client.query('INSERT INTO daily_counters(owner_type,owner_id,business_date,counter_key,limit_value) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[ref.ownerType,ref.ownerId,date,ref.key,ref.limit]);
    const result=await client.query('SELECT used,reserved FROM daily_counters WHERE owner_type=$1 AND owner_id=$2 AND business_date=$3 AND counter_key=$4 FOR UPDATE',[ref.ownerType,ref.ownerId,date,ref.key]);
    assert(result.rows[0].used+result.rows[0].reserved<ref.limit,'DAILY_LIMIT_REACHED','今日正式比赛额度已用完，可选择友谊赛');
  }
  private quotaRefs(match: StoredMatch, participants: any[]): QuotaRef[] {
    const refs:QuotaRef[]=participants.map(p=>({ownerType:'USER',ownerId:p.user_id,key:'formal',limit:config.daily.formalMatchesPerPlayer}));
    if(teamMode(match.mode)) {
      for(const guild of [match.guild_a!,match.guild_b!])refs.push({ownerType:'GUILD',ownerId:guild,key:'formal',limit:config.daily.formalTeamMatchesPerGuild});
      refs.push({ownerType:'GUILD_PAIR',ownerId:[match.guild_a,match.guild_b].sort().join(':'),key:'formal',limit:config.daily.formalTeamMatchesPerGuildPair});
    } else refs.push({ownerType:'DUEL_PAIR',ownerId:participants.map(p=>p.user_id).sort().join(':'),key:'formal',limit:config.daily.formalSoloMatchesPerPair});
    return refs.sort((a,b)=>`${a.ownerType}:${a.ownerId}`.localeCompare(`${b.ownerType}:${b.ownerId}`));
  }
  private async validateReady(client: PoolClient, match: StoredMatch, participants: any[], date: string) {
    assert(participants.length===(teamMode(match.mode)?config.battle.teamSize*2:2),'MATCH_STATE_INVALID','参赛名单未齐备');
    if(teamMode(match.mode))assert(participants.every(p=>p.guild_id===(p.team==='A'?match.guild_a:match.guild_b)),'MEMBER_REQUIRED','参赛者必须仍属于对应组织',403);
    assert(participants.every(p=>this.isOnline(p.user_id)),'PEER_NOT_ELIGIBLE','有参赛者离线，请等待重新连接');
    await this.assertFree(client,participants.map(p=>p.user_id),match.id);
    if(formal(match.mode)) {
      assert(participants.every(p=>p.role!=='GUEST'),'MEMBER_REQUIRED','正式赛要求全部参赛者为同事',403);
      for(const participant of participants)await ensureDaily(client,participant.user_id,date);
      for(const ref of this.quotaRefs(match,participants))await this.ensureQuota(client,ref,date);
      const stake=quoteStake(participants.map(p=>p.balance-p.held));
      assert(stake>=config.battle.stakeMin,'INSUFFICIENT_AVAILABLE_POWER','可用余额不足以正式押注，请选择友谊赛');
      return stake;
    }
    return 0;
  }
  async accept(userId: string,key: string,id: string,payload: {version?:number;roster?:string[]}):Promise<MatchView> {
    this.assertAccepting();
    const result=await durable(userId,`matches:${id}:accept`,key,payload,async client=>{
      const match=await this.matchRow(client,id,true);
      assert(match.status==='INVITED' && match.deadline_at && new Date(match.deadline_at).getTime()>Date.now(),'MATCH_STATE_INVALID','邀请已失效或已经处理');
      if(payload.version!==undefined)assert(payload.version===match.version,'VERSION_CONFLICT','比赛状态已更新，请重新查看');
      if(teamMode(match.mode)) {
        await this.lockGuilds(client,match);
        const actor=await client.query('SELECT role FROM guild_members WHERE user_id=$1 AND guild_id=$2',[userId,match.guild_b]);
        assert(actor.rowCount && ['LEADER','ADMIN'].includes(actor.rows[0].role),'FISH_NOT_OWNED','只有受邀组织的组织长或管理员可以确认阵容',403);
        const roster=[...new Set(payload.roster??[])].sort();
        assert(roster.length===config.battle.teamSize,'MATCH_STATE_INVALID','请选择对方组织三名在线成员');
        const existing=await client.query('SELECT user_id FROM match_participants WHERE match_id=$1',[id]);
        const lockUsers=[...new Set([...roster,userId,...existing.rows.map(row=>row.user_id)])].sort();
        await client.query('SELECT id FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[lockUsers]);
        const teamB=await client.query('SELECT u.id,u.role,f.id AS fish_id,gm.guild_id FROM users u JOIN fish f ON f.user_id=u.id JOIN guild_members gm ON gm.user_id=u.id WHERE u.id=ANY($1::uuid[]) ORDER BY u.id',[roster]);
        assert(teamB.rowCount===config.battle.teamSize && teamB.rows.every(row=>row.guild_id===match.guild_b && row.role!=='GUEST'),'MEMBER_REQUIRED','B 队名单必须是受邀组织三名同事',403);
        assert(roster.every(memberId=>this.isOnline(memberId)),'PEER_NOT_ELIGIBLE','B 队三名成员必须保持在线');
        await this.assertFree(client,roster,id);
        await client.query("DELETE FROM match_participants WHERE match_id=$1 AND team='B'",[id]);
        for(const row of teamB.rows)await client.query("INSERT INTO match_participants(match_id,user_id,fish_id,team) VALUES ($1,$2,$3,'B')",[id,row.id,row.fish_id]);
      }
      const participants=await this.participantRows(client,id,true);
      if(!teamMode(match.mode))assert(participants.some(p=>p.user_id===userId&&p.team==='B'),'FISH_NOT_OWNED','只有受邀对手本人可以接受',403);
      const stake=await this.validateReady(client,match,participants,businessDate());
      await client.query("UPDATE matches SET status='READY_CHECK',stake=$2,version=version+1,deadline_at=$3 WHERE id=$1",[id,stake,new Date(Date.now()+config.battle.readyTimeoutSeconds*1000)]);
      return this.publicView(await this.matchRow(client,id),client);
    });
    await this.sync(id);
    const stored=await this.matchRow(pool,id),captain=String(stored.payload.invitedCaptainId??'');
    if(captain && !result.participants.some(participant=>participant.userId===captain)){await this.world.refreshPlayer(captain);this.world.invalidate(captain,['match']);}
    return result;
  }
  async ready(userId:string,key:string,id:string,payload:{quoteVersion:number;stake:number}):Promise<MatchView> {
    this.assertAccepting();
    const outcome=await durable(userId,`matches:${id}:ready`,key,payload,async client=>{
      const match=await this.matchRow(client,id,true);
      assert(match.status==='READY_CHECK' && match.deadline_at && new Date(match.deadline_at).getTime()>Date.now(),'MATCH_STATE_INVALID','准备阶段已结束');
      assert(payload.quoteVersion===match.quote_version && payload.stake===match.stake,'VERSION_CONFLICT','押注报价已更新，请重新确认');
      await this.lockGuilds(client,match);
      const participants=await this.participantRows(client,id,true);
      const own=participants.find(p=>p.user_id===userId);assert(own,'FISH_NOT_OWNED','只有本人可以确认自己的押注',403);
      const date=businessDate(),currentStake=await this.validateReady(client,match,participants,date);
      if(currentStake!==match.stake) {
        await client.query('UPDATE matches SET stake=$2,quote_version=quote_version+1,version=version+1 WHERE id=$1',[id,currentStake]);
        await client.query('UPDATE match_participants SET ready=false WHERE match_id=$1',[id]);
        return {view:await this.publicView(await this.matchRow(client,id),client),reconfirm:true};
      }
      await client.query('UPDATE match_participants SET ready=true WHERE match_id=$1 AND user_id=$2',[id,userId]);
      own.ready=true;
      if(participants.every(p=>p.ready)) {
        const refs=formal(match.mode)?this.quotaRefs(match,participants):[];
        for(const participant of participants) {
          const locked:LockedFighter={userId:participant.user_id,fishId:participant.fish_id,nickname:participant.nickname,team:participant.team,level:levelFromXp(participant.total_xp),appearance:participant.appearance_json,stats:combatStats(participant.appearance_json.presetId,levelFromXp(participant.total_xp))};
          await client.query('UPDATE match_participants SET locked_snapshot=$3 WHERE match_id=$1 AND user_id=$2',[id,participant.user_id,JSON.stringify(locked)]);
          if(formal(match.mode)) {
            await client.query('UPDATE wallets SET held=held+$2,version=version+1 WHERE id=$1',[personalWalletId(participant.user_id),match.stake]);
            await client.query("INSERT INTO wallet_holds(id,match_id,wallet_id,amount,status) VALUES ($1,$2,$3,$4,'HELD')",[randomUUID(),id,personalWalletId(participant.user_id),match.stake]);
          }
        }
        for(const ref of refs)await client.query('UPDATE daily_counters SET reserved=reserved+1 WHERE owner_type=$1 AND owner_id=$2 AND business_date=$3 AND counter_key=$4',[ref.ownerType,ref.ownerId,date,ref.key]);
        await client.query("UPDATE matches SET status='COUNTDOWN',business_date=$2,season_id=$3,deadline_at=$4,payload=payload||$5::jsonb,version=version+1 WHERE id=$1",[id,date,seasonKey(),new Date(Date.now()+config.battle.countdownSeconds*1000),JSON.stringify({quotaRefs:refs,quotaConsumed:false})]);
      }
      return {view:await this.publicView(await this.matchRow(client,id),client),reconfirm:false};
    });
    await this.sync(id);
    if(outcome.reconfirm)throw new AppError('VERSION_CONFLICT','余额变化导致押注报价更新，全部参赛者必须重新确认');
    return outcome.view;
  }
  async locked(id:string):Promise<{match:StoredMatch;fighters:LockedFighter[]}> {
    const match=await this.matchRow(pool,id);const result=await pool.query('SELECT locked_snapshot FROM match_participants WHERE match_id=$1 ORDER BY team,user_id',[id]);
    assert(result.rows.every(p=>p.locked_snapshot),'MATCH_STATE_INVALID','比赛尚未完成全体确认');
    return {match,fighters:result.rows.map(p=>p.locked_snapshot)};
  }
  private async updateQuota(client:PoolClient,match:StoredMatch,operation:'start'|'abort') {
    const refs=match.payload.quotaRefs??[];
    for(const ref of refs) {
      if(operation==='start')await client.query('UPDATE daily_counters SET reserved=reserved-1,used=used+1 WHERE owner_type=$1 AND owner_id=$2 AND business_date=$3 AND counter_key=$4',[ref.ownerType,ref.ownerId,match.business_date,ref.key]);
      else await client.query(`UPDATE daily_counters SET ${match.payload.quotaConsumed?'used=used-1':'reserved=reserved-1'} WHERE owner_type=$1 AND owner_id=$2 AND business_date=$3 AND counter_key=$4`,[ref.ownerType,ref.ownerId,match.business_date,ref.key]);
    }
  }
  async running(id:string):Promise<StoredMatch> {
    const result=await tx(async client=>{
      const match=await this.matchRow(client,id,true);if(match.status!=='COUNTDOWN')return match;
      await this.updateQuota(client,match,'start');
      await client.query("UPDATE matches SET status='RUNNING',started_at=now(),deadline_at=$2,payload=payload||'{\"quotaConsumed\":true}'::jsonb,version=version+1 WHERE id=$1",[id,new Date(Date.now()+(teamMode(match.mode)?config.battle.teamDurationSeconds:config.battle.duelDurationSeconds)*1000)]);
      return this.matchRow(client,id);
    });await this.sync(id);return result;
  }
  async phase(id:string,phase:'OVERTIME',deadlineAt:number) {
    await tx(async client=>{const match=await this.matchRow(client,id,true);assert(match.status==='RUNNING','MATCH_STATE_INVALID','比赛阶段不允许加时');await client.query('UPDATE matches SET status=$2,deadline_at=$3,version=version+1 WHERE id=$1',[id,phase,new Date(deadlineAt)]);});
    await this.sync(id);
  }
  private async finalize(client:PoolClient,match:StoredMatch,decision:MatchDecision):Promise<MatchResultView> {
    const existing=await client.query('SELECT result_json FROM match_results WHERE match_id=$1',[match.id]);if(existing.rowCount)return existing.rows[0].result_json;
    assert(!['FINISHED','ABORTED'].includes(match.status),'MATCH_STATE_INVALID','比赛已经结束');
    assert(Number.isSafeInteger(decision.scoreA)&&decision.scoreA>=0&&Number.isSafeInteger(decision.scoreB)&&decision.scoreB>=0,'VERSION_CONFLICT','服务器比赛分数无效');
    const aborted=decision.reason==='SYSTEM_ABORT';
    // Archived guilds can only arise from damaged data; aborts must still release assets.
    if(teamMode(match.mode))await client.query('SELECT id FROM guilds WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[[match.guild_a,match.guild_b].sort()]);
    const participants=await this.participantRows(client,match.id,true);
    if(aborted && match.payload.quotaRefs?.length)await this.updateQuota(client,match,'abort');
    if(!aborted && match.status==='COUNTDOWN' && !match.payload.quotaConsumed)await this.updateQuota(client,match,'start');
    const holds=await client.query("SELECT * FROM wallet_holds WHERE match_id=$1 AND status='HELD' ORDER BY wallet_id FOR UPDATE",[match.id]);
    for(const hold of holds.rows)await client.query('UPDATE wallets SET held=held-$2,version=version+1 WHERE id=$1',[hold.wallet_id,hold.amount]);
    await client.query("UPDATE wallet_holds SET status=$2 WHERE match_id=$1 AND status='HELD'",[match.id,aborted?'RELEASED':'SETTLED']);
    const winner=aborted?null:decision.winnerTeam;
    const deltas=aborted
      ? participants.map(participant=>({userId:participant.user_id,deltaPower:0}))
      : settlementDeltas(participants.map(p=>({userId:p.user_id,team:p.team})),winner,formal(match.mode)?match.stake:0);
    const transactionId=await transfer(client,`match:${match.id}:${aborted?'abort':'settle'}`,aborted?'MATCH_ABORT':'MATCH_SETTLE',null,deltas.map(d=>({walletId:personalWalletId(d.userId),amount:d.deltaPower})));
    for(const participant of participants)await client.query('UPDATE fish SET highest_power=GREATEST(highest_power,$2+(SELECT balance FROM wallets WHERE owner_user_id=$1)) WHERE user_id=$1',[participant.user_id,basePower(levelFromXp(participant.total_xp))]);
    const guildPointDeltas:Array<{guildId:string;points:number}>=[];
    if(!aborted && teamMode(match.mode) && formal(match.mode))for(const team of ['A','B'] as const) {
      const guildId=team==='A'?match.guild_a!:match.guild_b!;
      const points=winner===null?config.guild.pointsDraw:winner===team?config.guild.pointsWin:config.guild.pointsLoss;
      await client.query('INSERT INTO guild_season_stats(guild_id,season_id,points,wins,draws,losses) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(guild_id,season_id) DO UPDATE SET points=guild_season_stats.points+EXCLUDED.points,wins=guild_season_stats.wins+EXCLUDED.wins,draws=guild_season_stats.draws+EXCLUDED.draws,losses=guild_season_stats.losses+EXCLUDED.losses',[guildId,match.season_id,points,winner===team?1:0,winner===null?1:0,winner!==null&&winner!==team?1:0]);
      guildPointDeltas.push({guildId,points});
    }
    const result:MatchResultView={matchId:match.id,mode:match.mode,phase:aborted?'ABORTED':'FINISHED',winnerTeam:winner,reason:decision.reason,stake:match.stake,scoreA:decision.scoreA,scoreB:decision.scoreB,personalDeltas:deltas,guildPointDeltas,rulesVersion:match.rules_version,committedAt:new Date().toISOString()};
    await client.query('INSERT INTO match_results(match_id,winner_team,reason,final_score,settlement_tx_id,result_json) VALUES ($1,$2,$3,$4,$5,$6)',[match.id,winner,decision.reason,JSON.stringify({A:decision.scoreA,B:decision.scoreB}),transactionId,JSON.stringify(result)]);
    await client.query('UPDATE matches SET status=$2,ended_at=now(),deadline_at=NULL,version=version+1 WHERE id=$1',[match.id,result.phase]);
    for(const participant of participants)await client.query('INSERT INTO outbox_events(id,event_type,aggregate_id,payload) VALUES ($1,$2,$3,$4)',[randomUUID(),'self:invalidate',participant.user_id,JSON.stringify({domains:['match','wallet','daily','guild']})]);
    return result;
  }
  async settle(id:string,decision:MatchDecision):Promise<MatchResultView> {
    if(!this.decisions.has(id))this.decisions.set(id,decision);
    const result=await tx(async client=>this.finalize(client,await this.matchRow(client,id,true),this.decisions.get(id)!));await this.sync(id);return result;
  }
  /** Internal authority-only persistence of withdrawals; never releases a single player's hold. */
  async markWithdrawn(id:string,userIds:string[],reason:'FORFEIT'|'DISCONNECT') {
    await tx(async client=>{
      const match=await this.matchRow(client,id,true);
      if(!teamMode(match.mode)||!['COUNTDOWN','RUNNING','OVERTIME'].includes(match.status))return;
      const participants=await client.query('SELECT user_id FROM match_participants WHERE match_id=$1',[id]);
      const withdrawals={...match.payload.withdrawals};
      for(const userId of userIds)if(participants.rows.some(participant=>participant.user_id===userId))withdrawals[userId]??=reason;
      await client.query('UPDATE matches SET payload=payload||$2::jsonb,version=version+1 WHERE id=$1',[id,JSON.stringify({withdrawals})]);
    });
  }
  async cancel(userId:string,key:string,id:string):Promise<MatchView> {
    const result=await durable(userId,`matches:${id}:cancel`,key,{},async client=>{
      const match=await this.matchRow(client,id,true);const participants=await this.participantRows(client,id);
      const own=participants.find(p=>p.user_id===userId);
      const playing=['COUNTDOWN','RUNNING','OVERTIME','SETTLING'].includes(match.status);
      assert(own || !playing && match.payload.inviterId===userId,'FISH_NOT_OWNED','只有参赛者本人或发起队长可以取消',403);
      if(['FINISHED','ABORTED'].includes(match.status))return this.publicView(match,client);
      if(teamMode(match.mode) && playing && !this.decisions.has(id)) {
        const withdrawals={...match.payload.withdrawals,[userId]:'FORFEIT' as const};
        await client.query('UPDATE matches SET payload=payload||$2::jsonb,version=version+1 WHERE id=$1',[id,JSON.stringify({withdrawals})]);
        match.payload.withdrawals=withdrawals;
        const activeSides=new Set(participants.filter(participant=>!withdrawals[participant.user_id]).map(participant=>participant.team));
        if(activeSides.size===2)return this.publicView(await this.matchRow(client,id),client);
        await this.finalize(client,match,{winnerTeam:activeSides.size===1?[...activeSides][0] as 'A'|'B':null,reason:activeSides.size===1?'FORFEIT':'DRAW',scoreA:0,scoreB:0});
      } else await this.finalize(client,match,this.decisions.get(id)??{winnerTeam:playing?(own!.team==='A'?'B':'A'):null,reason:playing?'FORFEIT':'SYSTEM_ABORT',scoreA:0,scoreB:0});
      return this.publicView(await this.matchRow(client,id),client);
    });await this.sync(id);return result;
  }
  async abort(id:string) {return this.settle(id,{winnerTeam:null,reason:'SYSTEM_ABORT',scoreA:0,scoreB:0});}
  async recoverOldMatches(onlyMatchIds?:string[]) {
    const old=await pool.query('SELECT id FROM matches WHERE status=ANY($1::text[]) AND owner_epoch<>$2 AND ($3::uuid[] IS NULL OR id=ANY($3::uuid[])) ORDER BY id',[activePhases,ownerEpoch,onlyMatchIds??null]);
    for(const row of old.rows)await this.abort(row.id);
    return old.rowCount;
  }
  async abortAll() {const active=await pool.query('SELECT id FROM matches WHERE status=ANY($1::text[]) ORDER BY id',[activePhases]);for(const row of active.rows)await this.abort(row.id);}
  async expireDue() {
    const due=await pool.query("SELECT id FROM matches WHERE status IN ('INVITED','READY_CHECK') AND deadline_at<=now() ORDER BY id LIMIT 100");
    for(const row of due.rows)await this.abort(row.id);
  }
}
