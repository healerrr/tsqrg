<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { Fish, ShoppingBag, Utensils, Users, Trophy, Crown, Sparkles, Glasses, Headphones, Flag, Leaf, Check, Palette, Upload, ChevronRight, RefreshCw, Info, UserRoundCheck } from 'lucide-vue-next';
import type { Appearance, PresetId } from '@aquarium/protocol';
import { config, xpForLevel, xpToNext } from '@aquarium/core';
import { api, command } from '../api';
import { useSession } from '../stores/session';
import FishPreview from './FishPreview.vue';
import AdminPanel from './AdminPanel.vue';
import ArenaPanel from './ArenaPanel.vue';
const props=defineProps<{panel:string;presets:{id:PresetId;name:string;tag:string;color:string}[];colors:string[];appearance:Appearance;arenaTargetUserId?:string}>();
const emit=defineEmits<{preview:[Appearance];close:[];toast:[string]}>();
const session=useSession();
const loading=ref(false),busy=ref(false),error=ref(''),nickname=ref(''),inviteCode=ref(''),surfaceX=ref(960),tab=ref('all');
const draft=ref<Appearance>(structuredClone({...props.appearance,equipped:{...props.appearance.equipped}}));
const inventory=ref<string[]>([]),shopItems=ref<any[]>([]),skinAssets=ref<any[]>([]),skinNext=ref<string|null>(null),ranking=ref<any[]>([]),rankKind=ref('power');
const rankMeta=ref<{myRank:number|null;nextCursor:string|null}>({myRank:null,nextCursor:null});
const purchase=ref<any|null>(null),players=ref<any[]>([]),guilds=ref<any[]>([]),guild=ref<any|null>(null);
const guildName=ref(''),guildSearch=ref(''),guildNext=ref<string|null>(null),ledgerNext=ref<string|null>(null),notice=ref(''),donation=ref(10);
const guildConfirm=ref<{kind:'donate'|'dissolve';text:string}|null>(null);
const productIcons:Record<string,any>={'glasses.round':Glasses,'headphones.basic':Headphones,'hat.fish':Crown,'outfit.pirate':Flag,'trail.star':Sparkles,'charm.seagrass':Leaf};
const owned=computed(()=>new Set(inventory.value));
const filteredItems=computed(()=>shopItems.value.filter(i=>i.scope==='PERSONAL'&&(tab.value==='all'||tab.value==='owned'&&owned.value.has(i.id)||tab.value===i.slot)));
const xpProgress=computed(()=>{const m=session.me;if(!m)return 0;return m.level===config.fish.maxLevel?100:Math.max(0,(m.totalXp-xpForLevel(m.level))/xpToNext(m.level)*100);});
function rows(value:any):any[]{return Array.isArray(value)?value:value?.items??value?.entries??value?.rows??[];}
async function run(fn:()=>Promise<unknown>,success?:string){if(busy.value)return;busy.value=true;error.value='';try{await fn();if(success)emit('toast',success);await session.refresh();}catch(e){error.value=(e as Error).message;}finally{busy.value=false;}}
function preview(){emit('preview',JSON.parse(JSON.stringify(draft.value)));}
function choose(p:typeof props.presets[number]){draft.value={...draft.value,presetId:p.id,bodyColor:p.color};preview();}
async function load(){
  loading.value=true;error.value='';purchase.value=null;
  try{
    if(props.panel==='create'){draft.value={...draft.value,equipped:{},skinAssetId:null,patternId:'none',version:1};nickname.value='';preview();}
    if(props.panel==='fish'||props.panel==='shop'){
      if(session.me?.appearance)draft.value=JSON.parse(JSON.stringify(session.me.appearance));nickname.value=session.me?.nickname??'';
      if(props.panel==='fish')await loadSkins(true);
    }
    if(props.panel==='shop'){
      const [catalog,wardrobe]=await Promise.all([api<any>('/shop/items'),api<any>('/inventory')]);
      shopItems.value=rows(catalog);inventory.value=rows(wardrobe).map(i=>typeof i==='string'?i:i.itemId??i.item_id??i.id);
    }
    if(props.panel==='rank'){const r=await api<any>(rankUrl());ranking.value=rows(r);rankMeta.value={myRank:r.myRank,nextCursor:r.nextCursor};}
    if(props.panel==='guild'){
      const [listed,tankPlayers]=await Promise.all([api<any>(guildListUrl()),api('/players')]);
      guilds.value=rows(listed);guildNext.value=listed.nextCursor??null;players.value=rows(tankPlayers);
      if(session.me?.guildId){guild.value=await api(`/guilds/${session.me.guildId}`);notice.value=guild.value.notice??'';}
      else guild.value=null;
    }
  }catch(e){error.value=(e as Error).message;}finally{loading.value=false;}
}
watch(()=>props.panel,load,{immediate:true});
watch(rankKind,()=>{if(props.panel==='rank')void load();});
async function create(){await run(async()=>{await session.createFish(nickname.value,{...draft.value,equipped:{},skinAssetId:null});emit('close');},'欢迎入缸！你的鱼已保存。');}
async function save(){await run(async()=>{await command('/fish/me',{nickname:nickname.value,appearance:draft.value,version:session.me?.appearance?.version},'PATCH');emit('close');},'外观已保存');}
async function buy(){if(!purchase.value)return;await run(async()=>{await command('/shop/purchases',{itemId:purchase.value.id,itemVersion:purchase.value.version});purchase.value=null;await load();},'购买成功，已收入永久衣橱');}
function isEquipped(item:any){return session.me?.appearance?.equipped[item.slot as keyof Appearance['equipped']]===item.id;}
async function equip(item:any){const itemId=isEquipped(item)?null:item.id;await run(async()=>{await command('/inventory/equip',{slot:item.slot,itemId,version:session.me?.appearance?.version});await session.refresh();if(session.me?.appearance){draft.value=JSON.parse(JSON.stringify(session.me.appearance));preview();}},itemId?'已穿戴':'已脱下');}
async function upload(e:Event){const input=e.target as HTMLInputElement,file=input.files?.[0];if(!file)return;
  if(file.size>config.upload.maxBytes){error.value='图片不能超过2MB';return;}
  await run(async()=>{const form=new FormData();form.append('file',file);const result=await command<any>('/uploads/skins',form);draft.value={...draft.value,skinAssetId:result.assetId??result.id};preview();await loadSkins(true);},'贴图已安全处理，预览后记得保存');input.value='';
}
async function loadSkins(reset=false){const cursor=reset?null:skinNext.value;if(!reset&&!cursor)return;const result=await api<any>(`/uploads/skins?limit=12${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`);if(reset)skinAssets.value=rows(result);else skinAssets.value.push(...rows(result));skinNext.value=result.nextCursor??null;}
async function moreSkins(){await run(()=>loadSkins(false));}
async function claimInvite(){await run(async()=>{await command('/auth/claim',{inviteCode:inviteCode.value});inviteCode.value='';},'已绑定同事身份，原有角色与资产保留');}
async function feed(){await run(async()=>{await command('/tank/feed',{roomId:session.snapshot?.roomId,surfaceX:surfaceX.value,sceneEpoch:session.sceneEpoch});emit('close');},'鱼粮已投下，游过去看看！');}
async function supply(){await run(async()=>{const r=await command<any>('/rewards/daily');emit('toast',r.replayed?'今日补给已经领取，本次没有重复发放':`今日补给到账：${r.actualXp??r.xp??0} 经验，${r.actualPower??r.power??0} 战力`);});}
function rankUrl(cursor?:string){return `/leaderboards?kind=${['power','guest'].includes(rankKind.value)?'current':rankKind.value}&scope=${rankKind.value==='guest'?'guests':'members'}${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`;}
async function moreRanks(){if(!rankMeta.value.nextCursor)return;await run(async()=>{const r=await api<any>(rankUrl(rankMeta.value.nextCursor!));ranking.value.push(...rows(r));rankMeta.value={myRank:r.myRank,nextCursor:r.nextCursor};});}
function guildListUrl(cursor?:string){const search=guildSearch.value.trim()?`&search=${encodeURIComponent(guildSearch.value.trim())}`:'';return `/guilds?limit=20${search}${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`;}
async function searchGuilds(){await run(async()=>{const result=await api<any>(guildListUrl());guilds.value=rows(result);guildNext.value=result.nextCursor??null;});}
async function moreGuilds(){if(!guildNext.value)return;await run(async()=>{const result=await api<any>(guildListUrl(guildNext.value!));guilds.value.push(...rows(result));guildNext.value=result.nextCursor??null;});}
async function loadLedger(reset=true){if(!guild.value)return;const cursor=reset?null:ledgerNext.value;if(!reset&&!cursor)return;await run(async()=>{const result=await api<any>(`/guilds/${guild.value.id}/ledger?limit=20${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`);if(reset)guild.value.ledger=rows(result);else guild.value.ledger=[...(guild.value.ledger??[]),...rows(result)];ledgerNext.value=result.nextCursor??null;});}
async function guildAction(path:string,payload:unknown={},success='组织已更新',method='POST'){await run(async()=>{await command(path,payload,method);await session.refresh();await load();},success);}
const myGuildRole=computed(()=>guild.value?.members?.find((m:any)=>(m.userId??m.user_id)===session.me?.userId)?.role);
const canManage=computed(()=>myGuildRole.value==='LEADER'||myGuildRole.value==='ADMIN');
const guildFollowers=computed(()=>new Set(session.snapshot?.fish.filter(f=>f.followGroupId===session.me?.guildId).map(f=>f.id)??[]));
const invitablePlayers=computed(()=>players.value.filter(p=>p.userId!==session.me?.userId&&!p.guildId&&p.role!=='GUEST'));
function guildItemOwned(id:string){return !!guild.value?.assets?.some((asset:any)=>(asset.itemId??asset.item_id)===id);}
async function followMember(fishId?:string){await run(()=>session.follow(true,fishId),fishId?'已选择领游者；手动移动会立即脱队':'已加入一起游；手动移动会立即脱队');}
async function confirmGuildAction(){
  if(!guild.value||!guildConfirm.value)return;
  const action=guildConfirm.value.kind;guildConfirm.value=null;
  if(action==='donate')await guildAction(`/guilds/${guild.value.id}/donations`,{amount:donation.value},'捐献已到账');
  else await guildAction(`/guilds/${guild.value.id}/dissolve`,{version:guild.value.version,confirm:true},'鱼群已归档，公共资产不会退回个人');
}
</script>

<template>
  <div v-if="error" class="inline-error" role="alert">{{error}} <button @click="load" aria-label="重新加载"><RefreshCw :size="14"/></button></div>
  <div v-if="loading&&panel!=='arena'" class="loading-line">正在读取水族箱数据…</div>
  <AdminPanel v-if="panel==='admin'" @toast="text=>emit('toast',text)"/>
  <template v-else-if="panel==='create'||panel==='fish'">
    <div class="eyebrow"><Fish :size="17"/>{{panel==='create'?'欢迎入缸':'我的摸鱼搭子'}}</div><h1>{{panel==='create'?'给自己一点摸鱼时间':'今天，想做哪条鱼？'}}</h1><p class="panel-intro">{{panel==='create'?'选择模样、起个昵称，你的鱼会一直记得你。':'成长、衣橱与外观都保存在服务器。'}}</p>
    <label class="form-field">昵称<input v-model="nickname" maxlength="12" minlength="2" placeholder="2—12个字" aria-label="昵称"/></label>
    <FishPreview :appearance="draft" :nickname="nickname||'我的摸鱼搭子'" @error="text=>emit('toast',text)"/><div class="fish-selector"><button v-for="p in presets" :key="p.id" :class="{chosen:draft.presetId===p.id}" @click="choose(p)"><span class="preset-icon" :style="{background:p.color}"><Fish :size="30"/></span><b>{{p.name}}</b><small>{{p.tag}}</small><Check v-if="draft.presetId===p.id" class="preset-check" :size="14"/></button></div>
    <label class="field-label"><Palette :size="16"/>身体配色</label><div class="swatches"><button v-for="color in colors" :key="color" :style="{background:color}" :class="{chosen:draft.bodyColor===color}" @click="draft.bodyColor=color;preview()" :aria-label="`选择颜色${color}`"><Check v-if="draft.bodyColor===color" :size="18"/></button></div>
    <div class="appearance-fields"><label class="field-label">尾鳍颜色<input type="color" v-model="draft.finColor" @input="preview" aria-label="尾鳍颜色"/></label><label class="field-label">花纹<select v-model="draft.patternId" @change="preview" aria-label="花纹"><option value="none">纯色</option><option value="stripes">条纹</option><option value="spots">斑点</option><option value="belly">浅色肚皮</option></select></label></div>
    <template v-if="panel==='fish'&&session.me">
      <div class="growth-bar"><span :style="{width:xpProgress+'%'}"></span></div><p class="tiny-label">Lv.{{session.me.level}} · 累计 {{session.me.totalXp}} XP · 今日 {{session.me.daily.xpMinted}} / {{config.daily.xpMintCap}} XP</p>
      <div class="wallet-grid"><div><b>{{session.me.wallet.basePower}}</b><small>永久基础 B</small></div><div><b>{{session.me.wallet.powerBalance}}</b><small>争夺余额 C</small></div><div><b>{{session.me.wallet.heldPower}}</b><small>冻结额度 H</small></div><div><b>{{session.me.wallet.availablePower}}</b><small>可用额度 A</small></div></div><p class="tiny-label">当前总战力 {{session.me.wallet.totalPower}} · 历史最高 {{session.me.wallet.highestPower}}</p>
      <label class="upload-button"><Upload :size="17"/>上传身体贴图（PNG / WebP，2MB以内）<input type="file" accept="image/png,image/webp" @change="upload" :disabled="busy"/></label><p class="tiny-label">上传后先预览，再保存。贴图不会改变体型判定或战斗属性。</p><details v-if="skinAssets.length" class="bind-section"><summary>我的贴图库 · {{skinAssets.length}} 项</summary><div class="skin-library"><div v-for="skin in skinAssets" :key="skin.id" :class="{chosen:draft.skinAssetId===skin.id}"><img v-if="skin.status==='ACTIVE'" :src="`/api/assets/${encodeURIComponent(skin.id)}`" :alt="`我的贴图 ${skin.id}`" loading="lazy"/><span v-else>已下架</span><small>{{skin.width}}×{{skin.height}}</small><button v-if="skin.status==='ACTIVE'" @click="draft.skinAssetId=skin.id;preview()" :disabled="busy">{{draft.skinAssetId===skin.id?'正在预览':'预览'}}</button><small v-else>资产记录已保留，管理员恢复后可再次使用</small></div></div><button v-if="skinNext" class="text-button" @click="moreSkins" :disabled="busy">加载更多贴图</button></details>
      <button v-if="draft.skinAssetId" class="text-button" @click="draft.skinAssetId=null;preview()">移除当前贴图</button>
      <details class="bind-section"><summary><UserRoundCheck :size="16"/>{{session.me.role==='GUEST'?'用邀请码绑定同事身份':'已绑定同事身份'}}</summary><template v-if="session.me.role==='GUEST'"><p>绑定后保留全部角色资产，开放组织和正式比赛。</p><div class="inline-form"><input v-model="inviteCode" placeholder="单次邀请码" aria-label="邀请码"/><button @click="claimInvite" :disabled="busy||!inviteCode">绑定身份</button></div></template></details>
    </template>
    <div class="notice"><Info :size="17"/>{{panel==='create'?'创建后获得一次新手奖励：100点可争夺战力。':'比赛准备与运行期间不能更换外观；配饰没有额外战斗属性。'}}</div>
    <button class="primary wide" :disabled="busy||nickname.trim().length<2" @click="panel==='create'?create():save()">{{busy?'正在保存…':panel==='create'?'就这条，入缸！':'保存外观'}}<ChevronRight :size="17"/></button>
  </template>

  <template v-else-if="panel==='shop'">
    <div class="eyebrow"><ShoppingBag :size="17"/>摸鱼好物</div><h1>给摸鱼加点个性</h1><p class="panel-intro">永久衣橱，只改变外观。可用战力 {{session.me?.wallet.availablePower??0}}。</p>
    <FishPreview :appearance="draft" :nickname="session.me?.nickname" @error="text=>emit('toast',text)"/><div class="tabs"><button v-for="t in [{id:'all',name:'全部'},{id:'owned',name:'我的衣橱'},{id:'head',name:'头饰'},{id:'face',name:'面饰'},{id:'trail',name:'尾迹'}]" :key="t.id" :class="{active:tab===t.id}" @click="tab=t.id">{{t.name}}</button></div>
    <div class="shop-grid"><div class="shop-product" v-for="(item,index) in filteredItems" :key="item.id"><button class="product-art" :class="'product-'+index%6" @click="draft.equipped={...draft.equipped,[item.slot]:item.id};preview();emit('toast','试穿中，取消后恢复原外观')" :aria-label="`试穿${item.name}`"><component :is="productIcons[item.id]??Sparkles" :size="38"/></button><b>{{item.name}}</b><span class="price">{{item.price}} 战力</span><button class="product-action" v-if="owned.has(item.id)" @click="equip(item)" :disabled="busy">{{isEquipped(item)?'脱下':'穿戴'}}</button><button class="product-action" v-else @click="purchase=item" :disabled="busy||item.enabled===false">{{item.enabled===false?'已下架':'购买'}}</button></div></div>
    <div v-if="!loading&&!filteredItems.length" class="empty-panel">{{tab==='owned'?'衣橱还是空的，先试穿一件喜欢的吧。':'暂无商品'}}</div>
    <button class="text-button" @click="draft=JSON.parse(JSON.stringify(session.me?.appearance));preview();emit('toast','试穿已取消')">取消试穿，恢复已保存的装扮</button>
    <div v-if="purchase" class="purchase-confirm"><b>购买 {{purchase.name}}？</b><p>消耗 {{purchase.price}} 点可用战力，购买后剩余 {{(session.me?.wallet.availablePower??0)-purchase.price}} 点。冻结额度不能消费。</p><div class="inline-form"><button @click="purchase=null">取消</button><button class="primary" :disabled="busy||(session.me?.wallet.availablePower??0)<purchase.price" @click="buy">确认消耗 {{purchase.price}} 战力</button></div></div>
  </template>

  <template v-else-if="panel==='feed'">
    <div class="eyebrow"><Utensils :size="17"/>开饭时间</div><h1>来点好吃的吧</h1><p class="panel-intro">投喂供全缸的鱼竞争，每天可主动投喂 {{config.daily.manualFeedUses}} 次。</p>
    <div class="daily-card"><Sparkles :size="28"/><div><b>每日补给</b><p>{{config.daily.supplyXp}} 经验 + {{config.daily.supplyPower}} 战力，实际到账受今日额度限制</p></div><button @click="supply" :disabled="busy">领取</button></div>
    <div class="daily-progress"><p>今日成长 <b>{{session.me?.daily.xpMinted??0}} / {{config.daily.xpMintCap}} XP</b></p><p>今日生成 <b>{{session.me?.daily.powerMinted??0}} / {{config.daily.powerMintCap}} 战力</b></p></div>
    <label class="form-field">选择水面投喂位置<input type="range" min="80" max="1840" v-model.number="surfaceX" aria-label="投喂位置"/><span class="range-hint"><span>左侧</span><span>右侧</span></span></label><div class="notice">每次投下 {{config.tank.manualFeedPellets}} 颗鱼粮；只有在线、页面可见且最近 {{config.tank.activeWindowSeconds}} 秒有操作的角色获得收益。</div><button class="primary wide" @click="feed" :disabled="busy||!session.controlled||(session.me?.daily.feedUsed??0)>=config.daily.manualFeedUses">投下鱼粮（剩余 {{config.daily.manualFeedUses-(session.me?.daily.feedUsed??0)}} 次）</button>
  </template>

  <template v-else-if="panel==='rank'">
    <div class="eyebrow"><Crown :size="17"/>每次成长，都算数</div><h1>珊瑚海排行榜</h1><p class="panel-intro">战力来自真实成长与余额，购买后会即时变化。</p><div class="tabs"><button v-for="r in [{id:'power',name:'同事战力'},{id:'growth',name:'本周成长'},{id:'guild',name:'鱼群赛季'},{id:'guest',name:'游客榜'}]" :key="r.id" :class="{active:rankKind===r.id}" @click="rankKind=r.id">{{r.name}}</button></div><ol class="ranking-list"><li v-for="(entry,index) in ranking" :key="entry.userId??entry.id"><span class="rank-number">{{entry.rank??index+1}}</span><Fish :size="23"/><b>{{entry.nickname??entry.name}}</b><strong>{{rankKind==='growth'?entry.value:rankKind==='guild'?entry.points:entry.totalPower}}</strong></li></ol><p class="tiny-label">{{rankMeta.myRank?`我的名次：第${rankMeta.myRank}名`:'我尚未进入当前榜单'}}</p><button v-if="rankMeta.nextCursor" class="text-button" @click="moreRanks" :disabled="busy">加载更多</button><div v-if="!loading&&!ranking.length" class="empty-panel"><Trophy :size="46"/><h3>这里还很安静</h3><p>符合条件的玩家成长后，就会出现在这里。</p></div>
  </template>

  <template v-else-if="panel==='guild'">
    <div class="eyebrow"><Users :size="17"/>一群鱼，一个小世界</div><h1>{{guild?.name??'摸鱼，也要有组织'}}</h1><p class="panel-intro">8 位搭子，自愿捐献、共享装扮，也能在主缸里自然结伴。</p>
    <div v-if="session.me?.role==='GUEST'" class="notice">同事身份才能创建或加入组织。请先在“我的鱼”中绑定邀请码。</div>
    <template v-else-if="!session.me?.guildId">
      <label class="form-field">创建鱼群<input v-model="guildName" maxlength="12" placeholder="2—12个可见字符" aria-label="鱼群名称"/></label>
      <button class="primary wide" :disabled="busy||[...guildName.trim()].length<2" @click="guildAction('/guilds',{name:guildName,badge:'〰',color:'#21BDE7',notice:''},'鱼群已创建')">消耗 {{config.guild.creationCost}} 可用战力创建</button>
      <h3 class="section-title">发现鱼群</h3><div class="inline-form"><input v-model="guildSearch" maxlength="40" placeholder="搜索鱼群名称" aria-label="搜索鱼群" @keyup.enter="searchGuilds"/><button @click="searchGuilds" :disabled="busy">搜索</button></div>
      <div v-for="g in guilds" :key="g.id" class="list-row"><Users :size="24"/><div><b>{{g.name}}</b><small>{{g.memberCount??g.member_count??0}} / {{config.guild.memberLimit}} 位成员</small></div>
        <button v-if="g.application_status==='INVITED'" :disabled="busy" @click="guildAction(`/guilds/${g.id}/invitations/accept`,{version:g.version},'已接受邀请并加入鱼群')">接受邀请</button>
        <button v-else :disabled="busy||g.application_status==='PENDING'||(g.memberCount??g.member_count??0)>=config.guild.memberLimit" @click="guildAction(`/guilds/${g.id}/applications`,{},'申请已提交，等待接纳')">{{g.application_status==='PENDING'?'已申请':'申请加入'}}</button>
      </div>
      <button v-if="guildNext" class="text-button" @click="moreGuilds" :disabled="busy">加载更多鱼群</button>
      <div v-if="!guilds.length&&!loading" class="empty-panel">还没有鱼群，来创建第一个吧。</div>
    </template>
    <template v-else-if="guild">
      <div class="guild-summary"><div><b>{{guild.members?.length??0}} / {{config.guild.memberLimit}}</b><small>鱼群成员</small></div><div><b>{{guild.wallet?.availablePower??guild.wallet?.balance??0}}</b><small>组织钱包</small></div><div><b>{{myGuildRole==='LEADER'?'组织长':myGuildRole==='ADMIN'?'管理员':'成员'}}</b><small>你的权限</small></div></div>
      <div class="inline-form"><button class="primary" @click="followMember(session.me?.fishId??undefined)">由我领游</button><button @click="followMember()">加入队形</button><button @click="run(()=>session.follow(false),'已退出跟随')">退出跟随</button></div>
      <p class="tiny-label">领游者手动移动时成员自然跟随并保持间距；成员手动移动立即脱队。领游断线 {{config.guild.leaderDisconnectFallbackSeconds}} 秒后自动接替。</p>
      <div v-for="m in guild.members" :key="m.userId??m.user_id" class="list-row"><Fish :size="22"/><div><b>{{m.nickname??m.displayName??m.userId}}</b><small>{{m.online?'在线':'离线'}} · {{m.role==='LEADER'?'组织长':m.role==='ADMIN'?'管理员':'成员'}}</small></div>
        <div class="member-actions">
          <button v-if="m.online&&guildFollowers.has(m.fishId??m.fish_id)&&(m.userId??m.user_id)!==session.me?.userId" @click="followMember(m.fishId??m.fish_id)" :disabled="busy">跟随此鱼</button>
          <button v-if="myGuildRole==='LEADER'&&(m.userId??m.user_id)!==session.me?.userId" @click="guildAction(`/guilds/${guild.id}/members/${m.userId??m.user_id}/role`,{role:m.role==='ADMIN'?'MEMBER':'ADMIN',version:guild.version},m.role==='ADMIN'?'已取消管理员':'已任命管理员')" :disabled="busy">{{m.role==='ADMIN'?'取消管理':'设为管理'}}</button>
          <button v-if="myGuildRole==='LEADER'&&(m.userId??m.user_id)!==session.me?.userId" @click="guildAction(`/guilds/${guild.id}/transfer-leader`,{targetUserId:m.userId??m.user_id,version:guild.version},'已转让组织长')" :disabled="busy">转让</button>
          <button v-if="canManage&&(m.userId??m.user_id)!==session.me?.userId&&m.role!=='LEADER'&&(myGuildRole==='LEADER'||m.role==='MEMBER')" @click="guildAction(`/guilds/${guild.id}/members/${m.userId??m.user_id}/remove`,{version:guild.version},'成员已移出，进入24小时冷却')" :disabled="busy">移出</button>
        </div>
      </div>
      <template v-if="canManage">
        <label class="form-field">组织公告<input v-model="notice" maxlength="40" aria-label="组织公告"/></label><button class="text-button" @click="guildAction(`/guilds/${guild.id}`,{notice,version:guild.version},'公告已更新','PATCH')">保存公告</button>
        <div v-for="a in guild.applications?.filter((item:any)=>item.status==='PENDING')" :key="a.userId??a.user_id" class="list-row"><span>{{a.nickname??a.userId??a.user_id}} 申请加入</span><button @click="guildAction(`/guilds/${guild.id}/applications/${a.userId??a.user_id}/accept`,{version:guild.version},'已接纳成员')" :disabled="busy">接纳</button></div>
        <div v-for="p in invitablePlayers" :key="p.userId" class="list-row"><span>{{p.nickname}} · 在线同事</span><button @click="guildAction(`/guilds/${guild.id}/invitations`,{targetUserId:p.userId,version:guild.version},'邀请已发送，须由本人接受')" :disabled="busy">邀请</button></div>
      </template>
      <label class="form-field">自愿捐献（不可退回个人）<input type="number" v-model.number="donation" min="1" step="1" aria-label="捐献数量"/></label><button class="primary wide" @click="guildConfirm={kind:'donate',text:`确认自愿捐献 ${donation} 点可用战力？组织钱包仅可购买公共装扮。`}" :disabled="busy||donation<1">捐献 {{donation}} 战力</button>
      <div v-if="guildConfirm" class="purchase-confirm"><p>{{guildConfirm.text}}</p><div class="inline-form"><button @click="guildConfirm=null">取消</button><button class="primary" @click="confirmGuildAction">确认</button></div></div>
      <details class="bind-section"><summary>公共装扮与组织流水</summary><div v-for="item in config.catalog.filter(i=>i.scope==='GUILD')" :key="item.id" class="list-row"><span>{{item.name}} · {{item.price}} 战力</span><b v-if="guildItemOwned(item.id)">已拥有并启用</b><button v-else-if="myGuildRole==='LEADER'" @click="guildAction(`/guilds/${guild.id}/purchases`,{itemId:item.id,itemVersion:1},'公共装扮已购买并启用')" :disabled="busy">购买</button></div><button class="text-button" @click="loadLedger(true)" :disabled="busy">读取组织流水</button><div v-for="l in guild.ledger" :key="l.id" class="ledger-row">{{l.kind}} · {{l.amount>0?'+':''}}{{l.amount}} · 余额{{l.balance_after}} · {{new Date(l.created_at??l.createdAt).toLocaleString('zh-CN')}}</div><button v-if="ledgerNext" class="text-button" @click="loadLedger(false)" :disabled="busy">加载更多流水</button></details>
      <details class="bind-section"><summary>成员与组织管理</summary><p class="tiny-label">退出或被移出后 {{config.guild.rejoinCooldownHours}} 小时内不能加入或创建其他鱼群；比赛期间不能退出或移除。组织长须先转让职位或解散。</p><button v-if="myGuildRole!=='LEADER'" class="danger-button" @click="guildAction(`/guilds/${guild.id}/leave`,{},'已退出鱼群，进入24小时冷却')" :disabled="busy">退出鱼群</button><button v-else class="danger-button" @click="guildConfirm={kind:'dissolve',text:'解散会归档全部组织资产，不向个人退款；仍有未完成比赛时服务器会拒绝。确认继续？'}" :disabled="busy">解散鱼群</button></details>
    </template>
  </template>

  <ArenaPanel v-else-if="panel==='arena'" :target-user-id="arenaTargetUserId" @close="emit('close')" @toast="text=>emit('toast',text)"/>
</template>
