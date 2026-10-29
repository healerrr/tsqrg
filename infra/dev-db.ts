/** Local development only: a real PostgreSQL 17 cluster without a system service. */
import EmbeddedPostgres from 'embedded-postgres';
import { mkdir, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, unlink } from 'node:fs/promises';

const workspace = resolve(fileURLToPath(new URL('..', import.meta.url)));
const databaseDir = resolve(workspace, '.runtime/postgres');
await mkdir(databaseDir, { recursive: true });
// The upstream Windows binaries use ANSI paths when re-executing initdb.
// NTFS short names keep the user's Chinese workspace name intact on disk.
if (process.platform === 'win32') {
  const run = promisify(execFile);
  const embeddedRequire = createRequire(import.meta.resolve('embedded-postgres'));
  const native = await import(pathToFileURL(embeddedRequire.resolve('@embedded-postgres/windows-x64')).href) as {initdb:string;pg_ctl:string};
  const shortPath = async (path: string, file = false) => {
    const escaped = path.replaceAll("'", "''");
    const {stdout} = await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',`(New-Object -ComObject Scripting.FileSystemObject).${file?'GetFile':'GetFolder'}('${escaped}').ShortPath`],{windowsHide:true});
    const result=stdout.trim();
    if ([...result].some(character=>character.charCodeAt(0)>127)) throw new Error('PostgreSQL Windows需要可用的NTFS短文件名；请用ASCII路径启动数据库');
    return result;
  };
  const initdb=await shortPath(native.initdb,true), pgCtl=await shortPath(native.pg_ctl,true), data=await shortPath(databaseDir);
  let exists=false;try{await access(resolve(databaseDir,'PG_VERSION'));exists=true;}catch{/* initialize */}
  if(!exists){
    const pw=resolve(workspace,'.runtime/init-password.txt');await writeFile(pw,process.env.LOCAL_DB_PASSWORD??'aquarium_dev');
    try { const result=await run(initdb,[`--pgdata=${data}`,'--auth=scram-sha-256','--username=aquarium',`--pwfile=${await shortPath(pw,true)}`,'--encoding=UTF8','--locale=C'],{windowsHide:true});process.stdout.write(result.stdout); }
    finally{await unlink(pw);}
  }
  const {Client}=embeddedRequire('pg') as typeof import('pg');
  const connection={host:'127.0.0.1',port:Number(process.env.LOCAL_DB_PORT??55432),user:'aquarium',password:process.env.LOCAL_DB_PASSWORD??'aquarium_dev',database:'postgres',connectionTimeoutMillis:2000};
  const probe=new Client(connection);let running=false;
  try{await probe.connect();running=true;await probe.end();}catch{/* not started */}
  if(!running) await new Promise<void>((resolveStart,rejectStart)=>{
    const child=spawn(pgCtl,['-D',data,'-l',`${data}\\server.log`,'-o',`-h 127.0.0.1 -p ${process.env.LOCAL_DB_PORT??55432}`,'start','-w'],{windowsHide:true,stdio:'ignore'});
    child.once('error',rejectStart);child.once('exit',code=>code===0?resolveStart():rejectStart(new Error(`pg_ctl启动失败：${code}`)));
  });
  const client=new Client(connection);
  await client.connect();const found=await client.query("SELECT 1 FROM pg_database WHERE datname='aquarium'");
  if(!found.rowCount)await client.query('CREATE DATABASE aquarium');await client.end();
  console.log('真实 PostgreSQL 17 已在后台启动：127.0.0.1:55432 / aquarium（仅开发环境）。停止：pg_ctl -D .runtime/postgres stop');
  process.exit(0);
}
const cluster = new EmbeddedPostgres({
  databaseDir,
  user: 'aquarium',
  password: process.env.LOCAL_DB_PASSWORD ?? 'aquarium_dev',
  port: Number(process.env.LOCAL_DB_PORT ?? 55432),
  persistent: true,
  authMethod: 'scram-sha-256',
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
  postgresFlags: ['-h', '127.0.0.1'],
  onLog: (message: string) => process.stdout.write(`${message}\n`),
  onError: (error: unknown) => process.stderr.write(`${String(error)}\n`),
});
let initialized = false;
try { await access(resolve(databaseDir, 'PG_VERSION')); initialized = true; } catch { /* fresh cluster */ }
if (!initialized) await cluster.initialise();
await cluster.start();
const client = cluster.getPgClient();
await client.connect();
const found = await client.query("SELECT 1 FROM pg_database WHERE datname='aquarium'");
await client.end();
if (!found.rowCount) await cluster.createDatabase('aquarium');
console.log('真实 PostgreSQL 17 已启动：127.0.0.1:55432 / aquarium（仅开发环境）');
let closing = false;
async function stop() {
  if (closing) return;
  closing = true;
  await cluster.stop();
  process.exit(0);
}
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
setInterval(() => undefined, 60_000);
