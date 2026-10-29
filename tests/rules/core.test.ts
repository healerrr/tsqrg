import { describe, expect, it } from 'vitest';
import {
  config, xpForLevel, xpToNext, maxXp, levelFromXp, levelProgress, basePower, displaySize,
  rewardWithinCaps, businessDate, seasonKey, weekStartDate, walletView, quoteStake,
  combatStats, canHunt, isActiveForRewards, stepMovement, segmentCircleTime,
  segmentCircleHit, sweptCircleHit, resolveArenaPosition, moveAgainstObstacles,
  duelWinner, settlementDeltas, guildPoints, pearlPickupCandidate, pickupPearl,
  dropPearl, pearlScore, overtimeHoldWon, damageAfterShield,
  type PearlState,
} from '../../packages/game-core/src/index';
import { inputFrameSchema, appearanceSchema, createFishSchema } from '../../packages/protocol/src/index';

describe('等级和永久成长', () => {
  it('所有累计等级阈值都与逐级经验吻合', () => {
    let cumulative = 0;
    for (let level = 1; level <= 30; level++) {
      expect(xpForLevel(level)).toBe(cumulative);
      expect(levelFromXp(cumulative)).toBe(level);
      if (level > 1) expect(levelFromXp(cumulative - 1)).toBe(level - 1);
      cumulative += xpToNext(level);
    }
    expect(maxXp).toBe(11600);
    expect(levelFromXp(maxXp + 1000)).toBe(30);
  });
  it('基础战力和体型只由等级决定，30级封顶', () => {
    expect(basePower(1)).toBe(100);
    expect(basePower(11)).toBe(300);
    expect(basePower(30)).toBe(680);
    expect(displaySize(1)).toBe(1);
    expect(displaySize(30)).toBe(1.8);
    expect(levelProgress(55)).toEqual({ level: 2, current: 5, required: 75, fraction: 5 / 75 });
    expect(levelProgress(maxXp)).toEqual({ level: 30, current: 0, required: 0, fraction: 1 });
    expect(() => basePower(0)).toThrow();
  });
  it('拒绝浮点、负数、非有限和不安全经验', () => {
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(() => levelFromXp(value)).toThrow();
  });
});

describe('日常奖励和业务日', () => {
  it('ECO02: 295XP/79战力后银鱼仅发5XP/1战力', () => {
    expect(rewardWithinCaps({ totalXp: 1000, xpMinted: 295, powerMinted: 79, requestedXp: 12, requestedPower: 2 })).toMatchObject({ actualXp: 5, actualPower: 1, xpMinted: 300, powerMinted: 80, totalXp: 1005 });
  });
  it('先按剩余额度计算，封顶经验仍可获战力', () => {
    expect(rewardWithinCaps({ totalXp: maxXp - 2, xpMinted: 0, powerMinted: 0, requestedXp: 80, requestedPower: 20 })).toMatchObject({ actualXp: 2, actualPower: 20, totalXp: maxXp, level: 30 });
    expect(rewardWithinCaps({ totalXp: maxXp, xpMinted: 300, powerMinted: 78, requestedXp: 80, requestedPower: 20 })).toMatchObject({ actualXp: 0, actualPower: 2 });
  });
  it('不同奖励源累计永远不越过日上限', () => {
    let counters = { totalXp: 0, xpMinted: 0, powerMinted: 0 };
    for (let i = 0; i < 100; i++) {
      const grant = rewardWithinCaps({ ...counters, requestedXp: i % 2 ? 4 : 18, requestedPower: i % 2 ? 1 : 3 });
      counters = { totalXp: grant.totalXp, xpMinted: grant.xpMinted, powerMinted: grant.powerMinted };
      expect(counters.xpMinted).toBeLessThanOrEqual(300);
      expect(counters.powerMinted).toBeLessThanOrEqual(80);
    }
    expect(counters).toEqual({ totalXp: 300, xpMinted: 300, powerMinted: 80 });
  });
  it('上海零点决定日期、月份与周起点，宿主时区无关', () => {
    expect(businessDate('2026-10-31T15:59:59.999Z')).toBe('2026-10-31');
    expect(businessDate('2026-10-31T16:00:00.000Z')).toBe('2026-11-01');
    expect(seasonKey('2026-10-31T16:00:00Z')).toBe('2026-11');
    expect(weekStartDate('2026-10-25T15:59:59Z')).toBe('2026-10-19');
    expect(weekStartDate('2026-10-25T16:00:00Z')).toBe('2026-10-26');
  });
  it('观察页、隐藏页、离线和120秒后失去收益资格', () => {
    const active = { connected: true, controlled: true, pageVisible: true, lastActivityMs: 1000, nowMs: 121000 };
    expect(isActiveForRewards(active)).toBe(true);
    expect(isActiveForRewards({ ...active, nowMs: 121001 })).toBe(false);
    for (const flag of ['connected', 'controlled', 'pageVisible'] as const) expect(isActiveForRewards({ ...active, [flag]: false })).toBe(false);
  });
  it('只允许捕猎符合体型比例的NPC', () => {
    expect(canHunt(1, 0.55)).toBe(true);
    expect(canHunt(1, 0.7)).toBe(false);
    expect(canHunt(1.8, 0.7)).toBe(true);
    expect(canHunt(0, 0)).toBe(false);
  });
});

describe('钱包和正式赛守恒', () => {
  it('SHOP01: 11级购买120点耳机后不改变基础能力', () => {
    expect(walletView({ level: 11, powerBalance: 280, heldPower: 0 })).toMatchObject({ basePower: 300, totalPower: 580, availablePower: 280 });
    expect(walletView({ level: 11, powerBalance: 150, heldPower: 50 })).toMatchObject({ availablePower: 100, totalPower: 450 });
  });
  it('钱包负数、H>C和不安全整数不允许流入UI', () => {
    expect(() => walletView({ level: 1, powerBalance: 1, heldPower: 2 })).toThrow();
    expect(() => walletView({ level: 1, powerBalance: -1, heldPower: 0 })).toThrow();
    expect(() => walletView({ level: 1, powerBalance: Number.MAX_SAFE_INTEGER, heldPower: 0 })).toThrow();
  });
  it('PK01: 600与400报价20，低于20不可正式，上限50', () => {
    expect(quoteStake([600, 400])).toBe(20);
    expect(quoteStake([19, 100])).toBe(0);
    expect(quoteStake([20, 100])).toBe(1);
    expect(quoteStake([100000, 100000])).toBe(50);
    expect(quoteStake([600, 700, 800, 900, 400, 500])).toBe(20);
    expect(() => quoteStake([])).toThrow();
  });
  it('六方胜负转移严格零和，平局全部为零', () => {
    const participants = Array.from({ length: 6 }, (_, i) => ({ userId: `u${i}`, team: (i < 3 ? 'A' : 'B') as 'A' | 'B' }));
    const deltas = settlementDeltas(participants, 'A', 20);
    expect(deltas.map(d => d.deltaPower)).toEqual([20, 20, 20, -20, -20, -20]);
    expect(deltas.reduce((sum, d) => sum + d.deltaPower, 0)).toBe(0);
    expect(settlementDeltas(participants, null, 20).every(d => d.deltaPower === 0)).toBe(true);
    expect(guildPoints('A')).toEqual({ A: 3, B: 0 });
    expect(guildPoints(null)).toEqual({ A: 1, B: 1 });
    expect(() => settlementDeltas([...participants, participants[0]], 'A', 20)).toThrow();
  });
});

describe('权威运动和高速碰撞', () => {
  it('斜向输入归一化，不因方向长度获得加速', () => {
    let state = { position: { x: 0, y: 0 }, velocity: { x: 0, y: 0 } };
    for (let i = 0; i < 60; i++) state = stepMovement(state, { kind: 'direction', direction: { x: 999, y: 999 } }, 1 / 30);
    expect(Math.hypot(state.velocity.x, state.velocity.y)).toBeCloseTo(config.tank.moveSpeed);
    expect(state.position.x).toBeCloseTo(state.position.y);
  });
  it('固定世界单位不受渲染帧率影响', () => {
    const simulate = (hz: number) => {
      let state = { position: { x: 0, y: 0 }, velocity: { x: 180, y: 0 } };
      for (let i = 0; i < hz; i++) state = stepMovement(state, { kind: 'direction', direction: { x: 1, y: 0 } }, 1 / hz);
      return state.position.x;
    };
    expect(simulate(30)).toBeCloseTo(180);
    expect(simulate(120)).toBeCloseTo(180);
  });
  it('抵达目标不越过，idle按减速停止', () => {
    expect(stepMovement({ position: { x: 0, y: 0 }, velocity: { x: 180, y: 0 } }, { kind: 'target', target: { x: 2, y: 0 } }, 1 / 30)).toEqual({ position: { x: 2, y: 0 }, velocity: { x: 0, y: 0 } });
    let state = { position: { x: 0, y: 0 }, velocity: { x: 180, y: 0 } };
    for (let i = 0; i < 10; i++) state = stepMovement(state, { kind: 'idle' }, 1 / 30);
    expect(state.velocity).toEqual({ x: 0, y: 0 });
  });
  it('高速穿过目标也命中，切线与静止重叠同样判定', () => {
    expect(segmentCircleHit({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 0 }, 14)).toBe(true);
    expect(segmentCircleTime({ x: 0, y: 14 }, { x: 100, y: 14 }, { x: 50, y: 0 }, 14)).toBeCloseTo(0.5);
    expect(segmentCircleHit({ x: 50, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 0 }, 14)).toBe(true);
    expect(segmentCircleHit({ x: 0, y: 30 }, { x: 100, y: 30 }, { x: 50, y: 0 }, 14)).toBe(false);
    expect(sweptCircleHit({ x: 0, y: 0 }, { x: 100, y: 0 }, 14, { x: 50, y: -50 }, { x: 50, y: 50 }, 14)).toBe(true);
  });
  it('圆形边界和障碍不把角色留在非法点', () => {
    const arena = { center: { x: 0, y: 0 }, radius: 300, obstacles: [{ x: 100, y: 0, radius: 35 }] };
    expect(resolveArenaPosition({ x: 400, y: 0 }, arena, 14)).toEqual({ x: 286, y: 0 });
    expect(resolveArenaPosition({ x: 100, y: 0 }, arena, 14).x).toBeGreaterThanOrEqual(149);
    const blocked = moveAgainstObstacles({ x: 0, y: 0 }, { x: 200, y: 0 }, arena.obstacles, 14);
    expect(blocked.x).toBeLessThan(52);
  });
});

describe('竞技伤害与珍珠', () => {
  const initial = (): PearlState => ({ position: { x: 800, y: 450 }, carrierFishId: null, oldCarrierFishId: null, oldCarrierBlockedUntilServerMs: 0, heldSinceMs: null, lastScoredAtMs: null });
  const a = { fishId: 'a', team: 'A' as const, position: { x: 800, y: 450 }, hp: 100, protectionUntilMs: 0 };
  const b = { ...a, fishId: 'b', team: 'B' as const };
  it('锁定鱼型特性，等级只提升生命伤害10%', () => {
    expect(combatStats('goldfish', 1)).toMatchObject({ hp: 100, damage: 22, speed: 180, trait: 'BALANCED' });
    expect(combatStats('puffer', 30)).toMatchObject({ hp: 132, damage: 23, speed: 158.4 });
    expect(combatStats('ray', 1)).toMatchObject({ hp: 90, damage: 21 });
    expect(combatStats('ray', 1).speed).toBeCloseTo(201.6);
  });
  it('超时比较生命比例，整数精确交叉比较', () => {
    expect(duelWinner({ hp: 50, maxHp: 100 }, { hp: 60, maxHp: 120 })).toBeNull();
    expect(duelWinner({ hp: 51, maxHp: 100 }, { hp: 60, maxHp: 120 })).toBe('A');
    expect(duelWinner({ hp: 0, maxHp: 100 }, { hp: 1, maxHp: 120 })).toBe('B');
  });
  it('同帧拾珠按距离和ID唯一选择，保护期和死亡不可拾取', () => {
    expect(pearlPickupCandidate(initial(), [b, a], 1000)?.fishId).toBe('a');
    expect(pearlPickupCandidate(initial(), [{ ...a, hp: 0 }, { ...b, protectionUntilMs: 1001 }], 1000)).toBeNull();
    expect(pearlPickupCandidate(pickupPearl(initial(), a, 1000), [b], 1000)).toBeNull();
  });
  it('持有未满整秒不计分、切换持有者重置秒计时', () => {
    let pearl = pickupPearl(initial(), a, 1000);
    expect(pearlScore(pearl, 1999).points).toBe(0);
    const first = pearlScore(pearl, 2500);
    expect(first.points).toBe(1);
    pearl = first.pearl;
    expect(pearlScore(pearl, 2999).points).toBe(0);
    pearl = pickupPearl(dropPearl(pearl, a.position, 3000), b, 3001);
    expect(pearlScore(pearl, 4000).points).toBe(0);
    expect(pearlScore(pearl, 4001).points).toBe(1);
  });
  it('旧持有者掉落后0.5秒不可拾，别人可立即争抢', () => {
    const dropped = dropPearl(pickupPearl(initial(), a, 1000), a.position, 2000);
    expect(pearlPickupCandidate(dropped, [a], 2499)).toBeNull();
    expect(pearlPickupCandidate(dropped, [a], 2500)?.fishId).toBe('a');
    expect(pearlPickupCandidate(dropped, [a, b], 2001)?.fishId).toBe('b');
  });
  it('加时连续5秒才获胜，掉落重置', () => {
    const held = pickupPearl(initial(), a, 1000);
    expect(overtimeHoldWon(held, 5999)).toBe(false);
    expect(overtimeHoldWon(held, 6000)).toBe(true);
    expect(overtimeHoldWon(dropPearl(held, a.position, 5000), 6000)).toBe(false);
  });
  it('护盾挡一次攻击，受伤保护不消耗护盾外的生命', () => {
    expect(damageAfterShield({ damage: 22, shieldUntilMs: 1001, invulnerableUntilMs: 0, nowMs: 1000 })).toEqual({ damage: 0, blocked: true, consumeShield: true });
    expect(damageAfterShield({ damage: 22, shieldUntilMs: 0, invulnerableUntilMs: 1250, nowMs: 1000 })).toEqual({ damage: 0, blocked: true, consumeShield: false });
    expect(damageAfterShield({ damage: 22, shieldUntilMs: 0, invulnerableUntilMs: 1250, nowMs: 1250 })).toEqual({ damage: 22, blocked: false, consumeShield: false });
  });
});

describe('协议运行时边界', () => {
  const appearance = { presetId: 'goldfish', bodyColor: '#FFAA45', finColor: '#AA8CEB', patternId: 'none', skinAssetId: null, equipped: {}, version: 1 };
  const frame = { protocolVersion: 1, roomId: 'tank-1', sceneEpoch: 'epoch-1', inputSeq: 1, basedOnServerTick: 10, move: { kind: 'idle' }, actions: [], pageVisible: true };
  it('拒绝NaN、Infinity、旧协议和客户端自报坐标/收益字段', () => {
    expect(inputFrameSchema.safeParse(frame).success).toBe(true);
    for (const invalid of [{ ...frame, inputSeq: -1 }, { ...frame, protocolVersion: 2 }, { ...frame, move: { kind: 'target', target: { x: Infinity, y: 1 } } }, { ...frame, position: { x: 1, y: 1 } }, { ...frame, powerBalance: 999 }]) expect(inputFrameSchema.safeParse(invalid).success).toBe(false);
  });
  it('仅允许六鱼型、合法配色和已知外观槽', () => {
    expect(appearanceSchema.safeParse(appearance).success).toBe(true);
    expect(appearanceSchema.safeParse({ ...appearance, bodyColor: 'url(https://example.com)' }).success).toBe(false);
    expect(appearanceSchema.safeParse({ ...appearance, equipped: { damage: '999' } }).success).toBe(false);
    expect(createFishSchema.safeParse({ nickname: '小鱼', appearance }).success).toBe(true);
    expect(createFishSchema.safeParse({ nickname: '\u0001鱼', appearance }).success).toBe(false);
  });
});
