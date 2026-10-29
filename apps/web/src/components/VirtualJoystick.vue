<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { MoveIntent } from '@aquarium/protocol';

const props = withDefaults(defineProps<{ disabled?: boolean }>(), { disabled: false });
const emit = defineEmits<{ move: [intent: MoveIntent] }>();
const base = ref<HTMLElement>();
const displacement = ref({ x: 0, y: 0 });
const active = ref(false);
let pointerId: number | null = null;
const knobStyle = computed(() => ({ transform: `translate(${displacement.value.x}px, ${displacement.value.y}px)` }));
function update(e: PointerEvent) {
  if (!base.value || props.disabled) return;
  const rect = base.value.getBoundingClientRect();
  const dx = e.clientX - (rect.left + rect.width / 2), dy = e.clientY - (rect.top + rect.height / 2);
  const length = Math.hypot(dx, dy), radius = rect.width * 0.29;
  displacement.value = length > radius ? { x: dx / length * radius, y: dy / length * radius } : { x: dx, y: dy };
  emit('move', length < 6 ? { kind: 'idle' } : { kind: 'direction', direction: { x: dx / Math.max(1, length), y: dy / Math.max(1, length) } });
}
function start(e: PointerEvent) {
  if (props.disabled || pointerId !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
  e.preventDefault(); e.stopPropagation(); pointerId = e.pointerId; active.value = true;
  base.value?.setPointerCapture(e.pointerId); update(e);
}
function drag(e: PointerEvent) { if (e.pointerId === pointerId) { e.preventDefault(); e.stopPropagation(); update(e); } }
function stop(e?: Event) {
  if (e instanceof PointerEvent && pointerId !== null && e.pointerId !== pointerId) return;
  const id = pointerId; pointerId = null; active.value = false; displacement.value = { x: 0, y: 0 };
  if (id !== null && base.value?.hasPointerCapture(id)) base.value.releasePointerCapture(id);
  emit('move', { kind: 'idle' });
}
function visibility() { if (document.hidden) stop(); }
watch(() => props.disabled, value => { if (value) stop(); });
onMounted(() => { window.addEventListener('blur', stop); document.addEventListener('visibilitychange', visibility); });
onBeforeUnmount(() => { stop(); window.removeEventListener('blur', stop); document.removeEventListener('visibilitychange', visibility); });
</script>

<template>
  <div ref="base" class="virtual-joystick" :class="{ active, disabled }" role="group" aria-label="移动摇杆：按住并拖动控制游动方向"
    @pointerdown="start" @pointermove="drag" @pointerup="stop" @pointercancel="stop" @lostpointercapture="stop">
    <span class="joystick-guide" aria-hidden="true">＋</span><span class="joystick-knob" :style="knobStyle" aria-hidden="true"></span>
    <small>移动</small>
  </div>
</template>

<style scoped>
.virtual-joystick{position:absolute;left:max(22px,env(safe-area-inset-left));bottom:108px;width:108px;height:108px;border-radius:50%;border:1px solid #bcefff66;background:#12385b50;box-shadow:inset 0 0 0 13px #a4eeff0a,0 4px 18px #12385b15;touch-action:none;user-select:none;pointer-events:auto;z-index:8;-webkit-user-select:none}
.joystick-guide{position:absolute;inset:0;display:grid;place-items:center;color:#cdf8ff44;font:70px/1 sans-serif;font-weight:200}
.joystick-knob{position:absolute;width:46px;height:46px;left:30px;top:30px;border-radius:50%;background:#e6fbfdbb;border:2px solid #e5ffffaa;box-shadow:0 4px 10px #12385b40;transition:background .15s}
.active .joystick-knob{background:#a8eee9ee}.virtual-joystick small{position:absolute;left:0;right:0;bottom:-22px;text-align:center;color:#efffff;font-size:11px;letter-spacing:2px;text-shadow:0 1px 4px #12385b}
.disabled{opacity:.35;pointer-events:none}
@media(pointer:fine) and (min-width:901px){.virtual-joystick{display:none}}
@media(max-height:520px){.virtual-joystick{bottom:92px;width:96px;height:96px}.joystick-knob{left:24px;top:24px}}
</style>
