CREATE TABLE IF NOT EXISTS users (
 id uuid PRIMARY KEY, role text NOT NULL DEFAULT 'GUEST' CHECK(role IN ('GUEST','MEMBER','ADMIN')),
 employee_ref text UNIQUE, guild_rejoin_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
 expires_at timestamptz NOT NULL, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS employee_invites (
 id uuid PRIMARY KEY, code_hash text NOT NULL UNIQUE, employee_ref text NOT NULL,
 expires_at timestamptz NOT NULL, used_by uuid REFERENCES users(id), used_at timestamptz
);
CREATE TABLE IF NOT EXISTS fish (
 id uuid PRIMARY KEY, user_id uuid NOT NULL UNIQUE REFERENCES users(id), nickname text NOT NULL,
 preset_id text NOT NULL, total_xp integer NOT NULL DEFAULT 0 CHECK(total_xp>=0),
 appearance_json jsonb NOT NULL, appearance_version integer NOT NULL DEFAULT 1,
 highest_power integer NOT NULL DEFAULT 100 CHECK(highest_power>=0), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS guilds (
 id uuid PRIMARY KEY, name text NOT NULL UNIQUE, leader_user_id uuid NOT NULL REFERENCES users(id),
 badge text NOT NULL, color text NOT NULL, notice text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'ACTIVE', version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS guild_members (
 user_id uuid PRIMARY KEY REFERENCES users(id), guild_id uuid NOT NULL REFERENCES guilds(id),
 role text NOT NULL CHECK(role IN ('LEADER','ADMIN','MEMBER')), joined_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS guild_members_guild ON guild_members(guild_id);
CREATE TABLE IF NOT EXISTS guild_applications (
 guild_id uuid NOT NULL REFERENCES guilds(id), user_id uuid NOT NULL REFERENCES users(id),
 status text NOT NULL DEFAULT 'PENDING', created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(guild_id,user_id)
);
CREATE TABLE IF NOT EXISTS wallets (
 id text PRIMARY KEY, owner_kind text NOT NULL CHECK(owner_kind IN ('PERSONAL','GUILD','SYSTEM')),
 owner_user_id uuid UNIQUE REFERENCES users(id), owner_guild_id uuid UNIQUE REFERENCES guilds(id), system_key text UNIQUE,
 balance integer NOT NULL DEFAULT 0, held integer NOT NULL DEFAULT 0, version integer NOT NULL DEFAULT 1,
 CHECK((owner_kind='PERSONAL' AND owner_user_id IS NOT NULL AND owner_guild_id IS NULL AND system_key IS NULL) OR
       (owner_kind='GUILD' AND owner_guild_id IS NOT NULL AND owner_user_id IS NULL AND system_key IS NULL) OR
       (owner_kind='SYSTEM' AND system_key IS NOT NULL AND owner_user_id IS NULL AND owner_guild_id IS NULL)),
 CHECK(held>=0 AND (owner_kind='SYSTEM' OR balance>=held)), CHECK(owner_kind='PERSONAL' OR held=0)
);
CREATE TABLE IF NOT EXISTS ledger_transactions (
 id uuid PRIMARY KEY, kind text NOT NULL, source_key text NOT NULL UNIQUE,
 actor_user_id uuid REFERENCES users(id), rules_version text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ledger_entries (
 id bigserial PRIMARY KEY, transaction_id uuid NOT NULL REFERENCES ledger_transactions(id),
 wallet_id text NOT NULL REFERENCES wallets(id), amount integer NOT NULL, balance_after integer NOT NULL
);
CREATE OR REPLACE FUNCTION check_ledger_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (SELECT COALESCE(sum(amount),0) FROM ledger_entries WHERE transaction_id=NEW.transaction_id) <> 0 THEN
   RAISE EXCEPTION 'ledger transaction is not balanced';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS ledger_balanced ON ledger_entries;
CREATE CONSTRAINT TRIGGER ledger_balanced AFTER INSERT OR UPDATE ON ledger_entries
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ledger_balanced();
CREATE TABLE IF NOT EXISTS daily_counters (
 owner_type text NOT NULL DEFAULT 'USER', owner_id text NOT NULL, business_date date NOT NULL,
 counter_key text NOT NULL, used integer NOT NULL DEFAULT 0 CHECK(used>=0),
 reserved integer NOT NULL DEFAULT 0 CHECK(reserved>=0), PRIMARY KEY(owner_type,owner_id,business_date,counter_key)
);
CREATE TABLE IF NOT EXISTS reward_events (
 id uuid PRIMARY KEY, source_kind text NOT NULL, source_id text NOT NULL UNIQUE,
 fish_id uuid NOT NULL REFERENCES fish(id), xp_delta integer NOT NULL CHECK(xp_delta>=0),
 power_delta integer NOT NULL CHECK(power_delta>=0), business_date date NOT NULL,
 rules_version text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS shop_items (
 id text PRIMARY KEY, name text NOT NULL, scope text NOT NULL, slot text NOT NULL,
 price integer NOT NULL CHECK(price>=0), enabled boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS inventory (
 user_id uuid NOT NULL REFERENCES users(id), item_id text NOT NULL REFERENCES shop_items(id),
 acquired_at timestamptz NOT NULL DEFAULT now(), source_tx_id uuid NOT NULL REFERENCES ledger_transactions(id),
 PRIMARY KEY(user_id,item_id)
);
CREATE TABLE IF NOT EXISTS guild_assets (
 guild_id uuid NOT NULL REFERENCES guilds(id), item_id text NOT NULL REFERENCES shop_items(id),
 source_tx_id uuid NOT NULL REFERENCES ledger_transactions(id), PRIMARY KEY(guild_id,item_id)
);
CREATE TABLE IF NOT EXISTS uploads (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), storage_key text NOT NULL UNIQUE,
 mime text NOT NULL, width integer NOT NULL, height integer NOT NULL,
 status text NOT NULL DEFAULT 'ACTIVE', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS matches (
 id uuid PRIMARY KEY, mode text NOT NULL, status text NOT NULL, rules_version text NOT NULL,
 stake integer NOT NULL DEFAULT 0 CHECK(stake>=0), owner_epoch uuid NOT NULL,
 business_date date, season_id text, guild_a uuid REFERENCES guilds(id), guild_b uuid REFERENCES guilds(id),
 quote_version integer NOT NULL DEFAULT 1, version integer NOT NULL DEFAULT 1,
 deadline_at timestamptz, started_at timestamptz, ended_at timestamptz,
 payload jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS match_participants (
 match_id uuid NOT NULL REFERENCES matches(id), user_id uuid NOT NULL REFERENCES users(id),
 fish_id uuid NOT NULL REFERENCES fish(id), team text NOT NULL CHECK(team IN ('A','B')),
 ready boolean NOT NULL DEFAULT false, locked_snapshot jsonb, disconnect_at timestamptz,
 PRIMARY KEY(match_id,user_id)
);
CREATE INDEX IF NOT EXISTS match_participants_user ON match_participants(user_id);
CREATE TABLE IF NOT EXISTS wallet_holds (
 id uuid PRIMARY KEY, match_id uuid NOT NULL REFERENCES matches(id), wallet_id text NOT NULL REFERENCES wallets(id),
 amount integer NOT NULL CHECK(amount>=0), status text NOT NULL DEFAULT 'HELD',
 UNIQUE(match_id,wallet_id)
);
CREATE TABLE IF NOT EXISTS match_results (
 match_id uuid PRIMARY KEY REFERENCES matches(id), winner_team text,
 reason text NOT NULL, final_score jsonb NOT NULL, settlement_tx_id uuid REFERENCES ledger_transactions(id),
 result_json jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS guild_season_stats (
 guild_id uuid NOT NULL REFERENCES guilds(id), season_id text NOT NULL,
 points integer NOT NULL DEFAULT 0, wins integer NOT NULL DEFAULT 0,
 draws integer NOT NULL DEFAULT 0, losses integer NOT NULL DEFAULT 0,
 PRIMARY KEY(guild_id,season_id)
);
CREATE TABLE IF NOT EXISTS idempotency_keys (
 user_id uuid NOT NULL REFERENCES users(id), route_scope text NOT NULL, key uuid NOT NULL,
 payload_hash text NOT NULL, response_json jsonb NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days',
 PRIMARY KEY(user_id,route_scope,key)
);
CREATE TABLE IF NOT EXISTS outbox_events (
 id uuid PRIMARY KEY, event_type text NOT NULL, aggregate_id text NOT NULL, payload jsonb NOT NULL,
 published_at timestamptz, attempts integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_logs (
 id uuid PRIMARY KEY, actor_user_id uuid REFERENCES users(id), action text NOT NULL,
 target_type text NOT NULL, target_id text NOT NULL, before_json jsonb, after_json jsonb,
 reason text, created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO wallets(id,owner_kind,system_key) VALUES ('system:MINT','SYSTEM','MINT'),('system:SINK','SYSTEM','SINK') ON CONFLICT DO NOTHING;
