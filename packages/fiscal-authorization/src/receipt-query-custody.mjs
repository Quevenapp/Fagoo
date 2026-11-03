import {parseEnvelope,withReceiptQueryCredential} from '../../fiscal-vault/src/envelope.mjs';
import {context as vaultContext} from '../../fiscal-vault/src/common.mjs';
import {captureReceiptQueryPreparation} from './receipt-query-preparation.mjs';
import {data,copy,hash,scope} from './service-common.mjs';
import {same} from './service-dto.mjs';
export class ReceiptQueryCustodyError extends Error {
 constructor(code){super(code);this.name='ReceiptQueryCustodyError';this.code=code;this.retry_automatically=false;}
}
const need=(v,c='RECEIPT_QUERY_CUSTODY_INVALID')=>{if(!v)throw new ReceiptQueryCustodyError(c);};
const wipe=b=>{try{if(b instanceof Uint8Array)b.fill(0);}catch{}};
/** No repository/environment defaults. The hashed041 envelope supplies its own
 * authenticated key id/context; no new grant is acquired to look up metadata.
 * readObject transfers ownership of returned ciphertext bytes to this port.
 */
export function createReceiptQueryCustodyPort(configuration){
 const p=data(configuration,['readObject','loader','keyring','authorizePreparation']);
 const loader=data(p.loader,['withContext']);
 need(typeof p.readObject==='function'&&typeof p.authorizePreparation==='function'&&typeof loader.withContext==='function'&&p.keyring instanceof Map&&p.keyring.size>=1&&p.keyring.size<=5);
 const readObject=p.readObject,authorize=p.authorizePreparation,keyring=p.keyring;
 const tlsLoader=Object.freeze({withContext:(...args)=>loader.withContext(...args)});
 return async function withPreparedSession(input,action,options){
  let s,bytes,keys,closed=false,called=false,complete=false,invalid=false;
  try{
   const v=captureReceiptQueryPreparation(input),c=v.context,o=data(options,['deadline'],['signal']);
   need(typeof action==='function'&&Number.isSafeInteger(o.deadline)&&o.deadline>Date.now()&&o.deadline<=Date.now()+20000,'RECEIPT_QUERY_CUSTODY_OPTIONS_INVALID');
   need(Date.parse(c.expires_at)>Date.now()&&Date.parse(c.expires_at)<=Date.now()+60000,'RECEIPT_QUERY_CUSTODY_LEASE_EXPIRED');
   // Snapshot every permitted KEK before the first await: key_id is only known
   // after the pinned envelope has arrived. Originals remain caller-owned.
   keys=new Map();need(keyring.size>=1&&keyring.size<=5);
   for(const [id,key]of keyring){need(typeof id==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(id));const own=copy(key,32);keys.set(id,own);need(own.length===32);}
   s=scope({signal:o.signal,deadline:Math.min(o.deadline,Date.parse(c.expires_at))},20000);
   const check=()=>{need(!closed,'RECEIPT_QUERY_CUSTODY_CALLBACK_CLOSED');s.check();need(Date.now()<Date.parse(c.expires_at),'RECEIPT_QUERY_CUSTODY_LEASE_EXPIRED');};
   check();const fresh=await s.bounded(()=>authorize(v,{signal:s.signal,deadline:s.deadline}));
   need(same(captureReceiptQueryPreparation({...v,context:fresh}).context,c),'RECEIPT_QUERY_CUSTODY_PREPARATION_CHANGED');check();
   const ref=Object.freeze({bucket:'brufap-a1-vault',key:`credentials/${c.credential_id}/${c.envelope_hash}.json`,sha256:c.envelope_hash,maxBytes:1500000});
   const pending=Promise.resolve().then(()=>{check();return readObject(ref,{signal:s.signal,deadline:s.deadline});});
   let received;try{received=await s.bounded(()=>pending);}catch(e){void pending.then(wipe,()=>{});throw e;}
   try{bytes=copy(received,1500000);need(hash(bytes)===c.envelope_hash,'RECEIPT_QUERY_CUSTODY_OBJECT_MISMATCH');}finally{wipe(received);}
   check();const envelope=parseEnvelope(bytes),ctx=vaultContext(envelope.context),meta=envelope.metadata;
   need(ctx.credential_id===c.credential_id&&ctx.credential_version<=c.a1_version&&ctx.company_identity_version===c.identity_version&&ctx.holder_cnpj===c.issuer_cnpj&&meta.holder_cnpj===c.issuer_cnpj&&meta.fingerprint_sha256===c.certificate_fingerprint,'RECEIPT_QUERY_CUSTODY_ENVELOPE_MISMATCH');
   need(Date.parse(meta.not_before)<=Date.now()&&Date.now()<=Date.parse(meta.not_after),'RECEIPT_QUERY_CUSTODY_CERTIFICATE_EXPIRED');
   const key=keys.get(envelope.key_id);need(key,'RECEIPT_QUERY_CUSTODY_KEY_UNAVAILABLE');
   await s.bounded(()=>withReceiptQueryCredential({envelope,expectedEnvelopeHash:c.envelope_hash,expectedContext:ctx,kekBytes:key,expectedKeyId:envelope.key_id,loader:tlsLoader,purpose:c.purpose,now:new Date(),signal:s.signal,deadline:s.deadline},async session=>{
    check();if(called){invalid=true;throw new ReceiptQueryCustodyError('RECEIPT_QUERY_CUSTODY_CALLBACK_INVALID');}called=true;
    const result=await action(session);check();need(result===undefined,'RECEIPT_QUERY_CUSTODY_CALLBACK_INVALID');complete=true;
   }));check();need(called&&complete&&!invalid,'RECEIPT_QUERY_CUSTODY_CALLBACK_INVALID');
  }catch(e){
   if(e instanceof ReceiptQueryCustodyError)throw e;
   if(e?.code==='42501')throw e; // Preserve an explicit ACL denial; never read privately after it.
   throw new ReceiptQueryCustodyError('RECEIPT_QUERY_CUSTODY_OPEN_FAILED');
  }finally{closed=true;s?.stop('AUTHORIZATION_SERVICE_ABORTED');s?.close();wipe(bytes);if(keys)for(const key of keys.values())wipe(key);}
 };
}
