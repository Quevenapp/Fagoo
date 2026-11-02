import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {createPostgresFiscalExecutor,createLedgerPort} from '../ledger-port.mjs';
import {createFiscalArtifactPort} from '../storage-port.mjs';
import {createAuthorizationDispatchService,fiscalEngineCapabilities} from '../index.mjs';

test('PostgreSQL bridge binds company and actor and restricts callable functions',async()=>{
  const db=new PGlite(),pool={async connect(){return{query:(...args)=>db.query(...args),release(){}};}},companyId=randomUUID(),actorId=randomUUID();
  try{
    await db.exec("CREATE SCHEMA fagoo_fiscal;CREATE FUNCTION fagoo_fiscal.synthetic_context(value jsonb) RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('company_id',current_setting('fagoo.company_id'),'actor_id',current_setting('fagoo.actor_id'),'request',value) $$;");
    const execute=createPostgresFiscalExecutor({pool,companyId,actorId,operations:{context:'fagoo_fiscal.synthetic_context'}}),args={p_user_id:actorId,p_command_id:randomUUID()};
    const result=await execute('context',args,{deadline:Date.now()+5000});assert.equal(result.company_id,companyId);assert.equal(result.actor_id,actorId);assert.deepEqual(result.request,args);
    await assert.rejects(execute('drop',args,{deadline:Date.now()+5000}),/FISCAL_LEDGER_ACTION_INVALID/);
    await assert.rejects(execute('context',{...args,p_user_id:randomUUID()},{deadline:Date.now()+5000}),/42501/);
    assert.throws(()=>createPostgresFiscalExecutor({pool,companyId,actorId,operations:{context:'public.fn;drop schema fagoo'}}),/FISCAL_LEDGER_CONFIGURATION_INVALID/);
    assert.equal((await db.query("SELECT current_setting('fagoo.company_id',true) AS value")).rows[0].value,'');
  }finally{await db.close();}
});

test('ledger errors preserve definitive SQL denials and reject late results',async()=>{
  const failures=new WeakSet(),common={actions:['get'],capture:(_,args)=>structuredClone(args),project:(_,value)=>value,attestedFailures:failures};
  const denied=createLedgerPort({...common,execute:async()=>{throw Object.assign(new Error('private detail'),{code:'42501'});}});
  await assert.rejects(denied('get',{}),error=>error.code==='42501'&&failures.has(error)&&!error.message.includes('private'));
  const late=createLedgerPort({...common,execute:()=>new Promise(resolve=>setTimeout(()=>resolve({ok:true}),50))});
  await assert.rejects(late('get',{}, {deadline:Date.now()+5}),/AUTHORIZATION_SERVICE_TIMEOUT/);
});

test('artifact port prefixes company, verifies immutable readback and rejects credential paths',async()=>{
  const objects=new Map(),storage={async put(key,bytes){if(objects.has(key))assert.deepEqual(objects.get(key),bytes);else objects.set(key,Buffer.from(bytes));},async get(key){if(!objects.has(key))throw Object.assign(new Error('missing'),{code:'OBJECT_NOT_FOUND'});return Buffer.from(objects.get(key));}};
  const companyId=randomUUID(),port=createFiscalArtifactPort({storage,companyId}),bytes=Buffer.from('<synthetic/>'),sha256=createHash('sha256').update(bytes).digest('hex'),key=`authorization/${randomUUID()}/requests/${sha256}.xml`;
  assert.equal(await port.read({bucket:'fagoo-fiscal-artifacts',key}),null);
  await port.putImmutable({bucket:'fagoo-fiscal-artifacts',key,bytes,sha256,contentType:'application/octet-stream',upsert:false,ifNoneMatch:'*'});
  assert.equal([...objects.keys()][0],`companies/${companyId}/fiscal-engine/${key}`);assert.equal(await(await port.read({bucket:'fagoo-fiscal-artifacts',key})).text(),'<synthetic/>');
  await assert.rejects(port.read({bucket:'fagoo-a1-vault',key:'credentials/test'}),/FISCAL_ARTIFACT_KEY_INVALID/);
  await assert.rejects(port.read({bucket:'fagoo-fiscal-artifacts',key:'../outside'}),/FISCAL_ARTIFACT_KEY_INVALID/);
  assert.equal(bytes.toString(),'<synthetic/>');
});

test('copied dispatch composition stays closed before every injected side effect',()=>{
  let calls=0;const effect=()=>{calls++;throw Error('must remain closed');};
  const service=createAuthorizationDispatchService({rpc:effect,storage:{read:effect,putImmutable:effect},validate:effect,readReview:effect,withPreparedSession:effect,transport:effect});
  assert.throws(()=>service.run({}),/AUTHORIZATION_SERVICE_DISABLED/);assert.equal(calls,0);assert.equal(fiscalEngineCapabilities.dispatch_enabled,false);assert.equal(fiscalEngineCapabilities.production_authorized,false);
});
