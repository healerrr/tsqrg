import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool } from '../../apps/server/src/persistence/db';
import { createInvite } from '../../apps/server/src/services/identity';

const base=process.env.TEST_API_URL??'http://127.0.0.1:3000/api/v1';
type JsonRecord=Record<string,unknown>;
async function request(path:string,cookie='',body?:unknown,key=randomUUID()) {
  const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',Cookie:cookie,'Idempotency-Key':key,Origin:'http://localhost:5173'},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,json:await response.json() as {data?:JsonRecord;error?:JsonRecord},cookie:response.headers.getSetCookie()[0]?.split(';')[0]??cookie};
}
try {
  const a=await request('/auth/guest','',{}),b=await request('/auth/guest','',{});
  assert.equal(a.status,200);assert.equal(b.status,200);assert.notEqual(a.json.data!.userId,b.json.data!.userId);
  const payload={nickname:'验证游客',appearance:{presetId:'goldfish',bodyColor:'#ffaa45',finColor:'#5d99ef',patternId:'none',skinAssetId:null,equipped:{},version:1}};
  const key=randomUUID();
  const created=await request('/fish',a.cookie,payload,key);assert.equal(created.status,200);
  const retry=await request('/fish',a.cookie,payload,key);assert.equal(retry.status,200);assert.deepEqual(retry.json.data,created.json.data);
  const conflict=await request('/fish',a.cookie,{...payload,nickname:'不同内容'},key);assert.equal(conflict.status,409);
  const current=await request('/me',a.cookie);assert.equal(current.json.data!.fishId,created.json.data!.fishId);
  assert.equal((current.json.data!.wallet as JsonRecord).powerBalance,100);
  const invite=await createInvite('m2-race-'+randomUUID());
  const claims=await Promise.all([request('/auth/claim',a.cookie,{inviteCode:invite.inviteCode}),request('/auth/claim',b.cookie,{inviteCode:invite.inviteCode})]);
  assert.equal(claims.filter(c=>c.status===200).length,1);assert.equal(claims.filter(c=>c.status===409).length,1);
  const ledger=await pool.query('SELECT count(*)::int AS count FROM ledger_transactions WHERE source_key=$1',[`starter:${a.json.data!.userId}`]);assert.equal(ledger.rows[0].count,1);
  const imbalance=await pool.query('SELECT transaction_id FROM ledger_entries GROUP BY transaction_id HAVING sum(amount)<>0');assert.equal(imbalance.rowCount,0);
  const fish=await pool.query('SELECT count(*)::int AS count FROM fish WHERE user_id=$1',[a.json.data!.userId]);assert.equal(fish.rows[0].count,1);
  console.log(JSON.stringify({stage:'M2',database:'PostgreSQL17',passed:['游客独立Cookie会话','一账号一鱼','新手奖励重试唯一','幂等payload冲突','同事邀请码并发消费唯一','GET刷新保持角色','真实数据库流水平衡'],userId:a.json.data!.userId,fishId:created.json.data!.fishId},null,2));
}finally{await pool.end();}
