import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { config } from '@aquarium/core';
import { tx } from '../persistence/db';
import { assert } from '../http/errors';
import { assertAssetWritesAllowed } from './write-guard';

export const personalWalletId = (userId: string) => `personal:${userId}`;
export const guildWalletId = (guildId: string) => `guild:${guildId}`;
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export async function durable<T>(userId: string, scope: string, key: string, payload: unknown, fn: (client: PoolClient) => Promise<T>, options: { allowWhenPaused?: boolean } = {}): Promise<T> {
  assert(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key), 'VERSION_CONFLICT', '操作缺少有效幂等键', 400);
  const payloadHash = hash(stableJson(payload));
  return tx(async client => {
    const old = await client.query('SELECT payload_hash,response_json FROM idempotency_keys WHERE user_id=$1 AND route_scope=$2 AND key=$3', [userId, scope, key]);
    if (old.rowCount) { assert(old.rows[0].payload_hash === payloadHash, 'VERSION_CONFLICT', '同一操作编号不能重复用于不同内容'); return old.rows[0].response_json as T; }
    if (!options.allowWhenPaused) assertAssetWritesAllowed();
    const result = await fn(client);
    await client.query("INSERT INTO idempotency_keys(user_id,route_scope,key,payload_hash,response_json,expires_at) VALUES ($1,$2,$3,$4,$5,now()+($6*interval '1 day'))", [userId, scope, key, payloadHash, JSON.stringify(result),config.network.idempotencyRetentionDays]);
    await client.query('INSERT INTO outbox_events(id,event_type,aggregate_id,payload) VALUES ($1,$2,$3,$4)', [randomUUID(), 'self:invalidate', userId, JSON.stringify({ domains: ['fish', 'wallet', 'daily', 'inventory', 'guild', 'match'] })]);
    return result;
  });
}
export async function transfer(client: PoolClient, sourceKey: string, kind: string, actorId: string | null, entries: Array<{ walletId: string; amount: number }>): Promise<string> {
  assert(entries.every(e => Number.isSafeInteger(e.amount)) && entries.reduce((sum, e) => sum + e.amount, 0) === 0, 'VERSION_CONFLICT', '账目不平衡');
  const combined = new Map<string, number>();
  for (const e of entries) combined.set(e.walletId, (combined.get(e.walletId) ?? 0) + e.amount);
  const old = await client.query('SELECT id,kind,actor_user_id FROM ledger_transactions WHERE source_key=$1', [sourceKey]);
  if (old.rowCount) {
    const recorded=await client.query('SELECT wallet_id,sum(amount)::int AS amount FROM ledger_entries WHERE transaction_id=$1 GROUP BY wallet_id ORDER BY wallet_id',[old.rows[0].id]);
    const expected=[...combined].sort(([a],[b])=>a.localeCompare(b)).map(([walletId,amount])=>({wallet_id:walletId,amount}));
    assert(old.rows[0].kind===kind&&old.rows[0].actor_user_id===actorId&&stableJson(recorded.rows)===stableJson(expected),'VERSION_CONFLICT','同一账目来源不能复用于不同变动');
    return old.rows[0].id;
  }
  const ids = [...new Set(entries.map(e => e.walletId))].sort();
  const wallets = await client.query('SELECT * FROM wallets WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE', [ids]);
  assert(wallets.rowCount === ids.length, 'VERSION_CONFLICT', '钱包不存在');
  const txnId = randomUUID();
  await client.query('INSERT INTO ledger_transactions(id,kind,source_key,actor_user_id,rules_version) VALUES ($1,$2,$3,$4,$5)', [txnId, kind, sourceKey, actorId, config.rulesVersion]);
  for (const walletId of ids) {
    const amount = combined.get(walletId)!;
    const wallet = wallets.rows.find(w => w.id === walletId)!;
    assert(wallet.owner_kind === 'SYSTEM' || wallet.balance + amount >= wallet.held, 'INSUFFICIENT_AVAILABLE_POWER', '可用战力不足，冻结中的额度不可消费');
    const updated = await client.query('UPDATE wallets SET balance=balance+$2,version=version+1 WHERE id=$1 RETURNING balance', [walletId, amount]);
    await client.query('INSERT INTO ledger_entries(transaction_id,wallet_id,amount,balance_after) VALUES ($1,$2,$3,$4)', [txnId, walletId, amount, updated.rows[0].balance]);
  }
  return txnId;
}
export async function ensureDaily(client: PoolClient, userId: string, date: string) {
  const limits:Record<string,number>={xp:config.daily.xpMintCap,power:config.daily.powerMintCap,feed:config.daily.manualFeedUses,formal:config.daily.formalMatchesPerPlayer,supply:1};
  for (const counter of ['xp','power','feed','formal','supply']) await client.query(
    'INSERT INTO daily_counters(owner_id,business_date,counter_key,limit_value) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [userId, date, counter,limits[counter]],
  );
  const result = await client.query('SELECT counter_key,used,reserved FROM daily_counters WHERE owner_type=\'USER\' AND owner_id=$1 AND business_date=$2 ORDER BY counter_key FOR UPDATE', [userId, date]);
  return Object.fromEntries(result.rows.map(row => [row.counter_key, { used: row.used as number, reserved: row.reserved as number }])) as Record<string, { used: number; reserved: number }>;
}
