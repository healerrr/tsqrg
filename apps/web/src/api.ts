export class ApiError extends Error {
  constructor(public code:string,message:string,public requestId?:string){super(message);}
}
export async function api<T>(path:string,options:RequestInit={}):Promise<T>{
  let response:Response;
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),20000);
  try{response=await fetch(`/api/v1${path}`,{credentials:'same-origin',...options,signal:options.signal??controller.signal,headers:{...(options.body instanceof FormData?{}:{'Content-Type':'application/json'}),...options.headers}});}catch{throw new ApiError('NETWORK_ERROR',controller.signal.aborted?'服务器响应超时，可安全重试':'网络连接失败，请检查连接后重试');}finally{clearTimeout(timeout);}
  let result;
  try{result=await response.json();}catch{throw new ApiError('SERVER_UNAVAILABLE','服务暂时不可用，请稍后重试');}
  if(!response.ok||result.error)throw new ApiError(result.error?.code??'SERVER_ERROR',result.error?.message??'操作失败，请重试',result.requestId);
  return result.data as T;
}
export async function command<T>(path:string,payload:unknown={},method='POST',key=crypto.randomUUID()):Promise<T>{
  const options={method,headers:{'Idempotency-Key':key},body:payload instanceof FormData?payload:JSON.stringify(payload)};
  try{return await api<T>(path,options);}catch(e){
    // A lost response must retry the same durable command, never generate a second business action.
    if(e instanceof ApiError&&e.code==='NETWORK_ERROR')return api<T>(path,options);
    throw e;
  }
}
