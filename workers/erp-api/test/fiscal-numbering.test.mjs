import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {parseFiscalNumberingRoute,executeFiscalNumberingRoute,fiscalNumberingMethods,FiscalNumberingError} from '../src/fiscal-numbering.mjs';

const base='https://synthetic.invalid/v1/numeracao-fiscal',actor=randomUUID(),sid=randomUUID(),did=randomUUID(),rid=randomUUID(),cid=randomUUID(),oid=randomUUID(),sha='a'.repeat(64),at='2026-10-16T10:00:00.123456+00:00';
const flags={data_mode:'fiscal_numbering',policy:'brufap-homologation-exclusive-v1',environment:'2',can_emit:false,can_transmit:false,authorized:false,financial_mutation_performed:false,stock_mutation_performed:false};
const config=()=>({command_id:cid,id:null,expected_version:0,expected_identity_version:1,model:'55',environment:'2',series:'0',initial_number:'1',enabled:true,exclusive_use_confirmed:true,reference:'Confirmação sintética explícita'});
const reserve=()=>({command_id:cid,series_id:sid,expected_series_version:1,expected_identity_version:1,draft_id:did,expected_draft_version:1,snapshot_hash:sha,item_preparation_version:1,tax_preparation_version:1,confirm_reserve:true});
const series=patch=>({id:sid,issuer_cnpj:'11222333000181',cuf:'35',model:'55',environment:'2',series:'0',first_number:'1',next_number:'1',exhausted:false,version:1,identity_version:1,enabled:true,exclusive_use_confirmed:true,reference:config().reference,created_at:at,updated_at:at,company_changed:false,...patch});
const reservation=patch=>({id:rid,state:'reserved',numbering_reserved:true,series_id:sid,series_version:1,issuer_cnpj:'11222333000181',cuf:'35',model:'55',environment:'2',series:'0',number:'1',draft_id:did,draft_version:1,snapshot_hash:sha,item_preparation_version:1,tax_preparation_version:1,item_preparation_hash:sha,tax_preparation_hash:sha,source_document_id:oid,source_document_version:1,company_identity_version:1,company_fiscal_version:1,reserved_at:at,...patch});
const basis=patch=>({draft_version:1,draft_status:'draft',source_document_version:1,source_status:'draft',item_preparation_version:1,tax_preparation_version:1,company_identity_version:1,company_fiscal_version:1,basis_changed:false,draft_archived:false,source_cancelled:false,...patch});
const configured=()=>({...flags,command_id:cid,action:'configure',replayed:false,receipt:series(),current_series:series(),current_basis:null});
const reserved=()=>({...flags,command_id:cid,action:'reserve',replayed:false,receipt:reservation(),current_series:series({version:2,next_number:'2'}),current_basis:basis()});
const request=(path,body,headers={})=>new Request(base+path,body===undefined?{headers}:{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
const parse=(path,body)=>parseFiscalNumberingRoute(request(path,body));
const run=async(path,input,value,options={})=>executeFiscalNumberingRoute(await parse(path,input),{userId:actor,rpc:async()=>value,...options});
const reject=(fn,status,code)=>assert.rejects(fn,error=>error instanceof FiscalNumberingError&&error.status===status&&(!code||error.code===code));

test('routes expose only homologation configuration/reservation and recovery reads; path UUIDs canonicalize',async()=>{
 assert.equal(await parseFiscalNumberingRoute(new Request('https://synthetic.invalid/v1/other')),null);
 assert.deepEqual(fiscalNumberingMethods('/v1/numeracao-fiscal/series'),['GET','POST']);assert.deepEqual(fiscalNumberingMethods('/v1/numeracao-fiscal/reservations'),['POST']);
 for(const path of ['/','/emit','/series/reset','/reservations/'+rid+'/cancel','/drafts/wrong','/commands/'+cid+'/retry'])await reject(()=>parse(path),404);
 await reject(()=>parse('/reservations'),405);await reject(()=>parseFiscalNumberingRoute(new Request(base+'/series',{method:'DELETE'})),405);
 assert.equal((await parse('/drafts/'+did.toUpperCase())).args.p_draft_id,did);assert.equal((await parse('/commands/'+cid.toUpperCase())).args.p_command_id,cid);
});

test('queries are allowlisted, unique and canonical with strict pagination',async()=>{
 const r=await parse('/series?model=65&limit=25&after='+sid.toUpperCase());assert.deepEqual(r.args,{p_model:'65',p_limit:25,p_after:sid});assert.equal(Object.isFrozen(r.args),true);
 for(const query of ['model=57','model=55&model=65','limit=0','limit=26','limit=01','limit=1.0','after=x','environment=1','issuer_cnpj=11222333000181','user_id='+actor])await reject(()=>parse('/series?'+query),400);
 for(const path of ['/commands/'+cid,'/drafts/'+did,'/reservations/'+rid])await reject(()=>parse(path+'?extra=1'),400);
 await reject(()=>parse('/series?model=55',config()),400);
});

test('configuration requires explicit string values, identity CAS and meaningful reference without normalization',async()=>{
 const v=config(),r=await parse('/series',v);assert.deepEqual(r.args,Object.fromEntries(Object.entries(v).map(([key,value])=>['p_'+key,value])));
 for(const patch of [{id:sid},{expected_version:1},{expected_version:2147483647},{expected_identity_version:0},{environment:'1'},{model:'57'},{series:1},{series:'00'},{series:'890'},{series:' 1'},{initial_number:'0'},{initial_number:'01'},{initial_number:'1000000000'},{initial_number:1},{enabled:true,exclusive_use_confirmed:false},{reference:'\u00a0\u2003\ufeff'},{reference:'bad\ntext'},{reference:'a'.repeat(241)},{p_user_id:actor},{next_number:'3'},{command_id:cid.toUpperCase()}])await reject(()=>parse('/series',{...v,...patch}),400);
 const unicode=await parse('/series',{...v,reference:'Uso\u00a0exclusivo conferido'});assert.equal(unicode.args.p_reference,'Uso\u00a0exclusivo conferido');
 assert.equal((await parse('/series',{...v,enabled:false,exclusive_use_confirmed:false})).args.p_enabled,false);
});

test('reservation binds exact preparation revisions and requires explicit confirmation; number and issuer are server derived',async()=>{
 const v=reserve(),r=await parse('/reservations',v);assert.equal(r.rpc,'erp_fiscal_numbering_reserve');assert.equal(r.args.p_confirm_reserve,true);
 for(const patch of [{confirm_reserve:false},{confirm_reserve:'true'},{expected_series_version:2147483647},{expected_draft_version:0},{item_preparation_version:null},{tax_preparation_version:'1'},{snapshot_hash:sha.toUpperCase()},{snapshot_hash:'abc'},{series_id:'bad'},{number:'99'},{environment:'2'},{issuer_cnpj:'11222333000181'},{actor}])await reject(()=>parse('/reservations',{...v,...patch}),400);
});

test('body boundary limits encoding, UTF-8, declared and streamed size and accepts no alternate content',async()=>{
 for(const [headers,text,status] of [[{'Content-Encoding':'gzip'},'{}',400],[{'Content-Type':'text/plain'},'{}',400],[{'Content-Length':'9000'},'{}',413],[{'Content-Length':'1'},'{}',400],[{},'{invalid',400],[{},' '.repeat(8193),413]])await reject(()=>parseFiscalNumberingRoute(new Request(base+'/series',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:text})),status);
 await reject(()=>parseFiscalNumberingRoute(new Request(base+'/series',{method:'POST',headers:{'Content-Type':'application/json'},body:Uint8Array.of(0xff)})),400);
 const controller=new AbortController();let cancelled=false;const request=new Request(base+'/series',{method:'POST',headers:{'Content-Type':'application/json'},body:new ReadableStream({cancel(){cancelled=true;}}),duplex:'half',signal:controller.signal});
 const result=parseFiscalNumberingRoute(request);controller.abort();await reject(()=>result,400,'ERP_REQUEST_ABORTED');assert.equal(cancelled,true);
});

test('authenticated actor is injected, fabricated routes rejected, and no internal fields leak through DTO projection',async()=>{
 const route=await parse('/series',config());let calls=0;const raw=configured();raw.private_token='DO_NOT_EXPOSE';raw.receipt.raw={commercial:'DO_NOT_EXPOSE'};
 const result=await executeFiscalNumberingRoute(route,{userId:actor.toUpperCase(),rpc:async(name,args,options)=>{calls++;assert.equal(name,'erp_fiscal_numbering_configure');assert.equal(args.p_user_id,actor);assert.ok(options.signal instanceof AbortSignal);return raw;}});
 assert.equal(calls,1);assert.equal(result.type,'json');assert.doesNotMatch(JSON.stringify(result),/DO_NOT_EXPOSE|private_token|commercial/);
 await reject(()=>executeFiscalNumberingRoute({...route},{userId:actor,rpc:async()=>{throw Error('MUST_NOT_CALL');}}),404);
 await reject(()=>executeFiscalNumberingRoute(route,{userId:'not-uuid',rpc:async()=>{throw Error('MUST_NOT_CALL');}}),401);
});

test('flags, mutation receipt and canonical integer bindings reject plausible but unrelated upstream data',async()=>{
 for(const mutate of [v=>v.can_emit=true,v=>v.environment='1',v=>v.receipt.series='001',v=>v.receipt.number=1,v=>v.receipt.draft_id=randomUUID(),v=>v.receipt.snapshot_hash='b'.repeat(64),v=>v.receipt.series_version=2,v=>v.receipt.company_identity_version=2,v=>v.receipt.item_preparation_version=2,v=>v.current_series.next_number='1',v=>v.current_series.series='9',v=>v.current_basis.basis_changed=true,v=>v.current_basis.draft_archived=true,v=>v.receipt.reserved_at='2026-02-30T10:00:00Z',v=>v.receipt.reserved_at='2026-10-16T10:00:00+14:01',v=>v.current_series.created_at='2026-09-31T10:00:00Z']){
  const value=reserved();mutate(value);await reject(()=>run('/reservations',reserve(),value),502);
 }
 for(const mutate of [v=>v.receipt.reference='Outro texto válido',v=>v.receipt.first_number='2',v=>v.receipt.version=2,v=>v.receipt.company_changed=true]){
  const value=configured();mutate(value);await reject(()=>run('/series',config(),value),502);
 }
});

test('historical reserve receipt remains unchanged while current basis/series advances or is disabled',async()=>{
 const raw=reserved();raw.replayed=true;raw.current_series=series({version:4,next_number:'3',enabled:false,exclusive_use_confirmed:false});raw.current_basis=basis({draft_version:2,draft_status:'archived',basis_changed:true,draft_archived:true});
 const result=(await run('/commands/'+cid,undefined,raw)).body;assert.equal(result.receipt.number,'1');assert.equal(result.receipt.draft_version,1);assert.equal(result.current_series.next_number,'3');assert.equal(result.current_series.enabled,false);assert.equal(result.current_basis.basis_changed,true);
 const read={...raw,read_only:true};delete read.command_id;delete read.action;delete read.replayed;
 assert.equal((await run('/reservations/'+rid,undefined,read)).body.receipt.id,rid);assert.equal((await run('/drafts/'+did,undefined,read)).body.receipt.draft_id,did);
 await reject(()=>run('/reservations/'+randomUUID(),undefined,read),502);await reject(()=>run('/drafts/'+randomUUID(),undefined,read),502);
 raw.current_basis=basis({item_preparation_version:null,basis_changed:true});assert.equal((await run('/commands/'+cid,undefined,raw)).body.current_basis.item_preparation_version,null);
});

test('unreserved draft is explicit; exhausted last number remains a string and is never wrapped',async()=>{
 const empty={...flags,read_only:true,receipt:null,current_series:null,current_basis:null};assert.equal((await run('/drafts/'+did,undefined,empty)).body.receipt,null);await reject(()=>run('/reservations/'+rid,undefined,empty),502);
 const raw=reserved();raw.receipt.number='999999999';raw.current_series=series({version:2,first_number:'999999999',next_number:null,exhausted:true});
 assert.equal((await run('/reservations',reserve(),raw)).body.receipt.number,'999999999');raw.current_series.exhausted=false;await reject(()=>run('/reservations',reserve(),raw),502);
});

test('series pages enforce filtering, ordering, uniqueness and cursor while stripping unrelated metadata',async()=>{
 const a='10000000-0000-0000-0000-000000000001',b='10000000-0000-0000-0000-000000000002';
 const value={...flags,read_only:true,items:[series({id:a}),series({id:b,series:'1'})],limit:2,has_more:true,next_cursor:b};
 const result=(await run('/series?limit=2&model=55',undefined,value)).body;assert.equal(result.items.length,2);assert.equal(result.next_cursor,b);
 for(const mutate of [v=>v.items.reverse(),v=>v.items[1].id=a,v=>v.items[1].model='65',v=>v.items[1].issuer_cnpj='12345678000195',v=>v.next_cursor=a,v=>v.limit=3,v=>v.items.pop()]){const raw=structuredClone(value);mutate(raw);await reject(()=>run('/series?limit=2&model=55',undefined,raw),502);}
});

test('SQL errors and wrapped adapter statuses are sanitized; deadline does not retry a mutation',async()=>{
 const route=await parse('/series',config());
 for(const [source,status,expected] of [[{code:'22023'},400,'ERP_INVALID_QUERY'],[{code:'42501'},403,'ERP_FORBIDDEN'],[{code:'40001'},409,'ERP_CONFLICT'],[{code:'P0002'},404,'ERP_NOT_FOUND'],[{status:400,code:'ERP_INVALID_QUERY'},400,'ERP_INVALID_QUERY'],[{status:409},409,'ERP_CONFLICT'],[{},502,'ERP_FISCAL_NUMBERING_UNAVAILABLE']])await reject(()=>executeFiscalNumberingRoute(route,{userId:actor,rpc:async()=>{throw Object.assign(new Error('PRIVATE_SQL_DETAIL'),source);}}),status,expected);
 let calls=0,signal;await reject(()=>executeFiscalNumberingRoute(route,{userId:actor,timeoutMs:20,rpc:async(_name,_args,options)=>{calls++;signal=options.signal;return new Promise(()=>{});}}),504,'ERP_FISCAL_NUMBERING_TIMEOUT');assert.equal(calls,1);assert.equal(signal.aborted,true);
});

test('actual SQL046→HTTP handles configure, reservation, readback, replay and changed historical basis',async()=>{
 const db=new PGlite(),admin=randomUUID(),fiscal=randomUUID();
 const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].value;
 const rpc=async(name,args)=>{assert.match(name,/^erp_[a-z_]+$/);const pairs=Object.entries(args);return scalar(`select public.${name}(${pairs.map(([key],i)=>key+'=>$'+(i+1)).join(',')})value`,pairs.map(([,value])=>value!==null&&typeof value==='object'?JSON.stringify(value):value));};
 const http=async(path,body,who=fiscal)=>executeFiscalNumberingRoute(await parse(path,body),{userId:who,rpc});
 try{
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);');
  for(const name of ['0001_origin_sync','0002_origin_quotes_nfce','0004_erp_access','0006_erp_catalog','0008_erp_documents','0009_erp_stock','0010_erp_finance','0016_company','0022_fiscal_drafts','0023_product_details','0035_fiscal_item_preparation','0040_fiscal_tax_preparation','0046_fiscal_numbering'])await db.exec(await readFile(new URL('../../../supabase/migrations/20261016'+name+'.sql',import.meta.url),'utf8'));
  for(const[user,role]of [[admin,'admin'],[fiscal,'fiscal']]){await db.query('insert into auth.users values($1)',[user]);await db.query('insert into erp_access.membership(user_id,role)values($1,$2)',[user,role]);}
  const company={legal_name:'EMPRESA FICTICIA046HTTP',cnpj:'11222333000181',postal_code:'13400000',street:'Rua fictícia',number:'1',district:'Centro',city:'Piracicaba',municipality_code:'3538709',state:'SP'};
  await rpc('erp_company_save_identity',{p_user_id:admin,p_expected_version:0,p_command_id:randomUUID(),p_data:company});
  const currentFiscal=await rpc('erp_company_get',{p_user_id:admin,p_section:'fiscal'});await rpc('erp_company_confirm_fiscal',{p_user_id:admin,p_expected_version:currentFiscal.record.version,p_expected_identity_version:1,p_command_id:randomUUID(),p_crt:'1',p_confirmed:true,p_reason:'Confirmação fictícia somente teste'});
  const contact=(await rpc('erp_catalog_save',{p_user_id:admin,p_entity:'contacts',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'CONTATO FICTICIO',person_type:'J',document:'11222333000181',state:'SP'}})).record;
  const product=(await rpc('erp_catalog_save',{p_user_id:admin,p_entity:'products',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'PRODUTO FICTICIO',unit:'UN',kind:'P',format:'S'}})).record;
  const document=(await rpc('erp_document_save',{p_user_id:admin,p_kind:'sales_orders',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_body:{date:'2026-10-16',contact_id:contact.id,items:[{product_id:product.id,description:'FICTICIO',unit:'UN',quantity:'1.000000',unit_price:'10.0000',discount_percent:'0'}]}})).document;
  const draft=(await rpc('erp_fiscal_draft_execute',{p_user_id:fiscal,p_command_id:randomUUID(),p_action:'create',p_data:{source_document_id:document.id,expected_source_version:document.version,model:'55',preparation:{operation_nature:'Venda fictícia',notes:null}}})).record;
  await rpc('erp_fiscal_item_save',{p_user_id:fiscal,p_draft_id:draft.id,p_expected_draft_version:1,p_snapshot_hash:draft.snapshot_hash,p_expected_version:0,p_decisions:[],p_command_id:randomUUID()});
  await rpc('erp_fiscal_tax_save',{p_user_id:fiscal,p_draft_id:draft.id,p_expected_draft_version:1,p_snapshot_hash:draft.snapshot_hash,p_item_preparation_version:1,p_expected_version:0,p_operation:'internal_normal_sale',p_decisions:[],p_command_id:randomUUID()});
  const data={...config(),command_id:randomUUID()},created=(await http('/series',data,admin)).body;assert.equal(created.receipt.next_number,'1');assert.equal((await http('/series')).body.items.length,1);
  assert.equal((await http('/drafts/'+draft.id)).body.receipt,null);
  const chosen={...reserve(),command_id:randomUUID(),series_id:created.receipt.id,draft_id:draft.id,snapshot_hash:draft.snapshot_hash};
  const saved=(await http('/reservations',chosen)).body;assert.equal(saved.receipt.number,'1');assert.equal(saved.current_series.next_number,'2');assert.equal((await http('/reservations',chosen)).body.replayed,true);
  assert.deepEqual((await http('/reservations/'+saved.receipt.id)).body.receipt,saved.receipt);assert.deepEqual((await http('/drafts/'+draft.id)).body.receipt,saved.receipt);
  await rpc('erp_fiscal_draft_execute',{p_user_id:fiscal,p_command_id:randomUUID(),p_action:'archive',p_data:{id:draft.id,expected_version:1,reason:'Arquivo fictício após reserva'}});
  const historical=(await http('/commands/'+chosen.command_id)).body;assert.equal(historical.current_basis.draft_archived,true);assert.equal(historical.current_basis.basis_changed,true);assert.deepEqual(historical.receipt,saved.receipt);
  assert.equal(await scalar('select count(*)::int value from erp_fiscal_numbering.reservation'),1);
  await reject(()=>http('/commands/'+chosen.command_id,undefined,admin),403);await db.query('update erp_access.membership set active=false where user_id=$1',[fiscal]);await reject(()=>http('/reservations',chosen),403);
 }finally{await db.close();}
});
