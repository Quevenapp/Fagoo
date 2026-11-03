import test from 'node:test';import assert from 'node:assert/strict';
import {route,parsePayload} from '../src/processed-protocol.mjs';
import {FLAGS,processedMetadata,publicProcessedResult,downloadFilename} from '../src/processed-dto.mjs';
import {signRuntimeRequest,verifyRuntimeRequest,digest} from '../src/processed-auth.mjs';
const id='30000000-0000-4000-8000-000000000089',original='30000000-0000-4000-8000-000000000001';
const source={source_kind:'receipt_query',source_command_id:id,authorization_command_id:original,attempt_id:original,candidate_id:'20000000-0000-4000-8000-000000000001',candidate_version:1,signed_hash:'1'.repeat(64),signed_size:100,model:'55',environment:'2',processed_hash:'2'.repeat(64),processed_size:100,protocol:{cstat:'100',number:'13526000000000001',received_at:'2026-10-16T12:01:00.000Z'},resolution_hash:'3'.repeat(64)};
test('only two new GET routes accept089; all four legacy routes retain their exact descriptors',()=>{
 for(const [path,kind]of[['authorizations','authorization'],['revalidations','revalidation'],['receipt-queries','receipt_query']])for(const action of['xml','print']){
  const url=`/internal/v1/fiscal-danfe/${path}/${id}/${action}`,selected=route(url,'GET');assert.deepEqual(selected,{action,sourceKind:kind,commandId:id,path:url,method:'GET',limit:0,responseLimit:action==='xml'?1048576:8388608});assert.deepEqual(parsePayload(new Uint8Array(),selected),{});assert.throws(()=>route(url,'POST'));assert.throws(()=>parsePayload(new Uint8Array([1]),selected));
 }
 for(const suffix of['/xml/','/run','/xml?actor=1','/xml#x','/recover','/print/other'])assert.throws(()=>route(`/internal/v1/fiscal-danfe/receipt-queries/${id}${suffix}`,'GET'));
});
test('resolution hash is mandatory only for089 and is never silently added to legacy envelopes',()=>{
 assert.deepEqual(processedMetadata(source),source);
 const {resolution_hash,...noResolution}=source;assert.throws(()=>processedMetadata(noResolution));assert.throws(()=>processedMetadata({...source,resolution_hash:null}));assert.throws(()=>processedMetadata({...source,source_kind:'authorization',source_command_id:original}));assert.throws(()=>processedMetadata({...source,source_kind:'revalidation'}));
 for(const kind of['authorization','revalidation']){const legacy={...noResolution,source_kind:kind,source_command_id:kind==='authorization'?original:id};assert.deepEqual(processedMetadata(legacy),legacy);assert.equal(Object.hasOwn(processedMetadata(legacy),'resolution_hash'),false);}
 let read=0;const fake={...source};Object.defineProperty(fake,'source_kind',{enumerable:true,get(){read++;return'receipt_query';}});assert.throws(()=>processedMetadata(fake));assert.equal(read,0);
});
test('089HMAC authenticates query UUID/action and cannot become an authorization artifact route',async()=>{
 const secretBytes=new Uint8Array(32).fill(4),keyId='synthetic',audience='synthetic-danfe',actor='10000000-0000-4000-8000-000000000001',path=`/internal/v1/fiscal-danfe/receipt-queries/${id}/xml`,now=Date.now(),bodyHash=await digest(new Uint8Array()),header=await signRuntimeRequest({secretBytes,keyId,audience,actor,nonce:id,method:'GET',path,bodyHash,now});
 assert.equal((await verifyRuntimeRequest({header,secretBytes,keyId,audience,method:'GET',path,now})).actor,actor);
 for(const changed of[path.replace('receipt-queries','revalidations'),path.replace('/xml','/print'),path.replace(id,original)])await assert.rejects(verifyRuntimeRequest({header,secretBytes,keyId,audience,method:'GET',path:changed,now}));
});
test('089 XML projection preserves resolution receipt and immutable copied metadata across hash await',async()=>{
 const bytes=new TextEncoder().encode('<nfeProc/>'),s={...source,processed_hash:await digest(bytes),processed_size:bytes.length},raw={...FLAGS,action:'xml',source:s,xml_base64:Buffer.from(bytes).toString('base64'),filename:downloadFilename(s)},binding={sourceKind:'receipt_query',commandId:id,action:'xml'};
 const pending=publicProcessedResult(raw,binding);s.resolution_hash='4'.repeat(64);binding.commandId=original;const value=await pending;assert.equal(value.source.resolution_hash,'3'.repeat(64));assert.equal(value.source.source_command_id,id);assert.ok(Object.isFrozen(value.source));assert.equal(value.xml_base64,raw.xml_base64);
 await assert.rejects(publicProcessedResult({...raw,source:{...s,resolution_hash:undefined}}, {...binding,commandId:id}));
});
