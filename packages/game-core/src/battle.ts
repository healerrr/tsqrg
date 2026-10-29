import config from '../../../config/game-balance.v1.json';
import type { Vec2 } from '@aquarium/protocol';
import { nonnegativeInteger } from './rules';
import { distance } from './geometry';

export type Team = 'A' | 'B';
export function duelWinner(a: { hp: number; maxHp: number }, b: { hp: number; maxHp: number }): Team | null {
  for (const value of [a.hp, a.maxHp, b.hp, b.maxHp]) nonnegativeInteger(value);
  if (a.maxHp === 0 || b.maxHp === 0) throw new RangeError('最大生命必须大于零');
  const left = BigInt(a.hp) * BigInt(b.maxHp);
  const right = BigInt(b.hp) * BigInt(a.maxHp);
  return left === right ? null : left > right ? 'A' : 'B';
}
export function settlementDeltas(participants: readonly { userId: string; team: Team }[], winner: Team | null, stake: number): Array<{ userId: string; deltaPower: number }> {
  nonnegativeInteger(stake, '押注');
  if (new Set(participants.map(p => p.userId)).size !== participants.length) throw new RangeError('参赛者重复');
  const countA = participants.filter(p => p.team === 'A').length;
  const countB = participants.filter(p => p.team === 'B').length;
  if (!countA || countA !== countB) throw new RangeError('双方人数必须相等');
  return participants.map(p => ({ userId: p.userId, deltaPower: winner === null ? 0 : p.team === winner ? stake : -stake }));
}
export function guildPoints(winner: Team | null): { A: number; B: number } {
  if (winner === null) return { A: config.guild.pointsDraw, B: config.guild.pointsDraw };
  return { A: winner === 'A' ? config.guild.pointsWin : config.guild.pointsLoss, B: winner === 'B' ? config.guild.pointsWin : config.guild.pointsLoss };
}
export interface PearlState {
  position: Vec2;
  carrierFishId: string | null;
  oldCarrierFishId: string | null;
  oldCarrierBlockedUntilServerMs: number;
  heldSinceMs: number | null;
  lastScoredAtMs: number | null;
}
export interface PearlCandidate { fishId: string; team: Team; position: Vec2; hp: number; protectionUntilMs: number; active?: boolean }
export function pearlPickupCandidate(pearl: PearlState, candidates: readonly PearlCandidate[], nowMs: number, pickupRadius = config.battle.bodyRadius + 12): PearlCandidate | null {
  if (pearl.carrierFishId) return null;
  return candidates.filter(p => p.hp > 0 && p.active !== false && p.protectionUntilMs <= nowMs && !(p.fishId === pearl.oldCarrierFishId && nowMs < pearl.oldCarrierBlockedUntilServerMs) && distance(p.position, pearl.position) <= pickupRadius)
    .sort((a, b) => distance(a.position, pearl.position) - distance(b.position, pearl.position) || a.fishId.localeCompare(b.fishId))[0] ?? null;
}
export function pickupPearl(pearl: PearlState, candidate: PearlCandidate, nowMs: number): PearlState {
  return { ...pearl, position: { ...candidate.position }, carrierFishId: candidate.fishId, heldSinceMs: nowMs, lastScoredAtMs: nowMs };
}
export function dropPearl(pearl: PearlState, position: Vec2, nowMs: number): PearlState {
  return { ...pearl, position: { ...position }, oldCarrierFishId: pearl.carrierFishId, carrierFishId: null, oldCarrierBlockedUntilServerMs: nowMs + config.battle.pearl.oldCarrierPickupBlockSeconds * 1000, heldSinceMs: null, lastScoredAtMs: null };
}
export function pearlScore(pearl: PearlState, nowMs: number): { pearl: PearlState; points: number } {
  if (!pearl.carrierFishId || pearl.lastScoredAtMs === null || nowMs < pearl.lastScoredAtMs) return { pearl, points: 0 };
  const seconds = Math.floor((nowMs - pearl.lastScoredAtMs) / 1000);
  return { pearl: { ...pearl, lastScoredAtMs: pearl.lastScoredAtMs + seconds * 1000 }, points: seconds * config.battle.pearl.scorePerWholeSecond };
}
export function overtimeHoldWon(pearl: PearlState, nowMs: number): boolean {
  return pearl.carrierFishId !== null && pearl.heldSinceMs !== null && nowMs - pearl.heldSinceMs >= config.battle.pearl.overtimeContinuousHoldSeconds * 1000;
}
export function damageAfterShield(input: { damage: number; shieldUntilMs: number; invulnerableUntilMs: number; nowMs: number }): { damage: number; blocked: boolean; consumeShield: boolean } {
  nonnegativeInteger(input.damage, '伤害');
  if (input.shieldUntilMs > input.nowMs) return { damage: 0, blocked: true, consumeShield: true };
  if (input.invulnerableUntilMs > input.nowMs) return { damage: 0, blocked: true, consumeShield: false };
  return { damage: input.damage, blocked: false, consumeShield: false };
}
