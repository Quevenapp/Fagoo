import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createWsdlQaFixture} from '../src/qa/wsdl-fixture.ts';
import {createWsdlClient} from '../src/lib/wsdl-client.ts';
import {a1Metadata,a1Company} from '../src/lib/a1-model.ts';
import {wsdlRun,WSDL_BASE} from '../src/lib/wsdl-model.ts';
const state={phase:'ready',membership:{user_id:'e0000000-0000-4000-8000-000000000001',role:'admin'}};
async function setup(){
 const fixture=createWsdlQaFixture(),a1=a1Metadata(await fixture.a1('/v1/a1')),company=a1Company(await fixture.company('/v1/empresa/identidade'));
 const client=createWsdlClient({origin:'https://unsigned.qa.invalid',getSnapshot:()=>state,getEpoch:()=>1,getToken:()=> 'SYNTHETIC_QA_TOKEN',fetchImpl:fixture.fetch});
 return{fixture,client,body:model=>wsdlRun(model,'protocol',a1,company,true,randomUUID())};
}
test('DEV WSDL55 fixture commits once, loses POST and first GET, then recovers through the real client',async()=>{
 const{fixture,client,body}=await setup(),p=body('55');
 await assert.rejects(client(WSDL_BASE+'/run',{method:'POST',body:p}),e=>e.status===503&&e.recovery_required);
 await assert.rejects(client(WSDL_BASE+'/commands/'+p.command_id),e=>e.status===503&&!e.recovery_required);
 const value=await client(WSDL_BASE+'/commands/'+p.command_id);assert.equal(value.status,'stored');assert.equal(value.read_only,true);assert.equal(value.receipt.model,'55');assert.equal(value.can_emit,false);
 assert.deepEqual(fixture.getSnapshot().nf55,{post:1,get:2,records:1});assert.deepEqual(fixture.getSnapshot().nf65,{post:0,get:0,records:0});
});
test('DEV WSDL65 fixture returns normal ACK plus current GET, with one distinct record and reactive counters',async()=>{
 const{fixture,client,body}=await setup(),p=body('65'),seen=[];const stop=fixture.subscribe(()=>seen.push(fixture.getSnapshot()));
 const ack=await client(WSDL_BASE+'/run',{method:'POST',body:p}),current=await client(WSDL_BASE+'/commands/'+p.command_id);stop();assert.equal(ack.status,'stored');assert.equal(ack.read_only,false);assert.deepEqual(current.artifact,ack.artifact);assert.equal(current.receipt.model,'65');assert.deepEqual(fixture.getSnapshot().nf65,{post:1,get:1,records:1});assert.equal(seen.length,3);assert.ok(Object.isFrozen(fixture.getSnapshot().nf65));
});
test('DEV transport is fixed to its synthetic origin and metadata ports have no write operations',async()=>{
 const{fixture,client,body}=await setup(),p=body('65');
 const denied=await fixture.fetch('https://production.invalid'+WSDL_BASE+'/run',{method:'POST',body:JSON.stringify(p)});assert.equal(denied.status,404);assert.deepEqual(fixture.getSnapshot().nf65,{post:0,get:0,records:0});
 await assert.rejects(fixture.a1('/v1/a1/configure',{method:'POST',body:new Uint8Array([1])}),/READ_ONLY/);await assert.rejects(fixture.company('/v1/empresa/identidade',{method:'POST',body:{}}),/READ_ONLY/);
 await client(WSDL_BASE+'/run',{method:'POST',body:p});await client(WSDL_BASE+'/run',{method:'POST',body:p});assert.deepEqual(fixture.getSnapshot().nf65,{post:2,get:0,records:1});
});
