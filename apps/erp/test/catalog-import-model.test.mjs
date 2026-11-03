import test from 'node:test';
import assert from 'node:assert/strict';
import {canSelectImport,importSelection,importChangeText,checkedImportPage,checkedImportPlan,checkedImportResult,importListPath} from '../src/lib/catalog-import-model.ts';
import {createAccessController} from '../src/lib/real-access.ts';
const row=(source_id,action='create')=>({source_id,source_hash:'a'.repeat(64),action});
test('import selection preserves source IDs and exact hashes, limits a batch to its visible selection and blocks unavailable rows',()=>{
 const rows=[row('0001'),row('90071992547409931234'),row('deleted','pending_source_deleted'),row('bad','invalid_source')];
 assert.deepEqual(importSelection(rows,new Set(['90071992547409931234','0001'])),[{source_id:'0001',source_hash:'a'.repeat(64)},{source_id:'90071992547409931234',source_hash:'a'.repeat(64)}]);
 assert.equal(canSelectImport(rows[2]),true);assert.equal(canSelectImport(rows[3]),false);
 for(const selected of [new Set(),new Set(['missing']),new Set(['bad'])])assert.throws(()=>importSelection(rows,selected));
 const excessive=Array.from({length:101},(_,i)=>row(String(i)));assert.throws(()=>importSelection(excessive,new Set(excessive.map(item=>item.source_id))));
});
test('protected differences never expose values even if a malformed caller supplies them',()=>{
 const change={field:'document',redacted:true,before:'PRIVATE_BEFORE',after:'PRIVATE_AFTER'};
 assert.equal(importChangeText(change,'before'),'Valor protegido');assert.equal(importChangeText(change,'after'),'Alteração em campo protegido');
 assert.equal(importChangeText({field:'price',redacted:false,before:null,after:'12345678901234.1234'},'after'),'12345678901234.1234');
 assert.equal(importChangeText({field:'active',redacted:false,before:false,after:true},'after'),'Sim');
});
test('import readback is bound to entity, ordered selection, preview hash and safety flags',()=>{
 const items=[{source_id:'0001',source_hash:'a'.repeat(64)}],base={entity:'contacts',data_mode:'erp_native',operational_effects:false};
 const page={...base,source:'origin_staging',items:[row('0001')],limit:25,has_more:false,next_cursor:null};
 const plan={...base,items:[{...row('0001'),changes:[]}],preview_hash:'b'.repeat(64),dry_run:true};
 const result={...base,items:[row('0001')],preview_hash:plan.preview_hash,dry_run:false,replayed:true};
 assert.equal(checkedImportPage(page,'contacts',25),page);assert.equal(checkedImportPlan(plan,'contacts',items),plan);
 assert.equal(checkedImportResult(result,'contacts',items,plan.preview_hash),result);
 for(const bad of [{...page,entity:'products'},{...page,operational_effects:true},{...page,has_more:true,next_cursor:'0001'},{...page,items:[row('0001'),row('0001')]}])assert.throws(()=>checkedImportPage(bad,'contacts',25));
 for(const bad of [{...plan,dry_run:false},{...plan,preview_hash:'bad'},{...plan,items:[{...row('another'),changes:[]}]}])assert.throws(()=>checkedImportPlan(bad,'contacts',items));
 for(const bad of [{...result,preview_hash:'c'.repeat(64)},{...result,items:[row('another')]},{...result,entity:'products'},{...result,replayed:undefined}])assert.throws(()=>checkedImportResult(bad,'contacts',items,plan.preview_hash));
 const path=importListPath('contacts',100,'0001 / ?','Nome % sintético');const parsed=new URL(path,'https://example.invalid');
 assert.equal(parsed.pathname,'/v1/importacao-cadastros/contacts');assert.equal(parsed.searchParams.get('after'),'0001 / ?');assert.equal(parsed.searchParams.get('q'),'Nome % sintético');assert.equal(parsed.searchParams.get('limit'),'100');
});
test('import controller enforces prefix, four-MiB bound and session cancellation for late replies',async()=>{
 const session={access_token:'synthetic-import-token',user:{id:'a0000000-0000-4000-8000-000000000001'}};
 const auth={getSession:async()=>({data:{session},error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signInWithPassword:async()=>({data:{session},error:null}),signOut:async()=>({error:null})};
 let large=false,pending=false,finish,signal;
 const controller=createAccessController(auth,'https://api.example.test',async(url,options)=>{
  if(url.endsWith('/me'))return new Response(JSON.stringify({user_id:session.user.id,role:'admin',resources:[],data_mode:'staging_readonly'}));
  if(pending){signal=options.signal;return new Promise(resolve=>{finish=resolve;});}
  return new Response(JSON.stringify({data:large?'x'.repeat(4*1024*1024):'okay'}));
 });
 const stop=controller.start();await new Promise(resolve=>setTimeout(resolve,0));await assert.rejects(controller.catalogImport('/v1/cadastros'),error=>error.status===400);
 large=true;await assert.rejects(controller.catalogImport('/v1/importacao-cadastros/contacts'),error=>error.status===502);
 pending=true;const request=controller.catalogImport('/v1/importacao-cadastros/contacts/preview',{method:'POST',body:{items:[]}});await controller.logout();assert.equal(signal.aborted,true);
 finish(new Response('{}'));await assert.rejects(request,error=>error.name==='AbortError');stop();
});
