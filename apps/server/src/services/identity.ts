import { randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { basePower, businessDate, config, levelFromXp, walletView } from '@aquarium/core';
import type { Appearance, SelfView } from '@aquarium/protocol';
import { pool, tx } from '../persistence/db';
import { assert } from '../http/errors';
import { durable, ensureDaily, hash, personalWalletId, transfer } from './economy';

type Queryable = Pick<PoolClient, 'query'>;
export async function selfView(userId: string, client: Queryable = pool): Promise<SelfView> {
  const result = await client.query(`SELECT u.*,f.id AS fish_id,f.nickname,f.total_xp,f.appearance_json,f.highest_power,
    w.balance,w.held,w.version AS wallet_version,gm.guild_id,
    (SELECT m.id FROM matches m JOIN match_participants p ON p.match_id=m.id WHERE p.user_id=u.id
      AND m.status NOT IN ('FINISHED','ABORTED') ORDER BY m.created_at DESC LIMIT 1) AS current_match_id
    FROM users u LEFT JOIN fish f ON f.user_id=u.id LEFT JOIN wallets w ON w.owner_user_id=u.id
    LEFT JOIN guild_members gm ON gm.user_id=u.id WHERE u.id=$1`, [userId]);
  assert(result.rowCount, 'AUTH_REQUIRED', '会话已失效，请重新进入', 401);
  const row = result.rows[0];
  const date = businessDate();
  const counters = await client.query("SELECT counter_key,used,reserved FROM daily_counters WHERE owner_type='USER' AND owner_id=$1 AND business_date=$2", [userId, date]);
  const counter = (key: string) => counters.rows.find(c => c.counter_key === key) ?? { used: 0, reserved: 0 };
  const level = levelFromXp(row.total_xp ?? 0);
  return {
    userId, role: row.role, fishId: row.fish_id ?? null, nickname: row.nickname ?? '', totalXp: row.total_xp ?? 0,
    level, appearance: row.appearance_json ?? null, guildId: row.guild_id ?? null, currentMatchId: row.current_match_id ?? null,
    wallet: walletView({ level, powerBalance: row.balance ?? 0, heldPower: row.held ?? 0, highestPower: row.highest_power ?? 0, version: row.wallet_version ?? 1 }),
    businessDate: date,
    daily: { xpMinted: counter('xp').used, powerMinted: counter('power').used, feedUsed: counter('feed').used, formalUsed: counter('formal').used, formalReserved: counter('formal').reserved },
  };
}
export async function createGuest(): Promise<{ userId: string; token: string }> {
  const userId = randomUUID(), token = randomBytes(32).toString('hex');
  await tx(async client => {
    await client.query('INSERT INTO users(id) VALUES ($1)', [userId]);
    await client.query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES ($1,$2,now()+interval \'90 days\')', [hash(token), userId]);
    await client.query("INSERT INTO wallets(id,owner_kind,owner_user_id) VALUES ($1,'PERSONAL',$2)", [personalWalletId(userId), userId]);
  });
  return { userId, token };
}
export async function userFromToken(token: string | undefined): Promise<string | null> {
  if (!token || token.length > 128) return null;
  const result = await pool.query('SELECT user_id FROM sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()', [hash(token)]);
  return result.rows[0]?.user_id ?? null;
}
export async function createFish(userId: string, key: string, payload: { nickname: string; appearance: Appearance }) {
  return durable(userId, 'fish:create', key, payload, async client => {
    await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
    const existing = await client.query('SELECT id FROM fish WHERE user_id=$1', [userId]);
    assert(!existing.rowCount, 'VERSION_CONFLICT', '此账号已经拥有一条鱼');
    assert(!Object.keys(payload.appearance.equipped).length && !payload.appearance.skinAssetId, 'FISH_NOT_OWNED', '初始外观不能使用尚未拥有的资产', 403);
    const appearance = { ...payload.appearance, version: 1 };
    const starter=config.fish.starterPowerOnce;
    await client.query('INSERT INTO fish(id,user_id,nickname,preset_id,appearance_json,highest_power) VALUES ($1,$2,$3,$4,$5,$6)', [randomUUID(), userId, payload.nickname, appearance.presetId, JSON.stringify(appearance), basePower(1) + starter]);
    await transfer(client, `starter:${userId}`, 'STARTER', userId, [{ walletId: personalWalletId(userId), amount: starter }, { walletId: 'system:MINT', amount: -starter }]);
    return selfView(userId, client);
  });
}
export async function claimInvite(userId: string, key: string, inviteCode: string) {
  return durable(userId, 'auth:claim', key, { inviteCode }, async client => {
    const invite = await client.query('SELECT * FROM employee_invites WHERE code_hash=$1 FOR UPDATE', [hash(inviteCode)]);
    assert(invite.rowCount && !invite.rows[0].used_by && new Date(invite.rows[0].expires_at).getTime() > Date.now(), 'PEER_NOT_ELIGIBLE', '邀请码无效、已使用或已过期');
    const user = await client.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [userId]);
    assert(user.rows[0].role === 'GUEST', 'VERSION_CONFLICT', '账号已经绑定同事身份');
    const used = await client.query('SELECT id FROM users WHERE employee_ref=$1', [invite.rows[0].employee_ref]);
    assert(!used.rowCount, 'PEER_NOT_ELIGIBLE', '该同事身份已经绑定');
    await client.query("UPDATE users SET role='MEMBER',employee_ref=$2 WHERE id=$1", [userId, invite.rows[0].employee_ref]);
    await client.query('UPDATE employee_invites SET used_by=$2,used_at=now() WHERE id=$1', [invite.rows[0].id, userId]);
    return selfView(userId, client);
  });
}
export async function createInvite(employeeRef: string, expiresAt = new Date(Date.now() + 7 * 86400000).toISOString()) {
  const code = randomBytes(12).toString('base64url');
  const id = randomUUID();
  await tx(async client => { await client.query('INSERT INTO employee_invites(id,code_hash,employee_ref,expires_at) VALUES ($1,$2,$3,$4)', [id, hash(code), employeeRef, expiresAt]); });
  return { id, inviteCode: code, employeeRef, expiresAt };
}
export async function ensurePlayerDaily(userId: string) { return tx(client => ensureDaily(client, userId, businessDate())); }
