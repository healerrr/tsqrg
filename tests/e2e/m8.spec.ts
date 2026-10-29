import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { WEB_URL, api, createGuest, waitForAquarium } from './helpers';
import type { SelfView } from '../../packages/protocol/src/types';

const enabled = process.env.M8_SOAK === '1';
const durationSeconds = Number(process.env.M8_SOAK_SECONDS ?? 1800);

async function sceneKind(page: Page) {
  return page.evaluate(() => (window as any).__session?.snapshot?.sceneKind as string | undefined);
}
async function sample(page: Page) {
  return page.evaluate(() => ({
    at: Date.now(),
    heap: (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null,
    debug: (window as any).__aquarium?.getDebugState() ?? null,
    sceneKind: (window as any).__session?.snapshot?.sceneKind ?? null,
    status: (window as any).__session?.status ?? null,
  }));
}
async function duel(a: BrowserContext, b: BrowserContext, pages: [Page, Page], targetUserId: string) {
  const invited = await api<any>(a, '/matches/invitations', { mode: 'DUEL_FRIENDLY', targetUserId });
  const accepted = await api<any>(b, `/matches/${invited.id}/accept`, { version: invited.version });
  await api(a, `/matches/${invited.id}/ready`, { quoteVersion: accepted.quoteVersion, stake: accepted.stake });
  await api(b, `/matches/${invited.id}/ready`, { quoteVersion: accepted.quoteVersion, stake: accepted.stake });
  await expect.poll(() => Promise.all(pages.map(sceneKind)).then(values => values.every(value => value === 'DUEL')), { timeout: 12_000 }).toBe(true);
  await api(b, `/matches/${invited.id}/cancel`, {});
  await expect.poll(() => Promise.all(pages.map(sceneKind)).then(values => values.every(value => value === 'TANK')), { timeout: 12_000 }).toBe(true);
  return invited.id as string;
}

test.describe('M8 浏览器耐久与监听清理', () => {
  test.skip(!enabled, '设置 M8_SOAK=1 后执行真实30分钟场景/面板耐久验证');
  test('双会话反复切换竞技场和面板，ticker与堆内存不持续累积', async ({ browser }, info) => {
    if (!Number.isFinite(durationSeconds) || durationSeconds < 60 || durationSeconds > 7200) throw new Error('M8_SOAK_SECONDS 范围 60—7200');
    test.setTimeout((durationSeconds + 120) * 1000);
    const contexts = await Promise.all([browser.newContext({ viewport: { width: 1280, height: 720 } }), browser.newContext({ viewport: { width: 844, height: 390 } })]);
    const pages: [Page, Page] = [await contexts[0]!.newPage(), await contexts[1]!.newPage()];
    const samples: Array<Awaited<ReturnType<typeof sample>> & { page: number }> = [];
    const matches: string[] = [];
    try {
      const selves = await Promise.all([createGuest(contexts[0]!, `耐久甲${Date.now().toString().slice(-4)}`), createGuest(contexts[1]!, `耐久乙${Date.now().toString().slice(-4)}`)]);
      await Promise.all(pages.map(page => page.goto(`${WEB_URL}/?qa=1`)));
      await Promise.all(pages.map(waitForAquarium));
      await expect.poll(() => Promise.all(pages.map(page => page.evaluate(() => (window as any).__session?.status))).then(values => values.every(value => value === 'online'))).toBe(true);
      matches.push(await duel(contexts[0]!, contexts[1]!, pages, selves[1]!.userId));

      const startedAt = Date.now(), deadline = startedAt + durationSeconds * 1000;
      let nextDuelAt = startedAt + 5 * 60_000, panelIndex = 0;
      const panelNames = ['投喂', '我的鱼', '商城', '鱼群组织', '竞技场'];
      while (Date.now() < deadline) {
        for (let index = 0; index < pages.length; index++) samples.push({ ...(await sample(pages[index]!)), page: index });
        for (const page of pages) {
          const button = page.getByRole('button', { name: panelNames[panelIndex % panelNames.length]!, exact: true });
          if (await button.isVisible()) { await button.click(); await page.waitForTimeout(120); await page.keyboard.press('Escape'); }
        }
        panelIndex++;
        if (Date.now() >= nextDuelAt && Date.now() + 20_000 < deadline) {
          const target = await api<SelfView>(contexts[1]!, '/me');
          matches.push(await duel(contexts[0]!, contexts[1]!, pages, target.userId));
          nextDuelAt += 5 * 60_000;
        }
        await pages[0]!.waitForTimeout(5000);
      }

      const tickerCounts = samples.map(entry => entry.debug?.tickerCount).filter((value): value is number => typeof value === 'number');
      expect(tickerCounts.length).toBeGreaterThan(0);
      expect(Math.max(...tickerCounts)).toBe(1);
      const heaps = samples.map(entry => entry.heap).filter((value): value is number => typeof value === 'number');
      if (heaps.length > 2) expect(heaps.at(-1)!).toBeLessThanOrEqual(heaps[0]! * 1.5 + 64 * 1024 * 1024);
      const output = resolve(info.outputPath('m8-soak-report.json'));
      await mkdir(resolve(output, '..'), { recursive: true });
      await writeFile(output, `${JSON.stringify({ startedAt: new Date(startedAt).toISOString(), finishedAt: new Date().toISOString(), durationSeconds, matches, samples, assertions: { maxTickerCount: Math.max(...tickerCounts), heapSamples: heaps.length } }, null, 2)}\n`);
    } finally {
      await Promise.all(contexts.map(context => context.close().catch(() => undefined)));
    }
  });
});
