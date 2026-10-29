import { z } from 'zod';

export const idSchema = z.string().min(1).max(100);
export const uuidSchema = z.string().uuid();
export const safeIntSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const vec2Schema = z.object({ x: z.number().finite().min(-10000).max(10000), y: z.number().finite().min(-10000).max(10000) }).strict();
export const presetSchema = z.enum(['goldfish', 'clownfish', 'puffer', 'betta', 'angelfish', 'ray']);
export const colorSchema = z.string().regex(/^#[\da-fA-F]{6}$/, '请选择有效的十六进制颜色');
export const slotSchema = z.enum(['face', 'head', 'outfit', 'trail', 'charm']);
export const appearanceSchema = z.object({
  presetId: presetSchema,
  bodyColor: colorSchema,
  finColor: colorSchema,
  patternId: z.enum(['none', 'stripes', 'spots', 'belly']),
  skinAssetId: idSchema.nullable(),
  equipped: z.object({ face: idSchema.optional(), head: idSchema.optional(), outfit: idSchema.optional(), trail: idSchema.optional(), charm: idSchema.optional() }).strict(),
  version: safeIntSchema,
}).strict();
export const nicknameSchema = z.string().trim().min(2, '昵称至少 2 个字').max(12, '昵称最多 12 个字').refine(v => [...v].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127), '昵称不可含控制字符');
export const guildNameSchema = z.string().trim().refine(v => [...v].length >= 2, '鱼群名称至少 2 个可见字符').refine(v => [...v].length <= 12, '鱼群名称最多 12 个可见字符').refine(v => [...v].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127), '鱼群名称不可含控制字符');
export const createFishSchema = z.object({ nickname: nicknameSchema, presetId: presetSchema.optional(), appearance: appearanceSchema }).strict();
export const updateFishSchema = z.object({ nickname: nicknameSchema.optional(), appearance: appearanceSchema.optional(), version: safeIntSchema.optional(), appearanceVersion: safeIntSchema.optional() }).strict();
export const moveIntentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('idle') }).strict(),
  z.object({ kind: z.literal('direction'), direction: vec2Schema }).strict(),
  z.object({ kind: z.literal('target'), target: vec2Schema }).strict(),
]);
export const actionIntentSchema = z.object({ actionSeq: safeIntSchema, kind: z.enum(['dash', 'shield']), direction: vec2Schema.optional(), issuedAtClientMs: z.number().finite().nonnegative() }).strict();
export const inputFrameSchema = z.object({
  protocolVersion: z.literal(1), roomId: idSchema, sceneEpoch: idSchema,
  inputSeq: safeIntSchema, basedOnServerTick: safeIntSchema, move: moveIntentSchema,
  actions: z.array(actionIntentSchema).max(4), pageVisible: z.boolean(),
}).strict();
export const helloSchema = z.object({ protocolVersion: z.number().int(), clientInstanceId: idSchema }).strict();
export const claimControlSchema = z.object({ clientInstanceId: idSchema }).strict();
export const joinSceneSchema = z.object({ sceneKind: z.enum(['TANK', 'DUEL', 'TEAM']), roomId: idSchema.optional(), watchMatchId: idSchema.optional() }).strict();
export const followSchema = z.object({ enabled: z.boolean(), leaderFishId: idSchema.optional(), sceneEpoch: idSchema }).strict();
export const emoteSchema = z.object({ emote: z.enum(['hi', 'heart', 'zzz', 'challenge']), sceneEpoch: idSchema }).strict();
export const claimInviteSchema = z.object({ inviteCode: z.string().trim().min(6).max(128) }).strict();
export const feedSchema = z.object({ roomId: idSchema, surfaceX: z.number().finite().min(64).max(1856), sceneEpoch: idSchema }).strict();
export const purchaseSchema = z.object({ itemId: idSchema, itemVersion: safeIntSchema }).strict();
export const equipSchema = z.object({ slot: slotSchema, itemId: idSchema.nullable(), version: safeIntSchema.optional() }).strict();
export const guildCreateSchema = z.object({ name: guildNameSchema, badge: z.string().trim().min(1).max(12).default('波浪'), color: colorSchema.default('#21BDE7'), notice: z.string().trim().max(40).default('') }).strict();
export const guildUpdateSchema = z.object({ name: guildNameSchema.optional(), badge: z.string().trim().min(1).max(12).optional(), color: colorSchema.optional(), notice: z.string().trim().max(40).optional(), version: safeIntSchema }).strict();
export const guildDonationSchema = z.object({ amount: safeIntSchema.min(1) }).strict();
export const guildTransferSchema = z.object({ targetUserId: idSchema, version: safeIntSchema }).strict();
export const guildApplicationSchema = z.object({ version: safeIntSchema.optional() }).strict();
export const guildInviteSchema = z.object({ targetUserId: uuidSchema, version: safeIntSchema }).strict();
export const guildRoleSchema = z.object({ role: z.enum(['ADMIN', 'MEMBER']), version: safeIntSchema }).strict();
export const guildRemoveSchema = z.object({ version: safeIntSchema }).strict();
export const guildDissolveSchema = z.object({ version: safeIntSchema, confirm: z.literal(true) }).strict();
export const matchModeSchema = z.enum(['DUEL_FRIENDLY', 'DUEL_FORMAL', 'TEAM_FRIENDLY', 'TEAM_FORMAL']);
export const invitationSchema = z.object({ mode: matchModeSchema, targetUserId: idSchema.optional(), targetGuildId: idSchema.optional(), roster: z.array(idSchema).max(3).optional() }).strict();
export const acceptMatchSchema = z.object({ roster: z.array(idSchema).max(3).optional(), version: safeIntSchema.optional() }).strict();
export const readyMatchSchema = z.object({ quoteVersion: safeIntSchema, stake: safeIntSchema }).strict();
export const paginationSchema = z.object({ cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(20) });
export const adminInviteSchema = z.object({ employeeRef: z.string().trim().min(1).max(100), expiresAt: z.string().datetime().optional() }).strict();

export const walletViewSchema = z.object({
  basePower: safeIntSchema, powerBalance: safeIntSchema, heldPower: safeIntSchema,
  availablePower: safeIntSchema, totalPower: safeIntSchema, highestPower: safeIntSchema,
  version: safeIntSchema,
}).strict().refine(w => w.powerBalance >= w.heldPower && w.availablePower === w.powerBalance - w.heldPower && w.totalPower === w.basePower + w.powerBalance && w.highestPower >= w.totalPower, '钱包额度不一致');
export const selfViewSchema = z.object({
  userId: idSchema, role: z.enum(['GUEST', 'MEMBER', 'ADMIN']), fishId: idSchema.nullable(),
  nickname: z.string().max(12), totalXp: safeIntSchema, level: safeIntSchema.min(1).max(30),
  appearance: appearanceSchema.nullable(), wallet: walletViewSchema,
  guildId: idSchema.nullable(), currentMatchId: idSchema.nullable(),
  businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  daily: z.object({ xpMinted: safeIntSchema, powerMinted: safeIntSchema, feedUsed: safeIntSchema, formalUsed: safeIntSchema, formalReserved: safeIntSchema }).strict(),
}).strict();
export const matchPhaseSchema = z.enum(['INVITED', 'READY_CHECK', 'COUNTDOWN', 'RUNNING', 'OVERTIME', 'SETTLING', 'FINISHED', 'ABORTED']);
export const fishSnapshotSchema = z.object({
  id: idSchema, nickname: z.string().max(12), position: vec2Schema, velocity: vec2Schema,
  facing: z.enum(['left', 'right']), angle: z.number().finite(), appearance: appearanceSchema,
  level: safeIntSchema.min(1).max(30), displaySize: z.number().finite().positive().max(10),
  guildId: idSchema.nullable(), team: z.enum(['A', 'B']).nullable(),
  animation: z.enum(['idle', 'swim', 'dash', 'eat', 'hit', 'victory', 'defeat', 'bubble']),
  interactive: z.boolean(), followGroupId: idSchema.nullable(), hp: safeIntSchema.nullable(),
  followLeaderFishId: idSchema.nullable().optional(),
  guildMark: z.object({ id: idSchema, name: guildNameSchema, badge: z.string().max(12), color: colorSchema, bannerItemId: idSchema.nullable(), trailItemId: idSchema.nullable() }).strict().nullable().optional(),
  maxHp: safeIntSchema.nullable(), shieldUntilServerMs: safeIntSchema, respawnAtServerMs: safeIntSchema.nullable(),
  disconnectDeadlineAtServerMs: safeIntSchema.nullable().optional(),
}).strict();
export const sceneSnapshotSchema = z.object({
  protocolVersion: z.literal(1), snapshotKind: z.literal('full'), rulesVersion: z.string().min(1).max(32),
  roomId: idSchema, roomEpoch: idSchema, sceneEpoch: idSchema,
  sceneKind: z.enum(['TANK', 'DUEL', 'TEAM']), serverTick: safeIntSchema, serverTimeMs: safeIntSchema,
  ackInputSeq: safeIntSchema, ackActionSeq: safeIntSchema, controlledFishId: idSchema.nullable(),
  fish: z.array(fishSnapshotSchema).max(64),
  food: z.array(z.object({ id: idSchema, position: vec2Schema, state: z.enum(['AVAILABLE', 'CLAIM_PENDING']), expiresAtServerMs: safeIntSchema }).strict()).max(100),
  npc: z.array(z.object({ id: idSchema, tier: z.enum(['silver', 'agile', 'rare']), position: vec2Schema, velocity: vec2Schema, relativeSize: z.number().finite().positive(), state: z.enum(['AVAILABLE', 'CLAIM_PENDING']) }).strict()).max(100),
  pearl: z.object({ id: idSchema, position: vec2Schema, carrierFishId: idSchema.nullable(), oldCarrierFishId: idSchema.nullable(), oldCarrierBlockedUntilServerMs: safeIntSchema }).strict().nullable(),
  match: z.object({ id: idSchema, phase: matchPhaseSchema, deadlineAtServerMs: safeIntSchema, scoreA: safeIntSchema, scoreB: safeIntSchema }).strict().nullable(),
  ownRuntime: z.object({ stamina: z.number().finite().nonnegative(), dashReadyAtServerMs: safeIntSchema, shieldReadyAtServerMs: safeIntSchema }).strict().nullable(),
}).strict();

// Named aliases keep boundary validation uniform in HTTP and Socket.IO handlers.
export const InputFrameSchema = inputFrameSchema;
export const AppearanceSchema = appearanceSchema;
export const MoveIntentSchema = moveIntentSchema;
export const PresetIdSchema = presetSchema;
export const SceneSnapshotSchema = sceneSnapshotSchema;
export const SelfViewSchema = selfViewSchema;
