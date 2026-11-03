import {test} from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {createCatalogAdoptionRpc} from './catalog_adoption_rpc.mjs';
const base='https://abcdefghijklmnopqrst.supabase.co',secret='synthetic-secret-not-real-000000',H='a'.repeat(64);
const plan=()=>({actor:randomUUID(),batches:[{entity:'contacts',command_id:randomUUID(),preview_hash:H,items:[{source_id:'1',source_hash:H}],evidence:[{proposal_id:'2'}]}]});
const response=(url,body={ok:true},status=200)=>{const r=new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});Object.defineProperty(r,'url',{value:url});return r;};
const args=p=>({p_user_id:p.actor,p_entity:p.batches[0].entity,p_items:p.batches[0].items,p_command_id:p.batches[0].command_id,p_preview_hash:H});
test('prepare and readonly recovery reject apply before fetch; recovery also rejects proposal reads',async()=>{
 for(const mode of ['prepare','recover-readonly']){let count=0;const p=plan(),port=createCatalogAdoptionRpc({fetchImpl:async()=>{count++;},projectUrl:base,secret,plan:p,mode});await assert.rejects(port.rpc('erp_catalog_import_apply',args(p)),/CATALOG_RPC_SCOPE/);if(mode==='recover-readonly')await assert.rejects(port.rpc('erp_origin_proposal_import_preview_v2',{p_source_id:'2'}),/CATALOG_RPC_SCOPE/);assert.equal(count,0);port.dispose();}
});
test('only pinned actor/entity/ordered items/UUID/hash can reach one apply',async()=>{
 let count=0,body;const p=plan(),port=createCatalogAdoptionRpc({fetchImpl:async(url,o)=>{count++;body=JSON.parse(o.body);return response(url);},projectUrl:base,secret,plan:p,mode:'apply-reviewed'});
 for(const edit of [a=>a.p_user_id=randomUUID(),a=>a.p_entity='products',a=>a.p_command_id=randomUUID(),a=>a.p_items[0].source_hash='b'.repeat(64)]){const a=structuredClone(args(p));edit(a);await assert.rejects(port.rpc('erp_catalog_import_apply',a),/CATALOG_RPC_SCOPE/);}
 assert.equal(count,0);await port.rpc('erp_catalog_import_apply',args(p));assert.equal(body.p_user_id,p.actor);await assert.rejects(port.rpc('erp_catalog_import_apply',args(p)),/CATALOG_RPC_SCOPE/);assert.equal(count,1);port.dispose();
});
test('lost apply acknowledgement cannot authorize a second network attempt and raw errors never escape',async()=>{
 const p=plan();let count=0;const port=createCatalogAdoptionRpc({fetchImpl:async()=>{count++;throw Error(secret+' private payload');},projectUrl:base,secret,plan:p,mode:'apply-reviewed'});await assert.rejects(port.rpc('erp_catalog_import_apply',args(p)),{message:'CATALOG_RPC_UNCONFIRMED'});await assert.rejects(port.rpc('erp_catalog_import_apply',args(p)),/CATALOG_RPC_SCOPE/);assert.equal(count,1);port.dispose();
});
test('arguments and plan are captured synchronously; actor is injected only from pinned plan',async()=>{
 const p=plan();let body;const port=createCatalogAdoptionRpc({fetchImpl:async(url,o)=>{body=JSON.parse(o.body);return response(url);},projectUrl:base,secret,plan:p,mode:'prepare'});const actor=p.actor,a={p_entity:'contacts',p_items:structuredClone(p.batches[0].items)};const waiting=port.rpc('erp_catalog_import_preview',a);a.p_items[0].source_id='9';p.actor=randomUUID();await waiting;assert.equal(body.p_items[0].source_id,'1');assert.equal(body.p_user_id,actor);port.dispose();
});
test('redirect/wrong URL, HTTP errors and oversized bodies fail closed',async()=>{
 for(const kind of ['url','http','size']){const p=plan(),port=createCatalogAdoptionRpc({fetchImpl:async url=>kind==='url'?response(base+'/other'):kind==='http'?response(url,{secret},403):response(url,{text:'x'.repeat(2097153)}),projectUrl:base,secret,plan:p,mode:'prepare'});await assert.rejects(port.rpc('erp_origin_proposal_import_preview_v2',{p_source_id:'2'}),/CATALOG_RPC_(UNAVAILABLE|RESPONSE_LIMIT)/);port.dispose();}
});
test('abort bounds a fetch that ignores signal; aborted-before-dispatch makes zero requests',async()=>{
 const p=plan();let calls=0;const ac=new AbortController(),port=createCatalogAdoptionRpc({fetchImpl:async()=>{calls++;ac.abort();return new Promise(()=>{});},projectUrl:base,secret,plan:p,mode:'prepare'});await assert.rejects(port.rpc('erp_origin_proposal_import_preview_v2',{p_source_id:'2'},{signal:ac.signal}),/UNCONFIRMED/);assert.equal(calls,1);const p2=createCatalogAdoptionRpc({fetchImpl:async()=>{calls++;},projectUrl:base,secret,plan:p,mode:'prepare'});await assert.rejects(p2.rpc('erp_origin_proposal_import_preview_v2',{p_source_id:'2'},{signal:ac.signal}),/UNCONFIRMED/);assert.equal(calls,1);port.dispose();p2.dispose();
});
test('unsettled cancellation cannot hold the caller past abort or an HTTP failure', {timeout:1000},async()=>{
 for(const status of [200,403]){const p=plan(),ac=new AbortController();let cancelled=0;const port=createCatalogAdoptionRpc({fetchImpl:async url=>{const body=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{"ok":true}'));if(status===200)setTimeout(()=>ac.abort(),1);},cancel(){cancelled++;return new Promise(()=>{});}});const r=new Response(body,{status,headers:{'content-type':'application/json'}});Object.defineProperty(r,'url',{value:url});return r;},projectUrl:base,secret,plan:p,mode:'prepare'});
 await assert.rejects(port.rpc('erp_origin_proposal_import_preview_v2',{p_source_id:'2'},{signal:ac.signal}),/CATALOG_RPC_(UNCONFIRMED|UNAVAILABLE)/);assert.equal(cancelled,1);port.dispose();}
});
test('zero-byte chunks are rejected without a microtask loop starving the deadline', {timeout:1000},async()=>{
 const p=plan();let pulls=0,cancelled=false;const port=createCatalogAdoptionRpc({fetchImpl:async url=>{const r=new Response(new ReadableStream({pull(c){pulls++;c.enqueue(new Uint8Array());},cancel(){cancelled=true;}}),{headers:{'content-type':'application/json'}});Object.defineProperty(r,'url',{value:url});return r;},projectUrl:base,secret,plan:p,mode:'prepare'});await assert.rejects(port.rpc('erp_origin_proposal_import_preview_v2',{p_source_id:'2'}),/CATALOG_RPC_RESPONSE_INVALID/);assert.ok(pulls<=2);assert.equal(cancelled,true);port.dispose();
});
test('a parsed response is still rejected when its deadline has elapsed',async()=>{
 const p=plan();let expired=false;const original=JSON.parse,port=createCatalogAdoptionRpc({fetchImpl:async url=>response(url),projectUrl:base,secret,plan:p,mode:'prepare',now:()=>expired?30000:1000});
 try{JSON.parse=(...a)=>{const result=original(...a);expired=true;return result;};await assert.rejects(port.rpc('erp_origin_proposal_import_preview_v2',{p_source_id:'2'},{deadline:2000}),/CATALOG_RPC_UNCONFIRMED/);}finally{JSON.parse=original;port.dispose();}
});
