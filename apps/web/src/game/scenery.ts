import { Container, Graphics, Rectangle } from 'pixi.js';
import { config } from '@aquarium/core';

function blend(a: number, b: number, t: number) {
  return [16, 8, 0].reduce((v, sh) => v | Math.round(((a >> sh) & 255) * (1 - t) + ((b >> sh) & 255) * t) << sh, 0);
}
function stone(x: number, y: number, w: number, h: number, color = 0x376a83) {
  const g = new Graphics();
  g.poly([x - w / 2, y, x - w * 0.39, y - h * 0.65, x - w * 0.13, y - h, x + w * 0.26, y - h * 0.89, x + w / 2, y - h * 0.34, x + w * 0.42, y]).fill(color);
  g.poly([x - w * 0.39, y - h * 0.65, x - w * 0.13, y - h, x + w * 0.26, y - h * 0.89, x + w * 0.05, y - h * 0.67]).fill(blend(color, 0xa3d8d9, 0.32));
  g.poly([x - w * 0.13, y - h * 0.67, x + w * 0.26, y - h * 0.89, x + w / 2, y - h * 0.34, x + w * 0.42, y, x + w * 0.12, y]).fill(blend(color, 0x163f62, 0.3));
  g.moveTo(x - w * 0.1, y - h * 0.6).lineTo(x + w * 0.04, y - h * 0.27).lineTo(x, y - h * 0.1).stroke({ color: 0x123b5b, width: 3, alpha: 0.5 });
  return g;
}
function seagrass(x: number, y: number, height: number, color: number, count = 5) {
  const c = new Container();
  for (let i = 0; i < count; i++) {
    const g = new Graphics(); const h = height * (0.65 + (i * 17 % 9) / 18);
    const dx = (i - count / 2) * 15; const bend = (i % 2 ? -1 : 1) * 28;
    g.moveTo(x + dx, y).bezierCurveTo(x + dx + bend - 8, y - h * 0.4, x + dx - bend, y - h * 0.7, x + dx + bend * 0.5, y - h)
      .bezierCurveTo(x + dx + bend * 0.5 + 16, y - h * 0.82, x + dx - bend + 20, y - h * 0.65, x + dx + bend + 13, y - h * 0.4)
      .bezierCurveTo(x + dx + 20, y - h * 0.12, x + dx + 14, y, x + dx, y).fill(i % 2 ? blend(color, 0x94d296, 0.22) : color);
    g.moveTo(x + dx + 6, y - 10).bezierCurveTo(x + dx + bend + 2, y - h * 0.4, x + dx - bend + 4, y - h * 0.7, x + dx + bend * 0.5 + 4, y - h * 0.9).stroke({ color: 0xc2e6a4, width: 1.7, alpha: 0.25 });
    c.addChild(g);
  }
  return c;
}
function coral(x: number, y: number, scale: number, color: number, variant = 0) {
  const g = new Graphics();
  const b = (ax: number, ay: number, bx: number, by: number, width: number) => {
    g.moveTo(ax, ay).quadraticCurveTo((ax + bx) / 2 - 4, (ay + by) / 2, bx, by).stroke({ color: blend(color, 0x734b86, 0.23), width: width + 5, cap: 'round' });
    g.moveTo(ax, ay).quadraticCurveTo((ax + bx) / 2 - 4, (ay + by) / 2, bx, by).stroke({ color, width, cap: 'round' });
    g.circle(bx, by, width / 2).fill(blend(color, 0xffeee0, 0.36));
  };
  b(0, 0, -6, -95, 14); b(-4, -28, -44, -58, 12); b(-33, -50, -40, -83, 10);
  b(-5, -48, 30, -77, 12); b(25, -70, 52, -74, 9); b(-6, -75, 11, -112, 10);
  b(-6, -85, -25, -113, 9); b(0, -17, 40, -42, 13); b(31, -36, 35, -62, 9);
  if (variant) { b(5, -7, 58, -21, 10); b(50, -18, 65, -45, 8); }
  g.position.set(x, y); g.scale.set(scale); return g;
}
function tube(x: number, y: number, height: number, angle = 0) {
  const g = new Graphics();
  g.moveTo(-15, 0).lineTo(-19, -height).quadraticCurveTo(0, -height - 13, 19, -height).lineTo(14, 0).closePath().fill(0xf1aa50).stroke({ color: 0xdf854a, width: 3 });
  g.ellipse(0, -height, 19, 8).fill(0xffd979).stroke({ color: 0xffe6a2, width: 3 });
  g.ellipse(0, -height, 12, 4.5).fill(0xb46c3e);
  g.moveTo(-7, -8).lineTo(-8, -height + 12).stroke({ color: 0xffdc80, width: 4, alpha: 0.6 });
  g.position.set(x, y); g.rotation = angle; return g;
}
function miniFish(x: number, y: number, size: number, color: number) {
  const g = new Graphics();
  g.ellipse(0, 0, 19, 8).poly([-15, 0, -30, -10, -26, 0, -30, 10]).fill(color);
  g.circle(10, -2, 1.5).fill({ color: 0x133b5c, alpha: 0.7 });
  g.position.set(x, y); g.scale.set(size); return g;
}

export interface Scenery { root: Container; rays: Container; bubbles: Container; setQuality(quality: 'normal' | 'low'): void; update(time: number, reduced: boolean): void; }
/** World-space layers preserve the central playfield while framing the tank with coral. */
export function createScenery(): Scenery {
  const root = new Container(); const back = new Container(); const rays = new Container();
  const far = new Container(); const mid = new Container(); const floor = new Container(); const front = new Container();
  const staticDecor = new Container(); staticDecor.addChild(far, mid, floor, front);
  const bubbles = new Container();
  root.addChild(back, rays, staticDecor, bubbles);
  const water = new Graphics();
  for (let y = 0; y < 1080; y += 8) water.rect(0, y, 1920, 9).fill(blend(0x45d5e6, 0x087fac, y / 1080));
  back.addChild(water);
  for (let i = 0; i < 7; i++) {
    const x = 190 + i * 270; const g = new Graphics();
    // Feather both the sides and the depth; shafts must never form a hard floor line.
    for (let depth = 0; depth < 18; depth++) {
      const y0 = depth * 60 - 25, y1 = y0 + 62;
      const shift0 = y0 * 0.25, shift1 = y1 * 0.25;
      for (let feather = 0; feather < 3; feather++) {
        const halfWidth = 14 + feather * 16;
        const alpha = (1 - depth / 18) * (feather === 0 ? 0.018 : 0.009);
        g.poly([x - halfWidth - shift0, y0, x + halfWidth - shift0, y0, x + halfWidth + 35 - shift1, y1, x - halfWidth - 35 - shift1, y1]).fill({ color: 0xd3fff4, alpha });
      }
    }
    rays.addChild(g);
  }
  const surface = new Graphics();
  for (let i = 0; i < 18; i++) {
    const x = (i * 173) % 1920; const y = (i * 31) % 115;
    surface.ellipse(x, y, 65 + i % 4 * 23, 3 + i % 3 * 2).fill({ color: 0xd0fff6, alpha: 0.16 });
  }
  back.addChild(surface);
  // Far ruins remain deliberately low contrast and do not create physical obstacles.
  const ruins = new Graphics().poly([0, 700, 80, 560, 220, 590, 295, 680, 365, 725, 405, 850, 0, 900]).fill({ color: 0x317f9c, alpha: 0.45 });
  ruins.poly([1920, 440, 1830, 390, 1740, 468, 1660, 690, 1585, 780, 1920, 850]).fill({ color: 0x277e9d, alpha: 0.5 });
  ruins.roundRect(1350, 596, 46, 237, 12).roundRect(1520, 568, 42, 270, 12).fill({ color: 0x5aa5b5, alpha: 0.25 });
  ruins.moveTo(1324, 600).lineTo(1586, 574).lineTo(1581, 612).lineTo(1331, 633).closePath().fill({ color: 0x82bac1, alpha: 0.2 });
  far.addChild(ruins);
  for (let i = 0; i < 14; i++) {
    const x = i < 7 ? 30 + i * 48 : 1600 + (i - 7) * 48;
    far.addChild(seagrass(x, 850 + i % 3 * 30, 130 + i % 4 * 35, 0x278aa1, 3));
  }
  for (let i = 0; i < 22; i++) {
    const x = 50 + (i * 173) % 1810, y = 220 + (i * 137) % 540;
    far.addChild(miniFish(x, y, 0.6 + i % 4 * 0.13, i % 2 ? 0x4baec0 : 0x3395ad));
  }
  mid.addChild(stone(40, 867, 390, 270, 0x347590), stone(180, 930, 300, 195, 0x3c7b94));
  mid.addChild(stone(1870, 850, 390, 350, 0x32728f), stone(1690, 930, 310, 180, 0x4088a0));
  mid.addChild(seagrass(80, 907, 296, 0x399d83, 7), seagrass(1820, 917, 330, 0x41a389, 8));
  mid.addChild(seagrass(285, 935, 200, 0x4baf94, 4), seagrass(1585, 935, 185, 0x58b59c, 4));
  const sand = new Graphics();
  sand.moveTo(0, 935).bezierCurveTo(360, 850, 600, 1000, 960, 938).bezierCurveTo(1310, 870, 1570, 955, 1920, 877).lineTo(1920, 1080).lineTo(0, 1080).closePath().fill(0xf4ddb0);
  sand.moveTo(0, 945).bezierCurveTo(360, 873, 600, 1025, 960, 960).bezierCurveTo(1310, 899, 1570, 981, 1920, 897).lineTo(1920, 923).bezierCurveTo(1550, 1000, 1300, 918, 960, 976).bezierCurveTo(600, 1042, 360, 900, 0, 965).closePath().fill(0xffedc9);
  sand.moveTo(0, 1026).bezierCurveTo(470, 980, 1260, 1060, 1920, 995).lineTo(1920, 1080).lineTo(0, 1080).closePath().fill(0xeccf9c);
  floor.addChild(sand);
  const grains = new Graphics();
  for (let i = 0; i < 95; i++) grains.ellipse((i * 113.1) % 1920, 960 + i * 13 % 115, 1.2 + i % 3, 1).fill({ color: i % 2 ? 0xffffff : 0xbba780, alpha: 0.4 });
  floor.addChild(grains);
  front.addChild(coral(223, 956, 1.5, 0xec8da2, 1), coral(1694, 948, 1.55, 0xb496dd), coral(1766, 936, 1.0, 0x83b9d2, 1));
  front.addChild(tube(113, 930, 116, -0.11), tube(153, 939, 77, 0.2), tube(76, 939, 60, -0.25));
  front.addChild(stone(8, 1080, 250, 210, 0x42677e), stone(1915, 1080, 270, 222, 0x426b84));
  front.addChild(seagrass(33, 1080, 195, 0x5aa77f, 5), seagrass(1888, 1080, 233, 0x75b682, 5));
  for (let i = 0; i < 15; i++) {
    const x = 280 + (i * 117) % 1330;
    floor.addChild(stone(x, 1015 + i % 3 * 19, 19 + i % 5 * 8, 9 + i % 4 * 7, 0x8ca6ab));
  }
  // Starfish and shell are foreground illustrations, never pick-up targets.
  const star = new Graphics();
  const points: number[] = [];
  for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5; const r = i % 2 ? 12 : 31; points.push(Math.cos(a) * r, Math.sin(a) * r); }
  star.poly(points).fill(0xf1a36b).stroke({ color: 0xd88a61, width: 2 });
  for (let i = 0; i < 5; i++) star.circle(Math.cos(i * 1.256) * 8, Math.sin(i * 1.256) * 8, 1.5).fill(0xffd59a);
  star.position.set(230, 1030); star.rotation = 0.2; front.addChild(star);
  for (let i = 0; i < 38; i++) {
    const g = new Graphics(); const r = 2 + i % 5;
    g.circle(0, 0, r).stroke({ color: 0xcafffa, width: 1.3, alpha: 0.65 }).circle(-r * 0.3, -r * 0.3, r * 0.22).fill({ color: 0xffffff, alpha: 0.9 });
    g.position.set(85 + i * 97 % 1780, i * 83 % 1000); bubbles.addChild(g);
  }
  function setQuality(quality: 'normal' | 'low') {
    const low = quality === 'low';
    // Explicit bounds prevent off-canvas rocks/ellipses producing textures above 4096 px.
    // Bubbles and the parent ray alpha remain dynamic outside these static caches.
    for (const [layer, requested] of [[back, low ? 0.75 : 1], [rays, low ? 0.75 : 1], [staticDecor, low ? 1 : 1.5]] as const) {
      layer.boundsArea = new Rectangle(0, 0, 1920, 1080);
      layer.cacheAsTexture(false);
      layer.cacheAsTexture({ resolution: Math.min(requested, 4096 / 1920, 4096 / 1080), antialias: false });
    }
    bubbles.children.forEach((bubble, i) => { bubble.visible = !low || i % 3 === 0; });
  }
  setQuality('normal');
  return { root, rays, bubbles, setQuality, update(time, reduced) {
    if (reduced) return;
    rays.alpha = 0.8 + Math.sin(time * 0.3) * 0.12;
    bubbles.children.forEach((b, i) => { b.y = 1020 - ((time * (11 + i % 5 * 3) + i * 83) % 1050); b.x = 85 + i * 97 % 1780 + Math.sin(time + i) * 6; });
  } };
}

export function createArena(kind: 'DUEL' | 'TEAM') {
  const c = new Container(); const team = kind === 'TEAM'; const arena = team ? config.battle.teamArena : config.battle.duelArena;
  const { width, height, radius } = arena;
  const g = new Graphics().rect(0, 0, width, height).fill(0x145575);
  g.circle(width / 2, height / 2, radius + 7).fill(0x75c5cf).circle(width / 2, height / 2, radius).fill(0x27849a);
  for (let r = 50; r < radius; r += 55) g.circle(width / 2, height / 2, r).stroke({ color: 0xa5e2dc, width: 1, alpha: 0.09 });
  g.moveTo(width / 2, height / 2 - radius).lineTo(width / 2, height / 2 + radius).stroke({ color: 0xd2f2e9, width: 2, alpha: 0.23 });
  const obstacles = arena.obstacles.map(o => [o.x, o.y, o.radius]);
  c.addChild(g);
  obstacles.forEach(([x, y, r]) => { c.addChild(new Graphics().circle(x!, y!, r!).fill(0x657e99).stroke({ color: 0xa1bcc8, width: 4 }), coral(x!, y! + 12, r! / 70, 0xe993aa)); });
  const xs = [arena.spawnsA[0]!.x, arena.spawnsB[0]!.x];
  xs.forEach((x, i) => c.addChild(new Graphics().circle(x!, height / 2, 38).fill({ color: i ? 0xffa78e : 0x89e6de, alpha: 0.2 }).stroke({ color: i ? 0xffa78e : 0x89e6de, width: 2, alpha: 0.6 })));
  c.boundsArea = new Rectangle(0, 0, width, height);
  c.cacheAsTexture({ resolution: 1, antialias: false });
  return c;
}
