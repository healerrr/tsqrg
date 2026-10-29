import type { Vec2 } from '@aquarium/protocol';

export interface Circle extends Vec2 { radius: number }
export interface Rect { x: number; y: number; width: number; height: number }
export const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
export const distanceSquared = (a: Vec2, b: Vec2): number => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
export const distance = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const subtract = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const multiply = (a: Vec2, value: number): Vec2 => ({ x: a.x * value, y: a.y * value });
export function normalize(v: Vec2): Vec2 {
  const length = Math.hypot(v.x, v.y);
  return length > 1e-8 && Number.isFinite(length) ? { x: v.x / length, y: v.y / length } : { x: 0, y: 0 };
}
export function clampToRect(position: Vec2, rect: Rect, radius = 0): Vec2 {
  return { x: clamp(position.x, rect.x + radius, rect.x + rect.width - radius), y: clamp(position.y, rect.y + radius, rect.y + rect.height - radius) };
}
/** Return earliest normalized contact time in [0,1], including stationary overlap. */
export function segmentCircleTime(start: Vec2, end: Vec2, center: Vec2, radius: number): number | null {
  if (![start.x, start.y, end.x, end.y, center.x, center.y, radius].every(Number.isFinite) || radius < 0) return null;
  const d = subtract(end, start);
  const f = subtract(start, center);
  const c = f.x * f.x + f.y * f.y - radius * radius;
  if (c <= 0) return 0;
  const a = d.x * d.x + d.y * d.y;
  if (a < 1e-12) return null;
  const b = 2 * (f.x * d.x + f.y * d.y);
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return null;
  const time = (-b - Math.sqrt(discriminant)) / (2 * a);
  return time >= 0 && time <= 1 ? time : null;
}
export function segmentCircleHit(start: Vec2, end: Vec2, center: Vec2, radius: number): boolean { return segmentCircleTime(start, end, center, radius) !== null; }
/** Relative motion handles a target crossing a dash during the same tick. */
export function sweptCircleHit(aStart: Vec2, aEnd: Vec2, aRadius: number, bStart: Vec2, bEnd: Vec2, bRadius: number): boolean {
  return segmentCircleHit(subtract(aStart, bStart), subtract(aEnd, bEnd), { x: 0, y: 0 }, aRadius + bRadius);
}
export function resolveArenaPosition(position: Vec2, arena: { center: Vec2; radius: number; obstacles: readonly Circle[] }, bodyRadius = 14): Vec2 {
  let point = { ...position };
  const constrainBoundary = () => {
    const offset = subtract(point, arena.center);
    const dist = Math.hypot(offset.x, offset.y);
    const limit = Math.max(0, arena.radius - bodyRadius);
    if (dist > limit) point = add(arena.center, multiply(normalize(offset), limit));
  };
  constrainBoundary();
  // Multiple passes resolve overlapping obstacle/boundary constraints without teleporting.
  for (let pass = 0; pass < 4; pass++) {
    for (const obstacle of arena.obstacles) {
      const offset = subtract(point, obstacle);
      const dist = Math.hypot(offset.x, offset.y);
      const limit = obstacle.radius + bodyRadius;
      if (dist < limit) point = add(obstacle, multiply(dist < 1e-8 ? { x: 1, y: 0 } : normalize(offset), limit + 0.001));
    }
    constrainBoundary();
  }
  return point;
}
export function moveAgainstObstacles(start: Vec2, proposed: Vec2, obstacles: readonly Circle[], bodyRadius: number): Vec2 {
  let result = { ...proposed };
  // Substeps prevent a fast dash from skipping a narrow obstacle completely.
  const steps = Math.max(1, Math.ceil(distance(start, proposed) / Math.max(1, bodyRadius)));
  const step = { x: (proposed.x - start.x) / steps, y: (proposed.y - start.y) / steps };
  let previous = { ...start };
  for (let i = 1; i <= steps; i++) {
    result = add(previous, step);
    for (const obstacle of obstacles) {
      const offset = subtract(result, obstacle);
      const dist = Math.hypot(offset.x, offset.y);
      const limit = obstacle.radius + bodyRadius;
      if (dist < limit) {
        const fallback = normalize(subtract(previous, obstacle));
        result = add(obstacle, multiply(dist < 1e-8 ? (fallback.x || fallback.y ? fallback : { x: 1, y: 0 }) : normalize(offset), limit + 0.001));
      }
    }
    previous = result;
  }
  return result;
}
export const sweptHit = sweptCircleHit;
