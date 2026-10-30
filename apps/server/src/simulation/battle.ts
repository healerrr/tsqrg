import { randomUUID } from 'node:crypto';
import { config, damageAfterShield, duelWinner, normalize, resolveArenaPosition, stepMovement, sweptCircleHit, pearlPickupCandidate, pickupPearl, dropPearl, pearlScore, overtimeHoldWon, type PearlState } from '@aquarium/core';
import type { FishSnapshot, InputFrame, MatchPhase, MatchResultView, SceneSnapshot, Vec2 } from '@aquarium/protocol';
import { pool } from '../persistence/db';
import { assert } from '../http/errors';
import { MatchService, type LockedFighter, type MatchDecision } from '../services/matches';
import type { BattleBridge, ConnectionRuntime, PlayerRuntime, World } from './world';

interface Fighter {
  locked: LockedFighter; player: PlayerRuntime; tankRoom: string; tankFish: FishSnapshot;
  invulnerableUntil: number; protectionUntil: number; dashTargets: Set<string>;
  respawnAt: number|null; withdrawn: boolean; withdrawalReason: 'FORFEIT'|'DISCONNECT'|null;
}
interface ArenaRuntime {
  id:string; roomId:string; roomEpoch:string; mode:string; phase:MatchPhase; deadline:number;
  fighters:Fighter[]; transitionPending:boolean; decision:MatchDecision|null; retryAt:number;
  result:MatchResultView|null; restoreAt:number; scoreA:number;scoreB:number;pearl:PearlState|null;guildA:string|null;guildB:string|null;
}
const isTeam=(mode:string)=>mode.startsWith('TEAM_');

/** Fixed-step authority. Database transitions are queued outside the simulation loop. */
export class BattleWorld implements BattleBridge {
  arenas=new Map<string,ArenaRuntime>();
  private loading=new Set<string>();
  constructor(public world:World,public matches:MatchService) { matches.changed=id=>{void this.changed(id).catch(error=>console.error('比赛场景更新失败',error));}; }
  async changed(id:string) {
    const record=await pool.query('SELECT status,payload FROM matches WHERE id=$1',[id]);if(!record.rowCount)return;
    const phase=record.rows[0].status as MatchPhase;
    const existing=this.arenas.get(id);
    if(existing)for(const fighter of existing.fighters) {
      const reason=record.rows[0].payload.withdrawals?.[fighter.locked.userId] as 'FORFEIT'|'DISCONNECT'|undefined;
      if(reason)this.withdraw(existing,fighter,reason,Date.now());
    }
    if(['FINISHED','ABORTED'].includes(phase)) {
      const arena=this.arenas.get(id);if(!arena)return;
      const result=await pool.query('SELECT result_json FROM match_results WHERE match_id=$1',[id]);
      if(result.rowCount)this.finished(arena,result.rows[0].result_json);return;
    }
    if(phase!=='COUNTDOWN'||this.arenas.has(id)||this.loading.has(id))return;
    this.loading.add(id);
    try {
      const {match,fighters}=await this.matches.locked(id);
      const arena:ArenaRuntime={id,roomId:`match:${id}`,roomEpoch:randomUUID(),mode:match.mode,phase:match.status,deadline:new Date(match.deadline_at!).getTime(),fighters:[],transitionPending:false,decision:null,retryAt:0,result:null,restoreAt:0,scoreA:0,scoreB:0,pearl:null,guildA:match.guild_a,guildB:match.guild_b};
      const geometry=isTeam(match.mode)?config.battle.teamArena:config.battle.duelArena;
      const indexes={A:0,B:0};
      assert(fighters.every(locked=>this.world.players.has(locked.userId)),'PEER_NOT_ELIGIBLE','参赛者场景尚未恢复');
      for(const locked of fighters) {
        const player=this.world.players.get(locked.userId);assert(player,'PEER_NOT_ELIGIBLE','参赛者场景尚未恢复');
        const spawn=(locked.team==='A'?geometry.spawnsA:geometry.spawnsB)[indexes[locked.team]++]!;
        const original=structuredClone(player.fish);
        const fighter:Fighter={locked,player,tankRoom:player.roomId,tankFish:original,invulnerableUntil:0,protectionUntil:0,dashTargets:new Set(),respawnAt:null,withdrawn:false,withdrawalReason:null};
        player.roomId=arena.roomId;player.input={kind:'idle'};player.ackInputSeq=0;player.ackActionSeq=0;player.dashUntil=0;player.dashReadyAt=0;player.shieldUntil=0;player.shieldReadyAt=0;player.follow.enabled=false;
        player.fish={...original,nickname:locked.nickname,appearance:structuredClone(locked.appearance),level:locked.level,position:{...spawn},velocity:{x:0,y:0},displaySize:1,team:locked.team,hp:locked.stats.hp,maxHp:locked.stats.hp,animation:'idle',followGroupId:null,followLeaderFishId:null,shieldUntilServerMs:0,respawnAtServerMs:null,spawnProtectionUntilServerMs:0,withdrawn:false};
        const withdrawal=match.payload.withdrawals?.[locked.userId];if(withdrawal)this.withdraw(arena,fighter,withdrawal,Date.now());
        this.newEpoch(player);arena.fighters.push(fighter);
      }
      if(isTeam(match.mode))arena.pearl={position:{...geometry.center},carrierFishId:null,oldCarrierFishId:null,oldCarrierBlockedUntilServerMs:0,heldSinceMs:null,lastScoredAtMs:null};
      this.arenas.set(id,arena);this.announce(arena);
    } catch(error) {
      console.error('竞技场建立失败，执行系统中止',id,error);
      await this.matches.abort(id);
    } finally {this.loading.delete(id);}
  }
  private newEpoch(player:PlayerRuntime) {
    for(const connection of this.world.connections.values())if(connection.userId===player.self.userId) {
      connection.sceneEpoch=randomUUID();
      connection.socket.emit('control:changed',{controlled:player.controlSocketId===connection.socket.id,controlledFishId:player.controlSocketId===connection.socket.id?player.fish.id:null,sceneEpoch:connection.sceneEpoch});
    }
  }
  private announce(arena:ArenaRuntime) {
    for(const connection of this.world.connections.values())if(connection.watchMatchId===arena.id || arena.fighters.some(f=>f.locked.userId===connection.userId))connection.socket.emit('match:phase',{matchId:arena.id,phase:arena.phase,deadlineAtServerMs:arena.deadline,quoteVersion:null,stake:null});
  }
  private forUser(userId:string):ArenaRuntime|undefined {return [...this.arenas.values()].find(a=>a.fighters.some(f=>f.locked.userId===userId));}
  private withdraw(arena:ArenaRuntime,fighter:Fighter,reason:'FORFEIT'|'DISCONNECT',now:number) {
    if(fighter.withdrawn)return;
    fighter.withdrawn=true;fighter.withdrawalReason=reason;fighter.respawnAt=null;
    const player=fighter.player;player.input={kind:'idle'};player.dashUntil=0;player.shieldUntil=0;player.fish.velocity={x:0,y:0};player.fish.animation='bubble';player.fish.interactive=false;player.fish.withdrawn=true;player.fish.respawnAtServerMs=null;
    if(arena.pearl?.carrierFishId===player.fish.id)this.drop(arena,player.fish.position,now);
    this.newEpoch(player);
  }
  canControl(userId:string):boolean {
    const arena=this.forUser(userId);if(!arena)return true;
    const fighter=arena.fighters.find(candidate=>candidate.locked.userId===userId)!;
    if(isTeam(arena.mode)&&fighter.player.disconnectedAt!==null&&Date.now()-fighter.player.disconnectedAt>config.battle.disconnectGraceSeconds*1000&&!['FINISHED','ABORTED'].includes(arena.phase)) {
      this.withdraw(arena,fighter,'DISCONNECT',Date.now());
      void this.matches.markWithdrawn(arena.id,[userId],'DISCONNECT').catch(error=>console.error('断线退出记录失败',arena.id,error));
    }
    return !fighter.withdrawn;
  }
  input(player:PlayerRuntime,frame:InputFrame):boolean {
    const arena=this.forUser(player.self.userId);if(!arena||player.roomId!==arena.roomId)return false;
    const fighter=arena.fighters.find(f=>f.locked.userId===player.self.userId)!;
    for(const action of frame.actions) {
      if(action.actionSeq<=player.ackActionSeq)continue;player.ackActionSeq=action.actionSeq;
      if(!['RUNNING','OVERTIME'].includes(arena.phase)||fighter.withdrawn||fighter.respawnAt!==null||!frame.pageVisible)continue;
      const now=Date.now();
      if(action.kind==='dash' && now>=player.dashReadyAt) {
        const requested=action.direction??(frame.move.kind==='direction'?frame.move.direction:frame.move.kind==='target'?{x:frame.move.target.x-player.fish.position.x,y:frame.move.target.y-player.fish.position.y}:{x:player.fish.facing==='left'?-1:1,y:0});
        const direction=normalize(requested);player.dashDirection=direction.x||direction.y?direction:{x:player.fish.facing==='left'?-1:1,y:0};
        player.dashUntil=now+config.battle.dashDurationSeconds*1000;player.dashReadyAt=now+config.battle.dashCooldownSeconds*1000;fighter.dashTargets.clear();
        this.world.sceneEvent(arena.roomId,{kind:'dash',fishId:player.fish.id,actionSeq:action.actionSeq,direction:player.dashDirection});
      }
      if(action.kind==='shield' && now>=player.shieldReadyAt) {player.shieldUntil=now+config.battle.shieldDurationSeconds*1000;player.shieldReadyAt=now+config.battle.shieldCooldownSeconds*1000;}
    }
    return true;
  }
  step(now:number,dt:number) {
    for(const arena of this.arenas.values()) {
      if(['FINISHED','ABORTED'].includes(arena.phase)) {if(now>=arena.restoreAt)this.restore(arena);continue;}
      if(arena.phase==='SETTLING') {if(!arena.transitionPending&&now>=arena.retryAt&&arena.decision)this.settle(arena,arena.decision);continue;}
      if(arena.phase==='COUNTDOWN') {
        if(now>=arena.deadline&&!arena.transitionPending) {
          arena.transitionPending=true;
          void this.matches.running(arena.id).then(match=>{if(arena.result)return;arena.phase=match.status;arena.deadline=new Date(match.deadline_at!).getTime();arena.transitionPending=false;this.announce(arena);}).catch(error=>{console.error('比赛开局提交失败',error);arena.transitionPending=false;this.settle(arena,{winnerTeam:null,reason:'SYSTEM_ABORT',scoreA:0,scoreB:0});});
        }
        continue;
      }
      if(!['RUNNING','OVERTIME'].includes(arena.phase))continue;
      this.simulate(arena,now,dt);
    }
  }
  private simulate(arena:ArenaRuntime,now:number,dt:number) {
    if(arena.transitionPending)return;
    const team=isTeam(arena.mode),geometry=team?config.battle.teamArena:config.battle.duelArena;
    const previous=new Map<string,Vec2>();
    const disconnectedPastGrace=arena.fighters.filter(f=>!f.withdrawn&&f.player.disconnectedAt!==null&&now-f.player.disconnectedAt>config.battle.disconnectGraceSeconds*1000);
    if(!team&&disconnectedPastGrace.length) {
      const sides=new Set(disconnectedPastGrace.map(f=>f.locked.team));
      this.settle(arena,{winnerTeam:sides.size===2?null:disconnectedPastGrace[0]!.locked.team==='A'?'B':'A',reason:sides.size===2?'DRAW':'DISCONNECT',scoreA:0,scoreB:0});
      return;
    }
    if(disconnectedPastGrace.length) {
      for(const fighter of disconnectedPastGrace)this.withdraw(arena,fighter,'DISCONNECT',now);
      arena.transitionPending=true;
      void this.matches.markWithdrawn(arena.id,disconnectedPastGrace.map(fighter=>fighter.locked.userId),'DISCONNECT').then(()=>{
        arena.transitionPending=false;if(!arena.result)this.simulate(arena,Date.now(),0);
      }).catch(error=>{arena.transitionPending=false;console.error('断线退出记录失败',arena.id,error);});
      return;
    }
    for(const fighter of arena.fighters) {
      const player=fighter.player,fish=player.fish;previous.set(fish.id,{...fish.position});
      if(fighter.withdrawn){fish.velocity={x:0,y:0};fish.animation='bubble';fish.interactive=false;continue;}
      if(fighter.respawnAt!==null) {
        if(now<fighter.respawnAt)continue;
        const own=arena.fighters.filter(f=>f.locked.team===fighter.locked.team),index=own.indexOf(fighter);
        const spawn=(fighter.locked.team==='A'?geometry.spawnsA:geometry.spawnsB)[index]!;
        fish.position={...spawn};fish.hp=fighter.locked.stats.hp;fish.respawnAtServerMs=null;fish.animation='idle';fighter.respawnAt=null;
        fighter.protectionUntil=now+config.battle.pearl.spawnProtectionSeconds*1000;fish.shieldUntilServerMs=fighter.protectionUntil;fish.spawnProtectionUntilServerMs=fighter.protectionUntil;
        this.world.sceneEvent(arena.roomId,{kind:'respawn',fishId:fish.id,position:fish.position});
      }
      const valid=player.controlSocketId&&player.leaseUntil>now&&player.pageVisible&&now-player.lastInputAt<=350&&player.disconnectedAt===null;
      const dash=now<player.dashUntil;
      const move=dash?{kind:'direction' as const,direction:player.dashDirection}:valid?player.input:{kind:'idle' as const};
      const carrier=arena.pearl?.carrierFishId===fish.id;
      const speed=(dash?config.battle.dashSpeed:fighter.locked.stats.speed)*(carrier?config.battle.pearl.carrierSpeedMultiplier:1);
      if(dash)fish.velocity={x:player.dashDirection.x*speed,y:player.dashDirection.y*speed};
      const next=stepMovement(fish,move,dt,{speed,arena:geometry,bodyRadius:config.battle.bodyRadius});fish.position=next.position;fish.velocity=next.velocity;
      if(Math.abs(next.velocity.x)>2)fish.facing=next.velocity.x<0?'left':'right';
      fish.angle=Math.atan2(next.velocity.y,Math.abs(next.velocity.x)+40)*.15;
      if(now>=player.animationUntil)fish.animation=dash?'dash':Math.hypot(next.velocity.x,next.velocity.y)>3?'swim':'idle';
      fish.shieldUntilServerMs=Math.max(player.shieldUntil,fighter.protectionUntil);
    }
    for(const attacker of arena.fighters) {
      if(attacker.withdrawn||attacker.respawnAt!==null||now>=attacker.player.dashUntil)continue;
      for(const target of arena.fighters) {
        if(target.locked.team===attacker.locked.team||target.withdrawn||target.respawnAt!==null||attacker.dashTargets.has(target.locked.fishId))continue;
        if(!sweptCircleHit(previous.get(attacker.locked.fishId)!,attacker.player.fish.position,config.battle.bodyRadius,previous.get(target.locked.fishId)!,target.player.fish.position,config.battle.bodyRadius))continue;
        attacker.dashTargets.add(target.locked.fishId);
        const damage=damageAfterShield({damage:attacker.locked.stats.damage,shieldUntilMs:target.player.shieldUntil,invulnerableUntilMs:Math.max(target.invulnerableUntil,target.protectionUntil),nowMs:now});
        if(damage.consumeShield)target.player.shieldUntil=0;
        if(damage.damage>0) {
          target.player.fish.hp=Math.max(0,target.player.fish.hp!-damage.damage);target.invulnerableUntil=now+config.battle.damageInvulnerabilitySeconds*1000;
          target.player.fish.animation='hit';target.player.animationUntil=now+200;
          const push=attacker.player.dashDirection;target.player.fish.position=resolveArenaPosition({x:target.player.fish.position.x+push.x*18,y:target.player.fish.position.y+push.y*18},geometry,config.battle.bodyRadius);
          if(arena.pearl?.carrierFishId===target.locked.fishId)this.drop(arena,target.player.fish.position,now);
          if(team&&target.player.fish.hp===0){target.respawnAt=now+config.battle.pearl.respawnSeconds*1000;target.player.fish.respawnAtServerMs=target.respawnAt;target.player.fish.animation='bubble';target.player.fish.velocity={x:0,y:0};target.player.input={kind:'idle'};target.player.dashUntil=0;target.player.shieldUntil=0;}
        }
        this.world.sceneEvent(arena.roomId,{kind:'hit',sourceFishId:attacker.locked.fishId,targetFishId:target.locked.fishId,damage:damage.damage,blocked:damage.blocked});
      }
    }
    if(!team) {
      const a=arena.fighters.find(f=>f.locked.team==='A')!.player.fish,b=arena.fighters.find(f=>f.locked.team==='B')!.player.fish;
      if(a.hp===0||b.hp===0){const winner=duelWinner({hp:a.hp!,maxHp:a.maxHp!},{hp:b.hp!,maxHp:b.maxHp!});this.settle(arena,{winnerTeam:winner,reason:winner?'HP_ZERO':'DRAW',scoreA:a.hp!,scoreB:b.hp!});}
      else if(now>=arena.deadline){const winner=duelWinner({hp:a.hp!,maxHp:a.maxHp!},{hp:b.hp!,maxHp:b.maxHp!});this.settle(arena,{winnerTeam:winner,reason:winner?'TIME':'DRAW',scoreA:a.hp!,scoreB:b.hp!});}
      return;
    }
    const alive=(side:'A'|'B')=>arena.fighters.filter(f=>f.locked.team===side).some(f=>!f.withdrawn);
    if(!alive('A')||!alive('B')){this.settle(arena,{winnerTeam:alive('A')?'A':alive('B')?'B':null,reason:alive('A')||alive('B')?'DISCONNECT':'DRAW',scoreA:arena.scoreA,scoreB:arena.scoreB});return;}
    this.updatePearl(arena,now);
    if(arena.phase==='RUNNING'&&(arena.scoreA>=config.battle.pearl.scoreToWin||arena.scoreB>=config.battle.pearl.scoreToWin))this.settle(arena,{winnerTeam:arena.scoreA>arena.scoreB?'A':'B',reason:'SCORE_LIMIT',scoreA:arena.scoreA,scoreB:arena.scoreB});
    else if(now>=arena.deadline&&arena.phase==='RUNNING') {
      if(arena.scoreA!==arena.scoreB)this.settle(arena,{winnerTeam:arena.scoreA>arena.scoreB?'A':'B',reason:'TIME',scoreA:arena.scoreA,scoreB:arena.scoreB});
      else if(!arena.transitionPending) {
        arena.transitionPending=true;const deadline=now+config.battle.pearl.overtimeSeconds*1000;
        void this.matches.phase(arena.id,'OVERTIME',deadline).then(()=>{if(arena.result)return;arena.phase='OVERTIME';arena.deadline=deadline;arena.transitionPending=false;arena.pearl={position:{...config.battle.teamArena.center},carrierFishId:null,oldCarrierFishId:null,oldCarrierBlockedUntilServerMs:0,heldSinceMs:null,lastScoredAtMs:null};this.announce(arena);}).catch(error=>{console.error('加时提交失败',error);this.settle(arena,{winnerTeam:null,reason:'SYSTEM_ABORT',scoreA:arena.scoreA,scoreB:arena.scoreB});});
      }
    } else if(arena.phase==='OVERTIME'&&arena.pearl&&overtimeHoldWon(arena.pearl,now)) {
      const holder=arena.fighters.find(f=>f.locked.fishId===arena.pearl!.carrierFishId)!;this.settle(arena,{winnerTeam:holder.locked.team,reason:'OVERTIME_HOLD',scoreA:arena.scoreA,scoreB:arena.scoreB});
    } else if(arena.phase==='OVERTIME'&&now>=arena.deadline)this.settle(arena,{winnerTeam:null,reason:'DRAW',scoreA:arena.scoreA,scoreB:arena.scoreB});
  }
  private updatePearl(arena:ArenaRuntime,now:number) {
    if(!arena.pearl)return;
    if(arena.pearl.carrierFishId) {
      const holder=arena.fighters.find(f=>f.locked.fishId===arena.pearl!.carrierFishId);
      if(!holder||holder.withdrawn||holder.respawnAt!==null)this.drop(arena,holder?.player.fish.position??config.battle.teamArena.center,now);
      else {
        arena.pearl.position={...holder.player.fish.position};const score=pearlScore(arena.pearl,now);arena.pearl=score.pearl;
        if(arena.phase==='RUNNING'){if(holder.locked.team==='A')arena.scoreA+=score.points;else arena.scoreB+=score.points;}
      }
    }
    if(!arena.pearl.carrierFishId) {
      const candidate=pearlPickupCandidate(arena.pearl,arena.fighters.map(f=>({fishId:f.locked.fishId,team:f.locked.team,position:f.player.fish.position,hp:f.player.fish.hp!,protectionUntilMs:f.protectionUntil,active:!f.withdrawn&&f.respawnAt===null})),now);
      if(candidate){arena.pearl=pickupPearl(arena.pearl,candidate,now);this.world.sceneEvent(arena.roomId,{kind:'pearl',carrierFishId:candidate.fishId,position:arena.pearl.position});}
    }
  }
  private drop(arena:ArenaRuntime,position:Vec2,now:number) {if(!arena.pearl)return;arena.pearl=dropPearl(arena.pearl,resolveArenaPosition(position,config.battle.teamArena,config.battle.bodyRadius),now);this.world.sceneEvent(arena.roomId,{kind:'pearl',carrierFishId:null,position:arena.pearl.position});}
  private settle(arena:ArenaRuntime,decision:MatchDecision) {
    if(arena.transitionPending&&arena.phase==='SETTLING')return;
    arena.phase='SETTLING';arena.decision=decision;arena.transitionPending=true;this.announce(arena);
    void this.matches.settle(arena.id,decision).then(result=>this.finished(arena,result)).catch(error=>{console.error('比赛等待幂等结算重试',arena.id,error);arena.transitionPending=false;arena.retryAt=Date.now()+1000;});
  }
  private finished(arena:ArenaRuntime,result:MatchResultView) {
    if(arena.result)return;
    arena.result=result;arena.phase=result.phase;arena.transitionPending=false;arena.deadline=0;arena.restoreAt=Date.now()+1800;
    for(const fighter of arena.fighters){const player=fighter.player;player.input={kind:'idle'};player.fish.velocity={x:0,y:0};player.fish.animation=result.winnerTeam===null?'idle':result.winnerTeam===fighter.locked.team?'victory':'defeat';}
    this.announce(arena);
  }
  private restore(arena:ArenaRuntime) {
    for(const fighter of arena.fighters) {
      const player=fighter.player;if(player.roomId!==arena.roomId)continue;
      player.roomId=this.world.tankRoomForReturn(player,fighter.tankRoom);
      this.world.rememberTankLocation(player);
      player.fish={...fighter.tankFish,appearance:player.self.appearance??fighter.tankFish.appearance,level:player.self.level,guildId:player.self.guildId,team:null,hp:null,maxHp:null,animation:'idle',velocity:{x:0,y:0},followGroupId:null,shieldUntilServerMs:0,respawnAtServerMs:null,interactive:player.disconnectedAt===null};
      player.input={kind:'idle'};player.ackInputSeq=0;player.ackActionSeq=0;player.dashUntil=0;player.shieldUntil=0;this.newEpoch(player);
    }
    for(const connection of this.world.connections.values())if(connection.watchMatchId===arena.id) {
      connection.watchMatchId=undefined;connection.sceneEpoch=randomUUID();
    }
    this.arenas.delete(arena.id);
  }
  disconnected(_userId:string) { /* Per-player disconnect timestamps belong to World and are inspected each tick. */ }
  async join(userId:string,request:{sceneKind:string;watchMatchId?:string},connection?:ConnectionRuntime) {
    const ownArena=this.forUser(userId);
    if(request.sceneKind==='TANK') {
      assert(!ownArena||['FINISHED','ABORTED'].includes(ownArena.phase),'MATCH_STATE_INVALID','比赛进行中，请结束后返回主缸');
      if(connection)connection.watchMatchId=undefined;
      if(ownArena)this.restore(ownArena);return;
    }
    if(request.watchMatchId) {
      const arena=this.arenas.get(request.watchMatchId),player=this.world.players.get(userId);
      assert(connection&&player&&arena&&isTeam(arena.mode),'FISH_NOT_OWNED','没有进入这场竞技的权限',403);
      assert(!!player.self.guildId&&[arena.guildA,arena.guildB].includes(player.self.guildId),'FISH_NOT_OWNED','只有参赛鱼群成员可以观战',403);
      assert(!arena.fighters.some(f=>f.locked.userId===userId),'MATCH_STATE_INVALID','参赛者已在竞技场中');
      assert(request.sceneKind==='TEAM','MATCH_STATE_INVALID','竞技场类型不匹配');
      player.input={kind:'idle'};connection.watchMatchId=arena.id;return;
    }
    assert(ownArena,'FISH_NOT_OWNED','没有进入这场竞技的权限',403);
    if(connection)connection.watchMatchId=undefined;
    assert(request.sceneKind===(isTeam(ownArena.mode)?'TEAM':'DUEL'),'MATCH_STATE_INVALID','竞技场类型不匹配');
  }
  snapshot(player:PlayerRuntime,connection:ConnectionRuntime):SceneSnapshot|null {
    const arena=connection.watchMatchId?this.arenas.get(connection.watchMatchId):this.forUser(player.self.userId);
    if(!arena||(!connection.watchMatchId&&player.roomId!==arena.roomId))return null;
    const own=arena.fighters.find(f=>f.locked.userId===player.self.userId);
    const controlled=!!own&&!connection.watchMatchId&&player.controlSocketId===connection.socket.id&&player.leaseUntil>Date.now()&&!own.withdrawn;
    return {protocolVersion:1,snapshotKind:'full',rulesVersion:config.rulesVersion,roomId:arena.roomId,roomEpoch:arena.roomEpoch,sceneEpoch:connection.sceneEpoch,sceneKind:isTeam(arena.mode)?'TEAM':'DUEL',serverTick:this.world.serverTick,serverTimeMs:Date.now(),ackInputSeq:player.ackInputSeq,ackActionSeq:player.ackActionSeq,controlledFishId:controlled?player.fish.id:null,
      fish:arena.fighters.map(f=>({...f.player.fish,disconnectDeadlineAtServerMs:f.player.disconnectedAt===null?null:f.player.disconnectedAt+config.battle.disconnectGraceSeconds*1000})),food:[],npc:[],pearl:arena.pearl?{id:`pearl:${arena.id}`,position:arena.pearl.position,carrierFishId:arena.pearl.carrierFishId,oldCarrierFishId:arena.pearl.oldCarrierFishId,oldCarrierBlockedUntilServerMs:arena.pearl.oldCarrierBlockedUntilServerMs}:null,
      match:{id:arena.id,phase:arena.phase,deadlineAtServerMs:arena.deadline,scoreA:arena.scoreA,scoreB:arena.scoreB},ownRuntime:controlled?{stamina:config.tank.staminaMax,dashReadyAtServerMs:player.dashReadyAt,shieldReadyAtServerMs:player.shieldReadyAt}:null};
  }
  async close() {this.matches.stop();await this.matches.abortAll();for(const arena of this.arenas.values())this.restore(arena);}
}

export async function installBattles(world:World):Promise<{matches:MatchService;battle:BattleWorld}> {
  const matches=new MatchService(world),battle=new BattleWorld(world,matches);world.battle=battle;
  return {matches,battle};
}
