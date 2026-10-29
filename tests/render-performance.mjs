/* global window, document */
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
const origin = process.argv[2] ?? 'http://127.0.0.1:5173';
const mode = process.env.AQUARIUM_RENDERER_MODE ?? 'software';
const channel = process.env.AQUARIUM_ASSET_BROWSER ?? 'msedge';
const args = mode === 'software' ? ['--use-angle=swiftshader', '--enable-webgl', '--enable-unsafe-swiftshader'] : mode === 'd3d11' ? ['--use-angle=d3d11', '--enable-webgl'] : ['--enable-webgl'];
const browser = await chromium.launch({ channel, headless: true, args });
const result = { browser: await browser.version(), channel, mode, launchArgs: args, scope: 'M1 local six-fish preview, not 30-user production performance', viewport: { width: 1280, height: 720, dpr: 2 }, adapter: null, errors: [], records: [], assertionFailures: [], cleanup: null, failure: null };
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
  page.on('pageerror', error => result.errors.push(error.message));
  await page.goto(`${origin}/?preview=1&qa=1`);
  await page.waitForFunction(() => !!window.__aquarium?.getStats, undefined, { timeout: 20000 });
  result.adapter = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!gl) return { renderer: 'unavailable' };
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    return { renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), vendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR), version: gl.getParameter(gl.VERSION) };
  });
  for (const { quality, profile } of [{ quality: 'normal', profile: 'full-ui' }, { quality: 'normal', profile: 'canvas-only' }, { quality: 'low', profile: 'canvas-only' }]) {
    await page.evaluate(({ quality, profile }) => {
      window.__aquarium.setQuality(quality);
      document.getElementById('qa-hide-dom')?.remove();
      if (profile === 'canvas-only') { const style = document.createElement('style'); style.id = 'qa-hide-dom'; style.textContent = '.game-shell > :not(.aquarium-host){visibility:hidden!important}'; document.head.appendChild(style); }
    }, { quality, profile });
    await page.waitForTimeout(1200); await page.evaluate(() => window.__aquarium.resetStats()); await page.waitForTimeout(4000);
    const stats = await page.evaluate(() => window.__aquarium.getStats());
    const before = await page.evaluate(() => window.__aquarium.getDebugState().fish.find(f => f.id === 'preview-0'));
    const startedAt = Date.now(); await page.keyboard.down('KeyD'); await page.waitForTimeout(700); await page.keyboard.up('KeyD'); await page.waitForTimeout(120);
    const after = await page.evaluate(() => window.__aquarium.getDebugState().fish.find(f => f.id === 'preview-0'));
    const elapsedMs = Date.now() - startedAt, movement = after.simulatedX - before.simulatedX, renderedMovement = after.x - before.x;
    result.records.push({ quality, profile, stats, movement, renderedMovement, elapsedMs });
    if (movement < 60 || movement > elapsedMs / 1000 * 180 + 40 || stats.tickerCount !== 1 || stats.frameSamples > 600 || stats.resolution > (quality === 'low' ? 1.5 : 2)) result.assertionFailures.push(`Quality/physics assertion failed: ${JSON.stringify(result.records.at(-1))}`);
  }
  result.cleanup = await page.evaluate(() => { window.__aquarium.destroy(); return window.__aquarium.getStats(); });
  if (result.cleanup.tickerCount !== 0 || result.cleanup.entityCount !== 0) throw new Error('Renderer cleanup assertion failed');
  if (result.errors.length) throw new Error(result.errors.join('\n'));
  if (result.assertionFailures.length) throw new Error(result.assertionFailures.join('\n'));
} catch (error) { result.failure = error.stack ?? error.message; }
finally {
  await mkdir('artifacts/rendering', { recursive: true });
  await writeFile(`artifacts/rendering/performance-${channel}-${mode}.json`, JSON.stringify(result, null, 2)); await browser.close();
}
console.log(JSON.stringify(result, null, 2)); if (result.failure) process.exitCode = 1;
