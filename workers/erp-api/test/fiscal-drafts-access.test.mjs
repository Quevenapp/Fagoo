import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../src/index.mjs';
import {normalizeDocument} from '../../../packages/erp-domain/src/index.mjs';
import {FISCAL_DRAFT_PENDING} from '../src/fiscal-drafts.mjs';
const user='a0000000-0000-4000-8000-000000000001',draft='b0000000-0000-4000-8000-000000000001',source='c0000000-0000-4000-8000-000000000001',contact='d0000000-0000-4000-8000-000000000001',command='e0000000-0000-4000-8000-000000000001';
const env={SUPABASE_URL:'https://project.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service',ALLOWED_ORIGINS:'https://erp.example.test'};
const base={data_mode:'fiscal_draft',emission_enabled:false,operational_effects:false};
const list=()=>({...base,items:[],limit:25,has_more:false,next_cursor:null});
function detail(){
 const n=normalizeDocument('sales_orders',{date:'2026-10-16',contact_id:contact,items:[{id:'f0000000-0000-4000-8000-000000000001',description:'Peça fictícia',unit:'UN',quantity:'1',unit_price:'1.0050'}]});
 const recipient={id:contact,version:1,name:'Contato fictício',...Object.fromEntries(['person_type','document','ie','postal_code','street','number','complement','district','city','state'].map(k=>[k,null]))};
 const snapshot={catalog_basis:'document_snapshot',document_id:source,document_version:1,kind:'sales_orders',number:'1',status:'draft',date:n.date,contact_id:contact,contact:recipient,
  items:n.items.map(i=>({...i,product:null})),discount_mode:n.discount_mode,discount_value:n.discount_value,totals:n.totals,installments:n.installments,notes:n.notes,payment_terms:n.payment_terms,delivery_terms:n.delivery_terms,company:null};
 return {...base,record:{id:draft,model:'55',environment:'2',status:'draft',version:1,source_document_id:source,source_document_version:1,snapshot,snapshot_hash:'a'.repeat(64),preparation:{operation_nature:'Venda fictícia',notes:null},created_at:'2026-10-16T12:00:00Z',updated_at:'2026-10-16T12:00:00Z',archived_at:null,archive_reason:null},
  current:{version:1,status:'draft',source_document_version:1,source_status:'draft',identity_version:null,fiscal_version:null,source_changed:false,company_changed:false},
  pending:[...FISCAL_DRAFT_PENDING.slice(0,10),'COMPANY_IDENTITY_MISSING','REGIME_UNCONFIRMED','RECIPIENT_DOCUMENT_MISSING','RECIPIENT_ADDRESS_INCOMPLETE','ITEM_WITHOUT_CATALOG_LINK','ITEM_KIND_REQUIRES_REVIEW','ITEM_NCM_MISSING','PAYMENT_PLAN_MISSING']};
}
const request=(path='',method='GET',data)=>new Request(`https://api.example.test/v1/rascunhos-fiscais${path}`,{method,headers:{Authorization:'Bearer synthetic-token',Origin:'https://erp.example.test',...(data?{'Content-Type':'application/json'}:{})},body:data?JSON.stringify(data):undefined});
const harness=(value,status=200)=>{const calls=[];return {calls,handler:createHandler({fetchImpl:async(url,options)=>{calls.push({url,options});return url.endsWith('/auth/v1/user')?Response.json({id:user,user_metadata:{role:'admin',actor:'forged'}}):Response.json(value,{status});}})};};
test('fiscal draft reads route verified actors and exact filters to private RPCs, with minimal projection',async()=>{
 const h=harness({...list(),secret:'PRIVATE'});const response=await h.handler(request(`?model=55&status=draft&source_document_id=${source}`),env);
 assert.equal(response.status,200);assert.doesNotMatch(await response.text(),/PRIVATE/);assert.equal(h.calls.length,2);
 assert.ok(h.calls[1].url.endsWith('/rpc/erp_fiscal_draft_list'));assert.deepEqual(JSON.parse(h.calls[1].options.body),{p_user_id:user,p_model:'55',p_status:'draft',p_source_document_id:source,p_limit:25,p_after:null});assert.equal(h.calls[1].options.redirect,'manual');
 const d=harness(detail());assert.equal((await d.handler(request(`/${draft.toUpperCase()}`),env)).status,200);assert.deepEqual(JSON.parse(d.calls[1].options.body),{p_user_id:user,p_id:draft,p_revision:null});
 const history=harness({...list(),draft_id:draft});assert.equal((await history.handler(request(`/${draft}/revisions`),env)).status,200);assert.ok(history.calls[1].url.endsWith('/rpc/erp_fiscal_draft_revisions'));
});
test('fiscal draft creation is explicit, authenticates before reading body, and binds source version and command',async()=>{
 const data={command_id:command,source_document_id:source,expected_source_version:1,model:'55',preparation:{operation_nature:'Venda fictícia',notes:null}};
 const h=harness({...detail(),action:'create',replayed:false});const response=await h.handler(request('','POST',data),env);assert.equal(response.status,200);
 assert.deepEqual(JSON.parse(h.calls[1].options.body),{p_user_id:user,p_command_id:command,p_action:'create',p_data:{source_document_id:source,expected_source_version:1,model:'55',preparation:data.preparation}});
 const untrusted=request('','POST',{actor:'forged'});untrusted.headers.delete('Authorization');const denied=harness({});assert.equal((await denied.handler(untrusted,env)).status,401);assert.equal(denied.calls.length,0);
 for(const extra of [{p_user_id:user},{environment:'1'},{emission_enabled:true}]){const bad=harness({});assert.equal((await bad.handler(request('','POST',{...data,...extra}),env)).status,400);assert.equal(bad.calls.length,1);}
});
test('fiscal draft boundary sanitizes SQL errors and rejects response scope or emission forgery',async()=>{
 for(const [code,status]of[['42501',403],['40001',409],['22023',400],['P0002',404],['23505',409]]){const h=harness({code,message:'PRIVATE_SQL'},400);const r=await h.handler(request(),env);assert.equal(r.status,status);assert.doesNotMatch(await r.text(),/PRIVATE_SQL/);}
 for(const mutate of [v=>v.emission_enabled=true,v=>v.record.environment='1',v=>v.record.id=source,v=>v.current.source_changed=true]){const v=detail();mutate(v);assert.equal((await harness(v).handler(request(`/${draft}`),env)).status,502);}
 const anon=createHandler({fetchImpl:async()=>Response.json({id:user,is_anonymous:true})});assert.equal((await anon(request(),env)).status,403);
});
test('fiscal draft route methods and CORS never allow deletion or an unrelated origin',async()=>{
 for(const [path,method]of[['','DELETE'],[`/${draft}`,'POST'],[`/${draft}/archive`,'PATCH'],[`/${draft}/refresh`,'GET']])assert.equal((await harness({}).handler(request(path,method),env)).status,405);
 for(const path of ['/other',`/${draft}/unknown`])assert.equal((await harness({}).handler(request(path),env)).status,404);
 const h=harness({});const req=new Request('https://api.example.test/v1/rascunhos-fiscais',{method:'OPTIONS',headers:{Origin:'https://erp.example.test','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'Authorization, Content-Type'}});
 assert.equal((await h.handler(req,env)).status,204);assert.equal(h.calls.length,0);req.headers.set('Origin','https://other.invalid');assert.equal((await h.handler(req,env)).status,403);
});
test('fiscal snapshots have a dedicated bounded 4 MiB response budget',async()=>{
 const run=async(size)=>createHandler({fetchImpl:async url=>url.endsWith('/auth/v1/user')?Response.json({id:user}):new Response(JSON.stringify(list()),{headers:{'Content-Type':'application/json','Content-Length':String(size)}})})(request(),env);
 assert.equal((await run(1024*1024+1)).status,200);
 assert.equal((await run(4*1024*1024+1)).status,502);
});
