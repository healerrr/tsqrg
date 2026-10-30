ALTER TABLE fish ADD COLUMN last_tank_room_id text
  CHECK(last_tank_room_id IS NULL OR last_tank_room_id ~ '^tank:[1-9][0-9]{0,8}$');
