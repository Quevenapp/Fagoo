import test from'node:test';import assert from'node:assert/strict';
import{a1Company,a1Metadata,a1Command,configureBytes,wipeAttempt}from'../src/lib/a1-model.ts';
import{parseConfigure}from'../../../packages/fiscal-runtime/src/protocol.mjs';
import{id,company,empty,configured,disabled,envelope,committed}from'./helpers/a1-fixtures.mjs';
const attempt=()=>({id,action:'configure',expectedVersion:0,expectedIdentityVersion:2,holder:company.record.data.cnpj,body:null,state:'unknown',errorCode:null,retryAt:0});
test('A1 public model preserves historical receipt separately from current and binds identity, action and CAS',()=>{
 const result=a1Command(committed(id,disabled),attempt(),true);assert.equal(result.current.state,'disabled');assert.equal(result.receipt.state,'configured_offline');
 for(const mutate of [v=>v.receipt.command_id='b0000000-0000-4000-8000-000000000001',v=>v.receipt.version=2,v=>v.receipt.company_identity_version=3,v=>v.receipt.metadata.holder_cnpj='99888777000100',v=>v.can_emit=true,v=>v.receipt.action='rewrap']){const value=structuredClone(committed(id,disabled));mutate(value);assert.throws(()=>a1Command(value,attempt(),true),/A1_RESPONSE_INVALID/);}
 assert.throws(()=>a1Command({...envelope(empty),state:'pending'},attempt(),true));
 assert.deepEqual(a1Metadata({...envelope(configured),key_id:'hidden',path:'secret/path'}),configured);
 assert.throws(()=>a1Metadata({...envelope(configured),current:{...configured,private_key:'forbidden'}}));
});
test('A1 identity projection rejects absent or malformed identity and strips unrelated data',()=>{
 assert.deepEqual(a1Company(company),{version:2,cnpj:'12ABC34501DE35',legal_name:'EMPRESA SINTETICA A1'});
 assert.equal(a1Company({...company,record:null}),null);
 for(const value of [{...company,record:undefined},{...company,section:'fiscal'},{...company,emission_enabled:true},{...company,record:{...company.record,data:{...company.record.data,cnpj:['12ABC34501DE35']}}}])assert.throws(()=>a1Company(value));
});
test('A1 binary handoff uses exact UTF-8 bytes, forbids invalid passwords and wipes retained command bytes',()=>{
 const pfx=new Uint8Array([1,2,3]),body=configureBytes({id,current:empty,company:a1Company(company),why:' Conferência sintética ',pfx,password:'senha sintética €'}),decoded=parseConfigure(body);
 assert.equal(decoded.command_id,id);assert.equal(decoded.expected_identity_version,2);assert.equal(decoded.reason,'Conferência sintética');assert.deepEqual([...decoded.pfxBytes],[1,2,3]);assert.equal(new TextDecoder().decode(decoded.passwordBytes),'senha sintética €');
 const value={...attempt(),body};wipeAttempt(value);assert.equal(value.body,null);assert.ok(body.every(v=>v===0));assert.deepEqual([...pfx],[1,2,3]);
 for(const password of ['','\u0000','line\nbreak','€'.repeat(342)])assert.throws(()=>configureBytes({id,current:empty,company:a1Company(company),why:'Motivo sintético',pfx,password}));
});
