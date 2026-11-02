import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { Pool } from 'pg';
import { migrateAll } from '../src/migrate.mjs';
import { bootstrap } from '../src/bootstrap.mjs';
import { createAuth } from '../src/auth.mjs';
import { createApp } from '../src/app.mjs';
import { configuration } from '../src/config.mjs';

test('configuration requires a protected production origin and strong session secret',()=>{
 const base={DATABASE_URL:'postgresql://localhost/fagoo',BETTER_AUTH_SECRET:'test-secret-with-at-least-32-characters'};
 assert.throws(()=>configuration({...base,FAGOO_PUBLIC_URL:'http://public.example'}));
 assert.throws(()=>configuration({...base,FAGOO_PUBLIC_URL:'https://example.test/path'}));
 assert.throws(()=>configuration({...base,BETTER_AUTH_SECRET:'short'}));
 assert.equal(configuration({...base,FAGOO_PUBLIC_URL:'http://localhost:3000'}).production,false);
});

test('fresh PostgreSQL installation, browser auth, scoped agent, MCP and native PKCE',{skip:!process.env.FAGOO_TEST_DATABASE_URL},async t=>{
 const source=new URL(process.env.FAGOO_TEST_DATABASE_URL);
 assert.ok(['127.0.0.1','localhost'].includes(source.hostname),'Integration tests require a local database');
 const name='fagoo_test_'+randomUUID().replaceAll('-','');const admin=new Pool({connectionString:source.href,max:2});
 await admin.query(`CREATE DATABASE ${name}`);source.pathname='/'+name;
 const pool=new Pool({connectionString:source.href,max:8});
 const config=configuration({DATABASE_URL:source.href,FAGOO_PUBLIC_URL:'http://localhost:3000',BETTER_AUTH_SECRET:'test-secret-with-at-least-32-characters'});
 try{
  await migrateAll(pool,config);const initial=await bootstrap(pool,config,{email:'admin@example.test',password:'test-password-long-enough',name:'Administrator',company:'Test Company'});
  await assert.rejects(()=>bootstrap(pool,config,{email:'other@example.test',password:'test-password-long-enough',name:'Other',company:'Other'}),/already initialized/);
  const auth=createAuth(pool,config),app=createApp({pool,auth,config,update:async()=>({status:'idle',latest:null,backup:null})});
  const request=(path,{method='GET',data,cookie,token,origin=config.publicUrl,headers={}}={})=>app(new Request(config.publicUrl+path,{method,headers:{...(data?{'Content-Type':'application/json'}:{}),...(cookie?{cookie}:{}),...(token?{Authorization:`Bearer ${token}`}:{ }),...(origin?{Origin:origin}:{}),...headers},...(data?{body:JSON.stringify(data)}:{})}));
  let cookie,machineToken,machineId;
  await t.test('sign-up is closed, sign-in works and discovery contains no credentials',async()=>{
   const denied=await request('/api/auth/sign-up/email',{method:'POST',data:{email:'intruder@example.test',password:'test-password-long-enough',name:'Intruder'}});assert.equal(denied.status,400);
   const login=await request('/api/auth/sign-in/email',{method:'POST',data:{email:'admin@example.test',password:'test-password-long-enough'}});assert.equal(login.status,200,await login.clone().text());cookie=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');assert.ok(cookie);
   const discovery=await(await request('/.well-known/fagoo.json')).json();assert.equal(discovery.product,'fagoo');assert.ok(discovery.server_id);assert.equal(discovery.capabilities.mobile_pkce,true);
   assert.equal((await request('/api/v1/me')).status,401);assert.equal((await request('/api/v1/me',{cookie})).status,200);
  });
  await t.test('browser writes require origin; integration token cannot administer the installation',async()=>{
   const data={name:'Team bot',scopes:['catalog:read','catalog:write','orders:read','orders:write','stock:read','stock:write','finance:read','finance:write','analytics:read','events:read','events:write','fiscal:read']};
   assert.equal((await request('/api/v1/integrations',{cookie,method:'POST',data,origin:'https://other.example'})).status,403);
   const created=await request('/api/v1/integrations',{cookie,method:'POST',data});assert.equal(created.status,201);const value=await created.json();machineToken=value.token;machineId=value.id;
   assert.equal((await request('/api/v1/integrations',{token:machineToken})).status,403);
   const listed=await(await request('/api/v1/integrations',{cookie})).text();assert.ok(!listed.includes(machineToken));assert.ok(!listed.includes('token_hash'));
  });
  await t.test('external agent negotiates MCP, creates once, reads through API and sees no admin tool',async()=>{
   const call=(method,params)=>request('/api/mcp',{method:'POST',token:machineToken,data:{jsonrpc:'2.0',id:1,method,params}});
   const init=await(await call('initialize',{})).json();assert.equal(init.result.serverInfo.name,'FAGOO');
   const listed=await(await call('tools/list',{})).json();assert.ok(listed.result.tools.some(t=>t.name==='fagoo_create_product'));assert.ok(!listed.result.tools.some(t=>t.name.includes('update_system')));
   const args={command_id:randomUUID(),name:'Test product',code:'TEST-1',sale_price:'12.50',cost_price:'5.00',stock_min:'2',stock_max:'20'};
   const first=await(await call('tools/call',{name:'fagoo_create_product',arguments:args})).json();assert.equal(first.result.isError,false,JSON.stringify(first));
   const repeat=await(await call('tools/call',{name:'fagoo_create_product',arguments:args})).json();assert.equal(repeat.result.structuredContent.replayed,true);
   const products=await(await request('/api/v1/products',{token:machineToken})).json();assert.equal(products.items.length,1);
  });
  await t.test('staff access is restricted and the last administrator cannot be disabled',async()=>{
   const created=await request('/api/v1/users',{cookie,method:'POST',data:{name:'Reader',email:'reader@example.test',password:'test-password-long-enough',role:'operator',scopes:['catalog:read']}});assert.equal(created.status,201,await created.clone().text());
   const login=await request('/api/auth/sign-in/email',{method:'POST',data:{email:'reader@example.test',password:'test-password-long-enough'}});const staffCookie=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
   assert.equal((await request('/api/v1/system/updates',{cookie:staffCookie})).status,403);
   assert.equal((await request('/api/v1/users/'+initial.userId,{cookie,method:'PATCH',data:{role:'operator',scopes:[],active:false}})).status,409);
  });
  await t.test('external agent completes procurement, receipt, installments and sales through scoped tools',async()=>{
   const call=async(name,args={})=>{
    const result=await(await request('/api/mcp',{method:'POST',token:machineToken,data:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}}})).json();
    assert.ok(result.result&&!result.result.isError,JSON.stringify(result));return result.result.structuredContent;
   };
   const p=(await call('fagoo_products')).items[0],warehouse=(await call('fagoo_warehouses')).items[0];
   const supplier=(await call('fagoo_create_contact',{command_id:randomUUID(),name:'Synthetic supplier',kind:'supplier'})).contact;
   await call('fagoo_link_supplier_product',{command_id:randomUUID(),resource_id:p.id,expected_version:p.version,supplier_id:supplier.id,code:'SUP-TEST',unit_factor:'1',price:'5.00'});
   assert.equal((await call('fagoo_product',{resource_id:p.id})).suppliers[0].code,'SUP-TEST');
   const customer=(await call('fagoo_create_contact',{command_id:randomUUID(),name:'Synthetic customer',kind:'customer',payment_terms:'30 dias'})).contact;
   const purchase=await call('fagoo_create_order',{command_id:randomUUID(),kind:'purchase',contact_id:supplier.id,warehouse_id:warehouse.id,items:[{product_id:p.id,quantity:'4',unit_price:'5.00'}]});
   const confirmed=await call('fagoo_confirm_order',{command_id:randomUUID(),resource_id:purchase.order.id,expected_version:purchase.order.version});
   const receipt={command_id:randomUUID(),resource_id:purchase.order.id,expected_version:confirmed.order.version,confirmed:true,items:[{item_id:purchase.items[0].id,quantity:'4'}]};
   const received=await call('fagoo_receive_order',receipt);assert.equal((await call('fagoo_receive_order',receipt)).replayed,true);
   const finance=await call('fagoo_post_finance',{command_id:randomUUID(),resource_id:purchase.order.id,expected_version:received.order.version,installments:[{due_on:'2027-01-01',amount:'20.00'}]});
   assert.equal(finance.cash_movement_performed,false);
   const sale=await call('fagoo_create_order',{command_id:randomUUID(),kind:'sale',contact_id:customer.id,warehouse_id:warehouse.id,items:[{product_id:p.id,quantity:'1'}]});assert.equal(sale.order.total,'12.50');
   const saleConfirmed=await call('fagoo_confirm_order',{command_id:randomUUID(),resource_id:sale.order.id,expected_version:sale.order.version});
   await call('fagoo_fulfill_order',{command_id:randomUUID(),resource_id:sale.order.id,expected_version:saleConfirmed.order.version,confirmed:true});
   assert.equal((await call('fagoo_stock',{warehouse_id:warehouse.id})).items[0].quantity,'3.000000');
   assert.equal((await call('fagoo_stock_movements',{product_id:p.id})).items.length,2);
   const context=await call('fagoo_customer_context',{contact_id:customer.id,product_id:p.id,quantity:'1',payment_terms:'30 dias'});
   assert.equal(context.last_purchase.order_id,sale.order.id);assert.equal(context.current_price,'12.5000000000');
   const today=new Date().toISOString().slice(0,10),from=today.slice(0,4)+'-01-01';
   const replenishment=await call('fagoo_replenishment_context',{from,to:today,limit:1});assert.equal(replenishment.coverage.partial,false);assert.equal(replenishment.items[0].sold,'1.000000');
   const series=await call('fagoo_sales_series',{from,to:today,group:'customer_product_month'});assert.equal(series.items.length,1);
   assert.equal((await call('fagoo_received_invoices')).items.length,0);
   assert.equal((await call('fagoo_payables')).items.length,1);
   const events=await call('fagoo_events');assert.ok(events.items.some(item=>item.type==='purchase.received'));
   await call('fagoo_ack_events',{command_id:randomUUID(),sequence:events.next_after});assert.equal((await call('fagoo_events')).items.length,0);
  });
  await t.test('webhook administration and delivery inspection are inaccessible to the team token',async()=>{
   assert.equal((await request('/api/v1/integrations/webhooks',{token:machineToken})).status,403);
   const created=await request('/api/v1/integrations/webhooks',{cookie,method:'POST',data:{name:'Synthetic listener',url:'https://events.example.test/fagoo',event_types:['*']}});
   assert.equal(created.status,201,await created.clone().text());const subscription=await created.json();
   const list=await request('/api/v1/integrations/webhooks',{cookie});assert.equal(list.status,200);
   const deliveries=await request('/api/v1/integrations/webhooks/'+subscription.id+'/deliveries',{cookie});assert.equal(deliveries.status,200,await deliveries.clone().text());
   assert.equal((await request('/api/v1/integrations/webhooks/'+subscription.id,{cookie,method:'DELETE'})).status,200);
  });
  await t.test('native OAuth public client requires PKCE and advertises S256',async()=>{
   const result=await request('/api/v1/mobile/client',{cookie,method:'POST',data:{}});assert.equal(result.status,201,await result.clone().text());const client=await result.json();assert.ok(client.client_id);
   const metadata=await(await request('/.well-known/oauth-authorization-server/api/auth')).json();assert.ok(metadata.code_challenge_methods_supported.includes('S256'));
   const args=new URLSearchParams({client_id:client.client_id,redirect_uri:'app.fagoo://oauth/callback',response_type:'code',scope:'openid profile email fagoo',state:'test-state'});
   const refused=await request('/api/auth/oauth2/authorize?'+args,{cookie});assert.ok(refused.status>=400||refused.headers.get('location')?.includes('error='),'Authorization without PKCE must fail');
   const verifier='a'.repeat(64);args.set('code_challenge',createHash('sha256').update(verifier).digest('base64url'));args.set('code_challenge_method','S256');
   const authorization=await request('/api/auth/oauth2/authorize?'+args,{cookie});assert.ok([200,302,303].includes(authorization.status),await authorization.clone().text());
   const authLocation=authorization.headers.get('location')||((await authorization.clone().json()).url);
   const consentQuery=new URL(authLocation,config.publicUrl).search.slice(1);assert.ok(new URLSearchParams(consentQuery).get('sig'),'Provider must sign the consent query');
   const consent=await request('/api/auth/oauth2/consent',{cookie,method:'POST',data:{oauth_query:consentQuery,accept:true}});assert.equal(consent.status,200,await consent.clone().text());
   const consentData=await consent.json();const callback=consentData.redirect_uri||consentData.url;assert.ok(callback,'Consent returns the registered callback');
   const code=new URL(callback).searchParams.get('code');assert.ok(code);
   const tokenRequest=new URLSearchParams({grant_type:'authorization_code',client_id:client.client_id,redirect_uri:'app.fagoo://oauth/callback',code,code_verifier:verifier});
   const tokenResponse=await app(new Request(config.publicUrl+'/api/auth/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:tokenRequest}));
   assert.equal(tokenResponse.status,200,await tokenResponse.clone().text());const tokens=await tokenResponse.json();assert.ok(tokens.access_token);
   const native=await request('/api/v1/me',{token:tokens.access_token,origin:null});assert.equal(native.status,200,await native.clone().text());assert.equal((await native.json()).user.id,initial.userId);
  });
  await t.test('revoked machine token stops immediately',async()=>{assert.equal((await request('/api/v1/integrations/'+machineId,{cookie,method:'DELETE'})).status,200);assert.equal((await request('/api/v1/products',{token:machineToken})).status,401);});
 }finally{await pool.end();await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);await admin.end();}
});
