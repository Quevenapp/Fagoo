import {createHash} from 'node:crypto';
import {parseEnvelope,withCredential,VaultError} from '../../fiscal-vault/src/index.mjs';
import {context as vaultContext} from '../../fiscal-vault/src/common.mjs';
import {metadata as checkedMetadata,timestamp} from '../../fiscal-runtime/src/dto.mjs';
import {buildAccessKey} from '../../fiscal-core/src/identity.mjs';
import {FiscalXmlError,disposeSigner} from '../../fiscal-xml/src/index.mjs';

const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/,HASH=/^[a-f0-9]{64}$/;
const KEYS=['actor','command_id','candidate_id','a1_version','lease_id','lease_until','used_at','identity','access_key','unsigned_object','credential_context','credential_metadata','credential_object'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const id=v=>typeof v==='string'&&UUID.test(v),sha=v=>typeof v==='string'&&HASH.test(v);
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
export class SignedCustodyError extends Error{constructor(code){super(code);this.name='SignedCustodyError';this.code=code;}}
const need=(v,code='SIGNED_CUSTODY_GRANT_INVALID')=>{if(!v)throw new SignedCustodyError(code);};
function copy(value,depth=0){
 need(depth<=8);
 if(value===null||typeof value==='boolean'||typeof value==='number'||typeof value==='string'){need(typeof value!=='string'||value.length<=4096);need(typeof value!=='number'||Number.isFinite(value));return value;}
 need(value&&typeof value==='object'&&[Object.prototype,null,Array.prototype].includes(Object.getPrototypeOf(value)));
 const descriptors=Object.getOwnPropertyDescriptors(value),keys=Object.keys(descriptors);need(keys.length<=100&&Object.getOwnPropertySymbols(value).length===0);
 for(const key of keys)need(Object.hasOwn(descriptors[key],'value'));
 if(Array.isArray(value))return Object.freeze(value.map(item=>copy(item,depth+1)));
 return Object.freeze(Object.fromEntries(keys.map(key=>[key,copy(descriptors[key].value,depth+1)])));
}
function grant(input,now){
 const g=copy(input);need(exact(g,KEYS)&&['actor','command_id','candidate_id','lease_id'].every(k=>id(g[k]))&&Number.isInteger(g.a1_version)&&g.a1_version>0&&g.a1_version<=2147483647);
 need(timestamp(g.lease_until)&&timestamp(g.used_at)&&Date.parse(g.used_at)<Date.parse(g.lease_until));
 need(Date.parse(g.lease_until)>now,'SIGNED_CUSTODY_LEASE_EXPIRED');
 let ctx,meta;try{ctx=vaultContext(g.credential_context);meta=checkedMetadata(g.credential_metadata);}catch{throw new SignedCustodyError('SIGNED_CUSTODY_GRANT_INVALID');}
 const i=g.identity,o=g.unsigned_object,c=g.credential_object;
 need(exact(i,['cUF','cnpj','model','environment','series','number','issuedAt','cNF','tpEmis'])&&Object.values(i).every(v=>typeof v==='string')&&i.cUF==='35'&&i.environment==='2'&&i.tpEmis==='1'&&['55','65'].includes(i.model));
 try{need(buildAccessKey(i)===g.access_key);}catch{throw new SignedCustodyError('SIGNED_CUSTODY_GRANT_INVALID');}
 need(ctx.holder_cnpj===i.cnpj&&meta.holder_cnpj===i.cnpj&&ctx.credential_version<=g.a1_version);
 need(exact(o,['bucket','path','hash','size'])&&o.bucket==='brufap-fiscal-artifacts'&&sha(o.hash)&&Number.isInteger(o.size)&&o.size>=1&&o.size<=480000&&typeof o.path==='string'&&new RegExp(`^jobs/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/${o.hash}\\.xml$`).test(o.path));
 need(exact(c,['bucket','path','hash','size','key_id'])&&c.bucket==='brufap-a1-vault'&&sha(c.hash)&&Number.isInteger(c.size)&&c.size>=1&&c.size<=1500000&&c.path===`credentials/${ctx.credential_id}/${c.hash}.json`&&typeof c.key_id==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(c.key_id));
 need(now>=Date.parse(meta.not_before)&&now<=Date.parse(meta.not_after),'SIGNED_CUSTODY_CERTIFICATE_EXPIRED');
 return g;
}
function equal(a,b){
 if(a===b)return true;if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
 const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(k=>Object.hasOwn(b,k)&&equal(a[k],b[k]));
}

/** Private callback port. The caller must supply a freshly authorized, bound use050 grant. */
export function createSignedCustodyPort({readObject,loader,keyring,now=Date.now}={}){
 need(typeof readObject==='function'&&loader&&typeof loader.load==='function'&&keyring instanceof Map&&keyring.size>=1&&keyring.size<=5&&typeof now==='function','SIGNED_CUSTODY_CONFIGURATION_INVALID');
 for(const [key,bytes]of keyring)need(typeof key==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(key)&&bytes instanceof Uint8Array&&bytes.length===32,'SIGNED_CUSTODY_CONFIGURATION_INVALID');
 return async function withAuthorizedSigner(input,action,{signal,deadline}={}){
  need(typeof action==='function'&&(signal===undefined||signal instanceof AbortSignal)&&Number.isSafeInteger(deadline),'SIGNED_CUSTODY_OPTIONS_INVALID');
  let at,g;try{at=now();need(Number.isSafeInteger(at),'SIGNED_CUSTODY_CONFIGURATION_INVALID');}catch{throw new SignedCustodyError('SIGNED_CUSTODY_CONFIGURATION_INVALID');}
  try{g=grant(input,at);}catch(error){if(error instanceof SignedCustodyError)throw error;throw new SignedCustodyError('SIGNED_CUSTODY_GRANT_INVALID');}
  const end=Math.min(deadline,Date.now()+45000);
  const stop=new AbortController();let timer,rejectStop,closed=false,keyBytes,objectBytes,callbackError,invoked=false;
  const stopped=new Promise((_,reject)=>{rejectStop=reject;});void stopped.catch(()=>{});
  const abort=code=>{stop.abort();rejectStop(new SignedCustodyError(code));};
  const onAbort=()=>abort('SIGNED_CUSTODY_ABORTED');
  const check=()=>{need(!closed&&!signal?.aborted&&!stop.signal.aborted,'SIGNED_CUSTODY_ABORTED');need(Date.now()<end,'SIGNED_CUSTODY_TIMEOUT');const current=now();need(Number.isSafeInteger(current),'SIGNED_CUSTODY_CONFIGURATION_INVALID');need(current<Date.parse(g.lease_until),'SIGNED_CUSTODY_LEASE_EXPIRED');need(current>=Date.parse(g.credential_metadata.not_before)&&current<=Date.parse(g.credential_metadata.not_after),'SIGNED_CUSTODY_CERTIFICATE_EXPIRED');};
  const bounded=async(fn,late)=>{check();const pending=Promise.resolve().then(()=>{check();return fn();});void pending.then(value=>{if(closed)late?.(value);},()=>{});return Promise.race([pending,stopped]);};
  try{
   check();signal?.addEventListener('abort',onAbort,{once:true});timer=setTimeout(()=>abort('SIGNED_CUSTODY_TIMEOUT'),Math.max(1,end-Date.now()));
   const key=keyring.get(g.credential_object.key_id);need(key instanceof Uint8Array&&key.length===32,'SIGNED_CUSTODY_KEY_UNAVAILABLE');keyBytes=Buffer.from(key);
   const bytes=await bounded(()=>readObject(g.credential_object,{signal:stop.signal,deadline:end}),late=>{if(late instanceof Uint8Array)late.fill(0);});
   try{need(bytes instanceof Uint8Array&&bytes.length===g.credential_object.size&&hash(bytes)===g.credential_object.hash,'SIGNED_CUSTODY_OBJECT_INVALID');objectBytes=Buffer.from(bytes);}finally{if(bytes instanceof Uint8Array)bytes.fill(0);}
   check();let envelope;try{envelope=parseEnvelope(objectBytes);}catch{throw new SignedCustodyError('SIGNED_CUSTODY_ENVELOPE_INVALID');}
   need(envelope.key_id===g.credential_object.key_id&&equal(envelope.context,g.credential_context)&&equal(envelope.metadata,g.credential_metadata),'SIGNED_CUSTODY_ENVELOPE_CONFLICT');
   const useNow=now();need(Number.isSafeInteger(useNow)&&useNow>=Date.parse(g.credential_metadata.not_before)&&useNow<=Date.parse(g.credential_metadata.not_after),'SIGNED_CUSTODY_CERTIFICATE_EXPIRED');
   await bounded(()=>withCredential({envelope,expectedContext:g.credential_context,kekBytes:keyBytes,expectedKeyId:g.credential_object.key_id,loader,now:new Date(useNow)},signer=>{
    try{check();need(!invoked,'SIGNED_CUSTODY_CALLBACK_INVALID');invoked=true;const result=action(signer);if(result&&typeof result.then==='function')void Promise.resolve(result).catch(()=>{});need(result===undefined,'SIGNED_CUSTODY_CALLBACK_INVALID');check();}
    catch(error){callbackError=error;throw error;}finally{disposeSigner(signer);}
   }));
   check();need(invoked,'SIGNED_CUSTODY_CALLBACK_INVALID');
  }catch(error){
   if(error instanceof SignedCustodyError)throw error;
   if(callbackError instanceof FiscalXmlError)throw new FiscalXmlError(callbackError.code);
   if(callbackError instanceof SignedCustodyError)throw callbackError;
   if(error instanceof VaultError&&/EXPIRED/.test(error.code))throw new SignedCustodyError('SIGNED_CUSTODY_CERTIFICATE_EXPIRED');
   throw new SignedCustodyError('SIGNED_CUSTODY_OPEN_FAILED');
  }finally{closed=true;clearTimeout(timer);signal?.removeEventListener('abort',onAbort);stop.abort();keyBytes?.fill(0);objectBytes?.fill(0);}
 };
}
