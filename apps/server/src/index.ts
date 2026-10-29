import { createApp } from './http/app';

const server=await createApp();
try { await server.start(); }
catch(error) { console.error(error); await server.close(); process.exitCode=1; }
let closing=false;
async function close(){if(closing)return;closing=true;await server.close();}
process.once('SIGINT',()=>{void close();});
process.once('SIGTERM',()=>{void close();});
