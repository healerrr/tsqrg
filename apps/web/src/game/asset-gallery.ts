import { Application, Graphics, Text } from 'pixi.js';
import type { Appearance, FishSnapshot, PresetId } from '@aquarium/protocol';
import { config } from '@aquarium/core';
import { FishView, PRESET_COLORS } from './fish';

/** Dedicated developer QA view, loaded only by tests/ui-assets.mjs, never by the game entry. */
export async function createAssetGallery(host: HTMLElement) {
  const presets = Object.keys(PRESET_COLORS) as PresetId[];
  const names: Record<PresetId, string> = { goldfish: '金鱼', clownfish: '小丑鱼', puffer: '河豚', betta: '斗鱼', angelfish: '神仙鱼', ray: '鳐鱼' };
  const catalog = config.catalog.filter(i => i.scope === 'PERSONAL');
  const cellWidth = 165, cellHeight = 175, left = 90, top = 90;
  const app = new Application();
  await app.init({ width: left + cellWidth * 12 + 10, height: top + cellHeight * 6 + 20, resolution: 1, antialias: true, background: 0xd9f2f3 });
  host.appendChild(app.canvas); app.ticker.stop();
  const title = new Text({ text: '六种鱼型 × 六种配饰 × 左右朝向 · 正式 FishView 渲染', style: { fontFamily: 'Microsoft YaHei, sans-serif', fontSize: 26, fontWeight: 'bold', fill: 0x12385b } });
  title.position.set(28, 18); app.stage.addChild(title);
  const checks: Array<{ preset: PresetId; item: string; facing: string; visualScaleX: number; labelScaleX: number }> = [];
  presets.forEach((preset, row) => {
    const rowName = new Text({ text: names[preset], style: { fontFamily: 'Microsoft YaHei, sans-serif', fontSize: 18, fontWeight: 'bold', fill: 0x33566d } }); rowName.position.set(12, top + row * cellHeight + 63); app.stage.addChild(rowName);
    catalog.forEach((item, col) => {
      for (const [side, facing] of ['left', 'right'].entries()) {
        const x = left + (col * 2 + side) * cellWidth, y = top + row * cellHeight;
        app.stage.addChild(new Graphics().roundRect(x + 3, y + 3, cellWidth - 6, cellHeight - 6, 12).fill({ color: 0xffffff, alpha: (row + col) % 2 ? 0.32 : 0.6 }));
        if (row === 0) {
          const label = new Text({ text: `${item.name} ${facing === 'left' ? '←' : '→'}`, style: { fontFamily: 'Microsoft YaHei, sans-serif', fontSize: 13, fill: 0x33566d } }); label.anchor.set(0.5); label.position.set(x + cellWidth / 2, 65); app.stage.addChild(label);
        }
        const appearance: Appearance = { presetId: preset, bodyColor: PRESET_COLORS[preset][0], finColor: PRESET_COLORS[preset][1], patternId: 'plain', equipped: { [item.slot]: item.id }, skinAssetId: null, version: 1 };
        const snapshot: FishSnapshot = { id: `${preset}-${item.id}-${facing}`, nickname: `${names[preset]}${facing === 'left' ? '向左' : '向右'}`, position: { x: x + cellWidth / 2 + (facing === 'left' ? -8 : 8), y: y + 78 }, velocity: { x: facing === 'left' ? -90 : 90, y: 0 }, facing: facing as 'left' | 'right', angle: 0, appearance,
          level: 1, displaySize: preset === 'angelfish' ? 0.63 : 0.76, guildId: null, team: null, animation: 'swim', interactive: false, followGroupId: null, hp: null, maxHp: null, shieldUntilServerMs: 0, respawnAtServerMs: null };
        const view = new FishView(snapshot, () => {}); view.setSelected(true); view.eventMode = 'none'; view.update(1, 0, true, Date.now(), false, false); app.stage.addChild(view);
        checks.push({ preset, item: item.id, facing, visualScaleX: view.visual.scale.x, labelScaleX: view.nameTag.scale.x });
      }
    });
  });
  app.render();
  return { checks, destroy() { app.destroy({ removeView: true }, { children: true }); } };
}

export async function createAnimationGallery(host: HTMLElement, facing: 'left' | 'right') {
  const presets = Object.keys(PRESET_COLORS) as PresetId[];
  const names: Record<PresetId, string> = { goldfish: '金鱼', clownfish: '小丑鱼', puffer: '河豚', betta: '斗鱼', angelfish: '神仙鱼', ray: '鳐鱼' };
  const states = [['idle', '待机'], ['swim', '游动'], ['dash', '冲刺'], ['eat', '吃食'], ['hit', '受击'], ['victory', '胜利'], ['defeat', '失败'], ['bubble', '泡泡复活'], ['shield', '护盾']] as const;
  const cellWidth = 175, cellHeight = 175, top = 90, left = 90, now = Date.now();
  const app = new Application(); await app.init({ width: left + cellWidth * states.length + 10, height: top + cellHeight * presets.length + 20, resolution: 1, antialias: true, background: 0xd9f2f3 });
  host.appendChild(app.canvas); app.ticker.stop();
  const title = new Text({ text: `六鱼型 × 八状态与护盾 · 全部朝${facing === 'left' ? '左' : '右'} · 快照视觉 fixture`, style: { fontFamily: 'Microsoft YaHei, sans-serif', fontSize: 25, fontWeight: 'bold', fill: 0x12385b } }); title.position.set(25, 18); app.stage.addChild(title);
  const checks: Array<{ preset: PresetId; state: string; facing: string; visualScaleX: number; labelScaleX: number; bubbleScaleX: number; countdown: string }> = [];
  presets.forEach((preset, row) => {
    const rowName = new Text({ text: names[preset], style: { fontFamily: 'Microsoft YaHei, sans-serif', fontSize: 18, fontWeight: 'bold', fill: 0x33566d } }); rowName.position.set(12, top + row * cellHeight + 65); app.stage.addChild(rowName);
    states.forEach(([state, stateName], col) => {
      const x = left + col * cellWidth, y = top + row * cellHeight;
      app.stage.addChild(new Graphics().roundRect(x + 3, y + 3, cellWidth - 6, cellHeight - 6, 12).fill({ color: 0xffffff, alpha: (row + col) % 2 ? 0.32 : 0.6 }));
      if (row === 0) { const label = new Text({ text: stateName, style: { fontFamily: 'Microsoft YaHei, sans-serif', fontSize: 15, fontWeight: 'bold', fill: 0x33566d } }); label.anchor.set(0.5); label.position.set(x + cellWidth / 2, 65); app.stage.addChild(label); }
      const appearance: Appearance = { presetId: preset, bodyColor: PRESET_COLORS[preset][0], finColor: PRESET_COLORS[preset][1], patternId: 'plain', equipped: { face: 'glasses.round', head: 'headphones.basic' }, skinAssetId: null, version: 1 };
      const snapshot: FishSnapshot = { id: `${preset}-${state}`, nickname: `${names[preset]}·${stateName}`, position: { x: x + cellWidth / 2 + (facing === 'left' ? -6 : 6), y: y + 78 }, velocity: { x: (state === 'idle' ? 0 : state === 'dash' ? 540 : 90) * (facing === 'left' ? -1 : 1), y: 0 }, facing, angle: 0, appearance,
        level: 1, displaySize: preset === 'angelfish' ? 0.6 : 0.72, guildId: null, team: null, animation: state === 'shield' ? 'idle' : state, interactive: false, followGroupId: null,
        hp: null, maxHp: null, shieldUntilServerMs: state === 'shield' ? now + 600 : 0, respawnAtServerMs: state === 'bubble' ? now + 3000 : null };
      const view = new FishView(snapshot, () => {}); view.setSelected(true); view.eventMode = 'none'; view.update(1, state === 'hit' ? 0.02 : 0.3, false, now, false, false); app.stage.addChild(view);
      checks.push({ preset, state, facing, visualScaleX: view.visual.scale.x, labelScaleX: view.nameTag.scale.x, bubbleScaleX: view.aura.scale.x, countdown: view.statusText.text });
    });
  });
  app.render(); return { checks, destroy() { app.destroy({ removeView: true }, { children: true }); } };
}
