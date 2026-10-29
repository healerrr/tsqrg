import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

const channels = (process.env.AQUARIUM_BROWSER_CHANNELS ?? 'msedge,chrome').split(',').filter(Boolean);
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  expect: { timeout: 8000 },
  outputDir: '../../artifacts/e2e',
  reporter: [['list'], ['json', { outputFile: resolve(process.cwd(), process.env.AQUARIUM_E2E_REPORT ?? 'artifacts/e2e/results.json') }]],
  use: {
    baseURL: process.env.AQUARIUM_WEB_URL ?? 'http://127.0.0.1:5173',
    viewport: { width: 1440, height: 900 },
    headless: true,
    trace: process.env.AQUARIUM_TRACE === '1' ? 'retain-on-failure' : 'off',
    screenshot: 'only-on-failure',
    launchOptions: { args: process.env.AQUARIUM_SOFTWARE_WEBGL === '1' ? ['--use-angle=swiftshader', '--enable-webgl', '--enable-unsafe-swiftshader'] : [] },
  },
  projects: channels.map(channel => ({ name: channel, use: { channel: channel === 'chromium' ? undefined : channel } })),
});
