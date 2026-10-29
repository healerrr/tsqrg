import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { SceneSnapshot, SelfView } from '../packages/protocol/src/types';

const requireWeb = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { io } = requireWeb('socket.io-client') as { io: (...args: any[]) => any };
const apiUrl = process.env.AQUARIUM_API_URL ?? 'http://127.0.0.1:3000';
const webOrigin = process.env.AQUARIUM_WEB_URL ?? 'http://127.0.0.1:5173';
const clientCount = Number(process.env.LOAD_CLIENTS ?? 30);
const seconds = Number(process.env.LOAD_SECONDS ?? 15);
if (!Number.isInteger(clientCount) || clientCount < 1 || clientCount > 100 || !Number.isFinite(seconds) || seconds < 3 || seconds > 1800) throw new Error('LOAD_CLIENTS范围1至100，LOAD_SECONDS范围3至1800');
const teamFixture = process.env.LOAD_ALLOW_TEST_FIXTURES === '1';
if (teamFixture && (clientCount < 30 || seconds < 8)) throw new Error('两场团战混合负载要求 LOAD_CLIENTS>=30、LOAD_SECONDS>=8');
const sockets: any[] = [];
const timers: ReturnType<typeof setInterval>[] = [];
let fixturePool: { end(): Promise<void> } | null = null;
const percentile = (values: number[], p: number): number | null => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] : null;
const metrics = async () => {
  const response = await fetch(`${apiUrl}/api/v1/health/ready`);
  if (!response.ok) throw new Error(`服务未就绪 HTTP ${response.status}`);
  return response.json();
};
async function makeGuest(index: number) {
  let cookie = '';
  async function post(path: string, body: unknown) {
    const response = await fetch(`${apiUrl}/api/v1${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: webOrigin, 'Idempotency-Key': randomUUID(), ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
    const setCookie = response.headers.getSetCookie();
    if (setCookie.length) cookie = setCookie.map(c => c.split(';')[0]).join('; ');
    const result = await response.json() as any;
    if (!response.ok || result.error) throw new Error(`${path}: ${result.error?.message ?? response.status}`);
    return result.data as SelfView;
  }
  await post('/auth/guest', {});
  const me = await post('/fish', { nickname: `负载${String(index).padStart(2, '0')}`, appearance: { presetId: ['goldfish', 'clownfish', 'puffer', 'betta', 'angelfish', 'ray'][index % 6], bodyColor: '#ffaa45', finColor: '#539bec', patternId: 'none', skinAssetId: null, equipped: {}, version: 1 } });
  const socket = io(`${apiUrl}/game`, { transports: ['websocket'], extraHeaders: { Cookie: cookie, Origin: webOrigin }, reconnection: false });
  sockets.push(socket);
  let snapshot: SceneSnapshot | null = null;
  let inputSeq = 0, bytes = 0, snapshots = 0, lastAt = 0;
  const gaps: number[] = [];
  let collecting = false;
  socket.on('scene:snapshot', (value: SceneSnapshot) => {
    snapshot = value;
    if (!collecting) return;
    bytes += Buffer.byteLength(JSON.stringify(value));
    snapshots++;
    const now = performance.now();
    if (lastAt) gaps.push(now - lastAt);
    lastAt = now;
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`连接${index}超时`)), 12000);
    socket.on('connect_error', (error: Error) => { clearTimeout(timeout); reject(error); });
    socket.on('connect', () => socket.emit('session:hello', { protocolVersion: 1, clientInstanceId: randomUUID() }, (ack: any) => {
      clearTimeout(timeout);
      if (ack.error) reject(new Error(ack.error.message)); else resolve();
    }));
  });
  const timer = setInterval(() => {
    if (!snapshot || snapshot.controlledFishId !== me.fishId) return;
    const theta = performance.now() / 2500 + index;
    socket.volatile.emit('input:frame', { protocolVersion: 1, roomId: snapshot.roomId, sceneEpoch: snapshot.sceneEpoch, inputSeq: ++inputSeq, basedOnServerTick: snapshot.serverTick, move: { kind: 'direction', direction: { x: Math.cos(theta), y: Math.sin(theta) } }, actions: [], pageVisible: true });
  }, 50);
  timers.push(timer);
  const serverMetrics = async () => {
    const response = await fetch(`${apiUrl}/api/v1/metrics`, { headers: { Cookie: cookie } });
    if (!response.ok) throw new Error(`无法读取服务端性能指标 HTTP ${response.status}`);
    return response.json();
  };
  return { userId: me.userId, fishId: me.fishId, post, serverMetrics, start: () => { collecting = true; }, result: () => ({ snapshots, bytes, kibPerSecond: bytes / 1024 / seconds, snapshotGapP95Ms: percentile(gaps, 0.95), lastRoom: snapshot?.roomId, sceneKind: snapshot?.sceneKind, sawFish: snapshot?.fish.length ?? 0 }) };
}
async function startTwoTeamMatches(clients: Awaited<ReturnType<typeof makeGuest>>[]) {
  const database = await import('../apps/server/src/persistence/db');
  fixturePool = database.pool;
  const guilds = Array.from({ length: 4 }, () => randomUUID());
  await database.tx(async client => {
    for (let group = 0; group < 4; group++) {
      const users = clients.slice(group * 3, group * 3 + 3).map(entry => entry.userId);
      for (const userId of users) await client.query("UPDATE users SET role='MEMBER',employee_ref=$2 WHERE id=$1", [userId, `load-${randomUUID()}`]);
      await client.query('INSERT INTO guilds(id,name,leader_user_id,badge,color,notice) VALUES ($1,$2,$3,$4,$5,$6)', [guilds[group], `压测${String.fromCharCode(65 + group)}${randomUUID().slice(0, 3)}`, users[0], String.fromCharCode(65 + group), ['#21BDE7', '#FF7B88', '#8C79D8', '#52B788'][group], '仅用于显式负载测试']);
      await client.query("INSERT INTO wallets(id,owner_kind,owner_guild_id) VALUES ($1,'GUILD',$2)", [`guild:${guilds[group]}`, guilds[group]]);
      for (let index = 0; index < users.length; index++) await client.query("INSERT INTO guild_members(user_id,guild_id,role) VALUES ($1,$2,$3)", [users[index], guilds[group], index === 0 ? 'LEADER' : 'MEMBER']);
    }
  });
  const matchIds: string[] = [];
  for (const [left, right] of [[0, 1], [2, 3]] as const) {
    const leftClients = clients.slice(left * 3, left * 3 + 3), rightClients = clients.slice(right * 3, right * 3 + 3);
    const invited: any = await leftClients[0]!.post('/matches/invitations', { mode: 'TEAM_FRIENDLY', targetGuildId: guilds[right], roster: leftClients.map(entry => entry.userId) });
    const accepted: any = await rightClients[0]!.post(`/matches/${invited.id}/accept`, { version: invited.version, roster: rightClients.map(entry => entry.userId) });
    for (const participant of [...leftClients, ...rightClients]) await participant.post(`/matches/${invited.id}/ready`, { quoteVersion: accepted.quoteVersion, stake: accepted.stake });
    matchIds.push(invited.id);
  }
  return matchIds;
}
try {
  const before = await metrics();
  console.log(`创建 ${clientCount} 个独立游客和真实 Socket.IO 连接…`);
  const clients = await Promise.all(Array.from({ length: clientCount }, (_, i) => makeGuest(i)));
  const teamMatchIds = teamFixture ? await startTwoTeamMatches(clients) : [];
  const serverBefore = await clients[0].serverMetrics();
  clients.forEach(c => c.start());
  console.log(`已联机，采集 ${seconds} 秒${teamFixture ? '公共主缸与两场3v3' : '公共主缸'}负载。`);
  await new Promise(resolve => setTimeout(resolve, seconds * 1000));
  const after = await metrics();
  const serverAfter = await clients[0].serverMetrics();
  const results = clients.map(c => ({ userId: c.userId, ...c.result() }));
  if (results.some(r => r.snapshots === 0)) throw new Error('部分真实连接没有收到完整快照');
  if (teamFixture && results.filter(result => result.sceneKind === 'TEAM').length < 12) throw new Error('两场团战没有让12个独立连接全部进入TEAM快照');
  const report = { recordedAt: new Date().toISOString(), node: process.version, scene: teamFixture ? 'public-tank-plus-two-team-matches' : 'public-tank-only', clients: clientCount, durationSeconds: seconds, fixtureMode: teamFixture, teamMatchIds, before, after, serverBefore, serverAfter, maxKibPerSecond: Math.max(...results.map(r => r.kibPerSecond)), p95SnapshotGapMs: percentile(results.map(r => r.snapshotGapP95Ms ?? 0), 0.95), results, rendererFps: null, limitations: [...(!teamFixture ? ['未设置 LOAD_ALLOW_TEST_FIXTURES=1，本轮未运行两场团战，不代表OPS01完整通过。'] : []), 'snapshotGap为网络到达间隔，不是服务端tick执行耗时；tickP95Ms来自独立服务端metrics字段。', '脚本不采集浏览器渲染FPS；30分钟内存趋势需配合ops:monitor和浏览器性能记录。'] };
  await mkdir('artifacts/load', { recursive: true });
  const path = `artifacts/load/tank-${Date.now()}.json`;
  await writeFile(path, JSON.stringify(report, null, 2));
  console.log(`公共缸负载完成，报告 ${path}`);
} finally { timers.forEach(clearInterval); sockets.forEach(s => s.disconnect()); if (fixturePool) await fixturePool.end(); }

