import { readFile, readdir } from 'node:fs/promises';
import { pool } from './db';

export async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(739280)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const files=(await readdir(new URL('./migrations/',import.meta.url))).filter(file=>file.endsWith('.sql')).sort();
    for(const file of files) {
      const version=file.slice(0,-4);
      const exists = await client.query('SELECT 1 FROM schema_migrations WHERE version=$1', [version]);
      if (exists.rowCount)continue;
      await client.query(await readFile(new URL(`./migrations/${file}`, import.meta.url), 'utf8'));
      await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [version]);
      console.log(`已应用迁移：${version}`);
    }
    await client.query('COMMIT');
    console.log('迁移完成');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
if (process.argv[1]?.replaceAll('\\', '/').endsWith('/migrate.ts')) {
  migrate().then(() => pool.end()).catch(error => { console.error(error); process.exitCode = 1; void pool.end(); });
}
