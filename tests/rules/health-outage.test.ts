import { describe, expect, it, vi } from 'vitest';
import { pool } from '../../apps/server/src/persistence/db';
import { createApp } from '../../apps/server/src/http/app';
import { resumeAssetWrites } from '../../apps/server/src/services/write-guard';

describe('数据库不可用时的进程观测', () => {
  it('带失效会话的存活检查和令牌监控可读取，readiness关闭且数据库指标不伪装成0', async () => {
    vi.stubEnv('NODE_ENV', 'development'); vi.stubEnv('LOG_LEVEL', 'silent');
    const metricsToken = 'test-outage-metrics-token-only'; vi.stubEnv('OPS_METRICS_TOKEN', metricsToken);
    const query = vi.spyOn(pool, 'query').mockRejectedValue(new Error('database unavailable fixture'));
    const server = await createApp();
    const cookie = `aquarium_session=${server.app.signCookie('unavailable-session-token')}`;
    try {
      const live = await server.app.inject({ method: 'GET', url: '/api/v1/health/live', headers: { cookie } });
      expect(live.statusCode).toBe(200); expect(query).not.toHaveBeenCalled();
      const ready = await server.app.inject({ method: 'GET', url: '/api/v1/health/ready', headers: { cookie } });
      expect(ready.statusCode).toBe(503);
      expect(ready.json().data.database).toBe(false);
      const unauthorized = await server.app.inject({ method: 'GET', url: '/metrics', headers: { cookie } });
      expect(unauthorized.statusCode).toBe(401);
      const metrics = await server.app.inject({ method: 'GET', url: '/metrics', headers: { cookie, authorization: `Bearer ${metricsToken}` } });
      expect(metrics.statusCode).toBe(200);
      expect(metrics.body).toContain('aquarium_database_available 0');
      expect(metrics.body).toContain('aquarium_ready 0');
      expect(metrics.body).toContain('aquarium_frozen_power NaN');
      expect(metrics.body).toMatch(/aquarium_process_resident_memory_bytes \d+/);
    } finally {
      await server.close(); query.mockRestore();
      resumeAssetWrites('database'); resumeAssetWrites('maintenance'); vi.unstubAllEnvs();
    }
  });
});
