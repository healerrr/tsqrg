import pg, { type PoolClient } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';
import * as schema from './schema';
import { pauseAssetWrites } from '../services/write-guard';

export const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://aquarium:aquarium_dev@127.0.0.1:55432/aquarium';
export const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 10, min: 3, idleTimeoutMillis: 60000, connectionTimeoutMillis: 15000 });
export const db = drizzle(pool,{schema});
export const ownerEpoch = randomUUID();
export let ready = false;
export const setReady = (value: boolean) => { ready = value; };
let mainLock: PoolClient | null = null;
pool.on('error', (error: Error) => {
  ready = false;
  pauseAssetWrites('database', '数据库连接异常，资产命令保持暂停直至健康检查与对账恢复');
  console.error('数据库连接错误', error.message);
});
export async function acquireMainInstance(): Promise<void> {
  mainLock = await pool.connect();
  const result = await mainLock.query('SELECT pg_try_advisory_lock(739282) AS acquired');
  if (!result.rows[0].acquired) { mainLock.release(); mainLock = null; throw new Error('已有权威模拟实例运行，拒绝启动第二实例'); }
  mainLock.on('error', error => {
    ready = false;
    pauseAssetWrites('database', '权威模拟实例锁连接已丢失');
    console.error('权威实例锁连接已丢失，立即停止进程',error.message);
    process.exit(1);
  });
  const warm = await Promise.all([pool.connect(),pool.connect()]);
  for(const client of warm)client.release();
}
export async function releaseMainInstance(): Promise<void> {
  if (mainLock) { await mainLock.query('SELECT pg_advisory_unlock(739282)').catch(() => undefined); mainLock.release(); mainLock = null; }
}
/** Serializes durable writes in this first 30-user release, then applies row locks. */
export async function tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(739281)');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}
