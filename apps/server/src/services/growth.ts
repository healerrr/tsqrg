import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { basePower, businessDate, config, rewardWithinCaps } from '@aquarium/core';
import { tx } from '../persistence/db';
import { assert } from '../http/errors';
import { durable, ensureDaily, personalWalletId, transfer } from './economy';
import { selfView } from './identity';
import { assertAssetWritesAllowed } from './write-guard';

export interface RewardReceipt { fishId:string;sourceId:string;actualXp:number;actualPower:number;businessDate:string;replayed:boolean }
/** Only server simulation or the daily-supply route can call this reward source. */
export async function grantRewardTx(client:PoolClient,userId:string,sourceKind:'FOOD'|'NPC'|'SUPPLY',sourceId:string,xp:number,power:number,date=businessDate()):Promise<RewardReceipt> {
  const prior=await client.query('SELECT * FROM reward_events WHERE source_id=$1',[sourceId]);
  if(prior.rowCount){const row=prior.rows[0];return {fishId:row.fish_id,sourceId,actualXp:row.xp_delta,actualPower:row.power_delta,businessDate:typeof row.business_date==='string'?row.business_date:businessDate(row.business_date),replayed:true};}
  assertAssetWritesAllowed();
  await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[userId]);
  const wallet=await client.query('SELECT * FROM wallets WHERE id=$1 FOR UPDATE',[personalWalletId(userId)]);
  const fish=await client.query('SELECT * FROM fish WHERE user_id=$1 FOR UPDATE',[userId]);
  assert(fish.rowCount,'FISH_NOT_OWNED','请先创建自己的鱼');
  const counters=await ensureDaily(client,userId,date);
  const result=rewardWithinCaps({totalXp:fish.rows[0].total_xp,xpMinted:counters.xp.used,powerMinted:counters.power.used,requestedXp:xp,requestedPower:power});
  await transfer(client,`reward:${sourceId}`,sourceKind,userId,[{walletId:personalWalletId(userId),amount:result.actualPower},{walletId:'system:MINT',amount:-result.actualPower}]);
  await client.query('UPDATE fish SET total_xp=$2,highest_power=GREATEST(highest_power,$3) WHERE user_id=$1',[userId,result.totalXp,basePower(result.level)+wallet.rows[0].balance+result.actualPower]);
  await client.query("UPDATE daily_counters SET used=$3 WHERE owner_type='USER' AND owner_id=$1 AND business_date=$2 AND counter_key='xp'",[userId,date,result.xpMinted]);
  await client.query("UPDATE daily_counters SET used=$3 WHERE owner_type='USER' AND owner_id=$1 AND business_date=$2 AND counter_key='power'",[userId,date,result.powerMinted]);
  await client.query('INSERT INTO reward_events(id,source_kind,source_id,fish_id,xp_delta,power_delta,business_date,rules_version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',[randomUUID(),sourceKind,sourceId,fish.rows[0].id,result.actualXp,result.actualPower,date,config.rulesVersion]);
  await client.query('INSERT INTO outbox_events(id,event_type,aggregate_id,payload) VALUES ($1,$2,$3,$4)',[randomUUID(),'self:invalidate',userId,JSON.stringify({domains:['fish','wallet','daily']})]);
  return {fishId:fish.rows[0].id,sourceId,actualXp:result.actualXp,actualPower:result.actualPower,businessDate:date,replayed:false};
}
export async function grantReward(userId:string,kind:'FOOD'|'NPC',sourceId:string,xp:number,power:number):Promise<RewardReceipt> {
  return tx(client=>grantRewardTx(client,userId,kind,sourceId,xp,power));
}
export async function claimDailySupply(userId:string,key:string) {
  return durable(userId,'rewards:daily',key,{},async client=>{
    const date=businessDate();
    const receipt=await grantRewardTx(client,userId,'SUPPLY',`supply:${userId}:${date}`,config.daily.supplyXp,config.daily.supplyPower,date);
    await client.query("UPDATE daily_counters SET used=1 WHERE owner_type='USER' AND owner_id=$1 AND business_date=$2 AND counter_key='supply'",[userId,date]);
    return {...receipt,self:await selfView(userId,client)};
  });
}
