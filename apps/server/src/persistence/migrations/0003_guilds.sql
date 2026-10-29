ALTER TABLE guilds
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

ALTER TABLE guild_applications
  ADD COLUMN IF NOT EXISTS invited_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE guild_applications
  ADD CONSTRAINT guild_applications_status_check
  CHECK(status IN ('PENDING','INVITED','ACCEPTED','REJECTED','CANCELLED'));

ALTER TABLE guilds
  ADD CONSTRAINT guilds_status_check
  CHECK(status IN ('ACTIVE','ARCHIVED'));

CREATE INDEX IF NOT EXISTS guild_applications_user_status
  ON guild_applications(user_id,status);

CREATE OR REPLACE FUNCTION enforce_guild_member_limit_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM guilds WHERE id=NEW.guild_id AND status='ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'guild is not active';
  END IF;
  IF (SELECT count(*) FROM guild_members WHERE guild_id=NEW.guild_id) >= 8 THEN
    RAISE EXCEPTION 'guild member limit reached';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS guild_member_limit_v1 ON guild_members;
CREATE TRIGGER guild_member_limit_v1
  BEFORE INSERT ON guild_members
  FOR EACH ROW EXECUTE FUNCTION enforce_guild_member_limit_v1();
