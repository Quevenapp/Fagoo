import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';

export const SCHEMA_RUNNER_PROFILE=Object.freeze({version:'fiscal-schema-runner-v1',schemaProfile:'pl010f-v1.04',manifestHash:'6099e1ce8a90a079609f986ab0b9783744d2fbb10151fab0b5e7a3549c82d9a0',validatorHash:'1da9dba6f75bca015fd7bd114a9fa030e57bb11d46a8f4b248cc3214dcbc53c6'});
const HASH=/^[a-f0-9]{64}$/,MAX_XML=512000,MAX_STDOUT=16384,MAX_STDERR=8192;
const FALSE_FLAGS=['signatureVerified','taxRulesValidated','icpBrasilChainValidated','revocationChecked','sefazAuthorized','canTransmit'];
const XML_CODES=new Set(['XML_SIZE_OR_TYPE_INVALID','XML_ENCODING_INVALID','XML_DECLARATION_UNSUPPORTED','XML_MALFORMED','XML_NFE_ROOT_INVALID','XML_TREE_LIMIT','XML_EXPECTED_MODEL_MISMATCH','XML_HOMOLOGATION_REQUIRED','XML_XSD_INVALID']);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const exact=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
export class FiscalSchemaRunnerError extends Error{constructor(code){super(code);this.name='FiscalSchemaRunnerError';this.code=code;}}
const fail=code=>{throw new FiscalSchemaRunnerError(code);};
const path=value=>typeof value==='string'&&isAbsolute(value)&&!/[\x00-\x1f\x7f]/.test(value);
function optionsCheck(signal,deadline){if(signal!==undefined&&!(signal instanceof AbortSignal)||!Number.isSafeInteger(deadline))fail('SCHEMA_RUNNER_OPTIONS_INVALID');if(signal?.aborted)fail('SCHEMA_RUNNER_ABORTED');if(deadline<=Date.now())fail('SCHEMA_RUNNER_TIMEOUT');}
function diagnostic(value){
 if(!exact(value,['line','column','domain','type'])||!['line','column'].every(key=>Number.isInteger(value[key])&&value[key]>=0&&value[key]<=MAX_XML)||!['domain','type'].every(key=>typeof value[key]==='string'&&/^[A-Z][A-Z0-9_]{0,95}$/.test(value[key])))fail('SCHEMA_RUNNER_RESPONSE_INVALID');
 return Object.freeze({...value});
}
function report(raw,code,expectedModel,xmlHash,sizeBytes){
 if(raw?.ok===true){
  if(code!==0||!exact(raw,['ok','schemaProfile','xmlDigest','model','environment','xsdValidated',...FALSE_FLAGS])||raw.schemaProfile!==SCHEMA_RUNNER_PROFILE.schemaProfile||raw.xmlDigest!==xmlHash||raw.model!==expectedModel||raw.environment!=='2'||raw.xsdValidated!==true||FALSE_FLAGS.some(key=>raw[key]!==false))fail('SCHEMA_RUNNER_RESPONSE_INVALID');
  return Object.freeze({...raw,validatorVersion:SCHEMA_RUNNER_PROFILE.version,validatorHash:SCHEMA_RUNNER_PROFILE.validatorHash,schemaManifestHash:SCHEMA_RUNNER_PROFILE.manifestHash,sizeBytes,canEmit:false});
 }
 if(code!==2||!exact(raw,['ok','code','diagnostics','canTransmit'])||raw.ok!==false||raw.canTransmit!==false||typeof raw.code!=='string'||!Array.isArray(raw.diagnostics)||raw.diagnostics.length>20)fail('SCHEMA_RUNNER_RESPONSE_INVALID');
 if(!XML_CODES.has(raw.code))fail('SCHEMA_RUNNER_PROFILE_UNAVAILABLE');
 if(raw.code!=='XML_XSD_INVALID'&&raw.diagnostics.length)fail('SCHEMA_RUNNER_RESPONSE_INVALID');
 return Object.freeze({ok:false,code:raw.code,diagnostics:Object.freeze(raw.diagnostics.map(diagnostic)),xmlDigest:xmlHash,model:expectedModel,environment:'2',sizeBytes,schemaProfile:SCHEMA_RUNNER_PROFILE.schemaProfile,validatorVersion:SCHEMA_RUNNER_PROFILE.version,validatorHash:SCHEMA_RUNNER_PROFILE.validatorHash,schemaManifestHash:SCHEMA_RUNNER_PROFILE.manifestHash,xsdValidated:false,canEmit:false,...Object.fromEntries(FALSE_FLAGS.map(key=>[key,false]))});
}

/** Private Node-only port; fixed validator, no HTTP, certificate, environment secrets or automatic retry. */
export function createFiscalSchemaRunner({pythonPath,validatorPath,spawnImpl=spawn}={}){
 if(!path(pythonPath)||!path(validatorPath)||typeof spawnImpl!=='function')fail('SCHEMA_RUNNER_CONFIGURATION_INVALID');
 return async function validate(xmlBytes,{expectedModel,expectedHash,signal,deadline=Date.now()+10000}={}){
  if(!(xmlBytes instanceof Uint8Array)||xmlBytes.byteLength<1||xmlBytes.byteLength>MAX_XML||!['55','65'].includes(expectedModel)||typeof expectedHash!=='string'||!HASH.test(expectedHash))fail('SCHEMA_RUNNER_INPUT_INVALID');
  optionsCheck(signal,deadline);deadline=Math.min(deadline,Date.now()+10000);const input=Buffer.from(xmlBytes),xmlHash=digest(input),sizeBytes=input.length;
  try{
   if(xmlHash!==expectedHash)fail('SCHEMA_RUNNER_HASH_MISMATCH');
   let source;const sourceStop=new AbortController(),sourceTimer=setTimeout(()=>sourceStop.abort(),Math.max(1,deadline-Date.now()));
   try{source=await readFile(validatorPath,{signal:signal?AbortSignal.any([signal,sourceStop.signal]):sourceStop.signal});}
   catch{optionsCheck(signal,deadline);if(sourceStop.signal.aborted)fail('SCHEMA_RUNNER_TIMEOUT');fail('SCHEMA_RUNNER_PROFILE_UNAVAILABLE');}
   finally{clearTimeout(sourceTimer);}
   try{if(digest(source)!==SCHEMA_RUNNER_PROFILE.validatorHash)fail('SCHEMA_RUNNER_PROFILE_UNAVAILABLE');}finally{source.fill(0);}
   optionsCheck(signal,deadline);
   return await new Promise((resolve,reject)=>{
    let child,settled=false,stdoutSize=0,stderrSize=0,timer;const chunks=[];
    const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);chunks.forEach(chunk=>chunk.fill(0));chunks.length=0;};
    const stop=error=>{if(settled)return;settled=true;try{child?.kill('SIGKILL');}catch{/* Child already closed. */}cleanup();reject(error);};
    const onAbort=()=>stop(new FiscalSchemaRunnerError('SCHEMA_RUNNER_ABORTED'));
    const invalid=()=>stop(new FiscalSchemaRunnerError('SCHEMA_RUNNER_PROCESS_FAILED'));
    signal?.addEventListener('abort',onAbort,{once:true});
    timer=setTimeout(()=>stop(new FiscalSchemaRunnerError('SCHEMA_RUNNER_TIMEOUT')),Math.min(10000,Math.max(1,deadline-Date.now())));
    if(signal?.aborted){onAbort();return;}
    try{
     // -I ignores PYTHONPATH/site customization; no parent environment or credentials are inherited.
     child=spawnImpl(pythonPath,['-I','-B',validatorPath,'--model',expectedModel],{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{LANG:'C.UTF-8',PATH:'/usr/bin:/bin'}});
     if(!child?.stdin||!child.stdout||!child.stderr||typeof child.kill!=='function'){invalid();return;}
     child.once('error',invalid);child.stdin.on('error',invalid);
     child.stdout.on('data',data=>{if(settled)return;if(!(data instanceof Uint8Array)||(stdoutSize+=data.byteLength)>MAX_STDOUT){stop(new FiscalSchemaRunnerError('SCHEMA_RUNNER_OUTPUT_LIMIT'));return;}chunks.push(Buffer.from(data));});
     child.stderr.on('data',data=>{if(settled)return;if(!(data instanceof Uint8Array)||(stderrSize+=data.byteLength)>MAX_STDERR)stop(new FiscalSchemaRunnerError('SCHEMA_RUNNER_OUTPUT_LIMIT'));});
     child.once('close',(code,processSignal)=>{
      if(settled)return;
      try{
       optionsCheck(signal,deadline);if(processSignal||![0,2].includes(code))fail('SCHEMA_RUNNER_PROCESS_FAILED');
       let raw,bytes=Buffer.concat(chunks);try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('SCHEMA_RUNNER_RESPONSE_INVALID');}finally{bytes.fill(0);}
       const result=report(raw,code,expectedModel,xmlHash,sizeBytes);settled=true;cleanup();resolve(result);
      }catch(error){stop(error instanceof FiscalSchemaRunnerError?error:new FiscalSchemaRunnerError('SCHEMA_RUNNER_RESPONSE_INVALID'));}
     });
     child.stdin.end(input);
    }catch{invalid();}
   });
  }finally{input.fill(0);}
 };
}
