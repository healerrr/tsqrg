import { test, expect } from '@playwright/test';
import { debugState, ownFish, waitForAquarium } from './helpers';

test.describe('M1 主缸美术与真实输入', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/?preview=1&qa=1');
    await waitForAquarium(page);
  });
  test('六型独立实体、键盘移动、冲刺与失焦停止', async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const state = await debugState(page);
    expect(state.preview).toBe(true);
    expect(new Set(state.fish.map(f => f.preset))).toEqual(new Set(['goldfish', 'clownfish', 'puffer', 'betta', 'angelfish', 'ray']));
    await expect(page.getByText('本地美术预览', { exact: true }).first()).toBeVisible();
    const before = await ownFish(page);
    const startedAt = Date.now();
    await page.keyboard.down('KeyD');
    await page.waitForTimeout(600);
    await page.keyboard.up('KeyD');
    const moved = await ownFish(page);
    expect(moved.x - before.x).toBeGreaterThan(60);
    expect(moved.x - before.x).toBeLessThan(180 * (Date.now() - startedAt) / 1000 + 30);
    await page.keyboard.press('Space');
    await page.waitForTimeout(170);
    await page.screenshot({ path: info.outputPath('dash.png') });
    await page.keyboard.down('KeyD');
    await page.waitForTimeout(200);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.waitForTimeout(300);
    const stopped = await ownFish(page);
    await page.waitForTimeout(500);
    const afterBlur = await ownFish(page);
    expect(Math.abs(afterBlur.x - stopped.x)).toBeLessThan(5);
    expect((await debugState(page)).input.kind).toBe('idle');
    await page.keyboard.up('KeyD');
    await page.screenshot({ path: info.outputPath('tank-desktop.png') });
    expect(errors).toEqual([]);
  });
  test('界面阻止游戏输入，六鱼型外观可选择', async ({ page }, info) => {
    await page.getByRole('button', { name: '我的鱼', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('heading', { name: '今天，想做哪条鱼？' }).click();
    await page.waitForTimeout(250);
    const before = await ownFish(page);
    await page.keyboard.down('KeyD');
    await page.keyboard.press('Space');
    await page.waitForTimeout(400);
    await page.keyboard.up('KeyD');
    const after = await ownFish(page);
    expect(Math.abs(after.x - before.x)).toBeLessThan(3);
    for (const [label, preset] of [['河豚 耐打', 'puffer'], ['斗鱼 灵活', 'betta'], ['神仙鱼 均衡', 'angelfish'], ['鳐鱼 灵活', 'ray'], ['小丑鱼 均衡', 'clownfish'], ['金鱼 均衡', 'goldfish']]) {
      await page.getByRole('button', { name: label }).click();
      await expect.poll(async () => (await ownFish(page)).preset).toBe(preset);
    }
    await page.screenshot({ path: info.outputPath('fish-selector.png') });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
  for (const viewport of [{ width: 1280, height: 720 }, { width: 844, height: 390 }, { width: 390, height: 844 }]) {
    test(`${viewport.width}×${viewport.height} 控件与点击坐标`, async ({ page }, info) => {
      await page.setViewportSize(viewport);
      await page.waitForTimeout(300);
      const canvas = await page.locator('canvas').boundingBox();
      expect(canvas).not.toBeNull();
      const before = await ownFish(page);
      // The central water area remains a direct pointer target at every aspect ratio.
      await page.mouse.click(viewport.width * 0.40, viewport.height * 0.42);
      await page.waitForTimeout(600);
      const after = await ownFish(page);
      expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeGreaterThan(12);
      await expect(page.getByRole('button', { name: '冲刺', exact: true })).toBeVisible();
      await page.getByRole('button', { name: '冲刺', exact: true }).click();
      await page.getByRole('button', { name: '我的鱼', exact: true }).click();
      const panel = await page.getByRole('dialog').boundingBox();
      expect(panel?.width).toBeLessThanOrEqual(viewport.width);
      await page.screenshot({ path: info.outputPath(`tank-${viewport.width}x${viewport.height}.png`) });
    });
  }
});
