/** Optional local Python port. No network, environment credentials or runtime wiring. */
import {spawn} from 'node:child_process';
import {isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {authorizationRequestBytes,FiscalAuthorizationError,MAX_AUTHORIZATION_BYTES} from './index.mjs';

export const AUTHORIZATION_VALIDATOR_PROFILE=Object.freeze({
  profile:'brufap-authorization-pl010f-v1.04',
  validatorHash:'98453faa968544a8a19d9ae10a29dbbed3015f7e8898062be33bed37b21ad612',
  manifestHash:'6248c0e9f23720a306df93e4c2e067f0b52a37ae6980e50846b2b4ff11334fda',
});
const XML_CODES=Object.freeze(['AUTHORIZATION_INPUT_INVALID','AUTHORIZATION_ENCODING_INVALID','AUTHORIZATION_SIZE_LIMIT',
  'AUTHORIZATION_XML_DECLARATION_UNSUPPORTED','AUTHORIZATION_XML_INVALID','AUTHORIZATION_ROOT_INVALID','AUTHORIZATION_TREE_LIMIT',
  'AUTHORIZATION_XSD_INVALID','AUTHORIZATION_SINGLE_NFE_REQUIRED','AUTHORIZATION_CONTEXT_MISMATCH','AUTHORIZATION_REFERENCE_MISMATCH',
  'AUTHORIZATION_BATCH_MISMATCH','AUTHORIZATION_TIMESTAMP_INVALID','AUTHORIZATION_PROTOCOL_CONTEXT_MISMATCH',
  'AUTHORIZATION_PROTOCOL_INCOMPLETE','AUTHORIZATION_PROCESSED_STATUS_INVALID']);
const fail=code=>{throw new FiscalAuthorizationError(code);};
const digest=v=>createHash('sha256').update(v).digest('hex');
const prototype=Object.getPrototypeOf(Uint8Array.prototype);
const getters=Object.fromEntries(['byteLength','byteOffset','buffer'].map(k=>[k,Object.getOwnPropertyDescriptor(prototype,k).get]));
function data(v,keys,required=keys){try{if(!v||![Object.prototype,null].includes(Object.getPrototypeOf(v)))fail('AUTHORIZATION_VALIDATOR_INPUT_INVALID');const d=Object.getOwnPropertyDescriptors(v),ks=Reflect.ownKeys(d);if(ks.some(k=>typeof k!=='string'||!keys.includes(k)||!Object.hasOwn(d[k],'value'))||required.some(k=>!Object.hasOwn(d,k)))fail('AUTHORIZATION_VALIDATOR_INPUT_INVALID');return Object.fromEntries(ks.map(k=>[k,d[k].value]));}catch{fail('AUTHORIZATION_VALIDATOR_INPUT_INVALID');}}
function copy(v){try{if(!ArrayBuffer.isView(v)||!(v instanceof Uint8Array))fail('AUTHORIZATION_BYTES_INVALID');const size=getters.byteLength.call(v),offset=getters.byteOffset.call(v),buffer=getters.buffer.call(v);if(size<1||size>MAX_AUTHORIZATION_BYTES||!(buffer instanceof ArrayBuffer))fail('AUTHORIZATION_BYTES_INVALID');return Buffer.from(new Uint8Array(buffer,offset,size));}catch{fail('AUTHORIZATION_BYTES_INVALID');}}
function check(signal,deadline){if(signal?.aborted)fail('AUTHORIZATION_VALIDATOR_ABORTED');if(Date.now()>=deadline)fail('AUTHORIZATION_VALIDATOR_TIMEOUT');}
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const falseFlags=['signatureVerified','tlsOriginVerified','sefazAuthorized','authorizedInHomologation','canEmit','canTransmit'];
function project(raw,exit,ctx){
  if(raw?.ok===false){
    if(exit!==2||!exact(raw,['ok','code','canTransmit'])||raw.canTransmit!==false)fail('AUTHORIZATION_VALIDATOR_RESPONSE_INVALID');
    if(!XML_CODES.includes(raw.code))fail('AUTHORIZATION_VALIDATOR_PROFILE_UNAVAILABLE');
    return Object.freeze({ok:false,code:raw.code,xmlDigest:ctx.hash,kind:ctx.kind,...Object.fromEntries(falseFlags.map(k=>[k,false])),xsdValidated:false,contextMatched:false});
  }
  if(exit!==0||!exact(raw,['ok','schemaProfile','kind','xmlDigest','model','environment','xsdValidated','contextMatched','cStat','protocolCStat','referenceDigestMatched','authorizationDeclared',...falseFlags])
    ||raw.ok!==true||raw.schemaProfile!==AUTHORIZATION_VALIDATOR_PROFILE.profile||raw.kind!==ctx.kind||raw.xmlDigest!==ctx.hash
    ||raw.model!==ctx.model||raw.environment!=='2'||raw.xsdValidated!==true||raw.contextMatched!==true||falseFlags.some(k=>raw[k]!==false)
    ||!['cStat','protocolCStat'].every(k=>raw[k]===null||typeof raw[k]==='string'&&/^\d{3,4}$/.test(raw[k]))
    ||typeof raw.referenceDigestMatched!=='boolean'||raw.authorizationDeclared!==['100','150'].includes(raw.protocolCStat)
    ||(ctx.kind==='response')!==(raw.cStat!==null)||ctx.kind==='request'&&(raw.protocolCStat!==null||raw.referenceDigestMatched)
    ||ctx.kind==='processed'&&(!raw.authorizationDeclared||!raw.referenceDigestMatched))fail('AUTHORIZATION_VALIDATOR_RESPONSE_INVALID');
  return Object.freeze({...raw,validatorHash:AUTHORIZATION_VALIDATOR_PROFILE.validatorHash,schemaManifestHash:AUTHORIZATION_VALIDATOR_PROFILE.manifestHash});
}
const bootstrap=`import sys,pathlib,hashlib\np=pathlib.Path(sys.argv[1]);b=p.read_bytes()\nif hashlib.sha256(b).hexdigest()!='${AUTHORIZATION_VALIDATOR_PROFILE.validatorHash}': raise RuntimeError('profile unavailable')\nexec(compile(b,str(p),'exec'),{'__name__':'__main__','__file__':str(p)})`;

export function createAuthorizationValidator(configuration){
  const c=data(configuration,['pythonPath','validatorPath','spawnImpl'],['pythonPath','validatorPath']);
  if(!['pythonPath','validatorPath'].every(k=>typeof c[k]==='string'&&isAbsolute(c[k])&&!/[\x00-\x1f\x7f]/.test(c[k]))||c.spawnImpl!==undefined&&typeof c.spawnImpl!=='function')fail('AUTHORIZATION_VALIDATOR_CONFIGURATION_INVALID');
  const execute=c.spawnImpl??spawn;
  return async function validate(input,options={}){
    const v=data(input,['request','xmlBytes','kind']),o=data(options,['signal','deadline'],[]),signal=o.signal;
    if(!['request','response','processed'].includes(v.kind)||signal!==undefined&&!(signal instanceof AbortSignal)||o.deadline!==undefined&&!Number.isSafeInteger(o.deadline))fail('AUTHORIZATION_VALIDATOR_INPUT_INVALID');
    // Test the local brand before reading handle metadata. A hash is not attestation.
    const probe=authorizationRequestBytes(v.request);probe.fill(0);
    const deadline=Math.min(o.deadline??Date.now()+10000,Date.now()+10000);check(signal,deadline);
    const bytes=copy(v.xmlBytes),ctx={kind:v.kind,model:v.request.model,hash:digest(bytes)};let payload;
    try{
      let xml;try{xml=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{fail('AUTHORIZATION_ENCODING_INVALID');}
      if(v.kind==='request'&&ctx.hash!==v.request.requestHash)fail('AUTHORIZATION_REQUEST_HASH_MISMATCH');
      payload=Buffer.from(JSON.stringify({xml,kind:v.kind,expectedModel:ctx.model,expectedAccessKey:v.request.accessKey,expectedReferenceDigest:v.request.referenceDigest,expectedBatchId:v.request.batchId}));xml=null;
      return await new Promise((resolve,reject)=>{
        let child,done=false,timer,total=0,stderr=0;const chunks=[];
        const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);chunks.forEach(x=>x.fill(0));chunks.length=0;};
        const stop=code=>{if(done)return;done=true;try{child?.kill('SIGKILL');}catch{}cleanup();reject(new FiscalAuthorizationError(code));};
        const onAbort=()=>stop('AUTHORIZATION_VALIDATOR_ABORTED');signal?.addEventListener('abort',onAbort,{once:true});timer=setTimeout(()=>stop('AUTHORIZATION_VALIDATOR_TIMEOUT'),Math.max(1,deadline-Date.now()));
        if(signal?.aborted){onAbort();return;}
        try{
          check(signal,deadline);child=execute(c.pythonPath,['-I','-B','-c',bootstrap,c.validatorPath],{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{LANG:'C.UTF-8',PATH:'/usr/bin:/bin'}});
          if(!child?.stdin||!child.stdout||!child.stderr||typeof child.kill!=='function'){stop('AUTHORIZATION_VALIDATOR_PROCESS_FAILED');return;}
          child.once('error',()=>stop('AUTHORIZATION_VALIDATOR_PROCESS_FAILED'));child.stdin.on('error',()=>stop('AUTHORIZATION_VALIDATOR_PROCESS_FAILED'));
          child.stdout.on('data',x=>{if(done)return;if(!(x instanceof Uint8Array)||(total+=x.length)>16384){stop('AUTHORIZATION_VALIDATOR_OUTPUT_LIMIT');return;}chunks.push(Buffer.from(x));});
          child.stderr.on('data',x=>{if(done)return;if(!(x instanceof Uint8Array)||(stderr+=x.length)>8192)stop('AUTHORIZATION_VALIDATOR_OUTPUT_LIMIT');});
          child.once('close',(exit,kill)=>{if(done)return;let raw;try{check(signal,deadline);if(kill||![0,2].includes(exit))fail('AUTHORIZATION_VALIDATOR_PROCESS_FAILED');raw=Buffer.concat(chunks);const value=project(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)),exit,ctx);done=true;cleanup();resolve(value);}catch(e){stop(e instanceof FiscalAuthorizationError?e.code:'AUTHORIZATION_VALIDATOR_RESPONSE_INVALID');}finally{raw?.fill(0);}});
          child.stdin.end(payload);
        }catch(e){stop(e instanceof FiscalAuthorizationError?e.code:'AUTHORIZATION_VALIDATOR_PROCESS_FAILED');}
      });
    }finally{bytes.fill(0);payload?.fill(0);}
  };
}
