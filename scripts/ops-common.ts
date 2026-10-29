import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';

const requireServer = createRequire(new URL('../apps/server/package.json', import.meta.url));
export const { Client } = requireServer('pg') as typeof import('../apps/server/node_modules/pg');
export type SqlClient = InstanceType<typeof Client>;
export function options() {
  const args = process.argv.slice(2), result: Record<string, string> = {};
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === '--') continue;
    if (argument === '--help' || argument === '-h') result.help = '1';
    else {
      if (!argument.startsWith('--') || !args[index + 1] || args[index + 1]!.startsWith('--')) throw new Error(`参数 ${argument} 需要一个值`);
      result[argument.slice(2)] = args[++index]!;
    }
  }
  return result;
}
export function databaseUrl(value: string | undefined, name = 'DATABASE_URL') {
  if (!value) throw new Error(`必须显式设置 ${name}，运维脚本不使用默认数据库`);
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname.slice(1)) throw new Error(`${name} 必须是包含数据库名的 PostgreSQL URL`);
  return url;
}
export function pgEnv(url: URL): NodeJS.ProcessEnv {
  const query = url.searchParams;
  return { ...process.env, PGHOST: url.hostname, PGPORT: url.port || '5432', PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGCONNECT_TIMEOUT: '15', ...(query.has('sslmode') ? { PGSSLMODE: query.get('sslmode')! } : {}), ...(query.has('sslrootcert') ? { PGSSLROOTCERT: query.get('sslrootcert')! } : {}), ...(process.env.PG_BIN ? { PATH: `${resolve(process.env.PG_BIN)}${delimiter}${process.env.PATH ?? ''}` } : {}) };
}
export async function pgCommand(command: 'pg_dump' | 'pg_restore', args: string[], env: NodeJS.ProcessEnv) {
  await new Promise<void>((complete, reject) => {
    const executable = process.env.PG_BIN ? join(resolve(process.env.PG_BIN), `${command}${process.platform === 'win32' ? '.exe' : ''}`) : command;
    const child = spawn(executable, args, { env, shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString()}`.slice(-10000); });
    child.once('error', error => reject(new Error(`无法运行 ${command}：${error.message}。请安装 PostgreSQL 17 客户端并设置 PG_BIN。`)));
    child.once('exit', code => code === 0 ? complete() : reject(new Error(`${command} 失败（exit ${code}）：${stderr.replaceAll(env.PGPASSWORD || '\0', '[REDACTED]')}`)));
  });
}
export function childPath(parent: string, child: string) {
  if (!child || isAbsolute(child)) throw new Error('备份相对路径无效');
  const resolved = resolve(parent, child), part = relative(resolve(parent), resolved);
  if (!part || part.startsWith(`..${sep}`) || part === '..' || isAbsolute(part)) throw new Error('备份路径越界');
  return resolved;
}
export function explicitDirectory(value: string | undefined, argument: string) {
  if (!value || !isAbsolute(value)) throw new Error(`${argument} 必须是显式的绝对目录`);
  const directory = resolve(value);
  if (directory === resolve(directory, '..') || basename(directory).length < 3) throw new Error(`${argument} 不能是文件系统根目录或宽泛路径`);
  return directory;
}
export async function exists(path: string) { try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
export async function sha256(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export async function plainFile(path: string) { const metadata = await lstat(path); if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`只允许普通文件：${basename(path)}`); return metadata; }
export async function fingerprints(client: SqlClient) {
  const counted = await client.query(`SELECT
    (SELECT count(*)::int FROM users) AS users,
    (SELECT count(*)::int FROM fish) AS fish,
    (SELECT count(*)::int FROM inventory) AS inventory,
    (SELECT count(*)::int FROM uploads) AS uploads,
    (SELECT count(*)::int FROM guilds) AS guilds,
    (SELECT count(*)::int FROM guild_members) AS guild_members,
    (SELECT count(*)::int FROM guild_assets) AS guild_assets,
    (SELECT count(*)::int FROM ledger_transactions) AS ledger_transactions,
    (SELECT count(*)::int FROM ledger_entries) AS ledger_entries,
    (SELECT count(*)::int FROM wallet_holds) AS wallet_holds,
    (SELECT count(*)::int FROM match_results) AS match_results,
    (SELECT count(*)::int FROM guild_season_stats) AS guild_season_stats,
    (SELECT COALESCE(sum(balance),0)::text FROM wallets) AS all_wallet_balance,
    (SELECT COALESCE(sum(held),0)::text FROM wallets) AS held_total,
    (SELECT md5(COALESCE(string_agg(id||':'||balance||':'||held,',' ORDER BY id),'')) FROM wallets) AS wallet_fingerprint,
    (SELECT md5(COALESCE(string_agg(id::text||':'||storage_key||':'||status,',' ORDER BY id),'')) FROM uploads) AS upload_fingerprint`);
  return counted.rows[0] as Record<string, string | number>;
}
export async function reconciliation(client: SqlClient) {
  const result = await client.query(`SELECT
    (SELECT count(*)::int FROM (SELECT transaction_id FROM ledger_entries GROUP BY transaction_id HAVING sum(amount)<>0) q) AS unbalanced_ledger,
    (SELECT count(*)::int FROM (SELECT w.id FROM wallets w LEFT JOIN wallet_holds h ON h.wallet_id=w.id AND h.status='HELD' WHERE w.owner_kind='PERSONAL' GROUP BY w.id,w.held HAVING w.held<>COALESCE(sum(h.amount),0)) q) AS hold_mismatch,
    (SELECT count(*)::int FROM wallet_holds h JOIN matches m ON m.id=h.match_id WHERE h.status='HELD' AND m.status IN ('FINISHED','ABORTED')) AS finished_holds,
    (SELECT count(*)::int FROM daily_counters WHERE used<0 OR reserved<0 OR used+reserved>limit_value) AS invalid_quotas,
    (SELECT count(*)::int FROM wallets WHERE owner_kind<>'SYSTEM' AND (balance<held OR held<0)) AS invalid_wallets,
    (SELECT count(*)::int FROM (SELECT guild_id FROM guild_members GROUP BY guild_id HAVING count(*)>8) q) AS overflowing_guilds`);
  const values = result.rows[0] as Record<string, number>;
  if (Object.values(values).some(value => value !== 0)) throw new Error(`账目一致性检查未通过：${JSON.stringify(values)}`);
  return values;
}
export interface BackupManifest {
  formatVersion: 1; backupId: string; createdAt: string; consistentWriteLock: 739281;
  database: { name: string; version: string; dumpFile: string; sha256: string };
  fingerprints: Record<string, string | number>; reconciliation: Record<string, number>;
  uploads: Array<{ file: string; storageKey: string; bytes: number; sha256: string }>;
}
export async function readManifest(directory: string): Promise<BackupManifest> {
  const raw = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as BackupManifest;
  if (raw.formatVersion !== 1 || raw.consistentWriteLock !== 739281 || !Array.isArray(raw.uploads) || !/^[a-f0-9]{64}$/.test(raw.database?.sha256 ?? '')) throw new Error('备份 manifest 格式不受支持');
  const files = new Set<string>();
  for (const upload of raw.uploads) {
    if (!upload.storageKey || basename(upload.storageKey) !== upload.storageKey || !/^[a-f0-9]{64}$/.test(upload.sha256) || files.has(upload.file)) throw new Error('备份上传文件清单无效');
    childPath(directory, upload.file); files.add(upload.file);
  }
  await plainFile(childPath(directory, raw.database.dumpFile));
  return raw;
}
export async function ensureEmptyDirectory(directory: string) {
  if (await exists(directory)) {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (await readdir(directory)).length) throw new Error('目标上传目录必须不存在或为普通空目录');
  }
}
