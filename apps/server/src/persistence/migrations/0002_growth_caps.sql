ALTER TABLE daily_counters ADD COLUMN IF NOT EXISTS limit_value integer NOT NULL DEFAULT 2147483647;
UPDATE daily_counters SET limit_value=CASE counter_key
 WHEN 'xp' THEN 300 WHEN 'power' THEN 80 WHEN 'feed' THEN 5 WHEN 'formal' THEN 5 WHEN 'supply' THEN 1 ELSE limit_value END
 WHERE owner_type='USER';
ALTER TABLE daily_counters ADD CONSTRAINT daily_cap CHECK(used+reserved<=limit_value);
CREATE TABLE food_batches (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), room_id text NOT NULL,
 pellets_json jsonb NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX food_batches_expiry ON food_batches(expires_at);
