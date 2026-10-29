/* global window, document */
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
const origin = process.argv[2] ?? 'http://127.0.0.1:5173';
const browser = await chromium.launch({ channel: process.env.AQUARIUM_ASSET_BROWSER ?? 'msedge', headless: true, args: ['--use-angle=swiftshader', '--enable-webgl', '--enable-unsafe-swiftshader'] });
try {
const page = await browser.newPage({ viewport: { width: 2080, height: 1190 }, deviceScaleFactor: 1 });
const errors = []; page.on('pageerror', e => errors.push(e.message));
await page.route('**/asset-qa', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>六鱼型配饰验收</title><style>body{margin:0;background:#d9f2f3}canvas{display:block}</style><body><main id="gallery"></main></body></html>' }));
await page.goto(`${origin}/asset-qa`);
const checks = await page.evaluate(async () => {
  const { createAssetGallery } = await import('/src/game/asset-gallery.ts');
  const gallery = await createAssetGallery(document.getElementById('gallery'));
  window.assetGallery = gallery; return gallery.checks;
});
if (checks.length !== 72 || checks.some(c => c.labelScaleX !== 1 || (c.facing === 'left' ? c.visualScaleX >= 0 : c.visualScaleX <= 0))) throw new Error('鱼型、配饰或标签朝向断言失败');
await mkdir('artifacts/assets', { recursive: true });
await page.screenshot({ path: 'artifacts/assets/six-fish-accessories-both-directions.png', fullPage: true });
await writeFile('artifacts/assets/asset-qa.json', JSON.stringify({ browser: await browser.version(), errors, checks }, null, 2));
await page.evaluate(() => window.assetGallery.destroy());
if (errors.length) throw new Error(errors.join('\n'));
} finally { await browser.close(); }
console.log('72 fish/accessory/direction combinations rendered; label direction checks passed. Screenshot requires visual review.');
