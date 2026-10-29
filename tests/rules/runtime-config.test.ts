import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRuntimeConfig } from '../../apps/server/src/runtime-config';

function production(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production', HOST: '0.0.0.0', PORT: '3000',
    DATABASE_URL: 'postgresql://aquarium:test@db:5432/aquarium', APP_ORIGIN: 'https://fish.example.com',
    SESSION_SECRET: 'a'.repeat(32), OPS_METRICS_TOKEN: 'b'.repeat(24), UPLOAD_DIR: resolve('uploads'),
    GAME_TIMEZONE: 'Asia/Shanghai', RULES_VERSION: '1.0.0', LOG_LEVEL: 'info',
  };
}

describe('生产启动配置', () => {
  it('显式配置可启动，默认排空时间为容器停止宽限保留10秒', () => {
    expect(readRuntimeConfig(production())).toMatchObject({ production: true, port: 3000, shutdownDrainMs: 35000, operationsIntervalMs: 60000 });
    expect(readRuntimeConfig({})).toMatchObject({ production: false, host: '127.0.0.1' });
  });
  it.each([
    ['PORT', 'NaN'], ['PORT', '65536'], ['OPERATIONS_CHECK_INTERVAL_MS', 'NaN'],
    ['OPERATIONS_CHECK_INTERVAL_MS', ''], ['OPERATIONS_CHECK_INTERVAL_MS', '0'],
    ['SHUTDOWN_DRAIN_MS', 'NaN'], ['SHUTDOWN_DRAIN_MS', '-1'], ['SHUTDOWN_DRAIN_MS', '45000'],
    ['APP_ORIGIN', 'http://fish.example.com'], ['APP_ORIGIN', 'https://fish.example.com/other'],
    ['SESSION_SECRET', 'REPLACE_WITH_AT_LEAST_32_RANDOM_CHARACTERS'], ['UPLOAD_DIR', 'relative/uploads'],
  ])('启动前拒绝无效 %s=%s', (name, value) => {
    expect(() => readRuntimeConfig({ ...production(), [name]: value })).toThrow();
  });
  it('缺少生产密钥时说明缺失名称，错误不包含密钥值', () => {
    const env = production(); delete env.OPS_METRICS_TOKEN;
    expect(() => readRuntimeConfig(env)).toThrow('OPS_METRICS_TOKEN');
    expect(() => readRuntimeConfig({ ...env, SESSION_SECRET: 'private-secret' })).not.toThrow('private-secret');
  });
});
