import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../src/index.mjs';

const uid='a0000000-0000-4000-8000-000000000001',id='b0000000-0000-4000-8000-000000000001';
const env={SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-key',ALLOWED_ORIGINS:'https://erp.example.test'};
const base='/v1/numeracao-fiscal',token='synthetic-user-token';
const flags={data_mode:'fiscal_numbering',policy:'brufap-homologation-exclusive-v1',environment:'2',can_emit:false,can_transmit:false,authorized:false,financial_mutation_performed:false,stock_mutation_performed:false};
const empty={...flags,read_only:true,items:[],limit:25,has_more:false,next_cursor:null};
const configuration={command_id:id,id:null,expected_version:0,expected_identity_version:1,model:'55',environment:'2',series:'1',initial_number:'23',enabled:true,exclusive_use_confirmed:true,reference:'Série fictícia explicitamente confirmada'};
const reservation={command_id:id,series_id:id,expected_series_version:1,expected_identity_version:1,draft_id:id,expected_draft_version:1,snapshot_hash:'a'.repeat(64),item_preparation_version:1,tax_preparation_version:1,confirm_reserve:true};
const s={id,issuer_cnpj:'11222333000181',cuf:'35',model:'55',environment:'2',series:'1',first_number:'23',next_number:'23',exhausted:false,version:1,identity_version:1,enabled:true,exclusive_use_confirmed:true,reference:configuration.reference,created_at:'2026-10-16T12:00:00Z',updated_at:'2026-10-16T12:00:00Z',company_changed:false};
const configured={...flags,command_id:id,action:'configure',replayed:false,receipt:s,current_series:s,current_basis:null};
const cases=[
 [base+'/series','GET','erp_fiscal_numbering_series'],
 [base+'/series','POST','erp_fiscal_numbering_configure',configuration],
 [base+'/reservations','POST','erp_fiscal_numbering_reserve',reservation],
 [base+`/reservations/${id}`,'GET','erp_fiscal_numbering_reservation'],
 [base+`/drafts/${id}`,'GET','erp_fiscal_numbering_draft'],
 [base+`/commands/${id}`,'GET','erp_fiscal_numbering_command'],
];
const req=(path,options={})=>new Request('https://api.example.test'+path,options);
const authenticated=(path,method='GET',body,headers={})=>req(path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});

test('046 authenticates every route before parsing mutation bodies or invoking business RPCs',async()=>{
 let calls=0;const handler=createHandler({fetchImpl:async()=>{calls++;throw Error('MUST_NOT_CALL');}});
 for(const[path,method]of cases){
  assert.equal((await handler(req(path,{method}),env)).status,401);
  assert.equal((await handler(req(path,{method,headers:{Authorization:'Bearer invalid token'}}),env)).status,401);
 }
 assert.equal(calls,0);
 for(const [authResponse,expectedStatus] of [[Response.json({message:'PRIVATE_AUTH_DETAIL'},{status:401}),401],[Response.json({id:'wrong'}),401],[Response.json({id:uid,is_anonymous:true}),403]]){
  const calls=[],api=createHandler({fetchImpl:async(url)=>{calls.push(url);return authResponse;}}),result=await api(authenticated(base+'/series','POST',configuration),env);
  assert.equal(result.status,expectedStatus);assert.equal(calls.length,1);assert.ok(calls[0].endsWith('/auth/v1/user'));assert.doesNotMatch(await result.text(),/PRIVATE_AUTH_DETAIL|synthetic-service-key/);
 }
});

test('046 preflight uses exact origin, headers and route methods without authentication or RPC',async()=>{
 let calls=0;const handler=createHandler({fetchImpl:async()=>{calls++;throw Error('MUST_NOT_CALL');}});
 for(const[path,method]of cases){
  const allowed=path===base+'/series'?['GET','POST']:[method];
  for(const candidate of ['GET','POST','PUT','PATCH','DELETE']){
   const result=await handler(req(path,{method:'OPTIONS',headers:{Origin:env.ALLOWED_ORIGINS,'Access-Control-Request-Method':candidate,'Access-Control-Request-Headers':'Authorization, Content-Type'}}),env);
   assert.equal(result.status,allowed.includes(candidate)?204:403);assert.equal(result.headers.get('Cache-Control'),'no-store');
   if(result.status===204){assert.equal(result.headers.get('Access-Control-Allow-Origin'),env.ALLOWED_ORIGINS);assert.equal(result.headers.get('Access-Control-Allow-Methods'),allowed.join(', '));assert.equal(await result.text(),'');}
  }
 }
 for(const headers of [{Origin:'https://evil.example.test','Access-Control-Request-Method':'GET'},{Origin:env.ALLOWED_ORIGINS,'Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'x-service-key'},{'Access-Control-Request-Method':'GET'}])assert.equal((await handler(req(base+'/series',{method:'OPTIONS',headers}),env)).status,403);
 assert.equal((await handler(authenticated(base+'/series','GET',undefined,{Origin:'https://evil.example.test'}),env)).status,403);assert.equal((await handler(authenticated(base+'/series','GET',undefined,{Origin:env.ALLOWED_ORIGINS}),{...env,ALLOWED_ORIGINS:''})).status,403);assert.equal(calls,0);
});

test('046 rejects unsupported methods and never exposes reset, release, emit or production-specific actions',async()=>{
 let calls=0;const handler=createHandler({fetchImpl:async()=>{calls++;return Response.json({id:uid});}});
 for(const[path,method]of cases)for(const candidate of ['PUT','PATCH','DELETE']){
  const result=await handler(authenticated(path,candidate),env);assert.equal(result.status,405);assert.equal(result.headers.get('Allow'),(path===base+'/series'?['GET','POST','OPTIONS']:[method,'OPTIONS']).join(', '));
 }
 assert.equal(calls,0);
 for(const path of ['/reset','/emit','/series/'+id+'/reset','/reservations/'+id+'/release']){
  const before=calls,result=await handler(authenticated(base+path),env);assert.equal(result.status,404);assert.equal(calls-before,1);
 }
});

test('046 binds the authenticated actor, keeps service credentials upstream and sanitizes SQL errors',async()=>{
 for(const[path,method,rpc,body]of cases)for(const[code,status]of [['42501',403],['40001',409],['22023',400],['23505',409],['55000',503],['P0002',404]]){
  const calls=[],handler=createHandler({fetchImpl:async(url,options)=>{calls.push({url,options});return url.endsWith('/auth/v1/user')?Response.json({id:uid.toUpperCase()}):Response.json({code,message:'PRIVATE_NUMBERING_CONTEXT',details:env.SUPABASE_SERVICE_ROLE_KEY},{status:400});}});
  const result=await handler(authenticated(path,method,body,{Origin:env.ALLOWED_ORIGINS}),env);assert.equal(result.status,status,rpc+' '+code);assert.equal(calls.length,2);assert.ok(calls[1].url.endsWith('/rpc/'+rpc));
  assert.equal(calls[0].options.headers.Authorization,'Bearer '+token);assert.equal(calls[0].options.headers.apikey,env.SUPABASE_SERVICE_ROLE_KEY);
  assert.equal(JSON.parse(calls[1].options.body).p_user_id,uid);assert.equal(calls[1].options.headers.Authorization,'Bearer '+env.SUPABASE_SERVICE_ROLE_KEY);assert.equal(calls[1].options.headers.apikey,env.SUPABASE_SERVICE_ROLE_KEY);assert.equal(calls[1].options.redirect,'manual');assert.ok(calls[1].options.signal instanceof AbortSignal);
  assert.equal(result.headers.get('Access-Control-Allow-Origin'),env.ALLOWED_ORIGINS);assert.doesNotMatch(await result.text(),/PRIVATE_NUMBERING_CONTEXT|synthetic-service-key|synthetic-user-token/);assert.doesNotMatch(JSON.stringify([...result.headers]),/synthetic-service-key|synthetic-user-token/);
 }
});

test('046 rejects actor overrides, mutable numbers and unsupported body/query options after auth but before RPC',async()=>{
 let calls=0;const handler=createHandler({fetchImpl:async()=>{calls++;return Response.json({id:uid});}});
 const invalid=[[base+'/series?user_id='+id,'GET'],[base+'/series?limit=26','GET'],[base+'/series?model=55&model=65','GET'],[base+'/series','POST',{...configuration,p_user_id:id}],[base+'/series','POST',{...configuration,environment:'1'}],[base+'/series','POST',{...configuration,next_number:'99'}],[base+'/reservations','POST',{...reservation,user_id:id}],[base+'/reservations','POST',{...reservation,number:'99'}],[base+'/reservations','POST',{...reservation,confirm_reserve:false}]];
 for(const[path,method,body]of invalid){const before=calls,result=await handler(authenticated(path,method,body),env);assert.equal(result.status,400);assert.equal(calls-before,1);}
 const before=calls,result=await handler(authenticated(base+'/series','POST',configuration,{'Content-Encoding':'gzip'}),env);assert.equal(result.status,400);assert.equal(calls-before,1);
});

test('046 valid empty GET and explicit configure preserve flags and separate history/current without extra upstream fields',async()=>{
 for(const[path,method,body,value]of [[base+'/series','GET',undefined,empty],[base+'/series','POST',configuration,configured]]){
  const calls=[],handler=createHandler({fetchImpl:async(url,options)=>{calls.push({url,options});return Response.json(url.endsWith('/auth/v1/user')?{id:uid}:{...value,private:{token:env.SUPABASE_SERVICE_ROLE_KEY}});}});
  const result=await handler(authenticated(path,method,body,{Origin:env.ALLOWED_ORIGINS}),env);assert.equal(result.status,200);assert.deepEqual(await result.json(),value);assert.equal(calls.length,2);assert.equal(result.headers.get('Cache-Control'),'no-store');assert.equal(result.headers.get('X-Content-Type-Options'),'nosniff');assert.equal(result.headers.get('Access-Control-Allow-Origin'),env.ALLOWED_ORIGINS);
  if(method==='POST'){const args=JSON.parse(calls[1].options.body);assert.equal(args.p_initial_number,'23');assert.equal(args.p_series,'1');assert.equal(args.p_reference,configuration.reference);assert.equal(args.p_command_id,id);assert.equal(args.p_user_id,uid);}
 }
});

test('046 upstream body limit is enforced before projection, and overclaiming DTOs are rejected',async()=>{
 for(const[bytes,status]of [[100000,200],[132000,502]]){
  const handler=createHandler({fetchImpl:async url=>Response.json(url.endsWith('/auth/v1/user')?{id:uid}:{...empty,extra:'x'.repeat(bytes)})}),result=await handler(authenticated(base+'/series'),env);
  assert.equal(result.status,status);assert.doesNotMatch(await result.text(),/extra|xxxx/);
 }
 const handler=createHandler({fetchImpl:async url=>Response.json(url.endsWith('/auth/v1/user')?{id:uid}:{...empty,can_emit:true})});assert.equal((await handler(authenticated(base+'/series'),env)).status,502);
});

test('046 lost or interrupted RPC responses remain uncertain instead of returning a definitive400',async()=>{
 for(const phase of['headers','body']){
  const calls=[];let upstreamSignal;
  const handler=createHandler({timeoutMs:10,fetchImpl:async(url,options)=>{
   calls.push(url);if(url.endsWith('/auth/v1/user'))return Response.json({id:uid});upstreamSignal=options.signal;
   if(phase==='headers')return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));
   return new Response(new ReadableStream({start(stream){options.signal.addEventListener('abort',()=>stream.error(new DOMException('Aborted','AbortError')),{once:true});}}),{headers:{'Content-Type':'application/json'}});
  }});
  const response=await handler(authenticated(base+'/series','POST',configuration),env);assert.ok([502,503,504].includes(response.status));assert.equal(calls.length,2);assert.equal(upstreamSignal.aborted,true);assert.doesNotMatch(await response.text(),/synthetic-service-key|synthetic-user-token/);
 }
});
