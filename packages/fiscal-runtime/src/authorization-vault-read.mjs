import { isConfiguredBackendOrigin } from '../../backend-config/src/origin.mjs';
/** Fixed, private GET only. No writes, metadata lookup, grant or network default. */
import {data,hash,need,scope,cancel,AuthorizationServiceError} from '../../fiscal-authorization/src/service-common.mjs';
export function createAuthorizationVaultReader(configuration){
 const p=data(configuration,['projectUrl','serviceKey','fetchImpl'],['supabaseDeployment']);
 need(isConfiguredBackendOrigin(p.projectUrl,p.supabaseDeployment)&&typeof p.serviceKey==='string'&&p.serviceKey.length>=20&&p.serviceKey.length<=8192&&/^[!-~]+$/.test(p.serviceKey)&&typeof p.fetchImpl==='function');
 const {projectUrl,serviceKey,fetchImpl}=p;
 return async function readObject(reference,options){
  const r=data(reference,['bucket','key','sha256','maxBytes']);
  need(r.bucket==='brufap-a1-vault'&&typeof r.sha256==='string'&&/^[a-f0-9]{64}$/.test(r.sha256)&&typeof r.key==='string'&&new RegExp('^credentials/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/'+r.sha256+'\\.json$').test(r.key)&&r.maxBytes===1500000,'AUTHORIZATION_VAULT_REFERENCE_INVALID');
  const s=scope(options,20000),url=`${projectUrl}/storage/v1/object/authenticated/${r.bucket}/${r.key}`;let response,reader,bytes;const chunks=[];let size=0;
  try{
   const pending=Promise.resolve().then(()=>{s.check();return fetchImpl(url,{method:'GET',redirect:'manual',cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',signal:s.signal,headers:{Authorization:`Bearer ${serviceKey}`,apikey:serviceKey,Accept:'application/json','Accept-Encoding':'identity','Cache-Control':'no-store'}});});
   try{response=await s.bounded(()=>pending);}catch(e){void pending.then(v=>cancel(v?.body)).catch(()=>{});throw e;}
   need(response instanceof Response&&!response.redirected&&(response.url===''||response.url===url)&&response.status===200&&/^application\/json(?:;\s*charset=utf-8)?$/i.test(response.headers.get('content-type')??''),'AUTHORIZATION_VAULT_RESPONSE_INVALID');
   const length=response.headers.get('content-length'),encoding=response.headers.get('content-encoding');
   need((encoding===null||encoding==='identity')&&(length===null||/^[0-9]{1,9}$/.test(length)&&Number(length)>0&&Number(length)<=r.maxBytes)&&response.body,'AUTHORIZATION_VAULT_BODY_INVALID');
   reader=response.body.getReader();for(;;){const item=await s.bounded(()=>reader.read());if(item.done)break;need(item.value instanceof Uint8Array&&item.value.length>0&&(size+=item.value.length)<=r.maxBytes,'AUTHORIZATION_VAULT_BODY_INVALID');chunks.push(Buffer.from(item.value));}
   need(size>0&&(length===null||Number(length)===size),'AUTHORIZATION_VAULT_BODY_INVALID');bytes=Buffer.concat(chunks,size);need(hash(bytes)===r.sha256,'AUTHORIZATION_VAULT_HASH_MISMATCH');s.check();const output=bytes;bytes=null;return output;
  }catch(e){if(e instanceof AuthorizationServiceError)throw e;throw new AuthorizationServiceError('AUTHORIZATION_VAULT_READ_FAILED');}
  finally{bytes?.fill(0);for(const b of chunks)b.fill(0);try{void reader?.cancel().catch(()=>{});}catch{}try{reader?.releaseLock();}catch{}cancel(response?.body);s.stop('AUTHORIZATION_SERVICE_ABORTED');s.close();}
 };
}
