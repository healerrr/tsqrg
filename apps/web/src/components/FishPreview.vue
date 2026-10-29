<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Application } from 'pixi.js';
import type { Appearance, FishSnapshot } from '@aquarium/protocol';
import { FishView } from '../game/fish';

const props = withDefaults(defineProps<{ appearance: Appearance; nickname?: string; reducedMotion?: boolean }>(), { nickname: '我的鱼', reducedMotion: false });
const emit = defineEmits<{ error: [message: string] }>();
const host = ref<HTMLElement>(); const direction = ref<'left' | 'right'>('right'); const failed = ref(false);
let app: Application | null = null, fish: FishView | null = null, resizeObserver: ResizeObserver | null = null, disposed = false;
let previousTime = performance.now();
function data(): FishSnapshot {
  return { id: 'appearance-preview', nickname: props.nickname, position: { x: 0, y: 0 }, velocity: { x: direction.value === 'right' ? 65 : -65, y: 0 },
    facing: direction.value, angle: 0, appearance: props.appearance, level: 1, displaySize: props.appearance.presetId === 'angelfish' ? 0.73 : 1.05,
    guildId: null, team: null, animation: 'swim', interactive: false, followGroupId: null, hp: null, maxHp: null, shieldUntilServerMs: 0, respawnAtServerMs: null };
}
function resize() {
  if (!host.value || !app || !fish || disposed) return;
  const width = host.value.clientWidth || 320;
  app.renderer.resize(width, 150); fish.target = { x: width / 2 + 12, y: 74 }; fish.position.copyFrom(fish.target);
}
function update() {
  if (!fish || disposed) return;
  const now = performance.now(); fish.update(Math.min(0.5, (now - previousTime) / 1000), now / 1000, props.reducedMotion, Date.now(), false, false); previousTime = now;
}
function refresh() { if (fish) { fish.updateSnapshot(data()); resize(); } }
defineExpose({ getDebugState: () => ({ preset: fish?.renderedPreset, facing: fish?.facing, skinStatus: fish?.skinStatus, visualScaleX: fish?.visual.scale.x, nameScaleX: fish?.nameTag.scale.x, mounted: !!app && !disposed }) });
watch(() => props.appearance, refresh, { deep: true }); watch(direction, refresh); watch(() => props.nickname, refresh);
onMounted(async () => {
  const initialized = new Application();
  try {
    await initialized.init({ width: 320, height: 150, backgroundAlpha: 0, antialias: true, resolution: Math.min(devicePixelRatio || 1, 2), autoDensity: true, preference: 'webgl' });
    if (disposed || !host.value) { initialized.destroy({ removeView: true }, { children: true }); return; }
    app = initialized; host.value.appendChild(app.canvas); app.canvas.style.width = '100%'; app.canvas.style.height = '150px';
    app.canvas.setAttribute('role', 'img'); app.canvas.setAttribute('aria-label', `${props.nickname}的外观预览`);
    fish = new FishView(data(), () => {}); fish.eventMode = 'none'; fish.on('skin-error', () => emit('error', '贴图加载失败，预览已恢复默认外观'));
    app.stage.addChild(fish); resizeObserver = new ResizeObserver(resize); resizeObserver.observe(host.value); resize(); app.ticker.add(update);
  } catch { if (initialized.renderer) initialized.destroy({ removeView: true }, { children: true }); failed.value = true; emit('error', '外观预览加载失败，请关闭面板后重试'); }
});
onBeforeUnmount(() => { disposed = true; resizeObserver?.disconnect(); if (app) { app.ticker.remove(update); app.destroy({ removeView: true }, { children: true }); } app = null; fish = null; });
</script>

<template>
  <section class="fish-preview" aria-label="自己的鱼外观预览">
    <div ref="host" class="fish-preview-canvas"><p v-if="failed" role="status">预览加载失败，请重新打开面板</p></div>
    <div class="preview-directions" aria-label="预览朝向"><button :aria-pressed="direction==='left'" @click="direction='left'" aria-label="预览向左游动">←</button><span>左右转向，看看每个细节</span><button :aria-pressed="direction==='right'" @click="direction='right'" aria-label="预览向右游动">→</button></div>
  </section>
</template>

<style scoped>
.fish-preview{position:relative;margin:16px 0;border-radius:18px;border:1px solid #c0ebf1;background:radial-gradient(ellipse at 50% 35%,#edfdf8,#d7f1f4);overflow:hidden}
.fish-preview-canvas{height:150px;min-width:0}.fish-preview-canvas p{text-align:center;padding:45px 12px;font-size:13px;color:#536b7c}
.preview-directions{display:flex;align-items:center;justify-content:center;gap:12px;padding:0 10px 7px;color:#57818d;font-size:11px}.preview-directions button{height:44px;width:44px;border-radius:50%;border:1px solid #a2d4dd;background:#ffffff80;color:#22556d;font-size:21px;cursor:pointer}.preview-directions button[aria-pressed=true]{border-color:#22556d;background:#c5e9ea}
</style>
