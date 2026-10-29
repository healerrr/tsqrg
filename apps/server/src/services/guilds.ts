import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { config } from '@aquarium/core';
import type { GuildMark } from '@aquarium/protocol';
import { pool } from '../persistence/db';
import { assert } from '../http/errors';
import { durable, guildWalletId, personalWalletId, transfer } from './economy';
import { selfView } from './identity';

type Queryable = Pick<PoolClient, 'query'>;
type GuildRole = 'LEADER' | 'ADMIN' | 'MEMBER';
const activeMatchPhases = ['INVITED', 'READY_CHECK', 'COUNTDOWN', 'RUNNING', 'OVERTIME', 'SETTLING'];

interface GuildRow {
  id: string;
  name: string;
  leader_user_id: string;
  badge: string;
  color: string;
  notice: string;
  status: 'ACTIVE' | 'ARCHIVED';
  version: number;
  created_at: Date;
}

function visibleLength(value: string): number { return [...value].length; }
function assertGuildName(name: string): void {
  assert(visibleLength(name) >= 2 && visibleLength(name) <= 12, 'VERSION_CONFLICT', '鱼群名称须为 2—12 个可见字符', 400);
}
async function guildRow(client: Queryable, guildId: string, lock = false): Promise<GuildRow> {
  const result = await client.query(`SELECT * FROM guilds WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [guildId]);
  assert(result.rowCount, 'PEER_NOT_ELIGIBLE', '鱼群不存在');
  return result.rows[0];
}
async function membership(client: Queryable, userId: string, guildId?: string): Promise<{ guild_id: string; role: GuildRole } | null> {
  const result = await client.query('SELECT guild_id,role FROM guild_members WHERE user_id=$1 AND ($2::uuid IS NULL OR guild_id=$2)', [userId, guildId ?? null]);
  return result.rows[0] ?? null;
}
async function assertRole(client: Queryable, userId: string, guildId: string, roles: GuildRole[]): Promise<{ guild_id: string; role: GuildRole }> {
  const own = await membership(client, userId, guildId);
  assert(own && roles.includes(own.role), 'MEMBER_REQUIRED', roles.includes('MEMBER') ? '只有当前鱼群成员可以操作' : '当前鱼群权限不足', 403);
  return own;
}
async function assertMemberIdentity(client: Queryable, userId: string): Promise<any> {
  const result = await client.query('SELECT u.*,f.id AS fish_id FROM users u LEFT JOIN fish f ON f.user_id=u.id WHERE u.id=$1 FOR UPDATE OF u', [userId]);
  assert(result.rowCount && result.rows[0].role !== 'GUEST', 'MEMBER_REQUIRED', '绑定同事身份后才能加入鱼群', 403);
  assert(result.rows[0].fish_id, 'FISH_NOT_OWNED', '请先创建自己的鱼');
  return result.rows[0];
}
async function assertCanJoin(client: Queryable, userId: string): Promise<any> {
  const user = await assertMemberIdentity(client, userId);
  assert(!(await membership(client, userId)), 'VERSION_CONFLICT', '每位同事只能属于一个鱼群');
  assert(!user.guild_rejoin_at || new Date(user.guild_rejoin_at).getTime() <= Date.now(), 'PEER_NOT_ELIGIBLE', `退出鱼群后需等待 ${config.guild.rejoinCooldownHours} 小时才能再次加入或创建`);
  return user;
}
async function assertNoActiveMatch(client: Queryable, userIds: string[], message = '比赛邀请、准备或进行中不能变更鱼群成员'): Promise<void> {
  const active = await client.query('SELECT 1 FROM match_participants p JOIN matches m ON m.id=p.match_id WHERE p.user_id=ANY($1::uuid[]) AND m.status=ANY($2::text[]) LIMIT 1', [userIds, activeMatchPhases]);
  assert(!active.rowCount, 'STAKE_LOCKED', message);
}
async function memberIds(client: Queryable, guildId: string): Promise<string[]> {
  const result = await client.query('SELECT user_id FROM guild_members WHERE guild_id=$1 ORDER BY user_id', [guildId]);
  return result.rows.map(row => row.user_id as string);
}
async function audit(client: Queryable, actor: string, action: string, guildId: string, before: unknown, after: unknown): Promise<void> {
  await client.query('INSERT INTO audit_logs(id,actor_user_id,action,target_type,target_id,before_json,after_json) VALUES ($1,$2,$3,$4,$5,$6,$7)', [randomUUID(), actor, action, 'GUILD', guildId, before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after)]);
}
async function invalidate(client: Queryable, users: string[], domains = ['guild', 'wallet']): Promise<void> {
  for (const userId of [...new Set(users)]) await client.query('INSERT INTO outbox_events(id,event_type,aggregate_id,payload) VALUES ($1,$2,$3,$4)', [randomUUID(), 'self:invalidate', userId, JSON.stringify({ domains })]);
}

export async function listGuilds(userId: string, search = '', offset = 0, limit = 20) {
  const normalized = search.trim();
  const result = await pool.query(`SELECT g.id,g.name,g.badge,g.color,g.notice,g.version,g.created_at,
      count(gm.user_id)::int AS member_count,
      max(CASE WHEN ga.user_id=$1 THEN ga.status END) AS application_status
    FROM guilds g LEFT JOIN guild_members gm ON gm.guild_id=g.id
    LEFT JOIN guild_applications ga ON ga.guild_id=g.id AND ga.user_id=$1
    WHERE g.status='ACTIVE' AND ($2='' OR g.name ILIKE '%'||$2||'%')
    GROUP BY g.id ORDER BY lower(g.name),g.id OFFSET $3 LIMIT $4`, [userId, normalized, offset, limit + 1]);
  return { items: result.rows.slice(0, limit), nextCursor: result.rows.length > limit ? String(offset + limit) : null };
}

export async function getGuild(userId: string, guildId: string, client: Queryable = pool) {
  const guild = await guildRow(client, guildId);
  const user = await client.query('SELECT role FROM users WHERE id=$1', [userId]);
  const own = await membership(client, userId, guildId);
  const globalAdmin = user.rows[0]?.role === 'ADMIN';
  assert(own || globalAdmin, 'MEMBER_REQUIRED', '只有当前鱼群成员可以查看内部资产和流水', 403);
  const members = await client.query(`SELECT gm.user_id,gm.role,gm.joined_at,f.id AS fish_id,f.nickname,f.appearance_json,
    (SELECT m.id FROM matches m JOIN match_participants p ON p.match_id=m.id WHERE p.user_id=gm.user_id
      AND m.status IN ('INVITED','READY_CHECK','COUNTDOWN','RUNNING','OVERTIME','SETTLING') ORDER BY m.created_at DESC LIMIT 1) AS current_match_id
    FROM guild_members gm JOIN fish f ON f.user_id=gm.user_id WHERE gm.guild_id=$1
    ORDER BY CASE gm.role WHEN 'LEADER' THEN 0 WHEN 'ADMIN' THEN 1 ELSE 2 END,gm.joined_at,gm.user_id`, [guildId]);
  const assets = await client.query('SELECT ga.item_id,s.name,s.slot,s.price,ga.source_tx_id FROM guild_assets ga JOIN shop_items s ON s.id=ga.item_id WHERE ga.guild_id=$1 ORDER BY s.slot,s.id', [guildId]);
  const wallet = await client.query('SELECT balance,held,version FROM wallets WHERE owner_guild_id=$1', [guildId]);
  const applications = own && ['LEADER', 'ADMIN'].includes(own.role) || globalAdmin
    ? await client.query(`SELECT ga.user_id,ga.status,ga.created_at,ga.updated_at,f.nickname
        FROM guild_applications ga JOIN fish f ON f.user_id=ga.user_id
        WHERE ga.guild_id=$1 AND ga.status IN ('PENDING','INVITED') ORDER BY ga.created_at,ga.user_id`, [guildId])
    : { rows: [] };
  return {
    ...guild,
    leaderUserId: guild.leader_user_id,
    members: members.rows.map(row => ({ ...row, userId: row.user_id, fishId: row.fish_id, joinedAt: row.joined_at, currentMatchId: row.current_match_id ?? null })),
    applications: applications.rows.map(row => ({ ...row, userId: row.user_id })),
    assets: assets.rows.map(row => ({ ...row, itemId: row.item_id })),
    wallet: { balance: wallet.rows[0]?.balance ?? 0, heldPower: 0, availablePower: wallet.rows[0]?.balance ?? 0, version: wallet.rows[0]?.version ?? 1 },
  };
}

export async function guildMarkForUser(userId: string, client: Queryable = pool): Promise<GuildMark | null> {
  const result = await client.query(`SELECT g.id,g.name,g.badge,g.color,
      max(CASE WHEN s.slot='banner' THEN s.id END) AS banner_item_id,
      max(CASE WHEN s.slot='guildTrail' THEN s.id END) AS trail_item_id
    FROM guild_members gm JOIN guilds g ON g.id=gm.guild_id AND g.status='ACTIVE'
    LEFT JOIN guild_assets ga ON ga.guild_id=g.id LEFT JOIN shop_items s ON s.id=ga.item_id
    WHERE gm.user_id=$1 GROUP BY g.id`, [userId]);
  if (!result.rowCount) return null;
  const row = result.rows[0];
  return { id: row.id, name: row.name, badge: row.badge, color: row.color, bannerItemId: row.banner_item_id ?? null, trailItemId: row.trail_item_id ?? null };
}

export async function createGuild(userId: string, key: string, payload: { name: string; badge: string; color: string; notice: string }) {
  assertGuildName(payload.name);
  return durable(userId, 'guilds:create', key, payload, async client => {
    await assertCanJoin(client, userId);
    const same = await client.query('SELECT 1 FROM guilds WHERE lower(name)=lower($1)', [payload.name]);
    assert(!same.rowCount, 'VERSION_CONFLICT', '这个鱼群名称已经被使用');
    const guildId = randomUUID();
    await client.query("INSERT INTO guilds(id,name,leader_user_id,badge,color,notice) VALUES ($1,$2,$3,$4,$5,$6)", [guildId, payload.name, userId, payload.badge, payload.color, payload.notice]);
    await client.query("INSERT INTO wallets(id,owner_kind,owner_guild_id) VALUES ($1,'GUILD',$2)", [guildWalletId(guildId), guildId]);
    await transfer(client, `guild-create:${guildId}`, 'GUILD_CREATE', userId, [{ walletId: personalWalletId(userId), amount: -config.guild.creationCost }, { walletId: 'system:SINK', amount: config.guild.creationCost }]);
    await client.query("INSERT INTO guild_members(user_id,guild_id,role) VALUES ($1,$2,'LEADER')", [userId, guildId]);
    await audit(client, userId, 'GUILD_CREATE', guildId, null, payload);
    return getGuild(userId, guildId, client);
  });
}

export async function applyToGuild(userId: string, key: string, guildId: string) {
  return durable(userId, `guilds:${guildId}:apply`, key, {}, async client => {
    const guild = await guildRow(client, guildId, true);
    assert(guild.status === 'ACTIVE', 'PEER_NOT_ELIGIBLE', '鱼群已归档');
    await assertCanJoin(client, userId);
    const count = await client.query('SELECT count(*)::int AS n FROM guild_members WHERE guild_id=$1', [guildId]);
    assert(count.rows[0].n < config.guild.memberLimit, 'ROOM_FULL', '鱼群已经满员');
    const old = await client.query('SELECT status FROM guild_applications WHERE guild_id=$1 AND user_id=$2', [guildId, userId]);
    assert(!old.rowCount || !['PENDING', 'ACCEPTED'].includes(old.rows[0].status), 'VERSION_CONFLICT', old.rows[0]?.status === 'PENDING' ? '已经提交过申请' : '成员状态已更新');
    await client.query(`INSERT INTO guild_applications(guild_id,user_id,status,updated_at) VALUES ($1,$2,'PENDING',now())
      ON CONFLICT(guild_id,user_id) DO UPDATE SET status='PENDING',invited_by=NULL,created_at=now(),updated_at=now()`, [guildId, userId]);
    return { guildId, status: 'PENDING' as const };
  });
}

async function joinFromApplication(client: PoolClient, actorId: string, targetUserId: string, guild: GuildRow, expected: 'PENDING' | 'INVITED') {
  await assertCanJoin(client, targetUserId);
  const application = await client.query('SELECT * FROM guild_applications WHERE guild_id=$1 AND user_id=$2 FOR UPDATE', [guild.id, targetUserId]);
  assert(application.rowCount && application.rows[0].status === expected, 'MATCH_STATE_INVALID', expected === 'PENDING' ? '申请不存在或已处理' : '邀请不存在或已处理');
  const count = await client.query('SELECT count(*)::int AS n FROM guild_members WHERE guild_id=$1', [guild.id]);
  assert(count.rows[0].n < config.guild.memberLimit, 'ROOM_FULL', '鱼群已经满员');
  await client.query("INSERT INTO guild_members(user_id,guild_id,role) VALUES ($1,$2,'MEMBER')", [targetUserId, guild.id]);
  await client.query("UPDATE guild_applications SET status=CASE WHEN guild_id=$1 THEN 'ACCEPTED' ELSE 'REJECTED' END,updated_at=now() WHERE user_id=$2 AND status IN ('PENDING','INVITED')", [guild.id, targetUserId]);
  await client.query('UPDATE guilds SET version=version+1 WHERE id=$1', [guild.id]);
  await invalidate(client, [targetUserId], ['guild', 'fish']);
  await audit(client, actorId, expected === 'PENDING' ? 'GUILD_APPLICATION_ACCEPT' : 'GUILD_INVITATION_ACCEPT', guild.id, { targetUserId }, { role: 'MEMBER' });
}

export async function acceptApplication(userId: string, key: string, guildId: string, targetUserId: string, version: number) {
  return durable(userId, `guilds:${guildId}:accept:${targetUserId}`, key, { version }, async client => {
    const guild = await guildRow(client, guildId, true);
    assert(guild.status === 'ACTIVE', 'PEER_NOT_ELIGIBLE', '鱼群已归档');
    assert(guild.version === version, 'VERSION_CONFLICT', '鱼群状态已更新，请重新查看');
    await assertRole(client, userId, guildId, ['LEADER', 'ADMIN']);
    await joinFromApplication(client, userId, targetUserId, guild, 'PENDING');
    return getGuild(userId, guildId, client);
  });
}

export async function inviteToGuild(userId: string, key: string, guildId: string, payload: { targetUserId: string; version: number }) {
  return durable(userId, `guilds:${guildId}:invite`, key, payload, async client => {
    const guild = await guildRow(client, guildId, true);
    assert(guild.status === 'ACTIVE' && guild.version === payload.version, 'VERSION_CONFLICT', '鱼群状态已更新，请重新查看');
    await assertRole(client, userId, guildId, ['LEADER', 'ADMIN']);
    await assertCanJoin(client, payload.targetUserId);
    const count = await client.query('SELECT count(*)::int AS n FROM guild_members WHERE guild_id=$1', [guildId]);
    assert(count.rows[0].n < config.guild.memberLimit, 'ROOM_FULL', '鱼群已经满员');
    await client.query(`INSERT INTO guild_applications(guild_id,user_id,status,invited_by,updated_at) VALUES ($1,$2,'INVITED',$3,now())
      ON CONFLICT(guild_id,user_id) DO UPDATE SET status='INVITED',invited_by=$3,created_at=now(),updated_at=now()`, [guildId, payload.targetUserId, userId]);
    await invalidate(client, [payload.targetUserId], ['guild']);
    return { guildId, targetUserId: payload.targetUserId, status: 'INVITED' as const };
  });
}

export async function acceptInvitation(userId: string, key: string, guildId: string, version: number) {
  return durable(userId, `guilds:${guildId}:accept-invitation`, key, { version }, async client => {
    const guild = await guildRow(client, guildId, true);
    assert(guild.status === 'ACTIVE' && guild.version === version, 'VERSION_CONFLICT', '鱼群状态已更新，请重新查看');
    await joinFromApplication(client, userId, userId, guild, 'INVITED');
    return getGuild(userId, guildId, client);
  });
}

export async function updateGuild(userId: string, key: string, guildId: string, payload: { name?: string; badge?: string; color?: string; notice?: string; version: number }) {
  if (payload.name) assertGuildName(payload.name);
  return durable(userId, `guilds:${guildId}:update`, key, payload, async client => {
    const guild = await guildRow(client, guildId, true);
    assert(guild.status === 'ACTIVE' && guild.version === payload.version, 'VERSION_CONFLICT', '鱼群状态已更新，请重新查看');
    const own = await assertRole(client, userId, guildId, ['LEADER', 'ADMIN']);
    if (own.role === 'ADMIN') assert(Object.keys(payload).every(field => ['notice', 'version'].includes(field)), 'MEMBER_REQUIRED', '管理员只能更新组织公告', 403);
    if (payload.name && payload.name.toLocaleLowerCase() !== guild.name.toLocaleLowerCase()) {
      const duplicate = await client.query('SELECT 1 FROM guilds WHERE id<>$1 AND lower(name)=lower($2)', [guildId, payload.name]);
      assert(!duplicate.rowCount, 'VERSION_CONFLICT', '这个鱼群名称已经被使用');
    }
    const next = { name: payload.name ?? guild.name, badge: payload.badge ?? guild.badge, color: payload.color ?? guild.color, notice: payload.notice ?? guild.notice };
    await client.query('UPDATE guilds SET name=$2,badge=$3,color=$4,notice=$5,version=version+1 WHERE id=$1', [guildId, next.name, next.badge, next.color, next.notice]);
    await audit(client, userId, 'GUILD_UPDATE', guildId, guild, next);
    const users = await memberIds(client, guildId); await invalidate(client, users, ['guild', 'fish']);
    return getGuild(userId, guildId, client);
  });
}

export async function setGuildRole(userId: string, key: string, guildId: string, targetUserId: string, payload: { role: 'ADMIN' | 'MEMBER'; version: number }) {
  return durable(userId, `guilds:${guildId}:role:${targetUserId}`, key, payload, async client => {
    const guild = await guildRow(client, guildId, true);
    assert(guild.status === 'ACTIVE' && guild.version === payload.version, 'VERSION_CONFLICT', '鱼群状态已更新，请重新查看');
    await assertRole(client, userId, guildId, ['LEADER']);
    const target = await membership(client, targetUserId, guildId);
    assert(target && target.role !== 'LEADER', 'PEER_NOT_ELIGIBLE', '目标不是可任免的当前成员');
    await client.query('UPDATE guild_members SET role=$3 WHERE guild_id=$1 AND user_id=$2', [guildId, targetUserId, payload.role]);
    await client.query('UPDATE guilds SET version=version+1 WHERE id=$1', [guildId]);
    await audit(client, userId, 'GUILD_ROLE_CHANGE', guildId, { targetUserId, role: target.role }, { targetUserId, role: payload.role });
    await invalidate(client, [targetUserId], ['guild']);
    return getGuild(userId, guildId, client);
  });
}

export async function transferLeader(userId: string, key: string, guildId: string, payload: { targetUserId: string; version: number }) {
  return durable(userId, `guilds:${guildId}:transfer-leader`, key, payload, async client => {
    const guild = await guildRow(client, guildId, true);
    assert(guild.status === 'ACTIVE' && guild.version === payload.version, 'VERSION_CONFLICT', '鱼群状态已更新，请重新查看');
    await assertRole(client, userId, guildId, ['LEADER']);
    assert(payload.targetUserId !== userId, 'PEER_NOT_ELIGIBLE', '请选择另一位成员接任');
    const target = await membership(client, payload.targetUserId, guildId);
    assert(target, 'PEER_NOT_ELIGIBLE', '接任者必须是当前鱼群成员');
    await client.query("UPDATE guild_members SET role=CASE WHEN user_id=$2 THEN 'LEADER' WHEN user_id=$3 THEN 'MEMBER' ELSE role END WHERE guild_id=$1", [guildId, payload.targetUserId, userId]);
    await client.query('UPDATE guilds SET leader_user_id=$2,version=version+1 WHERE id=$1', [guildId, payload.targetUserId]);
    await audit(client, userId, 'GUILD_TRANSFER_LEADER', guildId, { leaderUserId: userId }, { leaderUserId: payload.targetUserId });
    await invalidate(client, [userId, payload.targetUserId], ['guild']);
    return getGuild(userId, guildId, client);
  });
}

export async function leaveGuild(userId: string, key: string, guildId: string) {
  return durable(userId, `guilds:${guildId}:leave`, key, {}, async client => {
    await guildRow(client, guildId, true);
    const own = await assertRole(client, userId, guildId, ['LEADER', 'ADMIN', 'MEMBER']);
    assert(own.role !== 'LEADER', 'MEMBER_REQUIRED', '组织长须先转让职位或解散鱼群', 403);
    await assertNoActiveMatch(client, [userId]);
    await client.query('DELETE FROM guild_members WHERE guild_id=$1 AND user_id=$2', [guildId, userId]);
    await client.query("UPDATE users SET guild_rejoin_at=now()+($2*interval '1 hour') WHERE id=$1", [userId, config.guild.rejoinCooldownHours]);
    await client.query('UPDATE guilds SET version=version+1 WHERE id=$1', [guildId]);
    await client.query("UPDATE guild_applications SET status='CANCELLED',updated_at=now() WHERE user_id=$1 AND status IN ('PENDING','INVITED','ACCEPTED')", [userId]);
    await audit(client, userId, 'GUILD_LEAVE', guildId, { role: own.role }, null);
    return { left: true, guildId, rejoinAt: new Date(Date.now() + config.guild.rejoinCooldownHours * 3600000).toISOString() };
  });
}

export async function removeGuildMember(userId: string, key: string, guildId: string, targetUserId: string, version: number) {
  return durable(userId, `guilds:${guildId}:remove:${targetUserId}`, key, { version }, async client => {
    const guild = await guildRow(client, guildId, true);
    assert(guild.status === 'ACTIVE' && guild.version === version, 'VERSION_CONFLICT', '鱼群状态已更新，请重新查看');
    const actor = await assertRole(client, userId, guildId, ['LEADER', 'ADMIN']);
    const target = await membership(client, targetUserId, guildId);
    assert(target && target.role !== 'LEADER' && targetUserId !== userId, 'PEER_NOT_ELIGIBLE', '不能移除该成员');
    if (actor.role === 'ADMIN') assert(target.role === 'MEMBER', 'MEMBER_REQUIRED', '管理员不能移除组织长或其他管理员', 403);
    await assertNoActiveMatch(client, [targetUserId]);
    await client.query('DELETE FROM guild_members WHERE guild_id=$1 AND user_id=$2', [guildId, targetUserId]);
    await client.query("UPDATE users SET guild_rejoin_at=now()+($2*interval '1 hour') WHERE id=$1", [targetUserId, config.guild.rejoinCooldownHours]);
    await client.query('UPDATE guilds SET version=version+1 WHERE id=$1', [guildId]);
    await client.query("UPDATE guild_applications SET status='CANCELLED',updated_at=now() WHERE user_id=$1 AND status IN ('PENDING','INVITED','ACCEPTED')", [targetUserId]);
    await audit(client, userId, 'GUILD_MEMBER_REMOVE', guildId, { targetUserId, role: target.role }, null);
    await invalidate(client, [targetUserId], ['guild', 'fish']);
    return getGuild(userId, guildId, client);
  });
}

export async function donateToGuild(userId: string, key: string, guildId: string, payload: { amount: number }) {
  return durable(userId, `guilds:${guildId}:donate`, key, payload, async client => {
    const guild = await guildRow(client, guildId, true);
    assert(guild.status === 'ACTIVE', 'PEER_NOT_ELIGIBLE', '鱼群已归档');
    await assertRole(client, userId, guildId, ['LEADER', 'ADMIN', 'MEMBER']);
    const transactionId = await transfer(client, `guild-donation:${guildId}:${userId}:${key}`, 'GUILD_DONATION', userId, [{ walletId: personalWalletId(userId), amount: -payload.amount }, { walletId: guildWalletId(guildId), amount: payload.amount }]);
    const guildWallet = await client.query('SELECT balance,version FROM wallets WHERE id=$1', [guildWalletId(guildId)]);
    const self = await selfView(userId, client);
    await invalidate(client, await memberIds(client, guildId), ['guild', 'wallet']);
    return { transactionId, amount: payload.amount, wallet: self.wallet, guildWallet: { balance: guildWallet.rows[0].balance, availablePower: guildWallet.rows[0].balance, version: guildWallet.rows[0].version } };
  });
}

export async function purchaseGuildItem(userId: string, key: string, guildId: string, payload: { itemId: string; itemVersion: number }) {
  return durable(userId, `guilds:${guildId}:purchase`, key, payload, async client => {
    const guild = await guildRow(client, guildId, true);
    assert(guild.status === 'ACTIVE', 'PEER_NOT_ELIGIBLE', '鱼群已归档');
    await assertRole(client, userId, guildId, ['LEADER']);
    const item = await client.query('SELECT * FROM shop_items WHERE id=$1', [payload.itemId]);
    assert(item.rowCount && item.rows[0].scope === 'GUILD' && item.rows[0].enabled, 'PEER_NOT_ELIGIBLE', '组织商品不存在或已下架');
    assert(item.rows[0].version === payload.itemVersion, 'VERSION_CONFLICT', '商品价格已更新，请重新查看');
    const owned = await client.query('SELECT 1 FROM guild_assets WHERE guild_id=$1 AND item_id=$2', [guildId, payload.itemId]);
    assert(!owned.rowCount, 'ALREADY_OWNED', '鱼群已经拥有这件公共装扮');
    const transactionId = await transfer(client, `guild-purchase:${guildId}:${key}`, 'GUILD_PURCHASE', userId, [{ walletId: guildWalletId(guildId), amount: -item.rows[0].price }, { walletId: 'system:SINK', amount: item.rows[0].price }]);
    await client.query('INSERT INTO guild_assets(guild_id,item_id,source_tx_id) VALUES ($1,$2,$3)', [guildId, payload.itemId, transactionId]);
    await client.query('UPDATE guilds SET version=version+1 WHERE id=$1', [guildId]);
    const users = await memberIds(client, guildId); await invalidate(client, users, ['guild', 'fish']);
    return { itemId: payload.itemId, transactionId, guild: await getGuild(userId, guildId, client) };
  });
}

export async function guildLedger(userId: string, guildId: string, offset = 0, limit = 20) {
  await assertRole(pool, userId, guildId, ['LEADER', 'ADMIN', 'MEMBER']);
  const result = await pool.query(`SELECT t.id,t.kind,t.source_key,t.actor_user_id,f.nickname AS actor_nickname,
      e.amount,e.balance_after,t.created_at
    FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.transaction_id
    LEFT JOIN fish f ON f.user_id=t.actor_user_id
    WHERE e.wallet_id=$1 ORDER BY t.created_at DESC,t.id DESC OFFSET $2 LIMIT $3`, [guildWalletId(guildId), offset, limit + 1]);
  return { items: result.rows.slice(0, limit), nextCursor: result.rows.length > limit ? String(offset + limit) : null };
}

export async function dissolveGuild(userId: string, key: string, guildId: string, payload: { version: number; confirm: true }) {
  return durable(userId, `guilds:${guildId}:dissolve`, key, payload, async client => {
    const guild = await guildRow(client, guildId, true);
    assert(guild.status === 'ACTIVE' && guild.version === payload.version, 'VERSION_CONFLICT', '鱼群状态已更新，请重新查看');
    await assertRole(client, userId, guildId, ['LEADER']);
    const users = await memberIds(client, guildId);
    await assertNoActiveMatch(client, users, '仍有成员处于比赛邀请、准备或结算中，暂不能解散');
    const teamMatches = await client.query('SELECT 1 FROM matches WHERE (guild_a=$1 OR guild_b=$1) AND status=ANY($2::text[]) LIMIT 1', [guildId, activeMatchPhases]);
    assert(!teamMatches.rowCount, 'STAKE_LOCKED', '鱼群仍有未完成比赛，暂不能解散');
    await client.query("UPDATE guilds SET status='ARCHIVED',archived_at=now(),version=version+1 WHERE id=$1", [guildId]);
    await client.query('DELETE FROM guild_members WHERE guild_id=$1', [guildId]);
    await client.query("UPDATE guild_applications SET status='CANCELLED',updated_at=now() WHERE guild_id=$1 AND status IN ('PENDING','INVITED','ACCEPTED')", [guildId]);
    await audit(client, userId, 'GUILD_DISSOLVE', guildId, guild, { status: 'ARCHIVED' });
    await invalidate(client, users, ['guild', 'fish']);
    return { dissolved: true, guildId, archivedAssets: true, memberUserIds: users };
  });
}
