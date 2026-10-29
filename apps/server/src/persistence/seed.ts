import { config } from '@aquarium/core';
import { pool, tx } from './db';

export async function seed() {
  await tx(async client => {
    for (const item of config.catalog) await client.query(
      'INSERT INTO shop_items(id,name,scope,slot,price) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING',
      [item.id, item.name, item.scope, item.slot, item.price],
    );
  });
  console.log('种子完成：商品目录；未生成公开管理员或默认邀请码');
}
if (process.argv[1]?.replaceAll('\\', '/').endsWith('/seed.ts')) {
  seed().then(() => pool.end()).catch(error => { console.error(error); process.exitCode = 1; void pool.end(); });
}
