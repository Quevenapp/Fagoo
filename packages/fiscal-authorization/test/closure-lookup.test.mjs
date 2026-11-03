import {createAuthorizationRuntimeHandler} from '../../fiscal-authorization-runtime/src/handler.mjs';
import {createAuthorizationGateway} from '../../fiscal-authorization-runtime/src/gateway.mjs';
import {secret,keyId,audience,external,env,service as legacyService} from '../../fiscal-authorization-runtime/test/fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {closureLookupFixture,LOOKUP} from './closure-lookup-fixture.mjs';
import {BEGIN,hash} from './expired-closure-fixture.mjs';
import {createAuthorizationClosureLookupRpc} from '../src/closure-lookup-rpc.mjs';
import {createAuthorizationClosureLookupService} from '../src/closure-lookup-service.mjs';
import {captureClosureLookupInput,projectClosureLookupPublic} from '../src/closure-lookup-dto.mjs';
const reject=(fn,code)=>assert.rejects(fn,e=>e.code===code);
const rows=(f,sql,args=[])=>f.db.query(sql,args).then(v=>v.rows);
const functions=f=>rows(f,"select p.oid,pg_get_functiondef(p.oid) definition,p.proacl from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.prokind='f'and(n.nspname~'^(erp|origin)_'or n.nspname='public'and p.proname~'^(erp|origin)_')order by p.oid");
const tables=f=>rows(f,"select n.nspname,c.relname,c.relrowsecurity,c.relacl from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r'and(n.nspname~'^(erp|origin)_'or n.nspname in('auth','storage'))order by n.nspname,c.relname");
async function state(f){
 const result={};for(const table of ['erp_fiscal_authorization.intent','erp_fiscal_authorization.command','erp_fiscal_authorization.attempt','erp_fiscal_authorization.request','erp_fiscal_authorization.result','erp_fiscal_authorization.audit','erp_fiscal_authorization.policy','erp_fiscal_reviewed_authorization.review_binding','erp_fiscal_reviewed_authorization.observation','erp_fiscal_subset_review.review','erp_fiscal_authorization_closure.command','erp_finance.title','erp_finance.movement','erp_stock.movement'])result[table]=(await rows(f,`select count(*)::int n,md5(coalesce(string_agg(to_jsonb(t)::text,''order by to_jsonb(t)::text),'')) hash from ${table} t`))[0];return result;
}
const input=x=>({actor:x.args.p_user_id,authorizationCommandId:x.args.p_authorization_command_id,expectedAttemptId:x.args.p_expected_attempt_id});
async function httpLookup(x,service){
 const forbidden=()=>{throw Error('NO_OTHER_OPERATION');},handler=createAuthorizationRuntimeHandler({service:legacyService(),dispatch:{service:{run:forbidden,recover:forbidden,command:forbidden,history:forbidden,...service},readAccess:forbidden,enabled:false},transportSecret:secret,transportKeyId:keyId,audience});
 try{const gateway=createAuthorizationGateway({fetchImpl:async()=>Response.json({id:x.args.p_user_id}),now:Date.now,nonce:randomUUID}),environment={...env(),FISCAL_AUTHORIZATION_REVIEWED_ENABLED:'false',A1_RUNTIME:{fetch:r=>handler(new Request('http://runtime.internal'+new URL(r.url).pathname,r))}};return await gateway(external(`/reviewed/commands/${x.args.p_authorization_command_id}/attempts/${x.args.p_expected_attempt_id}/closure`),environment);}finally{handler.dispose();}
}
const publicInput=x=>({authorization_command_id:x.args.p_authorization_command_id,expected_attempt_id:x.args.p_expected_attempt_id});
test('075 lookup discovers only an existing074 receipt through authenticated SQL/RPC without mutation',{timeout:60000},async t=>{
 let oldFunctions,oldTables,oldState;const f=await closureLookupFixture({beforeMigration:async f=>{oldFunctions=await functions(f);oldTables=await tables(f);oldState=await state(f);}}),calls=[];
 const lookupRpc=createAuthorizationClosureLookupRpc({projectUrl:'https://abcdefghijklmnopqrst.supabase.co',serviceKey:'synthetic-lookup-service-key-only',fetchImpl:async(url,o)=>{
  assert.equal(url,'https://abcdefghijklmnopqrst.supabase.co/rest/v1/rpc/'+LOOKUP);assert.equal(o.method,'POST');assert.equal(o.redirect,'manual');assert.ok(o.signal instanceof AbortSignal);const args=JSON.parse(o.body);calls.push(args);
  try{return Response.json(await f.callSql(LOOKUP,args));}catch(e){return Response.json({code:e.code,message:'PRIVATE_LOOKUP_DIAGNOSTIC'},{status:400});}
 }}),service=createAuthorizationClosureLookupService({lookupRpc});let historic;
 try{
  await t.test('adds one stable service-only RPC with no table/schema/old-function or data change',async()=>{
   const after=await functions(f);assert.deepEqual(after.filter(x=>oldFunctions.some(y=>y.oid===x.oid)),oldFunctions);assert.equal(after.length,oldFunctions.length+1);assert.deepEqual(await tables(f),oldTables);assert.deepEqual(await state(f),oldState);
   const [fn]=await rows(f,"select prosecdef,provolatile,proconfig,has_function_privilege('anon',oid,'execute') anon,has_function_privilege('authenticated',oid,'execute') authenticated,has_function_privilege('service_role',oid,'execute') service from pg_proc where proname=$1",[LOOKUP]);assert.deepEqual(fn,{prosecdef:true,provolatile:'s',proconfig:['search_path=pg_catalog'],anon:false,authenticated:false,service:true});
   assert.equal((await rows(f,"select count(*)::int n from pg_proc p cross join lateral aclexplode(p.proacl)a where p.proname=$1 and a.grantee<>p.proowner and a.is_grantable",[LOOKUP]))[0].n,0);
  });
  for(const model of ['55','65'])for(const prepared of [false,true])await t.test(model+' reload discovers lost closure UUID for '+(prepared?'request_ready':'prepared'),async()=>{
   const x=await f.start(model,{prepared});await f.age(x.b.args.p_command_id);const before=await state(f);await reject(()=>service.closureLookup(input(x),f.opts()),'P0002');assert.deepEqual(await state(f),before);
   const ack=await f.closeAttempt(x),closed=await state(f);calls.length=0;const value=await service.closureLookup(input(x),f.opts());assert.equal(value.command_id,ack.command_id);assert.equal(value.read_only,true);assert.equal(value.replayed,true);assert.equal(value.receipt.attempt_id,x.args.p_expected_attempt_id);assert.equal(Object.hasOwn(value.receipt,'request_hash'),false);assert.equal(value.can_transmit,false);assert.equal(value.tax_rules_validated,false);assert.deepEqual(projectClosureLookupPublic(value,publicInput(x)),value);
   assert.deepEqual(calls,[f.lookupArgs(x)]);const response=await httpLookup(x,service);assert.equal(response.status,200,await response.clone().text());assert.deepEqual(await response.json(),value);assert.deepEqual(calls,[f.lookupArgs(x),f.lookupArgs(x)]);assert.deepEqual(await state(f),closed);assert.deepEqual((await f.discover(x)).receipt,ack.receipt);historic=x;
  });
  await t.test('current role and original actor precede CAS/existence disclosure',async()=>{
   const x=historic,before=await state(f);await reject(()=>f.discover(x,{p_user_id:f.users.admin}),'42501');await reject(()=>f.discover(x,{p_user_id:f.users.admin,p_expected_attempt_id:randomUUID()}),'42501');
   for(const sql of["update erp_access.membership set role='consulta'where user_id=$1","update erp_access.membership set active=false where user_id=$1"]){await f.db.query(sql,[x.args.p_user_id]);try{await reject(()=>service.closureLookup(input(x),f.opts()),'42501');const forbidden=await httpLookup(x,service);assert.equal(forbidden.status,403);assert.equal((await forbidden.json()).recovery_required,false);}finally{await f.db.query("update erp_access.membership set active=true,role='fiscal'where user_id=$1",[x.args.p_user_id]);}}
   const [{data:identity}]=await rows(f,'select data from erp_company.identity where singleton');await f.db.query("update erp_company.identity set data=jsonb_set(data,'{cnpj}','\"11111111000191\"')where singleton");try{await reject(()=>service.closureLookup(input(x),f.opts()),'42501');}finally{await f.db.query('update erp_company.identity set data=$1 where singleton',[identity]);}
   await reject(()=>f.discover(x,{p_expected_attempt_id:randomUUID()}),'40001');await reject(()=>f.discover(x,{p_authorization_command_id:randomUUID()}),'P0002');for(const key of['p_authorization_command_id','p_expected_attempt_id'])await reject(()=>f.discover(x,{[key]:null}),'22023');assert.deepEqual(await state(f),before);
  });
  await t.test('ordinary failure, unused preparation and consumed attempt do not become closure receipts',async()=>{
   const x=await f.start();await f.wire('fail',{...f.ids(x.b),p_error_code:'PREPARATION_FAILED'});const used=await f.start('65',{prepared:true});await f.use(used.b,used.proof);const unused=await f.start('55',{prepared:true});await f.age(unused.b.args.p_command_id);const before=await state(f);
   for(const v of[x,used,unused])await reject(()=>service.closureLookup(input(v),f.opts()),'P0002');assert.deepEqual(await state(f),before);
  });
  await t.test('successor has separate CAS and cannot replace the original closure',async()=>{
   const x=historic,prior=await f.discover(x),successor=await f.rpc(BEGIN,{...x.b.args,p_command_id:randomUUID()},f.opts());await f.prepare({value:successor},x.proof);await f.use({value:successor},x.proof);const before=await state(f);
   const value=await service.closureLookup(input(x),f.opts()),{request_hash,...receipt}=prior.receipt;assert.deepEqual(value.receipt,receipt);assert.equal(value.current.successor_exists,true);assert.equal(value.current.intent_consumed,true);assert.equal(value.current.grant_consumed,false);
   await reject(()=>f.discover(x,{p_expected_attempt_id:successor.receipt.attempt_id}),'40001');await reject(()=>f.discover(x,{p_authorization_command_id:successor.command_id,p_expected_attempt_id:successor.receipt.attempt_id}),'P0002');assert.deepEqual(await state(f),before);
  });
  await t.test('legacy064 profile is refused without exposing a false074 absence',async()=>{
   const c=await f.candidate(),version=Number((await rows(f,'select max(version)+1 v from erp_fiscal_authorization.policy'))[0].v);await f.db.query("insert into erp_fiscal_authorization.policy(model,version,origin,enabled,binding_profile,rule_profile,binding_reviewed,tax_rules_reviewed,source_manifest_hash,valid_from,valid_until)values('55',$1,'synthetic',true,'synthetic-authorization-binding','synthetic-rules-only',false,false,$2,clock_timestamp()-interval'1day',clock_timestamp()+interval'1day')",[version,hash('lookup legacy fixture')]);
   const args={p_user_id:c.input.actor,p_command_id:randomUUID(),p_candidate_id:c.input.candidateId,p_signed_hash:c.input.signedHash,p_expected_identity_version:1,p_expected_a1_version:2,p_expected_policy_version:version,p_confirmed:true},b=await f.callSql('erp_fiscal_authorization_begin',args),before=await state(f);
   await reject(()=>f.callSql(LOOKUP,{p_user_id:c.input.actor,p_authorization_command_id:args.p_command_id,p_expected_attempt_id:b.receipt.attempt_id}),'22023');assert.deepEqual(await state(f),before);f.setPolicy(await f.enable());
  });
  await t.test('history remains readable after review/policy/A1/current basis change',async()=>{
   const x=historic,prior=await service.closureLookup(input(x),f.opts());await f.review(x.c,{p_command_id:randomUUID(),p_expected_review_version:1});await f.enable('operational',false);
   const current=await f.callSql('erp_a1_metadata',{p_user_id:f.users.admin}),cmd=randomUUID();await f.callSql('erp_a1_disable',{p_user_id:f.users.admin,p_command_id:cmd,p_request_hash:hash(cmd),p_expected_version:current.current.version,p_reason:'TESTE LOCAL SEM USO DO CERTIFICADO'});
   const [{draft_id}]=await rows(f,'select j.draft_id from erp_fiscal_unsigned.job j join erp_fiscal_signed.candidate c on c.unsigned_job_id=j.id where c.id=$1',[x.c.input.candidateId]);await f.callSql('erp_fiscal_draft_execute',{p_user_id:f.users.fiscal,p_command_id:randomUUID(),p_action:'archive',p_data:{id:draft_id,expected_version:1,reason:'TESTE LOCAL DE HISTORICO'}});
   const before=await state(f);assert.deepEqual(await service.closureLookup(input(x),f.opts()),prior);assert.deepEqual(await state(f),before);
  });
 }finally{await f.close();}
});
