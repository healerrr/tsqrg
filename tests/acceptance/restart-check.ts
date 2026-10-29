import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { API_URL, WEB_URL, api, createGuest, waitForAquarium } from '../e2e/helpers';
import type { SelfView } from '../../packages/protocol/src/types';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const health = async (): Promise<boolean> => { try { return (await fetch(`${API_URL}/api/v1/health/ready`, { signal: AbortSignal.timeout(5000) })).ok; } catch { return false; } };
const browser = await chromium.launch({ channel: process.env.AQUARIUM_BROWSER_CHANNELS?.split(',')[0] ?? 'msedge', headless: true, args: process.env.AQUARIUM_SOFTWARE_WEBGL === '1' ? ['--use-angle=swiftshader', '--enable-webgl', '--enable-unsafe-swiftshader'] : [] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
try {
  const created = await createGuest(context, '重启验证');
  const page = await context.newPage();
  await page.goto(`${WEB_URL}/?qa=1`);
  await waitForAquarium(page);
  const before = await api<SelfView>(context, '/me');
  const instanceBefore = await api<{ instanceId: string; uptimeSeconds: number }>(context, '/metrics');
  if (!instanceBefore.instanceId) throw new Error('服务端metrics缺少实例UUID，无法证明进程实际重启');
  await mkdir('artifacts/m2', { recursive: true });
  const triggerPath = process.env.AQUARIUM_RESTART_MARKER;
  if (triggerPath) await writeFile(triggerPath, JSON.stringify({ requestedAt: new Date().toISOString(), instanceId: instanceBefore.instanceId, testProcessId: process.pid, userId: before.userId, fishId: before.fishId }, null, 2));
  console.log(`RESTART_READY userId=${created.userId} fishId=${created.fishId}；Cookie只在浏览器内存中。现在可重启游戏服务。`);
  let offlineObserved = false, onlineAgain = false;
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    const ready = await health();
    if (!ready) offlineObserved = true;
    if (offlineObserved && ready) { onlineAgain = true; break; }
    await pause(200);
  }
  expect(offlineObserved, '必须实际观察到服务停止').toBe(true);
  expect(onlineAgain, '重启服务必须重新就绪').toBe(true);
  await page.reload();
  await waitForAquarium(page);
  const after = await api<SelfView>(context, '/me');
  const instanceAfter = await api<{ instanceId: string; uptimeSeconds: number }>(context, '/metrics');
  expect(instanceAfter.instanceId, '瞬时health超时不算重启，实例UUID必须改变').not.toBe(instanceBefore.instanceId);
  expect(after.userId).toBe(before.userId);
  expect(after.fishId).toBe(before.fishId);
  expect(after.totalXp).toBe(before.totalXp);
  expect(after.appearance).toEqual(before.appearance);
  expect(after.wallet.powerBalance).toBe(before.wallet.powerBalance);
  expect(after.wallet.heldPower).toBe(before.wallet.heldPower);
  await page.screenshot({ path: 'artifacts/m2/after-server-restart.png' });
  await writeFile('artifacts/m2/server-restart.json', JSON.stringify({ recordedAt: new Date().toISOString(), browser: browser.version(), rulesVersion: '1.0.0', offlineObserved, onlineAgain, instanceBefore, instanceAfter, before, after, secretHandling: 'Cookie仅保留在本次测试浏览器内存；未写入文件', screenshot: 'artifacts/m2/after-server-restart.png' }, null, 2));
  console.log('RESTART_PASSED：服务重启后账号、鱼、经验、外观、余额和冻结一致。');
} finally { await context.close(); await browser.close(); }
