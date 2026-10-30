import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../packages/game-core/src/index';
import type { Appearance, FishSnapshot, SelfView } from '../../packages/protocol/src/index';
import { World, type ConnectionRuntime, type PlayerRuntime } from '../../apps/server/src/simulation/world';
import { saveTankLocations } from '../../apps/server/src/services/presence';

vi.mock('../../apps/server/src/services/presence', () => ({ fishOwners: vi.fn().mockResolvedValue([]), loadTankLocation: vi.fn().mockResolvedValue(null), saveTankLocations: vi.fn().mockResolvedValue(undefined) }));
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

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
  it('离线鱼超出容量后分缸继续托管，只有真正空缸才在宽限后释放', () => {
    const world = new World({} as ConstructorParameters<typeof World>[0]);
    world.roomEpochs.set('tank:2', 'room-two');
    const now = 100_000;
    for (let index = 0; index < 14; index++) world.players.set(`idle-${index}`, player(`idle-${index}`, 'tank:2', now - index));
    world.players.set('observer', player('observer', 'tank:2', now - 100));
    world.connections.set('observer-socket', observer('observer'));

    world.maintainPresence(now);

    expect(world.players.has('observer')).toBe(true);
    expect(world.players.size).toBe(15);
    expect([...world.players.values()].filter(value => value.roomId === 'tank:2').length).toBeLessThanOrEqual(config.tank.maxIdleDisplays);
    expect(world.emptyRoomSince.has('tank:2')).toBe(false);

    world.connections.clear();
    world.maintainPresence(now + 1);
    world.maintainPresence(now + 2 + config.tank.emptyRoomRetentionSeconds * 1000);
    expect(world.roomEpochs.has('tank:2')).toBe(true);
    expect(world.players.size).toBe(15);
    for (const [id, runtime] of world.players) if (runtime.roomId === 'tank:2') world.players.delete(id);
    world.maintainPresence(now + 3 + config.tank.emptyRoomRetentionSeconds * 1000);
    world.maintainPresence(now + 4 + config.tank.emptyRoomRetentionSeconds * 2000);
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

  it('两条已读取档案的连接依次取得最后一个位置时，第二条进入其他分缸', async () => {
    const world = new World({} as ConstructorParameters<typeof World>[0]);
    for (let index = 0; index < config.tank.maxOnlinePlayers - 1; index++) world.players.set(`online-${index}`, player(`online-${index}`, 'tank:1', null));
    const first = player('first', 'tank:1', 1), second = player('second', 'tank:1', 1);
    world.players.set('first', first); world.players.set('second', second);
    for (const runtime of [first, second]) {
      const connection = observer(runtime.self.userId);
      Object.assign(connection.socket, { id: `socket-${runtime.self.userId}`, emit: vi.fn() });
      world.connections.set(connection.socket.id, connection);
      world.claim(connection, runtime);
    }
    await world.flushTankLocations();
    expect(world.roomSize('tank:1')).toBe(config.tank.maxOnlinePlayers);
    expect(second.roomId).not.toBe('tank:1');
    expect(world.roomSize(second.roomId)).toBe(1);
  });

  it('保存偏好指向的分缸在重启后可恢复，但不能突破其在线容量', () => {
    const world = new World({} as ConstructorParameters<typeof World>[0]);
    const roomFor = (world as unknown as { tankRoomFor(guildId: string | null, excludeUserId?: string, preferredRoom?: string): string }).tankRoomFor.bind(world);
    expect(roomFor(null, 'returning', 'tank:7')).toBe('tank:7');
    expect(world.roomEpochs.has('tank:7')).toBe(true);
    for (let index = 0; index < config.tank.maxOnlinePlayers; index++) world.players.set(`seven-${index}`, player(`seven-${index}`, 'tank:7', null));
    expect(roomFor(null, 'returning', 'tank:7')).not.toBe('tank:7');
  });

  it('旧位置仍在写入时产生新位置，等待完成会继续提交最新位置', async () => {
    const world = new World({} as ConstructorParameters<typeof World>[0]);
    let completeFirst!: () => void;
    vi.mocked(saveTankLocations).mockImplementationOnce(() => new Promise<void>(resolve => { completeFirst = resolve; }));
    const runtime = player('moving', 'tank:1', null);
    world.rememberTankLocation(runtime);
    runtime.roomId = 'tank:2'; world.rememberTankLocation(runtime);
    const flushing = world.flushTankLocations(); completeFirst(); await flushing;
    expect(vi.mocked(saveTankLocations).mock.calls.map(([locations]) => locations)).toEqual([[['moving', 'tank:1']], [['moving', 'tank:2']]]);
  });

  it('离线随机游动，观察连接暂停托管；重新接管后不残留随机移动', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const world = new World({} as ConstructorParameters<typeof World>[0]), runtime = player('offline', 'tank:1', 1);
    world.players.set('offline', runtime);
    expect(world.isOfflineRoaming(runtime)).toBe(true);
    world.step(1 / 30); expect(runtime.fish.position.x).toBeGreaterThan(400);
    const connection = observer('offline'); Object.assign(connection.socket, { id: 'returned', emit: vi.fn() });
    world.connections.set('returned', connection);
    expect(world.isOfflineRoaming(runtime)).toBe(false);
    world.claim(connection, runtime);
    const position = { ...runtime.fish.position }; world.step(1 / 30);
    expect(runtime.fish.position).toEqual(position);
    expect(runtime.fish.velocity).toEqual({ x: 0, y: 0 });
    runtime.self.currentMatchId = 'locked-match'; runtime.disconnectedAt = 1; world.connections.clear();
    expect(world.isOfflineRoaming(runtime)).toBe(false);
  });
});
