/** Optional local Python port. No network, environment credentials or runtime wiring. */
import {spawn} from 'node:child_process';
import {isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {receiptRequestBytes,receiptValidationContext,parseReceiptResponse,FiscalReceiptError,MAX_RECEIPT_BYTES} from './receipt-core.mjs';

export const RECEIPT_VALIDATOR_PROFILE=Object.freeze({
  profile:'brufap-receipt-pl010f-v1.04',
  validatorHash:'13773b14382b10d559b8a8d5c6d13d03c01f317ce7173e238955996c408662a0',
  manifestHash:'01b172bfb96670a9f271c7fabf1987dc66a1fe7e2290b423f77519ed7e4bbdda',
});
const XML_CODES=Object.freeze(['RECEIPT_INPUT_INVALID','RECEIPT_ENCODING_INVALID','RECEIPT_SIZE_LIMIT',
  'RECEIPT_XML_DECLARATION_UNSUPPORTED','RECEIPT_XML_INVALID','RECEIPT_ROOT_INVALID','RECEIPT_TREE_LIMIT',
  'RECEIPT_XSD_INVALID','RECEIPT_SINGLE_CANDIDATE_REQUIRED','RECEIPT_CONTEXT_MISMATCH','RECEIPT_REFERENCE_MISMATCH',
  'RECEIPT_TIMESTAMP_INVALID','RECEIPT_PROTOCOL_CONTEXT_MISMATCH',
  'RECEIPT_PROTOCOL_INCOMPLETE']);
const fail=code=>{throw new FiscalReceiptError(code);};
const digest=v=>createHash('sha256').update(v).digest('hex');
const prototype=Object.getPrototypeOf(Uint8Array.prototype);
const getters=Object.fromEntries(['byteLength','byteOffset','buffer'].map(k=>[k,Object.getOwnPropertyDescriptor(prototype,k).get]));
function data(v,keys,required=keys){try{if(!v||![Object.prototype,null].includes(Object.getPrototypeOf(v)))fail('RECEIPT_VALIDATOR_INPUT_INVALID');const d=Object.getOwnPropertyDescriptors(v),ks=Reflect.ownKeys(d);if(ks.some(k=>typeof k!=='string'||!keys.includes(k)||!Object.hasOwn(d[k],'value'))||required.some(k=>!Object.hasOwn(d,k)))fail('RECEIPT_VALIDATOR_INPUT_INVALID');return Object.fromEntries(ks.map(k=>[k,d[k].value]));}catch{fail('RECEIPT_VALIDATOR_INPUT_INVALID');}}
function copy(v){try{if(!ArrayBuffer.isView(v)||!(v instanceof Uint8Array))fail('RECEIPT_BYTES_INVALID');const size=getters.byteLength.call(v),offset=getters.byteOffset.call(v),buffer=getters.buffer.call(v);if(size<1||size>MAX_RECEIPT_BYTES||!(buffer instanceof ArrayBuffer))fail('RECEIPT_BYTES_INVALID');return Buffer.from(new Uint8Array(buffer,offset,size));}catch{fail('RECEIPT_BYTES_INVALID');}}
const aborted=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted').get;
const add=EventTarget.prototype.addEventListener,remove=EventTarget.prototype.removeEventListener;
function check(signal,deadline){if(signal&&aborted.call(signal))fail('RECEIPT_VALIDATOR_ABORTED');if(Date.now()>=deadline)fail('RECEIPT_VALIDATOR_TIMEOUT');}
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const falseFlags=['signatureVerified','tlsOriginVerified','sefazAuthorized','authorizedInHomologation','canQuery','canEmit','canTransmit','retrySubmissionAllowed'];
function project(raw,exit,ctx){
  if(raw?.ok===false){
    if(exit!==2||!exact(raw,['ok','code','canTransmit'])||raw.canTransmit!==false)fail('RECEIPT_VALIDATOR_RESPONSE_INVALID');
    if(!XML_CODES.includes(raw.code))fail('RECEIPT_VALIDATOR_PROFILE_UNAVAILABLE');
    return Object.freeze({ok:false,code:raw.code,xmlDigest:ctx.hash,kind:ctx.kind,...Object.fromEntries(falseFlags.map(k=>[k,false])),xsdValidated:false,contextMatched:false});
  }
  if(exit!==0||!exact(raw,['ok','schemaProfile','kind','xmlDigest','model','environment','xsdValidated','contextMatched','cStat','protocolCStat','referenceDigestMatched','authorizationDeclared',...falseFlags])
    ||raw.ok!==true||raw.schemaProfile!==RECEIPT_VALIDATOR_PROFILE.profile||raw.kind!==ctx.kind||raw.xmlDigest!==ctx.hash
    ||raw.model!==ctx.model||raw.environment!=='2'||raw.xsdValidated!==true||raw.contextMatched!==true||falseFlags.some(k=>raw[k]!==false)
    ||!['cStat','protocolCStat'].every(k=>raw[k]===null||typeof raw[k]==='string'&&/^\d{3,4}$/.test(raw[k]))
    ||typeof raw.referenceDigestMatched!=='boolean'||raw.authorizationDeclared!==['100','150'].includes(raw.protocolCStat)
    ||(ctx.kind==='response')!==(raw.cStat!==null)||ctx.kind==='request'&&(raw.protocolCStat!==null||raw.referenceDigestMatched)
    )fail('RECEIPT_VALIDATOR_RESPONSE_INVALID');
  if(ctx.response&&(raw.cStat!==ctx.response.cStat||raw.protocolCStat!==(ctx.response.protocol?.cStat??null)||raw.referenceDigestMatched!==(ctx.response.protocol?.referenceDigestMatched??false)))fail('RECEIPT_VALIDATOR_RESPONSE_INVALID');
  return Object.freeze({...raw,validatorHash:RECEIPT_VALIDATOR_PROFILE.validatorHash,schemaManifestHash:RECEIPT_VALIDATOR_PROFILE.manifestHash});
}
const bootstrap=`import sys,pathlib,hashlib\np=pathlib.Path(sys.argv[1]);b=p.read_bytes()\nif hashlib.sha256(b).hexdigest()!='${RECEIPT_VALIDATOR_PROFILE.validatorHash}': raise RuntimeError('profile unavailable')\nexec(compile(b,str(p),'exec'),{'__name__':'__main__','__file__':str(p)})`;

export function createReceiptValidator(configuration){
  const c=data(configuration,['pythonPath','validatorPath','spawnImpl'],['pythonPath','validatorPath']);
  if(!['pythonPath','validatorPath'].every(k=>typeof c[k]==='string'&&isAbsolute(c[k])&&!/[\x00-\x1f\x7f]/.test(c[k]))||c.spawnImpl!==undefined&&typeof c.spawnImpl!=='function')fail('RECEIPT_VALIDATOR_CONFIGURATION_INVALID');
  const execute=c.spawnImpl??spawn;
  return async function validate(input,options={}){
    const v=data(input,['request','xmlBytes','kind']),o=data(options,['signal','deadline'],[]),signal=o.signal;
    if(!['request','response'].includes(v.kind)||signal!==undefined&&!(signal instanceof AbortSignal)||o.deadline!==undefined&&!Number.isSafeInteger(o.deadline))fail('RECEIPT_VALIDATOR_INPUT_INVALID');
    // Test the local brand before reading handle metadata. A hash is not attestation.
    try{if(signal!==undefined)aborted.call(signal);}catch{fail('RECEIPT_VALIDATOR_INPUT_INVALID');}
    const probe=receiptRequestBytes(v.request);probe.fill(0);
    const deadline=Math.min(o.deadline??Date.now()+10000,Date.now()+10000);check(signal,deadline);
    const bytes=copy(v.xmlBytes),ctx={kind:v.kind,model:v.request.model,hash:digest(bytes)};let payload;
    try{
      let xml;try{xml=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{fail('RECEIPT_ENCODING_INVALID');}
      if(v.kind==='request'&&ctx.hash!==v.request.requestHash)fail('RECEIPT_REQUEST_HASH_MISMATCH');
      if(v.kind==='response')ctx.response=parseReceiptResponse({request:v.request,responseBytes:bytes});
      payload=Buffer.from(JSON.stringify({xml,kind:v.kind,...receiptValidationContext(v.request)}));xml=null;
      return await new Promise((resolve,reject)=>{
        let child,done=false,timer,total=0,stderr=0;const chunks=[];
        const cleanup=()=>{clearTimeout(timer);if(signal)remove.call(signal,'abort',onAbort);chunks.forEach(x=>x.fill(0));chunks.length=0;};
        const stop=code=>{if(done)return;done=true;try{child?.kill('SIGKILL');}catch{}cleanup();reject(new FiscalReceiptError(code));};
        const onAbort=()=>stop('RECEIPT_VALIDATOR_ABORTED');if(signal)add.call(signal,'abort',onAbort,{once:true});timer=setTimeout(()=>stop('RECEIPT_VALIDATOR_TIMEOUT'),Math.max(1,deadline-Date.now()));
        if(signal&&aborted.call(signal)){onAbort();return;}
        try{
          check(signal,deadline);child=execute(c.pythonPath,['-I','-B','-c',bootstrap,c.validatorPath],{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{LANG:'C.UTF-8',PATH:'/usr/bin:/bin'}});
          if(!child?.stdin||!child.stdout||!child.stderr||typeof child.kill!=='function'){stop('RECEIPT_VALIDATOR_PROCESS_FAILED');return;}
          child.once('error',()=>stop('RECEIPT_VALIDATOR_PROCESS_FAILED'));child.stdin.on('error',()=>stop('RECEIPT_VALIDATOR_PROCESS_FAILED'));
          child.stdout.on('data',x=>{if(done)return;if(!(x instanceof Uint8Array)||(total+=x.length)>16384){stop('RECEIPT_VALIDATOR_OUTPUT_LIMIT');return;}chunks.push(Buffer.from(x));});
          child.stderr.on('data',x=>{if(done)return;if(!(x instanceof Uint8Array)||(stderr+=x.length)>8192)stop('RECEIPT_VALIDATOR_OUTPUT_LIMIT');});
          child.once('close',(exit,kill)=>{if(done)return;let raw;try{check(signal,deadline);if(kill||![0,2].includes(exit))fail('RECEIPT_VALIDATOR_PROCESS_FAILED');raw=Buffer.concat(chunks);const value=project(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)),exit,ctx);check(signal,deadline);done=true;cleanup();resolve(value);}catch(e){stop(e instanceof FiscalReceiptError?e.code:'RECEIPT_VALIDATOR_RESPONSE_INVALID');}finally{raw?.fill(0);}});
          child.stdin.end(payload);
        }catch(e){stop(e instanceof FiscalReceiptError?e.code:'RECEIPT_VALIDATOR_PROCESS_FAILED');}
      });
    }finally{bytes.fill(0);payload?.fill(0);}
  };
}
