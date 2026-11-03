import test from 'node:test';
import assert from 'node:assert/strict';
import {parseFiscalDraftStatusPage,FiscalDraftStatusError,FISCAL_DRAFT_STATUS_MAX_BYTES} from '../../../packages/erp-domain/src/fiscal-draft-status-dto.mjs';
import {parseFiscalDraftStatusRoute,executeFiscalDraftStatusRoute,FISCAL_DRAFT_STATUS_BASE} from '../src/fiscal-draft-status.mjs';
import {statusPage,id,H,at} from './helpers/fiscal-draft-status-response.mjs';
const url='https://erp.test'+FISCAL_DRAFT_STATUS_BASE,request=u=>new Request(u??url),route=()=>parseFiscalDraftStatusRoute(request());
test('082 public contract is frozen, bounded and keeps endpoint flags separate from stored authorization',()=>{
 const raw=statusPage(),v=parseFiscalDraftStatusPage(raw);assert.equal(v.can_emit,false);assert.equal(v.items[0].authorization.original.state,'authorized_homologation');assert.ok(Object.isFrozen(v.items[0].authorization.original));raw.items[0].draft.contact_name='CHANGED';assert.equal(v.items[0].draft.contact_name,'CLIENTE FICTICIO');
 for(const mutate of[v=>v.can_emit=true,v=>v.operational_effects=true,v=>v.extra='PRIVATE',v=>v.items[0].numbering.visibility='restricted',v=>v.items[0].authorization.selection='active',v=>v.items[0].authorization.original.origin='synthetic',v=>v.items[0].authorization.original.result.protocol_cstat='245',v=>v.items[0].authorization.original.result.processed_hash=null,v=>v.items[0].authorization.original.result.recorded_at='2026-02-31T00:00:00Z',v=>v.items[0].authorization.basis.is_latest_job=false,v=>v.items[0].authorization.basis.differences=['UNRECOGNIZED'],v=>v.items[0].draft.id=id(0),v=>v.items[0].draft.model='65']){
  const p=statusPage();mutate(p);assert.throws(()=>parseFiscalDraftStatusPage(p,{model:'55',after:id(0)}),FiscalDraftStatusError);
 }
 const synthetic=statusPage();synthetic.items[0].authorization.original.origin='synthetic';synthetic.items[0].authorization.original.state='authorization_observed';assert.equal(parseFiscalDraftStatusPage(synthetic).items[0].authorization.original.state,'authorization_observed');
});
test('082 DTO does not run getters or accept hidden data, sparse arrays, oversized strings or unbound079',()=>{
 let calls=0;const p=statusPage();Object.defineProperty(p,'private',{get(){calls++;throw Error('private');},enumerable:true});assert.throws(()=>parseFiscalDraftStatusPage(p));assert.equal(calls,0);
 const oversized=statusPage();oversized.items[0].draft.contact_name='a'.repeat(FISCAL_DRAFT_STATUS_MAX_BYTES);assert.throws(()=>parseFiscalDraftStatusPage(oversized));
 const sparse=statusPage();sparse.items=Array(1);assert.throws(()=>parseFiscalDraftStatusPage(sparse));
 const extra=statusPage();extra.items[0].authorization.revalidation={visibility:'restricted',result:{source_hash:H}};assert.throws(()=>parseFiscalDraftStatusPage(extra));
 const rv=statusPage(),o=rv.items[0].authorization.original;const good={...o.result,command_id:id(9),parser_profile:'authorization-stored-response-utf8-v1',parser_manifest_hash:'26a4ba4dcc9dbad2e196ae76136fbe8465f5dd235ca7aa30c468c192a8cce033',source_hash:H,state:'authorized_homologation'};o.state='review_required';o.result={...o.result,processed_hash:null,processed_size:null,cstat:null,protocol_cstat:null,protocol_number:null,received_at:null,rejection_code:'SOAP_INVALID'};rv.items[0].authorization.revalidation={visibility:'available',result:good};assert.equal(parseFiscalDraftStatusPage(rv).items[0].authorization.revalidation.result.state,'authorized_homologation');
 for(const patch of[{response_hash:'b'.repeat(64)},{response_size:101},{parser_manifest_hash:H},{command_id:id(4)},{recorded_at:'2026-10-16T03:00:00Z'}]){const other=structuredClone(rv);Object.assign(other.items[0].authorization.revalidation.result,patch);assert.throws(()=>parseFiscalDraftStatusPage(other));}
});
test('082 route only accepts GET with fixed query keys and exact captured values',()=>{
 assert.equal(parseFiscalDraftStatusRoute(request('https://erp.test/else')),null);const r=parseFiscalDraftStatusRoute(request(url+'?model=55&status=draft&source_document_id='+id(2)+'&limit=1&after='+id(0)));assert.equal(r.rpc,'erp_fiscal_draft_status_list');assert.equal(r.args.p_limit,1);assert.equal(r.args.p_source_document_id,id(2));assert.ok(Object.isFrozen(r.args));
 for(const suffix of['/x','?limit=26','?limit=01','?model=66','?status=authorized_homologation','?after=wrong','?limit=1&limit=2','?actor='+id(3),'#fragment'])assert.throws(()=>parseFiscalDraftStatusRoute(request(url+suffix)),FiscalDraftStatusError);
 assert.throws(()=>parseFiscalDraftStatusRoute(new Request(url,{method:'POST',body:'{}'})),e=>e.status===405);
});
test('082 adapter captures actor and transport before await, with one fixed RPC and bounded output',async()=>{
 let release,args,opts;const context={userId:id(10),rpc:async(n,a,o)=>{assert.equal(n,'erp_fiscal_draft_status_list');args=a;opts=o;return new Promise(r=>release=r);}};const pending=executeFiscalDraftStatusRoute(route(),context);context.userId=id(11);context.rpc=()=>{throw Error('must not run');};await Promise.resolve();assert.equal(args.p_user_id,id(10));assert.ok(Object.isFrozen(args));assert.ok(opts.signal instanceof AbortSignal);release(statusPage());assert.equal((await pending).items[0].draft.id,id(1));assert.equal(opts.signal.aborted,true);
 let calls=0;await assert.rejects(executeFiscalDraftStatusRoute({...route()},{userId:id(10),rpc:()=>calls++}),e=>e.status===404);assert.equal(calls,0);
 const getter={userId:id(10),get rpc(){calls++;throw Error('private');}};await assert.rejects(executeFiscalDraftStatusRoute(route(),getter));assert.equal(calls,0);
});
test('082 abort, deadline and late responses cannot leak stale payload',async()=>{
 const aborted=new AbortController();aborted.abort();let calls=0;await assert.rejects(executeFiscalDraftStatusRoute(route(),{userId:id(10),signal:aborted.signal,rpc:()=>calls++}),e=>e.code==='ERP_REQUEST_TIMEOUT');assert.equal(calls,0);
 let release;const pending=executeFiscalDraftStatusRoute(route(),{userId:id(10),timeoutMs:5,rpc:()=>new Promise(r=>release=r)});await assert.rejects(pending,e=>e.code==='ERP_REQUEST_TIMEOUT');release(statusPage());
 const c=new AbortController();const waiting=executeFiscalDraftStatusRoute(route(),{userId:id(10),signal:c.signal,rpc:async()=>{c.abort();return statusPage();}});await assert.rejects(waiting,e=>e.code==='ERP_REQUEST_TIMEOUT');
});
test('082 errors are closed, without raw database details or SQLSTATE spoof getters',async()=>{
 for(const[code,status]of[['42501',403],['22023',400],['P0002',404],['54000',502],['unknown',502]])await assert.rejects(executeFiscalDraftStatusRoute(route(),{userId:id(10),rpc:()=>{throw{code,message:'PRIVATE_SENTINEL',detail:'PRIVATE'};}}),e=>e.status===status&&!e.message.includes('PRIVATE')&&!JSON.stringify(e).includes('PRIVATE'));
 let touched=0;await assert.rejects(executeFiscalDraftStatusRoute(route(),{userId:id(10),rpc:()=>{throw{get code(){touched++;return'42501';}};}}),e=>e.status===502);assert.equal(touched,0);
 await assert.rejects(executeFiscalDraftStatusRoute(route(),{userId:id(10),rpc:()=>({...statusPage(),observed_at:'private'})}),e=>e.code==='ERP_UPSTREAM_INVALID_RESPONSE');
});
