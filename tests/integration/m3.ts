import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { businessDate, config, maxXp } from '../../packages/game-core/src/index';
import { pool, tx } from '../../apps/server/src/persistence/db';
import { createGuest, createFish, selfView } from '../../apps/server/src/services/identity';
import { ensureDaily, personalWalletId, transfer } from '../../apps/server/src/services/economy';
import { claimDailySupply, grantReward, grantRewardTx } from '../../apps/server/src/services/growth';
import { Ecosystem } from '../../apps/server/src/simulation/ecosystem';
import { World, type ConnectionRuntime } from '../../apps/server/src/simulation/world';

const fixture=async(name:string)=>{const {userId}=await createGuest();await createFish(userId,randomUUID(),{nickname:name,appearance:{presetId:'goldfish',bodyColor:'#ffaa45',finColor:'#5d99ef',patternId:'none',skinAssetId:null,equipped:{},version:1}});return userId;};
const waitFor=async(condition:()=>boolean)=>{const deadline=Date.now()+20000;while(!condition()){if(Date.now()>deadline)throw new Error('异步收益事务未完成');await new Promise(resolve=>setTimeout(resolve,30));}};
try {
  const a=await fixture('成长验证甲'),b=await fixture('成长验证乙');
  const source=`m3-contest:${randomUUID()}`;
  const receipts=await Promise.all([grantReward(a,'FOOD',source,4,1),grantReward(b,'FOOD',source,4,1)]);
  assert.equal(receipts[0].fishId,receipts[1].fishId);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM reward_events WHERE source_id=$1',[source])).rows[0].n,1);
  assert.equal((await selfView(a)).wallet.powerBalance+(await selfView(b)).wallet.powerBalance,201);
  const dailyUser=await fixture('补给验证');const key=randomUUID();
  const supplies=await Promise.all(Array.from({length:10},()=>claimDailySupply(dailyUser,key)));
  for(const supply of supplies)assert.deepEqual(supply,supplies[0]);
  assert.equal((await selfView(dailyUser)).wallet.powerBalance,120);
  const dailyAgain=await claimDailySupply(dailyUser,randomUUID());assert.equal(dailyAgain.actualXp,80);assert.equal(dailyAgain.actualPower,20);assert.equal(dailyAgain.replayed,true);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM reward_events WHERE fish_id=$1 AND source_kind='SUPPLY'",[(await selfView(dailyUser)).fishId])).rows[0].n,1);
  const capUser=await fixture('日末截断');const date=businessDate();
  await tx(async client=>{
    await ensureDaily(client,capUser,date);
    await client.query("UPDATE daily_counters SET used=CASE counter_key WHEN 'xp' THEN 295 WHEN 'power' THEN 79 ELSE used END WHERE owner_id=$1 AND business_date=$2",[capUser,date]);
    await client.query('UPDATE fish SET total_xp=295 WHERE user_id=$1',[capUser]);
    await transfer(client,`m3-fixture:${capUser}`,'TEST_FIXTURE',capUser,[{walletId:personalWalletId(capUser),amount:79},{walletId:'system:MINT',amount:-79}]);
  });
  const capped=await grantReward(capUser,'NPC',`m3-cap:${randomUUID()}`,12,2);assert.equal(capped.actualXp,5);assert.equal(capped.actualPower,1);
  const full=await selfView(capUser);assert.equal(full.daily.xpMinted,300);assert.equal(full.daily.powerMinted,80);
  const tomorrow=businessDate(new Date(`${date}T00:00:00+08:00`).getTime()+86400000);
  const afterMidnight=await tx(client=>grantRewardTx(client,capUser,'FOOD',`m3-midnight:${randomUUID()}`,4,1,tomorrow));assert.equal(afterMidnight.actualXp,4);assert.equal(afterMidnight.actualPower,1);
  const maxUser=await fixture('封顶验证');await pool.query('UPDATE fish SET total_xp=$2 WHERE user_id=$1',[maxUser,maxXp-5]);
  const toMax=await grantReward(maxUser,'NPC',`m3-max:${randomUUID()}`,12,2);assert.equal(toMax.actualXp,5);
  const overMax=await grantReward(maxUser,'FOOD',`m3-over:${randomUUID()}`,4,1);assert.equal(overMax.actualXp,0);assert.equal(overMax.actualPower,1);assert.equal((await selfView(maxUser)).level,30);assert.equal((await selfView(maxUser)).totalXp,maxXp);
  const world=new World({} as ConstructorParameters<typeof World>[0]);const eco=new Ecosystem(world);world.ecosystem=eco;
  const roomId=`tank:test:${randomUUID()}`;world.roomEpochs.set(roomId,randomUUID());
  const pa=(await world.refreshPlayer(a))!,pb=(await world.refreshPlayer(b))!;
  const now=Date.now();
  for(const [index,p]of [pa,pb].entries()){
    p.roomId=roomId;p.fish.position={x:64,y:96};p.controlSocketId=`test-socket-${index}`;p.disconnectedAt=null;p.leaseUntil=now+120000;p.lastActivityAt=now;p.pageVisible=true;
    world.connections.set(p.controlSocketId,{socket:{id:p.controlSocketId,connected:true,emit:()=>undefined},userId:p.self.userId,sceneEpoch:randomUUID(),lastInputAt:0,inputCount:0,rateWindow:0,lastEmote:0} as unknown as ConnectionRuntime);
  }
  const contestedId=`m3-same-tick:${randomUUID()}`;eco.food.set(contestedId,{id:contestedId,roomId,position:{x:64,y:96},state:'AVAILABLE',expiresAtServerMs:now+20000});
  eco.step(now,1/30);await waitFor(()=>eco.pending.size===0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM reward_events WHERE source_id=$1',[contestedId])).rows[0].n,1);
  pa.pageVisible=false;pb.lastActivityAt=now-config.tank.activeWindowSeconds*1000-1;
  const inactiveId=`m3-inactive:${randomUUID()}`;eco.food.set(inactiveId,{id:inactiveId,roomId,position:{x:64,y:96},state:'AVAILABLE',expiresAtServerMs:now+20000});eco.step(now,1/30);
  assert.equal(eco.food.get(inactiveId)?.state,'AVAILABLE');assert.equal(eco.pending.size,0);
  const feedUser=await fixture('投喂验证');const feeder=(await world.refreshPlayer(feedUser))!;feeder.roomId=`tank:feed:${randomUUID()}`;feeder.controlSocketId='feed-controller';feeder.leaseUntil=Date.now()+120000;
  const connection={socket:{id:'feed-controller',connected:true,emit:()=>undefined},userId:feedUser,sceneEpoch:randomUUID(),lastInputAt:0,inputCount:0,rateWindow:0,lastEmote:0} as unknown as ConnectionRuntime;world.connections.set('feed-controller',connection);
  const payload={roomId:feeder.roomId,surfaceX:900,sceneEpoch:connection.sceneEpoch},feedKey=randomUUID();
  const first=await eco.feed(feedUser,feedKey,payload);for(let i=0;i<9;i++)assert.deepEqual(await eco.feed(feedUser,feedKey,payload),first);
  assert.equal([...eco.food.values()].filter(food=>food.roomId===feeder.roomId).length,12);
  await eco.feed(feedUser,randomUUID(),payload);await eco.feed(feedUser,randomUUID(),payload);
  await assert.rejects(eco.feed(feedUser,randomUUID(),payload),/鱼粮充足/);assert.equal((await selfView(feedUser)).daily.feedUsed,3);
  await pool.query('UPDATE food_batches SET expires_at=now()-interval \'1 second\' WHERE user_id=$1',[feedUser]);
  for(const [id,food]of eco.food)if(food.roomId===feeder.roomId)eco.food.delete(id);
  await eco.feed(feedUser,randomUUID(),payload);await eco.feed(feedUser,randomUUID(),payload);
  await assert.rejects(eco.feed(feedUser,randomUUID(),payload),/五次/);assert.equal((await selfView(feedUser)).daily.feedUsed,5);
  await assert.rejects(eco.feed(feedUser,randomUUID(),{...payload,surfaceX:-1}),/水面范围/);
  const imbalanced=await pool.query('SELECT transaction_id FROM ledger_entries GROUP BY transaction_id HAVING sum(amount)<>0');assert.equal(imbalanced.rowCount,0);
  const capOverflow=await pool.query('SELECT 1 FROM daily_counters WHERE used+reserved>limit_value');assert.equal(capOverflow.rowCount,0);
  console.log(JSON.stringify({stage:'M3',database:'PostgreSQL17',passed:['同source并发仅一个收益事件','补给10次重试与新key仍只领取一次','295XP/79战力截断到300/80','上海跨日独立配额','30级XP封顶仍按日发战力','两鱼同tick争食唯一','隐藏及过期活跃窗口无收益','投喂同key不重复生成','缸满拒绝且不扣次数','五次上限与非法落点','真实流水净和0及日额度约束']},null,2));
}finally{await pool.end();}
