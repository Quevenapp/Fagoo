/** Local, synthetic integration harness. Binds loopback; never reads deployment secrets or calls a network upstream. */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash,randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import {createUnsignedExecutor} from '../../packages/fiscal-unsigned-runtime/src/handler.mjs';
import {createUnsignedGateway} from '../../workers/fiscal-gateway/src/unsigned.mjs';
import { createHandler } from '../../workers/erp-api/src/index.mjs';
import {createQaDatabaseQueue} from './serial-database.mjs';
import {seedFiscalSigned,createFiscalSignedQaGateway} from './seed-fiscal-signed.mjs';
import {seedDocumentCommercial} from './seed-document-commercial.mjs';
import {seedProposalImport} from './seed-proposal-import.mjs';
import {seedUnitPrice} from './seed-unit-price.mjs';
const db=new PGlite();
const databaseOperation=createQaDatabaseQueue();
const uid='e0000000-0000-4000-8000-000000000001';
const hash=value=>createHash('sha256').update(value).digest('hex');
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].value;
await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
  create schema auth;create table auth.users(id uuid primary key);
  create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
  create table storage.objects(bucket_id text,name text,metadata jsonb not null default '{}',primary key(bucket_id,name));
  alter table storage.objects enable row level security;`);
for(const name of ['0001_origin_sync','0002_origin_quotes_nfce','0003_origin_backup_staging','0004_erp_access','0005_origin_auxiliary_catalogs','0006_erp_catalog','0007_erp_history','0008_erp_documents','0009_erp_stock','0010_erp_finance','0011_catalog_stock_lock_order','0012_erp_attachments','0013_catalog_import_review','0014_erp_cnab','0015_document_filters','0016_company','0017_document_finance','0018_document_stock','0019_document_effect_flags','0020_cutover_readiness','0021_home_summary','0022_fiscal_drafts','0023_product_details','0024_cnab_human_review','0025_stock_positions','0026_finance_due_report','0027_origin_fiscal_archive','0028_service_order_journal','0029_fiscal_review','0030_origin_finance_refresh','0031_xml_queue_fairness','0032_proposal_service_conversion','0033_origin_progress','0034_document_copy','0035_fiscal_item_preparation','0036_backup_storage_proxy','0037_xml_direction_fairness','0038_financial_cutover_review','0039_origin_financial_import','0040_fiscal_tax_preparation','0041_a1_custody','0042_cnab_operational','0043_cnab_operational_returns','0044_catalog_ncm_format','0045_dfe_distribution','0046_fiscal_numbering','0047_business_completion','0048_unsigned_xml_jobs','0049_service_order_events','0050_signed_fiscal_candidates','0052_origin_proposal_import','0053_finance_transfers','0054_document_commercial','0055_origin_proposal_import_v2','0057_unit_price_precision','0058_itau_net_credit'])
  await db.exec(await readFile(new URL(`../../supabase/migrations/20261016${name}.sql`,import.meta.url),'utf8'));
await db.exec(await readFile(new URL('../../supabase/migrations/202610190097_home_summary_favorites.sql',import.meta.url),'utf8'));
await db.query('insert into auth.users values($1)',[uid]);
await db.query("insert into erp_access.membership(user_id,role)values($1,'admin')",[uid]);
const save=(entity,data)=>scalar('select public.erp_catalog_save($1::uuid,$2,null,0,$3::uuid,$4::jsonb)value',[uid,entity,randomUUID(),JSON.stringify(data)]);
const qaContacts=[];
for(let index=1;index<=28;index++)qaContacts.push((await save('contacts',{name:`Cliente fictício de QA ${String(index).padStart(2,'0')}`,code:`QA-${index}`,person_type:'J',roles:['customer'],email:`cliente-${index}@example.invalid`,city:'Piracicaba',state:'SP'})).record);
await seedDocumentCommercial(db,uid,qaContacts[0].id);
await seedProposalImport(db,uid);
await seedUnitPrice(db,uid);
const qaProduct=(await save('products',{name:'Produto fictício para QA',code:'QA-P01',unit:'UN',kind:'P',price:'12.3456',ncm:'82055900',origin:'0',gtin:'SEM GTIN',gtin_tax:'SEM GTIN'})).record;
await save('warehouses',{name:'Depósito fictício de QA'});
await save('warehouses',{name:'Depósito de transferência de QA'});
for(let index=0;index<30;index++){
 const body={date:index%3===0?'2026-10-15':'2026-10-16',contact_id:qaContacts[index%qaContacts.length].id,items:[{description:'Item sintético para filtro',unit:'UN',quantity:'1',unit_price:'12.50'}]};
 const response=await scalar("select public.erp_document_save($1,'sales_proposals',null,0,$2,$3::jsonb)value",[uid,randomUUID(),JSON.stringify(body)]);
 if(index%2)await scalar("select public.erp_document_transition($1,'sales_proposals',$2,1,$3,'open',null)value",[uid,response.document.id,randomUUID()]);
}
// Approved synthetic proposals exercise each conversion independently.
for(let index=0;index<3;index++){
 const body={date:'2026-10-16',contact_id:qaContacts[index].id,items:[{description:'Conversão fictícia para QA',unit:'UN',quantity:'2',unit_price:'15.50'}],notes:index===2?'QA-CONVERSION-RETRY':'Proposta fictícia aprovada para conferir conversão'};
 let document=(await scalar("select public.erp_document_save($1,'sales_proposals',null,0,$2,$3::jsonb)value",[uid,randomUUID(),JSON.stringify(body)])).document;
 for(const status of ['open','approved'])document=(await scalar("select public.erp_document_transition($1,'sales_proposals',$2,$3,$4,$5,null)value",[uid,document.id,document.version,randomUUID(),status])).document;
}
// Service journal fixtures remain entirely in-memory and carry no operational effects.
const qaServiceBody={date:'2026-10-16',contact_id:qaContacts[0].id,items:[],equipment:'Equipamento fictício para QA',technician:'Técnico sintético',defect:'Conferência local do diário'};
const qaService=(await scalar("select public.erp_document_save($1,'service_orders',null,0,$2,$3::jsonb)value",[uid,randomUUID(),JSON.stringify(qaServiceBody)])).document;
for(let index=1;index<=30;index++)await scalar('select public.erp_service_journal_append($1,$2,$3,$4,$5)value',[uid,qaService.id,qaService.version,randomUUID(),`Atividade fictícia ${String(index).padStart(2,'0')} para conferir paginação`]);
// Two wholly fictitious OS contexts expose decision/delivery forms without recording declarations at bootstrap.
for(const states of [['quoted'],['quoted','approved','in_progress','service_done']]){
 const body={...qaServiceBody,equipment:states.length===1?'Equipamento fictício para decisão 049':'Equipamento fictício para entrega 049',items:[{description:'Serviço fictício para QA 049',unit:'UN',quantity:'1',unit_price:'42.50'}]};
 let doc=(await scalar("select public.erp_document_save($1,'service_orders',null,0,$2,$3::jsonb)value",[uid,randomUUID(),JSON.stringify(body)])).document;
 for(const status of states)doc=(await scalar("select public.erp_document_transition($1,'service_orders',$2,$3,$4,$5,null)value",[uid,doc.id,doc.version,randomUUID(),status])).document;
}
// Fiscal preparation fixtures: native sales orders only, no automatic fiscal drafts or effects.
for(let index=0;index<2;index++){
 const body={date:'2026-10-16',contact_id:qaContacts[index].id,items:[{product_id:qaProduct.id,description:'Produto fictício para preparação fiscal',unit:'UN',quantity:'2',unit_price:'12.3456'},{description:'Item livre fictício para conferência',unit:'UN',quantity:'1',unit_price:'1.0050'}],installments:[{due_date:'2026-11-16',amount:'25.70',method:'Prazo fictício'}],notes:'Pedido inteiramente fictício para QA de rascunhos fiscais',internal_notes:'QA_PRIVATE_INTERNAL_NOTE_MUST_NOT_ENTER_FISCAL_SNAPSHOT'};
 await scalar("select public.erp_document_save($1,'sales_orders',null,0,$2,$3::jsonb)value",[uid,randomUUID(),JSON.stringify(body)]);
}
await db.exec("insert into origin_sync.resource_state(resource)values('qa_catalog') on conflict do nothing;");
const stage=async(entity,id,payload)=>{const sha=hash(JSON.stringify(payload));await db.query(`insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash)values($1,'qa_catalog',$2,$3::jsonb,$4)
 on conflict(entity,source_id)do update set payload=excluded.payload,version_hash=excluded.version_hash,version=origin_sync.raw_record.version+1`,[entity,id,JSON.stringify(payload),sha]);return {source_id:id,source_hash:sha};};
for(let index=1;index<=28;index++)await stage('contacts',`qa-contact-${String(index).padStart(3,'0')}`,{nome:`Contato Origin fictício ${String(index).padStart(2,'0')}`,codigo:`IMPORT-QA-${index}`,tipo:'J',situacao:'A',numeroDocumento:'DOCUMENTO-SINTETICO',email:`import-${index}@example.invalid`,endereco:{geral:{municipio:'Piracicaba',uf:'SP'}}});
await stage('products','qa-product-001',{nome:'Produto Origin novo · QA',codigo:'IMPORT-QA-01',situacao:'A',unidade:'UN',tipo:'P',formato:'S',preco:'9.9950'});
const preservedSource=await stage('products','qa-product-002',{nome:'Produto Origin antes da edição · QA',codigo:'IMPORT-QA-02',situacao:'A',unidade:'UN',tipo:'P',formato:'S',preco:'20'});
const seeded=await scalar("select public.erp_catalog_import_origin($1,'products',$2::jsonb,$3,false)value",[uid,JSON.stringify([preservedSource]),randomUUID()]);
await scalar("select public.erp_catalog_save($1,'products',$2,1,$3,$4::jsonb)value",[uid,seeded.items[0].record_id,randomUUID(),JSON.stringify({name:'Produto alterado pela equipe · QA',price:'22.00'})]);
await stage('products','qa-product-002',{nome:'Produto atualizado na origem · QA',codigo:'IMPORT-QA-02',situacao:'A',unidade:'UN',tipo:'P',formato:'S',preco:'25'});
await stage('products','qa-product-003',{nome:'Produto excluído na origem · QA',codigo:'IMPORT-QA-03',situacao:'E',unidade:'UN',tipo:'P',formato:'S',preco:'0'});
await stage('products','qa-product-004',{nome:'Produto incompleto · QA',situacao:'?'});
await db.query("insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)values('erp-attachments','erp-attachments',false,10485760,$1)",[['application/pdf','image/png','image/jpeg','application/xml','text/plain']]);
await db.query("insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)values('brufap-cnab','brufap-cnab',false,4020000,$1)",[['application/octet-stream']]);
const backup=hash('synthetic QA backup');
await db.query("insert into origin_backup.batch(backup_sha,manifest,status,finished_at)values($1,'{\"counts\":{\"xml\":3,\"issue\":1}}','stored_with_issues',now())",[backup]);
// Synthetic CSV source evidence remains separate from native balances and titles.
const csvFile=hash('synthetic QA CSV');let csvRow=0;
const csv=(entity,source_id,payload)=>db.query("insert into origin_backup.record(backup_sha,kind,file_id,record_no,data)values($1,'csv',$2,$3,$4::jsonb)",[backup,csvFile,++csvRow,JSON.stringify({entity,source_id,payload})]);
for(let i=1;i<=26;i++){
 const id=`qa-contact-${String(i).padStart(3,'0')}`;
 await csv('contacts',id,{ID:id,Nome:`Contato de backup fictício ${i}`,Código:`BACKUP-QA-${i}`,Situação:'Ativo'});
}
await csv('contacts','qa-contact-backup-only',{ID:'qa-contact-backup-only',Nome:'Contato somente backup · QA'});
await csv('contacts','qa-contact-backup-only',{ID:'qa-contact-backup-only',Nome:'Ocorrência duplicada preservada · QA'});
await csv('contacts',null,{Nome:'Contato sem ID · QA'});
await csv('products','qa-product-001',{ID:'qa-product-001',Descrição:'Produto do backup · QA',Código:'IMPORT-QA-01',Unidade:'UN',Situação:'Ativo'});
await csv('products','qa-product-002',{ID:'qa-product-002',Descrição:'Produto antes de edição · QA',Código:'IMPORT-QA-02',Unidade:'UN',Situação:'Ativo'});
await csv('receivables','qa-ar-001',{'Valor documento':'1.234,56','Valor recebido':'34,56',Situação:'aberto','Conta financeira':'Conta fictícia do backup','Data vencimento':'20/10/2026'});
await stage('receivables','qa-ar-001',{situacao:7,valor:'1234.56',saldo:'1200.00',contato:{id:'qa-contact-001'},vencimento:'2026-10-20'});
await stage('receivables','qa-ar-002',{situacao:3,valor:'100.00',saldo:'60.00',contato:{id:'qa-contact-002'},vencimento:'2026-10-21'});
await csv('payables','qa-ap-001',{'Valor documento':'89,50','Valor pago':'0,00',Situação:'aberto','Conta financeira':'','Data vencimento':'22/10/2026'});
await stage('payables','qa-ap-001',{situacao:1,valor:'89.50',saldo:'89.50',contato:{id:'qa-contact-003'},vencimento:'2026-10-22'});
for(const [depot,quantity]of[['Depósito original fictício','12,345678'],['Segundo depósito fictício','2,000000']])
 await csv('stock_snapshot',null,{'ID Produto':'qa-product-001','Nome do Produto':'Produto do backup · QA','Depósito*':depot,'Movimentação de Estoque*':quantity,'Tipo de lançamento*':''});

// Native home fixtures use the same explicit commands as the ERP, never source totals.
const finance=(action,data)=>scalar('select public.erp_finance_execute($1,$2,$3,$4::jsonb)value',[uid,randomUUID(),action,JSON.stringify(data)]);
const today=await scalar("select (current_timestamp at time zone 'America/Sao_Paulo')::date::text value");
const day=offset=>new Date(Date.parse(`${today}T12:00:00Z`)+offset*86400000).toISOString().slice(0,10);
const bank=(await finance('account_save',{name:'Banco fictício do painel · QA',kind:'bank',expected_version:0})).record;
await finance('account_save',{name:'Caixa sem abertura · QA',kind:'cash',expected_version:0});
await finance('opening',{id:bank.id,expected_version:bank.version,amount_cents:'100000',posted_on:day(-30),note:'Abertura fictícia para QA do painel'});
const title=async(kind,offset,amount,label)=>(await finance('title_create_group',{kind,contact_id:qaContacts[0].id,description:`${label} · QA fictício`,issued_on:day(-30),total_cents:amount,installments:[{due_on:day(offset),amount_cents:amount}]})).items[0];
for(const [kind,offset,amount,label]of[
 ['receivable',-2,'10001','Receber atrasado'],['receivable',1,'200','Receber amanhã'],['receivable',7,'301','Receber em sete dias'],['receivable',8,'400','Receber depois'],
 ['payable',-1,'2500','Pagar atrasado'],['payable',0,'7500','Pagar hoje'],['payable',7,'3000','Pagar em sete dias'],['payable',8,'4500','Pagar depois']
])await title(kind,offset,amount,label);
const partial=await title('receivable',0,'10000','Receber hoje parcialmente baixado');
await finance('settle',{id:partial.id,expected_version:partial.version,account_id:bank.id,posted_on:today,principal_cents:'2501',note:'Baixa parcial fictícia para QA'});
const paid=await title('receivable',0,'50','Recebido integralmente');
await finance('settle',{id:paid.id,expected_version:paid.version,account_id:bank.id,posted_on:today,principal_cents:'50',note:'Baixa integral fictícia para QA'});
const cancelled=await title('receivable',-1,'999999','Cancelado fora do resumo');
await finance('title_cancel',{id:cancelled.id,expected_version:cancelled.version,note:'Cancelamento fictício para QA'});
const objects=new Map();
await (await import('./seed-synced-xml.mjs')).seedSyncedXml(db,objects);
await (await import('./seed-integration-progress.mjs')).seedIntegrationProgress(db);
await (await import('./seed-financial-cutover.mjs')).seedFinancialCutover(db,{uid});
await (await import('./seed-financial-import.mjs')).seedFinancialImport(db,{uid});
await (await import('./seed-fiscal-tax.mjs')).seedFiscalTax(db,{uid});
for(const [index,model,kind]of [[1,'55','invoice'],[2,'65','invoice'],[3,'65','event']]){
  const raw=new TextEncoder().encode(`<SyntheticQA model="${model}" kind="${kind}">This is not a fiscal document ${index}</SyntheticQA>`);
  const sha=hash(raw),file=hash(`QA-file-${index}`),key=`35261000000000000190${model}00100000000${index}10000000${index}0`;
  const meta={sha256:sha,key,model,environment:'2',kind,protocol:`13526000000000${index}`,protocol_present:true,signature_present:index!==1,
    validation:'structural_only',signature_verified:false,xsd_validated:false,...(kind==='event'?{event_type:'110111',sequence:'1'}:{})};
  const fileMeta={kind:'xml',object_key:`objects/${sha}.xml`,object_sha256:sha,object_size:raw.length,storage_representation:'object'};
  for(const [recordKind,data]of [['file',fileMeta],['xml',meta]])await db.query('insert into origin_backup.record(backup_sha,kind,file_id,record_no,data)values($1,$2,$3,0,$4::jsonb)',[backup,recordKind,file,JSON.stringify(data)]);
  if(index===1)await db.query("insert into origin_backup.record(backup_sha,kind,file_id,record_no,data)values($1,'issue',$2,1,'{\"code\":\"INVOICE_SIGNATURE_ABSENT\"}')",[backup,file]);
  await db.query("insert into storage.objects(bucket_id,name)values('origin-backups',$1)",[`objects/${sha}.xml`]);
  objects.set(`/storage/v1/object/authenticated/origin-backups/objects/${sha}.xml`,{bytes:raw,mime:'application/xml'});
}
const fakeFetch=async(address,options={})=>{
  const url=new URL(address);
  if(url.origin!=='https://qqqqqqqqqqqqqqqqqqqq.supabase.co')throw new Error('QA_NETWORK_FORBIDDEN');
  if(url.pathname==='/auth/v1/user')return options.headers.Authorization==='Bearer qa-synthetic-token-unsigned-safe'?json({id:uid,is_anonymous:false}):json({},401);
  if(objects.has(url.pathname)){const object=objects.get(url.pathname);return new Response(object.bytes,{headers:{'Content-Type':object.mime,'Content-Length':String(object.bytes.length)}});}
  const storagePost=/^\/storage\/v1\/object\/(erp-attachments|brufap-cnab|brufap-fiscal-artifacts)\/(.+)$/.exec(url.pathname);
  if(storagePost&&options.method==='POST'){
    const [,bucket,key]=storagePost,getPath=`/storage/v1/object/authenticated/${bucket}/${key}`;
    const bytes=new Uint8Array(options.body),mime=options.headers['Content-Type'];
    if(!bytes.length||bytes.length>({'brufap-cnab':4020000,'brufap-fiscal-artifacts':8388608,'erp-attachments':10485760})[bucket])return json({},400);
    return databaseOperation(async()=>{
      if(options.signal?.aborted)throw new DOMException('QA_ABORTED','AbortError');
      if(objects.has(getPath)||options.headers['x-upsert']!=='false')return json({code:'ResourceAlreadyExists'},409);
      await db.query("insert into storage.objects(bucket_id,name,metadata)values($1,$2,$3::jsonb)",[bucket,key,JSON.stringify({size:bytes.length,mimetype:mime})]);
      objects.set(getPath,{bytes,mime});return json({Key:key});
    });
  }
  if(url.pathname.startsWith('/storage/v1/object/authenticated/brufap-fiscal-artifacts/'))return json({code:'NoSuchKey'},404);
  const name=url.pathname.slice('/rest/v1/rpc/'.length);
  if(!url.pathname.startsWith('/rest/v1/rpc/')||!/^erp_(access_me|read_records|catalog_[a-z_]+|history_[a-z_]+|synced_xml_[a-z_]+|stock_[a-z_]+|document_[a-z_]+|service_(?:journal|event)_[a-z_]+|proposal_convert(?:_to_service)?|origin_progress|origin_financial_import_[a-z_]+|origin_proposal_document_origin|origin_proposal_import_(?:sources|preview|apply|command|origin)(?:_v2)?|finance_[a-z_]+|attachment_[a-z_]+|cnab_[a-z_]+|dfe_[a-z_]+|company_[a-z_]+|a1_[a-z_]+|fiscal_(?:draft|item|tax|numbering|completion|unsigned|signed)_[a-z_]+|home_(?:summary|overview|shortcuts_get|shortcuts_save)|cutover_[a-z_]+)$/.test(name))return json({},404);
  const args=JSON.parse(options.body);const keys=Object.keys(args);
  if(keys.some(key=>!/^p_[a-z0-9_]+$/.test(key)))return json({},400);
  return databaseOperation(async()=>{
    if(options.signal?.aborted)throw new DOMException('QA_ABORTED','AbortError');
    try{
      await db.exec('set role service_role');
      const textArrayKeys=name==='erp_cnab_return_context'?new Set(['p_event_hashes','p_controls']):new Set();
      return json(await scalar(`select public.${name}(${keys.map((key,index)=>`${key}=>${textArrayKeys.has(key)?`ARRAY(SELECT jsonb_array_elements_text($${index+1}::jsonb))`:`$${index+1}`}`).join(',')}) value`,keys.map(key=>typeof args[key]==='object'&&args[key]!==null?JSON.stringify(args[key]):args[key])));
    }catch(error){return json({code:error.code||'XX000'},error.code==='42501'?403:400);}
    finally{await db.exec('reset role');}
  });
};
const handler=createHandler({fetchImpl:fakeFetch});
const env={SUPABASE_URL:'https://qqqqqqqqqqqqqqqqqqqq.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'qa-synthetic-service-key',ALLOWED_ORIGINS:'http://127.0.0.1:5173'};
await (await import('./cnab-fixtures.mjs')).seedCnabReview({db,uid,handler,env,today});
await (await import('./seed-operational-returns.mjs')).seedOperationalReturns({db,uid,handler,env,today});
await (await import('./seed-itau-net-credit.mjs')).seedItauNetCredit({db,uid,handler,env,today});
await (await import('./seed-received-dfe.mjs')).seedReceivedDfe({db,uid,objects});
await (await import('./seed-fiscal-numbering.mjs')).seedFiscalNumbering({db,uid});
await (await import('./seed-fiscal-completion.mjs')).seedFiscalCompletion({db,uid});
await db.query("insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)values('brufap-fiscal-artifacts','brufap-fiscal-artifacts',false,8388608,$1)",[['application/octet-stream']]);
await (await import('./seed-fiscal-unsigned.mjs')).seedFiscalUnsigned({db,uid});
const unsignedEnv={...env,SUPABASE_ANON_KEY:'qa-synthetic-public-key-only',A1_TRANSPORT_SECRET:Buffer.alloc(32,41).toString('base64'),A1_TRANSPORT_KEY_ID:'qa-local-only',A1_AUDIENCE:'qa-local-only',ALLOWED_ORIGINS:'https://qa.synthetic.invalid'};
const unsignedExecutor=createUnsignedExecutor(unsignedEnv,fakeFetch);unsignedEnv.A1_RUNTIME={fetch:unsignedExecutor};
const unsignedGateway=createUnsignedGateway({fetchImpl:fakeFetch,now:Date.now,nonce:randomUUID});
const signedSeed=await seedFiscalSigned({db,uid,objects,databaseOperation});
const signedQa=createFiscalSignedQaGateway({seed:signedSeed,fetchImpl:fakeFetch,env:unsignedEnv,retry:process.env.BRUFAP_QA_SIGNED_RETRY==='1',detailDelayMs:Number(process.env.BRUFAP_QA_SIGNED_DETAIL_DELAY_MS||0)});
const server=createServer(async(req,res)=>{
  try{
    const chunks=[];let length=0;
    const limit=req.method==='PUT'&&req.url.endsWith('/upload')?10485760:/^\/v1\/(?:cnab|retornos-operacionais)\//.test(req.url)?8388608:/^\/v1\/(?:preparacao-tributaria|complemento-fiscal)\//.test(req.url)?524288:262144;
    for await(const chunk of req){length+=chunk.length;if(length>limit)throw new Error('too_big');chunks.push(chunk);}
    const isUnsigned=req.url.startsWith('/v1/fiscal-unsigned/'),isSigned=req.url.startsWith('/v1/fiscal-signed/'),isA1=req.url==='/v1/a1',isFiscal=isUnsigned||isSigned||isA1;
    if(isFiscal&&req.headers.origin!=='http://127.0.0.1:5173')throw Error('QA_ORIGIN_INVALID');
    const request=new Request(`${isFiscal?'https://unsigned.qa.invalid':'http://127.0.0.1:9011'}${req.url}`,{method:req.method,headers:{...req.headers,...(isFiscal?{origin:'https://qa.synthetic.invalid'}:{})},...(!['GET','HEAD'].includes(req.method)?{body:Buffer.concat(chunks),duplex:'half'}:{})});
    const response=isUnsigned?await unsignedGateway(request,unsignedEnv):isSigned||isA1?await signedQa.fetch(request):await handler(request,env);
    if(isFiscal)response.headers.set('Access-Control-Allow-Origin','http://127.0.0.1:5173');
    if(isSigned)response.headers.set('X-Brufap-Qa-Xsd','simulated-report-not-validation');
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch{res.writeHead(500);res.end('QA_ERROR');}
});
if(process.env.BRUFAP_QA_BOOT_ONLY==='1'){
 signedQa.dispose();await databaseOperation.drain();await db.close();console.log('Synthetic ERP QA bootstrap completed with migrations001–050,052–055,057–058,097. NF-e/NFC-e unsigned stored; synthetic A1; XSD reports are simulated. No listening socket or network upstream.');
}else{
 server.listen(9011,'127.0.0.1',()=>console.log('Synthetic ERP QA: http://127.0.0.1:5173/qa.html; API loopback9011. Synthetic A1 and simulated XSD reports; no production data or credentials.'));
 for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close(async()=>{signedQa.dispose();await databaseOperation.drain();await db.close();process.exit(0);}));
}
