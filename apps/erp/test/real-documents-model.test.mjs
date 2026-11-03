import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDocument,documentInput,documentValidation,calculateDocument,documentListParams,EMPTY_DOCUMENT_FILTERS } from '../src/lib/real-documents-model.ts';
import { normalizeDocument } from '../../../packages/erp-domain/src/index.mjs';
import { createAccessController } from '../src/lib/real-access.ts';

const uuid='00000000-0000-4000-8000-000000000001';
const ready=()=>({date:'2026-10-16',contact_id:uuid,items:[{id:uuid,description:'Item sintético',unit:'KG',quantity:'3',unit_price:'1.005',discount_percent:'10'}],discount_mode:'percent',discount_value:'5',freight:'1.20',other_expenses:'0.30',installments:[{due_date:'2026-11-01',amount:'4.08'}]});
test('document filters preserve literal searches, explicit dates and cursor, rejecting invalid dates/status for the kind',()=>{
 assert.deepEqual(Object.fromEntries(documentListParams('sales_proposals',EMPTY_DOCUMENT_FILTERS)),{limit:'25'});
 const filters={query:'  Cliente_%  ',status:'draft',from:'2024-02-29',to:'2026-10-16'};
 assert.deepEqual(Object.fromEntries(documentListParams('sales_proposals',filters,uuid)),{limit:'25',after:uuid,status:'draft',q:'Cliente_%',date_from:'2024-02-29',date_to:'2026-10-16'});
 for(const patch of [{from:'2026-02-29'},{from:'2026-04-31'},{from:'1899-12-31'},{to:'2100-01-01'},{from:'2026-10-17'},{query:'x'.repeat(121)},{query:'hidden\ncontrol'},{status:'finalized'}])assert.throws(()=>documentListParams('sales_proposals',{...filters,...patch}));
 assert.throws(()=>documentListParams('sales_proposals',filters,'bad-cursor'));
});
test('new service reception permits no lines, while commercial documents need a described item and contact',()=>{
  const service=freshDocument('service_orders','2026-10-16');assert.deepEqual(service.items,[]);
  assert.match(documentValidation('service_orders',service),/cliente/);
  assert.equal(documentValidation('service_orders',{...service,contact_id:uuid}),null);
  assert.notEqual(documentValidation('sales_orders',{...service,contact_id:uuid}),null);
  const proposal=freshDocument('sales_proposals','2026-10-16');assert.equal(proposal.items.length,1);assert.equal(typeof proposal.items[0].id,'string');
});
test('editing projection preserves item IDs and planned terms but excludes server metadata and computed amounts',()=>{
  const normalized=normalizeDocument('sales_proposals',ready());
  const record={...normalized,id:uuid,number:'5',version:2,status:'open',contact_snapshot:{id:uuid,name:'Contato'},source_proposal_id:null,items:normalized.items.map(item=>({...item,product_snapshot:{private:'snapshot'}}))};
  const projected=documentInput(record);
  assert.equal(projected.items[0].id,uuid);assert.equal(projected.items[0].unit_price,'1.0050');
  assert.doesNotMatch(JSON.stringify(projected),/snapshot|version|source_proposal_id|position|totals/);
  assert.equal(documentValidation('sales_proposals',projected),null);assert.equal(calculateDocument(projected).total,'4.08');
  assert.match(documentValidation('sales_proposals',{...projected,installments:[{due_date:'2026-11-01',amount:'4.07'}]}),/soma das parcelas/);
});
const session={access_token:'synthetic-token',user:{id:uuid}};
const auth={getSession:async()=>({data:{session},error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signInWithPassword:async()=>({data:{session},error:null}),signOut:async()=>({error:null})};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const me={user_id:uuid,role:'admin',resources:[],data_mode:'staging_readonly'};
test('native clients enforce their prefixes and preserve token-only header, bounded responses and redirect refusal',async()=>{
  const calls=[];
  const controller=createAccessController(auth,'https://api.example.test',async(url,init)=>{calls.push({url,init});return new Response(JSON.stringify(url.endsWith('/me')?me:{ok:true}));});
  const stop=controller.start();await tick();
  for(const [name,prefix] of [['documents','documentos'],['stock','estoque'],['finance','financeiro']]){
    for(const path of ['/v1/cadastros','https://other.test',`/v1/${prefix}/../me`,`/v1/${prefix}/%2E%2e/me`])await assert.rejects(controller[name](path),error=>error.status===400);
    await controller[name](`/v1/${prefix}`,{method:'POST',body:{synthetic:true}});
    const {init}=calls.at(-1);assert.equal(init.headers.Authorization,'Bearer synthetic-token');assert.equal(init.redirect,'error');assert.equal(init.cache,'no-store');assert.doesNotMatch(init.body,/synthetic-token/);
  }
  assert.equal(calls.length,4);stop();
});
test('logout aborts document commands and cannot repopulate state from late mutation responses',async()=>{
  let finish,signal;
  const controller=createAccessController(auth,'https://api.example.test',async(url,init)=>{if(url.endsWith('/me'))return new Response(JSON.stringify(me));signal=init.signal;return new Promise(resolve=>{finish=resolve;});});
  const stop=controller.start();await tick();const pending=controller.documents('/v1/documentos/sales_orders',{method:'POST',body:{data:ready()}});
  await controller.logout();assert.equal(signal.aborted,true);finish(new Response('{"private":"late"}'));await assert.rejects(pending,error=>error.name==='AbortError');assert.equal(controller.getSnapshot().phase,'signed_out');stop();
});
test('documents allow bounded snapshots while finance and stock retain the one-MiB limit',async()=>{
  let bytes=1024*1024;
  const controller=createAccessController(auth,'https://api.example.test',async url=>new Response(JSON.stringify(url.endsWith('/me')?me:{data:'x'.repeat(bytes)})));
  const stop=controller.start();await tick();assert.equal((await controller.documents('/v1/documentos')).data.length,bytes);
  for(const name of ['stock','finance'])await assert.rejects(controller[name](name==='stock'?'/v1/estoque':'/v1/financeiro'),error=>error.status===502);
  bytes=8*1024*1024;await assert.rejects(controller.documents('/v1/documentos'),error=>error.status===502);stop();
});
