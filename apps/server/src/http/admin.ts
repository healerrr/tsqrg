import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { adminInviteSchema, nicknameSchema, uuidSchema } from '@aquarium/protocol';
import { pool } from '../persistence/db';
import { durable, hash } from '../services/economy';
import { enforceReconciliation, reconcile } from '../services/operations';
import { assetWriteState, resumeAssetWrites } from '../services/write-guard';
import type { World } from '../simulation/world';
import { assert } from './errors';

const pageSchema = z.object({ cursor: z.coerce.number().int().nonnegative().default(0), limit: z.coerce.number().int().min(1).max(100).default(20) });
const moderateFishSchema = z.object({ nickname: z.string(), reason: z.string().trim().min(2).max(200) }).strict();
type RuntimeOverview = () => Promise<unknown>;

export function registerAdminRoutes(app: FastifyInstance, world: World, overview: RuntimeOverview) {
  const key = (request: FastifyRequest) => String(request.headers['idempotency-key'] ?? '');
  async function admin(request: FastifyRequest): Promise<string> {
    assert(request.userId, 'AUTH_REQUIRED', '请先进入游戏', 401);
    const user = await pool.query('SELECT role FROM users WHERE id=$1', [request.userId]);
    assert(user.rows[0]?.role === 'ADMIN', 'MEMBER_REQUIRED', '只有管理员可以使用此功能', 403);
    return request.userId;
  }
  const ok = (data: unknown, requestId: string) => ({ data, requestId });
  const audit = async (client: Pick<import('pg').PoolClient, 'query'>, actor: string, action: string, target: string, before: unknown, after: unknown, reason = '') => {
    await client.query('INSERT INTO audit_logs(id,actor_user_id,action,target_type,target_id,before_json,after_json,reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [randomUUID(), actor, action, action.startsWith('SHOP') ? 'SHOP_ITEM' : action.startsWith('UPLOAD') ? 'UPLOAD' : 'SYSTEM', target, JSON.stringify(before), JSON.stringify(after), reason]);
  };

  app.get('/api/v1/admin/invites', async request => {
    await admin(request); const page = pageSchema.parse(request.query);
    const result = await pool.query('SELECT id,employee_ref,expires_at,used_by,used_at FROM employee_invites ORDER BY expires_at DESC,id OFFSET $1 LIMIT $2', [page.cursor, page.limit + 1]);
    return ok({ items: result.rows.slice(0, page.limit), nextCursor: result.rows.length > page.limit ? String(page.cursor + page.limit) : null }, request.id);
  });
  app.post('/api/v1/admin/invites', async request => {
    const userId = await admin(request), payload = adminInviteSchema.parse(request.body);
    let oneTimeCode: string | undefined;
    const result = await durable(userId, 'admin:invite', key(request), payload, async client => {
      const expires = payload.expiresAt ? new Date(payload.expiresAt) : new Date(Date.now() + 7 * 86400000);
      assert(expires.getTime() > Date.now(), 'VERSION_CONFLICT', '邀请码到期时间必须晚于现在', 400);
      const id = randomUUID(), inviteCode = randomBytes(12).toString('base64url');
      oneTimeCode = inviteCode;
      await client.query('INSERT INTO employee_invites(id,code_hash,employee_ref,expires_at) VALUES ($1,$2,$3,$4)', [id, hash(inviteCode), payload.employeeRef, expires]);
      await audit(client, userId, 'INVITE_CREATE', id, null, { employeeRef: payload.employeeRef, expiresAt: expires.toISOString() });
      // Durable replay data deliberately excludes the secret. A retried response cannot reveal it again.
      return { id, employeeRef: payload.employeeRef, expiresAt: expires.toISOString() };
    });
    return ok(oneTimeCode ? { ...result, inviteCode: oneTimeCode } : result, request.id);
  });
  app.get('/api/v1/admin/shop/items', async request => { await admin(request); return ok((await pool.query('SELECT * FROM shop_items ORDER BY scope,price,id')).rows, request.id); });
  app.patch<{ Params: { id: string } }>('/api/v1/admin/shop/items/:id', async request => {
    const userId = await admin(request), id = z.string().max(100).parse(request.params.id);
    const payload = z.object({ price: z.number().int().nonnegative().max(1000000), enabled: z.boolean(), version: z.number().int().positive() }).strict().parse(request.body);
    const result = await durable(userId, `admin:shop:${id}`, key(request), payload, async client => {
      const old = (await client.query('SELECT * FROM shop_items WHERE id=$1 FOR UPDATE', [id])).rows[0];
      assert(old, 'PEER_NOT_ELIGIBLE', '商品不存在'); assert(old.version === payload.version, 'VERSION_CONFLICT', '商品已被修改，请刷新后重试');
      const item = (await client.query('UPDATE shop_items SET price=$2,enabled=$3,version=version+1 WHERE id=$1 RETURNING *', [id, payload.price, payload.enabled])).rows[0];
      await audit(client, userId, 'SHOP_ITEM_UPDATE', id, old, item); return item;
    });
    return ok(result, request.id);
  });
  app.get('/api/v1/admin/uploads', async request => {
    await admin(request); const page = pageSchema.parse(request.query);
    const rows = await pool.query('SELECT id,user_id,mime,width,height,status,created_at FROM uploads ORDER BY created_at DESC,id OFFSET $1 LIMIT $2', [page.cursor, page.limit + 1]);
    return ok({ items: rows.rows.slice(0, page.limit), nextCursor: rows.rows.length > page.limit ? String(page.cursor + page.limit) : null }, request.id);
  });
  app.patch<{ Params: { id: string } }>('/api/v1/admin/uploads/:id', async request => {
    const userId = await admin(request), id = uuidSchema.parse(request.params.id);
    const payload = z.object({ status: z.enum(['ACTIVE', 'REMOVED']), reason: z.string().trim().min(2).max(200) }).strict().parse(request.body);
    const result = await durable(userId, `admin:upload:${id}`, key(request), payload, async client => {
      const old = (await client.query('SELECT * FROM uploads WHERE id=$1 FOR UPDATE', [id])).rows[0]; assert(old, 'UPLOAD_INVALID', '图片不存在', 404);
      await client.query('UPDATE uploads SET status=$2 WHERE id=$1', [id, payload.status]);
      if (payload.status === 'REMOVED') {
        await client.query(`UPDATE fish SET appearance_json=jsonb_set(jsonb_set(appearance_json,'{skinAssetId}','null'::jsonb),'{version}',to_jsonb(appearance_version+1)),appearance_version=appearance_version+1 WHERE appearance_json->>'skinAssetId'=$1`, [id]);
      }
      await audit(client, userId, 'UPLOAD_MODERATE', id, { status: old.status }, { status: payload.status }, payload.reason);
      await client.query('INSERT INTO outbox_events(id,event_type,aggregate_id,payload) VALUES ($1,$2,$3,$4)', [randomUUID(), 'self:invalidate', old.user_id, JSON.stringify({ domains: ['fish'] })]);
      return { assetId: id, userId: old.user_id, status: payload.status };
    });
    await world.refreshPlayer(result.userId); world.invalidate(result.userId, ['fish']); return ok(result, request.id);
  });
  app.patch<{ Params: { id: string } }>('/api/v1/admin/fish/:id', async request => {
    const actor = await admin(request);
    const fishId = uuidSchema.parse(request.params.id);
    const parsed = moderateFishSchema.parse(request.body);
    const payload = { nickname: nicknameSchema.parse(parsed.nickname), reason: parsed.reason };
    const result = await durable(actor, `admin:fish:${fishId}`, key(request), payload, async client => {
      const old = (await client.query('SELECT user_id,nickname FROM fish WHERE id=$1 FOR UPDATE', [fishId])).rows[0]; assert(old, 'FISH_NOT_OWNED', '角色不存在', 404);
      await client.query('UPDATE fish SET nickname=$2 WHERE id=$1', [fishId, payload.nickname]);
      await audit(client, actor, 'NICKNAME_MODERATE', fishId, { nickname: old.nickname }, { nickname: payload.nickname }, payload.reason);
      return { fishId, userId: old.user_id, nickname: payload.nickname };
    });
    await world.refreshPlayer(result.userId); world.invalidate(result.userId, ['fish']); return ok(result, request.id);
  });
  app.get('/api/v1/admin/audit', async request => {
    await admin(request); const page = pageSchema.parse(request.query);
    const result = await pool.query('SELECT * FROM audit_logs ORDER BY created_at DESC,id OFFSET $1 LIMIT $2', [page.cursor, page.limit + 1]);
    return ok({ items: result.rows.slice(0, page.limit), nextCursor: result.rows.length > page.limit ? String(page.cursor + page.limit) : null }, request.id);
  });
  app.get('/api/v1/admin/reconciliation', async request => { await admin(request); return ok(await reconcile(), request.id); });
  app.get('/api/v1/admin/operations', async request => { await admin(request); return ok({ runtime: await overview(), assetWrites: assetWriteState() }, request.id); });
  app.post('/api/v1/admin/operations/recheck', async request => {
    const actor = await admin(request), payload = z.object({ reason: z.string().trim().min(2).max(200) }).strict().parse(request.body);
    const report = await reconcile(); await enforceReconciliation(report);
    assert(report.ok, 'MATCH_STATE_INVALID', '对账仍有异常，资产操作保持暂停');
    const result = await durable(actor, 'admin:operations:recheck', key(request), payload, async client => {
      await audit(client, actor, 'ASSET_WRITES_RECHECK', 'economy', assetWriteState(), report, payload.reason); return { ok: true, checkedAt: report.checkedAt };
    }, { allowWhenPaused: true });
    resumeAssetWrites('integrity'); resumeAssetWrites('database'); return ok(result, request.id);
  });
}
