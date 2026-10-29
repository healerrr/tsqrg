import { isAbsolute, parse, resolve } from 'node:path';
import { config } from '@aquarium/core';

function integerSetting(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (raw?.trim() === '' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} 必须是 ${min}—${max} 的整数`);
  }
  return value;
}

/** Validate before opening database connections, timers or the listening socket. */
export function readRuntimeConfig(env: NodeJS.ProcessEnv = process.env) {
  const production = env.NODE_ENV === 'production';
  const port = integerSetting(env, 'PORT', 3000, 1, 65535);
  const operationsIntervalMs = integerSetting(env, 'OPERATIONS_CHECK_INTERVAL_MS', 60000, 10000, 3600000);
  const shutdownDrainMs = integerSetting(env, 'SHUTDOWN_DRAIN_MS', 35000, 0, 35000);
  if (production) {
    const required = ['HOST', 'PORT', 'DATABASE_URL', 'APP_ORIGIN', 'SESSION_SECRET', 'UPLOAD_DIR', 'GAME_TIMEZONE', 'RULES_VERSION', 'LOG_LEVEL', 'OPS_METRICS_TOKEN'] as const;
    const missing = required.filter(name => !env[name]?.trim());
    if (missing.length) throw new Error(`生产环境缺少必要变量：${missing.join('、')}`);
    if (env.SESSION_SECRET!.length < 32 || env.OPS_METRICS_TOKEN!.length < 24) throw new Error('生产环境 SESSION_SECRET 至少32字符，OPS_METRICS_TOKEN 至少24字符');
    if ([env.SESSION_SECRET, env.OPS_METRICS_TOKEN].some(value => value?.startsWith('REPLACE_'))) throw new Error('请替换生产密钥占位值');
    let origin: URL;
    try { origin = new URL(env.APP_ORIGIN!); } catch { throw new Error('生产环境 APP_ORIGIN 不是有效的 HTTPS 来源'); }
    if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) throw new Error('生产环境 APP_ORIGIN 必须是无凭据、路径、查询或片段的 HTTPS 同域来源');
    const uploadPath = resolve(env.UPLOAD_DIR!);
    if (!isAbsolute(env.UPLOAD_DIR!) || uploadPath === parse(uploadPath).root) throw new Error('生产环境 UPLOAD_DIR 必须是非根目录的绝对路径');
    if (env.GAME_TIMEZONE !== 'Asia/Shanghai') throw new Error('首版生产业务时区必须是 Asia/Shanghai');
    if (env.RULES_VERSION !== config.rulesVersion) throw new Error(`生产规则版本必须与构建配置一致：${config.rulesVersion}`);
  }
  const logLevel = env.LOG_LEVEL ?? 'info';
  if (!['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'].includes(logLevel)) throw new Error('LOG_LEVEL 无效');
  return { production, port, host: env.HOST ?? '127.0.0.1', operationsIntervalMs, shutdownDrainMs, logLevel };
}
