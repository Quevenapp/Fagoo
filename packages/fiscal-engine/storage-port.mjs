import {createHash} from 'node:crypto';
import {id,need,scope,data} from '../fiscal-authorization/src/service-common.mjs';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const UUID='[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const validKey=new RegExp(`^(?:candidates/${UUID}/[a-f0-9]{64}\\.xml|authorization/${UUID}/(?:requests|responses|processed)/[a-f0-9]{64}\\.xml|authorization/${UUID}/observations/[a-f0-9]{64}\\.json)$`);

/** Uses the installation's private immutable store, with an enforced company prefix. */
export function createFiscalArtifactPort({storage,companyId}){
  need(id(companyId)&&storage&&typeof storage.get==='function'&&typeof storage.put==='function','FISCAL_ARTIFACT_CONFIGURATION_INVALID');
  const key=input=>{need(input.bucket==='fagoo-fiscal-artifacts'&&typeof input.key==='string'&&validKey.test(input.key),'FISCAL_ARTIFACT_KEY_INVALID');return`companies/${companyId}/fiscal-engine/${input.key}`;};
  return Object.freeze({
    async read(input){
      const x=data(input,['bucket','key'],['signal','deadline']),objectKey=key(x),s=scope({signal:x.signal,deadline:x.deadline},15000);
      try{
        let bytes;try{bytes=await s.bounded(()=>storage.get(objectKey));}catch(error){if(error?.$metadata?.httpStatusCode===404||error?.code==='OBJECT_NOT_FOUND')return null;throw error;}
        s.check();need(bytes instanceof Uint8Array&&bytes.length>0&&bytes.length<=512000,'FISCAL_ARTIFACT_BYTES_INVALID');
        return new Response(Buffer.from(bytes),{headers:{'content-type':'application/octet-stream','content-length':String(bytes.length)}});
      }finally{s.close();}
    },
    async putImmutable(input){
      const x=data(input,['bucket','key','bytes','sha256','contentType','upsert','ifNoneMatch'],['signal','deadline']),objectKey=key(x),s=scope({signal:x.signal,deadline:x.deadline},15000);
      let bytes;
      try{
        need(x.upsert===false&&x.ifNoneMatch==='*'&&x.contentType==='application/octet-stream'&&x.bytes instanceof Uint8Array&&x.bytes.length>0&&x.bytes.length<=512000,'FISCAL_ARTIFACT_INPUT_INVALID');
        bytes=Buffer.from(x.bytes);need(digest(bytes)===x.sha256,'FISCAL_ARTIFACT_HASH_MISMATCH');
        await s.bounded(()=>storage.put(objectKey,bytes,{contentType:x.contentType,sha256:x.sha256}));s.check();
        const readback=await s.bounded(()=>storage.get(objectKey));s.check();need(readback instanceof Uint8Array&&readback.length===bytes.length&&digest(readback)===x.sha256,'FISCAL_ARTIFACT_READBACK_MISMATCH');
        return{status:201,requires_readback:true};
      }finally{bytes?.fill(0);s.close();}
    }
  });
}
