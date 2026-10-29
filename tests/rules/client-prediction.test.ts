import { describe, expect, it } from 'vitest';
import type { FishSnapshot, InputFrame, SceneSnapshot } from '../../packages/protocol/src/index';
import { MovementPrediction } from '../../apps/web/src/game/prediction';

function snapshot(x = 400): SceneSnapshot {
  const fish: FishSnapshot = { id: 'fish-a', nickname: '小鱼', position: { x, y: 400 }, velocity: { x: 0, y: 0 }, facing: 'right', angle: 0,
    appearance: { presetId: 'goldfish', bodyColor: '#ffaa45', finColor: '#4c9cec', equipped: {}, patternId: 'plain', skinAssetId: null, version: 1 },
    level: 1, displaySize: 1, guildId: null, team: null, animation: 'idle', interactive: true, followGroupId: null,
    hp: null, maxHp: null, shieldUntilServerMs: 0, respawnAtServerMs: null };
  return { protocolVersion: 1, snapshotKind: 'full', rulesVersion: '1.0.0', roomId: 'tank-1', roomEpoch: 'room-epoch', sceneEpoch: 'control-epoch', sceneKind: 'TANK',
    serverTick: 1, serverTimeMs: 0, ackInputSeq: 0, ackActionSeq: 0, controlledFishId: 'fish-a', fish: [fish], food: [], npc: [], pearl: null, match: null,
    ownRuntime: { stamina: 100, dashReadyAtServerMs: 0, shieldReadyAtServerMs: 0 } };
}
function frame(seq: number): InputFrame {
  return { protocolVersion: 1, roomId: 'tank-1', sceneEpoch: 'control-epoch', inputSeq: seq, basedOnServerTick: 1,
    move: { kind: 'direction', direction: { x: 1, y: 0 } }, actions: [], pageVisible: true };
}

describe('客户端运动预测与权威恢复', () => {
  it('从服务器纠正位置重放未确认帧，确认过的输入不会再次移动', () => {
    const p = new MovementPrediction(); p.reconcile(snapshot(), 0);
    p.recordInput(frame(1), 0); p.recordInput(frame(2), 50);
    const correction = snapshot(500); correction.ackInputSeq = 1;
    p.reconcile(correction, 100);
    expect(p.pendingCount).toBe(1);
    expect(p.getState()!.position.x).toBeGreaterThan(500);
    expect(p.getState()!.position.x).toBeLessThan(510);
    expect(correction.fish[0]!.position.x).toBe(500);
    const acknowledged = snapshot(530); acknowledged.ackInputSeq = 2;
    p.reconcile(acknowledged, 150);
    expect(p.pendingCount).toBe(0); expect(p.getState()!.position.x).toBe(530);
  });
  it('不同绘制帧率使用相同30Hz步长与加速，300ms运动距离相同', () => {
    const fast = new MovementPrediction(), slow = new MovementPrediction();
    for (const p of [fast, slow]) { p.reconcile(snapshot(), 0); p.recordInput(frame(1), 0); }
    for (let now = 10; now <= 300; now += 10) fast.advanceTo(now);
    for (let now = 100; now <= 300; now += 100) slow.advanceTo(now);
    expect(fast.getState()!.position.x).toBeCloseTo(slow.getState()!.position.x, 9);
    expect(slow.getState()!.position.x).toBeGreaterThan(430);
  });
  it('控制epoch更换立即丢弃旧输入，旧页面的帧不能进入新场景预测', () => {
    const p = new MovementPrediction(); p.reconcile(snapshot(), 0); p.recordInput(frame(1), 0);
    const replacement = snapshot(900); replacement.sceneEpoch = 'new-control';
    p.reconcile(replacement, 100); p.recordInput(frame(2), 110); p.advanceTo(200);
    expect(p.pendingCount).toBe(0); expect(p.getState()!.position.x).toBe(900);
  });
  it('重复序号不累计，失去控制和过期命令不在恢复时回放', () => {
    const p = new MovementPrediction(); p.reconcile(snapshot(), 0);
    p.recordInput(frame(1), 0); p.recordInput(frame(1), 10); expect(p.pendingCount).toBe(1);
    p.reconcile(snapshot(600), 1000); expect(p.pendingCount).toBe(0); expect(p.getState()!.position.x).toBe(600);
    const observer = snapshot(); observer.controlledFishId = null; p.reconcile(observer, 1100);
    expect(p.getState()).toBeNull(); expect(p.pendingCount).toBe(0);
  });
  it('自己的运动也使用世界边界，不能预测到缸外', () => {
    const p = new MovementPrediction(); p.reconcile(snapshot(1850), 0); p.recordInput(frame(1), 0); p.advanceTo(300);
    expect(p.getState()!.position.x).toBe(1856);
  });
  it('只有服务器确认的冲刺窗口改变预测速度，不预测伤害或资产', () => {
    const s = snapshot(); s.fish[0]!.velocity.x = 540; s.fish[0]!.animation = 'dash'; s.ownRuntime!.dashReadyAtServerMs = 2400;
    const frozen = JSON.stringify(s);
    const p = new MovementPrediction(); p.reconcile(s, 0); p.recordInput(frame(1), 0); p.advanceTo(100);
    expect(p.getState()!.position.x).toBeCloseTo(454, 5); expect(JSON.stringify(s)).toBe(frozen);
  });
});
