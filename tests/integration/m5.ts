import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { businessDate, config } from '../../packages/game-core/src/index';
import { inputFrameSchema, type InputFrame } from '../../packages/protocol/src/index';
import { pool, tx } from '../../apps/server/src/persistence/db';
import { createFish, createGuest, selfView } from '../../apps/server/src/services/identity';
import { ensureDaily, personalWalletId, transfer } from '../../apps/server/src/services/economy';
import { MatchService } from '../../apps/server/src/services/matches';
import { installBattles } from '../../apps/server/src/simulation/battle';
import { World, type ConnectionRuntime, type PlayerRuntime } from '../../apps/server/src/simulation/world';

type Side = 'A'|'B';
const appearance={presetId:'goldfish' as const,bodyColor:'#ffaa45',finColor:'#539bec',patternId:'none',skinAssetId:null,equipped:{},version:1};
const waitFor=async<T>(read:()=>T|Promise<T>,accept:(value:T)=>boolean,message:string,timeout=8000):Promise<T>=>{
  const deadline=Date.now()+timeout;
  while(true){const value=await read();if(accept(value))return value;if(Date.now()>deadline)throw new Error(message);await new Promise(resolve=>setTimeout(resolve,20));}
};
async function rejectsCode(promise:Promise<unknown>,code:string){let caught=false;try{await promise;}catch(error){caught=true;assert.equal((error as {code?:string}).code,code);}assert(caught,`预期拒绝 ${code}`);}
async function member(name:string,balance:number){
  const {userId}=await createGuest();
  await createFish(userId,randomUUID(),{nickname:name,appearance});
  await tx(async client=>{
    await client.query("UPDATE users SET role='MEMBER',employee_ref=$2 WHERE id=$1",[userId,`m5-${randomUUID()}`]);
    const delta=balance-config.fish.starterPowerOnce;
    if(delta)await transfer(client,`m5-fixture:${userId}`,'TEST_FIXTURE',userId,[{walletId:personalWalletId(userId),amount:delta},{walletId:'system:MINT',amount:-delta}]);
  });
  return userId;
}
async function online(world:World,userId:string){
  const player=(await world.refreshPlayer(userId))!;
  const id=`m5-socket-${randomUUID()}`;
  const connection={socket:{id,connected:true,emit:()=>undefined},userId,sceneEpoch:randomUUID(),lastInputAt:0,inputCount:0,rateWindow:0,lastEmote:0} as unknown as ConnectionRuntime;
  player.controlSocketId=id;player.disconnectedAt=null;player.leaseUntil=Date.now()+120000;player.pageVisible=true;
  world.connections.set(id,connection);
  return {player,connection};
}
async function pair(world:World,aBalance=600,bBalance=400,prefix='PK'){
  const a=await member(`${prefix}甲`,aBalance),b=await member(`${prefix}乙`,bBalance);
  const pa=await online(world,a),pb=await online(world,b);
  return {a,b,pa,pb};
}
async function createAccepted(matches:MatchService,a:string,b:string,mode:'DUEL_FORMAL'|'DUEL_FRIENDLY'){
  const invited=await matches.invite(a,randomUUID(),{mode,targetUserId:b});
  const accepted=await matches.accept(b,randomUUID(),invited.id,{version:invited.version});
  return accepted;
}
async function readyBoth(matches:MatchService,id:string,a:string,b:string,stake:number,quoteVersion=1){
  const first=await matches.ready(a,randomUUID(),id,{quoteVersion,stake});
  assert.equal(first.phase,'READY_CHECK');
  return matches.ready(b,randomUUID(),id,{quoteVersion,stake});
}
async function status(id:string){return (await pool.query('SELECT status FROM matches WHERE id=$1',[id])).rows[0]?.status as string|undefined;}
async function counter(ownerType:string,ownerId:string,date:string){
  const row=(await pool.query('SELECT used,reserved FROM daily_counters WHERE owner_type=$1 AND owner_id=$2 AND business_date=$3 AND counter_key=$4',[ownerType,ownerId,date,'formal'])).rows[0];
  return row??{used:0,reserved:0};
}

try{
  const world=new World({} as ConstructorParameters<typeof World>[0]);
  const matches=new MatchService(world);

  // PK01/06/10: quote, atomic holds, quota consumption and replay-safe settlement.
  const first=await pair(world,600,400,'正式结算');
  const formal=await createAccepted(matches,first.a,first.b,'DUEL_FORMAL');
  assert.equal(formal.stake,20);
  await matches.ready(first.a,randomUUID(),formal.id,{quoteVersion:formal.quoteVersion,stake:20});
  assert.equal((await selfView(first.a)).wallet.heldPower,0);
  const countdown=await matches.ready(first.b,randomUUID(),formal.id,{quoteVersion:formal.quoteVersion,stake:20});
  assert.equal(countdown.phase,'COUNTDOWN');
  assert.equal((await selfView(first.a)).wallet.heldPower,20);assert.equal((await selfView(first.b)).wallet.heldPower,20);
  const formalDate=(await pool.query('SELECT business_date::text AS date FROM matches WHERE id=$1',[formal.id])).rows[0].date;
  assert.deepEqual(await counter('USER',first.a,formalDate),{used:0,reserved:1});
  await matches.running(formal.id);
  const decision={winnerTeam:'A' as Side,reason:'HP_ZERO' as const,scoreA:42,scoreB:0};
  const settled=await matches.settle(formal.id,decision);
  const replays=await Promise.all(Array.from({length:10},()=>matches.settle(formal.id,decision)));
  for(const replay of replays)assert.deepEqual(replay,settled);
  assert.equal((await selfView(first.a)).wallet.powerBalance,620);assert.equal((await selfView(first.b)).wallet.powerBalance,380);
  assert.equal((await selfView(first.a)).wallet.heldPower,0);assert.equal((await selfView(first.b)).wallet.heldPower,0);
  assert.deepEqual(await counter('USER',first.a,formalDate),{used:1,reserved:0});
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM ledger_transactions WHERE source_key=$1',[`match:${formal.id}:settle`])).rows[0].n,1);
  const secondFormal=await matches.invite(first.a,randomUUID(),{mode:'DUEL_FORMAL',targetUserId:first.b});
  await rejectsCode(matches.accept(first.b,randomUUID(),secondFormal.id,{version:secondFormal.version}),'DAILY_LIMIT_REACHED');
  await matches.cancel(first.a,randomUUID(),secondFormal.id);
  const laterFriendly=await createAccepted(matches,first.a,first.b,'DUEL_FRIENDLY');assert.equal(laterFriendly.stake,0);await matches.cancel(first.a,randomUUID(),laterFriendly.id);

  // PK02: an intervening spend changes the quote, clears every ready flag, and creates no one-sided hold.
  const repriced=await pair(world,600,400,'重新报价');
  const quote=await createAccepted(matches,repriced.a,repriced.b,'DUEL_FORMAL');assert.equal(quote.stake,20);
  await tx(client=>transfer(client,`m5-spend:${repriced.a}`,'TEST_SPEND',repriced.a,[{walletId:personalWalletId(repriced.a),amount:-300},{walletId:'system:SINK',amount:300}]));
  await rejectsCode(matches.ready(repriced.a,randomUUID(),quote.id,{quoteVersion:quote.quoteVersion,stake:20}),'VERSION_CONFLICT');
  const requote=await matches.view(repriced.a,quote.id);assert.equal(requote.stake,15);assert.equal(requote.quoteVersion,2);assert(requote.participants.every(p=>!p.ready));
  assert.equal((await selfView(repriced.a)).wallet.heldPower,0);assert.equal((await selfView(repriced.b)).wallet.heldPower,0);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM wallet_holds WHERE match_id=$1 AND status='HELD'",[quote.id])).rows[0].n,0);
  await matches.cancel(repriced.a,randomUUID(),quote.id);

  // PK03: insufficient available power blocks formal play but not friendly play.
  const low=await pair(world,19,100,'低余额');
  const lowFormal=await matches.invite(low.a,randomUUID(),{mode:'DUEL_FORMAL',targetUserId:low.b});
  await rejectsCode(matches.accept(low.b,randomUUID(),lowFormal.id,{version:lowFormal.version}),'INSUFFICIENT_AVAILABLE_POWER');
  await matches.cancel(low.a,randomUUID(),lowFormal.id);
  const lowFriendly=await createAccepted(matches,low.a,low.b,'DUEL_FRIENDLY');assert.equal(lowFriendly.stake,0);await matches.cancel(low.a,randomUUID(),lowFriendly.id);

  // PK07: a normal draw returns both holds; a countdown forfeit consumes the entry and transfers once.
  const drawPair=await pair(world,400,400,'平局');
  const drawMatch=await createAccepted(matches,drawPair.a,drawPair.b,'DUEL_FORMAL');await readyBoth(matches,drawMatch.id,drawPair.a,drawPair.b,20);await matches.running(drawMatch.id);
  const draw=await matches.settle(drawMatch.id,{winnerTeam:null,reason:'DRAW',scoreA:50,scoreB:50});assert(draw.personalDeltas.every(d=>d.deltaPower===0));
  assert.equal((await selfView(drawPair.a)).wallet.powerBalance,400);assert.equal((await selfView(drawPair.a)).wallet.heldPower,0);
  const forfeitPair=await pair(world,400,400,'认输');
  const forfeitMatch=await createAccepted(matches,forfeitPair.a,forfeitPair.b,'DUEL_FORMAL');await readyBoth(matches,forfeitMatch.id,forfeitPair.a,forfeitPair.b,20);
  const forfeited=await matches.cancel(forfeitPair.a,randomUUID(),forfeitMatch.id);assert.equal(forfeited.result?.reason,'FORFEIT');assert.equal(forfeited.result?.winnerTeam,'B');
  assert.equal((await selfView(forfeitPair.a)).wallet.powerBalance,380);assert.equal((await selfView(forfeitPair.b)).wallet.powerBalance,420);

  // PK09: both reserved and already-consumed quota are restored on old-instance recovery.
  const recoverReady=await pair(world,400,400,'准备恢复');
  const readyMatch=await createAccepted(matches,recoverReady.a,recoverReady.b,'DUEL_FORMAL');await readyBoth(matches,readyMatch.id,recoverReady.a,recoverReady.b,20);
  const readyDate=(await pool.query('SELECT business_date::text AS date FROM matches WHERE id=$1',[readyMatch.id])).rows[0].date;
  await pool.query('UPDATE matches SET owner_epoch=$2 WHERE id=$1',[readyMatch.id,randomUUID()]);assert.equal(await matches.recoverOldMatches([readyMatch.id]),1);
  assert.equal(await status(readyMatch.id),'ABORTED');assert.equal((await selfView(recoverReady.a)).wallet.heldPower,0);assert.deepEqual(await counter('USER',recoverReady.a,readyDate),{used:0,reserved:0});
  const recoverRunning=await pair(world,400,400,'运行恢复');
  const runningMatch=await createAccepted(matches,recoverRunning.a,recoverRunning.b,'DUEL_FORMAL');await readyBoth(matches,runningMatch.id,recoverRunning.a,recoverRunning.b,20);await matches.running(runningMatch.id);
  const runningDate=(await pool.query('SELECT business_date::text AS date FROM matches WHERE id=$1',[runningMatch.id])).rows[0].date;
  await pool.query('UPDATE matches SET owner_epoch=$2 WHERE id=$1',[runningMatch.id,randomUUID()]);assert.equal(await matches.recoverOldMatches([runningMatch.id]),1);
  assert.deepEqual(await counter('USER',recoverRunning.a,runningDate),{used:0,reserved:0});assert.equal((await selfView(recoverRunning.a)).wallet.powerBalance,400);
  assert.equal(await matches.recoverOldMatches([formal.id]),0);assert.equal((await selfView(first.a)).wallet.powerBalance,620);

  // PK10: the shared per-player formal quota also blocks a new duel while friendly remains available.
  const capped=await pair(world,400,400,'日额度');
  await tx(async client=>{await ensureDaily(client,capped.a,businessDate());await client.query("UPDATE daily_counters SET used=$3 WHERE owner_type='USER' AND owner_id=$1 AND business_date=$2 AND counter_key='formal'",[capped.a,businessDate(),config.daily.formalMatchesPerPlayer]);});
  const cappedFormal=await matches.invite(capped.a,randomUUID(),{mode:'DUEL_FORMAL',targetUserId:capped.b});await rejectsCode(matches.accept(capped.b,randomUUID(),cappedFormal.id,{version:cappedFormal.version}),'DAILY_LIMIT_REACHED');await matches.cancel(capped.a,randomUUID(),cappedFormal.id);
  const cappedFriendly=await createAccepted(matches,capped.a,capped.b,'DUEL_FRIENDLY');await matches.cancel(capped.a,randomUUID(),cappedFriendly.id);

  // PK11: settlement uses the frozen business date, even after the current date has changed.
  const dated=await pair(world,400,400,'跨日');
  const datedMatch=await createAccepted(matches,dated.a,dated.b,'DUEL_FORMAL');await readyBoth(matches,datedMatch.id,dated.a,dated.b,20);
  const today=(await pool.query('SELECT business_date::text AS date FROM matches WHERE id=$1',[datedMatch.id])).rows[0].date as string;
  const previous=businessDate(new Date(`${today}T00:00:00+08:00`).getTime()-86400000);
  const pairKey=[dated.a,dated.b].sort().join(':');
  await tx(async client=>{
    await client.query("UPDATE daily_counters SET business_date=$3 WHERE business_date=$2 AND counter_key='formal' AND ((owner_type='USER' AND owner_id=ANY($1::text[])) OR (owner_type='DUEL_PAIR' AND owner_id=$4))",[[dated.a,dated.b],today,previous,pairKey]);
    await client.query('UPDATE matches SET business_date=$2 WHERE id=$1',[datedMatch.id,previous]);
  });
  await matches.running(datedMatch.id);await matches.settle(datedMatch.id,{winnerTeam:null,reason:'DRAW',scoreA:100,scoreB:100});
  assert.deepEqual(await counter('USER',dated.a,previous),{used:1,reserved:0});assert.deepEqual(await counter('DUEL_PAIR',pairKey,previous),{used:1,reserved:0});

  // PK04/05/08: exercise the authoritative arena, skill cooldown, shield, swept hit and disconnect outcomes.
  const battleWorld=new World({} as ConstructorParameters<typeof World>[0]);
  const installed=await installBattles(battleWorld);
  async function runningFriendly(prefix:string){
    const users=await pair(battleWorld,100,100,prefix);
    const match=await createAccepted(installed.matches,users.a,users.b,'DUEL_FRIENDLY');await readyBoth(installed.matches,match.id,users.a,users.b,0);
    const arena=await waitFor(()=>installed.battle.arenas.get(match.id),Boolean,'竞技场未创建');arena!.deadline=Date.now()-1;installed.battle.step(Date.now(),1/30);
    await waitFor(()=>arena!.phase,phase=>phase==='RUNNING','竞技场未进入运行阶段');
    return {...users,match,arena:arena!};
  }
  const combat=await runningFriendly('权威技能');
  const fighterA=combat.arena.fighters.find((f:any)=>f.locked.userId===combat.a) as any;
  const fighterB=combat.arena.fighters.find((f:any)=>f.locked.userId===combat.b) as any;
  const send=(player:PlayerRuntime,connection:ConnectionRuntime,inputSeq:number,actionSeq:number,kind:'dash'|'shield',direction={x:1,y:0})=>{
    const frame:InputFrame={protocolVersion:1,roomId:player.roomId,sceneEpoch:connection.sceneEpoch,inputSeq,basedOnServerTick:battleWorld.serverTick,move:{kind:'direction',direction},actions:[{actionSeq,kind,direction,issuedAtClientMs:Date.now()}],pageVisible:true};
    battleWorld.input(connection,frame);return frame;
  };
  const shieldFrame=send(combat.pb.player,combat.pb.connection,1,1,'shield',{x:-1,y:0});const firstShieldUntil=combat.pb.player.shieldUntil;
  send(combat.pb.player,combat.pb.connection,2,2,'shield',{x:-1,y:0});assert.equal(combat.pb.player.shieldUntil,firstShieldUntil);assert(combat.pb.player.shieldReadyAt>firstShieldUntil);
  assert.equal(inputFrameSchema.safeParse({...shieldFrame,position:{x:0,y:0}}).success,false);
  fighterA.player.fish.position={x:400,y:360};fighterB.player.fish.position={x:470,y:360};
  send(combat.pa.player,combat.pa.connection,1,1,'dash');const hpBefore=fighterB.player.fish.hp;
  const t0=Date.now();for(let i=1;i<=6;i++)installed.battle.step(t0+i*30,1/30);
  assert.equal(fighterB.player.fish.hp,hpBefore);assert.equal(combat.pb.player.shieldUntil,0);
  combat.pa.player.dashUntil=0;combat.pa.player.dashReadyAt=0;fighterA.player.fish.position={x:400,y:360};fighterB.player.fish.position={x:470,y:360};
  send(combat.pa.player,combat.pa.connection,2,2,'dash');const t1=Date.now();for(let i=1;i<=8;i++)installed.battle.step(t1+i*30,1/30);
  assert.equal(fighterB.player.fish.hp,hpBefore-fighterA.locked.stats.damage);const once=fighterB.player.fish.hp;for(let i=9;i<=12;i++)installed.battle.step(t1+i*30,1/30);assert.equal(fighterB.player.fish.hp,once);
  await installed.matches.settle(combat.match.id,{winnerTeam:'A',reason:'TIME',scoreA:fighterA.player.fish.hp,scoreB:fighterB.player.fish.hp});

  const bothGone=await runningFriendly('双断线');
  bothGone.pa.player.disconnectedAt=Date.now()-8000;installed.battle.step(Date.now(),1/30);
  assert.equal(bothGone.arena.phase,'RUNNING');assert.equal((await pool.query('SELECT 1 FROM match_results WHERE match_id=$1',[bothGone.match.id])).rowCount,0);
  bothGone.pa.player.disconnectedAt=null;
  bothGone.pa.player.disconnectedAt=Date.now()-config.battle.disconnectGraceSeconds*1000-10;bothGone.pb.player.disconnectedAt=bothGone.pa.player.disconnectedAt;
  installed.battle.step(Date.now(),1/30);
  const bothResult=await waitFor(async()=>(await pool.query('SELECT result_json FROM match_results WHERE match_id=$1',[bothGone.match.id])).rows[0]?.result_json,Boolean,'双断线未结算');assert.equal(bothResult.reason,'DRAW');assert.equal(bothResult.winnerTeam,null);
  const oneGone=await runningFriendly('单断线');oneGone.pa.player.disconnectedAt=Date.now()-config.battle.disconnectGraceSeconds*1000-10;installed.battle.step(Date.now(),1/30);
  const oneResult=await waitFor(async()=>(await pool.query('SELECT result_json FROM match_results WHERE match_id=$1',[oneGone.match.id])).rows[0]?.result_json,Boolean,'单断线未结算');assert.equal(oneResult.reason,'DISCONNECT');assert.equal(oneResult.winnerTeam,'B');

  const drift=await pool.query("SELECT w.id FROM wallets w LEFT JOIN wallet_holds h ON h.wallet_id=w.id AND h.status='HELD' WHERE w.owner_kind='PERSONAL' GROUP BY w.id,w.held HAVING w.held<>COALESCE(sum(h.amount),0)");assert.equal(drift.rowCount,0);
  const stuck=await pool.query("SELECT h.match_id FROM wallet_holds h JOIN matches m ON m.id=h.match_id WHERE h.status='HELD' AND m.status IN ('FINISHED','ABORTED')");assert.equal(stuck.rowCount,0);
  const imbalanced=await pool.query('SELECT transaction_id FROM ledger_entries GROUP BY transaction_id HAVING sum(amount)<>0');assert.equal(imbalanced.rowCount,0);
  const capOverflow=await pool.query('SELECT 1 FROM daily_counters WHERE used+reserved>limit_value OR used<0 OR reserved<0');assert.equal(capOverflow.rowCount,0);
  console.log(JSON.stringify({stage:'M5',database:'PostgreSQL17',passed:['S=20报价、双方同时冻结、倒计时才计正式次数','余额变化强制全员重新确认且无单边冻结','A=19正式赛拒绝但友谊赛可用','护盾/冷却/伪造位置拒绝/扫掠命中/单次冲刺只伤一次','重复结算10次仅一笔转移、胜者+S败者-S','平局退冻、倒计时认输按押注结算','8秒可恢复的数据路径与单双方超时断线裁决','准备与运行的旧实例恢复释放冻结和配额、已完成结果不退款','同对手一次与个人每日总额度','冻结日期归属的跨日结算','全库流水净和、held/hold与配额约束一致']},null,2));
}finally{await pool.end();}
