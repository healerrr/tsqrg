import { combatStats, config, normalize, stepMovement, type MovementState } from '@aquarium/core';
import type { FishSnapshot, InputFrame, MoveIntent, SceneSnapshot } from '@aquarium/protocol';

interface SentInput { frame: InputFrame; at: number; }
const STEP = 1 / config.network.serverTickHz;
const MAX_PENDING_MS = 350;
function copyMove(move: MoveIntent): MoveIntent {
  return move.kind === 'direction' ? { kind: 'direction', direction: { ...move.direction } }
    : move.kind === 'target' ? { kind: 'target', target: { ...move.target } } : { kind: 'idle' };
}
function copyState(state: MovementState): MovementState { return { position: { ...state.position }, velocity: { ...state.velocity } }; }

/** Only movement is speculative. The class never changes a server snapshot or asset value. */
export class MovementPrediction {
  private state: MovementState | null = null;
  private snapshot: SceneSnapshot | null = null;
  private fish: FishSnapshot | null = null;
  private pending: SentInput[] = [];
  private intent: MoveIntent = { kind: 'idle' };
  private epoch = '';
  private lastSequence = 0;
  private lastInputAt = -Infinity;
  private lastAdvancedAt = 0;
  private receivedAt = 0;
  private accumulator = 0;

  get pendingCount() { return this.pending.length; }
  getState() { return this.state ? copyState(this.state) : null; }
  reset() {
    this.state = null; this.snapshot = null; this.fish = null; this.pending = [];
    this.intent = { kind: 'idle' }; this.epoch = ''; this.lastSequence = 0;
    this.lastInputAt = -Infinity; this.lastAdvancedAt = 0; this.accumulator = 0;
  }
  setIntent(move: MoveIntent) { this.intent = copyMove(move); }
  recordInput(frame: InputFrame, now: number) {
    if (!this.snapshot || frame.sceneEpoch !== this.snapshot.sceneEpoch || frame.roomId !== this.snapshot.roomId || frame.inputSeq <= this.lastSequence) return;
    this.lastSequence = frame.inputSeq;
    this.lastInputAt = now;
    this.intent = frame.pageVisible ? copyMove(frame.move) : { kind: 'idle' };
    this.pending.push({ at: now, frame: { ...frame, move: copyMove(frame.move), actions: frame.actions.map(a => ({ ...a, direction: a.direction ? { ...a.direction } : undefined })) } });
    this.pending = this.pending.filter(p => now - p.at <= MAX_PENDING_MS).slice(-40);
  }
  reconcile(snapshot: SceneSnapshot, now: number) {
    const fish = snapshot.fish.find(f => f.id === snapshot.controlledFishId);
    if (!fish) { this.reset(); return; }
    const epoch = `${snapshot.roomEpoch}:${snapshot.sceneEpoch}:${fish.id}`;
    if (this.epoch !== epoch) { this.reset(); this.epoch = epoch; }
    this.snapshot = snapshot; this.fish = fish; this.receivedAt = now;
    this.lastAdvancedAt = now; this.accumulator = 0;
    this.pending = this.pending.filter(p => p.frame.inputSeq > snapshot.ackInputSeq && p.frame.sceneEpoch === snapshot.sceneEpoch && p.frame.roomId === snapshot.roomId && now - p.at <= MAX_PENDING_MS);
    this.state = copyState(fish);
    // Each unacknowledged command is replayed for its actual locally observed interval.
    // A late acknowledgement starts from the corrected authoritative position, never the old prediction.
    let simulatedAt = snapshot.serverTimeMs;
    for (let i = 0; i < this.pending.length; i++) {
      const command = this.pending[i]!;
      const until = this.pending[i + 1]?.at ?? now;
      let remaining = Math.max(0, Math.min(100, until - command.at)) / 1000;
      const intent = command.frame.pageVisible ? command.frame.move : { kind: 'idle' as const };
      while (remaining > 1e-8) {
        const dt = Math.min(STEP, remaining);
        this.state = this.step(this.state, intent, dt, simulatedAt);
        remaining -= dt; simulatedAt += dt * 1000;
      }
    }
  }
  advanceTo(now: number) {
    if (!this.state || !this.snapshot) return null;
    this.accumulator += Math.min(0.5, Math.max(0, (now - this.lastAdvancedAt) / 1000));
    this.lastAdvancedAt = now;
    let iterations = 0;
    while (this.accumulator + 1e-8 >= STEP && iterations++ < 15) {
      const stepAt = now - this.accumulator * 1000;
      const stale = stepAt - this.lastInputAt > MAX_PENDING_MS || stepAt - this.receivedAt > MAX_PENDING_MS;
      this.state = this.step(this.state, stale ? { kind: 'idle' } : this.intent, STEP, this.snapshot.serverTimeMs + stepAt - this.receivedAt);
      this.accumulator -= STEP;
    }
    return this.getState();
  }
  private step(state: MovementState, intent: MoveIntent, dt: number, serverNow: number): MovementState {
    const snapshot = this.snapshot!, fish = this.fish!;
    if (fish.respawnAtServerMs !== null || (snapshot.match && !['RUNNING', 'OVERTIME'].includes(snapshot.match.phase))) return { position: { ...state.position }, velocity: { x: 0, y: 0 } };
    const dashStartedAt = (snapshot.ownRuntime?.dashReadyAtServerMs ?? 0) - config.battle.dashCooldownSeconds * 1000;
    const dashActive = serverNow >= dashStartedAt && serverNow < dashStartedAt + config.battle.dashDurationSeconds * 1000 && Math.hypot(fish.velocity.x, fish.velocity.y) > config.tank.moveSpeed;
    if (dashActive) {
      const direction = normalize(fish.velocity);
      state = { position: state.position, velocity: { x: direction.x * config.battle.dashSpeed, y: direction.y * config.battle.dashSpeed } };
      intent = { kind: 'direction', direction };
    }
    if (snapshot.sceneKind === 'TANK') return stepMovement(state, intent, dt, { speed: dashActive ? config.battle.dashSpeed : config.tank.moveSpeed, bounds: config.tank.swimBounds });
    const stats = combatStats(fish.appearance.presetId, fish.level);
    const carrying = snapshot.pearl?.carrierFishId === fish.id;
    const arena = snapshot.sceneKind === 'TEAM' ? config.battle.teamArena : config.battle.duelArena;
    return stepMovement(state, intent, dt, { speed: dashActive ? config.battle.dashSpeed : stats.speed * (carrying ? config.battle.pearl.carrierSpeedMultiplier : 1),
      acceleration: config.battle.acceleration, deceleration: config.battle.deceleration, arena, bodyRadius: config.battle.bodyRadius });
  }
}
