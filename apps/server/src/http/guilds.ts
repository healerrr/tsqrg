import type { FastifyInstance } from 'fastify';
import {
  guildApplicationSchema,
  guildCreateSchema,
  guildDissolveSchema,
  guildDonationSchema,
  guildInviteSchema,
  guildRemoveSchema,
  guildRoleSchema,
  guildTransferSchema,
  guildUpdateSchema,
  purchaseSchema,
  uuidSchema,
} from '@aquarium/protocol';
import {
  acceptApplication,
  acceptInvitation,
  applyToGuild,
  createGuild,
  dissolveGuild,
  donateToGuild,
  getGuild,
  guildLedger,
  inviteToGuild,
  leaveGuild,
  listGuilds,
  purchaseGuildItem,
  removeGuildMember,
  setGuildRole,
  transferLeader,
  updateGuild,
} from '../services/guilds';
import type { World } from '../simulation/world';
import { assert } from './errors';

export function registerGuildRoutes(app: FastifyInstance, world: World) {
  const auth = (request: { userId: string | null }): string => { assert(request.userId, 'AUTH_REQUIRED', '请先进入游戏', 401); return request.userId; };
  const key = (request: { headers: Record<string, unknown> }): string => String(request.headers['idempotency-key'] ?? '');
  const ok = (data: unknown, requestId: string) => ({ data, requestId });
  const params = (request: { params: unknown }): { id: string; userId?: string } => {
    const raw = request.params as Record<string, unknown>;
    return { id: uuidSchema.parse(raw.id), userId: raw.userId === undefined ? undefined : uuidSchema.parse(raw.userId) };
  };
  const page = (query: unknown) => {
    const raw = query as Record<string, unknown>;
    const parsed = Number(raw.limit ?? 20);
    const limit = Number.isInteger(parsed) ? Math.max(1, Math.min(100, parsed)) : 20;
    const cursor = typeof raw.cursor === 'string' && /^\d+$/.test(raw.cursor) ? Number(raw.cursor) : 0;
    return { limit, cursor };
  };
  const sync = async (userIds: Array<string | undefined>) => {
    for (const userId of [...new Set(userIds.filter(Boolean) as string[])]) { await world.refreshPlayer(userId); world.invalidate(userId, ['guild', 'wallet', 'fish']); }
  };
  const syncGuild = async (guild: any, extra: string[] = []) => sync([...(guild?.members?.map((member: any) => member.userId ?? member.user_id) ?? []), ...extra]);

  app.get('/api/v1/guilds', async request => {
    const userId = auth(request);
    const paging = page(request.query), raw = request.query as Record<string, unknown>;
    const search = typeof raw.search === 'string' ? raw.search.trim().slice(0, 40) : '';
    return ok(await listGuilds(userId, search, paging.cursor, paging.limit), request.id);
  });
  app.get('/api/v1/guilds/:id', async request => {
    const userId = auth(request), { id } = params(request);
    const data = await getGuild(userId, id);
    for (const member of data.members) member.online = world.players.get(member.userId)?.disconnectedAt === null;
    return ok(data, request.id);
  });
  app.post('/api/v1/guilds', async request => {
    const userId = auth(request), payload = guildCreateSchema.parse(request.body);
    const data = await createGuild(userId, key(request), payload); await syncGuild(data, [userId]);
    return ok(data, request.id);
  });
  app.post('/api/v1/guilds/:id/applications', async request => {
    const userId = auth(request), { id } = params(request); guildApplicationSchema.parse(request.body ?? {});
    const data = await applyToGuild(userId, key(request), id); return ok(data, request.id);
  });
  app.post('/api/v1/guilds/:id/applications/:userId/accept', async request => {
    const actor = auth(request), { id, userId } = params(request), payload = guildRemoveSchema.parse(request.body);
    assert(userId, 'VERSION_CONFLICT', '缺少申请人');
    const data = await acceptApplication(actor, key(request), id, userId, payload.version); await syncGuild(data, [userId]);
    return ok(data, request.id);
  });
  app.post('/api/v1/guilds/:id/invitations', async request => {
    const actor = auth(request), { id } = params(request), payload = guildInviteSchema.parse(request.body);
    const data = await inviteToGuild(actor, key(request), id, payload); await sync([payload.targetUserId]); return ok(data, request.id);
  });
  app.post('/api/v1/guilds/:id/invitations/accept', async request => {
    const userId = auth(request), { id } = params(request), payload = guildRemoveSchema.parse(request.body);
    const data = await acceptInvitation(userId, key(request), id, payload.version); await syncGuild(data, [userId]); return ok(data, request.id);
  });
  app.patch('/api/v1/guilds/:id', async request => {
    const userId = auth(request), { id } = params(request), payload = guildUpdateSchema.parse(request.body);
    const data = await updateGuild(userId, key(request), id, payload); await syncGuild(data); return ok(data, request.id);
  });
  app.post('/api/v1/guilds/:id/members/:userId/role', async request => {
    const actor = auth(request), { id, userId } = params(request), payload = guildRoleSchema.parse(request.body);
    assert(userId, 'VERSION_CONFLICT', '缺少成员');
    const data = await setGuildRole(actor, key(request), id, userId, payload); await syncGuild(data, [userId]); return ok(data, request.id);
  });
  app.post('/api/v1/guilds/:id/transfer-leader', async request => {
    const actor = auth(request), { id } = params(request), payload = guildTransferSchema.parse(request.body);
    const data = await transferLeader(actor, key(request), id, payload); await syncGuild(data, [actor, payload.targetUserId]); return ok(data, request.id);
  });
  app.post('/api/v1/guilds/:id/leave', async request => {
    const userId = auth(request), { id } = params(request);
    const data = await leaveGuild(userId, key(request), id); await sync([userId]); return ok(data, request.id);
  });
  app.post('/api/v1/guilds/:id/members/:userId/remove', async request => {
    const actor = auth(request), { id, userId } = params(request), payload = guildRemoveSchema.parse(request.body);
    assert(userId, 'VERSION_CONFLICT', '缺少成员');
    const data = await removeGuildMember(actor, key(request), id, userId, payload.version); await syncGuild(data, [userId]); return ok(data, request.id);
  });
  app.post('/api/v1/guilds/:id/donations', async request => {
    const userId = auth(request), { id } = params(request), payload = guildDonationSchema.parse(request.body);
    const data = await donateToGuild(userId, key(request), id, payload); await sync([userId]); return ok(data, request.id);
  });
  app.post('/api/v1/guilds/:id/purchases', async request => {
    const userId = auth(request), { id } = params(request), payload = purchaseSchema.parse(request.body);
    const data = await purchaseGuildItem(userId, key(request), id, payload); await syncGuild(data.guild); return ok(data, request.id);
  });
  app.get('/api/v1/guilds/:id/ledger', async request => {
    const userId = auth(request), { id } = params(request), paging = page(request.query);
    return ok(await guildLedger(userId, id, paging.cursor, paging.limit), request.id);
  });
  app.post('/api/v1/guilds/:id/dissolve', async request => {
    const userId = auth(request), { id } = params(request), payload = guildDissolveSchema.parse(request.body);
    const data = await dissolveGuild(userId, key(request), id, payload); await sync(data.memberUserIds); return ok(data, request.id);
  });
}
