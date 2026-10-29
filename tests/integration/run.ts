import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
const required=['m2.ts','m3.ts','m4.ts','m5.ts','m6.ts','m7.ts','m8.ts'];
const only=process.argv.slice(2);
const files=only.length?only:required;
for(const file of files){if(!/^m[2-8]\.ts$/.test(file))throw new Error('仅接受明确的M2至M8集成脚本');await access(resolve('tests/integration',file));}
for(const file of files){
  console.log(`正在执行真实数据库集成：${file}`);
  const result=await new Promise<number|null>((done,reject)=>{
    const child=spawn(process.execPath,['--import','tsx',resolve('tests/integration',file)],{stdio:'inherit',env:process.env});
    child.once('error',reject);child.once('exit',done);
  });
  if(result!==0)throw new Error(`${file} 失败，停止后续检查（exit ${result}）`);
}
console.log(`实际通过 ${files.length} 个阶段集成脚本。`);
