/** Operator-only consistent PostgreSQL + immutable upload backup. Never prunes old backups. */
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client, childPath, databaseUrl, explicitDirectory, fingerprints, options, pgCommand, pgEnv, plainFile, reconciliation, sha256, type BackupManifest } from './ops-common';

const args = options();
if (args.help) {
  console.log('用法：DATABASE_URL=... UPLOAD_DIR=... node --import tsx scripts/backup.ts --out <绝对备份父目录>\n要求 PostgreSQL 17 pg_dump（PG_BIN 可指定目录）。脚本持有全局资产写锁，生成全新目录和 SHA256 manifest，不删除旧备份。');
} else {
  const url = databaseUrl(process.env.DATABASE_URL), outputRoot = explicitDirectory(args.out, '--out');
  const uploadRoot = resolve(process.env.UPLOAD_DIR ?? fileURLToPath(new URL('../.runtime/uploads', import.meta.url)));
  const id = `${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}`;
  const output = join(outputRoot, `aquarium-${id}`), client = new Client({ connectionString: url.href, connectionTimeoutMillis: 15000 });
  let locked = false;
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  await mkdir(output, { mode: 0o700 });
  try {
    await client.connect();
    await client.query("SET lock_timeout='15s'");
    await client.query('SELECT pg_advisory_lock(739281)'); locked = true;
    const version = String((await client.query('SHOW server_version')).rows[0].server_version);
    if (!version.startsWith('17.')) throw new Error('本工具只针对 PostgreSQL 17 备份；请使用相同主版本客户端');
    const invariant = await reconciliation(client), state = await fingerprints(client);
    const references = await client.query('SELECT storage_key FROM uploads ORDER BY storage_key');
    await pgCommand('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--file', join(output, 'database.dump')], pgEnv(url));
    await mkdir(join(output, 'uploads'), { mode: 0o700 });
    const uploads: BackupManifest['uploads'] = [];
    for (const row of references.rows) {
      const storageKey = String(row.storage_key);
      if (basename(storageKey) !== storageKey) throw new Error('数据库包含无效上传存储路径，停止备份');
      const source = childPath(uploadRoot, storageKey), metadata = await plainFile(source), file = `uploads/${storageKey}`;
      await copyFile(source, childPath(output, file));
      uploads.push({ storageKey, file, bytes: metadata.size, sha256: await sha256(childPath(output, file)) });
    }
    const manifest: BackupManifest = { formatVersion: 1, backupId: id, createdAt: new Date().toISOString(), consistentWriteLock: 739281, database: { name: decodeURIComponent(url.pathname.slice(1)), version, dumpFile: 'database.dump', sha256: await sha256(join(output, 'database.dump')) }, fingerprints: state, reconciliation: invariant, uploads };
    await writeFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ backup: output, backupId: id, uploads: uploads.length, consistent: true, note: '保留至少最近七份备份；本脚本未自动清理任何文件。' }, null, 2));
  } catch (error) {
    await writeFile(join(output, 'INCOMPLETE.txt'), '本次备份没有完整成功，不可用于恢复。请保留日志排查后由操作者清理此目录。\n', { flag: 'wx', mode: 0o600 }).catch(() => undefined);
    throw error;
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock(739281)').catch(() => undefined);
    await client.end();
  }
}
