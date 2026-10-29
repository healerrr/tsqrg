import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool } from '../../apps/server/src/persistence/db';
import { createGuest } from '../../apps/server/src/services/identity';
import { assetWriteState, pauseAssetWrites, resumeAssetWrites } from '../../apps/server/src/services/write-guard';
import { databaseMetrics, enforceReconciliation, reconcile } from '../../apps/server/src/services/operations';

const metricsToken = `m8-${randomUUID()}-${randomUUID()}`;
process.env.OPS_METRICS_TOKEN = metricsToken;
process.env.SHUTDOWN_DRAIN_MS = '0';

const { createApp } = await import('../../apps/server/src/http/app');
const server = await createApp();

try {
  const guest = await createGuest();
  await pool.query("UPDATE users SET role='ADMIN',employee_ref=$2 WHERE id=$1", [guest.userId, `m8-admin-${randomUUID()}`]);
  const cookie = `aquarium_session=${server.app.signCookie(guest.token)}`;
  const key = randomUUID();
  const payload = { employeeRef: `m8-invite-${randomUUID()}` };

  const first = await server.app.inject({ method: 'POST', url: '/api/v1/admin/invites', headers: { cookie, 'idempotency-key': key }, payload });
  assert.equal(first.statusCode, 200);
  const firstBody = first.json().data;
  assert.match(firstBody.inviteCode, /^[A-Za-z0-9_-]+$/);

  const replay = await server.app.inject({ method: 'POST', url: '/api/v1/admin/invites', headers: { cookie, 'idempotency-key': key }, payload });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().data.id, firstBody.id);
  assert.equal(replay.json().data.inviteCode, undefined);
  const stored = await pool.query('SELECT code_hash FROM employee_invites WHERE id=$1', [firstBody.id]);
  assert.equal(stored.rowCount, 1);
  assert.notEqual(stored.rows[0].code_hash, firstBody.inviteCode);
  const idem = await pool.query("SELECT response_json FROM idempotency_keys WHERE user_id=$1 AND route_scope='admin:invite' AND key=$2", [guest.userId, key]);
  assert.equal(idem.rows[0].response_json.inviteCode, undefined);

  const unauthorizedMetrics = await server.app.inject({ method: 'GET', url: '/metrics' });
  assert.equal(unauthorizedMetrics.statusCode, 401);
  const metrics = await server.app.inject({ method: 'GET', url: '/metrics', headers: { authorization: `Bearer ${metricsToken}` } });
  assert.equal(metrics.statusCode, 200);
  assert.match(metrics.body, /aquarium_connections/);
  assert.match(metrics.body, /aquarium_frozen_power/);

  const operations = await server.app.inject({ method: 'GET', url: '/api/v1/admin/operations', headers: { cookie } });
  assert.equal(operations.statusCode, 200);
  assert.equal(typeof operations.json().data.runtime.database.active_matches, 'number');

  const report = await reconcile();
  assert.equal(report.ok, true, JSON.stringify(report.checks.filter(check => check.count), null, 2));
  await enforceReconciliation(report);
  const database = await databaseMetrics();
  assert.equal(typeof database.held_power, 'number');
  assert.equal(typeof database.pool.waiting, 'number');

  pauseAssetWrites('integrity', 'M8 集成脚本临时验证写保护');
  assert.equal(assetWriteState().allowed, false);
  const blocked = await server.app.inject({ method: 'POST', url: '/api/v1/admin/invites', headers: { cookie, 'idempotency-key': randomUUID() }, payload: { employeeRef: `blocked-${randomUUID()}` } });
  assert.equal(blocked.statusCode, 503);
  resumeAssetWrites('integrity');
  assert.equal(assetWriteState().allowed, true);

  console.log(JSON.stringify({
    stage: 'M8',
    database: 'PostgreSQL17',
    passed: ['管理员鉴权', '邀请码只首次返回明文且幂等记录无明文', 'Prometheus令牌保护', '运维总览', '完整账目对账', '数据库指标', '对账异常资产写保护'],
    deferred: ['30连接和两场团战负载', '30分钟趋势', 'Docker空环境', '备份恢复演练'],
  }, null, 2));
} finally {
  resumeAssetWrites('integrity');
  await server.close();
}
