import { test, expect, type BrowserContext } from '@playwright/test';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { API_URL, WEB_URL, api, createGuest, debugState, ownFish, sessionCookie, waitForAquarium } from './helpers';
import type { ApiResult, InputFrame, SceneSnapshot, SelfView } from '../../packages/protocol/src/types';

const requireWeb = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { io } = requireWeb('socket.io-client') as { io: (...args: any[]) => any };
// Authentication cookies stay in memory; online tests do not persist HTTP traces.
test.use({ trace: 'off' });
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitUntil(condition: () => boolean, message: string, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (!condition()) { if (Date.now() > deadline) throw new Error(message); await pause(30); }
}
async function probe(context: BrowserContext) {
  const instanceId = randomUUID();
  const socket = io(`${API_URL}/game`, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: { Cookie: await sessionCookie(context), Origin: WEB_URL } });
  let snapshot: SceneSnapshot | null = null;
  let controlled = false;
  socket.on('scene:snapshot', (value: SceneSnapshot) => { snapshot = value; });
  socket.on('control:changed', (value: { controlled: boolean }) => { controlled = value.controlled; });
  const ack = <T>(event: string, payload: unknown) => new Promise<T>((resolve, reject) => socket.timeout(8000).emit(event, payload, (error: Error | null, result: ApiResult<T>) => {
    if (error) reject(error);
    else if ('error' in result) reject(new Error(`${result.error.code}: ${result.error.message}`));
    else resolve(result.data);
  }));
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  await ack('session:hello', { protocolVersion: 1, clientInstanceId: instanceId });
  await waitUntil(() => !!snapshot, '没有收到服务器完整快照');
  return { socket, ack, instanceId, state: () => snapshot!, controlled: () => controlled };
}
test.describe('M2 真实联机与控制租约', () => {
  test('两独立浏览器会话互看移动，刷新保留同一条鱼和奖励', async ({ browser }, info) => {
    test.setTimeout(90000);
    const contexts = await Promise.all([browser.newContext({ viewport: { width: 1440, height: 900 } }), browser.newContext({ viewport: { width: 1280, height: 720 } })]);
    try {
      const [a, b] = await Promise.all([createGuest(contexts[0], '联机甲', 'goldfish'), createGuest(contexts[1], '联机乙', 'puffer')]);
      expect(a.userId).not.toBe(b.userId);
      expect(a.fishId).not.toBe(b.fishId);
      expect(a.wallet.powerBalance).toBe(100);
      expect((await contexts[0].cookies()).some(c => c.httpOnly)).toBe(true);
      const pages = await Promise.all(contexts.map(c => c.newPage()));
      await Promise.all(pages.map(p => p.goto(`${WEB_URL}/?qa=1`)));
      await Promise.all(pages.map(waitForAquarium));
      await Promise.all(pages.map(p => p.waitForFunction(() => {
        const session = (window as any).__session;
        return session?.status === 'online' && session.controlled && session.snapshot?.sceneEpoch === session.sceneEpoch;
      })));
      await expect.poll(async () => (await debugState(pages[0])).fish.some(f => f.id === b.fishId)).toBe(true);
      await expect.poll(async () => (await debugState(pages[1])).fish.some(f => f.id === a.fishId)).toBe(true);
      expect((await debugState(pages[0])).preview).toBe(false);
      await pages[0].bringToFront();
      await expect.poll(() => pages[0].evaluate(() => document.visibilityState)).toBe('visible');
      await pages[0].evaluate(() => {
        const data = { frames: [] as any[], snapshots: [] as any[] };
        (window as any).__onlineTest = data;
        const session = (window as any).__session;
        session.onInput((frame: InputFrame) => data.frames.push({ ...frame, clientAt: Date.now() }));
        session.onSnapshot((snapshot: SceneSnapshot) => data.snapshots.push({ serverTick: snapshot.serverTick, at: snapshot.serverTimeMs, epoch: snapshot.sceneEpoch, ack: snapshot.ackInputSeq, fish: snapshot.fish.find(f => f.id === session.me?.fishId)?.position }));
      });
      const before = await ownFish(pages[0], a.fishId!);
      const serverStartX = await pages[0].evaluate(id => (window as any).__session.snapshot.fish.find((f: any) => f.id === id).position.x, a.fishId);
      await pages[0].keyboard.down('KeyD');
      await expect.poll(async () => (await debugState(pages[0])).input.kind).toBe('direction');
      // Verify authoritative displacement, independently of this host's software WebGL speed.
      await expect.poll(() => pages[0].evaluate(({ id, start }) => (window as any).__session.snapshot.fish.find((f: any) => f.id === id).position.x - start, { id: a.fishId, start: serverStartX }), { timeout: 10000 }).toBeGreaterThan(60);
      await pages[0].keyboard.up('KeyD');
      await info.attach('outgoing-input-and-authority', { body: JSON.stringify(await pages[0].evaluate(() => (window as any).__onlineTest)), contentType: 'application/json' });
      await pages[1].bringToFront();
      await expect.poll(async () => {
        const otherView = (await debugState(pages[1])).fish.find(f => f.id === a.fishId)!;
        return otherView.x - before.x;
      }).toBeGreaterThan(50);
      await pages[0].screenshot({ path: info.outputPath('online-context-a.png') });
      await pages[1].screenshot({ path: info.outputPath('online-context-b.png') });
      const beforeRefresh = await api<SelfView>(contexts[0], '/me');
      await pages[0].reload();
      await waitForAquarium(pages[0]);
      const restored = await api<SelfView>(contexts[0], '/me');
      expect(restored.userId).toBe(a.userId);
      expect(restored.fishId).toBe(a.fishId);
      expect(restored.wallet.powerBalance).toBe(beforeRefresh.wallet.powerBalance);
      const recovered = await api<SelfView>(contexts[0], '/auth/guest', {});
      expect(recovered.fishId).toBe(a.fishId);
      expect(recovered.wallet.powerBalance).toBe(restored.wallet.powerBalance);
    } finally { await Promise.all(contexts.map(c => c.close())); }
  });
  test('同账号只有当前租约可控制，旧epoch和重放序号无效', async ({ browser }) => {
    const context = await browser.newContext();
    const probes: Awaited<ReturnType<typeof probe>>[] = [];
    try {
      const me = await createGuest(context, '租约测试');
      const first = await probe(context); probes.push(first);
      await first.ack('control:claim', { clientInstanceId: first.instanceId });
      await waitUntil(() => first.state().controlledFishId === me.fishId, '第一次控制租约未生效');
      const oldEpoch = first.state().sceneEpoch;
      const second = await probe(context); probes.push(second);
      expect(second.state().controlledFishId).toBeNull();
      await second.ack('control:claim', { clientInstanceId: second.instanceId });
      await waitUntil(() => second.state().controlledFishId === me.fishId && first.state().controlledFishId === null, '接管未取消旧连接的控制权');
      expect(second.state().sceneEpoch).not.toBe(oldEpoch);
      const fishPosition = () => second.state().fish.find(f => f.id === me.fishId)!.position;
      const frame = (inputSeq: number, move: InputFrame['move'], epoch = second.state().sceneEpoch): InputFrame => ({ protocolVersion: 1, roomId: second.state().roomId, sceneEpoch: epoch, inputSeq, basedOnServerTick: second.state().serverTick, move, actions: [], pageVisible: true });
      await pause(200);
      const start = { ...fishPosition() };
      // A high sequence cannot bypass the old scene capability or old socket lease.
      for (let i = 0; i < 8; i++) {
        first.socket.emit('input:frame', frame(100 + i, { kind: 'direction', direction: { x: 1, y: 0 } }, oldEpoch));
        second.socket.emit('input:frame', frame(100 + i, { kind: 'direction', direction: { x: 1, y: 0 } }, oldEpoch));
        await pause(50);
      }
      expect(Math.hypot(fishPosition().x - start.x, fishPosition().y - start.y)).toBeLessThan(3);
      let validSeq = 0;
      for (let i = 0; i < 12; i++) {
        second.socket.emit('input:frame', frame(++validSeq, { kind: 'direction', direction: { x: 1, y: 0 } }));
        await pause(50);
      }
      second.socket.emit('input:frame', frame(++validSeq, { kind: 'idle' }));
      await pause(300);
      const moved = { ...fishPosition() };
      expect(moved.x - start.x).toBeGreaterThan(40);
      second.socket.emit('input:frame', frame(1, { kind: 'direction', direction: { x: 1, y: 0 } }));
      await pause(400);
      expect(Math.abs(fishPosition().x - moved.x)).toBeLessThan(3);
      expect(second.state().ackInputSeq).toBe(validSeq);
    } finally { probes.forEach(p => p.socket.disconnect()); await context.close(); }
  });
});
