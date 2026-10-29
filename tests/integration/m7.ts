import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { config } from '../../packages/game-core/src/index';
import { pool, tx } from '../../apps/server/src/persistence/db';
import { createFish, createGuest, selfView } from '../../apps/server/src/services/identity';
import { personalWalletId, transfer } from '../../apps/server/src/services/economy';
import { acceptApplication, applyToGuild, createGuild, getGuild } from '../../apps/server/src/services/guilds';
import { MatchService } from '../../apps/server/src/services/matches';
import { installBattles } from '../../apps/server/src/simulation/battle';
import { World, type ConnectionRuntime } from '../../apps/server/src/simulation/world';

type Side='A'|'B';
const appearance={presetId:'goldfish' as const,bodyColor:'#ffaa45',finColor:'#539bec',patternId:'none',skinAssetId:null,equipped:{},version:1};
const waitFor=async<T>(read:()=>T|Promise<T>,accept:(value:T)=>boolean,message:string,timeout=8000):Promise<T>=>{const deadline=Date.now()+timeout;while(true){const value=await read();if(accept(value))return value;if(Date.now()>deadline)throw new Error(message);await new Promise(resolve=>setTimeout(resolve,20));}};
async function rejectsCode(promise:Promise<unknown>,code:string){let caught=false;try{await promise;}catch(error){caught=true;assert.equal((error as {code?:string}).code,code);}assert(caught,`预期拒绝 ${code}`);}
async function member(name:string,balance=400){
  const {userId}=await createGuest();await createFish(userId,randomUUID(),{nickname:name,appearance});
  await tx(async client=>{await client.query("UPDATE users SET role='MEMBER',employee_ref=$2 WHERE id=$1",[userId,`m7-${randomUUID()}`]);const delta=balance-config.fish.starterPowerOnce;if(delta)await transfer(client,`m7-fixture:${userId}`,'TEST_FIXTURE',userId,[{walletId:personalWalletId(userId),amount:delta},{walletId:'system:MINT',amount:-delta}]);});
  return userId;
}
async function guild(prefix:string){
  const leader=await member(`${prefix}队长`,500);const created=await createGuild(leader,randomUUID(),{name:`${prefix}${randomUUID().slice(0,4)}`,badge:prefix,color:prefix==='A'?'#21BDE7':'#FF7B88',notice:''});
  const members=[leader];for(let i=1;i<4;i++){const id=await member(`${prefix}成员${i}`);await applyToGuild(id,randomUUID(),created.id);const view=await getGuild(leader,created.id);await acceptApplication(leader,randomUUID(),created.id,id,view.version);members.push(id);}
  return {id:created.id as string,leader,members};
}
async function online(world:World,userId:string){
  const player=(await world.refreshPlayer(userId))!;const id=`m7-socket-${randomUUID()}`;
  const connection={socket:{id,connected:true,emit:()=>undefined},userId,sceneEpoch:randomUUID(),lastInputAt:0,inputCount:0,rateWindow:0,lastEmote:0} as unknown as ConnectionRuntime;
  player.controlSocketId=id;player.disconnectedAt=null;player.leaseUntil=Date.now()+180000;player.pageVisible=true;world.connections.set(id,connection);return {player,connection};
}
async function teamMatch(matches:MatchService,a:{id:string;leader:string},b:{id:string;leader:string},rosterA:string[],rosterB:string[],mode:'TEAM_FORMAL'|'TEAM_FRIENDLY'){
  const invited=await matches.invite(a.leader,randomUUID(),{mode,targetGuildId:b.id,roster:rosterA});
  return matches.accept(b.leader,randomUUID(),invited.id,{version:invited.version,roster:rosterB});
}
async function readyAll(matches:MatchService,match:{id:string;stake:number;quoteVersion:number;participants:Array<{userId:string}>}){let current:any=match;for(const participant of match.participants)current=await matches.ready(participant.userId,randomUUID(),match.id,{quoteVersion:match.quoteVersion,stake:match.stake});return current;}
async function counter(ownerType:string,ownerId:string,date:string){return (await pool.query("SELECT used,reserved FROM daily_counters WHERE owner_type=$1 AND owner_id=$2 AND business_date=$3 AND counter_key='formal'",[ownerType,ownerId,date])).rows[0]??{used:0,reserved:0};}

try{
  const a=await guild('A'),b=await guild('B');
  const world=new World({} as ConstructorParameters<typeof World>[0]);
  const onlineUsers=new Map<string,Awaited<ReturnType<typeof online>>>();for(const id of [...a.members,...b.members])onlineUsers.set(id,await online(world,id));
  const matches=new MatchService(world);

  // TEAM01/05: six independent identities confirm, freeze and settle exactly once.
  const rosterA=a.members.slice(0,3),rosterB=b.members.slice(0,3);
  const formal=await teamMatch(matches,a,b,rosterA,rosterB,'TEAM_FORMAL');assert.equal(formal.participants.length,6);assert.equal(formal.stake,20);
  const countdown=await readyAll(matches,formal);assert.equal(countdown.phase,'COUNTDOWN');
  for(const id of [...rosterA,...rosterB])assert.equal((await selfView(id)).wallet.heldPower,20);
  const matchDate=(await pool.query('SELECT business_date::text AS date,season_id FROM matches WHERE id=$1',[formal.id])).rows[0];
  for(const id of [...rosterA,...rosterB])assert.deepEqual(await counter('USER',id,matchDate.date),{used:0,reserved:1});
  assert.deepEqual(await counter('GUILD_PAIR',[a.id,b.id].sort().join(':'),matchDate.date),{used:0,reserved:1});
  await matches.running(formal.id);
  const decision={winnerTeam:'A' as Side,reason:'SCORE_LIMIT' as const,scoreA:60,scoreB:22};
  const result=await matches.settle(formal.id,decision);const replays=await Promise.all(Array.from({length:10},()=>matches.settle(formal.id,decision)));
  for(const replay of replays)assert.deepEqual(replay,result);
  for(const id of rosterA){const self=await selfView(id);assert.equal(self.wallet.powerBalance,420);assert.equal(self.wallet.heldPower,0);}
  for(const id of rosterB){const self=await selfView(id);assert.equal(self.wallet.powerBalance,380);assert.equal(self.wallet.heldPower,0);}
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM ledger_transactions WHERE source_key=$1',[`match:${formal.id}:settle`])).rows[0].n,1);
  assert.equal(result.personalDeltas.filter(delta=>delta.deltaPower===20).length,3);assert.equal(result.personalDeltas.filter(delta=>delta.deltaPower===-20).length,3);
  let season=(await pool.query('SELECT guild_id,points,wins,losses FROM guild_season_stats WHERE season_id=$1 AND guild_id=ANY($2::uuid[]) ORDER BY guild_id',[matchDate.season_id,[a.id,b.id]])).rows;assert.equal(season.reduce((sum,row)=>sum+row.points,0),3);

  // TEAM06: a second game with rotated rosters counts against the same guild-pair quota; a third is rejected.
  const second=await teamMatch(matches,a,b,[a.members[0]!,a.members[2]!,a.members[3]!],[b.members[0]!,b.members[2]!,b.members[3]!],'TEAM_FORMAL');await readyAll(matches,second);await matches.running(second.id);await matches.settle(second.id,{winnerTeam:'A',reason:'TIME',scoreA:11,scoreB:8});
  const thirdInvite=await matches.invite(a.leader,randomUUID(),{mode:'TEAM_FORMAL',targetGuildId:b.id,roster:[a.members[0]!,a.members[1]!,a.members[3]!]});
  await rejectsCode(matches.accept(b.leader,randomUUID(),thirdInvite.id,{version:thirdInvite.version,roster:[b.members[0]!,b.members[1]!,b.members[3]!]}),'DAILY_LIMIT_REACHED');await matches.cancel(a.leader,randomUUID(),thirdInvite.id);
  assert.deepEqual(await counter('GUILD_PAIR',[a.id,b.id].sort().join(':'),matchDate.date),{used:2,reserved:0});
  season=(await pool.query('SELECT guild_id,points,wins,losses FROM guild_season_stats WHERE season_id=$1 AND guild_id=ANY($2::uuid[])',[matchDate.season_id,[a.id,b.id]])).rows;assert.equal(season.reduce((sum,row)=>sum+row.points,0),6);

  // TEAM02/03/04: authoritative pearl, shield/drop, respawn protection, scoring and overtime.
  const battleWorld=new World({} as ConstructorParameters<typeof World>[0]);const runtime=new Map<string,Awaited<ReturnType<typeof online>>>();for(const id of [...a.members,...b.members])runtime.set(id,await online(battleWorld,id));
  const installed=await installBattles(battleWorld);const friendly=await teamMatch(installed.matches,a,b,rosterA,rosterB,'TEAM_FRIENDLY');await readyAll(installed.matches,friendly);
  const arena:any=await waitFor(()=>installed.battle.arenas.get(friendly.id),Boolean,'团战竞技场未创建');arena.deadline=Date.now()-1;installed.battle.step(Date.now(),1/30);await waitFor(()=>arena.phase,(phase:string)=>phase==='RUNNING','团战未开始');
  const fighters=arena.fighters as any[],candidateA=fighters.find(f=>f.locked.userId===rosterA[0])!,candidateB=fighters.find(f=>f.locked.userId===rosterB[0])!;
  for(const fighter of fighters)fighter.player.fish.position={x:400,y:200};candidateA.player.fish.position={...config.battle.teamArena.center};candidateB.player.fish.position={...config.battle.teamArena.center};installed.battle.step(Date.now(),1/30);
  const expectedCarrier=[candidateA.locked.fishId,candidateB.locked.fishId].sort()[0];assert.equal(arena.pearl.carrierFishId,expectedCarrier);
  const carrier=fighters.find(f=>f.locked.fishId===expectedCarrier)!,attacker=fighters.find(f=>f.locked.team!==carrier.locked.team)!;
  carrier.player.fish.position={x:760,y:450};attacker.player.fish.position={x:720,y:450};carrier.player.shieldUntil=Date.now()+1000;attacker.player.dashDirection={x:1,y:0};attacker.player.dashUntil=Date.now()+500;attacker.dashTargets.clear();installed.battle.step(Date.now()+30,1/30);assert.equal(arena.pearl.carrierFishId,carrier.locked.fishId);assert.equal(carrier.player.shieldUntil,0);
  carrier.player.fish.position={x:760,y:450};attacker.player.fish.position={x:720,y:450};attacker.player.dashUntil=Date.now()+500;attacker.dashTargets.clear();carrier.invulnerableUntil=0;installed.battle.step(Date.now()+60,1/30);assert.equal(arena.pearl.oldCarrierFishId,carrier.locked.fishId);assert.notEqual(arena.pearl.carrierFishId,carrier.locked.fishId);
  carrier.player.fish.hp=1;carrier.player.fish.position={x:760,y:450};attacker.player.fish.position={x:720,y:450};attacker.player.dashUntil=Date.now()+500;attacker.dashTargets.clear();carrier.invulnerableUntil=0;installed.battle.step(Date.now()+90,1/30);assert(carrier.respawnAt!==null);assert.equal(carrier.player.fish.animation,'bubble');
  carrier.respawnAt=Date.now()-1;for(const fighter of fighters)if(fighter!==carrier)fighter.player.fish.position={x:400,y:200};installed.battle.step(Date.now()+120,1/30);assert.equal(carrier.player.fish.hp,carrier.locked.stats.hp);assert(carrier.protectionUntil>Date.now());arena.pearl={position:{...carrier.player.fish.position},carrierFishId:null,oldCarrierFishId:null,oldCarrierBlockedUntilServerMs:0,heldSinceMs:null,lastScoredAtMs:null};installed.battle.step(Date.now()+150,1/30);assert.equal(arena.pearl.carrierFishId,null);carrier.protectionUntil=0;installed.battle.step(Date.now()+180,1/30);assert.equal(arena.pearl.carrierFishId,carrier.locked.fishId);
  arena.scoreA=4;arena.scoreB=4;arena.deadline=Date.now()-1;installed.battle.step(Date.now()+210,1/30);await waitFor(()=>arena.phase,(phase:string)=>phase==='OVERTIME','平分未进入加时');arena.pearl={position:{...candidateA.player.fish.position},carrierFishId:candidateA.locked.fishId,oldCarrierFishId:null,oldCarrierBlockedUntilServerMs:0,heldSinceMs:Date.now()-config.battle.pearl.overtimeContinuousHoldSeconds*1000-10,lastScoredAtMs:Date.now()};installed.battle.step(Date.now()+240,1/30);
  const overtime=await waitFor(async()=>(await pool.query('SELECT result_json FROM match_results WHERE match_id=$1',[friendly.id])).rows[0]?.result_json,Boolean,'加时未结算');assert.equal(overtime.reason,'OVERTIME_HOLD');assert.equal(overtime.winnerTeam,'A');await waitFor(()=>arena.result,Boolean,'加时运行时未完成收尾');

  // TEAM07: one disconnected member withdraws while teammates continue; a whole team disconnect loses.
  const disconnectMatch=await teamMatch(installed.matches,a,b,rosterA,rosterB,'TEAM_FRIENDLY');await readyAll(installed.matches,disconnectMatch);const disconnectArena:any=await waitFor(()=>installed.battle.arenas.get(disconnectMatch.id),Boolean,'断线团战未创建');disconnectArena.deadline=Date.now()-1;installed.battle.step(Date.now(),1/30);await waitFor(()=>disconnectArena.phase,(phase:string)=>phase==='RUNNING','断线团战未开始');
  const lone=disconnectArena.fighters.find((fighter:any)=>fighter.locked.team==='A');lone.player.disconnectedAt=Date.now()-config.battle.disconnectGraceSeconds*1000-10;installed.battle.step(Date.now(),1/30);assert.equal(lone.withdrawn,true);assert.equal(disconnectArena.phase,'RUNNING');
  for(const fighter of disconnectArena.fighters.filter((entry:any)=>entry.locked.team==='A'))fighter.player.disconnectedAt=Date.now()-config.battle.disconnectGraceSeconds*1000-10;installed.battle.step(Date.now()+30,1/30);const disconnected=await waitFor(async()=>(await pool.query('SELECT result_json FROM match_results WHERE match_id=$1',[disconnectMatch.id])).rows[0]?.result_json,Boolean,'全队断线未结算');assert.equal(disconnected.reason,'DISCONNECT');assert.equal(disconnected.winnerTeam,'B');await waitFor(()=>disconnectArena.result,Boolean,'断线运行时未完成收尾');

  const drift=await pool.query("SELECT w.id FROM wallets w LEFT JOIN wallet_holds h ON h.wallet_id=w.id AND h.status='HELD' WHERE w.owner_kind='PERSONAL' GROUP BY w.id,w.held HAVING w.held<>COALESCE(sum(h.amount),0)");assert.equal(drift.rowCount,0);
  assert.equal((await pool.query('SELECT transaction_id FROM ledger_entries GROUP BY transaction_id HAVING sum(amount)<>0')).rowCount,0);assert.equal((await pool.query('SELECT 1 FROM daily_counters WHERE used+reserved>limit_value OR used<0 OR reserved<0')).rowCount,0);
  console.log(JSON.stringify({stage:'M7',database:'PostgreSQL17',passed:['六人独立确认与六份冻结','正式团战三胜三负守恒且十次结算一次','组织赛季积分幂等','换阵容不重置组织配对限额','唯一珍珠与同帧确定归属','护盾不掉珠、真实伤害掉珠','三秒复活与出生保护不可拾珠','平分加时连续持有胜利','单人断线继续、全队断线判负','全库流水、冻结与配额约束一致']},null,2));
}finally{await pool.end();}
