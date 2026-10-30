export class ApiError extends Error {
  constructor(public code:string,message:string,public requestId?:string,public status?:number){super(message);}
}
export async function api<T>(path:string,options:RequestInit={}):Promise<T>{
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),20000);
  const signal=options.signal?AbortSignal.any([controller.signal,options.signal]):controller.signal;
  const headers=new Headers(options.headers);
  if(!(options.body instanceof FormData)&&!headers.has('Content-Type'))headers.set('Content-Type','application/json');
  try{
    let response:Response;
    try{response=await fetch(`/api/v1${path}`,{credentials:'same-origin',...options,signal,headers});}
    catch{throw new ApiError('NETWORK_ERROR',controller.signal.aborted?'服务器响应超时，可安全重试':'网络连接失败，请检查连接后重试');}
    let result;
    try{result=await response.json();}
    catch{throw new ApiError(controller.signal.aborted?'NETWORK_ERROR':'SERVER_UNAVAILABLE',controller.signal.aborted?'服务器响应超时，可安全重试':'未收到完整操作结果，请重试确认',undefined,response.status);}
    if(!result||typeof result!=='object')throw new ApiError('SERVER_UNAVAILABLE','未收到完整操作结果，请重试确认',undefined,response.status);
    if(!response.ok||result.error)throw new ApiError(result.error?.code??'SERVER_ERROR',result.error?.message??'操作失败，请重试',result.requestId,response.status);
    if(!('data'in result))throw new ApiError('SERVER_UNAVAILABLE','未收到完整操作结果，请重试确认',result.requestId,response.status);
    return result.data as T;
  }finally{clearTimeout(timeout);}
}

interface PendingCommand { key:string;running:Promise<unknown>|null }
// Persist only request digests/nonces, never wallet values, payloads or credentials.
const pendingCommands=new Map<string,PendingCommand>();
const pendingStorageKey='tank.pending-commands.v1';
try{
  const saved=JSON.parse(sessionStorage.getItem(pendingStorageKey)??'[]');
  if(Array.isArray(saved))for(const entry of saved){
    if(Array.isArray(entry)&&typeof entry[0]==='string'&&typeof entry[1]==='string'&&/:[a-f0-9]{64}$/.test(entry[0])&&/^[a-f0-9-]{36}$/i.test(entry[1]))pendingCommands.set(entry[0],{key:entry[1],running:null});
  }
}catch{/* Storage can be disabled; in-memory retries remain safe. */}
function savePendingCommands(){try{sessionStorage.setItem(pendingStorageKey,JSON.stringify([...pendingCommands].map(([identity,entry])=>[identity,entry.key])));}catch{/* Do not block gameplay on browser storage quotas. */}}
function forgetCommand(identity:string){pendingCommands.delete(identity);savePendingCommands();}
function stableJson(value:unknown):string{
  if(Array.isArray(value))return `[${value.map(stableJson).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stableJson((value as Record<string,unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value)??'null';
}
async function digest(value:BufferSource){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',value))].map(byte=>byte.toString(16).padStart(2,'0')).join('');}
async function payloadIdentity(body:string|FormData):Promise<string>{
  if(typeof body==='string')return digest(new TextEncoder().encode(stableJson(JSON.parse(body))));
  const parts=[];
  for(const [name,value]of body.entries())parts.push([name,typeof value==='string'?value:{name:value.name,type:value.type,content:await digest(await value.arrayBuffer())}]);
  return digest(new TextEncoder().encode(JSON.stringify(parts)));
}
function uncertain(error:unknown):error is ApiError{return error instanceof ApiError&&(['NETWORK_ERROR','SERVER_UNAVAILABLE'].includes(error.code)||(error.status??0)>=500);}
export async function command<T>(path:string,payload:unknown={},method='POST',suppliedKey?:string):Promise<T>{
  const body=payload instanceof FormData?payload:JSON.stringify(payload);
  const identity=`${method}:${path}:${suppliedKey??''}:${await payloadIdentity(body)}`;
  let pending=pendingCommands.get(identity);
  if(!pending){pending={key:suppliedKey??crypto.randomUUID(),running:null};pendingCommands.set(identity,pending);savePendingCommands();}
  if(pending.running)return pending.running as Promise<T>;
  const retained=pending,options={method,headers:{'Idempotency-Key':pending.key},body};
  pending.running=(async()=>{
    try{
      let result:T;
      try{result=await api<T>(path,options);}catch(error){if(!uncertain(error))throw error;result=await api<T>(path,options);}
      forgetCommand(identity);return result;
    }catch(error){if(!uncertain(error))forgetCommand(identity);throw error;}
    finally{retained.running=null;}
  })();
  return pending.running as Promise<T>;
}
