import { describe, expect, it } from 'vitest';
import { config, randomOfflineWander } from '../../packages/game-core/src/index';

describe('离线纯随机巡游', () => {
  it('目标只由随机数产生且位于合法边界，不接收食物或NPC目标', () => {
    const values = [0.5, 0, 0.999, 0.4];
    const plan = randomOfflineWander(1000, () => values.shift()!);
    expect(plan.move.kind).toBe('target');
    if (plan.move.kind !== 'target') throw new Error('expected target');
    const bounds = config.tank.swimBounds, radius = config.tank.playerBodyRadius;
    expect(plan.move.target.x).toBe(bounds.x + radius);
    expect(plan.move.target.y).toBeGreaterThanOrEqual(bounds.y + radius);
    expect(plan.move.target.y).toBeLessThanOrEqual(bounds.y + bounds.height - radius);
    expect(plan.until).toBe(6000);
  });
  it('允许随机停留，不保证每一段都移动或进食', () => {
    const plan = randomOfflineWander(1000, () => 0);
    expect(plan.move).toEqual({ kind: 'idle' });
    expect(plan.until).toBe(1000 + config.tank.offlineRoaming.pauseMinSeconds * 1000);
  });
});
