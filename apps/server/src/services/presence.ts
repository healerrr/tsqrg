import { pool } from '../persistence/db';

export async function fishOwners(): Promise<string[]> {
  const result = await pool.query('SELECT user_id FROM fish ORDER BY created_at,id');
  return result.rows.map(row => row.user_id as string);
}

/** Server-assigned room preference only; never accepts a client-supplied room. */
export async function loadTankLocation(userId: string): Promise<string | null> {
  const result = await pool.query('SELECT last_tank_room_id FROM fish WHERE user_id=$1', [userId]);
  return result.rows[0]?.last_tank_room_id ?? null;
}

export async function saveTankLocations(locations: ReadonlyArray<readonly [string, string]>): Promise<void> {
  if (!locations.length) return;
  await pool.query(`UPDATE fish f SET last_tank_room_id=location.room_id
    FROM unnest($1::uuid[],$2::text[]) AS location(user_id,room_id)
    WHERE f.user_id=location.user_id AND f.last_tank_room_id IS DISTINCT FROM location.room_id`,
  [locations.map(([userId]) => userId), locations.map(([, roomId]) => roomId)]);
}
