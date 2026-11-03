import test from'node:test';import assert from'node:assert/strict';
import{parsePreferencesRoute as parse,preferencesMethods}from'../src/preferences.mjs';
import{parseActivity,captureActivityQuery,parseFiles,captureFilesQuery}from'../../../packages/erp-domain/src/activity.mjs';
import{createHandler}from'../src/index.mjs';
const ACTOR='10000000-0000-4000-8000-000000000118',DOC='40000000-0000-4000-8000-000000000118',FILE='50000000-0000-4000-8000-000000000118',STAMP='2026-10-20T12:00:00.000000+00:00';
const req=path=>new Request('https://synthetic.invalid'+path);
const entry=(over={})=>({source:'catalog',id:'7',created_at:STAMP,actor:{user_id:ACTOR,label:'Administrador'},module:'produtos',operation:'criacao',code:'SINT-1',description:'Produto sintético',...over});
const activity=(q,items=[entry()])=>({scope:'activity',data_mode:'erp_native',from:q.from,to:q.to,module:q.module,operation:q.operation,actor:q.actor,query:q.q,limit:q.limit,offset:q.offset,total:items.length,has_more:false,items});
// 263: erp_files_list_v2 (every origin; each item carries its origin and source).
const file=(over={})=>({id:FILE,origin:'documentos',filename:'contrato.pdf',mime_type:'application/pdf',size_bytes:2048,sha256:'a'.repeat(64),created_at:STAMP,owner:{user_id:ACTOR,label:'Administrador'},source:{kind:'sales_orders',id:DOC,code:'1001',label:'Cliente sintético'},...over});
const files=(q,items=[file()])=>({scope:'files',data_mode:'erp_native',query:q.q,from:q.from,to:q.to,order:q.order,origin:q.origin,limit:q.limit,offset:q.offset,total:items.length,total_bytes:'2048',has_more:false,items});

test('118 strict query parameters for the activity log and the file manager',async()=>{
 assert.deepEqual(preferencesMethods('/v1/registro-atividades'),['GET']);assert.deepEqual(preferencesMethods('/v1/gerenciador-arquivos'),['GET']);
 assert.deepEqual({...(await parse(req('/v1/registro-atividades?de=2026-10-01&ate=2026-10-20&operacao=exclusao&q=%20SINT%20'))).args},{p_from:'2026-10-01',p_to:'2026-10-20',p_module:null,p_operation:'exclusao',p_actor:null,p_query:'sint',p_limit:100,p_offset:0});
 // 186: the modules of waves A and B (Caixa, Pagamento/Recebimento, Certificado Digital, Meu Negócio) are accepted.
 for(const module of['caixa','pagamento_recebimento','certificado_digital','meu_negocio','comissao','campos_customizados'])assert.equal((await parse(req(`/v1/registro-atividades?de=2026-10-01&ate=2026-10-20&modulo=${module}`))).args.p_module,module);
 assert.equal(parseActivity(activity(captureActivityQuery({from:'2026-10-01',to:'2026-10-20',module:'caixa'}),[entry({source:'finance',module:'caixa',operation:'transferencia'})]),captureActivityQuery({from:'2026-10-01',to:'2026-10-20',module:'caixa'})).items[0].source,'finance');
 for(const path of['/v1/registro-atividades','/v1/registro-atividades?de=2026-10-01','/v1/registro-atividades?de=2025-01-01&ate=2026-10-20','/v1/registro-atividades?de=2026-10-02&ate=2026-10-01',
  '/v1/registro-atividades?de=2026-10-01&ate=2026-10-20&modulo=marketplace','/v1/registro-atividades?de=2026-10-01&ate=2026-10-20&modulo=cotacoes_frenet','/v1/registro-atividades?de=2026-10-01&ate=2026-10-20&usuario=x','/v1/registro-atividades?de=2026-10-01&ate=2026-10-20&x=1',
  '/v1/gerenciador-arquivos?ordem=peso','/v1/gerenciador-arquivos?de=2026-10-01','/v1/gerenciador-arquivos?limit=0','/v1/gerenciador-arquivos?origem=outros','/v1/gerenciador-arquivos?origem=empresa&origem=produtos'])await assert.rejects(()=>parse(req(path)),e=>e.status===400,path);
 // 263: the module Frente de Caixa.
 assert.equal((await parse(req('/v1/registro-atividades?de=2026-10-01&ate=2026-10-20&modulo=frente_caixa'))).args.p_module,'frente_caixa');
 await assert.rejects(()=>parse(req('/v1/registro-atividades/x')),e=>e.status===404);
 assert.deepEqual({...(await parse(req('/v1/gerenciador-arquivos?ordem=tamanho&q=Contrato'))).args},{p_query:'contrato',p_from:null,p_to:null,p_order:'tamanho',p_origin:null,p_limit:100,p_offset:0});
 assert.deepEqual({...(await parse(req('/v1/gerenciador-arquivos?origem=empresa'))).args},{p_query:null,p_from:null,p_to:null,p_order:'data',p_origin:'empresa',p_limit:100,p_offset:0});
});
test('118 projections are exact and match the query',()=>{
 const q=captureActivityQuery({from:'2026-10-01',to:'2026-10-20',operation:'criacao'});assert.equal(parseActivity(activity(q),q).items.length,1);
 for(const mutate of[v=>v.items[0].operation='exclusao',v=>v.items[0].module='marketplace',v=>v.items[0].extra=1,v=>v.from='2026-10-02',v=>v.total=5,v=>v.items.push({...v.items[0]}),
  v=>v.items.push(entry({id:'8',created_at:'2026-10-21T12:00:00Z'})),v=>v.items[0].actor={user_id:ACTOR}])
 {const r=activity(q);mutate(r);if(r.items.length===2)r.total=2;assert.throws(()=>parseActivity(r,q),undefined,String(mutate));}
 const f=captureFilesQuery({});assert.equal(parseFiles(files(f),f).items.length,1);
 for(const mutate of[v=>v.items[0].mime_type='text/html',v=>v.items[0].sha256='x',v=>v.items[0].source.kind='nfe',v=>v.total_bytes=2048,v=>v.items[0].size_bytes=0,v=>v.items[0].origin='outros',
  v=>v.items[0].source.code=null,v=>{v.items[0].origin='contatos';},v=>{v.items[0].origin='produtos';v.items[0].source.kind='product';},v=>{v.items[0].origin='empresa';v.items[0].source={kind:'logo',id:DOC,code:null,label:null};v.items[0].mime_type='image/png';},v=>delete v.origin])
 {const r=files(f);mutate(r);assert.throws(()=>parseFiles(r,f),undefined,String(mutate));}
 const only=captureFilesQuery({origin:'produtos'});assert.throws(()=>parseFiles(files(only),only),undefined,'an item of another origin than the filter');
 assert.equal(parseFiles(files(only,[file({origin:'produtos',mime_type:'image/png',size_bytes:1024,source:{kind:'product',id:DOC,code:'P-1',label:'Produto'}})]),only).items[0].origin,'produtos');
});
const env={SUPABASE_URL:'https://project.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-118',ALLOWED_ORIGINS:'https://erp.synthetic.test'},headers={Authorization:'Bearer synthetic-token',Origin:'https://erp.synthetic.test'};
test('118 real API calls one fixed RPC with the token actor and never exposes upstream errors',async()=>{
 const q=captureActivityQuery({from:'2026-10-01',to:'2026-10-20'}),fq=captureFilesQuery({});
 for(const[path,name,value]of[['/v1/registro-atividades?de=2026-10-01&ate=2026-10-20','erp_activity_list',activity(q)],['/v1/gerenciador-arquivos','erp_files_list_v2',files(fq)]]){
  const calls=[],h=createHandler({fetchImpl:async(url,o)=>{calls.push({url,o});return Response.json(url.endsWith('/auth/v1/user')?{id:ACTOR}:value);}}),r=await h(new Request('https://api.synthetic.test'+path,{headers}),env);
  assert.equal(r.status,200,path);assert.ok(calls[1].url.endsWith('/rest/v1/rpc/'+name));assert.equal(JSON.parse(calls[1].o.body).p_user_id,ACTOR);}
 const denied=createHandler({fetchImpl:async url=>url.endsWith('/auth/v1/user')?Response.json({id:ACTOR}):Response.json({code:'42501',message:'PRIVATE'},{status:403})});
 const r=await denied(new Request('https://api.synthetic.test/v1/gerenciador-arquivos',{headers}),env);assert.equal(r.status,403);assert.doesNotMatch(await r.text(),/PRIVATE/);
 const post=await denied(new Request('https://api.synthetic.test/v1/gerenciador-arquivos',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:'{}'}),env);assert.equal(post.status,405);
});
