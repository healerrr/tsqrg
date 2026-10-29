/* global window, document */
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
const origin = process.argv[2] ?? 'http://127.0.0.1:5173';
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-webgl'] });
const records = [], errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1680, height: 1190 }, deviceScaleFactor: 1 }); page.on('pageerror', e => errors.push(e.message));
  await page.route('**/animation-qa', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>六鱼型八状态验收</title><style>body{margin:0;background:#d9f2f3}canvas{display:block}</style><body><main id="gallery"></main></body></html>' }));
  await page.goto(`${origin}/animation-qa`); await mkdir('artifacts/assets', { recursive: true });
  for (const facing of ['left', 'right']) {
    const checks = await page.evaluate(async facing => {
      const { createAnimationGallery } = await import('/src/game/asset-gallery.ts');
      const gallery = await createAnimationGallery(document.getElementById('gallery'), facing); window.animationGallery = gallery; return gallery.checks;
    }, facing);
    if (checks.length !== 54 || checks.some(c => c.labelScaleX !== 1 || c.bubbleScaleX !== 1 || (c.state === 'bubble' && c.countdown !== '3') || (facing === 'left' ? c.visualScaleX >= 0 : c.visualScaleX <= 0))) throw new Error('状态或名字/泡泡朝向断言失败');
    await page.screenshot({ path: `artifacts/assets/six-fish-animation-${facing}.png`, fullPage: true }); records.push(...checks);
    await page.evaluate(() => { window.animationGallery.destroy(); document.getElementById('gallery').replaceChildren(); });
  }
  await writeFile('artifacts/assets/animation-qa.json', JSON.stringify({ browser: await browser.version(), scope: 'snapshot visual fixtures; no combat or economy result is simulated', errors, records }, null, 2));
  if (errors.length) throw new Error(errors.join('\n'));
} finally { await browser.close(); }
console.log('108 fish/state/direction fixtures rendered; nicknames, bubble orientation, respawn count assertions passed.');
