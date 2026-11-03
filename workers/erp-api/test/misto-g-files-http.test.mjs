import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mistoGFixture} from './helpers/misto-g-fixture.mjs';
import {createHandler} from '../src/index.mjs';
import {companyFileRoute,companyFileMethods,companyFileName} from '../src/company-files.mjs';
import {parseFiles,captureFilesQuery,parseActivity,captureActivityQuery} from '../../../packages/erp-domain/src/activity.mjs';

// Synthetic data only. 301 (PRF-238): Sistema › Gerenciador de arquivos › Inserir Arquivo, a company file without a document, on
// PGlite through the real Worker with an in-memory Storage.
let f,handler;
const files=new Map();
const config={SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-key',ALLOWED_ORIGINS:'https://synthetic.invalid'};
const pdf=new TextEncoder().encode('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
const txt=new TextEncoder().encode('Contrato social sintético.\n');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
before(async()=>{
 f=await mistoGFixture();
 await f.db.query("insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('erp-attachments','erp-attachments',false,10485760,array['application/pdf','image/png','image/jpeg','application/xml','text/plain']) on conflict do nothing");
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
 return {status:response.status,value,bytes,headers:response.headers};
}
const BASE='/v1/anexos-empresa/arquivos';
const reserve=(bytes,mime,filename,command=randomUUID(),user=f.users.admin)=>call(BASE,'POST',{command_id:command,filename,mime_type:mime,size_bytes:bytes.length,sha256:sha(bytes)},user);
const listFiles=async(extra={})=>{const q=captureFilesQuery({origin:'empresa',...extra});return parseFiles(await f.rpc('erp_files_list_v2',{p_user_id:f.users.admin,p_query:q.q,p_from:q.from,p_to:q.to,p_order:q.order,p_origin:q.origin,p_limit:q.limit,p_offset:q.offset}),q);};

test('301 routes are strict and the RPCs are service-only security definer functions over closed tables',async()=>{
 assert.deepEqual(companyFileRoute(BASE),{owner:'company_file',id:null,action:null});
 assert.equal(companyFileRoute(`${BASE}/x/upload`),null);assert.equal(companyFileRoute('/v1/anexos-empresa/outros'),null);
 assert.deepEqual(companyFileMethods(companyFileRoute(BASE)),['POST']);assert.deepEqual(companyFileMethods(companyFileRoute(`${BASE}/${randomUUID()}/download`)),['GET']);
 assert.equal(companyFileName('Contrato Social (2026).PDF','application/pdf'),'arquivo-Contrato-Social-2026-.pdf');
 assert.equal(companyFileName('foto.jpeg','image/jpeg'),'arquivo-foto.jpg');
 for(const bad of[['planilha.xlsx','application/pdf'],['sem-extensao','text/plain'],['a.png','image/jpeg']])assert.throws(()=>companyFileName(...bad),e=>e.status===400,bad[0]);
 for(const fn of['erp_company_file_reserve(uuid,uuid,text,text,integer,text)','erp_company_file_object(uuid,uuid,boolean)','erp_company_file_claim(uuid,uuid,uuid)',
  'erp_company_file_finish(uuid,uuid,uuid,text,integer)','erp_company_file_stop(uuid,uuid,boolean,uuid)','erp_company_file_delete(uuid,uuid,uuid)','erp_files_list_v2(uuid,text,date,date,text,text,integer,integer)','erp_activity_detail(uuid,text,text)']){
  assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v",['public.'+fn]),true,fn);
  for(const role of['anon','authenticated'])assert.equal(await f.scalar(`select has_function_privilege('${role}',$1,'EXECUTE') v`,['public.'+fn]),false,`${role} ${fn}`);
  assert.equal(await f.scalar("select p.prosecdef and array_to_string(p.proconfig,',') like '%search_path=pg_catalog%' v from pg_proc p where p.oid=$1::regprocedure",['public.'+fn]),true,fn);
 }
 for(const t of['erp_company.file','erp_company.file_audit']){
  assert.equal(await f.scalar('select relrowsecurity v from pg_class where oid=$1::regclass',[t]),true,t);
  assert.equal(await f.scalar("select has_table_privilege('service_role',$1,'SELECT') v",[t]),false,t);
 }
});

test('301 Inserir Arquivo: the administrador sends a file checked by SHA-256 and content; it is listed, downloaded, audited and excluded once',async()=>{
 assert.equal((await reserve(pdf,'application/pdf','contrato.pdf',randomUUID(),f.users.financeiro)).status,403,'only the administrador inserts files');
 assert.equal((await reserve(pdf,'image/gif','x.gif')).status,400);
 assert.equal((await reserve(pdf,'application/pdf','contrato.txt')).status,400,'the extension follows the type');
 assert.equal((await call(BASE,'POST',{command_id:randomUUID(),filename:'grande.pdf',mime_type:'application/pdf',size_bytes:10*1024*1024+1,sha256:sha(pdf)})).status,400,'over 10 MB');
 const command=randomUUID(),first=await reserve(pdf,'application/pdf','Contrato social.pdf',command);
 assert.equal(first.status,200);assert.deepEqual([first.value.file.status,first.value.file.filename,first.value.replayed],['reserved','arquivo-Contrato-social.pdf',false]);
 const id=first.value.file.id;
 const replay=await reserve(pdf,'application/pdf','Contrato social.pdf',command);assert.deepEqual([replay.status,replay.value.replayed,replay.value.file.id],[200,true,id]);
 assert.equal((await reserve(txt,'text/plain','Contrato social.txt',command)).status,409,'the same command with another body');
 // A reserved file is not listed yet.
 assert.equal((await listFiles()).items.some(x=>x.id===id),false);
 assert.equal((await call(`${BASE}/${id}/upload`,'PUT',txt,f.users.admin,'application/pdf')).status,400,'size differs from the reservation');
 const fake=new TextEncoder().encode('not a pdf at all, only text bytes......'.slice(0,pdf.length).padEnd(pdf.length,'.'));
 const other=await reserve(fake,'application/pdf','falso.pdf');assert.equal((await call(`${BASE}/${other.value.file.id}/upload`,'PUT',fake,f.users.admin,'application/pdf')).status,415,'the content is checked');
 const sent=await call(`${BASE}/${id}/upload`,'PUT',pdf,f.users.admin,'application/pdf');
 assert.equal(sent.status,200);assert.equal(sent.value.file.status,'ready');
 const again=await call(`${BASE}/${id}/upload`,'PUT',pdf,f.users.admin,'application/pdf');assert.deepEqual([again.status,again.value.replayed],[200,true]);
 // Gerenciador de arquivos: origin Empresa, "Arquivo da empresa", with the route of its module.
 const listed=(await listFiles()).items.find(x=>x.id===id);
 assert.deepEqual([listed.origin,listed.filename,listed.mime_type,listed.size_bytes,listed.source.kind,listed.source.id,listed.source.label],['empresa','arquivo-Contrato-social.pdf','application/pdf',pdf.length,'company_file',id,'Arquivo da empresa']);
 const down=await call(`${BASE}/${id}/download`);assert.equal(down.status,200);assert.deepEqual([...down.bytes],[...pdf]);
 assert.match(down.headers.get('Content-Disposition'),/filename="arquivo-Contrato-social.pdf"/);
 assert.equal((await call(`${BASE}/${id}/download`,'GET',undefined,f.users.financeiro)).status,403);
 // Excluir anexo: once, by command; the replay answers the same, another file cannot reuse the command.
 const removal=randomUUID(),removed=await call(`${BASE}/${id}/exclusao`,'POST',{command_id:removal});
 assert.deepEqual([removed.status,removed.value.file.deleted,removed.value.replayed],[200,true,false]);
 const repeated=await call(`${BASE}/${id}/exclusao`,'POST',{command_id:removal});assert.deepEqual([repeated.status,repeated.value.replayed],[200,true]);
 assert.equal((await listFiles()).items.some(x=>x.id===id),false);
 assert.equal((await call(`${BASE}/${id}/download`)).status,409);
 // "Descartar o envio" of a reservation that was never sent.
 const lost=await reserve(txt,'text/plain','rascunho.txt');const aborted=await call(`${BASE}/${lost.value.file.id}/abort`,'POST',{});
 assert.deepEqual([aborted.status,aborted.value.file.status],[200,'aborted']);
 assert.equal((await call(`${BASE}/${lost.value.file.id}/upload`,'PUT',txt,f.users.admin,'text/plain')).status,409);
 // The rows and their audit are immutable.
 await assert.rejects(()=>f.db.query('delete from erp_company.file where id=$1',[id]),e=>e.code==='40001');
 await assert.rejects(()=>f.db.query("update erp_company.file set filename='arquivo-outro.pdf' where id=$1",[id]),e=>e.code==='40001');
 await assert.rejects(()=>f.db.query('delete from erp_company.file_audit'),e=>e.code==='40001');
 // Registro de atividades: included and excluded (module Anexos), no detail.
 const day=await f.scalar("select to_char((clock_timestamp() at time zone 'America/Sao_Paulo')::date,'YYYY-MM-DD') v");
 const q=captureActivityQuery({from:day,to:day,module:'anexos',limit:100});
 const log=parseActivity(await f.rpc('erp_activity_list',{p_user_id:f.users.admin,p_from:q.from,p_to:q.to,p_module:q.module,p_operation:null,p_actor:null,p_query:null,p_limit:q.limit,p_offset:0}),q);
 const mine=log.items.filter(e=>e.source==='company_files');
 assert.deepEqual(mine.map(e=>[e.operation,e.description]).sort(),[['criacao','Arquivo da empresa incluído · arquivo-Contrato-social.pdf'],['exclusao','Arquivo da empresa excluído · arquivo-Contrato-social.pdf']]);
 const detail=await f.rpc('erp_activity_detail',{p_user_id:f.users.admin,p_source:'company_files',p_entry_id:mine[0].id});assert.equal(detail.available,false);
});

test('301 the import of lots appears in the Registro de atividades under Estoque',async()=>{
 const p=await f.catalog('products',{name:'Produto com lote',code:'LOT-ATV',unit:'UN',kind:'P',format:'S',price:'1'});
 await f.rpc('erp_catalog_product_save',{p_user_id:f.users.admin,p_id:p.id,p_expected_version:p.version,p_command_id:randomUUID(),p_data:{name:'Produto com lote',lot_control:true},p_acknowledged:null});
 await f.rpc('erp_preferences_import_batch',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_job_id:randomUUID(),p_kind:'lots',p_file_name:'lotes-atividade.csv',p_total_rows:1,p_dry_run:false,
  p_rows:[{row:2,lines:[2],data:{code:'LOT-ATV',lot:'A-1'}}]});
 const day=await f.scalar("select to_char((clock_timestamp() at time zone 'America/Sao_Paulo')::date,'YYYY-MM-DD') v");
 const q=captureActivityQuery({from:day,to:day,module:'estoque',limit:100});
 const log=parseActivity(await f.rpc('erp_activity_list',{p_user_id:f.users.admin,p_from:q.from,p_to:q.to,p_module:q.module,p_operation:null,p_actor:null,p_query:'lotes-atividade',p_limit:q.limit,p_offset:0}),{...q,q:'lotes-atividade'});
 assert.deepEqual(log.items.filter(e=>e.source==='imports').map(e=>e.description),['Importação de planilha de lotes · lotes-atividade.csv (1 linhas)']);
 // Each imported lot: a new one is Criação, an updated one Atualização; a line equal to the stored lot changed nothing and does not enter.
 const lotImport=async data=>f.rpc('erp_preferences_import_batch',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_job_id:randomUUID(),p_kind:'lots',p_file_name:'lotes-atividade-2.csv',p_total_rows:1,p_dry_run:false,
  p_rows:[{row:2,lines:[2],data:{code:'LOT-ATV',lot:'A-1',...data}}]});
 assert.equal((await lotImport({})).items[0].status,'unchanged');
 assert.equal((await lotImport({note:'Conferido'})).items[0].status,'updated');
 const lq=captureActivityQuery({from:day,to:day,module:'estoque',limit:100,q:'Produto com lote'});
 const lots=parseActivity(await f.rpc('erp_activity_list',{p_user_id:f.users.admin,p_from:lq.from,p_to:lq.to,p_module:lq.module,p_operation:null,p_actor:null,p_query:lq.q,p_limit:lq.limit,p_offset:0}),lq)
  .items.filter(e=>e.source==='lots');
 assert.deepEqual(lots.map(e=>[e.operation,e.description]).sort(),[['atualizacao','Lote A-1 do produto Produto com lote · importação de planilha'],['criacao','Lote A-1 do produto Produto com lote · importação de planilha']]);
});

test('301 replaces only the published functions: another version stops the migration',async()=>{const g=await mistoGFixture({before:'202610200301'});try{
 await g.db.exec(`create or replace function erp_activity.entries(p_from timestamptz,p_to timestamptz) returns table(source text,entry_id text,created_at timestamptz,actor uuid,module text,operation text,code text,description text)
  language sql stable set search_path=pg_catalog as $$ select null::text,null::text,null::timestamptz,null::uuid,null::text,null::text,null::text,null::text where false $$;`);
 await assert.rejects(()=>g.migrate('202610200301_company_files.sql'),e=>e.code==='55000'&&/company_files_301_previous_definition_changed/.test(e.message));
}finally{await g.close();}});
