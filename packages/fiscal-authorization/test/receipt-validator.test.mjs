import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {fileURLToPath} from 'node:url';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {spawnSync} from 'node:child_process';
import {readFile,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {receiptRequestBytes,receiptValidationContext} from '../src/receipt-core.mjs';
import {createReceiptValidator,RECEIPT_VALIDATOR_PROFILE} from '../src/receipt-validator.mjs';
import {receiptFixture,receiptResponse,hash} from './receipt-fixtures.mjs';
const pythonPath=process.env.BRUFAP_TEST_PYTHON??'/Users/bruno/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3';
const validatorPath=fileURLToPath(new URL('../receipt-validator.py',import.meta.url));
let f;before(async()=>{f=await receiptFixture();});after(()=>f?.close());
const validate=createReceiptValidator({pythonPath,validatorPath});
const response=q=>receiptResponse({...q,...receiptValidationContext(q)});
const rejects=(work,code)=>assert.rejects(work,e=>e.code===code);
function fakeSpawn(behavior){return()=>{const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.killed=0;child.kill=()=>{child.killed++;};const chunks=[];child.stdin.on('data',x=>chunks.push(Buffer.from(x)));child.stdin.on('finish',()=>behavior(child,Buffer.concat(chunks)));return child;};}
test('real lxml validates consReciNFe and retConsReciNFe55/65 against unchanged official types',async()=>{
 for(const model of ['55','65']){const q=await f.create(model).query();for(const[kind,xmlBytes]of [['request',receiptRequestBytes(q)],['response',response(q)]]){const r=await validate({request:q,kind,xmlBytes});assert.equal(r.ok,true);assert.equal(r.model,model);assert.equal(r.xsdValidated,true);assert.equal(r.contextMatched,true);assert.equal(r.xmlDigest,hash(xmlBytes));assert.equal(r.schemaManifestHash,RECEIPT_VALIDATOR_PROFILE.manifestHash);for(const k of ['canQuery','canEmit','canTransmit','signatureVerified','tlsOriginVerified','sefazAuthorized','retrySubmissionAllowed'])assert.equal(r[k],false);}}
});
test('real XSD accepts105/106/217 with no protocol and never promotes origin or retries',async()=>{
 const q=await f.create().query();for(const batch of ['105','106','217']){const xmlBytes=receiptResponse({...q,...receiptValidationContext(q)},{batch});const r=await validate({request:q,kind:'response',xmlBytes});assert.equal(r.ok,true);assert.equal(r.cStat,batch);assert.equal(r.protocolCStat,null);assert.equal(r.authorizationDeclared,false);}
});
test('real XSD rejects schema-order defect while contextual parser alone does not claim XSD',async()=>{
 const q=await f.create().query(),xml=response(q).toString().replace('<tpAmb>2</tpAmb><verAplic>SINTETICO</verAplic>','<verAplic>SINTETICO</verAplic><tpAmb>2</tpAmb>');const r=await validate({request:q,kind:'response',xmlBytes:Buffer.from(xml)});assert.equal(r.ok,false);assert.equal(r.code,'RECEIPT_XSD_INVALID');
});
test('Python standalone also binds receipt/candidate and rejects a schema-valid multi-note batch',async()=>{
 const q=await f.create().query(),context=receiptValidationContext(q),xml=response(q).toString(),protocol=xml.match(/<protNFe[\s\S]+<\/protNFe>/)[0];
 for(const changed of [xml.replace('<nRec>'+q.receiptNumber,'<nRec>350000000000002'),xml.replace(context.accessKey,'9'.repeat(44)),xml.replace('</retConsReciNFe>',protocol+'</retConsReciNFe>')]){const r=spawnSync(pythonPath,['-I','-B',validatorPath],{input:JSON.stringify({xml:changed,kind:'response',...context}),encoding:'utf8',timeout:10000,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}});assert.equal(r.status,2);const result=JSON.parse(r.stdout);assert.equal(result.ok,false);assert.equal(result.canTransmit,false);}
});
test('source/validator pins are exact and changed Python cannot run through the port',async()=>{
 assert.equal(hash(await readFile(validatorPath)),RECEIPT_VALIDATOR_PROFILE.validatorHash);const manifest=fileURLToPath(new URL('../receipt-schema/manifest.json',import.meta.url));assert.equal(hash(await readFile(manifest)),RECEIPT_VALIDATOR_PROFILE.manifestHash);
 const dir=await mkdtemp(join(tmpdir(),'brufap-receipt-validator-'));try{const path=join(dir,'changed.py');await writeFile(path,(await readFile(validatorPath)).toString()+'\n# modified\n');const q=await f.create().query();await rejects(()=>createReceiptValidator({pythonPath,validatorPath:path})({request:q,kind:'request',xmlBytes:receiptRequestBytes(q)}),'RECEIPT_VALIDATOR_PROCESS_FAILED');}finally{await rm(dir,{recursive:true,force:true});}
});
test('capture before await protects bytes/options; late output after abort cannot succeed',async()=>{
 const q=await f.create().query(),bytes=receiptRequestBytes(q),options={signal:new AbortController().signal};let observed,child;
 const spawnImpl=fakeSpawn((c,body)=>{child=c;observed=JSON.parse(body);});const v=createReceiptValidator({pythonPath,validatorPath,spawnImpl}),controller=new AbortController();options.signal=controller.signal;const p=v({request:q,xmlBytes:bytes,kind:'request'},options);bytes.fill(0);options.signal=new AbortController().signal;await new Promise(r=>setImmediate(r));assert.equal(observed.xml,receiptRequestBytes(q).toString());controller.abort();await rejects(()=>p,'RECEIPT_VALIDATOR_ABORTED');assert.equal(child.killed,1);child.stdout.write('{}');child.emit('close',0,null);
});
test('timeout/output bounds/forged subprocess report are closed errors',async()=>{
 const q=await f.create().query(),input={request:q,kind:'request',xmlBytes:receiptRequestBytes(q)};
 for(const[behavior,code]of [[()=>{},'RECEIPT_VALIDATOR_TIMEOUT'],[(c)=>c.stdout.write(Buffer.alloc(16385)),'RECEIPT_VALIDATOR_OUTPUT_LIMIT'],[(c)=>{c.stdout.write('{"ok":true}');c.emit('close',0,null);},'RECEIPT_VALIDATOR_RESPONSE_INVALID']])await rejects(()=>createReceiptValidator({pythonPath,validatorPath,spawnImpl:fakeSpawn(behavior)})(input,{deadline:Date.now()+40}),code);
});
test('no clone, free XML request, shared buffer or input accessor can start Python',async()=>{
 const q=await f.create().query();let calls=0;const v=createReceiptValidator({pythonPath,validatorPath,spawnImpl:()=>{calls++;throw Error();}}),input={request:q,kind:'request',xmlBytes:receiptRequestBytes(q)};
 await rejects(()=>v({...input,request:{...q}}),'RECEIPT_QUERY_UNATTESTED');await rejects(()=>v({...input,xmlBytes:Buffer.from('<consReciNFe/>')}),'RECEIPT_REQUEST_HASH_MISMATCH');await rejects(()=>v({...input,xmlBytes:new Uint8Array(new SharedArrayBuffer(100))}),'RECEIPT_BYTES_INVALID');await rejects(()=>v({get request(){throw Error();},kind:'request',xmlBytes:input.xmlBytes}),'RECEIPT_VALIDATOR_INPUT_INVALID');assert.equal(calls,0);
});
