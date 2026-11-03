import type {NativeRequestOptions} from './real-access';
export const NET_CREDIT_RESPONSE_BYTES=262144;
export function captureNetCreditRequest(path:string,input:NativeRequestOptions={}){
 const fail=():never=>{throw new Error('ITAU_NET_CREDIT_REQUEST_INVALID');};
 const own=(v:unknown,keys:string[])=>{
  if(!v||typeof v!=='object'||Array.isArray(v)||![Object.prototype,null].includes(Object.getPrototypeOf(v)))return fail();
  const d=Object.getOwnPropertyDescriptors(v);
  if(Reflect.ownKeys(d).some(k=>typeof k!=='string'||!keys.includes(k)||!Object.hasOwn(d[k],'value')||!d[k].enumerable))return fail();
  return Object.fromEntries(Object.entries(d).map(([k,p])=>[k,p.value])) as Record<string,unknown>;
 };
 const value=own(input,['method','body','signal']),method=value.method??'GET',signal=value.signal;
 if(signal!==undefined&&!(signal instanceof AbortSignal))return fail();
 const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
 const version=(v:unknown)=>typeof v==='number'&&Number.isInteger(v)&&v>0&&v<=2147483647;
 const event=/^\/v1\/retornos-itau109\/events\/([a-f0-9-]+)\/(preview|settle)$/.exec(path);
 const command=/^\/v1\/retornos-itau109\/commands\/([a-f0-9-]+)$/.exec(path);
 let body:Record<string,unknown>|undefined;
 if(event&&uuid(event[1])){
  if(method!=='POST')return fail();
  const keys=['file_id','line','fee_category_id','expected_fee_category_version',...(event[2]==='settle'?['command_id','expected_approval_version','context_hash','confirm']:[])];
  body=own(value.body,keys);
  if(Object.keys(body).length!==keys.length||!uuid(body.file_id)||!uuid(body.fee_category_id)||!version(body.expected_fee_category_version)||!version(body.line)||(body.line as number)<2||(body.line as number)>9999)return fail();
  if(event[2]==='settle'&&(!uuid(body.command_id)||!version(body.expected_approval_version)||typeof body.context_hash!=='string'||!/^[a-f0-9]{64}$/.test(body.context_hash)||body.confirm!==true))return fail();
  Object.freeze(body);
 }else if(!command||!uuid(command[1])||method!=='GET'||value.body!==undefined)return fail();
 return Object.freeze({path,options:Object.freeze({method:method as 'GET'|'POST',...(body?{body}:{}),...(signal?{signal:signal as AbortSignal}:{})})});
}
