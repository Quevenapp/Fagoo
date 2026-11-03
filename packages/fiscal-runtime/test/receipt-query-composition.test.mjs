// Wiring probes only: synthetic SQL contexts and controlled ports. No DB, PFX or outbound request.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {request} from 'node:https';
import {createReceiptQueryComposition} from '../src/receipt-query.mjs';
import {createReceiptQueryService} from '../../fiscal-authorization/src/receipt-query-service.mjs';
import {RECEIPT_QUERY_LEDGER_FLAGS} from '../../fiscal-authorization/src/receipt-query-ledger-dto.mjs';

const fixtures=JSON.parse(await readFile(new URL('./fixtures/receipt-query-contexts.json',import.meta.url),'utf8'));
assert.equal(fixtures.synthetic,true);
const clone=structuredClone,uid=n=>`90000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const forbidden=async()=>{throw Error('UNEXPECTED_PORT_CALL');};
const config=()=>({projectUrl:'https://abcdefghijklmnopqrst.supabase.co',serviceKey:'synthetic-private-key-not-secret',fetchImpl:forbidden,keyring:new Map([['synthetic',Buffer.alloc(32,9)]]),binaryPath:'/synthetic/openssl'});
const sourceInput=c=>({actor:c.source.original_source.recovery.actor,sourceKind:c.source.source_kind,sourceCommandId:c.source.source_command_id,authorizationCommandId:c.source.authorization_command_id,authorizationAttemptId:c.source.authorization_attempt_id});
function harness(patch={}){
 const calls={},ports={rpc:forbidden,historical:{read:forbidden,putImmutable:forbidden},storage:{read:forbidden,putImmutable:forbidden},validateProcessed:forbidden,validate:forbidden,source:forbidden,loader:Object.freeze({withContext:forbidden}),vault:forbidden,preparation:forbidden,custody:forbidden,transport:forbidden};
 const capture=(name,value)=>x=>{calls[name]=x;return value;};
 const factories={rpc:capture('rpc',ports.rpc),authorizationStorage:capture('historical',ports.historical),queryStorage:capture('storage',ports.storage),authorizationValidator:capture('validateProcessed',ports.validateProcessed),source:capture('source',ports.source),receiptValidator:capture('validate',ports.validate),tlsLoader:async x=>{calls.loader=x;return ports.loader;},vaultReader:capture('vault',ports.vault),preparation:capture('preparation',ports.preparation),custody:capture('custody',ports.custody),transport:capture('transport',ports.transport),service:x=>{calls.service=x;return createReceiptQueryService(x);},...patch};
 return{calls,ports,factories};
}
test('089 wires separate historical/query storage, fixed validators, preparation, custody and receipt transport',async()=>{
 const h=harness(),p=config(),out=await createReceiptQueryComposition(p,h.factories),c=h.calls;
 assert.deepEqual(Object.keys(out),['service','enabled']);assert.equal(out.enabled,false);assert.ok(Object.isFrozen(out)&&Object.isFrozen(out.service));assert.deepEqual(Object.keys(out.service),['context','history','command','run','recover']);
 assert.strictEqual(c.source.readObject,h.ports.historical.read);assert.strictEqual(c.source.validate,h.ports.validateProcessed);assert.strictEqual(c.service.storage,h.ports.storage);assert.notStrictEqual(c.service.storage,h.ports.historical);
 assert.strictEqual(c.service.readSource,h.ports.source);assert.strictEqual(c.service.validate,h.ports.validate);assert.strictEqual(c.service.validateProcessed,h.ports.validateProcessed);
 assert.deepEqual(c.preparation,{rpc:h.ports.rpc});assert.strictEqual(c.custody.authorizePreparation,h.ports.preparation);assert.strictEqual(c.custody.readObject,h.ports.vault);assert.strictEqual(c.custody.loader,h.ports.loader);assert.strictEqual(c.service.withPreparedSession,h.ports.custody);assert.strictEqual(c.service.transport,h.ports.transport);
 assert.deepEqual(c.loader,{binaryPath:'/synthetic/openssl',allowLegacy:false,timeoutMs:5000});assert.strictEqual(c.transport.requestImpl,request);
 assert.equal(c.validateProcessed.pythonPath,'/opt/fiscal-validator/bin/python3');assert.equal(c.validate.pythonPath,c.validateProcessed.pythonPath);assert.match(c.validateProcessed.validatorPath,/\/fiscal-authorization\/validator\.py$/);assert.match(c.validate.validatorPath,/\/fiscal-authorization\/receipt-validator\.py$/);
 for(const k of['rpc','historical','storage','vault'])assert.deepEqual(c[k],{projectUrl:p.projectUrl,serviceKey:p.serviceKey,fetchImpl:p.fetchImpl});
 assert.throws(()=>out.service.run({}),e=>e.code==='AUTHORIZATION_SERVICE_DISABLED'&&e.recovery_required===false);
});
test('089 configuration/getters/unknown factory fields fail before any port or fallback',async()=>{
 let factories=0,getters=0;const overrides={rpc:()=>{factories++;throw Error('not reached');}};
 for(const patch of[{projectUrl:'https://other.invalid'},{projectUrl:config().projectUrl+'/'},{serviceKey:'short'},{fetchImpl:null},{keyring:new Map()},{keyring:new Map([['x',Buffer.alloc(31)]])},{keyring:new Map([['bad/key',Buffer.alloc(32)]])},{binaryPath:'relative/openssl'},{binaryPath:'/invalid\npath'},{enabled:'true'},{enabled:null},{allowLegacy:'false'},{arbitrary:true}])await assert.rejects(()=>createReceiptQueryComposition({...config(),...patch},overrides),/RECEIPT_QUERY_RUNTIME_CONFIGURATION_INVALID/);
 const p=config();Object.defineProperty(p,'serviceKey',{get(){getters++;return 'not-read';}});await assert.rejects(()=>createReceiptQueryComposition(p,overrides));
 const seam={};Object.defineProperty(seam,'rpc',{get(){getters++;return()=>{};}});await assert.rejects(()=>createReceiptQueryComposition(config(),seam));
 for(const seams of[{fetchImpl:forbidden},{rpc:null},{service:{}}])await assert.rejects(()=>createReceiptQueryComposition(config(),seams));
 assert.equal(getters,0);assert.equal(factories,0);
});
test('089 captures configuration, factory set and key membership before asynchronous trust setup',async()=>{
 let release;const waiting=new Promise(r=>release=r),h=harness({tlsLoader:()=>waiting}),p=config();p.enabled=true;p.allowLegacy=true;
 const originalKey=p.keyring.get('synthetic'),pending=createReceiptQueryComposition(p,h.factories);
 p.enabled=false;p.allowLegacy=false;p.binaryPath='/changed';p.keyring.clear();h.factories.custody=()=>{throw Error('LATE_FACTORY');};release(h.ports.loader);
 const result=await pending;assert.equal(result.enabled,true);assert.equal(h.calls.service.enabled,true);assert.strictEqual(h.calls.custody.keyring.get('synthetic'),originalKey);assert.equal(h.calls.custody.keyring.size,1);assert.notStrictEqual(h.calls.custody.keyring,p.keyring);
});
test('089 source adapter projects all four real synthetic SQL contexts and propagates exact options',async()=>{
 for(const raw of fixtures.contexts){
  const calls=[],h=harness({rpc:()=>async(...args)=>{calls.push(args);return clone(raw);}});await createReceiptQueryComposition(config(),h.factories);
  const input=sourceInput(raw),options={signal:new AbortController().signal,deadline:Date.now()+1000};
  const out=await h.calls.source.readSource(input,options);assert.deepEqual(out,raw.source);assert.ok(Object.isFrozen(out.original_source));assert.equal(calls.length,1);
  assert.deepEqual(calls[0].slice(0,2),['context',{p_user_id:input.actor,p_source_kind:input.sourceKind,p_source_command_id:input.sourceCommandId,p_expected_attempt_id:input.authorizationAttemptId}]);assert.strictEqual(calls[0][2],options);
 }
});
test('089 adapter binds authorization command as well as actor, source kind, source command and attempt',async()=>{
 const raw=fixtures.contexts[1],h=harness({rpc:()=>async()=>clone(raw)});await createReceiptQueryComposition(config(),h.factories);
 for(const patch of[{actor:uid(80)},{sourceKind:'authorization'},{sourceCommandId:uid(81)},{authorizationCommandId:uid(82)},{authorizationAttemptId:uid(83)}])await assert.rejects(()=>h.calls.source.readSource({...sourceInput(raw),...patch},{}));
 const falseView=clone(raw);falseView.can_query=true;const bad=harness({rpc:()=>async()=>falseView});await createReceiptQueryComposition(config(),bad.factories);await assert.rejects(()=>bad.calls.source.readSource(sourceInput(raw),{}));
});
test('089 source adapter captures input before its RPC awaits and never invokes input getters',async()=>{
 const raw=fixtures.contexts[0];let release,calls=0,getters=0;const waiting=new Promise(r=>release=r),h=harness({rpc:()=>async()=>{calls++;await waiting;return clone(raw);}});await createReceiptQueryComposition(config(),h.factories);
 const i=sourceInput(raw),pending=h.calls.source.readSource(i,{});i.authorizationCommandId=uid(90);i.actor=uid(91);release();assert.deepEqual(await pending,raw.source);
 const bad=sourceInput(raw);Object.defineProperty(bad,'actor',{get(){getters++;return uid(92);}});await assert.rejects(()=>h.calls.source.readSource(bad,{}));assert.equal(calls,1);assert.equal(getters,0);
});
test('089 source ACL denial has no fallback to another source, private object, grant or credential',async()=>{
 const denial=Object.assign(Error('42501'),{code:'42501'});let calls=0;const h=harness({rpc:()=>async()=>{calls++;throw denial;}});await createReceiptQueryComposition(config(),h.factories);
 await assert.rejects(()=>h.calls.source.readSource(sourceInput(fixtures.contexts[1]),{}),e=>e===denial);assert.equal(calls,1);
});
test('089 real service and RPC remain read-capable while disabled; no custody/transport or writes',async()=>{
 const c=fixtures.contexts[0],i=sourceInput(c),calls=[];let tls=0;
 const fetchImpl=async(url,o)=>{calls.push({url,o});const args=JSON.parse(o.body);
  if(url.endsWith('/erp_fiscal_receipt_query_history'))return Response.json({...RECEIPT_QUERY_LEDGER_FLAGS,read_only:true,authorization_command_id:i.authorizationCommandId,authorization_attempt_id:i.authorizationAttemptId,observed_at:c.observed_at,chain_hash:c.chain_hash,resolution:{state:'pending',query_ids:[],selected_query_id:null,protocol:null,resolution_hash:'b'.repeat(64)},items:[],next_before:null,limit:args.p_limit});
  assert.ok(url.endsWith('/erp_fiscal_receipt_query_command'));return Response.json({code:'P0002'},{status:400});
 };
 const {service,enabled}=await createReceiptQueryComposition({...config(),fetchImpl},{tlsLoader:async()=>Object.freeze({withContext:async()=>{tls++;throw Error('UNEXPECTED_TLS');}})});
 assert.equal(enabled,false);assert.equal(calls.length,0);assert.throws(()=>service.run({}),e=>e.code==='AUTHORIZATION_SERVICE_DISABLED');
 const result=await service.history({actor:i.actor,request:{authorization_command_id:i.authorizationCommandId,expected_attempt_id:i.authorizationAttemptId,limit:25,before:null}});assert.equal(result.can_query,false);assert.deepEqual(result.items,[]);
 await assert.rejects(()=>service.command({actor:i.actor,commandId:uid(95)}),e=>e.code==='P0002');
 await assert.rejects(()=>service.recover({actor:i.actor,commandId:uid(95),confirmed:true}),e=>e.code==='P0002');
 assert.equal(calls.length,3);assert.equal(tls,0);assert.ok(calls.every(x=>/\/erp_fiscal_receipt_query_(?:history|command)$/.test(x.url)));assert.ok(calls.every(x=>x.o.redirect==='manual'));
});
test('089 trust setup rejection stops composition without silently replacing trust or a service',async()=>{
 let touched=0;const h=harness({tlsLoader:async()=>{throw Error('RECEIPT_QUERY_SERVER_TRUST_INVALID');},custody:()=>{touched++;},transport:()=>{touched++;},service:()=>{touched++;}});
 await assert.rejects(()=>createReceiptQueryComposition(config(),h.factories),/RECEIPT_QUERY_SERVER_TRUST_INVALID/);assert.equal(touched,0);
});
test('089 factory seams cannot accidentally return a dispatch service or extra methods',async()=>{
 const h=harness({service:()=>({context:forbidden,history:forbidden,command:forbidden,run:forbidden,recover:forbidden,emit:forbidden})});await assert.rejects(()=>createReceiptQueryComposition(config(),h.factories),/RECEIPT_QUERY_RUNTIME_CONFIGURATION_INVALID/);
});
