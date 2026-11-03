import test from'node:test';import assert from'node:assert/strict';import{randomUUID}from'node:crypto';
import{createHandler}from'../src/index.mjs';
import{parseCatalogMirrorRoute,catalogMirrorMethods}from'../src/catalog-mirror.mjs';
import{espelhoHFixture}from'./helpers/espelho-h-fixture.mjs';

// Leva H, lane espelho (350-352): /v1/espelho-origin over the real SQL answers of the synthetic fixture. Synthetic data only.
const env={SUPABASE_URL:'https://project.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-350',ALLOWED_ORIGINS:'https://erp.synthetic.test'};
const req=(p,init)=>new Request('https://api.synthetic.test'+p,init);
const post=(p,b)=>req(p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});

test('350 /v1/espelho-origin routes are closed',async()=>{
 const id=randomUUID(),command=randomUUID();
 assert.deepEqual(catalogMirrorMethods(`/v1/espelho-origin/cadastros/products/${id}`),['GET']);
 assert.deepEqual(catalogMirrorMethods('/v1/espelho-origin/categorias/sincronizar'),['POST']);
 assert.deepEqual(await parseCatalogMirrorRoute(req(`/v1/espelho-origin/cadastros/contacts/${id}`)),{action:'record',entity:'contacts',id});
 assert.deepEqual(await parseCatalogMirrorRoute(req('/v1/espelho-origin/exclusoes?limit=10')),{action:'deletions',limit:10,after:null});
 assert.deepEqual(await parseCatalogMirrorRoute(post(`/v1/espelho-origin/exclusoes/${id}`,{command_id:command,expected_version:3,action:'delete'})),{action:'deletion-apply',id,command_id:command,expected_version:3,apply:'delete'});
 for(const[p,status]of[[`/v1/espelho-origin/cadastros/warehouses/${id}`,404],['/v1/espelho-origin/cadastros/products/abc',404],['/v1/espelho-origin/exclusoes?limit=0',400],['/v1/espelho-origin/exclusoes?x=1',400],['/v1/espelho-origin/categorias?x=1',400]])
  await assert.rejects(()=>parseCatalogMirrorRoute(req(p)),e=>e.status===status,p);
 for(const bad of[{command_id:command,expected_version:0,action:'delete'},{command_id:command,expected_version:1,action:'apagar'},{command_id:'x',expected_version:1,action:'delete'},{command_id:command,expected_version:1,action:'delete',x:1}])
  await assert.rejects(()=>parseCatalogMirrorRoute(post(`/v1/espelho-origin/exclusoes/${id}`,bad)),e=>e.status===400,JSON.stringify(bad));
 await assert.rejects(()=>parseCatalogMirrorRoute(post(`/v1/espelho-origin/transportadores/${id}`,{command_id:command,carrier:'sim'})),e=>e.status===400);
 await assert.rejects(()=>parseCatalogMirrorRoute(req(`/v1/espelho-origin/transportadores/${id}`,{method:'POST',headers:{'content-type':'text/plain'},body:'{}'})),e=>e.status===415);
});

test('350-352 the Worker answers Dados do Origin, categories, deletions and the carrier complement from the database',async()=>{const f=await espelhoHFixture();try{
 let actor=f.users.admin;
 const h=createHandler({fetchImpl:async(url,o)=>{
  if(url.endsWith('/auth/v1/user'))return Response.json({id:actor});
  const name=/\/rest\/v1\/rpc\/([a-z0-9_]+)$/.exec(url)?.[1];assert.ok(name,url);
  try{return Response.json(await f.rpc(name,JSON.parse(o.body)));}catch(e){return Response.json({code:e.code,message:e.message},{status:400});}
 }});
 const call=async(p,init={})=>{const r=await h(req(p,{...init,headers:{Authorization:'Bearer t',Origin:'https://erp.synthetic.test',...(init.body?{'content-type':'application/json'}:{}),...init.headers}}),env);return{status:r.status,body:await r.json()};};
 await f.mirror('contacts','901',{id:901,nome:'Transportes Sintéticos',situacao:'A',tipo:'J',tiposContato:[{descricao:'Transportador'}],emailNotaFiscal:'nf@sintetico.test',endereco:{cobranca:{municipio:'Campinas',uf:'SP'}}});
 await f.mirror('products','902',{id:902,nome:'Produto Sintético',codigo:'P902',situacao:'A',tipo:'P',formato:'S',preco:1,marca:'M',estoque:{localizacao:'B-2'}});
 await f.importOrigin('contacts',['901']);await f.importOrigin('products',['902']);
 const contact=await f.scalar("select record_id v from erp_catalog.origin where source_id='901'"),product=await f.scalar("select record_id v from erp_catalog.origin where source_id='902'");
 const c=await call(`/v1/espelho-origin/cadastros/contacts/${contact}`);
 assert.equal(c.status,200);assert.equal(c.body.fields.nfe_email,'nf@sintetico.test');assert.deepEqual(c.body.fields.billing_address,{city:'Campinas',state:'SP'});assert.deepEqual(c.body.fields.source_roles,['carrier']);
 assert.equal((await call(`/v1/espelho-origin/cadastros/products/${product}`)).body.fields.location,'B-2');
 assert.equal((await call(`/v1/espelho-origin/cadastros/products/${randomUUID()}`)).status,404);
 // Categories: sync by the administrador only, then listed with their origin.
 await f.mirror('product_categories','31',{id:31,descricao:'Raiz',categoriaPai:{id:0}});await f.mirror('product_categories','32',{id:32,descricao:'Filha',categoriaPai:{id:31}});
 const command=randomUUID(),synced=await call('/v1/espelho-origin/categorias/sincronizar',{method:'POST',body:JSON.stringify({command_id:command})});
 assert.equal(synced.status,200);assert.deepEqual(synced.body.counts,{created:2});
 assert.equal((await call('/v1/espelho-origin/categorias/sincronizar',{method:'POST',body:JSON.stringify({command_id:command})})).body.replayed,true);
 const listed=await call('/v1/espelho-origin/categorias');assert.equal(listed.body.items.length,2);assert.equal(listed.body.pending,0);
 // Deletions: excluded in the Origin, applied by the administrador.
 await f.mirror('products','902',{id:902,nome:'Produto Sintético',codigo:'P902',situacao:'E',tipo:'P',formato:'S',preco:1});await f.importOrigin('products',['902']);
 const pending=await call('/v1/espelho-origin/exclusoes');assert.equal(pending.body.items.length,1);
 const applied=await call(`/v1/espelho-origin/exclusoes/${product}`,{method:'POST',body:JSON.stringify({command_id:randomUUID(),expected_version:pending.body.items[0].version,action:'delete'})});
 assert.equal(applied.status,200);assert.equal(applied.body.deleted,true);
 assert.equal((await call(`/v1/espelho-origin/exclusoes/${product}`,{method:'POST',body:JSON.stringify({command_id:randomUUID(),expected_version:applied.body.version,action:'delete'})})).status,409);
 // Carrier complement and the Transportador options of the contacts API (carrier_match passes the Worker check).
 await f.mirror('contacts','903',{id:903,nome:'Cliente Sintético',situacao:'A',tipo:'F',tiposContato:[{descricao:'Cliente'}]});await f.importOrigin('contacts',['903']);
 const client=await f.scalar("select record_id v from erp_catalog.origin where source_id='903'");
 actor=f.users.vendas;
 const marked=await call(`/v1/espelho-origin/transportadores/${client}`,{method:'POST',body:JSON.stringify({command_id:randomUUID(),carrier:true})});
 assert.equal(marked.status,200);assert.equal(marked.body.carrier_match,'complement');
 const options=await call('/v1/cadastros/contatos/opcoes?papel=transportador');
 assert.equal(options.status,200,JSON.stringify(options.body));assert.deepEqual(options.body.items.map(i=>[i.name,i.carrier_match]),[['Cliente Sintético','complement'],['Transportes Sintéticos','role']]);
 actor=f.users.consulta;
 assert.equal((await call('/v1/espelho-origin/categorias/sincronizar',{method:'POST',body:JSON.stringify({command_id:randomUUID()})})).status,403);
}finally{await f.close();}});
