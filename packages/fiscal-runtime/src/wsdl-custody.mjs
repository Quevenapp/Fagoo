import {createHash} from 'node:crypto';
import {parseEnvelope,withWsdlCredential} from '../../fiscal-vault/src/envelope.mjs';
import {context as vaultContext} from '../../fiscal-vault/src/common.mjs';
import {metadata as checkedMetadata,timestamp} from './dto.mjs';
import {prepareWsdlRequest} from '../../fiscal-sefaz-wsdl/src/profile.mjs';
import {createWsdlPreparationDiagnostic} from '../../fiscal-sefaz-wsdl/src/preparation-diagnostic.mjs';

const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/,HASH=/^[a-f0-9]{64}$/;
const PURPOSE='sefaz-sp-wsdl-readonly-v1';
const SCOPE=['attempt_id','command_id','actor','nonce','expires_at','purpose','effective_profile','environment','model','operation',
  'method','endpoint','identity_version','issuer_cnpj','a1_version','credential_id','envelope_hash','certificate_fingerprint'];
const CONTEXT=['purpose','environment','model','operation','request_id','method','endpoint','deadline'];
const uuid=v=>typeof v==='string'&&UUID.test(v),sha=v=>typeof v==='string'&&HASH.test(v);
const version=v=>Number.isInteger(v)&&v>0&&v<=2147483647;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export class WsdlCustodyError extends Error {
  constructor(code){super(code);this.name='WsdlCustodyError';this.code=code;this.retry_automatically=false;}
}
const need=(value,code='WSDL_CUSTODY_PREPARATION_INVALID')=>{if(!value)throw new WsdlCustodyError(code);};
function fields(value,allowed,required=allowed){
  need(value&&[Object.prototype,null].includes(Object.getPrototypeOf(value)));
  const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(descriptors);
  need(keys.every(k=>typeof k==='string'&&allowed.includes(k)&&Object.hasOwn(descriptors[k],'value'))&&required.every(k=>Object.hasOwn(descriptors,k)));
  return Object.fromEntries(keys.map(k=>[k,descriptors[k].value]));
}
function copy(value,depth=0,budget={nodes:0}){
  need(depth<=8&&++budget.nodes<=256);
  if(value===null||typeof value==='boolean')return value;
  if(typeof value==='string'){need(value.length<=4096);return value;}
  if(typeof value==='number'){need(Number.isFinite(value));return value;}
  need(value&&typeof value==='object');
  const array=Array.isArray(value);
  need(array?Object.getPrototypeOf(value)===Array.prototype:[Object.prototype,null].includes(Object.getPrototypeOf(value)));
  const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(descriptors);
  need(keys.length<=32&&keys.every(k=>typeof k==='string'&&Object.hasOwn(descriptors[k],'value')));
  if(array){need(value.length<=10&&keys.length===value.length+1);return Object.freeze(Array.from({length:value.length},(_,i)=>copy(descriptors[i]?.value,depth+1,budget)));}
  return Object.freeze(Object.fromEntries(keys.map(k=>[k,copy(descriptors[k].value,depth+1,budget)])));
}
function equal(a,b){
  if(a===b)return true;
  if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
  const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(k=>Object.hasOwn(b,k)&&equal(a[k],b[k]));
}
function capture(input,at,deadline){
  const value=copy(input),{actor,execution,context}=fields(value,['actor','execution','context']);
  fields(execution,['private_executor_only','lease_id','scope','credential']);
  const scope=fields(execution.scope,SCOPE),credential=fields(execution.credential,['id','context','metadata','object']);
  fields(context,CONTEXT);
  need(uuid(actor)&&execution.private_executor_only===true&&uuid(execution.lease_id)&&
    ['attempt_id','command_id','actor','nonce','credential_id'].every(k=>uuid(scope[k]))&&scope.actor===actor&&
    scope.purpose===PURPOSE&&scope.effective_profile==='wsdl-mtls-client-v1'&&scope.environment==='2'&&scope.method==='GET'&&
    version(scope.a1_version)&&version(scope.identity_version)&&sha(scope.envelope_hash)&&sha(scope.certificate_fingerprint)&&timestamp(scope.expires_at));
  const plan=prepareWsdlRequest({model:scope.model,operation:scope.operation,requestId:scope.attempt_id});
  need(scope.endpoint===plan.url&&context.purpose===PURPOSE&&context.environment==='2'&&context.method==='GET'&&
    context.model===scope.model&&context.operation===scope.operation&&context.request_id===scope.attempt_id&&context.endpoint===scope.endpoint&&context.deadline===deadline);
  need(Date.parse(scope.expires_at)>at&&Date.parse(scope.expires_at)<=at+60000,'WSDL_CUSTODY_LEASE_EXPIRED');
  const ctx=vaultContext(credential.context),meta=checkedMetadata(credential.metadata),object=fields(credential.object,['bucket','key','hash','size_bytes','key_id']);
  need(credential.id===scope.credential_id&&ctx.credential_id===scope.credential_id&&ctx.credential_version<=scope.a1_version&&
    ctx.company_identity_version===scope.identity_version&&ctx.holder_cnpj===scope.issuer_cnpj&&meta.holder_cnpj===scope.issuer_cnpj&&meta.fingerprint_sha256===scope.certificate_fingerprint);
  need(object.bucket==='brufap-a1-vault'&&object.hash===scope.envelope_hash&&object.key===`credentials/${credential.id}/${object.hash}.json`&&
    Number.isInteger(object.size_bytes)&&object.size_bytes>=1&&object.size_bytes<=1500000&&typeof object.key_id==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(object.key_id));
  need(at>=Date.parse(meta.not_before)&&at<=Date.parse(meta.not_after),'WSDL_CUSTODY_CERTIFICATE_EXPIRED');
  return value;
}

/**
 * Private preparation port, with no environment, network or default repository.
 * authorizePreparation must replay the EXISTING begin051 command, revalidate
 * ACL/current state and return its identical execution while still prepared.
 * This is not use051: the trusted action must consume use051 successfully before
 * handing its TLS context to any GET/handshake, and await/close that operation.
 * readObject transfers ownership of returned bytes to this port for wiping.
 */
export function createWsdlCustodyPort(config){
  let readObject,loader,load,keyring,authorizePreparation,now,diagnostic;
  try{
    ({readObject,loader,keyring,authorizePreparation,now=Date.now,diagnostic}=fields(config,['readObject','loader','keyring','authorizePreparation','now','diagnostic'],['readObject','loader','keyring','authorizePreparation']));
    load=loader?.withContext;
    need(typeof readObject==='function'&&typeof load==='function'&&typeof authorizePreparation==='function'&&typeof now==='function'&&
      keyring instanceof Map&&keyring.size>=1&&keyring.size<=5&&(diagnostic===undefined||typeof diagnostic==='function'));
    for(const [id,bytes]of keyring)need(typeof id==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(id)&&bytes instanceof Uint8Array&&bytes.length===32);
  }catch{throw new WsdlCustodyError('WSDL_CUSTODY_CONFIGURATION_INVALID');}
  return async function withPreparedTlsSession(input,action,options){
    let value,signal,deadline,controller,timer,onAbort,stopListener,keyBytes,objectBytes,closed=false,invoked=false;
    let phase='input_validation',diagnosticError;
    const report=createWsdlPreparationDiagnostic(diagnostic);
    const tlsLoader=Object.freeze({withContext:(...args)=>{phase='pkcs12_validation';return load.apply(loader,args);}});
    let abortCode='WSDL_CUSTODY_TIMEOUT';
    const time=()=>{let at;try{at=now();}catch{throw new WsdlCustodyError('WSDL_CUSTODY_CLOCK_INVALID');}need(Number.isSafeInteger(at),'WSDL_CUSTODY_CLOCK_INVALID');return at;};
    try{
      const opts=fields(options,['signal','deadline'],['deadline']);signal=opts.signal;deadline=opts.deadline;
      need(typeof action==='function'&&(signal===undefined||signal instanceof AbortSignal)&&Number.isSafeInteger(deadline)&&
        deadline>Date.now()&&deadline<=Date.now()+30000,'WSDL_CUSTODY_OPTIONS_INVALID');
      value=capture(input,time(),deadline);
      // A replayed preparation may have less than the client's 30s left.
      deadline=Math.min(deadline,Date.now()+Date.parse(value.execution.scope.expires_at)-time());
      controller=new AbortController();onAbort=()=>{abortCode='WSDL_CUSTODY_ABORTED';controller.abort();};
      signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)onAbort();
      const check=()=>{
        need(!closed&&!controller.signal.aborted,abortCode);need(Date.now()<deadline,'WSDL_CUSTODY_TIMEOUT');
        const at=time(),s=value.execution.scope,m=value.execution.credential.metadata;
        need(at<Date.parse(s.expires_at),'WSDL_CUSTODY_LEASE_EXPIRED');
        need(at>=Date.parse(m.not_before)&&at<=Date.parse(m.not_after),'WSDL_CUSTODY_CERTIFICATE_EXPIRED');
      };
      check();timer=setTimeout(()=>controller.abort(),Math.max(1,deadline-Date.now()));
      const stopped=new Promise((_,reject)=>{
        stopListener=()=>{try{check();}catch(error){reject(error);}};
        controller.signal.addEventListener('abort',stopListener,{once:true});
      });
      const bounded=async(fn,late)=>{
        check();const pending=Promise.resolve().then(()=>{check();return fn();});
        void pending.then(result=>{if(closed)late?.(result);},()=>{});
        const result=await Promise.race([pending,stopped]);
        try{check();return result;}catch(error){late?.(result);throw error;}
      };
      const credential=value.execution.credential,object=credential.object;
      phase='key_selection';
      const key=keyring.get(object.key_id);need(key instanceof Uint8Array&&key.length===32,'WSDL_CUSTODY_KEY_UNAVAILABLE');keyBytes=Buffer.from(key);
      let fresh;
      phase='authorization_replay';
      try{fresh=await bounded(()=>authorizePreparation(value,{signal:controller.signal,deadline}));}
      catch(error){diagnosticError=error;if(error instanceof WsdlCustodyError)throw error;throw new WsdlCustodyError('WSDL_CUSTODY_AUTHORIZATION_REJECTED');}
      need(equal(copy(fresh),value.execution),'WSDL_CUSTODY_PREPARATION_CHANGED');check();
      const reference=Object.freeze({bucket:object.bucket,path:object.key,hash:object.hash,size:object.size_bytes,key_id:object.key_id});
      phase='encrypted_object_read';
      const bytes=await bounded(()=>readObject(reference,{signal:controller.signal,deadline}),late=>{if(late instanceof Uint8Array)late.fill(0);});
      phase='encrypted_object_validation';
      try{need(bytes instanceof Uint8Array&&bytes.length===object.size_bytes&&hash(bytes)===object.hash,'WSDL_CUSTODY_OBJECT_INVALID');objectBytes=Buffer.from(bytes);}
      finally{if(bytes instanceof Uint8Array)bytes.fill(0);}
      check();let envelope;
      phase='envelope_validation';
      try{envelope=parseEnvelope(objectBytes);}catch{throw new WsdlCustodyError('WSDL_CUSTODY_ENVELOPE_INVALID');}
      need(envelope.key_id===object.key_id&&equal(envelope.context,credential.context)&&equal(envelope.metadata,credential.metadata),'WSDL_CUSTODY_ENVELOPE_CONFLICT');
      phase='envelope_open';
      await bounded(()=>withWsdlCredential({envelope,expectedEnvelopeHash:object.hash,expectedContext:credential.context,kekBytes:keyBytes,
        expectedKeyId:object.key_id,loader:tlsLoader,purpose:PURPOSE,now:new Date(time()),signal:controller.signal,deadline},async scope=>{
        phase='callback_validation';
        check();need(!invoked,'WSDL_CUSTODY_CALLBACK_INVALID');invoked=true;
        const result=await action(scope);check();need(result===undefined,'WSDL_CUSTODY_CALLBACK_INVALID');
      }));
      check();need(invoked,'WSDL_CUSTODY_CALLBACK_INVALID');
    }catch(error){
      // Once the trusted callback starts it may consume use051. Never label
      // its failure (or a later cleanup failure) as a pre-use diagnostic.
      if(!invoked)report(phase,diagnosticError??error);
      if(error instanceof WsdlCustodyError)throw error;
      if(controller?.signal.aborted)throw new WsdlCustodyError(abortCode);
      throw new WsdlCustodyError('WSDL_CUSTODY_OPEN_FAILED');
    }finally{
      closed=true;clearTimeout(timer);signal?.removeEventListener('abort',onAbort);
      controller?.signal.removeEventListener('abort',stopListener);controller?.abort();keyBytes?.fill(0);objectBytes?.fill(0);
    }
  };
}
