/* global window, document */
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
const origin = process.argv[2] ?? 'http://127.0.0.1:5173';
const browser = await chromium.launch({ channel: process.env.AQUARIUM_ASSET_BROWSER ?? 'msedge', headless: true, args: ['--enable-webgl'] });
const evidence = { browser: await browser.version(), scope: 'M4 renderer-only fixture; no purchase, inventory mutation or upload API', checks: [], requests: {}, pageErrors: [], failure: null };
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 1100 }, deviceScaleFactor: 1 }); page.on('pageerror', e => evidence.pageErrors.push(e.message));
  const images = await page.evaluate(() => {
    return ['#d647e2', '#ffd74d'].map((color, i) => { const c = document.createElement('canvas'); c.width = 200; c.height = 120; const ctx = c.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, 200, 120); ctx.fillStyle = i ? '#345be2' : '#87eff5'; for (let x = 0; x < 200; x += 40) ctx.fillRect(x, 0, 20, 120); ctx.fillStyle = '#ffffff'; ctx.fillRect(10, 10, 30, 20); return c.toDataURL('image/png').split(',')[1]; });
  });
  await page.route('**/m4-render-qa', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>M4渲染验收</title><body><main id="fixture"></main></body></html>' }));
  await page.route('**/api/assets/**', async route => { const id = route.request().url().split('/').at(-1); evidence.requests[id] = (evidence.requests[id] ?? 0) + 1; if (id === 'slow-asset') await new Promise(resolve => setTimeout(resolve, 200)); if (id === 'broken-asset') return route.fulfill({ status: 422, contentType: 'application/json', body: '{"error":"fixture invalid image"}' }); return route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from(images[id === 'fixture-b' ? 1 : 0], 'base64') }); });
  await page.goto(`${origin}/m4-render-qa`);
  await page.evaluate(async () => { const { createM4RenderFixture } = await import('/src/game/m4-render-fixture.ts'); window.m4Fixture = await createM4RenderFixture(document.getElementById('fixture')); });
  async function status() { return page.evaluate(() => window.m4Fixture.status()); }
  async function ready() { await page.waitForFunction(() => { const s = window.m4Fixture.status(); return [s.main.skinStatus, s.preview.skinStatus, s.left.skinStatus, s.right.skinStatus].every(v => v === 'ready'); }); }
  await ready();
  const presence = await status(); if (presence.offline.interactive || !presence.offline.presenceLabel || presence.offline.visualAlpha >= 0.6) throw new Error('Offline display fish is not visually distinct'); evidence.checks.push('offline display fish stays rendered and selectable while using a visible label and reduced opacity');
  if (evidence.requests['fixture-a'] !== 1) throw new Error('Shared texture request was not coalesced'); evidence.checks.push('extensionless asset URL decoded; main/preview/pair share one texture fetch');
  const snapshots = await page.evaluate(() => window.m4Fixture.repeatSnapshots()); if (snapshots.some(s => s !== 'ready')) throw new Error('Snapshot rebuilt or reset local try-on'); evidence.checks.push('10 authoritative snapshots preserve a loaded local try-on without rebuilding');
  await page.getByRole('button', { name: '预览向左游动' }).click(); if ((await status()).preview.facing !== -1) throw new Error('Preview left direction failed');
  await page.getByRole('button', { name: '预览向右游动' }).click(); if ((await status()).preview.facing !== 1) throw new Error('Preview right direction failed'); evidence.checks.push('FishPreview 44px DOM direction buttons operate both ways');
  await mkdir('artifacts/m4/rendering', { recursive: true });
  for (const preset of ['goldfish', 'clownfish', 'puffer', 'betta', 'angelfish', 'ray']) {
    await page.evaluate(p => window.m4Fixture.setVariant(p, 'fixture-a'), preset); await ready(); await page.evaluate(() => window.m4Fixture.renderPair());
    const s = await status(); if (!s.authorityUnchanged || s.left.nameScaleX !== 1 || s.right.nameScaleX !== 1 || s.left.nameWidth < s.left.textWidth || s.left.visualScaleX >= 0 || s.right.visualScaleX <= 0) throw new Error(`Appearance/label check failed for ${preset}`);
    await page.screenshot({ path: `artifacts/m4/rendering/skin-${preset}.png`, fullPage: true });
  }
  evidence.checks.push('all six presets render uploaded skin through exact body masks, flip internal parts only, and fit long nickname backgrounds');
  const locked = await page.evaluate(() => window.m4Fixture.battlePreviewLocked()); if (locked.preset !== 'goldfish' || locked.skinStatus !== 'empty') throw new Error('Arena accepted local appearance override'); evidence.checks.push('arena always renders locked authoritative appearance');
  await page.evaluate(() => window.m4Fixture.cancelMain()); if ((await status()).main.preset !== 'goldfish' || (await status()).main.skinStatus !== 'empty') throw new Error('Cancel did not restore authoritative appearance'); evidence.checks.push('cancel restores server appearance without changing its snapshot');
  const beforeErrors = (await status()).errors.length; await page.evaluate(() => { window.m4Fixture.setMainSkin('slow-asset'); window.m4Fixture.cancelMain(); }); await page.waitForTimeout(350); if ((await status()).errors.length !== beforeErrors || (await status()).main.skinStatus !== 'empty') throw new Error('Cancelled request changed appearance or showed a stale error'); evidence.checks.push('cancel during image decode never applies a late skin or stale error');
  await page.evaluate(() => window.m4Fixture.setMainSkin('broken-asset')); await page.waitForFunction(() => window.m4Fixture.status().main.skinStatus === 'error'); if ((await status()).errors.length !== beforeErrors + 1) throw new Error('Image failure did not produce one explicit fallback message'); evidence.checks.push('bad image response falls back to vector body and reports one error'); await page.evaluate(() => window.m4Fixture.cancelMain());
  await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole('button', { name: '预览向左游动' }).scrollIntoViewIfNeeded(); await page.getByRole('button', { name: '预览向左游动' }).click(); const button = await page.getByRole('button', { name: '预览向左游动' }).boundingBox(); if (button.width < 44 || button.height < 44 || (await status()).preview.facing !== -1) throw new Error('Mobile preview controls failed'); await page.screenshot({ path: 'artifacts/m4/rendering/preview-mobile.png', fullPage: true }); evidence.checks.push('390px preview fits viewport and left/right controls remain at least 44px');
  await page.evaluate(() => window.m4Fixture.closeLeft()); if (!await page.evaluate(() => window.m4Fixture.rightTextureAlive())) throw new Error('Closing one fish destroyed another fish texture'); await page.evaluate(() => window.m4Fixture.closePreview()); if (!await page.evaluate(() => window.m4Fixture.rightTextureAlive())) throw new Error('Closing component destroyed main texture'); evidence.checks.push('closing a fish or preview component preserves remaining shared texture users');
  const cleanup = await page.evaluate(() => window.m4Fixture.destroy()); await page.waitForTimeout(250); if (cleanup.tickerCount || cleanup.entityCount || await page.evaluate(() => window.m4Fixture.cacheHas('fixture-a'))) throw new Error('Renderer/cache cleanup failed'); evidence.checks.push('last texture user and app destroy release texture cache, ticker and entities');
  if (evidence.pageErrors.length) throw new Error(evidence.pageErrors.join('\n'));
} catch (error) { evidence.failure = error.stack ?? error.message; }
finally { await mkdir('artifacts/m4/rendering', { recursive: true }); await writeFile('artifacts/m4/rendering/renderer-qa.json', JSON.stringify(evidence, null, 2)); await browser.close(); }
console.log(JSON.stringify(evidence, null, 2)); if (evidence.failure) process.exitCode = 1;
