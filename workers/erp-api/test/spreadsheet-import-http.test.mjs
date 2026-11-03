import test from'node:test';import assert from'node:assert/strict';
import{parsePreferencesRoute as parse,preferencesMethods,executePreferencesRoute}from'../src/preferences.mjs';
import{createHandler}from'../src/index.mjs';
import{IMPORT_TEMPLATES,IMPORT_SLUGS,templateRows,normalizeCell,captureImportBatch}from'../../../packages/erp-domain/src/spreadsheet-import.mjs';

// 228 Importações de Dados: strict routes, canonical rows and closed answers. Synthetic data only.
const ACTOR='10000000-0000-4000-8000-000000000228',CMD='20000000-0000-4000-8000-000000000228',JOB='30000000-0000-4000-8000-000000000228',REC='40000000-0000-4000-8000-000000000228';
const req=(path,init)=>new Request('https://synthetic.invalid'+path,init);
const post=(path,body)=>req(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
const body=(over={})=>({command_id:CMD,job_id:JOB,file_name:'produtos.xlsx',total_rows:2,dry_run:false,items:[{row:2,lines:[2],data:{code:'P-1',name:'Parafuso',price:'2.5',active:true}},{row:3,lines:[3],data:{name:'Porca'}}],...over});
const job=(over={})=>({id:JOB,kind:'products',file_name:'produtos.xlsx',total_rows:2,rows_done:2,created:1,updated:1,unchanged:0,invalid:0,status:'concluida',actor:{user_id:ACTOR,label:'Admin sintético'},
 created_at:'2026-10-20T12:00:00Z',updated_at:'2026-10-20T12:00:01Z',finished_at:'2026-10-20T12:00:01Z',...over});
const answer=(over={})=>({scope:'import_batch',data_mode:'erp_native',kind:'products',dry_run:false,replayed:false,job:job(),
 items:[{row:2,status:'updated',action:'update',reason:null,field:null,record_id:REC,reference:'P-1'},{row:3,status:'created',action:'create',reason:null,field:null,record_id:REC,reference:'Porca'}],...over});

test('228 routes: POST <tipo>/lote for each template, GET the jobs and one job; everything else is refused',async()=>{
 for(const slug of Object.values(IMPORT_SLUGS))assert.deepEqual(preferencesMethods(`/v1/importacoes/${slug}/lote`),['POST'],slug);
 assert.deepEqual(preferencesMethods('/v1/importacoes'),['GET']);assert.deepEqual(preferencesMethods(`/v1/importacoes/${JOB}`),['GET']);
 const route=await parse(post('/v1/importacoes/produtos/lote',body()));
 assert.equal(route.rpc,'erp_preferences_import_batch');assert.equal(route.mutation,true);
 assert.deepEqual({...route.args,p_rows:undefined},{p_command_id:CMD,p_job_id:JOB,p_kind:'products',p_file_name:'produtos.xlsx',p_total_rows:2,p_dry_run:false,p_rows:undefined});
 const dry=await parse(post('/v1/importacoes/produtos/lote',body({command_id:null,job_id:null,dry_run:true})));assert.equal(dry.mutation,false);
 const jobs=await parse(req('/v1/importacoes?situacao=concluida&limit=10'));assert.deepEqual({...jobs.args},{p_status:'concluida',p_limit:10,p_offset:0});
 const one=await parse(req(`/v1/importacoes/${JOB}?erros=1`));assert.deepEqual({...one.args},{p_job_id:JOB,p_errors:true,p_limit:100,p_offset:0});
 for(const[path,status]of[['/v1/importacoes/notas/lote',404],['/v1/importacoes/produtos',404],['/v1/importacoes?situacao=x',400],['/v1/importacoes?limit=101',400],[`/v1/importacoes/${JOB}?erros=0`,400],
  [`/v1/importacoes/${JOB}?x=1`,400],['/v1/importacoes/nao-uuid',404]])
  await assert.rejects(()=>parse(req(path)),e=>e.status===status,path);
 await assert.rejects(()=>parse(post('/v1/importacoes/produtos/lote?x=1',body())),e=>e.status===400);
});

test('228 the batch takes only canonical values of the template, one result per item, and bounded sizes',async()=>{
 const bad=[b=>b.items[0].data.price='2,5',b=>b.items[0].data.unknown='x',b=>b.items[0].data.active='Ativo',b=>b.items[0].data.name=' Parafuso',b=>b.items[0].data.origin='9',
  b=>b.items.push({row:2,lines:[2],data:{name:'Dup'}}),b=>b.items[0].lines=[3],b=>b.items[0].row=1,b=>b.extra=1,b=>b.dry_run='false',b=>b.job_id=null,b=>b.total_rows=0,b=>b.total_rows=10001,
  b=>b.file_name='',b=>b.items=[],b=>b.items=Array.from({length:51},(_,i)=>({row:i+2,lines:[i+2],data:{name:'X'}})),b=>b.items[1].data={},b=>b.items[0].data.expiry_date='2026-02-30',
  b=>b.items[0].data.ncm='1234.56.78',b=>b.items[0].data.free_shipping='Sim'];
 for(const mutate of bad){const b=body();mutate(b);await assert.rejects(()=>parse(post('/v1/importacoes/produtos/lote',b)),e=>e.status===400,String(mutate));}
 // Pedidos: one item per document, its lines in order, the contact by name or CPF/CNPJ, positive quantities.
 const order={command_id:CMD,job_id:JOB,file_name:'pedidos.csv',total_rows:1,dry_run:false,items:[{row:2,lines:[2,4],data:{number:'10',date:'2026-10-10',contact_document:'11222333000181',items:[{code:'P-1',quantity:'2'},{description:'Livre',quantity:'1.5',unit_price:'3'}]}}]};
 assert.equal((await parse(post('/v1/importacoes/pedidos-compra/lote',order))).args.p_rows[0].data.items.length,2);
 for(const mutate of[b=>b.items[0].lines=[2],b=>b.items[0].lines=[2,2],b=>b.items[0].lines=[4,2],b=>delete b.items[0].data.contact_document,b=>b.items[0].data.items[0].quantity='0',
  b=>b.items[0].data.items[1]={quantity:'1'},b=>delete b.items[0].data.date,b=>b.items[0].data.items[0].extra='x',b=>b.items[0].data.contact_document='123'])
 {const b=structuredClone(order);mutate(b);await assert.rejects(()=>parse(post('/v1/importacoes/pedidos-compra/lote',b)),e=>e.status===400,String(mutate));}
 // Contatos: the contatos lane validator decides the shape (enum, length).
 const contact={...body({file_name:'contatos.csv'}),items:[{row:2,lines:[2],data:{name:'Cliente',document:'529.982.247-25',situation:'A',types:['cliente']}}]};
 assert.equal((await parse(post('/v1/importacoes/contatos/lote',contact))).args.p_kind,'contacts');
 for(const data of[{name:'X',situation:'Z'},{name:'X',unknown:'1'},{name:'X'.repeat(201)}]){const b=structuredClone(contact);b.items[0].data=data;await assert.rejects(()=>parse(post('/v1/importacoes/contatos/lote',b)),e=>e.status===400,JSON.stringify(data));}
 const huge=body({items:[{row:2,lines:[2],data:{name:'X',notes:'a'.repeat(2000)}}]});huge.file_name='a'.repeat(200);
 await assert.rejects(()=>parse(req('/v1/importacoes/produtos/lote',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body()).padEnd(262145,' ')})),e=>e.status===400);
});

test('228 answers are closed: forged results are refused; a lost import answer is unconfirmed, a lost validation is not',async()=>{
 const route=await parse(post('/v1/importacoes/produtos/lote',body()));
 const ok=await executePreferencesRoute(route,{userId:ACTOR,rpc:async(name,args)=>{assert.equal(name,'erp_preferences_import_batch');assert.equal(args.p_user_id,ACTOR);return answer();}});
 assert.deepEqual(ok.items.map(i=>i.status),['updated','created']);
 const forged=[v=>v.items.reverse(),v=>v.items[0].status='valid',v=>v.items[1].record_id=null,v=>v.items[0].reason='Texto livre',v=>v.items[0].extra=1,v=>v.job.id=REC,v=>v.job.rows_done=1,
  v=>v.kind='contacts',v=>v.dry_run=true,v=>v.items.pop(),v=>v.items[0].field='name',v=>v.job.status='em_andamento',v=>{v.items[1]={row:3,status:'invalid',action:null,reason:'erp_x',field:null,record_id:REC,reference:null};}];
 // An import answer that does not validate cannot prove what was written: it is unconfirmed (Conferir resultado sends the same command).
 for(const mutate of forged){const v=answer();mutate(v);await assert.rejects(()=>executePreferencesRoute(route,{userId:ACTOR,rpc:async()=>v}),e=>e.status===503&&e.code==='ERP_RESULT_UNCONFIRMED',String(mutate));}
 await assert.rejects(()=>executePreferencesRoute(route,{userId:ACTOR,rpc:async()=>{throw new Error('socket');}}),e=>e.status===503&&e.code==='ERP_RESULT_UNCONFIRMED');
 const dry=await parse(post('/v1/importacoes/produtos/lote',body({command_id:null,job_id:null,dry_run:true})));
 await assert.rejects(()=>executePreferencesRoute(dry,{userId:ACTOR,rpc:async()=>{throw new Error('socket');}}),e=>e.status===502&&e.code==='ERP_UPSTREAM_UNAVAILABLE');
 const valid=await executePreferencesRoute(dry,{userId:ACTOR,rpc:async()=>answer({dry_run:true,job:null,items:[{row:2,status:'valid',action:'update',reason:null,field:null,record_id:null,reference:null},
  {row:3,status:'invalid',action:null,reason:'erp_catalog_name_required',field:'name',record_id:null,reference:null}]})});
 assert.deepEqual(valid.items.map(i=>i.status),['valid','invalid']);
 await assert.rejects(()=>executePreferencesRoute(dry,{userId:ACTOR,rpc:async()=>answer()}),e=>e.status===502&&e.code==='ERP_UPSTREAM_INVALID_RESPONSE');
 // A known refusal of the whole batch keeps its meaning (not unconfirmed).
 for(const[code,status]of[['42501',403],['40001',409],['22023',400]])
  await assert.rejects(()=>executePreferencesRoute(route,{userId:ACTOR,rpc:async()=>{throw Object.assign(new Error(code),{code});}}),e=>e.status===status,code);
});

const env={SUPABASE_URL:'https://project.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-228',ALLOWED_ORIGINS:'https://erp.synthetic.test'},headers={Authorization:'Bearer synthetic-token',Origin:'https://erp.synthetic.test','content-type':'application/json'};
test('228 composed handler binds the token actor to the batch and maps the upstream refusals',async()=>{
 const calls=[],h=createHandler({fetchImpl:async(url,o)=>{calls.push({url,o});return Response.json(url.endsWith('/auth/v1/user')?{id:ACTOR}:answer());}});
 const r=await h(new Request('https://api.synthetic.test/v1/importacoes/produtos/lote',{method:'POST',headers,body:JSON.stringify(body())}),env);
 assert.equal(r.status,200);assert.ok(calls[1].url.endsWith('/rest/v1/rpc/erp_preferences_import_batch'));
 const sent=JSON.parse(calls[1].o.body);assert.equal(sent.p_user_id,ACTOR);assert.equal(sent.p_rows.length,2);
 const denied=createHandler({fetchImpl:async url=>url.endsWith('/auth/v1/user')?Response.json({id:ACTOR}):Response.json({code:'42501',message:'erp_preferences_import_denied'},{status:403})});
 assert.equal((await denied(new Request('https://api.synthetic.test/v1/importacoes/produtos/lote',{method:'POST',headers,body:JSON.stringify(body())}),env)).status,403);
});

test('228 the browser normalizes pt-BR cells to the canonical values the Worker accepts',()=>{
 const price=IMPORT_TEMPLATES.products.columns.find(c=>c.key==='price');
 assert.deepEqual(['1.234,50','1234.5','R$ 10','0,10','007'].map(v=>normalizeCell(price,v).value),['1234.5','1234.5','10','0.1','7']);
 assert.ok(normalizeCell(price,'-1').problem);assert.ok(normalizeCell(price,'1,23456789012').problem);
 const date=IMPORT_TEMPLATES.receivables.columns.find(c=>c.key==='issued_on');
 assert.deepEqual(['20/10/2026','2026-10-20','46315'].map(v=>normalizeCell(date,v).value),['2026-10-20','2026-10-20','2026-10-20']);
 assert.deepEqual(['46315.25','46315.75','46315.999'].map(v=>normalizeCell(date,v).value),['2026-10-20','2026-10-20','2026-10-20'],'a date and time cell keeps its day');assert.ok(normalizeCell(date,'31/02/2026').problem);
 const situation=IMPORT_TEMPLATES.products.columns.find(c=>c.key==='active');assert.equal(normalizeCell(situation,'inativo').value,false);
 const origin=IMPORT_TEMPLATES.products.columns.find(c=>c.key==='origin');assert.equal(normalizeCell(origin,'2 - Estrangeira - Adquirida no mercado interno').value,'2');
 // A whole sheet read in the browser is accepted by the Worker as it is.
 const sheet=templateRows('products',[['Código','Descrição','Preço','Situação','Estoque','NCM'],['P-1','Parafuso','2,50','Ativo','10','8471.30.12'],['','Porca','','','','']]);
 assert.deepEqual(sheet.readOnly,['Estoque']);assert.deepEqual(sheet.items.map(i=>i.data),[{code:'P-1',name:'Parafuso',price:'2.5',active:true,ncm:'84713012'},{name:'Porca'}]);
 assert.equal(captureImportBatch('products',{command_id:null,job_id:null,file_name:'p.csv',total_rows:2,dry_run:true,items:sheet.items.map(({row,lines,data})=>({row,lines,data}))}).items.length,2);
 const orders=templateRows('sales_orders',[['Número do pedido','Data','Cliente','Código do produto','Quantidade'],['1','01/10/2026','Ana','P-1','1'],['2','01/10/2026','Bia','P-1','2'],['1','','','P-2','3']]);
 assert.deepEqual(orders.items.map(i=>[i.row,i.lines,i.data.items.length,i.problems]),[[2,[2,4],2,[]],[3,[3],1,[]]]);
 const mixed=templateRows('sales_orders',[['Número do pedido','Data','Cliente','Código do produto','Quantidade'],['1','01/10/2026','Ana','P-1','1'],['1','02/10/2026','','P-2','0']]);
 assert.deepEqual(mixed.items[0].problems,['Linha 3: Quantidade: maior que zero','Data: valores diferentes nas linhas do mesmo pedido']);
 const missing=templateRows('stock_movements',[['Código do produto','Quantidade'],['P-1','1']]);assert.deepEqual(missing.missing,['Tipo']);
 // "Relacionar colunas": a sheet with other headers is mapped by the user.
 const mapped=templateRows('stock_movements',[['SKU','Operação','Qtd'],['P-1','Entrada','2']],{'Código do produto':'SKU',Tipo:'Operação',Quantidade:'Qtd'});
 assert.deepEqual(mapped.items[0].data,{code:'P-1',movement:'receipt',quantity:'2'});assert.deepEqual(mapped.missing,[]);
});
