import { Assets, Container, Graphics, Sprite, Text, type Texture } from 'pixi.js';
import type { Appearance, FishSnapshot, PresetId } from '@aquarium/protocol';

const INK = 0x12385b;
const CREAM = 0xfff8e8;
const stroke = { color: INK, width: 3.3, join: 'round' as const, cap: 'round' as const };
interface SkinEntry { users: number; promise: Promise<Texture>; unloading: Promise<void> | null; }
const skinTextures = new Map<string, SkinEntry>();
function retainSkin(url: string) {
  let entry = skinTextures.get(url);
  if (!entry) { entry = { users: 0, promise: Assets.load<Texture>({ src: url, parser: 'texture' }), unloading: null }; skinTextures.set(url, entry); }
  const retained = entry; retained.users++;
  if (retained.unloading) retained.promise = retained.unloading.then(() => Assets.load<Texture>({ src: url, parser: 'texture' }));
  let released = false;
  return { ready: retained.promise, release() {
    if (released) return; released = true; retained.users--;
    if (retained.users !== 0) return;
    void Promise.resolve().then(async () => {
      try {
        await retained.promise;
        if (retained.users || retained.unloading) return;
        retained.unloading = Assets.unload(url); await retained.unloading; retained.unloading = null;
        if (!retained.users && skinTextures.get(url) === retained) skinTextures.delete(url);
      } catch { if (!retained.users && skinTextures.get(url) === retained) skinTextures.delete(url); }
    });
  } };
}
export const PRESET_COLORS: Record<PresetId, [string, string]> = {
  goldfish: ['#ffb84c', '#4c9cec'], clownfish: ['#ff9755', '#ffb75f'],
  puffer: ['#b3df9e', '#76bc9b'], betta: ['#ba99ef', '#9b73e4'],
  angelfish: ['#ffefbc', '#6aa9ed'], ray: ['#75d7e3', '#40b3d4'],
};
export const ANCHORS: Record<PresetId, { face: [number, number]; head: [number, number]; charm: [number, number]; trail: [number, number] }> = {
  goldfish: { face: [24, -9], head: [0, -42], charm: [-12, 35], trail: [-95, 0] },
  clownfish: { face: [27, -7], head: [2, -35], charm: [-10, 31], trail: [-90, 0] },
  puffer: { face: [20, -11], head: [-1, -45], charm: [-15, 38], trail: [-82, 0] },
  betta: { face: [22, -7], head: [0, -35], charm: [-8, 31], trail: [-136, 0] },
  angelfish: { face: [24, -8], head: [-3, -44], charm: [-8, 39], trail: [-90, 0] },
  ray: { face: [18, -7], head: [0, -29], charm: [-20, 30], trail: [-126, 0] },
};
function tint(s: string) { return parseInt(s.replace('#', ''), 16); }
function shade(c: number, amount: number) {
  return [16, 8, 0].reduce((v, shift) => v | Math.max(0, Math.min(255, ((c >> shift) & 255) + amount)) << shift, 0);
}
function outlined(g: Graphics, color: number) { return g.fill(color).stroke(stroke); }
function line(g: Graphics, color = INK, width = 2.4) { return g.stroke({ color, width, cap: 'round', join: 'round' }); }
function bodyOutline(preset: PresetId) {
  const g = new Graphics();
  if (preset === 'betta') return g.ellipse(2, 0, 47, 36);
  if (preset === 'angelfish') return g.moveTo(-38, 0).bezierCurveTo(-34, -40, 16, -53, 43, -16).bezierCurveTo(57, 2, 45, 30, 22, 37).bezierCurveTo(-4, 44, -30, 24, -38, 0).closePath();
  if (preset === 'ray') return g.moveTo(51, 0).bezierCurveTo(16, -29, 2, -56, -23, -50).bezierCurveTo(-20, -24, -36, -12, -58, 1).bezierCurveTo(-32, 18, -20, 43, -13, 50).bezierCurveTo(5, 46, 29, 26, 51, 0).closePath();
  if (preset === 'puffer') return g.ellipse(0, 0, 49, 46);
  return g.ellipse(1, 0, preset === 'clownfish' ? 50 : 47, preset === 'clownfish' ? 32 : 42);
}

/** Every shape is bespoke vector artwork; no reference-image pixels are used. */
export class FishView extends Container {
  readonly visual = new Container();
  readonly guildVisual = new Container();
  readonly aura = new Graphics();
  readonly nameTag = new Container();
  readonly nameBackground = new Graphics();
  readonly nameText = new Text({ text: '', style: { fontFamily: 'Microsoft YaHei, sans-serif', fontSize: 17, fontWeight: 'bold', fill: 0xffffff } });
  readonly hpBar = new Graphics();
  readonly badge = new Text({ text: '', style: { fontFamily: 'sans-serif', fontSize: 14, fontWeight: 'bold', fill: 0xffffff } });
  readonly statusText = new Text({ text: '', style: { fontFamily: 'Microsoft YaHei, sans-serif', fontSize: 25, fontWeight: 'bold', fill: 0xffffff, stroke: { color: INK, width: 4 } } });
  readonly presenceText = new Text({ text: '离线展示', style: { fontFamily: 'Microsoft YaHei, sans-serif', fontSize: 13, fontWeight: 'bold', fill: 0xd9f5fa, stroke: { color: INK, width: 3 } } });
  private appearanceKey = '';
  private bodyMask: Graphics | null = null;
  private lastSkinId: string | null = null;
  private skinGeneration = 0;
  private releaseSkin: (() => void) | null = null;
  private preset: PresetId = 'goldfish';
  private currentAnimation: FishSnapshot['animation'] = 'idle';
  private transientUntil = 0;
  private transient: FishSnapshot['animation'] = 'idle';
  private own = false;
  private chosen = false;
  private hasCharm = false;
  private skinLoadStatus: 'empty' | 'loading' | 'ready' | 'error' = 'empty';
  private guildMarkKey = '';
  snapshot: FishSnapshot;
  target = { x: 0, y: 0 };
  facing: 1 | -1 = 1;

  constructor(snapshot: FishSnapshot, onSelect: (id: string) => void) {
    super();
    this.snapshot = snapshot;
    this.target = { ...snapshot.position };
    this.position.copyFrom(snapshot.position);
    this.addChild(this.aura, this.guildVisual, this.visual, this.nameTag, this.hpBar, this.badge, this.statusText, this.presenceText);
    this.nameTag.addChild(this.nameBackground, this.nameText);
    this.nameText.anchor.set(0.5);
    this.nameTag.y = 65;
    this.badge.anchor.set(0.5);
    this.statusText.anchor.set(0.5);
    this.presenceText.anchor.set(0.5);
    this.badge.y = -72;
    this.eventMode = 'static';
    this.cursor = 'pointer';
    this.on('pointertap', (e) => { e.stopPropagation(); onSelect(this.snapshot.id); });
    this.on('pointerover', () => { this.chosen = true; });
    this.on('pointerout', () => { this.chosen = false; });
    this.setAppearance(snapshot.appearance);
    this.updateSnapshot(snapshot);
  }

  setOwn(value: boolean) { this.own = value; }
  get renderedPreset() { return this.preset; }
  get skinStatus() { return this.skinLoadStatus; }
  setSelected(value: boolean) { this.chosen = value; }
  animate(kind: FishSnapshot['animation'], duration = 450) { this.transient = kind; this.transientUntil = performance.now() + duration; }
  updateSnapshot(s: FishSnapshot, appearanceOverride?: Appearance | null) {
    this.snapshot = s;
    this.target.x = s.position.x; this.target.y = s.position.y;
    this.facing = s.facing === 'left' ? -1 : 1;
    if (this.nameText.text !== s.nickname) {
      this.nameText.text = s.nickname;
      const width = Math.max(90, Math.min(260, this.nameText.width + 24));
      this.nameBackground.clear().roundRect(-width / 2, -15, width, 30, 15).fill({ color: INK, alpha: 0.84 });
    }
    this.setGuildMark(s);
    this.currentAnimation = s.animation;
    this.setAppearance(appearanceOverride ?? s.appearance);
  }

  private setGuildMark(s: FishSnapshot) {
    const mark = s.guildMark ?? null;
    const key = JSON.stringify(mark);
    if (key !== this.guildMarkKey) {
      this.guildMarkKey = key;
      this.guildVisual.removeChildren().forEach(child => child.destroy({ children: true }));
      if (mark) {
        const color = tint(mark.color);
        if (mark.trailItemId) {
          const trail = new Graphics();
          for (let i = 0; i < 4; i++) trail.circle(-72 - i * 15, (i % 2 ? -1 : 1) * (8 + i * 2), 7 - i).fill({ color, alpha: 0.34 - i * 0.045 }).stroke({ color: CREAM, width: 1.2, alpha: 0.55 });
          trail.label = 'guild-trail'; this.guildVisual.addChild(trail);
        }
        if (mark.bannerItemId) {
          const banner = new Graphics();
          banner.moveTo(-14, -29).lineTo(-14, -76).stroke({ color: INK, width: 3, cap: 'round' });
          banner.moveTo(-12, -74).lineTo(24, -68).lineTo(15, -50).lineTo(-12, -56).closePath().fill(color).stroke({ color: INK, width: 2.4, join: 'round' });
          banner.circle(1, -62, 4).fill(CREAM); banner.label = 'guild-banner'; this.guildVisual.addChild(banner);
        }
      }
    }
    this.badge.text = s.team ? `${s.team === 'A' ? '◆' : '●'} ${s.team}队` : mark ? `${mark.badge} ${mark.name}` : s.guildId ? '⚑ 鱼群' : '';
    this.badge.style.fill = mark?.color ?? '#ffffff';
  }

  override destroy(options?: Parameters<Container['destroy']>[0]) {
    if (this.destroyed) return;
    // A fish can leave a scene before the owning Pixi application is torn down.
    // Detach it first so a later parent destroy cannot release text/texture
    // resources for the same view a second time.
    this.removeFromParent();
    this.skinGeneration++;
    this.releaseSkin?.(); this.releaseSkin = null;
    if (this.bodyMask && !this.bodyMask.parent && !this.bodyMask.destroyed) this.bodyMask.destroy();
    super.destroy(options);
  }

  setAppearance(a: Appearance) {
    const key = JSON.stringify(a);
    if (key === this.appearanceKey) return;
    this.appearanceKey = key; this.preset = a.presetId;
    this.skinGeneration++; this.skinLoadStatus = 'empty';
    this.releaseSkin?.(); this.releaseSkin = null;
    if (this.bodyMask && !this.bodyMask.parent) this.bodyMask.destroy();
    this.visual.removeChildren().forEach(c => c.destroy({ children: true }));
    // Recreate layers so changing an appearance cannot leak prior graphics or texture sprites.
    const tail = new Graphics(); const rear = new Graphics(); const body = bodyOutline(a.presetId);
    const pattern = new Graphics(); const fin = new Graphics(); const face = new Container(); const accessories = new Graphics();
    const tailLayer = new Container(); tailLayer.addChild(tail);
    const finLayer = new Container(); finLayer.addChild(fin);
    this.visual.addChild(tailLayer, rear, body, pattern, finLayer, face, accessories);
    this.visual.label = a.presetId;
    tailLayer.label = 'tail'; finLayer.label = 'fin'; face.label = 'face';
    const color = tint(a.bodyColor || PRESET_COLORS[a.presetId][0]);
    const finColor = tint(a.finColor || PRESET_COLORS[a.presetId][1]);
    const pale = shade(color, 47); const dark = shade(color, -32);
    const p = a.presetId;
    outlined(body, color);

    if (p === 'betta') {
      outlined(tail.moveTo(-31, 0).bezierCurveTo(-72, -66, -123, -58, -93, -19).bezierCurveTo(-124, -25, -128, 24, -91, 21).bezierCurveTo(-122, 69, -67, 58, -30, 15).closePath(), finColor);
      tail.moveTo(-35, 3).bezierCurveTo(-60, -31, -83, -36, -99, -32); line(tail, shade(finColor, 40));
      tail.moveTo(-35, 3).bezierCurveTo(-62, 5, -91, 7, -112, 4); line(tail, shade(finColor, -25));
      tail.moveTo(-35, 3).bezierCurveTo(-55, 32, -78, 37, -94, 42); line(tail, shade(finColor, 40));
      outlined(rear.moveTo(-28, -24).bezierCurveTo(-47, -58, -15, -68, 5, -46).bezierCurveTo(-8, -47, -7, -29, 15, -24), finColor);
      outlined(rear.moveTo(-29, 18).bezierCurveTo(-36, 55, -7, 62, 15, 34).lineTo(25, 20), finColor);
      body.ellipse(12, 12, 35, 22).fill({ color: pale, alpha: 0.64 });
    } else if (p === 'angelfish') {
      outlined(tail.moveTo(-29, 0).bezierCurveTo(-52, -20, -78, -37, -80, -26).lineTo(-70, 0).lineTo(-80, 26).bezierCurveTo(-74, 40, -45, 17, -28, 10).closePath(), CREAM);
      outlined(rear.moveTo(-24, -12).bezierCurveTo(-35, -63, -61, -84, -64, -85).bezierCurveTo(-5, -82, 22, -42, 29, -17).lineTo(-8, 0).closePath(), finColor);
      outlined(rear.moveTo(-24, 11).bezierCurveTo(-32, 54, -58, 78, -64, 82).bezierCurveTo(-13, 79, 23, 48, 30, 18).lineTo(-8, 0).closePath(), finColor);
      rear.moveTo(-51, -74).bezierCurveTo(-18, -48, -20, -12, -16, 6).bezierCurveTo(-20, 32, -34, 64, -51, 73); line(rear, 0xffd162, 9);
      pattern.moveTo(-17, -33).bezierCurveTo(-8, -11, -10, 18, -23, 26).lineTo(-34, 4).lineTo(-29, -18).closePath().fill(finColor);
      pattern.moveTo(0, -39).bezierCurveTo(12, -15, 10, 21, 0, 36).lineTo(-10, 30).bezierCurveTo(1, 5, -4, -21, -11, -35).closePath().fill(finColor);
      outlined(fin.moveTo(13, 26).lineTo(24, 41).lineTo(15, 72).lineTo(5, 46).closePath(), 0x348bd3);
    } else if (p === 'ray') {
      tail.moveTo(-25, 0).bezierCurveTo(-71, -20, -78, 40, -110, 30); line(tail, INK, 6);
      body.moveTo(45, 3).bezierCurveTo(9, 9, -12, 20, -15, 42).bezierCurveTo(8, 42, 33, 20, 45, 3).fill(pale);
      pattern.moveTo(-18, -43).bezierCurveTo(-9, -17, -26, -5, -41, 0); line(pattern, dark, 2);
      pattern.moveTo(-12, 43).bezierCurveTo(-7, 19, -26, 7, -40, 3); line(pattern, dark, 2);
      for (let i = 0; i < 5; i++) pattern.ellipse(-15 + i * 8, -15 + (i % 2) * 9, 3, 2).fill({ color: pale, alpha: 0.7 });
    } else if (p === 'puffer') {
      outlined(tail.moveTo(-39, -6).bezierCurveTo(-55, -25, -80, -24, -69, -4).bezierCurveTo(-81, 14, -58, 28, -40, 12).closePath(), finColor);
      for (let i = 0; i < 14; i++) {
        const a1 = i / 14 * Math.PI * 2;
        const x = Math.cos(a1) * 48, y = Math.sin(a1) * 44;
        outlined(rear.poly([x - Math.sin(a1) * 5, y + Math.cos(a1) * 5, x * 1.18, y * 1.18, x + Math.sin(a1) * 5, y - Math.cos(a1) * 5]), color);
      }
      body.moveTo(-45, 8).bezierCurveTo(-18, 18, 21, 13, 44, 4).bezierCurveTo(44, 61, -40, 63, -45, 8).fill(CREAM);
      for (let i = 0; i < 11; i++) { const a1 = i * 2.4; pattern.circle(Math.cos(a1) * (28 + i % 3 * 6), -18 + Math.sin(a1) * 17, 2.2).fill(dark); }
      outlined(fin.moveTo(-13, 8).bezierCurveTo(-38, -8, -43, 10, -16, 20).closePath(), finColor);
    } else {
      const clown = p === 'clownfish';
      outlined(tail.moveTo(-34, 0).bezierCurveTo(-56, -37, -83, -43, -83, -27).bezierCurveTo(-80, -13, -70, -9, -72, 1).bezierCurveTo(-83, 15, -91, 34, -73, 33).bezierCurveTo(-55, 32, -44, 20, -32, 9).closePath(), finColor);
      tail.moveTo(-37, 1).lineTo(-75, -24); line(tail, shade(finColor, 45), 2);
      tail.moveTo(-37, 6).lineTo(-72, 25); line(tail, shade(finColor, -25), 2);
      tail.moveTo(-43, 2).quadraticCurveTo(-62, -7, -79, -8); line(tail, shade(finColor, 32), 1.8);
      tail.moveTo(-43, 5).quadraticCurveTo(-63, 10, -79, 13); line(tail, shade(finColor, -20), 1.6);
      if (!clown) tail.scale.set(1.08, 1.13);
      outlined(rear.moveTo(-23, -23).bezierCurveTo(-37, -44, -26, -57, 0, -49).bezierCurveTo(13, -44, 17, -29, 17, -25).closePath(), finColor);
      outlined(rear.moveTo(-18, 23).bezierCurveTo(-25, 44, -3, 49, 18, 29).closePath(), finColor);
      body.ellipse(13, 16, 32, clown ? 14 : 23).fill(pale);
      if (clown || a.patternId === 'stripes') {
        [-21, 1].forEach((x) => {
          pattern.moveTo(x, -30).bezierCurveTo(x + 8, -8, x + 4, 12, x - 1, 29).lineTo(x - 11, 24).bezierCurveTo(x - 3, 4, x - 5, -14, x - 10, -26).closePath().fill(clown ? CREAM : dark);
        });
      } else if (a.patternId === 'spots') {
        for (let i = 0; i < 6; i++) pattern.circle(-27 + i % 3 * 15, -21 + Math.floor(i / 3) * 21, 5).fill(dark);
      } else if (a.patternId !== 'none' && a.patternId !== 'belly') {
        pattern.moveTo(-29, -24).bezierCurveTo(-31, -12, -32, 8, -25, 20); line(pattern, shade(color, -25), 6);
        pattern.moveTo(-18, -33).bezierCurveTo(-23, -15, -21, 13, -11, 30); line(pattern, shade(color, -15), 5);
      }
      outlined(fin.moveTo(-2, 16).bezierCurveTo(-27, 16, -25, 40, -6, 32).bezierCurveTo(4, 26, 8, 18, -2, 16).closePath(), finColor);
      fin.moveTo(-2, 20).lineTo(-15, 30); line(fin, shade(finColor, 45), 1.7);
    }

    // User patterns apply to every body shape. Natural species markings remain beneath them.
    if (!['goldfish', 'clownfish'].includes(p) && a.patternId === 'stripes') {
      for (const x of [-22, 0]) pattern.moveTo(x, -50).bezierCurveTo(x + 9, -12, x + 8, 20, x - 4, 50).lineTo(x - 14, 50).bezierCurveTo(x - 2, 17, x - 3, -15, x - 12, -50).closePath().fill({ color: dark, alpha: 0.45 });
    }
    if (!['goldfish', 'clownfish'].includes(p) && a.patternId === 'spots') {
      for (let i = 0; i < 7; i++) pattern.circle(-25 + i % 3 * 17, -25 + Math.floor(i / 3) * 19, 4.5).fill({ color: dark, alpha: 0.55 });
    }
    if (a.patternId === 'belly') pattern.ellipse(8, 22, 37, 25).fill({ color: CREAM, alpha: 0.75 });
    const patternMask = this.makeBodyMask(p); patternMask.label = 'body-pattern-mask'; this.visual.addChild(patternMask); pattern.mask = patternMask;

    // The highlight adds a clear second colour plane without soft image shadows.
    body.ellipse(-8, p === 'puffer' ? -27 : -22, p === 'ray' ? 11 : 17, 5).fill({ color: 0xffffff, alpha: 0.32 });
    const eye = ANCHORS[p].face;
    const eyes = new Graphics();
    eyes.ellipse(eye[0] - 10, eye[1], 10, 12).fill(CREAM);
    eyes.ellipse(eye[0] + 10, eye[1] + 2, 10, 12).fill(CREAM);
    eyes.ellipse(eye[0] - 6, eye[1] + 4, 4.3, 6.5).fill(INK);
    eyes.ellipse(eye[0] + 14, eye[1] + 5, 4.3, 6.5).fill(INK);
    // Half-lidded office-fish expressions, matching the reference's relaxed character.
    eyes.moveTo(eye[0] - 20, eye[1] - 4).lineTo(eye[0] - 1, eye[1] - 3); line(eyes, INK, 2.3);
    eyes.moveTo(eye[0] + 1, eye[1] - 2).lineTo(eye[0] + 20, eye[1]); line(eyes, INK, 2.3);
    const mouth = new Graphics().moveTo(eye[0] + 5, eye[1] + 21).quadraticCurveTo(eye[0] + 9, eye[1] + 18, eye[0] + 13, eye[1] + 21); line(mouth, INK, 2.3);
    mouth.label = 'mouth';
    face.addChild(eyes, mouth);
    face.addChild(new Graphics().ellipse(eye[0] - 18, eye[1] + 17, 7, 4).ellipse(eye[0] + 24, eye[1] + 17, 5, 3).fill({ color: 0xffb2a0, alpha: 0.7 }));

    const eq = a.equipped || {};
    this.hasCharm = !!eq.charm;
    if (eq.face) {
      accessories.circle(eye[0] - 10, eye[1], 15).circle(eye[0] + 14, eye[1] + 1, 15).fill({ color: 0xc9f6fa, alpha: 0.18 }).stroke({ color: INK, width: 3 });
      accessories.moveTo(eye[0] + 4, eye[1] - 2).lineTo(eye[0] + 1, eye[1] - 2); line(accessories, INK, 3);
      accessories.moveTo(eye[0] - 26, eye[1] - 3).lineTo(-17, -14); line(accessories, INK, 3);
      accessories.moveTo(eye[0] - 19, eye[1] - 7).lineTo(eye[0] - 12, eye[1] - 11); line(accessories, 0xffffff, 2);
    }
    const head = ANCHORS[p].head;
    const headShift = head[1] + 42;
    if (eq.head === 'headphones.basic') {
      accessories.moveTo(-27, -2 + headShift).bezierCurveTo(-42, -64 + headShift, 31, -61 + headShift, 29, -4 + headShift); line(accessories, INK, 10);
      accessories.moveTo(-27, -2 + headShift).bezierCurveTo(-40, -62 + headShift, 31, -59 + headShift, 29, -4 + headShift); line(accessories, 0x79a6c2, 5);
      outlined(accessories.roundRect(-35, -15 + headShift, 16, 29, 7), 0x285b7b);
      accessories.ellipse(-27, -1 + headShift, 4, 7).fill(0xffd567);
    } else if (eq.head) {
      outlined(accessories.moveTo(head[0] - 29, head[1] + 4).quadraticCurveTo(head[0], head[1] - 33, head[0] + 25, head[1] + 3).closePath(), 0x65c9db);
      accessories.ellipse(head[0] + 28, head[1] + 5, 12, 4).fill(0xffd56c).stroke(stroke);
      accessories.circle(head[0] + 9, head[1] - 4, 4).fill(INK);
    }
    if (eq.outfit) {
      outlined(accessories.moveTo(-21, -35 + headShift).lineTo(-30, -50 + headShift).quadraticCurveTo(0, -76 + headShift, 31, -47 + headShift).lineTo(24, -32 + headShift).closePath(), 0x24465f);
      accessories.circle(0, -50 + headShift, 5).fill(CREAM).roundRect(-3, -45 + headShift, 6, 4, 1).fill(CREAM);
      accessories.moveTo(-9, -52 + headShift).lineTo(9, -39 + headShift).moveTo(9, -52 + headShift).lineTo(-9, -39 + headShift); line(accessories, CREAM, 2);
      accessories.circle(eye[0] + 12, eye[1] + 2, 10).fill(INK);
      accessories.moveTo(-25, -18).lineTo(41, 4); line(accessories, INK, 2.2);
    }
    if (eq.charm) {
      const [x, y] = ANCHORS[p].charm;
      accessories.moveTo(x, y - 7).lineTo(x, y + 22); line(accessories, INK, 2);
      accessories.moveTo(x, y + 22).bezierCurveTo(x - 17, y + 8, x - 12, y - 3, x, y + 4).bezierCurveTo(x + 13, y - 3, x + 18, y + 11, x, y + 22).fill(0x86cfa2).stroke({ ...stroke, width: 1.5 });
    }
    if (eq.trail) {
      const stars = new Graphics();
      for (let j = 0; j < 3; j++) {
        const points: number[] = [], x = ANCHORS[p].trail[0] - j * 13, y = (j % 2 ? -1 : 1) * 13;
        for (let i = 0; i < 8; i++) { const angle = i * Math.PI / 4, r = (i % 2 ? 2.1 : 5.2) * (1 - j * 0.15); points.push(x + Math.cos(angle) * r, y + Math.sin(angle) * r); }
        stars.poly(points).fill({ color: 0xffe0a0, alpha: 0.8 - j * 0.15 });
      }
      this.visual.addChildAt(stars, 0);
    }
    const mask = this.makeBodyMask(p);
    this.bodyMask = mask;
    this.lastSkinId = null;
    if (a.skinAssetId) void this.loadSkin(a.skinAssetId, pattern);
  }

  private makeBodyMask(p: PresetId) {
    const mask = bodyOutline(p).fill(0xffffff); mask.scale.set(0.94); return mask;
  }
  private async loadSkin(id: string, after: Graphics) {
    const gen = this.skinGeneration; this.skinLoadStatus = 'loading';
    this.lastSkinId = id;
    const lease = retainSkin(`/api/assets/${encodeURIComponent(id)}`);
    this.releaseSkin = lease.release;
    try {
      const texture = await lease.ready;
      if (!texture?.source) throw new Error('贴图未解码');
      if (this.destroyed || gen !== this.skinGeneration || this.lastSkinId !== id || !this.bodyMask) return;
      const skin = new Sprite(texture); skin.label = 'body-skin'; skin.anchor.set(0.5);
      const mask = this.bodyMask; mask.label = 'body-skin-mask'; const bounds = mask.getLocalBounds(), scale = 0.94;
      skin.scale.set(Math.max(bounds.width * scale / texture.width, bounds.height * scale / texture.height));
      skin.position.set((bounds.x + bounds.width / 2) * scale, (bounds.y + bounds.height / 2) * scale);
      this.visual.addChildAt(skin, this.visual.getChildIndex(after));
      this.visual.addChild(mask); skin.mask = mask; skin.alpha = 0.86; this.skinLoadStatus = 'ready';
    } catch { if (this.releaseSkin === lease.release) { lease.release(); this.releaseSkin = null; } if (!this.destroyed && gen === this.skinGeneration) { this.skinLoadStatus = 'error'; this.emit('skin-error', id); } }
  }

  update(dt: number, time: number, reduced: boolean, serverNow: number, inArena: boolean, smoothPosition = true) {
    const s = this.snapshot;
    const animation = performance.now() < this.transientUntil ? this.transient : this.currentAnimation;
    const speed = Math.hypot(s.velocity.x, s.velocity.y);
    const wiggle = reduced ? 0 : Math.sin(time * (speed > 15 ? 9 : 3) + this.target.x) * (speed > 15 ? 0.12 : 0.055);
    const tail = this.visual.children.find(c => c.label === 'tail');
    const fin = this.visual.children.find(c => c.label === 'fin');
    if (tail) { tail.rotation = wiggle; tail.scale.y = 1 + wiggle; }
    if (fin) fin.rotation = -wiggle * 1.9;
    const size = inArena ? 0.65 : Math.max(0.65, Math.min(1.8, s.displaySize || 1));
    const dash = animation === 'dash' ? 1.15 : animation === 'hit' ? 0.82 : 1;
    const eat = animation === 'eat' ? 1.04 + Math.sin(time * 24) * 0.04 : 1;
    this.visual.scale.set(this.facing * size * dash * eat, size / dash * eat);
    this.visual.rotation = reduced ? 0 : animation === 'defeat' ? 0.35 : animation === 'victory' ? Math.sin(time * 6) * 0.15 : Math.max(-0.15, Math.min(0.15, s.velocity.y / 900));
    const stateAlpha = animation === 'bubble' ? 0.5 : animation === 'hit' ? (Math.sin(time * 50) > 0 ? 0.6 : 1) : 1;
    const presenceAlpha = !s.interactive && !inArena ? 0.48 : 1;
    this.visual.alpha = stateAlpha * presenceAlpha;
    this.guildVisual.scale.copyFrom(this.visual.scale);
    this.guildVisual.rotation = this.visual.rotation;
    this.guildVisual.alpha = this.visual.alpha;
    this.statusText.text = s.respawnAtServerMs !== null && s.respawnAtServerMs > serverNow ? String(Math.max(1, Math.ceil((s.respawnAtServerMs - serverNow) / 1000))) : '';
    this.nameTag.visible = this.own || this.chosen || !!s.team;
    this.nameTag.y = ((this.preset === 'angelfish' ? 87 : 65) + (this.hasCharm ? 20 : 0)) * size;
    this.presenceText.visible = !s.interactive && !inArena;
    this.presenceText.y = this.nameTag.y + 24;
    this.badge.y = -67 * size;
    const aura = this.aura.clear();
    if (this.own) aura.ellipse(0, 64 * size, 45 * size, 8).fill({ color: 0x6cf2df, alpha: 0.16 }).stroke({ color: 0xc9fff0, width: 1.5, alpha: 0.65 });
    if (s.shieldUntilServerMs > serverNow || animation === 'bubble') {
      aura.circle(0, 0, 63 * size).fill({ color: 0xa5f3ff, alpha: 0.13 }).stroke({ color: animation === 'bubble' ? 0xffffff : 0x9cffff, width: 3, alpha: 0.85 });
      aura.arc(0, 0, 55 * size, -2.5, -1.6).stroke({ color: 0xffffff, width: 4, alpha: 0.7 });
    }
    this.hpBar.clear();
    if (s.hp !== null && s.maxHp) {
      this.hpBar.roundRect(-35, -53 * size, 70, 6, 3).fill({ color: INK, alpha: 0.7 });
      this.hpBar.roundRect(-34, -53 * size + 1, 68 * Math.max(0, s.hp / s.maxHp), 4, 2).fill(s.team === 'B' ? 0xffaf8f : 0x91edb8);
    }
    const factor = smoothPosition ? Math.min(1, dt * 13) : 1;
    this.position.x += (this.target.x - this.position.x) * factor;
    this.position.y += (this.target.y - this.position.y) * factor;
  }
}
