import { createApp } from './http/app';

const server=await createApp();
try { await server.start(); }
catch(error) { console.error(error); await server.close(); process.exitCode=1; }
let closing=false;
async function close(signal:string){
  if(closing)return;closing=true;
  console.log(`${signal}：停止接收新比赛，等待进行中的比赛有界排空`);
  try { await server.close(); }
  catch(error) { console.error('服务关闭失败',error);process.exitCode=1; }
}
process.once('SIGINT',()=>{void close('SIGINT');});
process.once('SIGTERM',()=>{void close('SIGTERM');});
