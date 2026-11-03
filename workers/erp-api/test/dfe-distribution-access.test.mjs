import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../src/index.mjs';
const uid='a0000000-0000-4000-8000-000000000001',id='b0000000-0000-4000-8000-000000000001';
const env={SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-key',ALLOWED_ORIGINS:'https://erp.example.test'};
const base='/v1/notas-recebidas';
const configuration={command_id:id,environment:'2',expected_version:0,expected_identity_version:1,coordinator:'external',checkpoint:null,checkpoint_confirmed:false,other_consumers_reviewed:false,collection_requested:false,reason:'Coordenação externa pendente'};
const cases=[
 [base+'/settings?environment=2','GET','erp_dfe_settings'],
 [base+'/settings','POST','erp_dfe_configure',configuration],
 [base+`/commands/${id}`,'GET','erp_dfe_command'],
 [base+`/documents?channel_id=${id}`,'GET','erp_dfe_documents'],
 [base+`/documents/${id}/download`,'GET','erp_dfe_object'],
];
const req=(path,options={})=>new Request('https://api.example.test'+path,options);
test('045 boundary requires authentication and exact origin/method on every public route',async()=>{
 let calls=0;const handler=createHandler({fetchImpl:async()=>{calls++;throw Error('unexpected');}});
 for(const[path,method]of cases){
  assert.equal((await handler(req(path,{method}),env)).status,401);
  for(const candidate of ['GET','POST','PATCH','DELETE']){
   const allowed=path.split('?')[0]===base+'/settings'?['GET','POST']:[method];
   const r=await handler(req(path,{method:'OPTIONS',headers:{Origin:env.ALLOWED_ORIGINS,'Access-Control-Request-Method':candidate,'Access-Control-Request-Headers':'authorization,content-type'}}),env);
   assert.equal(r.status,allowed.includes(candidate)?204:403);assert.equal(r.headers.get('Cache-Control'),'no-store');
  }
 }
 assert.equal((await handler(req(base+'/settings?environment=2',{headers:{Origin:'https://other.example.test'}}),env)).status,403);assert.equal(calls,0);
});
test('045 boundary injects the verified actor, preserves SQL status and sanitizes private diagnostics',async()=>{
 for(const[path,method,rpc,body]of cases)for(const[code,status]of [['42501',403],['40001',409],['22023',400],['55000',503],['P0002',404]]){
  const calls=[],handler=createHandler({fetchImpl:async(url,options)=>{calls.push({url,options});return url.endsWith('/auth/v1/user')?Response.json({id:uid}):Response.json({code,message:'PRIVATE_DFE_CONTEXT'},{status:400});}});
  const r=await handler(req(path,{method,headers:{Authorization:'Bearer synthetic','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}),env);
  assert.equal(r.status,status);assert.equal(calls.length,2);assert.ok(calls[1].url.endsWith('/rpc/'+rpc));
  assert.equal(JSON.parse(calls[1].options.body).p_user_id,uid);assert.doesNotMatch(await r.text(),/PRIVATE_DFE_CONTEXT/);
 }
});
test('045 runtime actions and client-selected actor/storage are never exposed through the ERP API',async()=>{
 let calls=0;const handler=createHandler({fetchImpl:async()=>{calls++;return Response.json({id:uid});}});
 for(const action of ['reserve','dispatch','finalize','renew','uncertain','abandon']){
  assert.equal((await handler(req(base+'/'+action,{headers:{Authorization:'Bearer synthetic'}}),env)).status,404);
 }
 for(const extra of [{user_id:uid},{bucket:'foreign'},{path:'objects/x.xml'},{xml:'<private/>'}]){
  const before=calls,r=await handler(req(base+'/settings',{method:'POST',headers:{Authorization:'Bearer synthetic','Content-Type':'application/json'},body:JSON.stringify({...configuration,...extra})}),env);
  assert.equal(r.status,400);assert.equal(calls-before,1);
 }
});
test('045 null configuration is read-only and does not imply an initial NSU or activation',async()=>{
 const value={data_mode:'received_dfe',model:'55',transport_enabled:false,can_query:false,can_manifest:false,can_emit:false,origin_authenticated:false,signature_verified:false,xsd_validated:false,sefaz_authorized:false,financial_mutation_performed:false,stock_mutation_performed:false,current:null};
 const handler=createHandler({fetchImpl:async(url)=>Response.json(url.endsWith('/auth/v1/user')?{id:uid}:value)});
 const r=await handler(req(base+'/settings?environment=2',{headers:{Authorization:'Bearer synthetic',Origin:env.ALLOWED_ORIGINS}}),env);
 assert.equal(r.status,200);assert.deepEqual(await r.json(),value);assert.equal(r.headers.get('Access-Control-Allow-Origin'),env.ALLOWED_ORIGINS);
});
test('045 full download boundary keeps storage credentials server-side and delivers verified bytes with safe headers',async()=>{
 const {createHash}=await import('node:crypto'),{buildAccessKey}=await import('../../../packages/fiscal-core/src/identity.mjs');
 const bytes=Buffer.from('<resNFe>DOWNLOAD SINTETICO</resNFe>'),hash=createHash('sha256').update(bytes).digest('hex');
 const accessKey=buildAccessKey({cUF:'35',cnpj:'12345678000195',model:'55',environment:'2',series:'1',number:'1',issuedAt:'2026-10-16T10:00:00-03:00',cNF:'12345678',tpEmis:'1'});
 const meta={data_mode:'received_dfe',model:'55',transport_enabled:false,can_query:false,can_manifest:false,can_emit:false,origin_authenticated:false,signature_verified:false,xsd_validated:false,sefaz_authorized:false,financial_mutation_performed:false,stock_mutation_performed:false,bucket:'brufap-received-dfe',object_key:`objects/${hash}.xml`,filename:`RESUMO_NFE_${id}.xml`,document:{id,channel_id:uid,nsu:'000000000000001',kind:'invoice_summary',schema:'resNFe_v1.01.xsd',model:'55',access_key:accessKey,recipient_match:null,quarantined:false,xml_hash:hash,size_bytes:bytes.length,collected_at:'2026-10-16T12:00:00Z',is_complete_invoice:false}};
 const calls=[],handler=createHandler({fetchImpl:async(url,options)=>{
  calls.push({url,options});
  if(url.endsWith('/auth/v1/user'))return Response.json({id:uid});
  if(url.includes('/rest/v1/rpc/'))return Response.json(meta);
  assert.equal(url,env.SUPABASE_URL+'/storage/v1/object/authenticated/brufap-received-dfe/objects/'+hash+'.xml');
  assert.equal(options.headers.Authorization,'Bearer '+env.SUPABASE_SERVICE_ROLE_KEY);assert.equal(options.redirect,'manual');assert.ok(options.signal instanceof AbortSignal);
  return new Response(bytes,{headers:{'Content-Type':'application/octet-stream','Content-Length':String(bytes.length)}});
 }});
 const r=await handler(req(base+`/documents/${id}/download`,{headers:{Authorization:'Bearer synthetic',Origin:env.ALLOWED_ORIGINS}}),env);
 assert.equal(r.status,200);assert.deepEqual(Buffer.from(await r.arrayBuffer()),bytes);assert.equal(calls.length,4);
 assert.equal(r.headers.get('Content-Type'),'application/octet-stream');assert.equal(r.headers.get('Content-Disposition'),`attachment; filename="RESUMO_NFE_${id}.xml"`);assert.match(r.headers.get('Content-Security-Policy'),/sandbox/);assert.equal(r.headers.get('Access-Control-Allow-Origin'),env.ALLOWED_ORIGINS);assert.equal(r.headers.get('Cache-Control'),'no-store');
 assert.doesNotMatch(JSON.stringify([...r.headers]),/synthetic-service-key|object_key/);
});
