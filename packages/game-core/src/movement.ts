import config from '../../../config/game-balance.v1.json';
import type { MoveIntent, Vec2 } from '@aquarium/protocol';
import { add, clampToRect, distance, multiply, normalize, resolveArenaPosition, moveAgainstObstacles, type Circle, type Rect } from './geometry';

export interface MovementState { position: Vec2; velocity: Vec2 }
export interface MovementOptions {
  speed?: number; acceleration?: number; deceleration?: number;
  bounds?: Rect; arena?: { center: Vec2; radius: number; obstacles: readonly Circle[] };
  bodyRadius?: number;
}
export function intentDirection(position: Vec2, move: MoveIntent): Vec2 {
  if (move.kind === 'direction') return normalize(move.direction);
  if (move.kind === 'target') return distance(position, move.target) <= 2 ? { x: 0, y: 0 } : normalize({ x: move.target.x - position.x, y: move.target.y - position.y });
  return { x: 0, y: 0 };
}
export function stepMovement(state: MovementState, move: MoveIntent, dt: number, options: MovementOptions = {}): MovementState {
  if (!Number.isFinite(dt) || dt < 0 || dt > 1) throw new RangeError('模拟步长无效');
  const direction = intentDirection(state.position, move);
  const moving = direction.x !== 0 || direction.y !== 0;
  const speed = options.speed ?? config.tank.moveSpeed;
  const target = multiply(direction, speed);
  const diff = { x: target.x - state.velocity.x, y: target.y - state.velocity.y };
  const diffLength = Math.hypot(diff.x, diff.y);
  const acceleration = moving ? options.acceleration ?? config.tank.acceleration : options.deceleration ?? config.tank.deceleration;
  const velocity = diffLength <= acceleration * dt ? target : add(state.velocity, multiply(normalize(diff), acceleration * dt));
  let position = add(state.position, multiply(velocity, dt));
  if (move.kind === 'target' && distance(state.position, move.target) <= Math.hypot(velocity.x, velocity.y) * dt + 2) {
    position = { ...move.target };
    velocity.x = 0;
    velocity.y = 0;
  }
  if (options.arena) {
    position = moveAgainstObstacles(state.position, position, options.arena.obstacles, options.bodyRadius ?? config.battle.bodyRadius);
    position = resolveArenaPosition(position, options.arena, options.bodyRadius ?? config.battle.bodyRadius);
  } else if (options.bounds) position = clampToRect(position, options.bounds, options.bodyRadius ?? 0);
  return { position, velocity };
}
export function softSeparation(position: Vec2, others: readonly Vec2[], separationDistance = config.guild.separationDistance): Vec2 {
  let offset: Vec2 = { x: 0, y: 0 };
  for (const other of others) {
    const d = distance(position, other);
    if (d > 0.01 && d < separationDistance) offset = add(offset, multiply(normalize({ x: position.x - other.x, y: position.y - other.y }), (separationDistance - d) / separationDistance));
  }
  return offset;
}
export const simulateMovement = stepMovement;
