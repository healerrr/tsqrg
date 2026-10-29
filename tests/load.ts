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
const sockets: any[] = [];
const timers: ReturnType<typeof setInterval>[] = [];
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
  return { userId: me.userId, fishId: me.fishId, serverMetrics, start: () => { collecting = true; }, result: () => ({ snapshots, bytes, kibPerSecond: bytes / 1024 / seconds, snapshotGapP95Ms: percentile(gaps, 0.95), lastRoom: snapshot?.roomId, sawFish: snapshot?.fish.length ?? 0 }) };
}
try {
  const before = await metrics();
  console.log(`创建 ${clientCount} 个独立游客和真实 Socket.IO 连接…`);
  const clients = await Promise.all(Array.from({ length: clientCount }, (_, i) => makeGuest(i)));
  const serverBefore = await clients[0].serverMetrics();
  clients.forEach(c => c.start());
  console.log(`已联机，采集 ${seconds} 秒公共主缸负载。`);
  await new Promise(resolve => setTimeout(resolve, seconds * 1000));
  const after = await metrics();
  const serverAfter = await clients[0].serverMetrics();
  const results = clients.map(c => ({ userId: c.userId, ...c.result() }));
  if (results.some(r => r.snapshots === 0)) throw new Error('部分真实连接没有收到完整快照');
  const report = { recordedAt: new Date().toISOString(), node: process.version, scene: 'public-tank-only', clients: clientCount, durationSeconds: seconds, before, after, serverBefore, serverAfter, maxKibPerSecond: Math.max(...results.map(r => r.kibPerSecond)), p95SnapshotGapMs: percentile(results.map(r => r.snapshotGapP95Ms ?? 0), 0.95), results, rendererFps: null, limitations: ['本脚本当前仅测公共缸；未同时运行两场团战，不代表OPS01完整通过。', 'snapshotGap为网络到达间隔，不是服务端tick执行耗时；tickP95Ms来自独立服务端metrics字段。', '未采集浏览器FPS和30分钟内存趋势。'] };
  await mkdir('artifacts/load', { recursive: true });
  const path = `artifacts/load/tank-${Date.now()}.json`;
  await writeFile(path, JSON.stringify(report, null, 2));
  console.log(`公共缸负载完成，报告 ${path}`);
} finally { timers.forEach(clearInterval); sockets.forEach(s => s.disconnect()); }

