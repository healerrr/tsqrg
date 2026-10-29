<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { Fish, Waves, ShoppingBag, Users, Trophy, Utensils, X, ChevronRight, Settings2, Volume2, VolumeX, Zap, Shield, Crown, MousePointer2, Keyboard, ArrowUpRight, Sparkles, Check, Palette, Info } from 'lucide-vue-next';
import { createAquarium } from './game/aquarium';
import type { Appearance, FishSnapshot, PresetId, PublicPlayerCard } from '@aquarium/protocol';
import { config, xpForLevel, xpToNext } from '@aquarium/core';
import { api } from './api';
import { useSession } from './stores/session';
import OnlinePanels from './components/OnlinePanels.vue';
import { createGameSound } from './game-sound';
import VirtualJoystick from './components/VirtualJoystick.vue';
const host=ref<HTMLElement>();
const dialog=ref<HTMLElement>();
let previousFocus:HTMLElement|null=null;
let aquarium:Awaited<ReturnType<typeof createAquarium>>|undefined;
const panel=ref(''); const selected=ref(''); const selectedCard=shallowRef<PublicPlayerCard|null>(null); const selectedLoading=ref(false); const selectedError=ref(''); const arenaTargetUserId=ref(''); const fps=ref(0); const message=ref('');
const muted=ref(localStorage.getItem('tank.muted')!=='false');
const reduced=ref(localStorage.getItem('tank.reduced')==='true');
const quality=ref<'normal'|'low'>(localStorage.getItem('tank.quality')==='low'?'low':'normal');
const sound=createGameSound(muted.value);
const presets:{id:PresetId;name:string;tag:string;color:string}[]=[{id:'goldfish',name:'金鱼',tag:'均衡',color:'#ffaa45'},{id:'clownfish',name:'小丑鱼',tag:'均衡',color:'#ff8057'},{id:'puffer',name:'河豚',tag:'耐打',color:'#a9ddb7'},{id:'betta',name:'斗鱼',tag:'灵活',color:'#aa8ceb'},{id:'angelfish',name:'神仙鱼',tag:'均衡',color:'#fff8e8'},{id:'ray',name:'鳐鱼',tag:'灵活',color:'#62d6ec'}];
const appearance=ref<Appearance>({presetId:'goldfish',bodyColor:'#ffaa45',finColor:'#539bec',patternId:'stripes',skinAssetId:null,equipped:{face:'glasses.round'},version:1});
const colors=['#ffaa45','#ff7b88','#a9ddb7','#aa8ceb','#6dd9ed','#fff8e8'];
const session=useSession();
const isPreview=new URLSearchParams(location.search).get('preview')==='1';
const selfName=computed(()=>session.me?.nickname||'我的摸鱼搭子');
const selfLevel=computed(()=>session.me?.level??1);
const selfXpPercent=computed(()=>!session.me?0:session.me.level>=config.fish.maxLevel?100:Math.max(0,(session.me.totalXp-xpForLevel(session.me.level))/xpToNext(session.me.level)*100));
const battleSnapshot=computed(()=>session.snapshot?.sceneKind!=='TANK'?session.snapshot:null);
const teamAFish=computed(()=>battleSnapshot.value?.fish.filter(f=>f.team==='A')??[]);
const teamBFish=computed(()=>battleSnapshot.value?.fish.filter(f=>f.team==='B')??[]);
const battleSeconds=computed(()=>Math.max(0,Math.ceil(((battleSnapshot.value?.match?.deadlineAtServerMs??0)-(battleSnapshot.value?.serverTimeMs??0))/1000)));
const dashCooldown=computed(()=>Math.max(0,Math.ceil(((battleSnapshot.value?.ownRuntime?.dashReadyAtServerMs??0)-(battleSnapshot.value?.serverTimeMs??0))/100)/10));
const shieldCooldown=computed(()=>Math.max(0,Math.ceil(((battleSnapshot.value?.ownRuntime?.shieldReadyAtServerMs??0)-(battleSnapshot.value?.serverTimeMs??0))/100)/10));
const reconnectingFish=computed(()=>battleSnapshot.value?.fish.filter(f=>(f.disconnectDeadlineAtServerMs??0)>(battleSnapshot.value?.serverTimeMs??0))??[]);
const battlePhaseLabels:Record<string,string>={COUNTDOWN:'准备入场',RUNNING:'对战中',OVERTIME:'加时',SETTLING:'结算中',FINISHED:'比赛结束',ABORTED:'系统中止'};
const battlePhaseLabel=computed(()=>battlePhaseLabels[battleSnapshot.value?.match?.phase??'']??battleSnapshot.value?.match?.phase);
function battleFishStatus(fish:FishSnapshot){const now=battleSnapshot.value?.serverTimeMs??Date.now();if(fish.withdrawn)return '已退出';if((fish.disconnectDeadlineAtServerMs??0)>now)return `重连 ${Math.ceil(((fish.disconnectDeadlineAtServerMs??0)-now)/1000)}s`;if((fish.respawnAtServerMs??0)>now)return `复活 ${Math.ceil(((fish.respawnAtServerMs??0)-now)/1000)}s`;return `${fish.hp??0}/${fish.maxHp??0}`;}
const topRanks=shallowRef<{nickname:string;totalPower:number;rank:number}[]>([]),boardError=ref(false);
let boardTimer:ReturnType<typeof setInterval>|undefined;
async function refreshBoard(){if(isPreview||session.status!=='online')return;try{const r=await api<{entries:typeof topRanks.value}>('/leaderboards?kind=current&scope=members&limit=3');topRanks.value=r.entries;boardError.value=false;}catch{boardError.value=true;}}
const dock=[{id:'feed',label:'投喂',icon:Utensils,color:'#ffc06a'},{id:'fish',label:'我的鱼',icon:Fish,color:'#64c7fb'},{id:'shop',label:'商城',icon:ShoppingBag,color:'#ff899c'},{id:'guild',label:'鱼群组织',icon:Users,color:'#bda7f5'},{id:'arena',label:'竞技场',icon:Trophy,color:'#ffd36c'}];
const currentPreset=computed(()=>presets.find(p=>p.id===appearance.value.presetId)!);
const locationTitle=computed(()=>session.snapshot?.sceneKind==='TEAM'?'组织竞技场':session.snapshot?.sceneKind==='DUEL'?'个人竞技场':'公共水族箱');
const locationSubtitle=computed(()=>{if(isPreview)return '01 · 珊瑚海';const scene=session.snapshot;if(!scene)return '连接中';if(scene.sceneKind!=='TANK')return `${scene.sceneKind==='TEAM'?'3v3 抢珠':'1v1 对决'} · ${scene.roomId.slice(0,14)}`;const number=scene.roomId.split(':')[1]??'1';return `${number.padStart(2,'0')} · 珊瑚海`;});
const items=config.catalog.filter(i=>i.scope==='PERSONAL');
let toastTimer:ReturnType<typeof setTimeout>;
function toast(text:string){message.value=text;clearTimeout(toastTimer);toastTimer=setTimeout(()=>message.value='',3500);}
function open(id:string,targetUserId=''){selected.value='';selectedCard.value=null;selectedError.value='';if(id==='arena')arenaTargetUserId.value=targetUserId;if(!isPreview&&session.me&&!session.me.fishId&&!['settings','guide'].includes(id)){panel.value='create';return;}panel.value=panel.value===id?'':id;}
async function selectFish(id:string){
  selected.value=id;panel.value='';selectedCard.value=null;selectedError.value='';selectedLoading.value=false;
  if(isPreview||id===session.me?.fishId)return;
  selectedLoading.value=true;
  try{const card=await api<PublicPlayerCard>(`/players/${encodeURIComponent(id)}/card`);if(selected.value===id)selectedCard.value=card;}
  catch(error){if(selected.value===id)selectedError.value=(error as Error).message;}
  finally{if(selected.value===id)selectedLoading.value=false;}
}
function choose(p:typeof presets[number]){appearance.value={...appearance.value,presetId:p.id,bodyColor:p.color};}
function previewItem(item:typeof items[number]){appearance.value={...appearance.value,equipped:{...appearance.value.equipped,[item.slot]:item.id}};toast('试穿已显示在你的鱼上');}
function dash(){aquarium?.triggerAction('dash');if(isPreview)sound.play('dash');}
function reloadPage(){window.location.reload();}
watch(appearance,v=>aquarium?.setAppearancePreview(v),{deep:true});
watch(panel,v=>{aquarium?.setInputEnabled(!v&&(isPreview||session.controlled));if(!v&&!isPreview)aquarium?.setAppearancePreview(null);});
watch(panel,async(value,old)=>{if(value&&!old)previousFocus=document.activeElement as HTMLElement;if(value){await nextTick();dialog.value?.focus();}else previousFocus?.focus();});
watch(()=>session.controlled,v=>{aquarium?.setInputEnabled(!panel.value&&v);if(!v)aquarium?.resetPrediction();});
watch(()=>session.status,v=>{if(v!=='online'&&!isPreview)aquarium?.resetPrediction();});
watch(()=>session.status,v=>{if(v==='online'){void refreshBoard();if(!boardTimer)boardTimer=setInterval(()=>void refreshBoard(),5000);}});
watch(()=>session.me,v=>{if(v?.appearance){appearance.value=structuredClone(v.appearance);}if(v&&!v.fishId&&!isPreview)panel.value='create';});
watch(()=>session.me?.currentMatchId,(id,old)=>{if(id&&id!==old&&session.snapshot?.sceneKind==='TANK'){panel.value='arena';toast('收到一场对决邀请，请查看并独立确认');}});
watch(()=>session.snapshot?.match?.phase,phase=>{if(phase==='FINISHED'||phase==='ABORTED'){panel.value='arena';toast(phase==='FINISHED'?'比赛已结算，可查看真实战力变化':'比赛已中止，冻结战力已经释放');}});
watch(reduced,v=>{aquarium?.setReducedMotion(v);localStorage.setItem('tank.reduced',String(v));});
watch(quality,v=>{aquarium?.setQuality(v);localStorage.setItem('tank.quality',v);});
watch(muted,v=>{localStorage.setItem('tank.muted',String(v));sound.setMuted(v);});
function escape(e:KeyboardEvent){if(e.key==='Escape'){panel.value='';selected.value='';}if(e.key==='Tab'&&panel.value&&dialog.value){const list=[...dialog.value.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href],summary')].filter(el=>el.getClientRects().length);const first=list[0],last=list.at(-1);if(!first)return;if(e.shiftKey&&(document.activeElement===first||document.activeElement===dialog.value)){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}}
onMounted(async()=>{try{aquarium=await createAquarium(host.value!,{onMove:move=>session.setMove(move),onAction:kind=>session.action(kind),onSelect:id=>{void selectFish(id);},onStats:stats=>fps.value=Math.round(stats.fps),onError:toast});aquarium.setPreviewMode(isPreview);aquarium.setReducedMotion(reduced.value);aquarium.setQuality(quality.value);if(isPreview)aquarium.setAppearancePreview(appearance.value);session.onInput(p=>aquarium?.recordInput(p));session.onSnapshot(p=>{aquarium?.setSnapshot(p);aquarium?.setSelfId(session.me?.fishId??null);});session.onEvent(e=>{aquarium?.showEvent(e);sound.play(e.payload.kind);});if(import.meta.env.DEV&&new URLSearchParams(location.search).has('qa'))Object.assign(window,{__aquarium:aquarium,__session:session});await session.start(isPreview);}catch(e){toast('水族箱加载失败，请刷新重试');console.error(e);}window.addEventListener('keydown',escape);});
onBeforeUnmount(()=>{session.stop();sound.destroy();aquarium?.destroy();clearTimeout(toastTimer);if(boardTimer)clearInterval(boardTimer);window.removeEventListener('keydown',escape);});
</script>

<template>
  <main class="game-shell">
    <div ref="host" class="aquarium-host" aria-label="可操作的公共水族箱"></div>
    <header class="topbar">
      <a class="brand" href="/" aria-label="同事请入缸首页"><span class="brand-fish"><Fish :size="30" stroke-width="2.6" /></span><span>同事<span class="warm">请入</span>缸<small>工作之外，一起摸鱼。</small></span></a>
      <div class="location"><Waves :size="18"/><span>{{locationTitle}}<small>{{locationSubtitle}}</small></span><span class="location-dot"></span></div>
      <div class="top-actions"><span class="preview-badge" :class="{connected:!isPreview&&session.status==='online'}"><span></span>{{isPreview?'本地美术预览':session.status==='online'?`在线 ${session.onlineCount} / ${config.tank.maxOnlinePlayers}`:session.status==='reconnecting'?'正在重连…':'连接中…'}}</span><button class="icon-button" @click="muted=!muted" :aria-label="muted?'开启声音':'静音'"><VolumeX v-if="muted" :size="20"/><Volume2 v-else :size="20"/></button><button class="icon-button" aria-label="设置" @click="open('settings')"><Settings2 :size="20"/></button></div>
    </header>

    <aside v-if="session.snapshot?.sceneKind!=='DUEL'&&session.snapshot?.sceneKind!=='TEAM'" class="leaderboard glass" aria-label="本地场景说明">
      <button class="board-title" @click="open('rank')"><span><Crown :size="20" class="gold"/>战力榜</span><ChevronRight :size="18"/></button>
      <div v-if="!isPreview&&topRanks.length" class="mini-ranking"><button v-for="entry in topRanks" :key="entry.rank" @click="open('rank')"><span>{{entry.rank}}</span><Fish :size="22"/><b>{{entry.nickname}}</b><strong>{{entry.totalPower}}</strong></button><p>我的战力 {{session.me?.wallet.totalPower??0}} · 可用 {{session.me?.wallet.availablePower??0}}</p></div><div v-else class="board-empty"><div class="board-illustration"><Trophy :size="27"/></div><b>{{isPreview?'每次成长，都算数':boardError?'榜单暂时无法读取':'同事榜还很安静'}}</b><p v-if="isPreview">接入真实联机后，<br>这里展示同事的实时战力。</p><p v-else>我的战力 {{session.me?.wallet.totalPower??0}}<br>可用 {{session.me?.wallet.availablePower??0}} · 冻结 {{session.me?.wallet.heldPower??0}}</p><span class="tiny-label">{{isPreview?'当前为本地美术预览':'正式榜与游客榜分别展示'}}</span></div>
      <button class="board-link" @click="open('guide')">认识这个水族箱 <ArrowUpRight :size="14"/></button>
    </aside>

    <div class="water-label"><span class="live-dot"></span>{{session.snapshot?.sceneKind==='TEAM'?'3v3 抢珠战':session.snapshot?.sceneKind==='DUEL'?'1v1 个人赛':'六种鱼型 · 自由游动'}}</div>
    <section v-if="battleSnapshot?.match" class="battle-hud glass" aria-label="竞技状态">
      <div class="battle-side team-a"><span class="battle-team-label">◆ A队</span><div class="battle-squad"><div v-for="fish in teamAFish" :key="fish.id" :class="{own:fish.id===session.me?.fishId,carrier:battleSnapshot.pearl?.carrierFishId===fish.id,withdrawn:fish.withdrawn}"><b>{{fish.nickname}}</b><strong>{{battleFishStatus(fish)}}</strong></div></div></div>
      <div class="battle-clock"><small>{{battlePhaseLabel}}</small><b>{{battleSeconds}}</b><span>秒</span><em>{{battleSnapshot.match.scoreA}} : {{battleSnapshot.match.scoreB}}</em><button class="battle-menu" @click="open('arena')">比赛菜单</button></div>
      <div class="battle-side team-b"><span class="battle-team-label">● B队</span><div class="battle-squad"><div v-for="fish in teamBFish" :key="fish.id" :class="{own:fish.id===session.me?.fishId,carrier:battleSnapshot.pearl?.carrierFishId===fish.id,withdrawn:fish.withdrawn}"><b>{{fish.nickname}}</b><strong>{{battleFishStatus(fish)}}</strong></div></div></div>
    </section>
    <div v-if="battleSnapshot?.match?.phase==='COUNTDOWN'" class="arena-countdown">{{battleSeconds||'开始'}}</div>
    <div v-if="battleSnapshot" class="orientation-warning glass" role="status">竞技操作建议切换为手机横屏；竖屏可继续观察和打开比赛菜单。</div>
    <div v-if="reconnectingFish.length" class="battle-disconnect glass">{{reconnectingFish.some(fish=>fish.id===session.me?.fishId)?'你的连接正在恢复':`${reconnectingFish.length} 名参赛者正在重连`}}，倒计时后将退出本局</div>
    <div v-if="!isPreview&&session.status==='online'&&!session.controlled&&session.me?.fishId" class="control-notice glass">当前页面为观察模式 <button @click="session.claimControl().catch(e=>toast(e.message))">接管控制</button></div>
    <div v-if="!isPreview&&session.status==='error'" class="network-error glass" role="alert"><b>暂时无法进入水族箱</b><p>{{session.error}}</p><button class="primary" @click="reloadPage">重新连接</button><a href="/?preview=1">查看本地美术预览</a></div>
    <div v-if="!isPreview&&session.status==='reconnecting'" class="reconnect-banner" role="status">连接中断，正在重新连接。操作已暂停。</div>
    <div class="hint"><MousePointer2 :size="16"/><span>点按水面游动</span><i></i><Keyboard :size="17"/><span>WASD 移动 / 空格冲刺{{battleSnapshot?' / E 护盾':''}}</span></div>

    <section v-if="!battleSnapshot" class="self-mini glass" @click="open('fish')" @keydown.enter="open('fish')" tabindex="0" role="button" aria-label="查看我的鱼">
      <span class="self-avatar" :style="{background:appearance.bodyColor}"><Fish :size="29"/></span><div><b>{{selfName}} <span>你</span></b><small>Lv.{{selfLevel}} · {{currentPreset.name}} · {{isPreview?'预览':session.me?.role==='GUEST'?'游客':'同事'}}</small><div class="xp-line"><span :style="{width:selfXpPercent+'%'}"></span></div></div><ChevronRight :size="16"/>
    </section>

    <nav v-if="!battleSnapshot" class="bottom-dock" aria-label="主菜单"><button v-for="entry in dock" :key="entry.id" :class="{active:panel===entry.id}" @click="open(entry.id)"><span class="dock-icon" :style="{color:entry.color}"><component :is="entry.icon" :size="30" stroke-width="2.3"/></span><span>{{entry.label}}</span><i v-if="entry.id==='fish'"></i></button></nav>
    <VirtualJoystick :disabled="!!panel||(!isPreview && !session.controlled)" @move="aquarium?.setMoveIntent($event)"/><div class="skill-controls"><button v-if="battleSnapshot" class="skill-button" :disabled="shieldCooldown>0" @click="aquarium?.triggerAction('shield')" aria-label="护盾"><Shield :size="27"/><small>{{shieldCooldown>0?`${shieldCooldown.toFixed(1)}秒`:'护盾'}} <kbd>E</kbd></small></button><button class="skill-button" :disabled="!!battleSnapshot&&dashCooldown>0" @click="dash" aria-label="冲刺"><Zap :size="27"/><small>{{battleSnapshot&&dashCooldown>0?`${dashCooldown.toFixed(1)}秒`:'冲刺'}} <kbd>空格</kbd></small></button></div>
    <span class="world-note">珊瑚海 · 慢一点，也没关系</span>

    <Transition name="toast"><div v-if="message" class="toast-message" role="status"><Check :size="18"/>{{message}}</div></Transition>

    <div v-if="selected" class="fish-card glass"><button class="close-small" aria-label="关闭角色卡" @click="selected='';selectedCard=null"><X :size="18"/></button><Fish :size="38" class="gold"/><h3>{{isPreview?'水族箱里的朋友':session.snapshot?.fish.find(f=>f.id===selected)?.nickname}}</h3><p v-if="isPreview">本地展示角色</p><template v-else-if="selected===session.me?.fishId"><p>Lv.{{session.me?.level??1}} · {{session.me?.guildId?'已加入鱼群':'自由游动'}} · {{session.me?.wallet.totalPower??0}} 战力</p></template><template v-else-if="selectedCard"><p>Lv.{{selectedCard.level}} · {{selectedCard.guild?`${selectedCard.guild.badge} ${selectedCard.guild.name}`:'自由游动'}} · {{selectedCard.totalPower}} 战力</p><div class="card-record"><span v-for="record in selectedCard.recentMatches.slice(0,5)" :key="record.matchId" :class="record.outcome.toLowerCase()">{{record.outcome==='WIN'?'胜':record.outcome==='LOSS'?'负':record.outcome==='DRAW'?'平':'止'}}</span><small>{{selectedCard.recentMatches.length?'最近战绩':'还没有战绩'}}</small></div><p v-if="!selectedCard.online" class="card-busy">当前为离线展示，不能发起邀请</p><p v-else-if="selectedCard.currentMatchId" class="card-busy">这条鱼正在比赛中</p></template><p v-else-if="selectedLoading">正在读取真实战力与战绩…</p><p v-else class="card-busy">{{selectedError||'角色资料暂时不可用'}}</p><button class="primary" :disabled="!isPreview&&selected!==session.me?.fishId&&(!selectedCard||!selectedCard.online||!!selectedCard.currentMatchId)" @click="open(selected===session.me?.fishId?'fish':'arena',selectedCard?.userId??'')">{{isPreview?'看看我的鱼':selected===session.me?.fishId?'查看我的鱼':!selectedCard?.online?'当前离线':selectedCard?.currentMatchId?'比赛进行中':'邀请一场 PK'}}</button></div>

    <div v-if="panel" class="modal-backdrop" @pointerdown.self="panel=''">
      <section ref="dialog" tabindex="-1" class="panel" role="dialog" aria-modal="true" :aria-label="panel==='fish'?'我的鱼':'水族箱面板'">
        <button class="panel-close" aria-label="关闭面板" @click="panel=''"><X :size="21"/></button>
        <OnlinePanels v-if="!isPreview&&panel!=='settings'&&panel!=='guide'" :panel="panel" :presets="presets" :colors="colors" :appearance="appearance" :arena-target-user-id="arenaTargetUserId" @preview="v=>{appearance=v;aquarium?.setAppearancePreview(v)}" @close="panel=''" @toast="toast"/>
        <template v-else-if="panel==='fish'">
          <div class="eyebrow"><Fish :size="17"/> 我的摸鱼搭子</div><h1>今天，想做哪条鱼？</h1><p class="panel-intro">选个合拍的模样，游进自己的节奏。</p>
          <div class="fish-selector"><button v-for="p in presets" :key="p.id" :class="{chosen:appearance.presetId===p.id}" @click="choose(p)"><span class="preset-icon" :style="{background:p.color}"><Fish :size="30"/></span><b>{{p.name}}</b><small>{{p.tag}}</small><Check v-if="appearance.presetId===p.id" class="preset-check" :size="14"/></button></div>
          <label class="field-label"><Palette :size="16"/>身体配色</label><div class="swatches"><button v-for="color in colors" :key="color" :style="{background:color}" :class="{chosen:appearance.bodyColor===color}" @click="appearance.bodyColor=color" :aria-label="`选择颜色${color}`"><Check v-if="appearance.bodyColor===color" :size="18"/></button></div>
          <label class="field-label">尾鳍颜色 <input type="color" v-model="appearance.finColor" aria-label="尾鳍颜色"/></label>
          <div class="notice"><Info :size="17"/>当前外观仅在本地预览，不写入角色资产。</div><button class="primary wide" @click="panel='';toast('外观已用于本次本地预览')">就这样，去游泳 <ArrowUpRight :size="17"/></button>
        </template>
        <template v-else-if="panel==='shop'">
          <div class="eyebrow"><ShoppingBag :size="17"/> 摸鱼好物</div><h1>给摸鱼加点个性</h1><p class="panel-intro">配饰只改变外观。点击商品，看看上身效果。</p><div class="shop-grid"><button v-for="(item,index) in items" :key="item.id" @click="previewItem(item)"><span class="product-art" :class="'product-'+index"><component :is="[Sparkles,Shield,Crown,Fish,Zap,Waves][index]" :size="39"/></span><b>{{item.name}}</b><span class="price">{{item.price}} 战力 <small>试穿</small></span></button></div><div class="notice">本地预览没有购买入口；真实钱包接入后开放购买与永久衣橱。</div>
        </template>
        <template v-else-if="panel==='feed'">
          <div class="eyebrow"><Utensils :size="17"/> 开饭时间</div><h1>开饭啦，摸鱼搭子</h1><p class="panel-intro">公共水族箱会随机落下鱼粮。正式联机中，每天还能主动投喂 {{config.daily.manualFeedUses}} 次。</p><div class="large-illustration"><Utensils :size="68"/><span>鱼粮从水面缓缓下沉</span></div><div class="notice">本地场景中的食物用于演示吃食动作，没有经验或战力到账。</div><button class="primary wide" @click="panel='';aquarium?.feedPreview();toast('试着游向水中金色的鱼粮吧')">去找点好吃的 <ChevronRight :size="18"/></button>
        </template>
        <template v-else-if="panel==='guild'">
          <div class="eyebrow"><Users :size="17"/> 一群鱼，一个小世界</div><h1>摸鱼，也要有组织</h1><p class="panel-intro">最多 {{config.guild.memberLimit}} 位搭子，一起游动、一起装扮，奔赴一场抢珠团战。</p><div class="large-illustration guild-art"><Users :size="72"/><span>一群鱼，一个小世界</span></div><div class="notice">组织需要同事身份和真实服务器。当前为美术与操控预览。</div><button class="primary wide" @click="panel=''">先在珊瑚海逛逛</button>
        </template>
        <template v-else-if="panel==='arena'">
          <div class="eyebrow"><Trophy :size="17"/> 偶尔认真一下</div><h1>偶尔，也要认真一下</h1><p class="panel-intro">30 秒个人 PK，或和搭子一起参加 3v3 抢珠战。</p><div class="mode-cards"><div><Zap :size="30"/><h3>1v1 个人赛</h3><p>冲刺与护盾，见招拆招</p></div><div><Shield :size="30"/><h3>3v3 抢珠战</h3><p>争夺珍珠，守住每一秒</p></div></div><div class="notice">真实对战在联机阶段开放。正式赛需所有参赛者独立确认押注。</div>
        </template>
        <template v-else-if="panel==='settings'">
          <div class="eyebrow"><Settings2 :size="17"/> 按你的节奏来</div><h1>按你的节奏来</h1><div class="setting-row"><div><b>静音</b><p>记住这台设备上的声音偏好</p></div><button class="toggle" :class="{on:muted}" @click="muted=!muted" role="switch" :aria-checked="muted" aria-label="静音"><i></i></button></div><div class="setting-row"><div><b>减弱动态效果</b><p>减少气泡和尾迹，保留必要反馈</p></div><button class="toggle" :class="{on:reduced}" @click="reduced=!reduced" role="switch" :aria-checked="reduced" aria-label="减弱动态效果"><i></i></button></div><div class="setting-row"><div><b>低画质</b><p>降低像素密度与粒子数量，规则与速度保持一致</p></div><button class="toggle" :class="{on:quality==='low'}" @click="quality=quality==='low'?'normal':'low'" role="switch" :aria-checked="quality==='low'" aria-label="低画质"><i></i></button></div><button v-if="session.me?.role==='ADMIN'" class="text-button" @click="open('admin')">管理员工具</button><p class="tiny-label">渲染 {{fps}} FPS · {{isPreview?'本地美术预览':'真实联机'}} · 规则 {{config.rulesVersion}}</p>
        </template>
        <template v-else-if="panel==='rank'">
          <div class="eyebrow"><Crown :size="17"/> 每次成长，都算数</div><h1>每次成长，都算数</h1><p class="panel-intro">当前战力由永久基础战力与可争夺余额相加。购买装扮不会降低你的等级。</p><div class="empty-panel"><Trophy :size="50"/><h3>真实榜单，即将接入</h3><p>当前是本地场景，没有在线榜单数据。</p></div>
        </template>
        <template v-else>
          <div class="eyebrow"><Waves :size="17"/> 欢迎来到珊瑚海</div><h1>工作之外，一起摸鱼。</h1><p class="panel-intro">这里是你的公共水族箱。选一条喜欢的鱼，游到任何想去的地方。</p><div class="guide-steps"><p><MousePointer2/>点按水面，或按住鼠标持续游动</p><p><Keyboard/>WASD / 方向键移动，空格冲刺</p><p><Fish/>点击鱼看卡片，底部入口打开面板</p></div><button class="primary wide" @click="panel=''">知道啦，入缸！</button>
        </template>
      </section>
    </div>
  </main>
</template>
