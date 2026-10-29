import { expect, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { ApiResult, Appearance, SelfView } from '../../packages/protocol/src/types';

export interface DebugFish { id: string; x: number; y: number; preset: string }
export interface DebugState { fish: DebugFish[]; input: { kind: string }; preview: boolean }
export interface AquariumDebug { getDebugState(): DebugState }
declare global { interface Window { __aquarium?: AquariumDebug } }
export const WEB_URL = process.env.AQUARIUM_WEB_URL ?? 'http://127.0.0.1:5173';
export const API_URL = process.env.AQUARIUM_API_URL ?? 'http://127.0.0.1:3000';
export async function debugState(page: Page): Promise<DebugState> {
  return page.evaluate(() => {
    if (!window.__aquarium) throw new Error('开发QA入口未就绪');
    return window.__aquarium.getDebugState();
  });
}
export async function ownFish(page: Page, id = 'preview-0'): Promise<DebugFish> {
  const fish = (await debugState(page)).fish.find(f => f.id === id);
  if (!fish) throw new Error(`场景缺少自己的鱼 ${id}`);
  return fish;
}
export async function waitForAquarium(page: Page): Promise<void> {
  await page.locator('canvas').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !!window.__aquarium?.getDebugState().fish.length);
}
export const defaultAppearance = (presetId: Appearance['presetId'] = 'goldfish'): Appearance => ({ presetId, bodyColor: '#ffaa45', finColor: '#539bec', patternId: 'none', skinAssetId: null, equipped: {}, version: 1 });
export async function api<T>(context: BrowserContext, path: string, body?: unknown, key = randomUUID()): Promise<T> {
  const response = await context.request.fetch(`${API_URL}/api/v1${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: WEB_URL, 'Idempotency-Key': key },
    data: body,
  });
  const result = await response.json() as ApiResult<T>;
  if ('error' in result) throw new Error(`${response.status()} ${result.error.code}: ${result.error.message} (requestId=${result.requestId}, path=${path})`);
  expect(response.ok(), `${path} HTTP ${response.status()}`).toBe(true);
  return result.data;
}
export async function createGuest(context: BrowserContext, nickname: string, preset: Appearance['presetId'] = 'goldfish'): Promise<SelfView> {
  await api<SelfView>(context, '/auth/guest', {});
  return api<SelfView>(context, '/fish', { nickname, appearance: defaultAppearance(preset) });
}
export async function sessionCookie(context: BrowserContext): Promise<string> {
  return (await context.cookies()).filter(c => c.httpOnly).map(c => `${c.name}=${c.value}`).join('; ');
}

