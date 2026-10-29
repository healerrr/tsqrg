/** Restore only into a newly created, explicitly named isolated database. Never drops or overwrites one. */
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Client, childPath, databaseUrl, ensureEmptyDirectory, exists, explicitDirectory, fingerprints, options, pgCommand, pgEnv, plainFile, readManifest, reconciliation, sha256 } from './ops-common';

const args = options();
if (args.help) {
  console.log('用法：RESTORE_ADMIN_URL=postgresql://.../postgres node --import tsx scripts/restore.ts --backup <绝对备份目录> --database aquarium_restore_<唯一后缀> --uploads <全新绝对上传目录>\n仅创建新数据库，不使用 DROP、--clean 或覆盖现库。失败会保留独立目标用于调查。');
} else {
  const source = explicitDirectory(args.backup, '--backup'), uploads = explicitDirectory(args.uploads, '--uploads');
  const name = args.database ?? '';
  if (!/^aquarium_restore_[a-z0-9_]{3,40}$/.test(name)) throw new Error('--database 必须以 aquarium_restore_ 开头并跟随3—40位小写字母/数字/下划线');
  const adminUrl = databaseUrl(process.env.RESTORE_ADMIN_URL, 'RESTORE_ADMIN_URL');
  if (decodeURIComponent(adminUrl.pathname.slice(1)) !== 'postgres') throw new Error('RESTORE_ADMIN_URL 必须指向 postgres 管理库；本工具自己创建独立目标库');
  if (uploads === source || uploads.startsWith(`${source}/`) || uploads.startsWith(`${source}\\`)) throw new Error('恢复上传目录不能位于备份源目录中');
  if (await exists(join(source, 'INCOMPLETE.txt'))) throw new Error('该备份标记为未完整成功，拒绝恢复');
  await ensureEmptyDirectory(uploads);
  const manifest = await readManifest(source), dump = childPath(source, manifest.database.dumpFile);
  if (await sha256(dump) !== manifest.database.sha256) throw new Error('数据库备份 SHA256 不一致');
  for (const upload of manifest.uploads) { const path = childPath(source, upload.file), metadata = await plainFile(path); if (metadata.size !== upload.bytes || await sha256(path) !== upload.sha256) throw new Error(`上传备份校验失败：${upload.storageKey}`); }
  const admin = new Client({ connectionString: adminUrl.href, connectionTimeoutMillis: 15000 });
  const targetUrl = new URL(adminUrl.href); targetUrl.pathname = `/${name}`;
  let target: InstanceType<typeof Client> | undefined;
  try {
    await admin.connect();
    if ((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [name])).rowCount) throw new Error('目标数据库已经存在；请使用新的独立名称，本工具不会覆盖');
    // Validated identifier contains only fixed-prefix ASCII; no user SQL is interpolated.
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
    await pgCommand('pg_restore', ['--no-owner', '--no-privileges', '--exit-on-error', '--dbname', name, dump], pgEnv(targetUrl));
    await mkdir(uploads, { recursive: true, mode: 0o700 });
    for (const upload of manifest.uploads) await copyFile(childPath(source, upload.file), childPath(uploads, upload.storageKey));
    target = new Client({ connectionString: targetUrl.href, connectionTimeoutMillis: 15000 }); await target.connect();
    const restored = await fingerprints(target), invariant = await reconciliation(target);
    if (!isDeepStrictEqual(restored, manifest.fingerprints)) throw new Error('恢复后行数或钱包/上传指纹不一致；保留独立目标调查');
    const report = { restoredAt: new Date().toISOString(), backupId: manifest.backupId, database: name, uploadDirectory: uploads, fingerprints: restored, reconciliation: invariant, matchedBackup: true, next: '在隔离环境设置 DATABASE_URL 与 UPLOAD_DIR，使用新的 SESSION_SECRET 启动游戏；等待旧比赛系统中止恢复完成后检查 readiness。' };
    const reportFile = join(uploads, '..', `${name}-restore-report.json`); await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ database: name, uploads, reportFile, matchedBackup: true }, null, 2));
  } finally { await target?.end(); await admin.end(); }
}
