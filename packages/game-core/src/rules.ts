import config from '../../../config/game-balance.v1.json';
import type { PresetId, Trait, WalletView } from '@aquarium/protocol';

export const RULES_VERSION = config.rulesVersion;
export const MAX_SAFE_BALANCE = Number.MAX_SAFE_INTEGER;
export function nonnegativeInteger(value: number, name = '数值'): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name}必须为非负安全整数`);
  return value;
}
export function validLevel(level: number): number {
  if (!Number.isInteger(level) || level < 1 || level > config.fish.maxLevel) throw new RangeError('等级无效');
  return level;
}
/** Cumulative XP needed to enter a level, rather than XP for a single step. */
export function xpForLevel(level: number): number {
  validLevel(level);
  const steps = level - 1;
  return steps * config.fish.xpToNextBase + config.fish.xpToNextPerLevel * steps * (steps - 1) / 2;
}
export const maxXp = xpForLevel(config.fish.maxLevel);
export const MAX_XP = maxXp;
export function xpToNext(level: number): number {
  validLevel(level);
  return level === config.fish.maxLevel ? 0 : config.fish.xpToNextBase + config.fish.xpToNextPerLevel * (level - 1);
}
export function levelFromXp(totalXp: number): number {
  nonnegativeInteger(totalXp, '经验');
  let level = 1;
  while (level < config.fish.maxLevel && totalXp >= xpForLevel(level + 1)) level++;
  return level;
}
export function levelProgress(totalXp: number): { level: number; current: number; required: number; fraction: number } {
  const level = levelFromXp(totalXp);
  const required = xpToNext(level);
  const current = Math.min(totalXp, maxXp) - xpForLevel(level);
  return { level, current, required, fraction: required ? current / required : 1 };
}
export function basePower(level: number): number {
  validLevel(level);
  return config.fish.basePowerAtLevelOne + config.fish.basePowerPerLevel * (level - 1);
}
export function displaySize(level: number): number {
  validLevel(level);
  return config.fish.tankSizeMin + (config.fish.tankSizeMax - config.fish.tankSizeMin) * (level - 1) / (config.fish.maxLevel - 1);
}
export function walletView(input: { level: number; powerBalance: number; heldPower: number; highestPower?: number; version?: number }): WalletView {
  const { powerBalance, heldPower } = input;
  nonnegativeInteger(powerBalance, '余额');
  nonnegativeInteger(heldPower, '冻结');
  nonnegativeInteger(input.highestPower ?? 0, '历史最高战力');
  nonnegativeInteger(input.version ?? 1, '钱包版本');
  if (powerBalance < heldPower) throw new RangeError('余额不能小于冻结额度');
  const base = basePower(input.level);
  const totalPower = nonnegativeInteger(base + powerBalance, '总战力');
  return { basePower: base, powerBalance, heldPower, availablePower: powerBalance - heldPower, totalPower, highestPower: Math.max(input.highestPower ?? 0, totalPower), version: input.version ?? 1 };
}
export function businessDate(now: number | Date | string = Date.now()): string {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) throw new RangeError('日期无效');
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: config.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const part = (key: string) => parts.find(p => p.type === key)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export function seasonKey(now: number | Date | string = Date.now()): string { return businessDate(now).slice(0, 7); }
export function weekStartDate(now: number | Date | string = Date.now()): string {
  const day = new Date(`${businessDate(now)}T00:00:00+08:00`);
  const localDay = new Date(day.getTime() + 8 * 3600000).getUTCDay();
  return businessDate(day.getTime() - ((localDay + 6) % 7) * 86400000);
}
export interface RewardRequest { totalXp: number; xpMinted: number; powerMinted: number; requestedXp: number; requestedPower: number }
export interface RewardGrant { actualXp: number; actualPower: number; totalXp: number; xpMinted: number; powerMinted: number; level: number }
export function rewardWithinCaps(input: RewardRequest): RewardGrant {
  for (const [key, value] of Object.entries(input)) nonnegativeInteger(value, key);
  const actualXp = Math.max(0, Math.min(input.requestedXp, config.daily.xpMintCap - input.xpMinted, maxXp - input.totalXp));
  const actualPower = Math.max(0, Math.min(input.requestedPower, config.daily.powerMintCap - input.powerMinted));
  const totalXp = Math.min(maxXp, input.totalXp + actualXp);
  return { actualXp, actualPower, totalXp, xpMinted: input.xpMinted + actualXp, powerMinted: input.powerMinted + actualPower, level: levelFromXp(totalXp) };
}
export function quoteStake(availableBalances: readonly number[]): number {
  if (!availableBalances.length) throw new RangeError('押注至少需要一名参赛者');
  for (const balance of availableBalances) nonnegativeInteger(balance, '可用战力');
  const stake = Math.min(config.battle.stakeMax, Math.floor(config.battle.stakeRate * Math.min(...availableBalances)));
  return stake < config.battle.stakeMin ? 0 : stake;
}
export function combatStats(presetId: PresetId, level: number): { trait: Trait; hp: number; maxHp: number; speed: number; damage: number; bodyRadius: number } {
  validLevel(level);
  const trait = config.fish.presets[presetId] as Trait;
  if (!trait) throw new RangeError('鱼型无效');
  const mult = config.battle.traits[trait];
  const factor = 1 + config.battle.maxLevelBonus * (level - 1) / (config.fish.maxLevel - 1);
  const hp = Math.round(config.battle.baseHp * mult.hp * factor);
  return { trait, hp, maxHp: hp, speed: config.battle.moveSpeed * mult.speed, damage: Math.round(config.battle.baseDashDamage * mult.damage * factor), bodyRadius: config.battle.bodyRadius };
}
export function canHunt(playerSize: number, npcRelativeSize: number): boolean {
  return Number.isFinite(playerSize) && Number.isFinite(npcRelativeSize) && playerSize > 0 && npcRelativeSize > 0 && npcRelativeSize <= playerSize * config.tank.maxPreySizeRatio;
}
export function isActiveForRewards(input: { connected: boolean; controlled: boolean; pageVisible: boolean; lastActivityMs: number; nowMs: number }): boolean {
  const elapsed = input.nowMs - input.lastActivityMs;
  return input.connected && input.controlled && input.pageVisible && elapsed >= 0 && elapsed <= config.tank.activeWindowSeconds * 1000;
}
/** Client diagnostic time never participates in accepting skill intents. */
export function isInputTickValid(basedOnServerTick: number, serverTick: number): boolean {
  return Number.isSafeInteger(basedOnServerTick) && Number.isSafeInteger(serverTick) && basedOnServerTick >= 0 && basedOnServerTick >= serverTick - 15 && basedOnServerTick <= serverTick + 2;
}
export const getLevel = levelFromXp;
export const getBasePower = basePower;
export const getDisplaySize = displaySize;
export const calculateStake = quoteStake;
