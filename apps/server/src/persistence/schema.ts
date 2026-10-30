import { integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { Appearance } from '@aquarium/protocol';

/** Typed ORM mappings; checked SQL migrations remain the schema authority. */
export const users = pgTable('users', {
  id: uuid('id').primaryKey(), role: text('role').notNull().default('GUEST'),
  employeeRef: text('employee_ref').unique(), guildRejoinAt: timestamp('guild_rejoin_at',{withTimezone:true}),
  createdAt: timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
});
export const fish = pgTable('fish', {
  id: uuid('id').primaryKey(), userId: uuid('user_id').notNull().unique().references(()=>users.id),
  nickname: text('nickname').notNull(), presetId: text('preset_id').notNull(),
  totalXp: integer('total_xp').notNull().default(0), appearance: jsonb('appearance_json').$type<Appearance>().notNull(),
  appearanceVersion: integer('appearance_version').notNull().default(1), highestPower: integer('highest_power').notNull(),
  lastTankRoomId: text('last_tank_room_id'),
});
export const wallets = pgTable('wallets', {
  id: text('id').primaryKey(), ownerKind: text('owner_kind').notNull(),
  ownerUserId: uuid('owner_user_id').unique().references(()=>users.id), ownerGuildId: uuid('owner_guild_id').unique(),
  systemKey: text('system_key').unique(), balance: integer('balance').notNull().default(0),
  held: integer('held').notNull().default(0), version: integer('version').notNull().default(1),
});
