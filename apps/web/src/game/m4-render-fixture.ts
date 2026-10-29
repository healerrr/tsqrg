import { Application, Assets, Sprite } from 'pixi.js';
import { createApp, h, nextTick, shallowRef } from 'vue';
import type { Appearance, FishSnapshot, PresetId, SceneSnapshot } from '@aquarium/protocol';
import FishPreview from '../components/FishPreview.vue';
import { createAquarium } from './aquarium';
import { FishView, PRESET_COLORS } from './fish';

type PreviewDebug = { getDebugState(): { preset?: string; skinStatus?: string; facing?: number; visualScaleX?: number; nameScaleX?: number; mounted: boolean } };
function appearance(presetId: PresetId, skinAssetId: string | null): Appearance {
  return { presetId, bodyColor: PRESET_COLORS[presetId][0], finColor: PRESET_COLORS[presetId][1], patternId: 'spots', equipped: { face: 'glasses.round', head: 'headphones.basic', charm: 'charm.seagrass' }, skinAssetId, version: 1 };
}
function fish(appearance: Appearance, id: string, facing: 'left' | 'right', x: number, y: number, interactive = true): FishSnapshot {
  return { id, nickname: '十二字昵称保持正向可读测试', position: { x, y }, velocity: { x: 0, y: 0 }, facing, angle: 0, appearance, level: 1, displaySize: 1,
    guildId: null, team: null, animation: 'idle', interactive, followGroupId: null, hp: null, maxHp: null, shieldUntilServerMs: 0, respawnAtServerMs: null };
}

/** Browser-only renderer fixture. It never starts a session, sends commands, or changes a wallet. */
export async function createM4RenderFixture(host: HTMLElement) {
  host.innerHTML = '<h1>M4 身体贴图与试穿视觉 fixture（无交易、无后端资产写入）</h1><section><h2>主缸：快照持续到达时保持本地试穿</h2><div id="qa-tank"></div></section><section><h2>正式 FishPreview 组件 · 按钮左右切换</h2><div id="qa-preview"></div></section><section><h2>同图共享纹理 · 昵称不翻转</h2><div id="qa-pair"></div></section>';
  const style = document.createElement('style'); style.textContent = 'body{margin:0;background:#f2fbf7;font:14px Microsoft YaHei,sans-serif;color:#12385b}main{max-width:1160px;margin:auto;padding:16px}h1{font-size:20px}h2{font-size:14px;margin:15px 0 8px}#qa-tank{height:440px;position:relative;overflow:hidden;border-radius:18px}#qa-preview{max-width:600px;margin:auto}#qa-pair{max-width:650px;margin:auto}#qa-pair canvas{display:block;width:100%;height:auto}'; document.head.appendChild(style);
  const errors: string[] = [], draft = shallowRef(appearance('ray', 'fixture-a'));
  const main = await createAquarium(host.querySelector('#qa-tank')!, { onMove() {}, onAction() {}, onSelect() {}, onError(message) { errors.push(message); } });
  main.setPreviewMode(false); main.setSelfId('owned-visual'); main.setInputEnabled(false);
  const authoritativeFish = fish({ ...appearance('goldfish', null), equipped: {}, patternId: 'none' }, 'owned-visual', 'right', 960, 450);
  const offlineFish = fish({ ...appearance('clownfish', null), equipped: {}, patternId: 'stripes' }, 'offline-visual', 'left', 1250, 510, false);
  const snapshot: SceneSnapshot = { protocolVersion: 1, snapshotKind: 'full', rulesVersion: '1.0.0', roomId: 'visual-tank', roomEpoch: 'fixture-room', sceneEpoch: 'fixture-control', sceneKind: 'TANK', serverTick: 1, serverTimeMs: Date.now(), ackInputSeq: 0, ackActionSeq: 0, controlledFishId: 'owned-visual', fish: [authoritativeFish, offlineFish], food: [], npc: [], pearl: null, match: null, ownRuntime: { stamina: 100, dashReadyAtServerMs: 0, shieldReadyAtServerMs: 0 } };
  main.setSnapshot(snapshot); main.setAppearancePreview(draft.value);
  let previewComponent: PreviewDebug | null = null;
  const previewApp = createApp({ render: () => h(FishPreview, { appearance: draft.value, nickname: authoritativeFish.nickname, ref: value => { previewComponent = value as unknown as PreviewDebug; }, onError: (message: string) => errors.push(message) }) });
  previewApp.mount(host.querySelector('#qa-preview')!);
  const pairApp = new Application(); await pairApp.init({ width: 650, height: 200, resolution: 1, background: 0xe2f4f3, antialias: true });
  host.querySelector('#qa-pair')!.appendChild(pairApp.canvas); pairApp.ticker.stop();
  const left = new FishView(fish(draft.value, 'fixture-left', 'left', 160, 81), () => {}), right = new FishView(fish(draft.value, 'fixture-right', 'right', 490, 81), () => {});
  pairApp.stage.addChild(left, right); left.setSelected(true); right.setSelected(true);
  function renderPair() { for (const v of [left, right]) if (!v.destroyed) v.update(1, 0, true, Date.now(), false, false); pairApp.render(); }
  renderPair(); await nextTick();
  const original = JSON.stringify(authoritativeFish);
  return {
    errors,
    status() { const sceneFish = main.getDebugState().fish; return { main: sceneFish.find(value => value.id === authoritativeFish.id), offline: sceneFish.find(value => value.id === offlineFish.id), preview: previewComponent?.getDebugState(), left: { preset: left.renderedPreset, skinStatus: left.skinStatus, nameScaleX: left.nameTag.scale.x, visualScaleX: left.visual.scale.x, nameWidth: left.nameBackground.width, textWidth: left.nameText.width }, right: { preset: right.renderedPreset, skinStatus: right.skinStatus, nameScaleX: right.nameTag.scale.x, visualScaleX: right.visual.scale.x }, errors: [...errors], authorityUnchanged: original === JSON.stringify(authoritativeFish) }; },
    async setVariant(preset: PresetId, id: string | null) { draft.value = appearance(preset, id); main.setAppearancePreview(draft.value); left.setAppearance(draft.value); right.setAppearance(draft.value); await nextTick(); renderPair(); },
    repeatSnapshots() { return Array.from({ length: 10 }, () => { snapshot.serverTick++; snapshot.serverTimeMs = Date.now(); main.setSnapshot(snapshot); return main.getDebugState().fish[0]!.skinStatus; }); },
    setMainSkin(id: string | null) { main.setAppearancePreview(appearance('ray', id)); },
    cancelMain() { main.setAppearancePreview(null); },
    battlePreviewLocked() { const arena = { ...snapshot, sceneKind: 'DUEL' as const, roomId: 'fixture-arena', sceneEpoch: 'fixture-arena-epoch', roomEpoch: 'fixture-arena-room', fish: [{ ...authoritativeFish, position: { x: 420, y: 360 } }] }; main.setSnapshot(arena); main.setAppearancePreview(appearance('betta', 'fixture-b')); const result = main.getDebugState().fish[0]!; main.setSnapshot(snapshot); return { preset: result.preset, skinStatus: result.skinStatus }; },
    closeLeft() { left.destroy({ children: true }); renderPair(); },
    closePreview() { previewApp.unmount(); },
    rightTextureAlive() { const sprite = right.visual.getChildByLabel('body-skin') as Sprite | undefined; return !!sprite && !sprite.texture.source.destroyed; },
    cacheHas(id: string) { return Assets.cache.has(`/api/assets/${id}`); },
    renderPair,
    destroy() { previewApp.unmount(); main.destroy(); pairApp.destroy({ removeView: true }, { children: true }); style.remove(); return main.getStats(); },
  };
}
