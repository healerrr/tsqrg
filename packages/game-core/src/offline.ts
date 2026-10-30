import config from '../../../config/game-balance.v1.json';
import type { MoveIntent } from '@aquarium/protocol';

export interface OfflineWanderPlan { move: MoveIntent; until: number }

/** No food/NPC inputs: a wandering fish cannot choose to chase a reward. */
export function randomOfflineWander(now: number, random: () => number = Math.random): OfflineWanderPlan {
  const settings = config.tank.offlineRoaming;
  if (random() < settings.pauseChance) return { move: { kind: 'idle' }, until: now + (settings.pauseMinSeconds + random() * (settings.pauseMaxSeconds - settings.pauseMinSeconds)) * 1000 };
  const bounds = config.tank.swimBounds, radius = config.tank.playerBodyRadius;
  return {
    move: { kind: 'target', target: { x: bounds.x + radius + random() * (bounds.width - radius * 2), y: bounds.y + radius + random() * (bounds.height - radius * 2) } },
    until: now + (settings.legMinSeconds + random() * (settings.legMaxSeconds - settings.legMinSeconds)) * 1000,
  };
}
