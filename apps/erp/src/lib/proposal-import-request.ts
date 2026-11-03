import type {NativeRequestOptions} from './real-access';

/** Capture the policy, primitive body and signal before token refresh can await. */
export function captureProposalImportRequest(path:string,input:NativeRequestOptions={}){
 const fail=():never=>{throw new Error('PROPOSAL_IMPORT_REQUEST_INVALID');};
 const fields=(value:unknown,allowed:string[])=>{
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return fail();
  const descriptors=Object.getOwnPropertyDescriptors(value);
  if(Reflect.ownKeys(value).some(key=>typeof key!=='string'||!allowed.includes(key))||Object.values(descriptors).some(d=>!Object.hasOwn(d,'value')))return fail();
  return Object.fromEntries(Object.entries(descriptors).map(([key,d])=>[key,d.value])) as Record<string,unknown>;
 };
 if(typeof path!=='string')return fail();
 const values=fields(input,['method','body','signal']),method=values.method??'GET',signal=values.signal;
 if(signal!==undefined&&!(signal instanceof AbortSignal))return fail();
 const legacy='/v1/importacao-orcamentos-origin',v2=legacy+'-v2';
 const base=path===v2||path.startsWith(v2+'/')||path.startsWith(v2+'?')?v2:legacy;
 const write=path===base+'/preview'||path===base+'/apply',list=path===base||path.startsWith(base+'?');
 const documentOrigin=/^\/v1\/importacao-orcamentos-origin\/documents\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/origin$/.test(path);
 const read=/^\/v1\/importacao-orcamentos-origin(?:-v2)?\/(?:commands\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|origins\/[1-9][0-9]{0,39})$/.test(path);
 if(write?method!=='POST'||values.body===undefined:!(list||read||documentOrigin)||method!=='GET'||values.body!==undefined)return fail();
 if(list){
  if(path.includes('#'))return fail();const query=new URLSearchParams(path.includes('?')?path.slice(path.indexOf('?')+1):'');
  for(const key of query.keys()){
   const value=query.get(key)!;
   if(!['limit','after','q'].includes(key)||query.getAll(key).length!==1||key==='limit'&&(!/^[1-9][0-9]?$/.test(value)||Number(value)>25)||key==='after'&&!/^[1-9][0-9]{0,39}$/.test(value)||key==='q'&&(Array.from(value).length>100||/[\x00-\x1f\x7f]/.test(value)))return fail();
  }
 }
 let body:Record<string,unknown>|undefined;
 if(write){
  const keys=path.endsWith('/preview')?['source_id']:['source_id','preview_hash','command_id','confirm_import','duplicate_reviewed'];
  body=fields(values.body,keys);
  if(Object.keys(body).length!==keys.length||typeof body.source_id!=='string'||!/^[1-9][0-9]{0,39}$/.test(body.source_id))return fail();
  if(keys.length>1&&(typeof body.command_id!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(body.command_id)||typeof body.preview_hash!=='string'||!/^[a-f0-9]{64}$/.test(body.preview_hash)||body.confirm_import!==true||body.duplicate_reviewed!==true))return fail();
  Object.freeze(body);
 }
 return Object.freeze({base,path,options:Object.freeze({method:method as 'GET'|'POST',...(body?{body}:{}),...(signal?{signal:signal as AbortSignal}:{})})});
}
