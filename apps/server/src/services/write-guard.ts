import { AppError } from '../http/errors';

type PauseSource = 'database' | 'integrity' | 'maintenance';
const pauses = new Map<PauseSource, { message: string; since: string }>();

/** A failed reconciliation never changes balances; it closes asset admission instead. */
export function pauseAssetWrites(source: PauseSource, message: string): void {
  if (!pauses.has(source)) pauses.set(source, { message, since: new Date().toISOString() });
}
export function resumeAssetWrites(source: PauseSource): void { pauses.delete(source); }
export function assetWriteState() {
  return { allowed: pauses.size === 0, reasons: [...pauses].map(([source, detail]) => ({ source, ...detail })) };
}
export function assertAssetWritesAllowed(): void {
  if (pauses.size) throw new AppError('MATCH_STATE_INVALID', '资产操作暂时暂停，正在核对账目或恢复数据库，请稍后重试', 503);
}
