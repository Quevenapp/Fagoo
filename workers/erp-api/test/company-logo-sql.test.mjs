import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {laneEFixture} from './helpers/preferences-e-fixture.mjs';
import {createHandler} from '../src/index.mjs';
import {companyLogoRoute,companyLogoMethods} from '../src/company-logo.mjs';

// Synthetic data only. 262: Empresa › Sua marca (the logo) on PGlite through the real Worker, with an in-memory Storage.
let f,handler;
const files=new Map();
const config={SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-key',ALLOWED_ORIGINS:'https://synthetic.invalid'};
const png=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9kAAAAASUVORK5CYII=','base64'));
const jpeg=Uint8Array.from([255,216,255,224,0,16,74,70,73,70,0,1,1,1,0,72,0,72,0,0,255,217]);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
before(async()=>{
 f=await laneEFixture();
 await f.db.query("insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('erp-attachments','erp-attachments',false,10485760,array['application/pdf','image/png','image/jpeg','application/xml','text/plain'])");
 const fail=(status,code)=>Response.json({code,message:'SANITIZE_SYNTHETIC_SQL_ERROR'},{status});
 handler=createHandler({fetchImpl:async(url,options={})=>{
  const {pathname}=new URL(url);
  if(pathname.endsWith('/auth/v1/user'))return Response.json({id:options.headers.Authorization.slice(7)});
  const object=/^\/storage\/v1\/object\/(?:authenticated\/)?erp-attachments\/(.+)$/.exec(pathname);
  if(object){
   if(options.method==='POST'){
    if(files.has(object[1]))return new Response(null,{status:409});
    const bytes=new Uint8Array(await new Response(options.body).arrayBuffer());files.set(object[1],bytes);
    await f.db.query('insert into storage.objects(bucket_id,name,metadata) values($1,$2,$3::jsonb)',['erp-attachments',object[1],JSON.stringify({size:bytes.length,mimetype:options.headers['Content-Type']})]);
    return new Response(null,{status:200});
   }
   const bytes=files.get(object[1]);return bytes?new Response(bytes,{headers:{'Content-Length':String(bytes.length)}}):new Response(null,{status:404});
  }
  try{return Response.json(await f.rpc(pathname.split('/').at(-1),JSON.parse(options.body)));}
  catch(e){return fail(400,e.code);}
 }});
});
after(async()=>f?.close());
async function call(path,method='GET',body,user=f.users.admin,type='application/json'){
 const response=await handler(new Request('https://api.synthetic.invalid'+path,{method,headers:{Authorization:'Bearer '+user,Origin:'https://synthetic.invalid',...(body!==undefined?{'Content-Type':type}:{})},
  body:body===undefined?undefined:body instanceof Uint8Array?body:JSON.stringify(body)}),config);
 const bytes=new Uint8Array(await response.arrayBuffer());
 let value=null;try{value=JSON.parse(new TextDecoder().decode(bytes));}catch{/* bytes */}
 return {status:response.status,value,bytes,type:response.headers.get('Content-Type')};
}
const BASE='/v1/anexos-empresa/logo';
const reserve=(bytes,mime,command=randomUUID(),user=f.users.admin)=>call(BASE,'POST',{command_id:command,mime_type:mime,size_bytes:bytes.length,sha256:sha(bytes)},user);
async function send(bytes,mime,user=f.users.admin){
 const reserved=await reserve(bytes,mime,randomUUID(),user);if(reserved.status!==200)return reserved;
 return call(`${BASE}/${reserved.value.logo.id}/upload`,'PUT',bytes,user,mime);
}

test('262 routes are strict and the RPCs are service-only security definer functions over closed tables',async()=>{
 assert.deepEqual(companyLogoRoute('/v1/anexos-empresa/logo'),{owner:'company',id:null,action:null});
 assert.equal(companyLogoRoute('/v1/anexos-empresa/logo/x/upload'),null);assert.equal(companyLogoRoute('/v1/anexos-empresa/outro'),null);
 assert.deepEqual(companyLogoMethods(companyLogoRoute(`/v1/anexos-empresa/logo/${randomUUID()}/exclusao`)),['POST']);
 for(const fn of['erp_company_logo_get(uuid)','erp_company_logo_reserve(uuid,uuid,text,integer,text)','erp_company_logo_object(uuid,uuid,boolean)','erp_company_logo_claim(uuid,uuid,uuid)',
  'erp_company_logo_finish(uuid,uuid,uuid,text,integer)','erp_company_logo_stop(uuid,uuid,boolean,uuid)','erp_company_logo_delete(uuid,uuid,uuid)']){
  assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v",['public.'+fn]),true,fn);
  for(const role of['anon','authenticated','public'])assert.equal(await f.scalar(`select has_function_privilege('${role==='public'?'anon':role}',$1,'EXECUTE') v`,['public.'+fn]),false,`${role} ${fn}`);
  assert.equal(await f.scalar("select p.prosecdef and array_to_string(p.proconfig,',') like '%search_path=pg_catalog%' v from pg_proc p where p.oid=$1::regprocedure",['public.'+fn]),true,fn);
 }
 for(const t of['erp_company.logo','erp_company.logo_audit']){
  assert.equal(await f.scalar('select relrowsecurity v from pg_class where oid=$1::regclass',[t]),true,t);
  assert.equal(await f.scalar("select has_table_privilege('service_role',$1,'SELECT') v",[t]),false,t);
 }
 await assert.rejects(()=>f.migrate('202610200262_company_logo.sql'),e=>e.code==='55000'&&/company_logo_262_already_applied/.test(e.message));
 await f.db.exec('rollback');
});

test('262 Sua marca: the administrador sends a PNG checked by SHA-256; every member reads and downloads it; other profiles cannot change it',async()=>{
 const empty=await call(BASE,'GET',undefined,f.users.financeiro);
 assert.equal(empty.status,200);assert.deepEqual([empty.value.logo,empty.value.can_manage,empty.value.pending],[null,false,[]]);
 assert.equal((await reserve(png,'image/png',randomUUID(),f.users.financeiro)).status,403,'only the administrador sends the logo');
 assert.equal((await reserve(png,'image/gif')).status,400);
 assert.equal((await call(BASE,'POST',{command_id:randomUUID(),mime_type:'image/png',size_bytes:2*1024*1024+1,sha256:sha(png)})).status,400,'over 2 MB');
 const command=randomUUID(),first=await reserve(png,'image/png',command);
 assert.equal(first.status,200);assert.equal(first.value.logo.status,'reserved');assert.equal(first.value.replayed,false);
 const replay=await reserve(png,'image/png',command);assert.deepEqual([replay.status,replay.value.replayed,replay.value.logo.id],[200,true,first.value.logo.id]);
 assert.equal((await reserve(jpeg,'image/jpeg',command)).status,409,'the same command with another body');
 const pending=await call(BASE);assert.deepEqual(pending.value.pending.map(p=>p.id),[first.value.logo.id]);
 assert.equal((await call(`${BASE}/${first.value.logo.id}/upload`,'PUT',jpeg,f.users.admin,'image/png')).status,400,'size differs from the reservation');
 const uploaded=await call(`${BASE}/${first.value.logo.id}/upload`,'PUT',png,f.users.admin,'image/png');
 assert.equal(uploaded.status,200);assert.equal(uploaded.value.logo.status,'ready');
 assert.ok(files.has(`company/logo/${first.value.logo.id}/${sha(png)}`),'immutable key in the private bucket');
 const read=await call(BASE,'GET',undefined,f.users.vendas);
 assert.deepEqual([read.status,read.value.logo.id,read.value.logo.sha256,read.value.can_manage,read.value.pending],[200,first.value.logo.id,sha(png),false,[]]);
 const download=await call(`${BASE}/${first.value.logo.id}/download`,'GET',undefined,f.users.financeiro);
 assert.deepEqual([download.status,download.type,sha(download.bytes)],[200,'application/octet-stream',sha(png)]);
 assert.equal((await call(`${BASE}/${first.value.logo.id}/download`,'GET',undefined,f.users.inactive)).status,403,'an inactive user reads nothing');
 // The upload repeated (Conferir resultado) answers the ready logo without writing again.
 const again=await call(`${BASE}/${first.value.logo.id}/upload`,'PUT',png,f.users.admin,'image/png');assert.deepEqual([again.status,again.value.replayed],[200,true]);
 assert.deepEqual((await f.db.query("select action from erp_company.logo_audit where logo_id=$1 order by id",[first.value.logo.id])).rows.map(r=>r.action),['reserve','finalize']);
});

test('262 a new logo replaces the previous one; Remover logo is a logical, audited deletion with replay; content and lease rules hold',async()=>{
 const current=(await call(BASE)).value.logo;
 const bad=await reserve(png,'image/jpeg');assert.equal(bad.status,200);
 assert.equal((await call(`${BASE}/${bad.value.logo.id}/upload`,'PUT',png,f.users.admin,'image/jpeg')).status,415,'PNG bytes declared as JPEG');
 const aborted=await call(`${BASE}/${bad.value.logo.id}/abort`,'POST',{});assert.deepEqual([aborted.status,aborted.value.logo.status],[200,'aborted']);
 assert.equal((await call(`${BASE}/${bad.value.logo.id}/upload`,'PUT',png,f.users.admin,'image/jpeg')).status,409,'an aborted reservation never receives bytes');
 const second=await send(jpeg,'image/jpeg');assert.equal(second.status,200);
 const now=(await call(BASE)).value.logo;assert.equal(now.id,second.value.logo.id);assert.equal(now.mime_type,'image/jpeg');
 assert.equal(await f.scalar('select deleted_at is not null v from erp_company.logo where id=$1',[current.id]),true,'the previous logo is kept, logically deleted');
 assert.equal((await call(`${BASE}/${current.id}/download`)).status,409,'a replaced logo is never delivered again');
 const command=randomUUID(),removed=await call(`${BASE}/${now.id}/exclusao`,'POST',{command_id:command});
 assert.deepEqual([removed.status,removed.value.logo.deleted,removed.value.replayed],[200,true,false]);
 const replay=await call(`${BASE}/${now.id}/exclusao`,'POST',{command_id:command});assert.deepEqual([replay.status,replay.value.replayed],[200,true]);
 assert.equal((await call(`${BASE}/${now.id}/exclusao`,'POST',{command_id:randomUUID()})).status,409,'already removed');
 assert.equal((await call(`${BASE}/${now.id}/exclusao`,'POST',{command_id:randomUUID()},f.users.financeiro)).status,403);
 assert.equal((await call(BASE)).value.logo,null);
 assert.deepEqual((await f.db.query("select action from erp_company.logo_audit where logo_id=$1 order by id",[now.id])).rows.map(r=>r.action),['reserve','finalize','delete']);
 await assert.rejects(()=>f.db.query('delete from erp_company.logo'),e=>/erp_company_logo_no_delete/.test(e.message));
 await assert.rejects(()=>f.db.query('update erp_company.logo_audit set action=$1',['delete']),e=>/erp_company_logo_immutable/.test(e.message));
 await assert.rejects(()=>f.db.query('update erp_company.logo set sha256=$1',['0'.repeat(64)]),e=>/erp_company_logo_immutable/.test(e.message));
});
