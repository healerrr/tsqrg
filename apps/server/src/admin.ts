/** Local operator CLI; never exposes a public bootstrap password. */
import { db, pool } from './persistence/db';
import { users } from './persistence/schema';
import { eq } from 'drizzle-orm';
import { createInvite } from './services/identity';

const [command,argument]=process.argv.slice(2);
try {
  if(command==='invite' && argument)console.log(JSON.stringify(await createInvite(argument)));
  else if(command==='promote' && argument){
    const changed=await db.update(users).set({role:'ADMIN'}).where(eq(users.id,argument)).returning({id:users.id});
    if(!changed.length)throw new Error('账号不存在');console.log('已设置管理员：'+argument);
  }else throw new Error('用法：tsx src/admin.ts invite <同事标识> 或 promote <已有用户UUID>');
}finally{await pool.end();}
