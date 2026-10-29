import { Application, Container, Graphics, Rectangle, Text } from 'pixi.js';
import type { Appearance, FishSnapshot, InputFrame, MoveIntent, SceneEvent, SceneSnapshot } from '@aquarium/protocol';
import { config } from '@aquarium/core';
import { ANCHORS, FishView, PRESET_COLORS } from './fish';
import { createArena, createScenery } from './scenery';
import { MovementPrediction } from './prediction';

export interface AquariumCallbacks {
  onMove(move: MoveIntent): void;
  onAction(kind: 'dash' | 'shield'): void;
  onSelect(fishId: string): void;
  onStats?(stats: AquariumStats): void;
  onError?(message: string): void;
}
export interface AquariumStats {
  fps: number; frames: number; avgFPS: number; p95FrameMs: number;
  tickerCount: number; entityCount: number; quality: 'normal' | 'low'; resolution: number; frameSamples: number;
}
export interface Aquarium {
  setSnapshot(snapshot: SceneSnapshot): void;
  recordInput(frame: InputFrame): void;
  resetPrediction(): void;
  setSelfId(id: string | null): void;
  setAppearancePreview(appearance: Appearance | null): void;
  setReducedMotion(enabled: boolean): void;
  setQuality(quality: 'normal' | 'low'): void;
  getStats(): AquariumStats;
  resetStats(): void;
  setPreviewMode(enabled: boolean): void;
  setInputEnabled(enabled: boolean): void;
  triggerAction(kind: 'dash' | 'shield'): void;
  feedPreview(): void;
  showEvent(event: SceneEvent): void;
  setMoveIntent(move: MoveIntent): void;
  getDebugState(): { fish: Array<{ id: string; x: number; y: number; simulatedX: number; simulatedY: number; preset: string; skinStatus: string; interactive: boolean; visualAlpha: number; presenceLabel: boolean }>; input: MoveIntent; preview: boolean; prediction: { pendingInputs: number; controlled: boolean } };
  destroy(): void;
}
interface Particle { display: Container; vx: number; vy: number; ttl: number; max: number; }
type BufferedSnapshot = { received: number; snapshot: SceneSnapshot };
const W = config.tank.worldWidth, H = config.tank.worldHeight;
const PRESETS = ['goldfish', 'angelfish', 'betta', 'puffer', 'clownfish', 'ray'] as const;
const POSITIONS = [[850, 505], [415, 305], [1160, 310], [1430, 505], [515, 655], [1110, 710]];
const NAMES = ['摸鱼实习生', '阿杰', '小林', '不想开会', '周五快乐', '小蓝'];
function previewFish(i: number): FishSnapshot {
  const presetId = PRESETS[i]!;
  const colors = PRESET_COLORS[presetId];
  const pos = POSITIONS[i]!;
  return {
    id: `preview-${i}`, nickname: NAMES[i]!, position: { x: pos[0]!, y: pos[1]! }, velocity: { x: 0, y: 0 },
    facing: i === 2 || i === 3 ? 'left' : 'right', angle: 0,
    appearance: { presetId, bodyColor: colors[0], finColor: colors[1], patternId: 'plain', skinAssetId: null,
      equipped: i === 0 ? { face: 'glasses.round' } : i === 2 ? { head: 'headphones.basic' } : {}, version: 1 },
    level: 1, displaySize: i === 0 ? 1.38 : i === 1 || i === 2 || i === 3 ? 1.18 : 0.98,
    guildId: null, team: null, animation: 'idle', interactive: true, followGroupId: null, hp: null, maxHp: null,
    shieldUntilServerMs: 0, respawnAtServerMs: null,
  };
}

/** The renderer owns only visual state. Live asset and battle changes require server snapshots. */
export async function createAquarium(host: HTMLElement, callbacks: AquariumCallbacks): Promise<Aquarium> {
  const app = new Application();
  await app.init({ width: host.clientWidth || 1280, height: host.clientHeight || 720, background: 0x087ca7,
    antialias: true, resolution: Math.min(devicePixelRatio || 1, 2), autoDensity: true, preference: 'webgl', powerPreference: 'high-performance' });
  if (!host.isConnected) { app.destroy({ removeView: true }, { children: true }); throw new Error('水族箱容器已关闭'); }
  host.appendChild(app.canvas);
  app.canvas.style.width = '100%'; app.canvas.style.height = '100%'; app.canvas.style.display = 'block'; app.canvas.style.touchAction = 'none';
  app.canvas.setAttribute('aria-label', '公共水族箱：点按游动，方向键或 WASD 移动，空格冲刺，E 护盾');
  app.canvas.setAttribute('role', 'img');
  const world = new Container(); const scenery = createScenery();
  const arenaLayer = new Container(); const entities = new Container(); const foodLayer = new Container();
  const npcLayer = new Container(); const effectLayer = new Container();
  const pearl = new Container(); const pearlBody = new Graphics();
  const pearlLabel = new Text({ text: '目标珠', style: { fontFamily: 'Microsoft YaHei, sans-serif', fontSize: 14, fontWeight: 'bold', fill: 0xffffff, stroke: { color: 0x12385b, width: 3 } } });
  pearlLabel.anchor.set(0.5); pearlLabel.y = 35;
  const marker = new Graphics();
  app.stage.addChild(world); world.addChild(scenery.root, arenaLayer, npcLayer, foodLayer, marker, entities, pearl, effectLayer);
  pearlBody.circle(0, 0, 23).fill({ color: 0xcaffef, alpha: 0.13 });
  pearlBody.circle(0, 0, 14).fill(0xeaf9ff).stroke({ color: 0xc8e8ff, width: 3 });
  pearlBody.circle(-4, -5, 4).fill(0xffffff);
  pearlBody.poly([0, -30, 5, -23, 0, -16, -5, -23]).fill(0xffd66e);
  pearl.addChild(pearlBody, pearlLabel); pearl.visible = false;
  const views = new Map<string, FishView>(); const foods = new Map<string, Graphics>(); const npcs = new Map<string, Graphics>();
  const particles: Particle[] = []; const buffer: BufferedSnapshot[] = [];
  const prediction = new MovementPrediction();
  let reconciliationOffset = { x: 0, y: 0 };
  let preview = true, selfId: string | null = 'preview-0', reduced = false, enabled = true, destroyed = false;
  let width = W, height = H, sceneKind: SceneSnapshot['sceneKind'] = 'TANK';
  let snapshot: SceneSnapshot | null = null, previewAppearance: Appearance | null = null;
  let move: MoveIntent = { kind: 'idle' }, dragging = false, selected: string | null = null;
  let dashUntil = 0, dashReadyAt = 0, shieldUntil = 0, markerUntil = 0, frameCount = 0, statsStart = performance.now(), serverOffset = 0;
  let lastSend = 0, lastTrail = 0;
  let portraitCamera = false, viewportWidth = host.clientWidth || 1280, viewportHeight = host.clientHeight || 720;
  let lastRenderAt = performance.now(), lastMotionAt = performance.now(), motionAccumulator = 0;
  let quality: 'normal' | 'low' = 'normal', totalFrames = 0, recentFPS = 0;
  const frameTimes: number[] = [];
  const keys = new Set<string>();

  function resize() {
    if (destroyed) return;
    const w = host.clientWidth || 1280, h = host.clientHeight || 720;
    viewportWidth = w; viewportHeight = h; portraitCamera = w / h < 0.8;
    app.renderer.resize(w, h);
    const scale = portraitCamera ? Math.max(w / 1100, h / height) : Math.min(w / width, h / height);
    world.scale.set(scale);
    const focusX = (selfId ? views.get(selfId)?.x : undefined) ?? width / 2;
    world.position.set(portraitCamera ? cameraX(focusX) : (w - width * scale) / 2, (h - height * scale) / 2);
    app.stage.hitArea = new Rectangle(0, 0, w, h);
  }
  function cameraX(focusX: number) {
    return Math.max(viewportWidth - width * world.scale.x, Math.min(0, viewportWidth / 2 - focusX * world.scale.x));
  }
  const observer = new ResizeObserver(resize); observer.observe(host);
  function addFish(f: FishSnapshot) {
    const view = new FishView(f, id => { selected = id; callbacks.onSelect(id); });
    view.on('pointerdown', e => e.stopPropagation());
    view.on('skin-error', () => { if (f.id === selfId) callbacks.onError?.('贴图加载失败，已显示默认外观。请重新打开我的鱼后重试。'); });
    view.setOwn(f.id === selfId); views.set(f.id, view); entities.addChild(view); return view;
  }
  function makePreview() {
    views.forEach(v => v.destroy({ children: true })); views.clear();
    for (let i = 0; i < 6; i++) addFish(previewFish(i));
    selfId = 'preview-0'; sceneKind = 'TANK'; width = W; height = H;
    scenery.root.visible = true; arenaLayer.removeChildren().forEach(c => c.destroy({ children: true })); pearl.visible = false;
    resize();
  }
  function clearInput() {
    if (preview) advanceControlClock(performance.now());
    keys.clear(); dragging = false; move = { kind: 'idle' }; prediction.setIntent(move); callbacks.onMove(move);
  }
  function sendMove(intent: MoveIntent) { if (preview) advanceControlClock(performance.now()); move = intent; prediction.setIntent(intent); callbacks.onMove(intent); }
  function pointerTarget(e: { global: { x: number; y: number } }) {
    const p = world.toLocal(e.global);
    const minX = sceneKind === 'TANK' ? 64 : 0, maxX = sceneKind === 'TANK' ? 1856 : width;
    const minY = sceneKind === 'TANK' ? 96 : 0, maxY = sceneKind === 'TANK' ? 876 : height;
    const target = { x: Math.max(minX, Math.min(maxX, p.x)), y: Math.max(minY, Math.min(maxY, p.y)) };
    sendMove({ kind: 'target', target }); marker.position.copyFrom(target); markerUntil = performance.now() + 750;
  }
  app.stage.eventMode = 'static';
  app.stage.on('pointerdown', e => { if (enabled && (e.button === 0 || e.pointerType === 'touch')) { dragging = true; pointerTarget(e); } });
  app.stage.on('pointermove', e => { if (dragging && enabled) pointerTarget(e); });
  app.stage.on('pointerup', () => { dragging = false; });
  app.stage.on('pointerupoutside', () => { dragging = false; });
  function keyboardBlocked(target: EventTarget | null) {
    return !enabled || (target instanceof HTMLElement && !!target.closest('input, textarea, select, button, [contenteditable="true"], [role="dialog"]'));
  }
  function keyMove() {
    const x = Number(keys.has('KeyD') || keys.has('ArrowRight')) - Number(keys.has('KeyA') || keys.has('ArrowLeft'));
    const y = Number(keys.has('KeyS') || keys.has('ArrowDown')) - Number(keys.has('KeyW') || keys.has('ArrowUp'));
    sendMove(x || y ? { kind: 'direction', direction: { x, y } } : { kind: 'idle' });
  }
  const movementKeys = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
  function keydown(e: KeyboardEvent) {
    if (keyboardBlocked(e.target)) return;
    if (movementKeys.includes(e.code)) { e.preventDefault(); keys.add(e.code); keyMove(); }
    if (e.code === 'Space' || e.code === 'KeyE') { e.preventDefault(); if (!e.repeat) triggerAction(e.code === 'Space' ? 'dash' : 'shield'); }
  }
  function keyup(e: KeyboardEvent) { if (keys.delete(e.code)) { if (enabled) keyMove(); else clearInput(); } }
  function visibility() { if (document.hidden) clearInput(); lastRenderAt = performance.now(); lastMotionAt = performance.now(); motionAccumulator = 0; }
  function focusChange(e: FocusEvent) { if (keyboardBlocked(e.target)) clearInput(); }
  window.addEventListener('keydown', keydown); window.addEventListener('keyup', keyup); window.addEventListener('blur', clearInput);
  window.addEventListener('pointercancel', clearInput);
  document.addEventListener('visibilitychange', visibility); document.addEventListener('focusin', focusChange);
  // The anonymous pointer-up handler is held explicitly for reliable cleanup.
  const endDrag = () => { dragging = false; };
  window.addEventListener('pointerup', endDrag);

  function triggerAction(kind: 'dash' | 'shield') {
    if (!enabled) return;
    callbacks.onAction(kind);
    if (!preview) return;
    const v = selfId ? views.get(selfId) : null;
    if (!v) return;
    if (kind === 'dash' && performance.now() > dashReadyAt) {
      dashUntil = performance.now() + config.battle.dashDurationSeconds * 1000; dashReadyAt = performance.now() + config.battle.dashCooldownSeconds * 1000;
      v.animate('dash', config.battle.dashDurationSeconds * 1000); burst(v.x, v.y, 0xd5fff8, 9);
    }
    if (kind === 'shield') { shieldUntil = Date.now() + config.battle.shieldDurationSeconds * 1000; v.snapshot.shieldUntilServerMs = shieldUntil; }
  }
  function burst(x: number, y: number, color: number, count: number) {
    if (quality === 'low') count = Math.ceil(count / 2);
    if (reduced) count = Math.min(count, 3);
    for (let i = 0; i < count; i++) {
      const g = new Graphics().circle(0, 0, 2 + i % 4).fill({ color, alpha: 0.85 });
      g.position.set(x, y); effectLayer.addChild(g);
      const angle = i * Math.PI * 2 / count;
      particles.push({ display: g, vx: Math.cos(angle) * (35 + i * 4), vy: Math.sin(angle) * (35 + i * 4), ttl: 0.65, max: 0.65 });
    }
  }
  function floatingText(x: number, y: number, text: string) {
    const t = new Text({ text, style: { fontSize: 21, fill: 0xfff5bf, fontFamily: 'Microsoft YaHei, sans-serif', fontWeight: 'bold', stroke: { color: 0x12385b, width: 3 } } });
    t.anchor.set(0.5); t.position.set(x, y - 55); effectLayer.addChild(t);
    particles.push({ display: t, vx: 0, vy: -35, ttl: 1.4, max: 1.4 });
  }
  function feedPreview() {
    if (!preview) return;
    for (let i = 0; i < config.tank.manualFeedPellets; i++) {
      const id = `local-food-${Date.now()}-${i}`;
      const g = new Graphics().ellipse(0, 0, 7, 5).fill(0xffcd70).stroke({ color: 0xbf8645, width: 1.5 });
      g.position.set(700 + Math.random() * 400, 150 + Math.random() * 250); g.label = String(performance.now()); foods.set(id, g); foodLayer.addChild(g);
    }
  }
  function scene(next: SceneSnapshot['sceneKind']) {
    if (next === sceneKind) return;
    clearInput(); prediction.reset(); reconciliationOffset = { x: 0, y: 0 }; sceneKind = next; buffer.length = 0;
    if (next !== 'TANK') previewAppearance = null;
    width = next === 'TANK' ? W : next === 'TEAM' ? config.battle.teamArena.width : config.battle.duelArena.width;
    height = next === 'TANK' ? H : next === 'TEAM' ? config.battle.teamArena.height : config.battle.duelArena.height;
    scenery.root.visible = next === 'TANK';
    arenaLayer.removeChildren().forEach(c => c.destroy({ children: true }));
    if (next !== 'TANK') arenaLayer.addChild(createArena(next));
    resize();
  }
  function setSnapshot(s: SceneSnapshot) {
    if (destroyed) return;
    if (preview) { preview = false; views.forEach(v => v.destroy({ children: true })); views.clear(); foods.forEach(v => v.destroy()); foods.clear(); }
    if (snapshot && (s.roomEpoch !== snapshot.roomEpoch || s.sceneEpoch !== snapshot.sceneEpoch)) { buffer.length = 0; prediction.reset(); reconciliationOffset = { x: 0, y: 0 }; clearInput(); }
    scene(s.sceneKind); snapshot = s; serverOffset = s.serverTimeMs - Date.now();
    buffer.push({ received: performance.now(), snapshot: s }); if (buffer.length > 12) buffer.shift();
    const ids = new Set(s.fish.map(f => f.id));
    views.forEach((v, id) => { if (!ids.has(id)) { v.destroy({ children: true }); views.delete(id); } });
    s.fish.forEach(f => {
      const v = views.get(f.id) || addFish(f); v.updateSnapshot(f, f.id === selfId && sceneKind === 'TANK' ? previewAppearance : null); v.setOwn(f.id === selfId);
    });
    const previousPrediction = prediction.getState();
    prediction.reconcile(s, performance.now());
    const corrected = prediction.getState(), controlled = s.controlledFishId ? views.get(s.controlledFishId) : null;
    if (corrected && controlled) {
      const dx = controlled.x - corrected.position.x, dy = controlled.y - corrected.position.y;
      reconciliationOffset = previousPrediction && Math.hypot(dx, dy) < 160 ? { x: dx, y: dy } : { x: 0, y: 0 };
      controlled.target = { x: corrected.position.x + reconciliationOffset.x, y: corrected.position.y + reconciliationOffset.y };
    }
    syncFood(s); syncNpc(s);
    pearl.visible = !!s.pearl;
    if (s.pearl) pearl.position.copyFrom(s.pearl.position);
  }
  function syncFood(s: SceneSnapshot) {
    const ids = new Set(s.food.map(f => f.id));
    foods.forEach((g, id) => { if (!ids.has(id)) { g.destroy(); foods.delete(id); } });
    s.food.forEach(f => {
      let g = foods.get(f.id);
      if (!g) { g = new Graphics().ellipse(0, 0, 6.5, 4.5).fill(0xffcf71).stroke({ color: 0xc28e4c, width: 1.4 }); g.rotation = f.position.x; foods.set(f.id, g); foodLayer.addChild(g); }
      g.position.copyFrom(f.position); g.alpha = f.state === 'CLAIM_PENDING' ? 0.4 : 1;
    });
  }
  function syncNpc(s: SceneSnapshot) {
    const ids = new Set(s.npc.map(f => f.id));
    npcs.forEach((g, id) => { if (!ids.has(id)) { g.destroy(); npcs.delete(id); } });
    s.npc.forEach(f => {
      let g = npcs.get(f.id);
      if (!g) {
        g = new Graphics();
        const color = f.tier === 'rare' ? 0xffda79 : f.tier === 'agile' ? 0xa1e9d7 : 0xa2d3e6;
        if (f.tier === 'agile') {
          g.moveTo(-20, 0).bezierCurveTo(-8, -8, 14, -8, 25, -1).quadraticCurveTo(11, 8, -20, 3).closePath().fill(color).stroke({ color: 0x367e8c, width: 1.3 });
          g.poly([-19, 0, -36, -12, -29, 0, -36, 11, -19, 3]).fill(0x7dd6c8).stroke({ color: 0x367e8c, width: 1.2 });
          g.poly([-7, -5, 1, -12, 6, -5]).fill(0x64b7ae).circle(17, -1, 1.7).fill(0x12385b);
        } else if (f.tier === 'rare') {
          g.ellipse(1, 0, 14, 11).fill(color).stroke({ color: 0xb58b45, width: 1.3 });
          g.moveTo(-11, -2).bezierCurveTo(-26, -17, -27, -2, -20, 0).bezierCurveTo(-27, 5, -21, 15, -11, 4).closePath().fill(0xf4ba5f).stroke({ color: 0xb58b45, width: 1.2 });
          g.poly([-6, -10, -9, -20, -1, -15, 4, -21, 9, -8]).fill(0xf6b85b).stroke({ color: 0xb58b45, width: 1.2 });
          g.ellipse(5, 4, 8, 5).fill(0xfff2c4).circle(9, -2, 1.8).fill(0x12385b);
          g.poly([0, -34, 3, -29, 0, -24, -3, -29]).fill(0xffe8a7);
        } else {
          g.moveTo(-16, 0).quadraticCurveTo(1, -12, 18, 0).quadraticCurveTo(3, 10, -16, 3).closePath().fill(color).stroke({ color: 0x3f8ba7, width: 1.3 });
          g.poly([-13, 1, -25, -7, -22, 1, -25, 8]).fill(0x80bbd2).stroke({ color: 0x3f8ba7, width: 1.2 });
          g.circle(11, -1, 1.6).fill(0x12385b);
        }
        npcs.set(f.id, g); npcLayer.addChild(g);
      }
      const scale = f.relativeSize / config.tank.npcTiers[0]!.relativeSize;
      g.position.copyFrom(f.position); g.scale.set((f.velocity.x < 0 ? -1 : 1) * scale, scale);
      g.alpha = f.state === 'CLAIM_PENDING' ? 0.4 : 1;
    });
  }
  function showEvent(event: SceneEvent) {
    const e = event.payload;
    const id = 'fishId' in e ? e.fishId : 'targetFishId' in e ? e.targetFishId : null;
    const view = id ? views.get(id) : null;
    if (e.kind === 'eat' && view) { view.animate('eat'); burst(view.x + view.facing * 36, view.y, 0xffd777, 6); if (id === selfId && (e.actualXp || e.actualPower)) floatingText(view.x, view.y, `+${e.actualXp} 经验 · +${e.actualPower} 战力`); }
    if (e.kind === 'dash' && view) { view.animate('dash', 180); burst(view.x, view.y, 0xc7fff7, 7); }
    if (e.kind === 'hit' && view) { view.animate(e.blocked ? 'idle' : 'hit', 300); burst(view.x, view.y, e.blocked ? 0xc6ffff : 0xffbfa5, 8); if (e.blocked || e.damage > 0) floatingText(view.x, view.y, e.blocked ? '格挡' : `−${e.damage}`); }
    if (e.kind === 'respawn' && view) { view.animate('bubble', 700); burst(e.position.x, e.position.y, 0xf4ffff, 10); }
    if (e.kind === 'emote' && view) floatingText(view.x, view.y, { hi: '嗨！', heart: '♥', zzz: '摸会儿鱼…', challenge: '来切磋！' }[e.emote]);
  }
  function updateControl(dt: number, now: number) {
    const own = selfId ? views.get(selfId) : null;
    if (!preview) { prediction.advanceTo(now); return; }
    if (own && enabled) {
      let dx = 0, dy = 0;
      if (move.kind === 'direction') { dx = move.direction.x; dy = move.direction.y; }
      if (move.kind === 'target') { dx = move.target.x - own.target.x; dy = move.target.y - own.target.y; if (Math.hypot(dx, dy) < 5) { dx = 0; dy = 0; } }
      if (preview && now < dashUntil && !dx && !dy) dx = own.facing;
      const d = Math.hypot(dx, dy);
      const speed = preview && now < dashUntil ? config.battle.dashSpeed : config.tank.moveSpeed;
      if (d > 0 && (!snapshot || snapshot.controlledFishId === selfId)) {
        own.target.x += dx / d * speed * dt; own.target.y += dy / d * speed * dt;
        if (sceneKind === 'TANK') { own.target.x = Math.max(64, Math.min(1856, own.target.x)); own.target.y = Math.max(96, Math.min(876, own.target.y)); }
        if (preview) { own.snapshot.velocity = { x: dx / d * speed, y: dy / d * speed }; own.snapshot.animation = now < dashUntil ? 'dash' : 'swim'; }
        if (Math.abs(dx) > 0.2) own.facing = dx < 0 ? -1 : 1;
      } else if (preview) { own.snapshot.velocity = { x: 0, y: 0 }; own.snapshot.animation = 'idle'; }
      if (now - lastSend > 1000 / config.network.inputHz && preview) { lastSend = now; callbacks.onMove(move); }
    }
  }
  // Control uses a real-time 30 Hz clock, independent of WebGL/SwiftShader frame rate.
  function advanceControlClock(now: number) {
    if (destroyed) return;
    if (document.hidden) { motionAccumulator = 0; lastMotionAt = now; return; }
    // Cheap fixed-step motion can catch up even when a software WebGL draw blocks for a second.
    // Intent transitions flush the old interval before changing direction, preserving held time.
    motionAccumulator += Math.min(2, Math.max(0, (now - lastMotionAt) / 1000)); lastMotionAt = now;
    const fixed = 1 / config.network.serverTickHz;
    let steps = 0;
    while (motionAccumulator >= fixed && steps++ < config.network.serverTickHz * 2) {
      updateControl(fixed, now - motionAccumulator * 1000); motionAccumulator -= fixed;
    }
  }
  const motionTimer = window.setInterval(() => advanceControlClock(performance.now()), 1000 / config.network.serverTickHz);
  function render() {
    if (destroyed) return;
    const now = performance.now(), rawFrameMs = Math.max(0, now - lastRenderAt), dt = Math.min(0.5, rawFrameMs / 1000), time = now / 1000;
    if (!document.hidden && rawFrameMs > 0 && totalFrames > 0) { frameTimes.push(rawFrameMs); if (frameTimes.length > 600) frameTimes.shift(); }
    totalFrames++;
    lastRenderAt = now;
    scenery.update(time, reduced);
    const own = selfId ? views.get(selfId) : null;
    if (preview) {
      views.forEach((v, id) => {
        if (id === selfId) return;
        const i = Number(id.split('-')[1]); const p = POSITIONS[i]!;
        v.target.x = p[0]! + Math.sin(time * 0.24 + i * 1.7) * 45;
        v.target.y = p[1]! + Math.cos(time * 0.43 + i) * 15;
      });
      foods.forEach((g, id) => {
        g.y += dt * 19; g.x += Math.sin(time + g.y) * dt * 2;
        if (own && Math.hypot(g.x - own.x, g.y - own.y) < 53) { own.animate('eat'); burst(g.x, g.y, 0xffd66e, 5); g.destroy(); foods.delete(id); }
        else if (g.y > 890 || now - Number(g.label) > config.tank.pelletLifetimeSeconds * 1000) { g.destroy(); foods.delete(id); }
      });
    } else if (buffer.length) {
      const renderAt = now - config.network.interpolationBufferMs;
      let before = buffer[0]!, after = buffer[buffer.length - 1]!;
      for (let i = 1; i < buffer.length; i++) {
        if (buffer[i]!.received >= renderAt) { before = buffer[i - 1]!; after = buffer[i]!; break; }
      }
      const a = Math.max(0, Math.min(1, (renderAt - before.received) / Math.max(1, after.received - before.received)));
      views.forEach((v, id) => {
        if (id === selfId && snapshot?.controlledFishId === selfId) return;
        const f0 = before.snapshot.fish.find(f => f.id === id), f1 = after.snapshot.fish.find(f => f.id === id);
        if (f0 && f1) { v.target.x = f0.position.x + (f1.position.x - f0.position.x) * a; v.target.y = f0.position.y + (f1.position.y - f0.position.y) * a; }
      });
    }
    if (!preview && own && snapshot?.controlledFishId === selfId) {
      const predicted = prediction.getState();
      if (predicted) {
        const decay = Math.exp(-dt * 12); reconciliationOffset.x *= decay; reconciliationOffset.y *= decay;
        own.target = { x: predicted.position.x + reconciliationOffset.x, y: predicted.position.y + reconciliationOffset.y };
        if (Math.abs(predicted.velocity.x) > 2) own.facing = predicted.velocity.x < 0 ? -1 : 1;
      }
    }
    views.forEach((v, id) => { v.setSelected(selected === id); v.update(dt, time, reduced, Date.now() + serverOffset, sceneKind !== 'TANK', preview); });
    if (snapshot?.pearl) {
      const carrier = snapshot.pearl.carrierFishId ? views.get(snapshot.pearl.carrierFishId) : null;
      if (carrier) { pearl.position.set(carrier.x, carrier.y - 58); pearlLabel.text = carrier.snapshot.team === 'A' ? '◆ A队' : carrier.snapshot.team === 'B' ? '● B队' : '携带者'; pearlLabel.y = -43; }
      else { pearl.position.copyFrom(snapshot.pearl.position); pearlLabel.text = '目标珠'; pearlLabel.y = 35; }
    }
    if (portraitCamera) {
      const focusX = own?.x ?? width / 2;
      world.x += (cameraX(focusX) - world.x) * (1 - Math.exp(-dt * 6));
      world.y = (viewportHeight - height * world.scale.y) / 2;
    }
    if (!reduced && now - lastTrail > (quality === 'low' ? 400 : 150) && particles.length < (quality === 'low' ? 60 : 160)) {
      lastTrail = now;
      views.forEach((v) => {
        const a = v.snapshot.id === selfId && previewAppearance && sceneKind === 'TANK' ? previewAppearance : v.snapshot.appearance;
        if (a.equipped.trail && Math.hypot(v.snapshot.velocity.x, v.snapshot.velocity.y) > 20) {
          const points: number[] = [];
          for (let i = 0; i < 8; i++) { const angle = i * Math.PI / 4; const r = i % 2 ? 2 : 6; points.push(Math.cos(angle) * r, Math.sin(angle) * r); }
          const star = new Graphics().poly(points).fill(0xffe7a2);
          const size = sceneKind === 'TANK' ? v.snapshot.displaySize : 0.65;
          star.position.set(v.x + v.facing * ANCHORS[a.presetId].trail[0] * size, v.y + Math.sin(now) * 12); effectLayer.addChild(star);
          particles.push({ display: star, vx: -v.facing * 25, vy: -5, ttl: 0.7, max: 0.7 });
        }
      });
    }
    marker.clear();
    if (markerUntil > now) {
      const age = (750 - (markerUntil - now)) / 750;
      marker.circle(0, 0, 11 + age * 15).stroke({ color: 0xd2fff6, width: 2, alpha: 1 - age });
      marker.circle(0, 0, 3).fill({ color: 0xffffff, alpha: 1 - age });
    }
    particles.forEach(p => { p.ttl -= dt; p.display.x += p.vx * dt; p.display.y += p.vy * dt; p.display.alpha = Math.max(0, p.ttl / p.max); });
    for (let i = particles.length - 1; i >= 0; i--) if (particles[i]!.ttl <= 0) { particles[i]!.display.destroy(); particles.splice(i, 1); }
    frameCount++;
    if (now - statsStart > 1000) { recentFPS = Math.round(frameCount * 1000 / (now - statsStart)); callbacks.onStats?.(getStats()); frameCount = 0; statsStart = now; }
  }
  function getStats(): AquariumStats {
    const sum = frameTimes.reduce((a, b) => a + b, 0), ordered = [...frameTimes].sort((a, b) => a - b);
    return { fps: recentFPS, frames: totalFrames, avgFPS: sum ? Math.round(1000 * frameTimes.length / sum * 10) / 10 : 0,
      p95FrameMs: ordered.length ? Math.round(ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * 0.95) - 1)]! * 10) / 10 : 0,
      tickerCount: destroyed ? 0 : 1, entityCount: views.size + foods.size + npcs.size + Number(pearl.visible), quality,
      resolution: destroyed ? 0 : app.renderer.resolution, frameSamples: frameTimes.length };
  }
  makePreview(); resize(); app.ticker.add(render);
  return {
    setSnapshot, triggerAction, feedPreview, showEvent,
    getStats,
    resetStats() { frameTimes.length = 0; totalFrames = 0; frameCount = 0; recentFPS = 0; statsStart = performance.now(); lastRenderAt = performance.now(); },
    setQuality(value) { if (destroyed || value === quality) return; quality = value; app.renderer.resolution = Math.min(devicePixelRatio || 1, value === 'low' ? 1.5 : 2); scenery.setQuality(value); resize(); },
    recordInput(frame) { if (!preview) prediction.recordInput(frame, performance.now()); },
    resetPrediction() { prediction.reset(); reconciliationOffset = { x: 0, y: 0 }; clearInput(); },
    setMoveIntent(intent) { if (enabled) sendMove(intent); },
    getDebugState() { return { fish: [...views.values()].map(v => ({ id: v.snapshot.id, x: v.x, y: v.y, simulatedX: v.target.x, simulatedY: v.target.y, preset: v.renderedPreset, skinStatus: v.skinStatus, interactive: v.snapshot.interactive, visualAlpha: v.visual.alpha, presenceLabel: v.presenceText.visible })), input: move, preview, prediction: { pendingInputs: prediction.pendingCount, controlled: !!snapshot?.controlledFishId } }; },
    setSelfId(id) { if (selfId !== id) { prediction.reset(); reconciliationOffset = { x: 0, y: 0 }; clearInput(); } selfId = id; views.forEach((v, key) => v.setOwn(key === id)); },
    setAppearancePreview(a) { if (sceneKind !== 'TANK') { previewAppearance = null; return; } previewAppearance = a; const v = selfId ? views.get(selfId) : null; if (v) v.setAppearance(a || v.snapshot.appearance); },
    setReducedMotion(value) { reduced = value; },
    setPreviewMode(value) { if (value !== preview) { prediction.reset(); reconciliationOffset = { x: 0, y: 0 }; clearInput(); } if (value && !preview) { preview = true; snapshot = null; buffer.length = 0; makePreview(); } else if (!value && preview) { preview = false; views.forEach(v => v.destroy({ children: true })); views.clear(); } },
    setInputEnabled(value) { if (!value) clearInput(); enabled = value; },
    destroy() {
      if (destroyed) return;
      clearInput(); prediction.reset(); destroyed = true; observer.disconnect();
      window.clearInterval(motionTimer);
      window.removeEventListener('keydown', keydown); window.removeEventListener('keyup', keyup); window.removeEventListener('blur', clearInput);
      window.removeEventListener('pointercancel', clearInput); window.removeEventListener('pointerup', endDrag);
      document.removeEventListener('visibilitychange', visibility); document.removeEventListener('focusin', focusChange);
      // Pixi applications share global pools. Releasing them here would break
      // an open FishPreview (and closing a preview would break this scene).
      app.ticker.remove(render); app.destroy({ removeView: true }, { children: true });
      views.clear(); foods.clear(); npcs.clear(); particles.length = 0; buffer.length = 0;
    },
  };
}
