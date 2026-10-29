/**
 * 协议设计起点，不是已经运行的服务。
 * 首版传输均为 JSON。实现时用运行时 schema 校验每个边界；
 * number 不代表可以接收 NaN、Infinity、负余额或非整数序号。
 */
export const PROTOCOL_VERSION = 1 as const;
export type Id = string;
export type Role = 'GUEST' | 'MEMBER' | 'ADMIN';
export type Trait = 'BALANCED' | 'AGILE' | 'TANK';
export type PresetId = 'goldfish' | 'clownfish' | 'puffer' | 'betta' | 'angelfish' | 'ray';
export type SceneKind = 'TANK' | 'DUEL' | 'TEAM';
export type MatchMode = 'DUEL_FRIENDLY' | 'DUEL_FORMAL' | 'TEAM_FRIENDLY' | 'TEAM_FORMAL';
export type MatchPhase = 'INVITED' | 'READY_CHECK' | 'COUNTDOWN' | 'RUNNING' | 'OVERTIME' | 'SETTLING' | 'FINISHED' | 'ABORTED';
export type ErrorCode = 'AUTH_REQUIRED' | 'MEMBER_REQUIRED' | 'FISH_NOT_OWNED' | 'CONTROL_TAKEN' | 'INSUFFICIENT_AVAILABLE_POWER' | 'STAKE_LOCKED' | 'ALREADY_OWNED' | 'DAILY_LIMIT_REACHED' | 'ROOM_FULL' | 'PEER_NOT_ELIGIBLE' | 'VERSION_CONFLICT' | 'RATE_LIMITED' | 'MATCH_STATE_INVALID' | 'UPLOAD_INVALID' | 'PROTOCOL_VERSION_UNSUPPORTED';
export interface Vec2 { x: number; y: number }
export interface GuildMark {
  id: Id;
  name: string;
  badge: string;
  color: string;
  bannerItemId: string | null;
  trailItemId: string | null;
}
export type ApiResult<T> = { data: T; requestId: Id } | { error: { code: ErrorCode; message: string; details?: Record<string, unknown> }; requestId: Id };
export type Ack<T> = (result: ApiResult<T>) => void;
export interface Appearance {
  presetId: PresetId;
  bodyColor: string;
  finColor: string;
  patternId: string;
  skinAssetId: Id | null;
  equipped: Partial<Record<'face' | 'head' | 'outfit' | 'trail' | 'charm', string>>;
  version: number;
}
export interface WalletView {
  basePower: number;
  powerBalance: number;
  heldPower: number;
  availablePower: number;
  totalPower: number;
  highestPower: number;
  version: number;
}
export interface SelfView {
  userId: Id;
  role: Role;
  fishId: Id | null;
  nickname: string;
  totalXp: number;
  level: number;
  appearance: Appearance | null;
  wallet: WalletView;
  guildId: Id | null;
  currentMatchId: Id | null;
  businessDate: string;
  daily: { xpMinted: number; powerMinted: number; feedUsed: number; formalUsed: number; formalReserved: number };
}
export type MoveIntent = { kind: 'idle' } | { kind: 'direction'; direction: Vec2 } | { kind: 'target'; target: Vec2 };
export interface ActionIntent {
  actionSeq: number;
  kind: 'dash' | 'shield';
  direction?: Vec2;
  /** 客户端时间仅用于诊断；是否过期以接收与场景会话约束判定。 */
  issuedAtClientMs: number;
}
export interface InputFrame {
  protocolVersion: 1;
  roomId: Id;
  /** 每次入场或接管控制后由服务器发放，旧值立即失效。 */
  sceneEpoch: Id;
  inputSeq: number;
  basedOnServerTick: number;
  move: MoveIntent;
  /** 仅保留尚未确认且在短时窗口内的意图，服务端按 actionSeq 去重。 */
  actions: ActionIntent[];
  pageVisible: boolean;
}
export interface FishSnapshot {
  id: Id;
  nickname: string;
  position: Vec2;
  velocity: Vec2;
  facing: 'left' | 'right';
  angle: number;
  appearance: Appearance;
  level: number;
  displaySize: number;
  guildId: Id | null;
  team: 'A' | 'B' | null;
  animation: 'idle' | 'swim' | 'dash' | 'eat' | 'hit' | 'victory' | 'defeat' | 'bubble';
  interactive: boolean;
  followGroupId: Id | null;
  followLeaderFishId?: Id | null;
  guildMark?: GuildMark | null;
  hp: number | null;
  maxHp: number | null;
  shieldUntilServerMs: number;
  respawnAtServerMs: number | null;
  /** 团战复活后的出生保护截止时间。 */
  spawnProtectionUntilServerMs?: number;
  /** 团战中已主动退出或断线超时；实体仅保留为结算可见状态。 */
  withdrawn?: boolean;
  /** 竞技断线宽限截止；仅在断线等待期间存在。 */
  disconnectDeadlineAtServerMs?: number | null;
}
export interface FoodSnapshot { id: Id; position: Vec2; state: 'AVAILABLE' | 'CLAIM_PENDING'; expiresAtServerMs: number }
export interface NpcSnapshot { id: Id; tier: 'silver' | 'agile' | 'rare'; position: Vec2; velocity: Vec2; relativeSize: number; state: 'AVAILABLE' | 'CLAIM_PENDING' }
export interface PearlSnapshot { id: Id; position: Vec2; carrierFishId: Id | null; oldCarrierFishId: Id | null; oldCarrierBlockedUntilServerMs: number }
export interface SceneSnapshot {
  protocolVersion: 1;
  snapshotKind: 'full';
  rulesVersion: string;
  roomId: Id;
  roomEpoch: Id;
  sceneEpoch: Id;
  sceneKind: SceneKind;
  serverTick: number;
  serverTimeMs: number;
  ackInputSeq: number;
  ackActionSeq: number;
  controlledFishId: Id | null;
  fish: FishSnapshot[];
  food: FoodSnapshot[];
  npc: NpcSnapshot[];
  pearl: PearlSnapshot | null;
  match: { id: Id; phase: MatchPhase; deadlineAtServerMs: number; scoreA: number; scoreB: number } | null;
  /** 本字段仅定向给当前用户，禁止向全房间广播个人冷却或私有资产。 */
  ownRuntime: { stamina: number; dashReadyAtServerMs: number; shieldReadyAtServerMs: number } | null;
}
export type SceneEventPayload =
  | { kind: 'eat'; fishId: Id; sourceId: Id; actualXp: number; actualPower: number }
  | { kind: 'dash'; fishId: Id; actionSeq: number; direction: Vec2 }
  | { kind: 'hit'; sourceFishId: Id; targetFishId: Id; damage: number; blocked: boolean }
  | { kind: 'pearl'; carrierFishId: Id | null; position: Vec2 }
  | { kind: 'respawn'; fishId: Id; position: Vec2 }
  | { kind: 'emote'; fishId: Id; emote: 'hi' | 'heart' | 'zzz' | 'challenge' };
export interface SceneEvent { eventId: Id; roomId: Id; sceneEpoch: Id; serverTick: number; serverTimeMs: number; payload: SceneEventPayload }
export interface MatchResultView {
  matchId: Id;
  mode: MatchMode;
  phase: 'FINISHED' | 'ABORTED';
  winnerTeam: 'A' | 'B' | null;
  reason: 'HP_ZERO' | 'TIME' | 'SCORE_LIMIT' | 'OVERTIME_HOLD' | 'DRAW' | 'FORFEIT' | 'DISCONNECT' | 'SYSTEM_ABORT';
  stake: number;
  scoreA: number;
  scoreB: number;
  personalDeltas: Array<{ userId: Id; deltaPower: number }>;
  guildPointDeltas: Array<{ guildId: Id; points: number }>;
  rulesVersion: string;
  committedAt: string;
}
export interface ClientToServerEvents {
  'session:hello': (p: { protocolVersion: number; clientInstanceId: Id }, ack: Ack<{ accepted: boolean }>) => void;
  'control:claim': (p: { clientInstanceId: Id }, ack: Ack<{ sceneEpoch: Id; controlledFishId: Id | null }>) => void;
  'scene:join': (p: { sceneKind: SceneKind; roomId?: Id; watchMatchId?: Id }, ack: Ack<{ roomId: Id; sceneEpoch: Id }>) => void;
  'input:frame': (p: InputFrame) => void;
  'guild:follow': (p: { enabled: boolean; leaderFishId?: Id; sceneEpoch: Id }, ack: Ack<{ enabled: boolean; leaderFishId: Id | null }>) => void;
  'emote:send': (p: { emote: 'hi' | 'heart' | 'zzz' | 'challenge'; sceneEpoch: Id }, ack: Ack<{ eventId: Id }>) => void;
}
export interface ServerToClientEvents {
  'session:welcome': (p: { protocolVersion: 1; rulesVersion: string; serverTimeMs: number; controlledFishId: Id | null; sceneEpoch: Id | null; recovered: boolean }) => void;
  'control:changed': (p: { controlled: boolean; controlledFishId: Id | null; sceneEpoch: Id | null }) => void;
  'scene:snapshot': (p: SceneSnapshot) => void;
  'scene:event': (p: SceneEvent) => void;
  'self:invalidate': (p: { eventId: Id; domains: Array<'fish' | 'wallet' | 'inventory' | 'guild' | 'match' | 'daily'> }) => void;
  'match:phase': (p: { matchId: Id; phase: MatchPhase; deadlineAtServerMs: number; quoteVersion: number | null; stake: number | null }) => void;
  'app:error': (p: { code: ErrorCode; message: string; requestId: Id }) => void;
}
