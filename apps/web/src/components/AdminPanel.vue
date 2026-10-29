<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ShieldCheck, KeyRound, RefreshCw, Check } from 'lucide-vue-next';
import { api, command } from '../api';
const busy=ref(false),error=ref(''),employeeRef=ref(''),generated=ref(''),invites=ref<any[]>([]),items=ref<any[]>([]),reconciliation=ref<any|null>(null);
const uploadId=ref(''),reason=ref('');
const emit=defineEmits<{toast:[string]}>();
function rows(v:any){return Array.isArray(v)?v:v?.items??[];}
async function run(fn:()=>Promise<unknown>){if(busy.value)return;busy.value=true;error.value='';try{await fn();}catch(e){error.value=(e as Error).message;}finally{busy.value=false;}}
async function load(){await run(async()=>{const [a,b,c]=await Promise.all([api('/admin/invites'),api('/shop/items?scope=ALL'),api('/admin/reconciliation')]);invites.value=rows(a);items.value=rows(b);reconciliation.value=c;});}
async function invite(){await run(async()=>{const r=await command<any>('/admin/invites',{employeeRef:employeeRef.value});generated.value=r.inviteCode;employeeRef.value='';emit('toast','邀请码已创建，明文仅本次显示');});}
async function update(item:any){await run(async()=>{await command(`/admin/shop/items/${item.id}`,{price:item.price,enabled:item.enabled,version:item.version},'PATCH');emit('toast','商品已更新');});await load();}
onMounted(load);
</script>
<template>
  <div class="eyebrow"><ShieldCheck :size="17"/>管理员工具</div><h1>让珊瑚海好好运行</h1><p class="panel-intro">管理操作由服务器鉴权并保留审计，邀请码明文只显示一次。</p>
  <div v-if="error" class="inline-error" role="alert">{{error}}</div><button class="text-button" @click="load" :disabled="busy"><RefreshCw :size="13"/>刷新管理数据</button>
  <label class="form-field">员工唯一标识<input v-model="employeeRef" maxlength="100" placeholder="例如公司员工编号" aria-label="员工唯一标识"/></label><button class="primary wide" @click="invite" :disabled="busy||!employeeRef.trim()"><KeyRound :size="17"/>生成单次邀请码</button>
  <div v-if="generated" class="purchase-confirm"><b>仅本次显示，请妥善保存</b><p class="invite-code">{{generated}}</p><button class="text-button" @click="generated=''">我已保存，隐藏明文</button></div>
  <details class="bind-section"><summary>已发放邀请码</summary><div v-for="i in invites" :key="i.id" class="ledger-row">{{i.employeeRef??i.employee_ref}} · {{i.usedBy??i.used_by?'已使用':'未使用'}} · 到期 {{new Date(i.expiresAt??i.expires_at).toLocaleString('zh-CN')}}</div></details>
  <details class="bind-section"><summary>商品上下架与价格</summary><div v-for="item in items" :key="item.id" class="admin-product"><b>{{item.name}}</b><input type="number" v-model.number="item.price" min="0" :aria-label="`${item.name}价格`"/><label><input type="checkbox" v-model="item.enabled"/>上架</label><button @click="update(item)" :disabled="busy">保存</button></div></details>
  <details class="bind-section"><summary>图片处置</summary><label class="form-field">图片资产编号<input v-model="uploadId" aria-label="图片资产编号"/></label><label class="form-field">下架原因<input v-model="reason" maxlength="200" aria-label="下架原因"/></label><button class="danger-button" :disabled="busy||!uploadId||!reason.trim()" @click="run(async()=>{await command(`/admin/uploads/${uploadId}`,{status:'REMOVED',reason},'PATCH');emit('toast','图片已下架，相关角色恢复默认皮肤')})">确认下架图片并记录原因</button></details>
  <h3 class="section-title">账目核对</h3><div v-if="reconciliation" class="reconciliation"><p><Check :size="15"/>{{reconciliation.ok===true?'对账一致':reconciliation.ok===false?'发现异常，请限制相关资产写入':'服务端核对结果'}}</p><pre>{{JSON.stringify(reconciliation,null,2)}}</pre></div><p class="tiny-label">发现异常不得静默改余额。以服务端告警、来源流水与冻结记录定位问题。</p>
</template>
<style scoped>
.invite-code{font-family:monospace;overflow-wrap:anywhere;font-size:15px;letter-spacing:1px}.admin-product{display:flex;align-items:center;gap:9px;margin:15px 0;font-size:10px}.admin-product b{flex:1}.admin-product input[type=number]{width:60px;padding:7px;border:1px solid #cfdcce;border-radius:6px;background:#fffff8}.admin-product button{padding:7px 12px;border-radius:6px;background:#dfebdc;color:#47716b;font-size:10px}.reconciliation{background:#edf1e7;border-radius:12px;padding:15px;color:#688a80;font-size:11px}.reconciliation>p{display:flex;align-items:center;gap:7px}.reconciliation pre{font-size:9px;max-height:240px;overflow:auto;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere}
</style>
