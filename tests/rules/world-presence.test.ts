import { describe, expect, it } from 'vitest';
import { config } from '../../packages/game-core/src/index';
import type { Appearance, FishSnapshot, SelfView } from '../../packages/protocol/src/index';
import { World, type ConnectionRuntime, type PlayerRuntime } from '../../apps/server/src/simulation/world';

const appearance: Appearance = {
  presetId: 'goldfish', bodyColor: '#ffb84c', finColor: '#4c9cec', patternId: 'none', skinAssetId: null, equipped: {}, version: 1,
};

function player(userId: string, roomId: string, disconnectedAt: number | null): PlayerRuntime {
  const self: SelfView = {
    userId, role: 'MEMBER', fishId: `fish-${userId}`, nickname: userId, totalXp: 0, level: 1, appearance,
    wallet: { basePower: 100, powerBalance: 100, heldPower: 0, availablePower: 100, totalPower: 200, highestPower: 200, version: 1 },
    guildId: null, currentMatchId: null, businessDate: '2026-10-29', daily: { xpMinted: 0, powerMinted: 0, feedUsed: 0, formalUsed: 0, formalReserved: 0 },
  };
  const fish: FishSnapshot = {
    id: self.fishId!, nickname: userId, position: { x: 400, y: 300 }, velocity: { x: 0, y: 0 }, facing: 'right', angle: 0,
    appearance, level: 1, displaySize: 1, guildId: null, team: null, animation: 'idle', interactive: disconnectedAt === null,
    followGroupId: null, hp: null, maxHp: null, shieldUntilServerMs: 0, respawnAtServerMs: null,
  };
  return {
    self, fish, roomId, controlSocketId: null, leaseUntil: 0, input: { kind: 'idle' }, lastInputAt: 0, lastActivityAt: 0,
    pageVisible: true, ackInputSeq: 0, ackActionSeq: 0, stamina: 100, dashUntil: 0, dashReadyAt: 0, shieldReadyAt: 0,
    shieldUntil: 0, dashDirection: { x: 1, y: 0 }, animationUntil: 0, disconnectedAt, follow: { enabled: false, since: 0 },
  };
}

function observer(userId: string): ConnectionRuntime {
  return {
    userId, socket: { connected: true } as ConnectionRuntime['socket'], sceneEpoch: `scene-${userId}`,
    lastInputAt: 0, inputCount: 0, rateWindow: 0, lastEmote: 0,
  };
}

describe('公共缸运行时维护', () => {
  it('保留仍有观察连接的玩家，并在宽限后释放真正空闲的分缸', () => {
    const world = new World({} as ConstructorParameters<typeof World>[0]);
    world.roomEpochs.set('tank:2', 'room-two');
    const now = 100_000;
    for (let index = 0; index < 14; index++) world.players.set(`idle-${index}`, player(`idle-${index}`, 'tank:2', now - index));
    world.players.set('observer', player('observer', 'tank:2', now - 100));
    world.connections.set('observer-socket', observer('observer'));

    world.maintainPresence(now);

    expect(world.players.has('observer')).toBe(true);
    expect([...world.players.values()].filter(value => value.roomId === 'tank:2')).toHaveLength(config.tank.maxIdleDisplays + 1);
    expect(world.emptyRoomSince.has('tank:2')).toBe(false);

    world.connections.clear();
    world.maintainPresence(now + 1);
    world.maintainPresence(now + 2 + config.tank.emptyRoomRetentionSeconds * 1000);

    expect(world.roomEpochs.has('tank:2')).toBe(false);
    expect([...world.players.values()].some(value => value.roomId === 'tank:2')).toBe(false);
  });

  it('复用空缺的分缸编号时不会覆盖仍存在的更高编号房间', () => {
    const world = new World({} as ConstructorParameters<typeof World>[0]);
    world.roomEpochs.set('tank:3', 'room-three');
    for (let index = 0; index < config.tank.maxOnlinePlayers; index++) {
      world.players.set(`one-${index}`, player(`one-${index}`, 'tank:1', null));
      world.players.set(`three-${index}`, player(`three-${index}`, 'tank:3', null));
    }
    const roomFor = (world as unknown as { tankRoomFor(guildId: string | null): string }).tankRoomFor.bind(world);

    expect(roomFor(null)).toBe('tank:2');
    expect(world.roomEpochs.get('tank:3')).toBe('room-three');
    expect(world.roomEpochs.has('tank:2')).toBe(true);
  });
});
