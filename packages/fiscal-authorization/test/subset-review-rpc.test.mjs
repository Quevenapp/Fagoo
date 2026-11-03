import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {sample} from './subset-review-unit-fixtures.mjs';
import {createSubsetReviewRpc,SUBSET_RPC_ENVELOPE_BYTES} from '../src/subset-review-rpc.mjs';
import {canonical,recordText,MAX_SUBSET_RECORD_BYTES} from '../src/subset-review-dto.mjs';
const projectUrl='https://abcdefghijklmnopqrst.supabase.co',serviceKey='SYNTHETIC_SERVICE_KEY_ONLY',save='erp_fiscal_subset_review_save',get='erp_fiscal_subset_review_get';
const rpc=fetchImpl=>createSubsetReviewRpc({projectUrl,serviceKey,fetchImpl}),opts=()=>({deadline:Date.now()+45000});
const code=c=>e=>e.code===c&&e.message===c&&!JSON.stringify(e).includes('PRIVATE_SENTINEL');
test('C1 controls in a declaration are rejected before HTTP, matching the SQL contract',async()=>{
 let calls=0;const port=rpc(async()=>{calls++;throw Error('must not dispatch');});
 for(const value of ['\u0080','\u0085','\u009f'])await assert.rejects(port(save,sample(1,'synthetic '+value).args,opts()),code('SUBSET_REVIEW_INVALID'));
 assert.equal(calls,0);
});
test('068 HTTP factory is explicit, allowlisted, fixed destination, and captures schema/body before await',async()=>{
 const s=sample();let release,seen;const wait=new Promise(r=>release=r);
 const call=rpc(async(url,o)=>{await wait;seen={url,args:JSON.parse(Buffer.from(o.body).toString()),headers:o.headers,redirect:o.redirect};return Response.json(s.value);});
 const args=structuredClone(s.args),promise=call(save,args,opts());args.p_schema.validator_hash='f'.repeat(64);args.p_user_id=randomUUID();args.p_declaration_text='{}';release();const value=await promise;
 assert.equal(value.receipt.review_hash,s.value.receipt.review_hash);assert.deepEqual(seen.args,s.args);assert.equal(seen.url,projectUrl+'/rest/v1/rpc/'+save);assert.equal(seen.redirect,'manual');assert.equal(seen.headers['Accept-Encoding'],'identity');
 let requests=0,accessed=0;const closed=rpc(async()=>{requests++;return Response.json({});});
 for(const n of ['erp_fiscal_authorization_use','erp_a1_metadata','unknown'])await assert.rejects(closed(n,s.args,opts()),code('SUBSET_REVIEW_RPC_UNSUPPORTED'));
 const bad=structuredClone(s.args);Object.defineProperty(bad.p_schema,'validator_hash',{get(){accessed++;return s.args.p_schema.validator_hash;}});await assert.rejects(closed(save,bad,opts()));assert.equal(accessed,0);assert.equal(requests,0);
 assert.throws(()=>createSubsetReviewRpc({projectUrl:projectUrl+'/',serviceKey,fetchImpl:async()=>{}}));
});
test('250-item escaped record exceeds the old128KiB HTTP cap but fits the separate canonical/envelope budgets',async()=>{
 let s;for(let n=1;n<200;n++){const candidate=sample(250,'á漢"\\'.repeat(n));const bytes=Buffer.byteLength(candidate.value.record_text);if(bytes>MAX_SUBSET_RECORD_BYTES)break;s=candidate;}
 assert.ok(s);const bytes=Buffer.byteLength(s.value.record_text),envelope=Buffer.byteLength(JSON.stringify(s.value));assert.ok(bytes<=MAX_SUBSET_RECORD_BYTES);assert.ok(envelope>MAX_SUBSET_RECORD_BYTES);assert.ok(envelope<SUBSET_RPC_ENVELOPE_BYTES);
 const call=rpc(async()=>Response.json(s.value));assert.equal((await call(save,s.args,opts())).record_text,s.value.record_text);
 assert.throws(()=>recordText('x'.repeat(MAX_SUBSET_RECORD_BYTES+1)),code('SUBSET_REVIEW_LIMIT'));
});
test('record metadata1.0/1e0, alternate whitespace and hash mismatches cannot cross the DTO',async()=>{
 const s=sample();for(const text of [s.value.record_text+' ',s.value.record_text.replace('"version":1','"version":1.0'),s.value.record_text.replace('"version":1','"version":1e0'),s.value.record_text.replace('"review_hash":"','"review_hash":"0')])await assert.rejects(rpc(async()=>Response.json({...s.value,record_text:text}))(save,s.args,opts()));
 for(const text of [s.args.p_declaration_text.replace('"position":1','"position":1,"position":1'),JSON.stringify(JSON.parse(s.args.p_declaration_text),null,2)])await assert.rejects(rpc(async()=>Response.json(s.value))(save,{...s.args,p_declaration_text:text},opts()));
 assert.equal(canonical(JSON.parse(s.value.record_text)),s.value.record_text);
});
test('empty chunks terminate immediately even if reader cancellation never resolves',async()=>{
 const s=sample();let cancelled=0;const stream=new ReadableStream({start(c){c.enqueue(new Uint8Array());},cancel(){cancelled++;return new Promise(()=>{});}});
 const before=Date.now();await assert.rejects(rpc(async()=>new Response(stream,{headers:{'content-type':'application/json'}}))(get,s.getArgs,{deadline:Date.now()+1000}),code('SUBSET_REVIEW_RPC_BODY_LIMIT'));assert.ok(Date.now()-before<900);assert.equal(cancelled,1);
});
test('redirect/coding/limits/UTF8 and private upstream messages fail closed',async()=>{
 const s=sample(),responses=[new Response('',{status:302}),new Response('{}',{headers:{'content-type':'application/json','content-encoding':'gzip'}}),new Response('{}',{headers:{'content-type':'application/json','content-length':String(SUBSET_RPC_ENVELOPE_BYTES+1)}}),new Response('{}',{headers:{'content-type':'application/json','content-length':'9'}}),new Response(Uint8Array.from([255]),{headers:{'content-type':'application/json'}})];
 for(const response of responses)await assert.rejects(rpc(async()=>response)(get,s.getArgs,opts()));
 for(const status of ['42501','40001','22023','P0002','55000'])await assert.rejects(rpc(async()=>Response.json({code:status,message:'PRIVATE_SENTINEL',details:serviceKey},{status:400}))(get,s.getArgs,opts()),code(status));
 await assert.rejects(rpc(async()=>Response.json({code:'XX000',message:'PRIVATE_SENTINEL'},{status:500}))(get,s.getArgs,opts()),code('SUBSET_REVIEW_RPC_HTTP_REJECTED'));
});
test('abort and deadline bound an ignoring driver and cancel late responses using the captured signal',async()=>{
 const s=sample();let release;const controller=new AbortController(),o={deadline:Date.now()+1000,signal:controller.signal},pending=rpc(()=>new Promise(r=>release=r))(get,s.getArgs,o);o.signal=new AbortController().signal;await Promise.resolve();controller.abort();await assert.rejects(pending,code('SUBSET_REVIEW_RPC_ABORTED'));let cancelled=0;release(new Response(new ReadableStream({cancel(){cancelled++;}}),{headers:{'content-type':'application/json'}}));await new Promise(r=>setTimeout(r,0));assert.equal(cancelled,1);
 await assert.rejects(rpc(()=>new Promise(()=>{}))(get,s.getArgs,{deadline:Date.now()+10}),code('SUBSET_REVIEW_RPC_TIMEOUT'));
});
test('deadline is checked again after JSON parsing before a successful result can escape',async()=>{
 const s=sample(),original=JSON.parse,clock=Date.now,deadline=clock()+1000;let parsing=false;
 try{JSON.parse=(...args)=>{const v=original(...args);if(parsing)Date.now=()=>deadline;return v;};await assert.rejects(rpc(async()=>{parsing=true;return Response.json(s.read);})(get,s.getArgs,{deadline}),code('SUBSET_REVIEW_RPC_TIMEOUT'));}
 finally{JSON.parse=original;Date.now=clock;}
});
