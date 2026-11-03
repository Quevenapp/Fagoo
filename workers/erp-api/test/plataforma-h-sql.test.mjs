import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {inflateRawSync} from 'node:zlib';
import {plataformaHFixture,fails} from './helpers/plataforma-h-fixture.mjs';
import {createHandler} from '../src/index.mjs';
import {runPlatformTasks,createZip,crc32,lookupCep,platformMethods,PlatformError} from '../src/platform.mjs';
import {buildReferenceMigration} from '../../../tools/reference/build-reference-migration.mjs';
import {readFile} from 'node:fs/promises';

// Synthetic data only. Leva H, lane plataforma (330-334) on PGlite through the real Worker, with in-memory Storage and CEP.
let f,handler,files,exports;
const config={SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-key',ALLOWED_ORIGINS:'https://synthetic.invalid'};
const pgRpc=async(name,args)=>{try{return await f.rpc(name,args);}catch(e){throw new PlatformError(409,`PG_${e.code}`);}};
const memoryExports=()=>({put:async(key,bytes)=>{exports.set(key,bytes);},remove:async key=>{exports.delete(key);},sign:async key=>`https://abcdefghijklmnopqrst.supabase.co/storage/v1/object/sign/brufap-exports/${key}?token=t`});
const memoryAttachments=()=>({get:async key=>files.has(key)?new Response(files.get(key)):new Response(null,{status:404})});
const run=(extra={})=>runPlatformTasks({rpc:pgRpc,exportStorage:memoryExports(),attachments:memoryAttachments(),...extra});
before(async()=>{
 f=await plataformaHFixture();files=new Map();exports=new Map();
 const fail=(status,code,message)=>Response.json({code,message:message??'SANITIZE_SYNTHETIC_SQL_ERROR'},{status});
 handler=createHandler({cepLookup:async cep=>cep==='01001000'?{scope:'cep_lookup',cep,street:'Praça da Sé',complement:null,district:'Sé',city:'São Paulo',state:'SP',ibge_code:'3550308',source:'ViaCEP',data_mode:'external_lookup'}
  :(()=>{throw new PlatformError(404,'ERP_CEP_NOT_FOUND');})(),
  fetchImpl:async(url,options={})=>{
  const {pathname}=new URL(url);
  if(pathname.endsWith('/auth/v1/user'))return Response.json({id:options.headers.Authorization.slice(7)});
  const sign=/^\/storage\/v1\/object\/sign\/brufap-exports\/(.+)$/.exec(pathname);
  if(sign)return Response.json({signedURL:`/object/sign/brufap-exports/${sign[1]}?token=synthetic`});
  try{return Response.json(await f.rpc(pathname.split('/').at(-1),JSON.parse(options.body)));}
  catch(e){return fail(400,e.code,e.message);}
 }});
});
after(async()=>f?.close());
async function call(path,method='GET',body,user=f.users.admin){
 const response=await handler(new Request('https://api.synthetic.invalid'+path,{method,headers:{Authorization:'Bearer '+user,Origin:'https://synthetic.invalid',...(body!==undefined?{'Content-Type':'application/json'}:{})},
  body:body===undefined?undefined:JSON.stringify(body)}),config);
 return {status:response.status,value:await response.json().catch(()=>null)};
}
const unzip=bytes=>{const out=new Map();let p=0;const b=Buffer.from(bytes);
 while(b.readUInt32LE(p)===0x04034b50){const size=b.readUInt32LE(p+18),n=b.readUInt16LE(p+26),e=b.readUInt16LE(p+28),name=b.slice(p+30,p+30+n).toString();
  const data=inflateRawSync(b.slice(p+30+n+e,p+30+n+e+size));assert.equal(crc32(data),b.readUInt32LE(p+14),name);out.set(name,data);p+=30+n+e+size;}
 assert.equal(b.readUInt32LE(b.length-22),0x06054b50);return out;};

test('330-334 RPCs are service-only security definer functions and the tables are closed',async()=>{
 for(const fn of['erp_platform_schedule(timestamptz)','erp_platform_task_claim(uuid,jsonb)','erp_platform_task_progress(uuid,uuid,jsonb)','erp_platform_task_finish(uuid,uuid,boolean,jsonb,text)',
  'erp_platform_notifications_run(uuid,uuid)','erp_platform_tasks(uuid,integer)','erp_platform_exports(uuid)','erp_platform_export_request(uuid,uuid)','erp_platform_export_plan(uuid,uuid)',
  'erp_platform_export_chunk(uuid,uuid,text,integer,integer)','erp_platform_export_complete(uuid,uuid,text,bigint,text,jsonb)','erp_platform_export_link(uuid,uuid)',
  'erp_platform_export_expired(uuid,uuid)','erp_platform_export_removed(uuid,uuid,uuid)','erp_reference_search(uuid,text,text,text,integer)','erp_platform_new_invoices(uuid)','erp_platform_new_invoices_seen(uuid,uuid)']){
  assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v",['public.'+fn]),true,fn);
  for(const role of['anon','authenticated'])assert.equal(await f.scalar(`select has_function_privilege('${role}',$1,'EXECUTE') v`,['public.'+fn]),false,`${role} ${fn}`);
  assert.equal(await f.scalar("select p.prosecdef and array_to_string(p.proconfig,',') like '%search_path=pg_catalog%' v from pg_proc p where p.oid=$1::regprocedure",['public.'+fn]),true,fn);
 }
 for(const t of['erp_platform.task','erp_platform.task_attempt','erp_platform.export','erp_platform.export_link','erp_platform.card_view','erp_reference.cnae','erp_reference.municipality','erp_reference.country','erp_reference.dataset']){
  assert.equal(await f.scalar('select relrowsecurity v from pg_class where oid=$1::regclass',[t]),true,t);
  assert.equal(await f.scalar("select has_table_privilege('service_role',$1,'SELECT') v",[t]),false,t);
 }
 assert.equal(await f.scalar("select public v from storage.buckets where id='brufap-exports'"),false);
 for(const name of['202610210330_platform_tasks.sql','202610210331_platform_exports.sql','202610210332_reference_tables.sql','202610210334_home_new_invoices.sql'])
  {await assert.rejects(()=>f.migrate(name),e=>e.code==='55000'&&/already_applied/.test(e.message),name);await f.db.exec('rollback');}
});

test('332 the reference migration is the generator output of the versioned copies, with source and version recorded',async()=>{
 const current=(await readFile(new URL('../../../supabase/migrations/202610210332_reference_tables.sql',import.meta.url),'utf8')).replace(/\r\n/g,'\n');
 assert.equal(current,buildReferenceMigration(),'run node tools/reference/build-reference-migration.mjs --write');
 const sets=(await f.db.query('select name,version,rows,source_url from erp_reference.dataset order by name')).rows;
 assert.deepEqual(sets.map(s=>s.name),['cnae','municipios','paises']);
 assert.ok(sets.every(s=>s.version&&/^https:\/\//.test(s.source_url)));
 assert.equal(sets.find(s=>s.name==='cnae').rows,1332);assert.equal(sets.find(s=>s.name==='municipios').rows,5571);
 assert.equal(await f.scalar("select string_agg(name,'|' order by name) v from erp_reference.country where code='1058'"),'BRASIL');
 assert.equal(await f.scalar("select code v from erp_reference.municipality where uf='SP' and key=erp_reference.key('São Paulo')"),'3550308');
});

test('PRF-296, CTT-045, VND-042: official tables through /v1/plataforma/referencias for any member; strict queries',async()=>{
 const cnae=await call('/v1/plataforma/referencias/cnae?q=4744',undefined,undefined,f.users.vendas);
 assert.equal(cnae.status,200);assert.ok(cnae.value.items.length>0&&cnae.value.items.every(i=>/^4744-\d\/\d{2}$/.test(i.code)));
 assert.match(cnae.value.dataset.version,/CNAE 2\.3/);
 const words=await call('/v1/plataforma/referencias/cnae?q=comercio varejista de ferragens');assert.ok(words.value.items.some(i=>i.code==='4744-0/01'),JSON.stringify(words.value.items.slice(0,3)));
 const city=await call('/v1/plataforma/referencias/municipios?uf=RO&q=alta floresta doeste');assert.deepEqual(city.value.items.map(i=>i.code),['1100015']);
 const country=await call('/v1/plataforma/referencias/paises?q=alemanha');assert.deepEqual(country.value.items[0],{code:'0230',name:'ALEMANHA'});
 assert.ok(!(await call('/v1/plataforma/referencias/paises?q=wake')).value.items.length,'a country closed in 2018 is not offered');
 assert.equal((await call('/v1/plataforma/referencias/paises?uf=SP')).status,400);
 assert.equal((await call('/v1/plataforma/referencias/ncm')).status,404);
 assert.equal((await call('/v1/plataforma/referencias/cnae?q=a&q=b')).status,400);
 assert.equal((await call('/v1/plataforma/referencias/cnae',undefined,undefined,f.users.inactive)).status,403);
 assert.deepEqual(platformMethods('/v1/plataforma/exportacoes'),['GET','POST']);
});

test('PRF-296: a new or changed CNAE of the company must be an official subclass; the stored value is kept',async()=>{
 // A value saved before 332 (outside the table) stays as it is while the CNAE does not change.
 await f.db.exec('alter table erp_company.extra disable trigger extra_cnae_official');
 await f.db.query("insert into erp_company.extra(singleton,version,data,updated_at,updated_by,command_id) values(true,1,'{\"cnae\":\"9999-9/99\",\"site\":null}'::jsonb,now(),$1,$2)",[f.users.admin,randomUUID()]);
 await f.db.exec('alter table erp_company.extra enable trigger extra_cnae_official');
 await f.db.query("update erp_company.extra set data=data||'{\"site\":\"https://sintetico.test\"}'::jsonb,version=2");
 await assert.rejects(()=>f.db.query("update erp_company.extra set data=data||'{\"cnae\":\"9999-9/98\"}'::jsonb"),e=>e.code==='22023'&&/cnae_unknown/.test(e.message));
 await f.db.query("update erp_company.extra set data=data||'{\"cnae\":\"4744-0/01\"}'::jsonb");
 assert.equal(await f.scalar("select data->>'cnae' v from erp_company.extra"),'4744-0/01');
});

test('VND-042: the pendências of the pedido check the Município in the IBGE table of the UF',async()=>{
 assert.equal(await f.scalar("select erp_reference.municipality_known('Sao Paulo','sp') v"),true);
 assert.equal(await f.scalar("select erp_reference.municipality_known('Cidade Inventada','SP') v"),false);
 assert.equal(await f.scalar("select erp_reference.municipality_known('Sao Paulo','RJ') v"),false,'the UF matters');
 assert.equal(await f.scalar("select erp_reference.municipality_known('Buenos Aires','EX') v"),null);
 assert.equal(await f.scalar("select erp_reference.municipality_known('',null) v"),null);
 assert.match(await f.scalar("select prosrc v from pg_proc where oid='erp_documents.pendencies(uuid)'::regprocedure"),/municipality_known/);
});

test('PRF-280, PRF-283: the scheduled run creates each notification once per user, type and day, whatever the repetition',async()=>{
 const now=new Date().toISOString();
 const first=await f.rpc('erp_platform_schedule',{p_now:now}),second=await f.rpc('erp_platform_schedule',{p_now:now});
 assert.deepEqual(first.tasks,second.tasks,'the same hour is the same task');
 // A proposal with Próximo contato today: the administrador (the default recipient) gets "proximo_contato" once.
 const contact=(await f.catalog('contacts',{name:'Cliente Sintético'})).id,product=(await f.catalog('products',{name:'Produto Sintético',code:'SKU-330'})).id;
 const today=await f.scalar("select to_char((clock_timestamp() at time zone 'America/Sao_Paulo')::date,'YYYY-MM-DD') v");
 await f.document('sales_proposals',{contact,date:today,items:[{product_id:product,description:'Produto Sintético',quantity:'1',unit_price:'10.00'}],body:{next_contact:today}});
 const ran=await run({purposes:['notifications_generate']});
 assert.deepEqual(ran.map(r=>[r.purpose,r.ok]),[['notifications_generate',true]],JSON.stringify(ran));
 const notified=async()=>f.scalar("select count(*)::int v from erp_home.notification where type='proximo_contato' and user_id=$1",[f.users.admin]);
 assert.equal(await notified(),1);
 // The bell opened afterwards (151) finds the notification of the day and creates nothing.
 await f.rpc('erp_home_notifications',{p_user_id:f.users.admin,p_tab:'todas'});assert.equal(await notified(),1);
 assert.equal((await run({purposes:['notifications_generate']})).length,0,'a done task is not run again');
 await f.db.query("insert into erp_platform.task(purpose,operation_id,payload) values('notifications_generate','notificacoes:repetida','{}')");
 await run({purposes:['notifications_generate']});
 const dup=await f.scalar('select count(*)::int v from(select user_id,type,day from erp_home.notification group by 1,2,3 having count(*)>1) x');
 assert.equal(dup,0);assert.equal(await notified(),1);
 const tasks=await call('/v1/plataforma/tarefas');
 assert.equal(tasks.status,200);assert.equal(tasks.value.all,true);
 assert.ok(tasks.value.items.some(t=>t.purpose==='notifications_generate'&&t.status==='done'&&t.history.length===1&&t.history[0].outcome==='done'));
 const others=await call('/v1/plataforma/tarefas',undefined,undefined,f.users.vendas);assert.equal(others.value.all,false);assert.deepEqual(others.value.items,[]);
});

test('PRF-280: a lost lease cannot finish; an expired lease is retried and then fails after the attempts',async()=>{
 await f.db.query("insert into erp_platform.task(purpose,operation_id,max_attempts) values('notifications_generate','notificacoes:lease',2)");
 const lease=randomUUID(),claimed=(await f.rpc('erp_platform_task_claim',{p_lease:lease,p_purposes:['notifications_generate']})).task;
 assert.equal(claimed.operation_id,'notificacoes:lease');
 await fails(assert,()=>f.rpc('erp_platform_task_finish',{p_task:claimed.id,p_lease:randomUUID(),p_ok:true,p_result:{},p_error:null}),'40001');
 await f.db.query("update erp_platform.task set lease_until=clock_timestamp()-interval '1 second' where id=$1",[claimed.id]);
 const again=(await f.rpc('erp_platform_task_claim',{p_lease:randomUUID(),p_purposes:['notifications_generate']})).task;
 assert.equal(again.id,claimed.id);assert.equal(again.attempts,2);assert.equal(again.history[0].outcome,'expired');
 await f.db.query("update erp_platform.task set lease_until=clock_timestamp()-interval '1 second' where id=$1",[claimed.id]);
 assert.equal((await f.rpc('erp_platform_task_claim',{p_lease:randomUUID(),p_purposes:['notifications_generate']})).task,null);
 assert.equal(await f.scalar('select status v from erp_platform.task where id=$1',[claimed.id]),'failed');
 await fails(assert,()=>f.db.query('delete from erp_platform.task where id=$1',[claimed.id]),'40001');
});

test('PRF-029: the administrador asks for one export at a time; the package has only the company tables and files; the link is short',async()=>{
 files.set('company/files/'+randomUUID()+'/'+'a'.repeat(64),new TextEncoder().encode('arquivo sintético'));
 for(const key of files.keys())await f.db.query('insert into storage.objects(bucket_id,name,metadata) values($1,$2,$3::jsonb)',['erp-attachments',key,JSON.stringify({size:17})]);
 assert.equal((await call('/v1/plataforma/exportacoes','POST',{command_id:randomUUID()},f.users.financeiro)).status,403);
 const command=randomUUID(),asked=await call('/v1/plataforma/exportacoes','POST',{command_id:command});
 assert.equal(asked.status,200);assert.equal(asked.value.export.status,'queued');assert.equal(asked.value.replayed,false);
 assert.equal((await call('/v1/plataforma/exportacoes','POST',{command_id:command})).value.replayed,true);
 const busy=await call('/v1/plataforma/exportacoes','POST',{command_id:randomUUID()});assert.deepEqual([busy.status,busy.value.error.field],[409,'export_in_progress']);
 assert.equal((await call(`/v1/plataforma/exportacoes/${asked.value.export.id}/link`,'POST',{})).status,409,'not ready yet');
 const ran=await run({purposes:['company_export']});
 assert.deepEqual(ran.map(r=>r.ok),[true],JSON.stringify(ran));
 const [[key,bytes]]=[...exports];assert.match(key,new RegExp(`^exports/${asked.value.export.id}/[a-f0-9]{64}\\.zip$`));
 assert.equal(key.split('/')[2],createHash('sha256').update(bytes).digest('hex')+'.zip');
 const zip=unzip(bytes),names=[...zip.keys()];
 assert.ok(names.includes('manifesto.json')&&names.includes('dados/erp_catalog.record.json')&&names.includes('dados/origin_sync.raw_record.json'));
 assert.ok(names.some(n=>n.startsWith('arquivos/company/files/')));
 assert.ok(!names.some(n=>/erp_access|auth\.|credential|erp_platform|vault/.test(n)),names.filter(n=>/access|auth|credential|platform|vault/.test(n)).join());
 const manifest=JSON.parse(zip.get('manifesto.json'));assert.equal(manifest.formato,'brufap-exportacao-v1');assert.ok(manifest.fora_do_pacote.includes('auth.users'));
 const list=await call('/v1/plataforma/exportacoes');assert.equal(list.value.items[0].status,'ready');assert.equal(list.value.items[0].size_bytes,bytes.length);
 assert.equal((await call('/v1/plataforma/exportacoes',undefined,undefined,f.users.consulta)).status,403);
 const link=await call(`/v1/plataforma/exportacoes/${asked.value.export.id}/link`,'POST',{});
 assert.equal(link.status,200);assert.equal(link.value.expires_in,120);assert.match(link.value.url,/\/storage\/v1\/object\/sign\/brufap-exports\/exports\/.+\?token=synthetic&download=brufap-exportacao-/);
 assert.equal((await call(`/v1/plataforma/exportacoes/${asked.value.export.id}/link`,'POST',{},f.users.vendas)).status,403);
 assert.equal(await f.scalar('select count(*)::int v from erp_platform.export_link'),1);
 // After the retention the daily cleanup removes the object once.
 await f.db.exec('alter table erp_platform.export disable trigger export_guard');
 await f.db.query("update erp_platform.export set expires_at=clock_timestamp()-interval '1 minute'");
 await f.db.exec('alter table erp_platform.export enable trigger export_guard');
 await f.rpc('erp_platform_schedule',{p_now:new Date().toISOString()});
 const cleaned=await run({purposes:['export_cleanup']});assert.deepEqual(cleaned.map(r=>r.ok),[true]);
 assert.equal(exports.size,0);assert.equal((await call('/v1/plataforma/exportacoes')).value.items[0].status,'expired');
 assert.equal((await call(`/v1/plataforma/exportacoes/${asked.value.export.id}/link`,'POST',{})).status,409);
});

test('PRF-252: Novas NF-es counts real synced and received notes since the last view, never drafts or homologation',async()=>{
 const empty=await call('/v1/plataforma/novas-nfes');assert.equal(empty.status,200);assert.deepEqual([empty.value.total,empty.value.seen_before],[0,false]);
 await f.db.query("insert into origin_sync.resource_state(resource) values('nfe') on conflict do nothing");
 const add=(id,situacao,key)=>f.db.query("insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash) values('nfe','nfe',$1,$2::jsonb,$3)",
  [id,JSON.stringify({id,situacao,chaveAcesso:key}),createHash('sha256').update(id).digest('hex')]);
 // Origin v3 situações: 5 Autorizada and 6 Emitida DANFE count; 1 Pendente does not.
 await add('9001',5,'3'.repeat(44));await add('9002',1,'4'.repeat(44));await add('9003',6,null);
 const counted=await call('/v1/plataforma/novas-nfes',undefined,undefined,f.users.fiscal);
 assert.deepEqual([counted.value.total,counted.value.synced,counted.value.received],[2,2,0],'Pendente (situação 1) is not counted');
 assert.equal((await call('/v1/plataforma/novas-nfes',undefined,undefined,f.users.vendas)).status,403);
 const command=randomUUID(),seen=await call('/v1/plataforma/novas-nfes/vistas','POST',{command_id:command},f.users.fiscal);
 assert.equal(seen.status,200);assert.equal(seen.value.view.total,0);assert.equal(seen.value.view.seen_before,true);
 assert.equal((await call('/v1/plataforma/novas-nfes/vistas','POST',{command_id:command},f.users.fiscal)).value.replayed,true);
 assert.equal((await call('/v1/plataforma/novas-nfes',undefined,undefined,f.users.admin)).value.total,2,'the view is per user');
});

test('NFE-103: the CEP lookup is a convenience for members; a missing CEP is a 404 and manual entry stays',async()=>{
 const found=await call('/v1/plataforma/cep/01001000',undefined,undefined,f.users.vendas);
 assert.equal(found.status,200);assert.deepEqual([found.value.city,found.value.state,found.value.ibge_code],['São Paulo','SP','3550308']);
 assert.equal((await call('/v1/plataforma/cep/99999999')).status,404);
 assert.equal((await call('/v1/plataforma/cep/0100100')).status,404);
 assert.equal((await call('/v1/plataforma/cep/01001000',undefined,undefined,f.users.inactive)).status,403);
 const viacep=async url=>{assert.equal(url,'https://viacep.com.br/ws/01001000/json/');return Response.json({cep:'01001-000',logradouro:'Praça da Sé',complemento:'lado ímpar',bairro:'Sé',localidade:'São Paulo',uf:'SP',ibge:'3550308'});};
 assert.equal((await lookupCep('01001000',{fetchImpl:viacep,cache:null})).street,'Praça da Sé');
 await assert.rejects(()=>lookupCep('99999999',{fetchImpl:async()=>Response.json({erro:'true'}),cache:null}),e=>e.code==='ERP_CEP_NOT_FOUND');
 await assert.rejects(()=>lookupCep('01001000',{fetchImpl:async()=>{throw new Error('offline');},cache:null}),e=>e.code==='ERP_CEP_UNAVAILABLE');
 await assert.rejects(()=>lookupCep('01001000',{fetchImpl:async()=>Response.json({cep:'02002-000',uf:'SP',localidade:'X'}),cache:null}),e=>e.code==='ERP_CEP_UNAVAILABLE','another CEP');
});

test('the ZIP writer produces entries any reader can inflate',async()=>{
 const zip=createZip(new Date('2026-10-21T12:00:00Z'));await zip.add('a/ção.txt',new TextEncoder().encode('olá '.repeat(100)));
 const bytes=zip.finish(),entries=unzip(bytes);assert.equal(new TextDecoder().decode(entries.get('a/ção.txt')),'olá '.repeat(100));
});
