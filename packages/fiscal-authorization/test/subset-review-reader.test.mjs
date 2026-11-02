import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {sample} from './subset-review-unit-fixtures.mjs';
import {createPersistedSubsetReviewReader} from '../src/subset-review-reader.mjs';
import {MAX_SUBSET_RECORD_BYTES,canonical,hash} from '../src/subset-review-dto.mjs';
const opts=()=>({signal:new AbortController().signal,deadline:Date.now()+5000,maxBytes:MAX_SUBSET_RECORD_BYTES});
test('reader checks actor/candidate version/latest/reviewer/time and exact facts rather than trusting an injected port',async()=>{
 const s=sample();const read=value=>createPersistedSubsetReviewReader({rpc:async()=>value});
 assert.equal(Buffer.from(await read(s.read)(s.query,opts())).toString(),s.read.record_text);
 for(const patch of [{actor:randomUUID()},{candidate_version:2},{current:{...s.read.current,reviewer_active:false}},{current:{...s.read.current,within_validity:false}},{current:{...s.read.current,is_latest:false,latest_review_id:randomUUID(),latest_review_version:2}}])await assert.rejects(read({...s.read,...patch})(s.query,opts()));
 const wrong=structuredClone(s.query);wrong.items[0].itemHash='f'.repeat(64);await assert.rejects(read(s.read)(wrong,opts()),e=>e.code==='SUBSET_REVIEW_FACTS_CHANGED');
 const r=structuredClone(s.record);r.reviewed_at='2026-10-16T00:00:00.000Z';r.valid_until='2026-10-16T00:00:00.001Z';const{review_hash,...body}=r;r.review_hash=hash(canonical(body));
 await assert.rejects(read({...s.read,record_text:canonical(r),receipt:{...s.read.receipt,reviewed_at:r.reviewed_at,valid_until:r.valid_until,review_hash:r.review_hash}})(s.query,opts()),e=>e.code==='SUBSET_REVIEW_NOT_CURRENT');
});
test('missing current review is null, bounded bytes are enforced, and query/signal are captured before await',async()=>{
 const s=sample(),empty={...s.read,receipt:null,record_text:null,current:{latest_review_id:null,latest_review_version:0,is_latest:false,reviewer_active:false,within_validity:false}};
 assert.equal(await createPersistedSubsetReviewReader({rpc:async()=>empty})(s.query,opts()),null);
 await assert.rejects(createPersistedSubsetReviewReader({rpc:async()=>s.read})(s.query,{...opts(),maxBytes:10}),e=>e.code==='SUBSET_REVIEW_LIMIT');
 let release,seen;const deferred=new Promise(r=>release=r),read=createPersistedSubsetReviewReader({rpc:async(_name,args,o)=>{seen={args,o};await deferred;return s.read;}}),q=structuredClone(s.query),o=opts(),signal=o.signal;
 const promise=read(q,o);q.actor=randomUUID();q.items[0].itemHash='f'.repeat(64);o.signal=new AbortController().signal;release();assert.equal(Buffer.from(await promise).toString(),s.read.record_text);assert.equal(seen.args.p_user_id,s.query.actor);assert.equal(seen.o.signal,signal);
});
test('reader rejects query accessors and a response that arrives after original cancellation',async()=>{
 const s=sample();let touched=0,called=0;const read=createPersistedSubsetReviewReader({rpc:async()=>{called++;return s.read;}}),q=structuredClone(s.query);Object.defineProperty(q.items[0],'itemHash',{get(){touched++;return s.query.items[0].itemHash;}});await assert.rejects(read(q,opts()));assert.equal(touched,0);assert.equal(called,0);
 let release;const controller=new AbortController(),pending=createPersistedSubsetReviewReader({rpc:()=>new Promise(r=>release=r)})(s.query,{...opts(),signal:controller.signal});controller.abort();release(s.read);await assert.rejects(pending,e=>e.code==='SUBSET_REVIEW_READER_EXPIRED');
});
test('reader rechecks the deadline after its final record validation and buffer copy',async()=>{
 const s=sample(),start=Date.now(),original=Date.now;let reads=0;
 Date.now=()=>++reads<=3?start:start+101;
 try{await assert.rejects(createPersistedSubsetReviewReader({rpc:async()=>s.read})(s.query,{signal:new AbortController().signal,deadline:start+100,maxBytes:MAX_SUBSET_RECORD_BYTES}),e=>e.code==='SUBSET_REVIEW_READER_EXPIRED');assert.ok(reads>=4);}
 finally{Date.now=original;}
});
