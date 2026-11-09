import test from 'node:test';import assert from 'node:assert/strict';import {createHandler} from '../src/index.mjs';
import {handleFagooBoundary,handleFagoo,sha256} from '../src/fagoo.mjs';
const actor='10000000-0000-4000-8000-000000000001',device='10000000-0000-4000-8000-000000000002';
const env={SUPABASE_DEPLOYMENT:'self-hosted',SUPABASE_URL:'https://services.example.test',SUPABASE_SERVICE_ROLE_KEY:'synthetic',ALLOWED_ORIGINS:'https://erp.example.test'};
test('Fagoo routes enforce Auth, real MFA and context before reaching setup',async()=>{
 for(const [mfa,origin,status] of [[false,'https://erp.example.test',403],[true,'https://evil.example',403],[true,'https://erp.example.test',200]]){
  let read=false;
  const handler=createHandler({fetchImpl:async url=>{
   const path=new URL(url).pathname;
   if(path==='/auth/v1/user')return Response.json({id:actor});
   if(path.endsWith('/erp_access_gate_v2'))return Response.json({scope:'access_gate',user_id:actor,open:true,mfa_required:true,mfa_ok:mfa});
   if(path.endsWith('/fagoo_context'))return Response.json({user_id:actor,role:'admin',units:[]});
   if(path.endsWith('/fagoo_setup')){read=true;return Response.json({units:[],members:[],devices:[]});}
   throw new Error('unexpected');
  }});
  const response=await handler(new Request('https://api.example.test/v1/fagoo/setup',{headers:{Authorization:'Bearer token',Origin:origin}}),env);
  assert.equal(response.status,status);assert.equal(read,status===200);
 }
});
test('panel tokens cannot enter private modules or setup and are hashed before RPC',async()=>{
 const token='fgd_'+'a'.repeat(64),calls=[];
 const rpc=async(name,args)=>{calls.push([name,args]);return {id:device,mode:'panel',capabilities:['panel.read']};};
 const invoke=path=>handleFagooBoundary({request:new Request('https://api.test'+path,{headers:{Authorization:'FagooDevice '+token}}),settings:{origins:[]},env:{},authenticate:()=>assert.fail('not a user'),rpc,route:handleFagoo});
 assert.equal((await invoke('/v1/fagoo/setup')).status,403);
 assert.equal((await invoke('/v1/communication/units/x')).status,403);
 assert.equal(calls.length,0);
 assert.equal((await invoke('/v1/fagoo/device')).status,200);
 assert.deepEqual(calls,[['fagoo_device_auth',{p_token_hash:await sha256(token)}]]);
});

test('PostgREST PT409 business conflicts reach clients as 409 without retry or database details',async()=>{
 const unit='10000000-0000-4000-8000-000000000003',command='10000000-0000-4000-8000-000000000004';
 for(const [path,payload,rpc] of [
  ['/v1/fagoo/commands',{command_id:command,action:'unit.save',payload:{id:unit,name:'Stale',expected_version:0}},'fagoo_command'],
  [`/v1/crm/units/${unit}/commands`,{command_id:command,action:'opportunity.move',payload:{id:device,stage:'won',expected_version:0}},'fagoo_crm_command'],
  [`/v1/crm/units/${unit}/links`,{command_id:command,ticket_id:device,contact_id:actor,expected_version:0},'fagoo_relationship_link'],
 ]){
  let calls=0;
  const handler=createHandler({fetchImpl:async url=>{
   const target=new URL(url).pathname;
   if(target==='/auth/v1/user')return Response.json({id:actor});
   if(target.endsWith('/erp_access_gate_v2'))return Response.json({scope:'access_gate',user_id:actor,open:true,mfa_required:false,mfa_ok:true});
   if(target.endsWith('/fagoo_context'))return Response.json({user_id:actor,role:'admin',units:[]});
   if(target.endsWith('/'+rpc)){calls++;return Response.json({code:'PT409',message:'private_database_conflict',details:'private details',hint:null},{status:409});}
   assert.fail('Unexpected RPC');
  }});
  const response=await handler(new Request('https://api.example.test'+path,{method:'POST',headers:{Authorization:'Bearer synthetic',Origin:'https://erp.example.test','Content-Type':'application/json'},body:JSON.stringify(payload)}),env);
  assert.equal(response.status,409);assert.equal(calls,1);assert.deepEqual(await response.json(),{error:{code:'ERP_CONFLICT'}});
 }
});
