<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import { Eye, Fish, RefreshCw, Shield, Trophy, Users } from 'lucide-vue-next';
import type { MatchMode, MatchPhase, MatchResultView } from '@aquarium/protocol';
import { config } from '@aquarium/core';
import { api, command } from '../api';
import { useSession } from '../stores/session';

interface Participant { userId:string;fishId:string;nickname:string;team:'A'|'B';ready:boolean;withdrawn?:boolean }
interface Match { id:string;mode:MatchMode;phase:MatchPhase;stake:number;version:number;quoteVersion:number;deadlineAtServerMs:number;guildA:string|null;guildB:string|null;participants:Participant[];result:MatchResultView|null }
interface GuildMember { userId:string;nickname:string;role:string;online:boolean;currentMatchId?:string|null }
interface Guild { id:string;name:string;members:GuildMember[] }
interface Player { userId:string;nickname:string;role:string;totalPower:number;currentMatchId:string|null }
interface GuildOption { id:string;name:string;member_count?:number }
interface GuildRank { guildId:string;name:string;points:number;wins:number;draws:number;losses:number;rank:number }
interface Page<T> { items?:T[];entries?:T[];nextCursor?:string|null }
const props=defineProps<{targetUserId?:string}>();
const emit=defineEmits<{close:[];toast:[string]}>();
const session=useSession();
const match=shallowRef<Match|null>(null),history=shallowRef<MatchResultView[]>([]),players=shallowRef<Player[]>([]),guild=shallowRef<Guild|null>(null),guilds=shallowRef<GuildOption[]>([]),guildMatches=shallowRef<Match[]>([]),guildRanks=shallowRef<GuildRank[]>([]);
const seasonId=ref(''),seasonSelection=ref(''),currentSeason=ref(true),myGuildRank=ref<number|null>(null),guildRankNext=ref<string|null>(null),guildRankLimit=ref(8);
const historyMode=ref<'ALL'|MatchMode>('ALL'),historyNext=ref<string|null>(null),historyLimit=ref(20);
const busy=ref(false),loading=ref(true),error=ref(''),formal=ref(false),mode=ref<'solo'|'team'>('solo'),roster=ref<string[]>([]),targetGuild=ref(''),cancelConfirm=ref(false),showLatest=ref(true);
const now=ref(Date.now());let clock:ReturnType<typeof setInterval>|undefined,poll:ReturnType<typeof setInterval>|undefined,reading=false,disposed=false;
const phaseLabels:Record<MatchPhase,string>={INVITED:'等待接受邀请',READY_CHECK:'各自确认押注',COUNTDOWN:'倒计时入场',RUNNING:'对战进行中',OVERTIME:'加时抢珠',SETTLING:'战力结算中',FINISHED:'比赛已完成',ABORTED:'系统中止，冻结已释放'};
const reasonLabels:Record<MatchResultView['reason'],string>={HP_ZERO:'生命耗尽',TIME:'时间结束',SCORE_LIMIT:'达到目标分数',OVERTIME_HOLD:'加时连续持珠获胜',DRAW:'平局',FORFEIT:'主动退赛',DISCONNECT:'断线超时',SYSTEM_ABORT:'系统中止，冻结已释放'};
const own=computed(()=>match.value?.participants.find(p=>p.userId===session.me?.userId));
const team=computed(()=>match.value?.mode.startsWith('TEAM_')??false);
const finished=computed(()=>match.value&&['FINISHED','ABORTED'].includes(match.value.phase));
const myRole=computed(()=>guild.value?.members.find(m=>m.userId===session.me?.userId)?.role);
const manage=computed(()=>myRole.value==='LEADER'||myRole.value==='ADMIN');
const onlineMembers=computed(()=>guild.value?.members.filter(m=>m.online&&!m.currentMatchId||match.value?.phase==='INVITED'&&m.currentMatchId===match.value.id&&m.online)??[]);
const orderedPlayers=computed(()=>players.value.filter(player=>player.userId!==session.me?.userId).sort((a,b)=>Number(b.userId===props.targetUserId)-Number(a.userId===props.targetUserId)||a.nickname.localeCompare(b.nickname,'zh-CN')));
const canAccept=computed(()=>match.value?.phase==='INVITED'&&(team.value?session.me?.guildId===match.value.guildB&&manage.value:own.value?.team==='B'));
const seconds=computed(()=>Math.max(0,Math.ceil(((match.value?.deadlineAtServerMs??0)-now.value)/1000)));
const resultTitle=computed(()=>{const r=match.value?.result;if(!r)return '';if(r.phase==='ABORTED')return '比赛已中止';if(!r.winnerTeam)return '握手言和';if(!own.value)return `${r.winnerTeam==='A'?'◆ A':'● B'}队获胜`;return r.winnerTeam===own.value.team?'这局赢啦！':'下次再战！';});
const ownDelta=computed(()=>match.value?.result?.personalDeltas.find(d=>d.userId===session.me?.userId)?.deltaPower??0);
function items<T>(value:T[]|{items?:T[];entries?:T[]}):T[]{return Array.isArray(value)?value:value.items??value.entries??[];}
function guildName(id:string){return guilds.value.find(g=>g.id===id)?.name??(guild.value?.id===id?guild.value.name:'对战鱼群');}
function playerName(userId:string){return match.value?.participants.find(p=>p.userId===userId)?.nickname??'参赛搭子';}
function signed(value:number){return `${value>0?'+':''}${value}`;}
function historyPath(){const mode=historyMode.value==='ALL'?'':`&mode=${historyMode.value}`;return `/matches/history?limit=${historyLimit.value}${mode}`;}
function rankingPath(){const season=!currentSeason.value&&seasonSelection.value?`&seasonId=${encodeURIComponent(seasonSelection.value)}`:'';return `/leaderboards?kind=guild&limit=${guildRankLimit.value}${season}`;}
async function load(silent=false){
  if(reading||disposed)return;reading=true;if(!silent)loading.value=true;
  try{
    const [tank,results,ranking]=await Promise.all([api<Player[]>('/players'),api<Page<MatchResultView>>(historyPath()),api<Page<GuildRank>&{seasonId:string;myRank:number|null}>(rankingPath())]);
    players.value=items(tank);history.value=items(results);historyNext.value=results.nextCursor??null;guildRanks.value=items(ranking);guildRankNext.value=ranking.nextCursor??null;seasonId.value=ranking.seasonId;seasonSelection.value=ranking.seasonId;myGuildRank.value=ranking.myRank;
    if(session.me?.guildId){const [ownGuild,allGuilds]=await Promise.all([api<Guild>(`/guilds/${session.me.guildId}`),api<{items:GuildOption[]}>('/guilds?limit=100')]);guild.value=ownGuild;guilds.value=items(allGuilds);}
    else {guild.value=null;guilds.value=[];}
    const id=session.me?.currentMatchId??match.value?.id??(showLatest.value?session.lastMatchId:null);
    match.value=id?await api<Match>(`/matches/${id}`):null;
    const ids=[...new Set(guild.value?.members.map(m=>m.currentMatchId).filter((id):id is string=>!!id)??[])];
    const found=await Promise.all(ids.filter(id=>id!==match.value?.id).map(id=>api<Match>(`/matches/${id}`).catch(()=>null)));
    guildMatches.value=found.filter((row):row is Match=>!!row&&row.mode.startsWith('TEAM_'));
    now.value=Date.now();if(!silent)error.value='';
  }catch(e){error.value=(e as Error).message;}finally{reading=false;loading.value=false;}
}
async function run(fn:()=>Promise<void>){if(busy.value)return;busy.value=true;error.value='';try{await fn();await session.refresh();await load(true);}catch(e){error.value=(e as Error).message;await session.refresh().catch(()=>undefined);await load(true);}finally{busy.value=false;}}
async function invite(userId?:string){await run(async()=>{match.value=await command<Match>('/matches/invitations',userId?{mode:formal.value?'DUEL_FORMAL':'DUEL_FRIENDLY',targetUserId:userId}:{mode:formal.value?'TEAM_FORMAL':'TEAM_FRIENDLY',targetGuildId:targetGuild.value,roster:roster.value});showLatest.value=true;emit('toast','邀请已发送，等待对方选择并确认');});}
async function accept(){if(!match.value)return;await run(async()=>{match.value=await command<Match>(`/matches/${match.value!.id}/accept`,team.value?{version:match.value!.version,roster:roster.value}:{version:match.value!.version});});}
async function ready(){if(!match.value)return;await run(async()=>{match.value=await command<Match>(`/matches/${match.value!.id}/ready`,{quoteVersion:match.value!.quoteVersion,stake:match.value!.stake});if(match.value!.phase==='COUNTDOWN')emit('close');});}
async function cancel(){if(!match.value)return;cancelConfirm.value=false;await run(async()=>{match.value=await command<Match>(`/matches/${match.value!.id}/cancel`);});}
async function returnTank(){await run(async()=>{await session.joinTank();match.value=null;showLatest.value=false;emit('close');});}
async function lobby(){if(session.snapshot?.sceneKind!=='TANK')await session.joinTank();match.value=null;showLatest.value=false;session.forgetMatch();roster.value=[];cancelConfirm.value=false;await load();}
async function viewHistory(id:string){await run(async()=>{match.value=await api<Match>(`/matches/${id}`);showLatest.value=true;});}
async function watchMatch(id:string){await run(async()=>{await session.watchMatch(id);emit('close');});}
async function chooseSeason(useCurrent=false){currentSeason.value=useCurrent;if(useCurrent)seasonSelection.value='';guildRankLimit.value=8;await run(()=>load(true));}
async function chooseHistoryMode(value:'ALL'|MatchMode){historyMode.value=value;historyLimit.value=20;await run(()=>load(true));}
async function moreGuildRanks(){guildRankLimit.value=Math.min(100,guildRankLimit.value+8);await run(()=>load(true));}
async function moreHistory(){historyLimit.value=Math.min(100,historyLimit.value+20);await run(()=>load(true));}
onMounted(()=>{void load();poll=setInterval(()=>{if(!busy.value)void load(true);},2000);clock=setInterval(()=>now.value=Date.now(),250);});
onBeforeUnmount(()=>{disposed=true;if(poll)clearInterval(poll);if(clock)clearInterval(clock);});
</script>

<template>
  <div class="eyebrow"><Trophy :size="17"/>偶尔，也要认真一下</div>
  <h1>{{team?'一起守住这颗珍珠':'来一场水下对决'}}</h1>
  <p class="panel-intro">冲刺攻击，护盾防守。每位玩家只确认自己的押注。今日正式额度已用 {{session.me?.daily.formalUsed??0}}、准备预留 {{session.me?.daily.formalReserved??0}}、剩余 {{Math.max(0,config.daily.formalMatchesPerPlayer-(session.me?.daily.formalUsed??0)-(session.me?.daily.formalReserved??0))}} 场。</p>
  <div v-if="error" role="alert" class="inline-error">{{error}}<button aria-label="重新读取比赛" @click="load()"><RefreshCw :size="16"/></button></div>
  <p v-if="loading" class="loading-line">正在读取比赛与鱼群…</p>
  <template v-if="match">
    <div class="match-state"><b>{{phaseLabels[match.phase]}}</b><span>{{match.mode.endsWith('FORMAL')?'正式赛':'友谊赛'}} · 每人 {{match.stake}} 战力<span v-if="!finished&&seconds"> · {{seconds}} 秒</span></span></div>
    <p v-if="team" class="tiny-label">◆ {{guildName(match.guildA!)}} 对阵 ● {{guildName(match.guildB!)}}</p>
    <div class="match-roster" :class="{'team-roster':team}"><div v-for="p in match.participants" :key="p.userId" :class="p.team==='A'?'roster-a':'roster-b'"><Fish :size="25"/><b>{{p.nickname}}{{p.userId===session.me?.userId?'（你）':''}}</b><small>{{p.team==='A'?'◆ A队':'● B队'}} · {{p.withdrawn?'已退出':p.ready?'已确认':'待确认'}}</small></div></div>
    <div v-if="canAccept" class="ready-actions">
      <template v-if="team"><h3 class="section-title">选择本队 {{config.battle.teamSize}} 名在线成员</h3><p class="tiny-label">组队不代表替成员同意押注。六人仍需分别确认。</p><label v-for="p in onlineMembers" :key="p.userId" class="checkbox-line"><input v-model="roster" type="checkbox" :value="p.userId" :disabled="roster.length>=config.battle.teamSize&&!roster.includes(p.userId)"/>{{p.nickname}}</label><p v-if="onlineMembers.length<config.battle.teamSize" class="notice">在线且空闲的成员不足三人，请等待搭子入缸。</p></template>
      <button class="primary wide" @click="accept" :disabled="busy||(team&&roster.length!==config.battle.teamSize)">接受邀请，查看押注报价</button>
    </div>
    <p v-else-if="match.phase==='INVITED'" class="notice">邀请已送达，等待对方接受。此时没有扣除或冻结战力。</p>
    <template v-if="match.phase==='READY_CHECK'"><div class="notice">本局最多损失 {{match.stake}} 点战力。{{team?'六':'两'}}人全部同意后统一冻结，任何人的条件变化都须重新确认。</div><button v-if="own" class="primary wide" @click="ready" :disabled="busy||own.ready">{{own.ready?'已确认，等待其他玩家':`我同意本局最多损失 ${match.stake} 战力，准备`}}</button><p v-else class="tiny-label">你未在参赛名单中，不会冻结或扣除战力。</p></template>
    <div v-if="match.result" class="purchase-confirm match-result" aria-live="polite"><h2>{{resultTitle}}</h2><p>{{reasonLabels[match.result.reason]}} · {{match.result.scoreA}} : {{match.result.scoreB}}</p><strong v-if="own" class="result-delta">你 {{signed(ownDelta)}} 战力</strong><p v-if="own">当前争夺余额 {{session.me?.wallet.powerBalance??0}} · 可用 {{session.me?.wallet.availablePower??0}} · 冻结 {{session.me?.wallet.heldPower??0}}</p><div v-for="d in match.result.personalDeltas" :key="d.userId" class="settlement-row"><span>{{playerName(d.userId)}}</span><b>{{signed(d.deltaPower)}} 战力</b></div><div v-for="d in match.result.guildPointDeltas" :key="d.guildId" class="settlement-row"><span>{{guildName(d.guildId)}}</span><b>赛季 {{signed(d.points)}} 分</b></div><p v-if="match.result.phase==='ABORTED'">本局冻结已释放，正式参赛额度已恢复；没有胜负积分。</p></div>
    <div v-if="cancelConfirm" class="purchase-confirm"><p>{{team&&['COUNTDOWN','RUNNING','OVERTIME'].includes(match.phase)?'确认退出本局？你将无法重新参战，已确认的押注仍按最终结果结算；队友可以继续。':'确认取消准备或认输？已经开始的正式个人赛会按认输结算押注。'}}</p><div class="inline-form"><button @click="cancelConfirm=false">再想想</button><button class="danger-button" @click="cancel" :disabled="busy">确认{{team?'退出本局':'取消 / 认输'}}</button></div></div>
    <div class="inline-form match-controls"><button v-if="['COUNTDOWN','RUNNING','OVERTIME','SETTLING'].includes(match.phase)" class="primary" @click="own?emit('close'):watchMatch(match.id)" :disabled="busy"><Eye v-if="!own" :size="16"/>{{own?.withdrawn?'查看队友战况':own?'返回对战画面':'观战'}}</button><button v-if="own&&!finished&&!own.withdrawn" class="danger-button" @click="cancelConfirm=true" :disabled="busy">{{['COUNTDOWN','RUNNING','OVERTIME'].includes(match.phase)?team?'退出本局，承担最终押注':'认输':'取消准备 / 拒绝邀请'}}</button><template v-if="finished"><button class="primary" @click="lobby" :disabled="busy">再邀一场</button><button @click="returnTank" :disabled="busy">回到主缸</button></template></div>
  </template>
  <template v-else>
    <div class="tabs"><button :class="{active:mode==='solo'}" @click="mode='solo'">1v1 个人赛</button><button :class="{active:mode==='team'}" @click="mode='team'">3v3 抢珠战</button></div>
    <label class="checkbox-line"><input type="checkbox" v-model="formal" :disabled="session.me?.role==='GUEST'"/>正式赛（参赛者分别确认押注后转移战力）</label>
    <div v-if="session.me?.role==='GUEST'" class="notice">游客可参加个人友谊赛。在“我的鱼”中绑定同事后开放正式赛与鱼群团战。</div>
    <template v-if="mode==='solo'"><h3 class="section-title">邀请在线搭子</h3><div v-for="p in orderedPlayers" :key="p.userId" class="list-row" :class="{'selected-target':p.userId===targetUserId}"><Fish :size="23"/><div><b>{{p.nickname}}{{p.userId===targetUserId?' · 刚刚选中':''}}</b><small>{{p.totalPower}} 战力 · {{p.currentMatchId?'比赛中':'在主缸'}}</small></div><button @click="invite(p.userId)" :disabled="busy||!!p.currentMatchId">邀请{{formal?'正式 PK':'友谊赛'}}</button></div><p v-if="!orderedPlayers.length" class="empty-panel">还没有其他在线搭子，邀请同事一起入缸吧。</p></template>
    <template v-else-if="guild"><div class="notice"><Shield :size="18"/>持珠每秒 +1 分，达到 {{config.battle.pearl.scoreToWin}} 分获胜；平分加时连续持珠 {{config.battle.pearl.overtimeContinuousHoldSeconds}} 秒。生命耗尽 {{config.battle.pearl.respawnSeconds}} 秒后复活。</div><p class="tiny-label">正式团战和个人赛共用每天 {{config.daily.formalMatchesPerPlayer}} 场额度。每个鱼群每天 {{config.daily.formalTeamMatchesPerGuild}} 场，同一对鱼群每天 {{config.daily.formalTeamMatchesPerGuildPair}} 场。</p><template v-if="manage"><h3 class="section-title">本队阵容 · 已选 {{roster.length}} / {{config.battle.teamSize}}</h3><label v-for="p in guild.members" :key="p.userId" class="checkbox-line"><input type="checkbox" v-model="roster" :value="p.userId" :disabled="!p.online||!!p.currentMatchId||roster.length>=config.battle.teamSize&&!roster.includes(p.userId)"/>{{p.nickname}}<small>{{p.online?p.currentMatchId?' · 忙碌':' · 在线':' · 离线'}}</small></label><label class="form-field">挑战鱼群<select v-model="targetGuild" aria-label="对方鱼群"><option value="">选择另一个鱼群</option><option v-for="g in guilds.filter(g=>g.id!==guild?.id)" :key="g.id" :value="g.id">{{g.name}}</option></select></label><button class="primary wide" @click="invite()" :disabled="busy||roster.length!==config.battle.teamSize||!targetGuild">发起 3v3 {{formal?'正式':'友谊'}}挑战</button></template><p v-else class="notice">由组织长或管理员组织挑战；进入阵容后你会收到独立确认邀请。</p></template>
    <div v-else-if="mode==='team'" class="empty-panel"><Users :size="40"/><p>加入一个鱼群，与三名搭子一起抢珠。</p></div>
  </template>
  <section v-if="guildMatches.length" class="bind-section"><h3 class="section-title">鱼群正在进行的比赛</h3><div v-for="g in guildMatches" :key="g.id" class="list-row"><div><b>{{guildName(g.guildA!)}} vs {{guildName(g.guildB!)}}</b><small>{{phaseLabels[g.phase]}}</small></div><button @click="viewHistory(g.id)" :disabled="busy">查看 / 观战</button></div></section>
  <details class="bind-section"><summary>组织赛季榜 · {{seasonId}}<span v-if="myGuildRank"> · 本群第 {{myGuildRank}} 名</span></summary><div class="history-tools"><label>历史赛季<input v-model="seasonSelection" type="month" min="2020-01" max="2100-12" aria-label="组织榜赛季" @change="currentSeason=false"/></label><button @click="chooseSeason(false)" :disabled="busy||!/^\d{4}-(0[1-9]|1[0-2])$/.test(seasonSelection)">查看</button><button v-if="!currentSeason" @click="chooseSeason(true)" :disabled="busy">返回当前赛季</button></div><div v-for="entry in guildRanks" :key="entry.guildId" class="settlement-row"><span>{{entry.rank}}. {{entry.name}}<small> {{entry.wins}}胜 {{entry.draws}}平 {{entry.losses}}负</small></span><b>{{entry.points}} 分</b></div><button v-if="guildRankNext&&guildRankLimit<100" class="text-button" @click="moreGuildRanks" :disabled="busy">加载更多组织</button><p v-if="!guildRanks.length" class="tiny-label">本赛季还没有组织赛成绩。</p></details>
  <details class="bind-section"><summary>真实历史战绩 · 已显示 {{history.length}} 场</summary><div class="tabs history-tabs"><button v-for="entry in [{id:'ALL',name:'全部'},{id:'DUEL_FORMAL',name:'正式个人'},{id:'DUEL_FRIENDLY',name:'友谊个人'},{id:'TEAM_FORMAL',name:'正式团战'},{id:'TEAM_FRIENDLY',name:'友谊团战'}]" :key="entry.id" :class="{active:historyMode===entry.id}" :disabled="busy" @click="chooseHistoryMode(entry.id as 'ALL'|MatchMode)">{{entry.name}}</button></div><div v-for="h in history" :key="h.matchId" class="list-row"><div><b>{{h.mode.startsWith('TEAM_')?'3v3 团战':'个人 PK'}} · {{reasonLabels[h.reason]}}</b><small>{{new Date(h.committedAt).toLocaleString('zh-CN')}} · 押注 {{h.stake}}</small></div><button @click="viewHistory(h.matchId)" :disabled="busy">查看结果</button></div><button v-if="historyNext&&historyLimit<100" class="text-button" @click="moreHistory" :disabled="busy">加载更多战绩</button><p v-if="!history.length" class="tiny-label">还没有符合条件的战绩。</p></details>
</template>

<style scoped>
.history-tools{display:flex;align-items:end;gap:8px;flex-wrap:wrap;margin:13px 0}.history-tools label{display:flex;flex-direction:column;gap:5px;color:#78918d;font-size:9px}.history-tools input{min-height:36px;border:1px solid #d8e1d5;border-radius:8px;padding:6px 9px;background:#fffff7;color:#254e61}.history-tools button{min-height:36px;padding:7px 11px;border-radius:8px;background:#e4eadb;color:#598b85;font-size:9px}.history-tabs{margin-top:13px;margin-bottom:8px}
.selected-target{margin:4px -8px;padding-left:8px;padding-right:8px;border-radius:10px;background:#e7f3e8}
</style>
