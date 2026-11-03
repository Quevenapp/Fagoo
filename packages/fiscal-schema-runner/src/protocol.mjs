import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {dirname,join,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';

export const PROTOCOL_RUNNER_PROFILE=Object.freeze({version:'fiscal-protocol-runner-v1',schemaProfile:'protocol-pl010d-v1.03',manifestHash:'e49b6b35f34dc361f9a5611ac40e161fde7f2c23b32d3bc14b9a60d77c08f2ee',validatorHash:'90f25cd7f3858b6af37294b075043f6d603c259f921307e3d5f6591cf249f735',dependencyHash:'1da9dba6f75bca015fd7bd114a9fa030e57bb11d46a8f4b248cc3214dcbc53c6'});
export const PROTOCOL_XML_CODES=Object.freeze(['XML_SIZE_OR_TYPE_INVALID','XML_ENCODING_INVALID','XML_DECLARATION_UNSUPPORTED','XML_MALFORMED','XML_QUERY_ROOT_INVALID','XML_TREE_LIMIT','XML_XSD_INVALID','XML_HOMOLOGATION_REQUIRED','XML_QUERY_KEY_MISMATCH','XML_QUERY_UF_MISMATCH','XML_QUERY_TIMESTAMP_INVALID','XML_PROTOCOL_CONTEXT_MISMATCH','XML_PROTOCOL_TIMESTAMP_INVALID','XML_PROTOCOL_DIGEST_INVALID','XML_AUTHORIZATION_PROTOCOL_INCOMPLETE','XML_PROTOCOL_DIGEST_MISMATCH','XML_EVENT_CONTEXT_MISMATCH']);
const MAX=512000,HASH=/^[a-f0-9]{64}$/,FALSE=['verified','tlsOriginVerified','signatureVerified','sefazAuthorized','canTransmit'];
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export class FiscalProtocolRunnerError extends Error{constructor(code){super(code);this.name='FiscalProtocolRunnerError';this.code=code;}}
const fail=code=>{throw new FiscalProtocolRunnerError(code);};
function data(value,allowed,required=allowed){
 try{if(!value||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail('PROTOCOL_RUNNER_INPUT_INVALID');const ds=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(ds);if(keys.some(k=>typeof k!=='string'||!allowed.includes(k)||!Object.hasOwn(ds[k],'value'))||required.some(k=>!Object.hasOwn(ds,k)))fail('PROTOCOL_RUNNER_INPUT_INVALID');return Object.fromEntries(keys.map(k=>[k,ds[k].value]));}catch{fail('PROTOCOL_RUNNER_INPUT_INVALID');}
}
const exact=(v,keys)=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const path=v=>typeof v==='string'&&isAbsolute(v)&&!/[\x00-\x1f\x7f]/.test(v);
function check(signal,deadline){if(signal?.aborted)fail('PROTOCOL_RUNNER_ABORTED');if(Date.now()>=deadline)fail('PROTOCOL_RUNNER_TIMEOUT');}
function stamp(v){const m=typeof v==='string'&&/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|[+-](\d{2}):(\d{2}))$/.exec(v);if(!m||+m[1]<2000||+m[4]>23||+m[5]>59||+m[6]>59||(+m[8]||0)>14||(+m[9]||0)>59||+m[8]===14&&+m[9]!==0)return false;const d=new Date(Date.UTC(+m[1],+m[2]-1,+m[3]));return d.getUTCFullYear()===+m[1]&&d.getUTCMonth()===+m[2]-1&&d.getUTCDate()===+m[3];}
function diagnostic(v){if(!exact(v,['line','column','domain','type'])||!['line','column'].every(k=>Number.isInteger(v[k])&&v[k]>=0&&v[k]<=MAX)||!['domain','type'].every(k=>typeof v[k]==='string'&&/^[A-Z][A-Z0-9_]{0,95}$/.test(v[k])))fail('PROTOCOL_RUNNER_RESPONSE_INVALID');return Object.freeze({...v});}
function report(raw,exit,ctx){
 const base={xmlDigest:ctx.expectedHash,model:ctx.expectedModel,environment:'2',direction:ctx.direction,sizeBytes:ctx.sizeBytes,schemaProfile:PROTOCOL_RUNNER_PROFILE.schemaProfile,validatorVersion:PROTOCOL_RUNNER_PROFILE.version,validatorHash:PROTOCOL_RUNNER_PROFILE.validatorHash,schemaManifestHash:PROTOCOL_RUNNER_PROFILE.manifestHash,canEmit:false,canQuery:false,...Object.fromEntries(FALSE.map(k=>[k,false]))};
 if(raw?.ok===false){
  if(exit!==2||!exact(raw,['ok','code','diagnostics','verified','canTransmit'])||raw.verified!==false||raw.canTransmit!==false||typeof raw.code!=='string'||!Array.isArray(raw.diagnostics)||raw.diagnostics.length>20)fail('PROTOCOL_RUNNER_RESPONSE_INVALID');
  if(!PROTOCOL_XML_CODES.includes(raw.code))fail('PROTOCOL_RUNNER_PROFILE_UNAVAILABLE');
  if(raw.code!=='XML_XSD_INVALID'&&raw.diagnostics.length)fail('PROTOCOL_RUNNER_RESPONSE_INVALID');
  return Object.freeze({...base,ok:false,code:raw.code,diagnostics:Object.freeze(raw.diagnostics.map(diagnostic)),xsdValidated:false,contextMatched:false});
 }
 const fields=['ok','schemaProfile','direction','xmlDigest','model','environment','xsdValidated','contextMatched',...FALSE],response=ctx.direction==='response';
 if(response)fields.push('cStat','receivedAt','protocol','eventCount','legacyCancellationObserved','eventReconciliationRequired');
 if(exit!==0||!exact(raw,fields)||raw.ok!==true||raw.schemaProfile!==base.schemaProfile||raw.direction!==ctx.direction||raw.xmlDigest!==ctx.expectedHash||raw.model!==ctx.expectedModel||raw.environment!=='2'||raw.xsdValidated!==true||raw.contextMatched!==true||FALSE.some(k=>raw[k]!==false))fail('PROTOCOL_RUNNER_RESPONSE_INVALID');
 if(!response)return Object.freeze({...base,ok:true,xsdValidated:true,contextMatched:true});
 if(!/^\d{3,4}$/.test(raw.cStat)||typeof raw.cStat!=='string'||!stamp(raw.receivedAt)||!Number.isInteger(raw.eventCount)||raw.eventCount<0||raw.eventCount>25000||typeof raw.legacyCancellationObserved!=='boolean'||raw.eventReconciliationRequired!==(raw.eventCount>0||raw.legacyCancellationObserved||['101','151'].includes(raw.cStat)))fail('PROTOCOL_RUNNER_RESPONSE_INVALID');
 let protocol=null;if(raw.protocol!==null){const p=raw.protocol;if(!exact(p,['cStat','number','receivedAt','referenceDigestMatched'])||typeof p.cStat!=='string'||!/^\d{3,4}$/.test(p.cStat)||!stamp(p.receivedAt)||p.referenceDigestMatched!==(ctx.expectedReferenceDigest!==null)||p.number!==null&&(typeof p.number!=='string'||!/^(\d{15}|\d{17})$/.test(p.number))||['100','150'].includes(p.cStat)&&(!p.number||/^0+$/.test(p.number)))fail('PROTOCOL_RUNNER_RESPONSE_INVALID');protocol=Object.freeze({...p});}
 if(ctx.expectedReferenceDigest!==null&&['100','150'].includes(raw.cStat)&&protocol===null)fail('PROTOCOL_RUNNER_RESPONSE_INVALID');
 return Object.freeze({...base,ok:true,xsdValidated:true,contextMatched:true,cStat:raw.cStat,receivedAt:raw.receivedAt,protocol,eventCount:raw.eventCount,legacyCancellationObserved:raw.legacyCancellationObserved,eventReconciliationRequired:raw.eventReconciliationRequired});
}
// -I deliberately excludes script directories. Load only the two pinned sources,
// verifying the exact bytes again in the child before exec; no PYTHONPATH or env secret.
const BOOTSTRAP=`import sys,hashlib,types,pathlib\np=pathlib.Path(sys.argv[1])\ndef source(p,h):\n b=p.read_bytes()\n if hashlib.sha256(b).hexdigest()!=h: raise RuntimeError('profile unavailable')\n return compile(b,str(p),'exec')\nm=types.ModuleType('validator');m.__file__=str(p.parent/'validator.py');sys.modules['validator']=m\nexec(source(pathlib.Path(m.__file__),'${PROTOCOL_RUNNER_PROFILE.dependencyHash}'),m.__dict__)\nexec(source(p,'${PROTOCOL_RUNNER_PROFILE.validatorHash}'),{'__name__':'__main__','__file__':str(p)})`;

/** Local Node process only. The result validates structure/context, never remote origin. */
export function createFiscalProtocolRunner(configuration){
 const c=data(configuration,['pythonPath','validatorPath','spawnImpl'],['pythonPath','validatorPath']);
 if(!path(c.pythonPath)||!path(c.validatorPath)||c.spawnImpl!==undefined&&typeof c.spawnImpl!=='function')fail('PROTOCOL_RUNNER_CONFIGURATION_INVALID');const spawnImpl=c.spawnImpl??spawn;
 return async function validate(xmlBytes,options){
  const o=data(options,['expectedModel','expectedHash','expectedAccessKey','expectedReferenceDigest','direction','signal','deadline'],['expectedModel','expectedHash','expectedAccessKey','direction']);
  const signal=o.signal,deadline=Math.min(o.deadline??Date.now()+10000,Date.now()+10000),reference=o.expectedReferenceDigest??null;
  if(!(xmlBytes instanceof Uint8Array)||!(xmlBytes.buffer instanceof ArrayBuffer)||xmlBytes.byteLength<1||xmlBytes.byteLength>MAX||!['55','65'].includes(o.expectedModel)||typeof o.expectedHash!=='string'||!HASH.test(o.expectedHash)||typeof o.expectedAccessKey!=='string'||!/^35\d{4}[A-Z0-9]{12}\d{26}$/.test(o.expectedAccessKey)||o.expectedAccessKey.slice(20,22)!==o.expectedModel||!['request','response'].includes(o.direction)||signal!==undefined&&!(signal instanceof AbortSignal)||!Number.isSafeInteger(deadline)||o.deadline!==undefined&&!Number.isSafeInteger(o.deadline)||reference!==null&&(typeof reference!=='string'||!/^[A-Za-z0-9+/]{27}=$/.test(reference)||Buffer.from(reference,'base64').toString('base64')!==reference))fail('PROTOCOL_RUNNER_INPUT_INVALID');
  check(signal,deadline);const input=Buffer.from(xmlBytes),sizeBytes=input.length;let payload;
  try{
   if(digest(input)!==o.expectedHash)fail('PROTOCOL_RUNNER_HASH_MISMATCH');let xml;try{xml=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(input);}catch{fail('PROTOCOL_RUNNER_INPUT_INVALID');}
   payload=Buffer.from(JSON.stringify({xml,expectedModel:o.expectedModel,expectedAccessKey:o.expectedAccessKey,expectedReferenceDigest:reference,direction:o.direction}));xml=null;
   const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),Math.max(1,deadline-Date.now()));const readSignal=signal?AbortSignal.any([signal,abort.signal]):abort.signal;
   try{for(const[p,h]of[[c.validatorPath,PROTOCOL_RUNNER_PROFILE.validatorHash],[join(dirname(c.validatorPath),'validator.py'),PROTOCOL_RUNNER_PROFILE.dependencyHash]]){const bytes=await readFile(p,{signal:readSignal});try{if(digest(bytes)!==h)fail('PROTOCOL_RUNNER_PROFILE_UNAVAILABLE');}finally{bytes.fill(0);}}}
   catch(e){check(signal,deadline);if(e instanceof FiscalProtocolRunnerError)throw e;fail('PROTOCOL_RUNNER_PROFILE_UNAVAILABLE');}finally{clearTimeout(timer);}
   check(signal,deadline);
   return await new Promise((resolve,reject)=>{
    let child,settled=false,total=0,errors=0;const chunks=[];let timer;
    const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);chunks.forEach(v=>v.fill(0));chunks.length=0;};
    const stop=code=>{if(settled)return;settled=true;try{child?.kill('SIGKILL');}catch{}cleanup();reject(new FiscalProtocolRunnerError(code));};
    const onAbort=()=>stop('PROTOCOL_RUNNER_ABORTED');signal?.addEventListener('abort',onAbort,{once:true});timer=setTimeout(()=>stop('PROTOCOL_RUNNER_TIMEOUT'),Math.max(1,deadline-Date.now()));
    if(signal?.aborted){onAbort();return;}
    try{child=spawnImpl(c.pythonPath,['-I','-B','-c',BOOTSTRAP,c.validatorPath],{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{LANG:'C.UTF-8',PATH:'/usr/bin:/bin'}});
     if(!child?.stdin||!child.stdout||!child.stderr||typeof child.kill!=='function'){stop('PROTOCOL_RUNNER_PROCESS_FAILED');return;}
     child.once('error',()=>stop('PROTOCOL_RUNNER_PROCESS_FAILED'));child.stdin.on('error',()=>stop('PROTOCOL_RUNNER_PROCESS_FAILED'));
     child.stdout.on('data',v=>{if(settled)return;if(!(v instanceof Uint8Array)||(total+=v.length)>16384){stop('PROTOCOL_RUNNER_OUTPUT_LIMIT');return;}chunks.push(Buffer.from(v));});
     child.stderr.on('data',v=>{if(settled)return;if(!(v instanceof Uint8Array)||(errors+=v.length)>8192)stop('PROTOCOL_RUNNER_OUTPUT_LIMIT');});
     child.once('close',(code,sig)=>{if(settled)return;let bytes;try{check(signal,deadline);if(sig||![0,2].includes(code))fail('PROTOCOL_RUNNER_PROCESS_FAILED');bytes=Buffer.concat(chunks);const raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));const value=report(raw,code,{...o,expectedReferenceDigest:reference,sizeBytes});settled=true;cleanup();resolve(value);}catch(e){stop(e instanceof FiscalProtocolRunnerError?e.code:'PROTOCOL_RUNNER_RESPONSE_INVALID');}finally{bytes?.fill(0);}});
     child.stdin.end(payload);
    }catch{stop('PROTOCOL_RUNNER_PROCESS_FAILED');}
   });
  }finally{input.fill(0);payload?.fill(0);}
 };
}
