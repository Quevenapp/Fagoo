import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createFiscalSchemaRunner,SCHEMA_RUNNER_PROFILE} from '../src/index.mjs';
const validatorPath=fileURLToPath(new URL('../../fiscal-schema/validator.py',import.meta.url));
const input=Buffer.from('<NFe>synthetic test only</NFe>'),hash=createHash('sha256').update(input).digest('hex');
const flags={signatureVerified:false,taxRulesValidated:false,icpBrasilChainValidated:false,revocationChecked:false,sefazAuthorized:false,canTransmit:false};
const success=()=>({ok:true,schemaProfile:'pl010f-v1.04',xmlDigest:hash,model:'55',environment:'2',xsdValidated:true,...flags});
function fixture(action){
 const calls=[],children=[];
 const spawnImpl=(program,args,options)=>{
  calls.push({program,args,options});const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.killed=false;child.input=[];
  child.stdin=new Writable({write(chunk,encoding,callback){child.input.push(Buffer.from(chunk));callback();},final(callback){callback();queueMicrotask(()=>action?.(child));}});
  child.kill=signal=>{child.killed=signal;queueMicrotask(()=>child.emit('close',null,signal));return true;};children.push(child);return child;
 };
 const run=createFiscalSchemaRunner({pythonPath:'/trusted/python',validatorPath,spawnImpl});return{run,calls,children};
}
const send=(child,value,code=0)=>{child.stdout.write(JSON.stringify(value));child.emit('close',code,null);};
const check={expectedModel:'55',expectedHash:hash};
test('pins validator and byte hash, uses isolated argv/env and preserves caller bytes',async()=>{
 const{run,calls,children}=fixture(child=>send(child,success()));const original=Buffer.from(input),r=await run(input,check);
 assert.equal(r.ok,true);assert.equal(r.xmlDigest,hash);assert.equal(r.schemaManifestHash,SCHEMA_RUNNER_PROFILE.manifestHash);assert.equal(r.validatorHash,SCHEMA_RUNNER_PROFILE.validatorHash);assert.equal(r.canEmit,false);assert.deepEqual(input,original);
 assert.equal(calls.length,1);assert.deepEqual(calls[0].args,['-I','-B',validatorPath,'--model','55']);assert.equal(calls[0].options.shell,false);assert.deepEqual(calls[0].options.env,{LANG:'C.UTF-8',PATH:'/usr/bin:/bin'});assert.deepEqual(Buffer.concat(children[0].input),input);
});
test('actual XSD rejection is a bounded negative report, not transport failure',async()=>{
 const{run}=fixture(child=>send(child,{ok:false,code:'XML_XSD_INVALID',diagnostics:[{line:3,column:0,domain:'SCHEMASV',type:'SCHEMAV_ELEMENT_CONTENT'}],canTransmit:false},2));const r=await run(input,check);
 assert.equal(r.ok,false);assert.equal(r.xsdValidated,false);assert.equal(r.xmlDigest,hash);assert.equal(r.signatureVerified,false);assert.equal(r.diagnostics.length,1);
});
test('wrong byte hash, model, type and configuration never spawn',async()=>{
 const{run,calls}=fixture();for(const options of [{...check,expectedHash:'a'.repeat(64)},{...check,expectedModel:'57'},{...check,deadline:0}])await assert.rejects(run(input,options),e=>e.code.startsWith('SCHEMA_RUNNER_'));
 await assert.rejects(run('xml',check));await assert.rejects(run(Buffer.alloc(512001),check));assert.equal(calls.length,0);
 assert.throws(()=>createFiscalSchemaRunner({pythonPath:'python3',validatorPath}));
});
test('validator source mismatch is infrastructure failure without spawning',async()=>{
 let called=false;const run=createFiscalSchemaRunner({pythonPath:'/trusted/python',validatorPath:fileURLToPath(import.meta.url),spawnImpl:()=>{called=true;}});
 await assert.rejects(run(input,check),{code:'SCHEMA_RUNNER_PROFILE_UNAVAILABLE'});assert.equal(called,false);
});
test('identity, trust flags, extra output and private diagnostics fail closed',async()=>{
 const cases=[{...success(),xmlDigest:'a'.repeat(64)},{...success(),model:'65'},{...success(),environment:'1'},{...success(),signatureVerified:true},{...success(),secret:'NEVER_FORWARD'},
 {ok:false,code:'XML_XSD_INVALID',diagnostics:[{line:1,column:0,domain:'SCHEMASV',type:'SCHEMAV_ELEMENT_CONTENT',message:'PRIVATE_XML'}],canTransmit:false}];
 for(const value of cases){const{run}=fixture(child=>send(child,value,value.ok?0:2));await assert.rejects(run(input,check),e=>e.code==='SCHEMA_RUNNER_RESPONSE_INVALID'&&!e.message.includes('PRIVATE'));}
});
test('schema deployment failures and process failures never label XML invalid',async()=>{
 const unavailable=fixture(child=>send(child,{ok:false,code:'SCHEMA_FILE_INTEGRITY_FAILED',diagnostics:[],canTransmit:false},2));await assert.rejects(unavailable.run(input,check),{code:'SCHEMA_RUNNER_PROFILE_UNAVAILABLE'});
 const failed=fixture(child=>{child.stderr.write('PRIVATE_STDERR');child.emit('close',1,null);});await assert.rejects(failed.run(input,check),e=>e.code==='SCHEMA_RUNNER_PROCESS_FAILED'&&!e.message.includes('PRIVATE'));
});
test('stdout/stderr bounds terminate the process without returning any content',async()=>{
 for(const channel of ['stdout','stderr']){const{run,children}=fixture(child=>child[channel].write(Buffer.alloc(channel==='stdout'?16385:8193,65)));await assert.rejects(run(input,check),{code:'SCHEMA_RUNNER_OUTPUT_LIMIT'});assert.equal(children[0].killed,'SIGKILL');}
});
test('absolute deadline terminates a stalled process and rejects late success',async()=>{
 const{run,children}=fixture();await assert.rejects(run(input,{...check,deadline:Date.now()+50}),{code:'SCHEMA_RUNNER_TIMEOUT'});assert.equal(children.length,1);assert.equal(children[0].killed,'SIGKILL');send(children[0],success());
});
test('abort before start does not spawn; abort in flight terminates with stable error',async()=>{
 const before=new AbortController();before.abort();const f=fixture();await assert.rejects(f.run(input,{...check,signal:before.signal}),{code:'SCHEMA_RUNNER_ABORTED'});assert.equal(f.calls.length,0);
 const controller=new AbortController(),during=fixture(()=>controller.abort());await assert.rejects(during.run(input,{...check,signal:controller.signal}),{code:'SCHEMA_RUNNER_ABORTED'});assert.equal(during.children[0].killed,'SIGKILL');
});
test('invalid JSON/UTF8 and mismatched exit status are not accepted',async()=>{
 for(const output of [Buffer.from('{'),Buffer.from([0xc3,0x28])]){const{run}=fixture(child=>{child.stdout.write(output);child.emit('close',0,null);});await assert.rejects(run(input,check),{code:'SCHEMA_RUNNER_RESPONSE_INVALID'});}
 const{run}=fixture(child=>send(child,success(),2));await assert.rejects(run(input,check),{code:'SCHEMA_RUNNER_RESPONSE_INVALID'});
});
