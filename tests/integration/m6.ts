import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { config } from '../../packages/game-core/src/index';
import type { InputFrame } from '../../packages/protocol/src/index';
import { pool, tx } from '../../apps/server/src/persistence/db';
import { createFish, createGuest, selfView } from '../../apps/server/src/services/identity';
import { personalWalletId, transfer } from '../../apps/server/src/services/economy';
import {
  acceptApplication,
  applyToGuild,
  createGuild,
  dissolveGuild,
  donateToGuild,
  getGuild,
  guildLedger,
  guildMarkForUser,
  leaveGuild,
  purchaseGuildItem,
  removeGuildMember,
  setGuildRole,
  transferLeader,
  updateGuild,
} from '../../apps/server/src/services/guilds';
import { World, type ConnectionRuntime, type PlayerRuntime } from '../../apps/server/src/simulation/world';

const appearance = { presetId: 'goldfish' as const, bodyColor: '#ffaa45', finColor: '#539bec', patternId: 'none', skinAssetId: null, equipped: {}, version: 1 };
async function member(name: string, balance = 600) {
  const { userId } = await createGuest();
  await createFish(userId, randomUUID(), { nickname: name, appearance });
  await tx(async client => {
    await client.query("UPDATE users SET role='MEMBER',employee_ref=$2 WHERE id=$1", [userId, `m6-${randomUUID()}`]);
    const delta = balance - config.fish.starterPowerOnce;
    if (delta) await transfer(client, `m6-fixture:${userId}`, 'TEST_FIXTURE', userId, [{ walletId: personalWalletId(userId), amount: delta }, { walletId: 'system:MINT', amount: -delta }]);
  });
  return userId;
}
async function rejectsCode(promise: Promise<unknown>, code: string) {
  let caught = false;
  try { await promise; } catch (error) { caught = true; assert.equal((error as { code?: string }).code, code); }
  assert(caught, `预期拒绝 ${code}`);
}
async function accept(guildId: string, leader: string, target: string) {
  await applyToGuild(target, randomUUID(), guildId);
  const guild = await getGuild(leader, guildId);
  return acceptApplication(leader, randomUUID(), guildId, target, guild.version);
}
async function activeMatch(userId: string) {
  const self = await selfView(userId), id = randomUUID();
  await tx(async client => {
    await client.query("INSERT INTO matches(id,mode,status,rules_version,owner_epoch) VALUES ($1,'DUEL_FRIENDLY','READY_CHECK',$2,$3)", [id, config.rulesVersion, randomUUID()]);
    await client.query("INSERT INTO match_participants(match_id,user_id,fish_id,team) VALUES ($1,$2,$3,'A')", [id, userId, self.fishId]);
  });
  return { id, async cleanup() { await tx(async client => { await client.query('DELETE FROM match_participants WHERE match_id=$1', [id]); await client.query('DELETE FROM matches WHERE id=$1', [id]); }); } };
}

class FakeSocket {
  id = `m6-socket-${randomUUID()}`;
  connected = true;
  handlers = new Map<string, (...args: any[]) => void>();
  events: Array<{ event: string; payload: unknown }> = [];
  on(event: string, handler: (...args: any[]) => void) { this.handlers.set(event, handler); return this; }
  emit(event: string, payload: unknown) { this.events.push({ event, payload }); return true; }
  async client<T>(event: string, payload: unknown): Promise<T> {
    const handler = this.handlers.get(event); assert(handler, `缺少 ${event} 处理器`);
    return new Promise<T>((resolve, reject) => handler(payload, (result: any) => result.error ? reject(Object.assign(new Error(result.error.message), { code: result.error.code })) : resolve(result.data)));
  }
}
async function online(world: World, userId: string) {
  const socket = new FakeSocket();
  await world.connect(socket as any, userId);
  await socket.client('session:hello', { protocolVersion: 1, clientInstanceId: randomUUID() });
  const player = world.players.get(userId)!;
  const connection = world.connections.get(socket.id)!;
  return { socket, player, connection };
}
function input(world: World, player: PlayerRuntime, connection: ConnectionRuntime, seq: number, direction = { x: 1, y: 0 }) {
  const frame: InputFrame = { protocolVersion: 1, roomId: player.roomId, sceneEpoch: connection.sceneEpoch, inputSeq: seq, basedOnServerTick: world.serverTick, move: { kind: 'direction', direction }, actions: [], pageVisible: true };
  world.input(connection, frame);
}

try {
  const leader = await member('鱼群验收长', 700);
  const created = await createGuild(leader, randomUUID(), { name: `珊瑚队${randomUUID().slice(0, 4)}`, badge: '◆', color: '#21BDE7', notice: '一起下班' });
  const guildId = created.id as string;
  assert.equal((await selfView(leader)).guildId, guildId);
  assert.equal((await selfView(leader)).wallet.powerBalance, 600);
  assert.equal(created.wallet.balance, 0);

  // G01: fill to seven, then race two applicants for the eighth place.
  const accepted: string[] = [];
  for (let i = 0; i < 6; i++) { const id = await member(`容量成员${i}`); await accept(guildId, leader, id); accepted.push(id); }
  assert.equal((await getGuild(leader, guildId)).members.length, 7);
  const candidateA = await member('第八候选甲'), candidateB = await member('第八候选乙');
  await applyToGuild(candidateA, randomUUID(), guildId); await applyToGuild(candidateB, randomUUID(), guildId);
  const capacityVersion = (await getGuild(leader, guildId)).version;
  const race = await Promise.allSettled([
    acceptApplication(leader, randomUUID(), guildId, candidateA, capacityVersion),
    acceptApplication(leader, randomUUID(), guildId, candidateB, capacityVersion),
  ]);
  assert.equal(race.filter(result => result.status === 'fulfilled').length, 1);
  const full = await getGuild(leader, guildId); assert.equal(full.members.length, config.guild.memberLimit);
  const joinedCandidate = [candidateA, candidateB].find(id => full.members.some((entry: any) => entry.userId === id))!;
  const waitingCandidate = joinedCandidate === candidateA ? candidateB : candidateA;
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM guild_members WHERE guild_id=$1', [guildId])).rows[0].n, 8);
  await rejectsCode(applyToGuild(accepted[0]!, randomUUID(), guildId), 'VERSION_CONFLICT');

  // G02/G05: permissions, atomic transfer, donation, shared asset and ledger.
  let guild = await getGuild(leader, guildId);
  guild = await setGuildRole(leader, randomUUID(), guildId, accepted[0]!, { role: 'ADMIN', version: guild.version });
  guild = await updateGuild(accepted[0]!, randomUUID(), guildId, { notice: '管理员更新公告', version: guild.version });
  await rejectsCode(updateGuild(accepted[0]!, randomUUID(), guildId, { badge: '×', version: guild.version }), 'MEMBER_REQUIRED');
  guild = await transferLeader(leader, randomUUID(), guildId, { targetUserId: joinedCandidate, version: guild.version });
  assert.equal(guild.leaderUserId, joinedCandidate);
  assert.equal(guild.members.find((entry: any) => entry.userId === leader).role, 'MEMBER');
  assert.equal(guild.members.find((entry: any) => entry.userId === joinedCandidate).role, 'LEADER');
  await rejectsCode(purchaseGuildItem(leader, randomUUID(), guildId, { itemId: 'guild.banner.basic', itemVersion: 1 }), 'MEMBER_REQUIRED');
  const donationKey = randomUUID();
  const donated = await donateToGuild(leader, donationKey, guildId, { amount: 250 });
  const donationReplays = await Promise.all(Array.from({ length: 10 }, () => donateToGuild(leader, donationKey, guildId, { amount: 250 })));
  for (const replay of donationReplays) assert.deepEqual(replay, donated);
  assert.equal((await selfView(leader)).wallet.powerBalance, 350);
  assert.equal(donated.guildWallet.balance, 250);
  const purchase = await purchaseGuildItem(joinedCandidate, randomUUID(), guildId, { itemId: 'guild.banner.basic', itemVersion: 1 });
  assert.equal(purchase.guild.wallet.balance, 50);
  assert(purchase.guild.assets.some((asset: any) => asset.itemId === 'guild.banner.basic'));
  assert.equal((await guildMarkForUser(accepted[1]!))?.bannerItemId, 'guild.banner.basic');
  const ledger = await guildLedger(accepted[1]!, guildId, 0, 20);
  assert(ledger.items.some((entry: any) => entry.kind === 'GUILD_DONATION' && entry.amount === 250));
  assert(ledger.items.some((entry: any) => entry.kind === 'GUILD_PURCHASE' && entry.amount === -200));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM ledger_transactions WHERE source_key=$1', [`guild-donation:${guildId}:${leader}:${donationKey}`])).rows[0].n, 1);

  // G06: active match blocks removal; leaving applies a database-backed cooldown.
  const protectedMember = accepted[2]!, match = await activeMatch(protectedMember);
  try { await rejectsCode(removeGuildMember(joinedCandidate, randomUUID(), guildId, protectedMember, purchase.guild.version), 'STAKE_LOCKED'); }
  finally { await match.cleanup(); }
  const beforeLeave = await getGuild(joinedCandidate, guildId);
  await leaveGuild(accepted[3]!, randomUUID(), guildId);
  await rejectsCode(applyToGuild(accepted[3]!, randomUUID(), guildId), 'PEER_NOT_ELIGIBLE');
  assert((await pool.query('SELECT guild_rejoin_at>now() AS cooling FROM users WHERE id=$1', [accepted[3]])).rows[0].cooling);
  assert.equal((await getGuild(joinedCandidate, guildId)).members.length, beforeLeave.members.length - 1);

  // A separate wallet race proves organization purchases cannot overdraw.
  const raceLeader = await member('组织钱包并发', 700), raceGuild = await createGuild(raceLeader, randomUUID(), { name: `钱包队${randomUUID().slice(0, 4)}`, badge: '●', color: '#AA8CEB', notice: '' });
  await donateToGuild(raceLeader, randomUUID(), raceGuild.id, { amount: 300 });
  const purchaseRace = await Promise.allSettled([
    purchaseGuildItem(raceLeader, randomUUID(), raceGuild.id, { itemId: 'guild.banner.basic', itemVersion: 1 }),
    purchaseGuildItem(raceLeader, randomUUID(), raceGuild.id, { itemId: 'guild.trail.basic', itemVersion: 1 }),
  ]);
  assert.equal(purchaseRace.filter(result => result.status === 'fulfilled').length, 1);
  const raceWallet = await pool.query('SELECT balance FROM wallets WHERE owner_guild_id=$1', [raceGuild.id]); assert(raceWallet.rows[0].balance >= 0);

  // G03/G04: three actual server runtimes follow a leader, manual input leaves immediately, then fallback is elected.
  const followLeader = await member('群游领游'), followB = await member('群游成员乙'), followC = await member('群游成员丙');
  const followGuild = await createGuild(followLeader, randomUUID(), { name: `群游队${randomUUID().slice(0, 4)}`, badge: '〰', color: '#FF7B88', notice: '' });
  await accept(followGuild.id, followLeader, followB); await accept(followGuild.id, followLeader, followC);
  const world = new World({} as ConstructorParameters<typeof World>[0]);
  const a = await online(world, followLeader), b = await online(world, followB), c = await online(world, followC);
  assert.equal(a.player.roomId, b.player.roomId); assert.equal(b.player.roomId, c.player.roomId);
  await a.socket.client('guild:follow', { enabled: true, leaderFishId: a.player.fish.id, sceneEpoch: a.connection.sceneEpoch });
  await b.socket.client('guild:follow', { enabled: true, leaderFishId: a.player.fish.id, sceneEpoch: b.connection.sceneEpoch });
  await c.socket.client('guild:follow', { enabled: true, leaderFishId: a.player.fish.id, sceneEpoch: c.connection.sceneEpoch });
  const startA = { ...a.player.fish.position }, startB = { ...b.player.fish.position };
  input(world, a.player, a.connection, 1, { x: 1, y: 0 });
  for (let i = 0; i < 75; i++) world.step(1 / 30);
  assert(a.player.fish.position.x > startA.x + 120);
  assert(Math.hypot(b.player.fish.position.x - startB.x, b.player.fish.position.y - startB.y) > 30);
  assert.equal(b.player.fish.followLeaderFishId, a.player.fish.id);
  const distances = [a.player, b.player, c.player].flatMap((left, index, all) => all.slice(index + 1).map(right => Math.hypot(left.fish.position.x - right.fish.position.x, left.fish.position.y - right.fish.position.y)));
  assert(distances.every(distance => distance > config.tank.playerBodyRadius));
  input(world, b.player, b.connection, 1, { x: 0, y: -1 });
  assert.equal(b.player.follow.enabled, false); assert.equal(b.player.fish.followGroupId, null);
  world.connections.delete(a.socket.id); a.socket.connected = false; a.player.controlSocketId = null; a.player.disconnectedAt = Date.now();
  const group = [...world.followGroups.values()][0]!; group.missingSince = Date.now() - config.guild.leaderDisconnectFallbackSeconds * 1000 - 10;
  world.step(1 / 30);
  assert.equal(group.leaderFishId, c.player.fish.id);
  assert.equal(c.player.fish.followLeaderFishId, c.player.fish.id);

  // Unfinished matches block dissolution; after cleanup, assets remain archived and personal wardrobe is untouched.
  const dissolveMatch = await activeMatch(accepted[1]!);
  let current = await getGuild(joinedCandidate, guildId);
  try { await rejectsCode(dissolveGuild(joinedCandidate, randomUUID(), guildId, { version: current.version, confirm: true }), 'STAKE_LOCKED'); }
  finally { await dissolveMatch.cleanup(); }
  current = await getGuild(joinedCandidate, guildId);
  await dissolveGuild(joinedCandidate, randomUUID(), guildId, { version: current.version, confirm: true });
  const archived = await pool.query('SELECT status FROM guilds WHERE id=$1', [guildId]); assert.equal(archived.rows[0].status, 'ARCHIVED');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM guild_members WHERE guild_id=$1', [guildId])).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM guild_assets WHERE guild_id=$1', [guildId])).rows[0].n, 1);
  assert.equal((await selfView(leader)).guildId, null);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM guild_members GROUP BY guild_id HAVING count(*)>$1', [config.guild.memberLimit])).rowCount, 0);
  assert.equal((await pool.query('SELECT transaction_id FROM ledger_entries GROUP BY transaction_id HAVING sum(amount)<>0')).rowCount, 0);
  const negativeGuild = await pool.query("SELECT id FROM wallets WHERE owner_kind='GUILD' AND (balance<0 OR held<>0)"); assert.equal(negativeGuild.rowCount, 0);
  assert.equal((await pool.query("SELECT user_id FROM guild_members GROUP BY user_id HAVING count(*)>1")).rowCount, 0);
  assert(waitingCandidate);

  console.log(JSON.stringify({ stage: 'M6', database: 'PostgreSQL17', passed: [
    '创建扣100且一人一组织', '并发竞争第8席仅一人成功并保持8人上限', '组织长/管理员/成员权限与原子转让',
    '捐献同键十次只入账一次且个人/组织账目守恒', '组织购买、共享旗帜归属与全员可查流水', '并发组织购买不透支',
    '退出24小时冷却、比赛中不可移除', '三独立运行时自然跟随/分离/手动脱队/5秒领游接替',
    '未完成比赛阻止解散、归档资产不退个人', '全库流水净和、组织钱包非负且成员唯一',
  ] }, null, 2));
} finally { await pool.end(); }
