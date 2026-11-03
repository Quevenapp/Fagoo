import test from'node:test';import assert from'node:assert/strict';import{randomUUID}from'node:crypto';import{warehouseFixture}from'./helpers/warehouse-import-fixture.mjs';
let f;test.before(async()=>{f=await warehouseFixture();});test.after(async()=>{await f?.close();});
const fails=(fn,code)=>assert.rejects(fn,e=>e.code===code);
test('086 additive migration preserves all prior rows and functions; private helpers/tables not callable',async()=>{
 assert.deepEqual(await f.fingerprint(),f.before);assert.deepEqual(await f.functions(),f.beforeFunctions);
 for(const role of['anon','authenticated','service_role']){assert.equal(await f.scalar("select has_schema_privilege($1,'erp_warehouse_import','usage')v",[role]),false);assert.equal(await f.scalar("select has_table_privilege($1,'erp_warehouse_import.binding','select')v",[role]),false);assert.equal(await f.scalar("select has_function_privilege($1,'erp_warehouse_import.source(origin_sync.raw_record)','execute')v",[role]),false);}
});
test('086 preview is read-only; create by exact ID never matches an existing name and inactive is born inactive',async()=>{
 await f.stage('100',{situacao:0});const before=await f.fingerprint(),p=await f.preview('100');assert.equal(p.planned.active,false);assert.deepEqual(await f.fingerprint(),before);
 const a=f.args(p),r=await f.apply(a);assert.equal(r.receipt.outcome,'created');assert.equal(r.receipt.binding.record.active,false);assert.notEqual(r.receipt.binding.record.id,f.existing.id);assert.equal(r.current.record.version,1);assert.equal(r.current.record.human_edited,false);
 assert.deepEqual((await f.command(a.p_command_id)).receipt,r.receipt);assert.equal((await f.apply(a)).replayed,true);
 for(const k of['erp_stock.balance','erp_stock.entry','erp_stock.movement','erp_stock.reservation','erp_documents.document','erp_documents.item','erp_finance.title','erp_catalog.origin','erp_catalog.source_snapshot'])assert.deepEqual((await f.fingerprint())[k],before[k],k);
 await fails(()=>f.db.query('update erp_warehouse_import.binding set source_version=2 where source_id=$1',['100']),'55000');
});
test('086 source last_seen is freshly captured under lock, not falsely treated as hash/version CAS',async()=>{
 await f.stage('101');const p=await f.preview('101');await f.db.query("update origin_sync.raw_record set last_seen_at=last_seen_at+interval'1 minute'where entity='warehouses'and source_id='101'");const r=await f.apply(f.args(p));assert.notEqual(r.receipt.binding.source.last_seen_at,p.source.last_seen_at);assert.equal(r.receipt.binding.source.source_hash,p.source.source_hash);
});
test('086 existing identity returns a durable already_linked receipt without touching record/snapshot',async()=>{
 await f.stage('102');const p=await f.preview('102'),a=f.args(p),first=await f.apply(a),b=f.args(p);const old=await f.scalar("select to_jsonb(b)v from erp_warehouse_import.binding b where source_id='102'");
 const second=await f.apply(b);assert.equal(second.receipt.outcome,'already_linked');assert.equal(second.receipt.binding.record.id,first.receipt.binding.record.id);assert.deepEqual(await f.scalar("select to_jsonb(b)v from erp_warehouse_import.binding b where source_id='102'"),old);assert.equal((await f.apply(b)).replayed,true);
 const current=first.current.record;await f.rpc('erp_catalog_save',{p_user_id:f.users.admin,p_entity:'warehouses',p_id:current.id,p_expected_version:1,p_command_id:randomUUID(),p_data:{name:'Nome alterado manualmente'}});await f.stage('102',{descricao:'Origem alterada',situacao:0});
 const replay=await f.apply(a);assert.deepEqual(replay.receipt,first.receipt);assert.equal(replay.current.record_state,'changed');assert.equal(replay.current.source_state,'changed');assert.equal(replay.current.record.active,true);const shown=await f.preview('102');assert.equal(shown.can_create,false);assert.equal(shown.existing.record.name,first.receipt.binding.record.name);assert.equal(shown.current.record.name,'Nome alterado manualmente');assert.equal(shown.current.source_state,'changed');
 await f.db.query("delete from origin_sync.raw_record where entity='warehouses'and source_id='102'");assert.equal((await f.command(a.p_command_id)).current.source_state,'missing');assert.ok((await f.page()).items.find(v=>v.source_id==='102').binding);
});
test('086 source CAS, preview/confirmation mismatch and malformed fields cannot create',async()=>{
 await f.stage('103');const p=await f.preview('103'),a=f.args(p);await f.stage('103',{descricao:'Nova observação'});await fails(()=>f.apply(a),'40001');
 for(const [id,patch,issue]of[['110',{situacao:'1'},'STATUS_INVALID'],['111',{padrao:1},'DEFAULT_INVALID'],['112',{desconsiderarSaldo:null},'BALANCE_SETTING_INVALID'],['113',{descricao:'x'.repeat(201)},'NAME_INVALID'],['114',{descricao:'Nome\u0085'},'NAME_INVALID'],['115',{id:'999'},'SOURCE_INVALID']]){await f.stage(id,patch);const x=await f.preview(id);assert.equal(x.can_create,false);assert.ok(x.source.issues.includes(issue));}
 const fresh=await f.preview('103');await fails(()=>f.apply({...f.args(fresh),p_confirmed:false}),'22023');await fails(()=>f.apply({...f.args(fresh),p_preview_hash:'f'.repeat(64)}),'40001');
});
test('086 exact decimal identity preserves leading zeros and rejects unsafe numeric source IDs',async()=>{
 await f.stage('00120');const p=await f.preview('00120');assert.equal(p.source.source_id,'00120');assert.equal((await f.apply(f.args(p))).receipt.source_id,'00120');
 await f.stage('9007199254740992',{id:9007199254740992});assert.equal((await f.preview('9007199254740992')).can_create,false);
});
test('086 symmetric006 command collision and payload/actor replay conflicts',async()=>{
 await f.stage('130');const p=await f.preview('130'),a=f.args(p);await f.apply(a);await fails(()=>f.catalog('warehouses',{name:'Não criar'},a.p_command_id),'40001');await fails(()=>f.apply({...a,p_source_version:'2'}),'40001');await fails(()=>f.apply({...a,p_user_id:f.users.other}),'40001');await fails(()=>f.command(a.p_command_id,f.users.other),'42501');
 const old=randomUUID();await f.catalog('warehouses',{name:'Comando006'},old);await fails(()=>f.apply(f.args(p,old)),'40001');
});
test('086 admin ACL applies to list, preview, apply, command and historical replay after revocation',async()=>{
 await f.stage('140');const p=await f.preview('140'),a=f.args(p);await f.apply(a);
 for(const role of['estoque','financeiro','vendas','fiscal','consulta']){await fails(()=>f.page({p_user_id:f.users[role]}),'42501');await fails(()=>f.preview('140',f.users[role]),'42501');}
 await f.db.query("update erp_access.membership set active=false where user_id=$1",[f.users.admin]);try{await fails(()=>f.apply(a),'42501');await fails(()=>f.command(a.p_command_id),'42501');}finally{await f.db.query('update erp_access.membership set active=true where user_id=$1',[f.users.admin]);}
});
test('086 failure after creation rolls back native record/binding/command/audit together',async()=>{
 await f.stage('150');const p=await f.preview('150'),a=f.args(p);const before=await f.fingerprint();await f.db.exec("create function public.synthetic_086_fail()returns trigger language plpgsql as $$begin raise exception 'synthetic failure';end$$;create trigger synthetic_086_fail before insert on erp_warehouse_import.command for each row execute function public.synthetic_086_fail();");try{await assert.rejects(()=>f.apply(a));}finally{await f.db.exec('drop trigger synthetic_086_fail on erp_warehouse_import.command;drop function public.synthetic_086_fail();');}
 assert.deepEqual(await f.fingerprint(),before);assert.equal(await f.scalar("select count(*)::int v from erp_warehouse_import.binding where source_id='150'"),0);
});
test('086 SQL → HTTP → closed DTO preserves active/inactive, existing binding and fresh observation metadata',async()=>{
 const{parseWarehouseImportRoute:parse,executeWarehouseImportRoute:execute}=await import('../src/origin-warehouse-import.mjs');const make=(path,body)=>new Request('https://synthetic.invalid/v1/depositos-origin'+path,{method:body?'POST':'GET',...(body?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});const port=async(path,body)=>execute(await parse(make(path,body)),{userId:f.users.admin,rpc:f.rpc});
 await f.stage('200',{situacao:0});const s=await f.source('200'),p=await port('/200/preview',{expected_source_hash:s.p_source_hash,expected_source_version:s.p_source_version});const body={command_id:randomUUID(),expected_source_hash:p.source.source_hash,expected_source_version:p.source.source_version,preview_hash:p.preview_hash,confirmed:true};const done=await port('/200/import',body);assert.equal(done.receipt.binding.record.active,false);assert.deepEqual((await port('/commands/'+body.command_id)).receipt,done.receipt);assert.equal((await port('/200/preview',{expected_source_hash:s.p_source_hash,expected_source_version:s.p_source_version})).existing.record.id,done.receipt.binding.record.id);assert.ok((await port('?limit=25')).items.some(i=>i.source_id==='200'));
});
