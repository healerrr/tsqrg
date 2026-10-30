import { randomUUID } from 'node:crypto';
import type { Server, Socket } from 'socket.io';
import { config, displaySize, softSeparation, stepMovement } from '@aquarium/core';
import type { FishSnapshot, InputFrame, MoveIntent, SceneSnapshot, SelfView, Vec2 } from '@aquarium/protocol';
import { claimControlSchema, emoteSchema, followSchema, helloSchema, inputFrameSchema, joinSceneSchema } from '@aquarium/protocol';
import { selfView } from '../services/identity';
import { AppError, assert } from '../http/errors';
import { guildMarkForUser } from '../services/guilds';
import { loadTankLocation, saveTankLocations } from '../services/presence';

export interface PlayerRuntime {
  self: SelfView; fish: FishSnapshot; roomId: string; controlSocketId: string | null;
  leaseUntil: number; input: MoveIntent; lastInputAt: number; lastActivityAt: number;
  pageVisible: boolean; ackInputSeq: number; ackActionSeq: number;
  stamina: number; dashUntil: number; dashReadyAt: number; shieldReadyAt: number;
  shieldUntil: number; dashDirection: Vec2; animationUntil: number; disconnectedAt: number | null;
  follow: { enabled: boolean; leaderFishId?: string; since: number };
}
interface FollowGroupRuntime { guildId: string; roomId: string; leaderFishId: string; rally: Vec2; startedAt: number; missingSince: number | null }
export interface ConnectionRuntime { socket: Socket; userId: string; sceneEpoch: string; lastInputAt: number; inputCount: number; rateWindow: number; lastEmote: number; watchMatchId?: string }
export interface BattleBridge {
  snapshot(player: PlayerRuntime, connection: ConnectionRuntime): SceneSnapshot | null;
  input(player: PlayerRuntime, input: InputFrame): boolean;
  step(now: number, dt: number): void;
  disconnected(userId: string): void;
  join(userId: string, request: { sceneKind: string; watchMatchId?: string }, connection?: ConnectionRuntime): Promise<void>;
  canControl?(userId:string): boolean;
}
export class World {
  players = new Map<string, PlayerRuntime>();
  connections = new Map<string, ConnectionRuntime>();
  roomEpochs = new Map<string, string>([['tank:1', randomUUID()]]);
  serverTick = 0;
  tickTimes: number[] = [];
  battle: BattleBridge | null = null;
  ecosystem: { step(now: number, dt: number): void; snapshot(roomId: string): Pick<SceneSnapshot, 'food'|'npc'> } | null = null;
  followGroups = new Map<string, FollowGroupRuntime>();
  emptyRoomSince = new Map<string, number>();
  private dirtyTankLocations = new Map<string, string>();
  private locationWrite: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  constructor(public io: Server) {}
  start() {
    const dt = 1 / config.network.serverTickHz;
    this.timer = setInterval(() => this.step(dt), 1000 / config.network.serverTickHz);
    this.snapshotTimer = setInterval(() => this.broadcastSnapshots(), 1000 / config.network.snapshotHz);
    this.heartbeatTimer = setInterval(() => this.maintainPresence(), config.network.controlLeaseHeartbeatMs);
  }
  stop() { if (this.timer) clearInterval(this.timer); if (this.snapshotTimer) clearInterval(this.snapshotTimer); if (this.heartbeatTimer) clearInterval(this.heartbeatTimer); }
  maintainPresence(now = Date.now()) {
    void this.flushTankLocations();
    for (const p of this.players.values()) if (p.controlSocketId && this.connections.get(p.controlSocketId)?.socket.connected) p.leaseUntil = now + config.network.controlLeaseTtlMs;
    const connectedUsers = new Set([...this.connections.values()].filter(connection => connection.socket.connected).map(connection => connection.userId));
    for (const roomId of [...this.roomEpochs.keys()]) {
      const idle = [...this.players.entries()].filter(([userId, p]) => p.roomId === roomId && p.disconnectedAt !== null && !p.self.currentMatchId && !connectedUsers.has(userId))
        .sort((a, b) => (b[1].disconnectedAt ?? 0) - (a[1].disconnectedAt ?? 0));
      for (const [userId] of idle.slice(config.tank.maxIdleDisplays)) this.players.delete(userId);

      const hasConnection = [...this.connections.values()].some(connection => connection.socket.connected && this.players.get(connection.userId)?.roomId === roomId);
      if (roomId === 'tank:1' || hasConnection || this.roomSize(roomId) > 0) { this.emptyRoomSince.delete(roomId); continue; }
      const emptySince = this.emptyRoomSince.get(roomId) ?? now;
      this.emptyRoomSince.set(roomId, emptySince);
      if (now - emptySince < config.tank.emptyRoomRetentionSeconds * 1000) continue;
      for (const [userId, player] of this.players) if (player.roomId === roomId && !player.self.currentMatchId && !connectedUsers.has(userId)) this.players.delete(userId);
      if ([...this.players.values()].some(player => player.roomId === roomId)) continue;
      this.roomEpochs.delete(roomId); this.emptyRoomSince.delete(roomId);
      for (const [key, group] of this.followGroups) if (group.roomId === roomId) this.followGroups.delete(key);
    }
  }
  rememberTankLocation(player: PlayerRuntime) {
    if (!/^tank:[1-9]\d{0,8}$/.test(player.roomId)) return;
    this.dirtyTankLocations.set(player.self.userId, player.roomId);
    void this.flushTankLocations();
  }
  async flushTankLocations(): Promise<void> {
    if (this.locationWrite) { await this.locationWrite; return; }
    if (!this.dirtyTankLocations.size) return;
    this.locationWrite = (async () => {
      while (this.dirtyTankLocations.size) {
        const locations = [...this.dirtyTankLocations.entries()];
        try { await saveTankLocations(locations); }
        catch (error) { console.error('分缸偏好保存失败，保留待重试', error); return; }
        for (const [userId, roomId] of locations) if (this.dirtyTankLocations.get(userId) === roomId) this.dirtyTankLocations.delete(userId);
      }
    })().finally(() => { this.locationWrite = null; });
    await this.locationWrite;
  }
  private tankRoomFor(guildId: string | null, excludeUserId?: string, preferredRoom?: string | null): string {
    if (preferredRoom && /^tank:[1-9]\d{0,8}$/.test(preferredRoom) && this.roomSize(preferredRoom) < config.tank.maxOnlinePlayers) {
      if (!this.roomEpochs.has(preferredRoom)) this.roomEpochs.set(preferredRoom, randomUUID());
      return preferredRoom;
    }
    const guildPeer=[...this.players.entries()].find(([userId,p])=>userId!==excludeUserId&&guildId&&p.self.guildId===guildId&&p.roomId.startsWith('tank:')&&this.roomSize(p.roomId)<config.tank.maxOnlinePlayers)?.[1];
    let roomId=guildPeer?.roomId??[...this.roomEpochs.keys()].find(id=>id.startsWith('tank:')&&this.roomSize(id)<config.tank.maxOnlinePlayers);
    if(!roomId){let number=1;while(this.roomEpochs.has(`tank:${number}`))number++;roomId=`tank:${number}`;this.roomEpochs.set(roomId,randomUUID());}
    return roomId;
  }
  tankRoomForReturn(player: PlayerRuntime, preferredRoom: string): string {
    if(preferredRoom.startsWith('tank:')&&this.roomEpochs.has(preferredRoom)&&this.roomSize(preferredRoom)<config.tank.maxOnlinePlayers)return preferredRoom;
    return this.tankRoomFor(player.self.guildId,player.self.userId);
  }
  async refreshPlayer(userId: string): Promise<PlayerRuntime | null> {
    const self = await selfView(userId);
    const guildMark = await guildMarkForUser(userId);
    const preferredRoom = this.players.has(userId) ? null : await loadTankLocation(userId);
    const old = this.players.get(userId);
    if (!self.fishId || !self.appearance) return null;
    if (old) {
      const previousGuildId = old.self.guildId;
      old.self = self;
      if(old.disconnectedAt!==null&&old.roomId.startsWith('tank:')&&this.roomSize(old.roomId)>=config.tank.maxOnlinePlayers){
        old.roomId=this.tankRoomFor(self.guildId,userId);
        old.fish.position={x:400+Math.random()*1000,y:250+Math.random()*450};old.fish.velocity={x:0,y:0};old.input={kind:'idle'};this.disableFollow(old);
      }
      // Persisted profile refreshes must not replace the match's locked appearance or level.
      if(old.roomId.startsWith('tank:')) { old.fish.nickname = self.nickname; old.fish.appearance = self.appearance; old.fish.level = self.level; old.fish.displaySize = displaySize(self.level); old.fish.guildId = self.guildId; old.fish.guildMark = guildMark; }
      if (!self.guildId || self.guildId !== previousGuildId) this.disableFollow(old);
      return old;
    }
    const roomId=this.tankRoomFor(self.guildId,userId,preferredRoom);
    const fish: FishSnapshot = { id: self.fishId, nickname: self.nickname, position: { x: 400 + Math.random()*1000, y: 250 + Math.random()*450 }, velocity: { x: 0, y: 0 }, facing: 'right', angle: 0,
      appearance: self.appearance, level: self.level, displaySize: displaySize(self.level), guildId: self.guildId, guildMark, team: null, animation: 'idle', interactive: true, followGroupId: null, followLeaderFishId: null, hp: null, maxHp: null, shieldUntilServerMs: 0, respawnAtServerMs: null };
    const p: PlayerRuntime = { self, fish, roomId, controlSocketId: null, leaseUntil: 0, input: { kind: 'idle' }, lastInputAt: 0, lastActivityAt: 0, pageVisible: true, ackInputSeq: 0, ackActionSeq: 0,
      stamina: config.tank.staminaMax, dashUntil: 0, dashReadyAt: 0, shieldReadyAt: 0, shieldUntil: 0, dashDirection: { x: 1, y: 0 }, animationUntil: 0, disconnectedAt: Date.now(), follow: { enabled: false, since: 0 } };
    this.players.set(userId, p); return p;
  }
  roomSize(roomId: string) { return [...this.players.values()].filter(p => p.roomId === roomId && p.disconnectedAt === null).length; }
  getConnectionFor(userId: string) { const p = this.players.get(userId); return p?.controlSocketId ? this.connections.get(p.controlSocketId) : undefined; }
  async connect(socket: Socket, userId: string) {
    const c: ConnectionRuntime = { socket, userId, sceneEpoch: randomUUID(), lastInputAt: 0, inputCount: 0, rateWindow: 0, lastEmote: 0 };
    this.connections.set(socket.id, c);
    const respond = (fn: (payload: unknown) => Promise<unknown>) => async (payload: unknown, ack?: (value: unknown)=>void) => {
      try { const data = await fn(payload); ack?.({ data, requestId: randomUUID() }); }
      catch (error) { const e = error instanceof AppError ? error : new AppError('VERSION_CONFLICT', '请求格式无效', 400); ack?.({ error: { code: e.code, message: e.message }, requestId: randomUUID() }); }
    };
    socket.on('session:hello', respond(async raw => {
      const payload = helloSchema.parse(raw);
      assert(payload.protocolVersion === 1, 'PROTOCOL_VERSION_UNSUPPORTED', '游戏版本不兼容，请更新页面');
      const p = await this.refreshPlayer(userId);
      if (p && (!p.controlSocketId || !this.connections.has(p.controlSocketId) || p.leaseUntil <= Date.now())) this.claim(c, p);
      await this.flushTankLocations();
      socket.emit('session:welcome', { protocolVersion: 1, rulesVersion: config.rulesVersion, serverTimeMs: Date.now(), controlledFishId: p?.controlSocketId === socket.id ? p.fish.id : null, sceneEpoch: c.sceneEpoch, recovered: false });
      return { accepted: true };
    }));
    socket.on('control:claim', respond(async raw => { claimControlSchema.parse(raw); const p = await this.refreshPlayer(userId); assert(p, 'FISH_NOT_OWNED', '请先创建自己的鱼'); assert(!c.watchMatchId,'MATCH_STATE_INVALID','请先结束观战返回主缸');this.claim(c, p);await this.flushTankLocations();return { sceneEpoch: c.sceneEpoch, controlledFishId: p.controlSocketId===socket.id?p.fish.id:null }; }));
    socket.on('scene:join', respond(async raw => {
      const payload = joinSceneSchema.parse(raw); const p = this.players.get(userId); assert(p, 'FISH_NOT_OWNED', '请先创建自己的鱼');
      if (payload.sceneKind !== 'TANK' || p.self.currentMatchId || c.watchMatchId) { assert(this.battle, 'MATCH_STATE_INVALID', '当前没有可进入的比赛'); await this.battle.join(userId, payload,c); }
      const roomId=c.watchMatchId?`match:${c.watchMatchId}`:p.roomId;
      assert(!payload.roomId || payload.roomId === roomId, 'FISH_NOT_OWNED', '没有访问该房间的权限', 403);
      c.sceneEpoch = randomUUID();
      if(p.controlSocketId===socket.id) { p.input = { kind: 'idle' }; p.ackInputSeq = 0; p.ackActionSeq = 0; }
      return { roomId, sceneEpoch: c.sceneEpoch };
    }));
    socket.on('input:frame', raw => { const parsed = inputFrameSchema.safeParse(raw); if (parsed.success) this.input(c, parsed.data); });
    socket.on('guild:follow', respond(async raw => {
      const payload = followSchema.parse(raw); const p = this.players.get(userId); assert(p && p.self.guildId, 'MEMBER_REQUIRED', '加入组织后可以一起游');
      assert(p.controlSocketId === socket.id && c.sceneEpoch === payload.sceneEpoch, 'CONTROL_TAKEN', '此页面没有控制权');
      assert(!p.self.currentMatchId, 'MATCH_STATE_INVALID', '比赛期间不能开启群游');
      if (!payload.enabled) {
        const group = this.followGroup(p);
        this.disableFollow(p);
        if (group?.leaderFishId === p.fish.id) group.missingSince = Date.now() - config.guild.leaderDisconnectFallbackSeconds * 1000;
        return { enabled: false, leaderFishId: null };
      }
      const now = Date.now(), key = this.followKey(p)!;
      let selected: PlayerRuntime | undefined;
      if (payload.leaderFishId) selected = [...this.players.values()].find(other => other.fish.id === payload.leaderFishId && other.self.guildId === p.self.guildId && other.roomId === p.roomId && (other === p || other.follow.enabled) && this.followOnline(other));
      assert(!payload.leaderFishId || selected, 'PEER_NOT_ELIGIBLE', '领游成员须在同一鱼缸并已开启一起游');
      const existing = this.followGroups.get(key);
      if (!selected && existing) selected = [...this.players.values()].find(other => other.fish.id === existing.leaderFishId && this.followOnline(other) && other.follow.enabled);
      selected ??= p;
      const group: FollowGroupRuntime = existing ?? { guildId: p.self.guildId, roomId: p.roomId, leaderFishId: selected.fish.id, rally: { ...selected.fish.position }, startedAt: now, missingSince: null };
      group.leaderFishId = selected.fish.id; group.missingSince = null;
      this.followGroups.set(key, group);
      p.follow = { enabled: true, leaderFishId: group.leaderFishId, since: now }; p.fish.followGroupId = p.self.guildId; p.fish.followLeaderFishId = group.leaderFishId; p.lastActivityAt = now;
      for (const member of this.followMembers(group)) { member.follow.leaderFishId = group.leaderFishId; member.fish.followLeaderFishId = group.leaderFishId; }
      return { enabled: true, leaderFishId: group.leaderFishId };
    }));
    socket.on('emote:send', respond(async raw => {
      const payload = emoteSchema.parse(raw); const p = this.players.get(userId); assert(p && p.controlSocketId === socket.id && payload.sceneEpoch === c.sceneEpoch, 'CONTROL_TAKEN', '此页面没有控制权');
      assert(Date.now() - c.lastEmote >= config.network.emoteCooldownMs, 'RATE_LIMITED', '气泡发送太快了', 429); c.lastEmote = Date.now();
      const eventId = randomUUID(); this.sceneEvent(p.roomId, { kind: 'emote', fishId: p.fish.id, emote: payload.emote }, eventId); return { eventId };
    }));
    socket.on('disconnect', () => {
      this.connections.delete(socket.id); const p = this.players.get(userId);
      if (p?.controlSocketId === socket.id) { p.input = { kind: 'idle' }; p.pageVisible = false; p.controlSocketId = null; p.disconnectedAt = Date.now(); this.battle?.disconnected(userId); }
    });
  }
  claim(c: ConnectionRuntime, p: PlayerRuntime) {
    if(this.battle?.canControl?.(p.self.userId)===false) {
      c.sceneEpoch=randomUUID();c.socket.emit('control:changed',{controlled:false,controlledFishId:null,sceneEpoch:c.sceneEpoch});return;
    }
    // Admission is synchronous: profiles may have been loaded concurrently while a seat was still free.
    if (p.disconnectedAt !== null && p.roomId.startsWith('tank:') && this.roomSize(p.roomId) >= config.tank.maxOnlinePlayers) {
      p.roomId = this.tankRoomFor(p.self.guildId, p.self.userId);
      p.input = { kind: 'idle' }; p.fish.velocity = { x: 0, y: 0 }; this.disableFollow(p);
    }
    const previous = p.controlSocketId ? this.connections.get(p.controlSocketId) : null;
    if (previous && previous.socket.id !== c.socket.id) { previous.sceneEpoch = randomUUID(); previous.socket.emit('control:changed', { controlled: false, controlledFishId: null, sceneEpoch: previous.sceneEpoch }); }
    p.controlSocketId = c.socket.id; p.leaseUntil = Date.now()+config.network.controlLeaseTtlMs; p.disconnectedAt = null;
    p.input = { kind: 'idle' }; p.ackInputSeq = 0; p.ackActionSeq = 0; p.pageVisible = true; c.sceneEpoch = randomUUID();
    c.socket.emit('control:changed', { controlled: true, controlledFishId: p.fish.id, sceneEpoch: c.sceneEpoch });
    this.rememberTankLocation(p);
  }
  private followKey(p: PlayerRuntime): string | null { return p.self.guildId ? `${p.self.guildId}:${p.roomId}` : null; }
  private followGroup(p: PlayerRuntime): FollowGroupRuntime | undefined { const key = this.followKey(p); return key ? this.followGroups.get(key) : undefined; }
  private followMembers(group: FollowGroupRuntime): PlayerRuntime[] {
    return [...this.players.values()].filter(player => player.follow.enabled && !player.self.currentMatchId && player.self.guildId === group.guildId && player.roomId === group.roomId);
  }
  private followOnline(player: PlayerRuntime): boolean {
    return player.disconnectedAt === null && !!player.controlSocketId && player.leaseUntil > Date.now() && !!this.connections.get(player.controlSocketId)?.socket.connected;
  }
  private isFollowLeader(player: PlayerRuntime): boolean { return this.followGroup(player)?.leaderFishId === player.fish.id; }
  private disableFollow(player: PlayerRuntime) {
    player.follow = { enabled: false, since: 0 };
    player.fish.followGroupId = null;
    player.fish.followLeaderFishId = null;
  }
  private updateFollowGroups(now: number) {
    for (const [key, group] of this.followGroups) {
      const members = this.followMembers(group);
      if (!members.length) { this.followGroups.delete(key); continue; }
      let leader = members.find(member => member.fish.id === group.leaderFishId);
      if (leader && this.followOnline(leader)) group.missingSince = null;
      else {
        group.missingSince ??= now;
        if (now - group.missingSince >= config.guild.leaderDisconnectFallbackSeconds * 1000) {
          leader = members.filter(member => this.followOnline(member)).sort((a, b) => a.follow.since - b.follow.since || a.fish.id.localeCompare(b.fish.id))[0];
          if (leader) { group.leaderFishId = leader.fish.id; group.rally = { ...leader.fish.position }; group.startedAt = now; group.missingSince = null; }
        }
      }
      for (const member of members) {
        member.follow.leaderFishId = group.leaderFishId;
        member.fish.followGroupId = group.guildId;
        member.fish.followLeaderFishId = group.leaderFishId;
      }
    }
  }
  private followMove(player: PlayerRuntime, now: number): MoveIntent {
    if (!player.follow.enabled || !this.followOnline(player)) return { kind: 'idle' };
    const group = this.followGroup(player); if (!group) return { kind: 'idle' };
    const members = this.followMembers(group);
    const leader = members.find(member => member.fish.id === group.leaderFishId);
    if (!leader || !this.followOnline(leader)) return { kind: 'idle' };
    if (leader === player) {
      if (player.input.kind !== 'idle') return player.input;
      const angle = ((now - group.startedAt) / (config.guild.patrolPeriodSeconds * 1000)) * Math.PI * 2;
      return { kind: 'target', target: { x: group.rally.x + Math.cos(angle) * config.guild.patrolRadius, y: group.rally.y + Math.sin(angle) * config.guild.patrolRadius * 0.55 } };
    }
    const followers = members.filter(member => member !== leader && this.followOnline(member)).sort((a, b) => a.follow.since - b.follow.since || a.fish.id.localeCompare(b.fish.id));
    const index = Math.max(0, followers.indexOf(player)), row = Math.floor(index / 2) + 1, side = index % 2 === 0 ? -1 : 1;
    const speed = Math.hypot(leader.fish.velocity.x, leader.fish.velocity.y);
    const forward = speed > 3 ? { x: leader.fish.velocity.x / speed, y: leader.fish.velocity.y / speed } : { x: leader.fish.facing === 'left' ? -1 : 1, y: 0 };
    const sideVector = { x: -forward.y, y: forward.x };
    const target = {
      x: leader.fish.position.x - forward.x * config.guild.formationRadius * 0.72 * row + sideVector.x * config.guild.separationDistance * 0.65 * side,
      y: leader.fish.position.y - forward.y * config.guild.formationRadius * 0.72 * row + sideVector.y * config.guild.separationDistance * 0.65 * side,
    };
    const separation = softSeparation(player.fish.position, members.filter(member => member !== player).map(member => member.fish.position));
    target.x += separation.x * config.guild.separationDistance * 0.55;
    target.y += separation.y * config.guild.separationDistance * 0.55;
    return { kind: 'target', target };
  }
  private applySeparation(dt: number) {
    const online = [...this.players.values()].filter(player => !player.self.currentMatchId && player.disconnectedAt === null);
    const positions = new Map(online.map(player => [player, { ...player.fish.position }]));
    const bounds = config.tank.swimBounds, radius = config.tank.playerBodyRadius;
    for (const player of online) {
      const others = online.filter(other => other !== player && other.roomId === player.roomId).map(other => positions.get(other)!);
      const offset = softSeparation(positions.get(player)!, others);
      player.fish.position = {
        x: Math.max(bounds.x + radius, Math.min(bounds.x + bounds.width - radius, player.fish.position.x + offset.x * config.guild.separationPushSpeed * dt)),
        y: Math.max(bounds.y + radius, Math.min(bounds.y + bounds.height - radius, player.fish.position.y + offset.y * config.guild.separationPushSpeed * dt)),
      };
    }
  }
  input(c: ConnectionRuntime, frame: InputFrame) {
    const p = this.players.get(c.userId), now = Date.now();
    if (!p || c.watchMatchId || this.battle?.canControl?.(c.userId)===false || p.controlSocketId !== c.socket.id || p.leaseUntil < now || frame.sceneEpoch !== c.sceneEpoch || frame.roomId !== p.roomId || frame.inputSeq <= p.ackInputSeq) return;
    if (frame.basedOnServerTick < this.serverTick-15 || frame.basedOnServerTick > this.serverTick+2) return;
    if (now-c.rateWindow >= 1000) { c.rateWindow = now; c.inputCount = 0; }
    if (++c.inputCount > config.network.maxInputHz) return;
    p.ackInputSeq = frame.inputSeq; p.lastInputAt = now; p.pageVisible = frame.pageVisible; p.input = frame.pageVisible ? frame.move : { kind: 'idle' };
    if (frame.move.kind !== 'idle' && frame.pageVisible) {
      p.lastActivityAt = now;
      if (p.follow.enabled && !this.isFollowLeader(p)) this.disableFollow(p);
    }
    if (this.battle?.input(p, frame)) return;
    for (const action of frame.actions) {
      if (action.actionSeq <= p.ackActionSeq) continue; p.ackActionSeq = action.actionSeq;
      if (!frame.pageVisible) continue;
      if (action.kind === 'dash' && now >= p.dashReadyAt && p.stamina >= config.tank.dashStaminaCost) {
        const d = action.direction ?? (frame.move.kind === 'direction' ? frame.move.direction : frame.move.kind === 'target' ? { x: frame.move.target.x-p.fish.position.x, y: frame.move.target.y-p.fish.position.y } : { x: p.fish.facing === 'left' ? -1 : 1, y: 0 });
        const len = Math.hypot(d.x,d.y) || 1; p.dashDirection = { x: d.x/len, y: d.y/len };
        p.stamina -= config.tank.dashStaminaCost; p.dashReadyAt = now+config.battle.dashCooldownSeconds*1000; p.dashUntil = now+config.battle.dashDurationSeconds*1000; p.lastActivityAt = now;
        this.sceneEvent(p.roomId, { kind: 'dash', fishId: p.fish.id, actionSeq: action.actionSeq, direction: p.dashDirection });
      }
    }
  }
  step(dt: number) {
    const started = performance.now(), now = Date.now(); this.serverTick++;
    this.updateFollowGroups(now);
    this.battle?.step(now, dt);
    for (const p of this.players.values()) {
      if (p.self.currentMatchId || !p.roomId.startsWith('tank:')) continue;
      if (!p.controlSocketId || p.leaseUntil < now || now-p.lastInputAt > 350 || !p.pageVisible) p.input = { kind: 'idle' };
      const dash = now < p.dashUntil;
      const manualMove = p.input.kind !== 'idle';
      const move = dash ? { kind: 'direction' as const, direction: p.dashDirection } : p.follow.enabled ? this.followMove(p, now) : p.input;
      if (dash) p.fish.velocity = { x: p.dashDirection.x*config.battle.dashSpeed, y: p.dashDirection.y*config.battle.dashSpeed };
      const group = this.followGroup(p), leader = group?.leaderFishId === p.fish.id;
      const distanceToTarget = move.kind === 'target' ? Math.hypot(move.target.x - p.fish.position.x, move.target.y - p.fish.position.y) : 0;
      const followSpeed = p.follow.enabled && !leader && distanceToTarget > config.guild.formationRadius * 1.5 ? config.tank.moveSpeed * config.guild.followCatchupMultiplier : config.tank.moveSpeed;
      const next = stepMovement(p.fish, move, dt, { speed: dash ? config.battle.dashSpeed : followSpeed, bounds: config.tank.swimBounds, bodyRadius: config.tank.playerBodyRadius });
      p.fish.position = next.position; p.fish.velocity = next.velocity;
      if (leader && manualMove && group) group.rally = { ...next.position };
      if (Math.abs(next.velocity.x)>2) p.fish.facing = next.velocity.x<0 ? 'left' : 'right';
      p.fish.angle = Math.atan2(next.velocity.y, Math.abs(next.velocity.x)+40)*0.15;
      if (now>=p.animationUntil) p.fish.animation = dash ? 'dash' : Math.hypot(next.velocity.x,next.velocity.y)>3 ? 'swim' : 'idle';
      p.stamina = Math.min(config.tank.staminaMax,p.stamina+config.tank.staminaRegenPerSecond*dt);
    }
    this.applySeparation(dt);
    this.ecosystem?.step(now, dt);
    this.tickTimes.push(performance.now()-started); if (this.tickTimes.length>1800) this.tickTimes.shift();
  }
  snapshot(c: ConnectionRuntime): SceneSnapshot | null {
    const p = this.players.get(c.userId); if (!p) return null;
    const battle = this.battle?.snapshot(p,c); if (battle) return battle;
    const controlled = p.controlSocketId === c.socket.id && p.leaseUntil>=Date.now();
    const visible = [...this.players.values()].filter(other => other.roomId===p.roomId && !other.self.currentMatchId);
    const online = visible.filter(other => other.disconnectedAt===null), offline = visible.filter(other => other.disconnectedAt!==null).slice(-config.tank.maxIdleDisplays);
    return { protocolVersion: 1, snapshotKind: 'full', rulesVersion: config.rulesVersion, roomId: p.roomId, roomEpoch: this.roomEpochs.get(p.roomId)!, sceneEpoch: c.sceneEpoch, sceneKind: 'TANK', serverTick: this.serverTick, serverTimeMs: Date.now(), ackInputSeq: p.ackInputSeq, ackActionSeq: p.ackActionSeq,
      controlledFishId: controlled ? p.fish.id : null, fish: [...online,...offline].map(other => ({...other.fish,interactive:other.disconnectedAt===null})),
      food: this.ecosystem?.snapshot(p.roomId).food ?? [], npc: this.ecosystem?.snapshot(p.roomId).npc ?? [], pearl: null, match: null,
      ownRuntime: controlled ? { stamina: p.stamina, dashReadyAtServerMs: p.dashReadyAt, shieldReadyAtServerMs: p.shieldReadyAt } : null };
  }
  broadcastSnapshots() { for (const c of this.connections.values()) { const snapshot = this.snapshot(c); if (snapshot) c.socket.emit('scene:snapshot',snapshot); } }
  sceneEvent(roomId: string, payload: unknown, eventId = randomUUID()) { for (const c of this.connections.values()) if (c.watchMatchId?roomId===`match:${c.watchMatchId}`:this.players.get(c.userId)?.roomId === roomId) c.socket.emit('scene:event',{eventId,roomId,sceneEpoch:c.sceneEpoch,serverTick:this.serverTick,serverTimeMs:Date.now(),payload}); }
  invalidate(userId: string, domains = ['fish','wallet','daily','inventory','guild','match']) { for (const c of this.connections.values()) if (c.userId===userId) c.socket.emit('self:invalidate',{eventId:randomUUID(),domains}); }
}
