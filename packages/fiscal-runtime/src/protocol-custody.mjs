import {createHash} from 'node:crypto';
import {parseEnvelope,withProtocolCredential} from '../../fiscal-vault/src/envelope.mjs';
import {context as vaultContext} from '../../fiscal-vault/src/common.mjs';
import {metadata as checkedMetadata} from './dto.mjs';
import {context as checkedContext} from '../../fiscal-reconciliation/src/dto.mjs';
import {prepareReviewedProtocolSoap,encodeReviewedProtocolSoap} from '../../fiscal-xml/src/protocol-binding.mjs';

const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const PURPOSE='sefaz-sp-protocol-homologation-v1';
const uuid=v=>typeof v==='string'&&UUID.test(v);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export class ProtocolCustodyError extends Error {
  constructor(code){super(code);this.name='ProtocolCustodyError';this.code=code;this.retry_automatically=false;}
}
const need=(value,code='PROTOCOL_CUSTODY_PREPARATION_INVALID')=>{if(!value)throw new ProtocolCustodyError(code);};
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
function capture(input,at){
  const value=copy(input),{actor,execution,context}=fields(value,['actor','execution','context']);
  fields(execution,['private_executor_only','context','credential']);
  const scope=checkedContext(execution.context),request=checkedContext(context),credential=fields(execution.credential,['id','context','metadata','object']);
  need(uuid(actor)&&execution.private_executor_only===true&&scope.actor===actor&&scope.purpose===PURPOSE&&request.purpose===PURPOSE&&scope.request_hash===null&&scope.request_size===null);
  need(equal(scope,{...request,request_hash:null,request_size:null}));
  const plan=prepareReviewedProtocolSoap({accessKey:scope.access_key,expectedModel:scope.model,environment:'2',requestId:scope.attempt_id});
  const bytes=encodeReviewedProtocolSoap(plan);
  try{need(request.request_hash===hash(bytes)&&request.request_size===bytes.length,'PROTOCOL_CUSTODY_REQUEST_MISMATCH');}finally{bytes.fill(0);}
  need(Date.parse(scope.expires_at)>at&&Date.parse(scope.expires_at)<=at+60000,'PROTOCOL_CUSTODY_LEASE_EXPIRED');
  const ctx=vaultContext(credential.context),meta=checkedMetadata(credential.metadata),object=fields(credential.object,['bucket','key','hash','size_bytes','key_id']);
  need(credential.id===scope.credential_id&&ctx.credential_id===scope.credential_id&&ctx.credential_version<=scope.a1_version&&
    ctx.company_identity_version===scope.identity_version&&ctx.holder_cnpj===scope.issuer_cnpj&&meta.holder_cnpj===scope.issuer_cnpj&&meta.fingerprint_sha256===scope.certificate_fingerprint);
  need(object.bucket==='brufap-a1-vault'&&object.hash===scope.envelope_hash&&object.key===`credentials/${credential.id}/${object.hash}.json`&&
    Number.isInteger(object.size_bytes)&&object.size_bytes>=1&&object.size_bytes<=1500000&&typeof object.key_id==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(object.key_id));
  need(at>=Date.parse(meta.not_before)&&at<=Date.parse(meta.not_after),'PROTOCOL_CUSTODY_CERTIFICATE_EXPIRED');
  return value;
}

/**
 * Private preparation port, with no environment, network or default repository.
 * authorizePreparation must replay the EXISTING begin062 command, revalidate
 * ACL/current state and return its identical execution while still prepared.
 * This is not use062: the trusted action must consume use062 successfully before
 * handing its TLS context to any protocol POST/handshake, and await/close that operation.
 * readObject transfers ownership of returned bytes to this port for wiping.
 */
export function createProtocolCustodyPort(config){
  let readObject,loader,load,keyring,authorizePreparation,now;
  try{
    ({readObject,loader,keyring,authorizePreparation,now=Date.now}=fields(config,['readObject','loader','keyring','authorizePreparation','now'],['readObject','loader','keyring','authorizePreparation']));
    load=loader?.withContext;
    need(typeof readObject==='function'&&typeof load==='function'&&typeof authorizePreparation==='function'&&typeof now==='function'&&
      keyring instanceof Map&&keyring.size>=1&&keyring.size<=5);
    for(const [id,bytes]of keyring)need(typeof id==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(id)&&bytes instanceof Uint8Array&&bytes.length===32);
  }catch{throw new ProtocolCustodyError('PROTOCOL_CUSTODY_CONFIGURATION_INVALID');}
  const tlsLoader=Object.freeze({withContext:(...args)=>load.apply(loader,args)});
  return async function withPreparedSession(input,action,options){
    let value,signal,deadline,controller,timer,onAbort,stopListener,keyBytes,objectBytes,closed=false,invoked=false;
    let abortCode='PROTOCOL_CUSTODY_TIMEOUT';
    const time=()=>{let at;try{at=now();}catch{throw new ProtocolCustodyError('PROTOCOL_CUSTODY_CLOCK_INVALID');}need(Number.isSafeInteger(at),'PROTOCOL_CUSTODY_CLOCK_INVALID');return at;};
    try{
      const opts=fields(options,['signal','deadline'],['deadline']);signal=opts.signal;deadline=opts.deadline;
      need(typeof action==='function'&&(signal===undefined||signal instanceof AbortSignal)&&Number.isSafeInteger(deadline)&&
        deadline>Date.now()&&deadline<=Date.now()+20000,'PROTOCOL_CUSTODY_OPTIONS_INVALID');
      value=capture(input,time());
      // A replayed preparation may have less than the client's 20s left.
      deadline=Math.min(deadline,Date.now()+Date.parse(value.execution.context.expires_at)-time());
      controller=new AbortController();onAbort=()=>{abortCode='PROTOCOL_CUSTODY_ABORTED';controller.abort();};
      signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)onAbort();
      const check=()=>{
        need(!closed&&!controller.signal.aborted,abortCode);need(Date.now()<deadline,'PROTOCOL_CUSTODY_TIMEOUT');
        const at=time(),s=value.execution.context,m=value.execution.credential.metadata;
        need(at<Date.parse(s.expires_at),'PROTOCOL_CUSTODY_LEASE_EXPIRED');
        need(at>=Date.parse(m.not_before)&&at<=Date.parse(m.not_after),'PROTOCOL_CUSTODY_CERTIFICATE_EXPIRED');
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
      const key=keyring.get(object.key_id);need(key instanceof Uint8Array&&key.length===32,'PROTOCOL_CUSTODY_KEY_UNAVAILABLE');keyBytes=Buffer.from(key);
      let fresh;
      try{fresh=await bounded(()=>authorizePreparation(value,{signal:controller.signal,deadline}));}
      catch(error){if(error instanceof ProtocolCustodyError)throw error;throw new ProtocolCustodyError('PROTOCOL_CUSTODY_AUTHORIZATION_REJECTED');}
      need(equal(copy(fresh),value.execution),'PROTOCOL_CUSTODY_PREPARATION_CHANGED');check();
      const reference=Object.freeze({bucket:object.bucket,path:object.key,hash:object.hash,size:object.size_bytes,key_id:object.key_id});
      const bytes=await bounded(()=>readObject(reference,{signal:controller.signal,deadline}),late=>{if(late instanceof Uint8Array)late.fill(0);});
      try{need(bytes instanceof Uint8Array&&bytes.length===object.size_bytes&&hash(bytes)===object.hash,'PROTOCOL_CUSTODY_OBJECT_INVALID');objectBytes=Buffer.from(bytes);}
      finally{if(bytes instanceof Uint8Array)bytes.fill(0);}
      check();let envelope;
      try{envelope=parseEnvelope(objectBytes);}catch{throw new ProtocolCustodyError('PROTOCOL_CUSTODY_ENVELOPE_INVALID');}
      need(envelope.key_id===object.key_id&&equal(envelope.context,credential.context)&&equal(envelope.metadata,credential.metadata),'PROTOCOL_CUSTODY_ENVELOPE_CONFLICT');
      await bounded(()=>withProtocolCredential({envelope,expectedEnvelopeHash:object.hash,expectedContext:credential.context,kekBytes:keyBytes,
        expectedKeyId:object.key_id,loader:tlsLoader,purpose:PURPOSE,now:new Date(time()),signal:controller.signal,deadline},async scope=>{
        check();need(!invoked,'PROTOCOL_CUSTODY_CALLBACK_INVALID');invoked=true;
        const result=await action(scope);check();need(result===undefined,'PROTOCOL_CUSTODY_CALLBACK_INVALID');
      }));
      check();need(invoked,'PROTOCOL_CUSTODY_CALLBACK_INVALID');
    }catch(error){
      if(error instanceof ProtocolCustodyError)throw error;
      if(controller?.signal.aborted)throw new ProtocolCustodyError(abortCode);
      throw new ProtocolCustodyError('PROTOCOL_CUSTODY_OPEN_FAILED');
    }finally{
      closed=true;clearTimeout(timer);signal?.removeEventListener('abort',onAbort);
      controller?.signal.removeEventListener('abort',stopListener);controller?.abort();keyBytes?.fill(0);objectBytes?.fill(0);
    }
  };
}
