import test from'node:test';import assert from'node:assert/strict';
import{mountComponent,AccessError}from'./helpers/component-recovery-harness.mjs';
import{captureSystemPortRequest}from'../src/lib/system-request.ts';
import{readSpreadsheet,parseCsv,remapHeader,SCREEN_TEMPLATES,reasonText,jobState,batches}from'../src/lib/spreadsheet-import.ts';
import{toXlsx,textCell,numberCell}from'../src/lib/spreadsheet-export.ts';
import{resolvePreferences}from'../src/lib/origin-menu.ts';
import{parsePreferencesPath}from'../src/lib/preferences-route.ts';

// 228 Importações de Dados (PRF-023, PRF-024, PRF-025) and Consultar gestão de ações (PRF-280). Synthetic data only.
let previous;test.before(()=>{previous=globalThis.document;globalThis.document={activeElement:null,documentElement:{dataset:{}},addEventListener(){},removeEventListener(){},querySelector:()=>null,body:{append(){},classList:{add(){},remove(){}}}};});
test.after(()=>{globalThis.document=previous;});
const ADMIN='a0000000-0000-4000-8000-000000000228',JOB_USER='b0000000-0000-4000-8000-000000000228',REC='c0000000-0000-4000-8000-000000000228';
const job=(over={})=>({id:'d0000000-0000-4000-8000-000000000228',kind:'products',file_name:'produtos.csv',total_rows:2,rows_done:2,created:1,updated:1,unchanged:0,invalid:0,status:'concluida',
 actor:{user_id:ADMIN,label:'Admin sintético'},created_at:'2026-10-20T12:00:00Z',updated_at:'2026-10-20T12:00:01Z',finished_at:'2026-10-20T12:00:01Z',...over});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
/** Synthetic server: answers each batch from the rows it receives, as the SQL does. */
function server({role='admin',fail=[]}={}){
 let snapshot={phase:'ready',membership:{user_id:ADMIN,role,resources:['products','contacts']}};const listeners=new Set(),calls=[];
 const answer=(body)=>{const items=body.items.map(i=>{const update=i.data.code==='P-1';
   if(!i.data.name&&!update)return{row:i.row,status:'invalid',action:null,reason:'erp_catalog_name_required',field:'name',record_id:null,reference:null};
   return body.dry_run?{row:i.row,status:'valid',action:update?'update':'create',reason:null,field:null,record_id:null,reference:null}
    :{row:i.row,status:update?'updated':'created',action:update?'update':'create',reason:null,field:null,record_id:REC,reference:i.data.code??i.data.name};});
  const done=items.filter(i=>i.status!=='valid');
  return{scope:'import_batch',data_mode:'erp_native',kind:'products',dry_run:body.dry_run,replayed:false,items,
   job:body.dry_run?null:job({id:body.job_id,file_name:body.file_name,total_rows:body.total_rows,rows_done:done.length,created:done.filter(i=>i.status==='created').length,updated:done.filter(i=>i.status==='updated').length,
    status:done.length===body.total_rows?'concluida':'em_andamento',finished_at:done.length===body.total_rows?'2026-10-20T12:00:01Z':null})};};
 const controller={getSnapshot:()=>snapshot,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},
  async system(path,options={}){const captured=captureSystemPortRequest(path,options);calls.push({path,method:captured.options.method,body:captured.options.body});
   const step=fail.shift();if(step)await step(calls.at(-1));return answer(captured.options.body);},
  async catalog(){return{items:[{id:'t1',slug:'cliente',label:'Cliente',system:true,deletable:false,position:1,contacts:0}],can_create:false,can_delete:false};}};
 return{controller,calls,setRole(next){snapshot={...snapshot,membership:{...snapshot.membership,role:next}};for(const fn of listeners)fn();}};
}
const csvFile=(text,name='produtos.csv')=>new File([text],name,{type:'text/csv'});
const mount=(s,kind='products')=>mountComponent('SpreadsheetImport.tsx',{controller:s.controller,kind});
const choose=async(v,file)=>{v.input('import-file').props.onChange({target:{files:[file]}});for(let i=0;i<20;i++)await v.flush();};
const CSV='Código;Descrição;Preço;Estoque\r\nP-1;Parafuso renomeado;3,75;10\r\n;Porca;1,5;\r\nP-3;;;\r\n';

test('228 Importar e atualizar produtos: Procurar arquivo, Relacionar colunas, Validar, Conferir registros and Importar in batches with one command each',async()=>{
 const s=server(),v=await mount(s);try{
  assert.match(v.text(),/Importar e atualizar produtosImportações de Dados · planilha modelo/);assert.match(v.text(),/Procurar arquivoRelacionar colunasValidarConferir registrosImportar/);
  assert.match(v.text(),/Origem vazia usa a "Origem padrão de tributação de produtos"/);
  await choose(v,csvFile(CSV));
  assert.match(v.text(),/produtos\.csv · 3 linhas/);assert.match(v.text(),/Colunas só de consulta, não importadas: Estoque/);
  const selects=v.nodes().filter(n=>n.type==='select'&&String(n.props.id).startsWith('import-map-'));
  assert.equal(selects[0].props.value,'Código');assert.equal(selects[1].props.value,'Descrição');assert.equal(v.guard().changed,true);
  assert.equal(v.button('Importar ').disabled,true,'Importar waits for Validar');
  await v.click('Validar');
  const dry=s.calls.filter(c=>c.body?.dry_run===true);assert.equal(dry.length,1);
  assert.deepEqual(dry[0].body.items.map(i=>i.data),[{code:'P-1',name:'Parafuso renomeado',price:'3.75'},{name:'Porca',price:'1.5'},{code:'P-3'}]);
  assert.equal(dry[0].path,'/v1/importacoes/produtos/lote');assert.equal(dry[0].body.command_id,null);
  assert.match(v.text(),/Válido · Atualizar/);assert.match(v.text(),/Válido · Incluir/);assert.match(v.text(),/Descrição: obrigatório para incluir/);
  await v.click('Importar 2 produtos');
  const real=s.calls.filter(c=>c.body?.dry_run===false);assert.equal(real.length,1);
  assert.match(real[0].body.command_id,/^[0-9a-f-]{36}$/);assert.match(real[0].body.job_id,/^[0-9a-f-]{36}$/);assert.equal(real[0].body.total_rows,2);assert.deepEqual(real[0].body.items.map(i=>i.row),[2,3]);
  assert.match(v.text(),/Importação concluída: 1 incluído, 1 atualizado, 0 sem alteração e 0 com erro/);assert.match(v.text(),/Atualizado · P-1/);
  assert.equal(v.guard().changed,false,'nothing left to lose after the import');
 }finally{v.unmount();}
});

test('228 an uncertain batch offers Conferir resultado with the same command; a refused batch says nothing was recorded',async()=>{
 const s=server({fail:[null,()=>{throw new AccessError(503);}]}),v=await mount(s);try{
  await choose(v,csvFile(CSV));await v.click('Validar');await v.click('Importar 2 produtos');
  assert.match(v.text(),/Não foi possível confirmar a importação deste lote/);assert.equal(v.guard().busy,true);
  assert.equal(v.nodes().find(n=>n.props.id==='import-file').disabled,true,'no other file while the batch is uncertain');
  await v.click('Conferir resultado');
  const real=s.calls.filter(c=>c.body?.dry_run===false);assert.equal(real.length,2);assert.deepEqual(real[1].body,real[0].body,'the same command and body');
  assert.match(v.text(),/Importação concluída/);
 }finally{v.unmount();}
 const r=server({fail:[null,()=>{throw new AccessError(409);}]}),w=await mount(r);try{
  await choose(w,csvFile(CSV));await w.click('Validar');await w.click('Importar 2 produtos');
  assert.match(w.text(),/Lote 1: Esta importação mudou ou já foi concluída/);assert.equal(w.nodes().some(n=>n.type==='button'&&n.props.children==='Conferir resultado'),false);
 }finally{w.unmount();}
});

test('228 Relacionar colunas: another header is related by the user; required fields block Validar until related',async()=>{
 const s=server(),v=await mount(s,'stock_movements');try{
  await choose(v,csvFile('SKU;Operação;Qtd\r\nP-1;Entrada;2\r\n','estoque.csv'));
  assert.match(v.text(),/Relacione as colunas obrigatórias: Código do produto, Tipo, Quantidade/);assert.equal(v.button('Validar').disabled,true);
  const ids=Object.fromEntries(v.nodes().filter(n=>n.type==='select'&&String(n.props.id).startsWith('import-map-')).map(n=>[v.text.length&&n.props.id,n]));
  await v.change('import-map-0','SKU');await v.change('import-map-2','Operação');await v.change('import-map-3','Qtd');
  assert.doesNotMatch(v.text(),/Relacione as colunas obrigatórias/);assert.equal(v.button('Validar').disabled,false);
  await v.click('Validar');assert.deepEqual(s.calls.at(-1).body.items[0].data,{code:'P-1',movement:'receipt',quantity:'2'});assert.equal(s.calls.at(-1).path,'/v1/importacoes/movimentacoes-estoque/lote');
  void ids;
 }finally{v.unmount();}
});

test('228 a late validation answer of another file or role is dropped; a non-administrador sees no import',async()=>{
 const gate=deferred(),s=server({fail:[async()=>gate.promise]}),v=await mount(s);try{
  await choose(v,csvFile(CSV));const pending=v.click('Validar');
  await choose(v,csvFile('Código;Descrição\r\nP-9;Outro\r\n','outro.csv'));gate.resolve();await pending;await v.flush();
  assert.match(v.text(),/outro\.csv · 1 linha/);assert.doesNotMatch(v.text(),/Válido · Atualizar/,'the answer for the first file is not shown');
  s.setRole('vendas');await v.flush();assert.match(v.text(),/Importar planilhas é uma ferramenta do administrador da empresa/);
 }finally{v.unmount();}
 const other=server({role:'estoque'}),w=await mount(other);try{assert.match(w.text(),/ferramenta do administrador/);assert.equal(other.calls.length,0);}finally{w.unmount();}
});

test('228 Importar e atualizar contatos reads the contatos sheet with its own reader and the contact types',async()=>{
 const s=server(),v=await mount(s,'contacts');try{
  await choose(v,csvFile('Nome;CPF/CNPJ;Tipo de Contato;Vendedor\r\nCliente Novo;529.982.247-25;Cliente;Fulano\r\n','contatos.csv'));
  assert.match(v.text(),/Colunas só de consulta, não importadas: Vendedor/);
  await v.click('Validar');assert.deepEqual(s.calls.at(-1).body.items[0].data,{name:'Cliente Novo',document:'529.982.247-25',types:['cliente']});
 }finally{v.unmount();}
});

test('228 readers, batches and texts: CSV and XLSX give the same cells; batches respect items and lines; reasons are Portuguese',async()=>{
 const xlsx=toXlsx('Produtos',[[textCell('Código'),textCell('Preço')],[textCell('P-1'),numberCell('1234.5')]]);
 assert.deepEqual(await readSpreadsheet('p.xlsx',xlsx),[['Código','Preço'],['P-1','1234.5']]);
 assert.deepEqual(await readSpreadsheet('p.csv',new TextEncoder().encode('﻿Código;Preço\r\n"P;1";"1,5"\r\n\r\n')),[['Código','Preço'],['P;1','1,5']]);
 await assert.rejects(()=>readSpreadsheet('p.pdf',new Uint8Array([1])),/Selecione uma planilha/);await assert.rejects(()=>readSpreadsheet('p.csv',new Uint8Array()),/vazio/);
 assert.throws(()=>parseCsv('a;"b\r\n'),/aspas sem fechamento/);
 assert.deepEqual(remapHeader(['Nome do cliente','Nome'],['Nome'],{Nome:'Nome do cliente'}),['Nome','']);
 const items=Array.from({length:120},(_,i)=>({row:i+2,lines:[i+2]}));assert.deepEqual(batches(items).map(b=>b.length),[50,50,20]);
 const docs=Array.from({length:3},(_,i)=>({row:i,lines:Array.from({length:200},(_,j)=>j)}));assert.deepEqual(batches(docs).map(b=>b.length),[2,1]);
 assert.equal(reasonText('sales_orders',{reason:'erp_preferences_import_not_found:item_code',field:'item_code'}),'Código do produto: não encontrado no FAGOO');
 assert.equal(reasonText('receivables',{reason:'erp_preferences_import_ambiguous:contact_name',field:'contact_name'}),'Cliente: há mais de um cadastro com esse valor');
 assert.equal(reasonText('stock_movements',{reason:'erp_stock_insufficient_or_excess_quantity',field:null}),'Estoque insuficiente: a política de estoque não permite saldo negativo');
 assert.equal(reasonText('contacts',{reason:'erp_catalog_contact_required:email',field:'email'}),'Obrigatório pelas Preferências: E-Mail');
 assert.equal(reasonText('products',{reason:'erp_x_y',field:null}),'Linha recusada pelo FAGOO (erp_x_y)');
 assert.equal(jobState({status:'em_andamento',updated_at:'2026-10-20T12:00:00Z'},Date.parse('2026-10-20T12:10:00Z')),'Em andamento');
 assert.equal(jobState({status:'em_andamento',updated_at:'2026-10-20T12:00:00Z'},Date.parse('2026-10-20T13:00:00Z')),'Interrompida');
 assert.equal(SCREEN_TEMPLATES.products.columns.length>40,true);
 assert.equal(reasonText('nfe',{reason:'erp_preferences_import_required:nature',field:'nature'}),'Natureza de operação: informe a natureza ou defina a padrão em Naturezas de operação');
 const notes=SCREEN_TEMPLATES.nfe.parse([['Número da nota','Cliente','Código do produto','Quantidade'],['1','Ana','P-1','1,5'],['1','','P-2','2']],{'Número da nota':'Número da nota',Cliente:'Cliente','Código do produto':'Código do produto',Quantidade:'Quantidade'},{types:[]});
 assert.deepEqual(notes.items.map(i=>[i.lines,i.data.items,i.problems]),[[[2,3],[{code:'P-1',quantity:'1.5'},{code:'P-2',quantity:'2'}],[]]]);assert.equal(SCREEN_TEMPLATES.nfe.identity(notes.items[0]),'Nota 1 · 2 itens');
});

test('228 the Preferências hub opens every import for the administrador; the routes and the browser capture are strict',()=>{
 const hub=resolvePreferences({role:'admin',resources:[]}).find(c=>c.id==='importacoes');
 // In the order of the Origin hub (Produtos, Contatos, Suprimentos, Fiscal, Finanças, Vendas); 265 adds the imports of composições,
 // campos customizados, lista de preços and fornecedores de produto in their Origin groups; 300 adds the lotes after the lista de preços.
 assert.deepEqual(hub.entries.map(e=>[e.label,e.to]).slice(0,12),[['Importar e atualizar produtos','/preferencias/importacoes/produtos'],['Importar composições','/preferencias/importacoes/composicoes'],
  ['Importar campos customizados','/preferencias/importacoes/campos-customizados'],['Importar lista de preços','/listas-precos'],['Importar lotes','/preferencias/importacoes/lotes'],['Importar e atualizar contatos','/preferencias/importacoes/contatos'],
  ['Importar pedidos de compra','/preferencias/importacoes/pedidos-compra'],['Importar movimentações de estoque em massa','/preferencias/importacoes/movimentacoes-estoque'],
  ['Importar fornecedores de produto','/preferencias/importacoes/fornecedores-produtos'],['Importar notas fiscais em Lote','/preferencias/importacoes/notas-fiscais'],
  ['Importar contas a receber/pagar','/preferencias/importacoes/contas-receber'],['Importar vendas','/preferencias/importacoes/vendas']]);
 assert.equal(resolvePreferences({role:'vendas',resources:[]}).some(c=>c.id==='importacoes'),false);
 assert.deepEqual(parsePreferencesPath('/preferencias/importacoes/contas-pagar'),{kind:'import',importKind:'payables'});assert.deepEqual(parsePreferencesPath('/preferencias/sistema/gestao-acoes'),{kind:'actions'});
 assert.equal(parsePreferencesPath('/preferencias/importacoes/notas').kind,'missing');
 assert.equal(captureSystemPortRequest('/v1/importacoes?situacao=concluida&limit=10',{}).base,'/v1/importacoes');
 for(const[path,options]of[['/v1/importacoes?situacao=x',{}],['/v1/importacoes/produtos/lote',{method:'GET'}],['/v1/importacoes/produtos/lote',{method:'POST',body:{}}],['/v1/importacoes/nada',{}],
  [`/v1/importacoes/${REC}?erros=0`,{}],['/v1/importacoes?x=1',{}]])assert.throws(()=>captureSystemPortRequest(path,options),undefined,path);
 const body={command_id:null,job_id:null,file_name:'p.csv',total_rows:1,dry_run:true,items:[{row:2,lines:[2],data:{name:'X'}}]};
 assert.deepEqual(Object.keys(captureSystemPortRequest('/v1/importacoes/produtos/lote',{method:'POST',body}).options.body).sort(),['command_id','dry_run','file_name','items','job_id','total_rows']);
});

function jobsServer(){
 const calls=[],snapshot={phase:'ready',membership:{user_id:ADMIN,role:'admin',resources:[]}};
 const controller={getSnapshot:()=>snapshot,subscribe:()=>()=>{},async system(path,options={}){captureSystemPortRequest(path,options);calls.push(path);
  if(path.startsWith('/v1/importacoes?')){const status=new URL(path,'https://x.invalid').searchParams.get('situacao');
   const all=[job({invalid:1,created:0,updated:1}),job({id:'e0000000-0000-4000-8000-000000000228',kind:'stock_movements',file_name:'estoque.csv',status:'em_andamento',rows_done:1,created:1,updated:0,finished_at:null,actor:{user_id:JOB_USER,label:'Outro admin'}})],items=all.filter(j=>!status||j.status===status);
   return{scope:'import_jobs',data_mode:'erp_native',status,limit:25,offset:0,total:items.length,has_more:false,all_users:true,items};}
  const q=new URL(path,'https://x.invalid').searchParams;
  return{scope:'import_job',data_mode:'erp_native',job:job({invalid:1,created:0,updated:1}),errors:q.get('erros')==='1',limit:100,offset:0,total:1,has_more:false,
   items:[{row:3,status:'invalid',action:null,reason:'erp_preferences_import_not_found:category',field:'category',record_id:null,reference:null}]};}};
 return{controller,calls};
}
test('228 Consultar gestão de ações lists the actions with progress and result, and opens the result of each line',async()=>{
 const s=jobsServer(),v=await mountComponent('RealImportJobs.tsx',{controller:s.controller},{expandChildren:true});try{
  assert.deepEqual(v.nodes().filter(n=>n.type==='th').map(n=>{const t=JSON.stringify(n.props.children);return t;}).length,8);
  assert.match(v.text(),/Importar e atualizar produtos/);assert.match(v.text(),/Importar movimentações de estoque em massa/);assert.match(v.text(),/Outro admin/);
  assert.match(v.text(),/0 incluídos · 1 atualizados · 0 sem alteração · 1 com erro/);assert.match(v.text(),/Quantidade de ações: 2/);
  await v.change('jobs-status','concluida');assert.equal(s.calls.at(-1),'/v1/importacoes?situacao=concluida&limit=25&offset=0');
  v.nodes().find(n=>n.type==='button'&&n.props.children==='Ver resultado').props.onClick();await v.flush();
  assert.equal(s.calls.at(-1),'/v1/importacoes/d0000000-0000-4000-8000-000000000228?erros=1&limit=100&offset=0','a job with errors opens on them');
  assert.match(v.text(),/Categoria do produto: não encontrado no FAGOO/);
 }finally{v.unmount();}
});

test('228 a role change during an import batch keeps that batch as Conferir resultado with the same command; it is never imported as new rows',async()=>{
 const s=server(),answer=s.controller.system.bind(s.controller),gate=deferred();let held=false;
 // The import batch waits; the role change aborts it in the browser (the server may have recorded it all the same).
 s.controller.system=async(path,options={})=>{if(options.body?.dry_run===false&&!held){held=true;s.calls.push({path,method:'POST',body:options.body});
  return new Promise((resolve,reject)=>{options.signal?.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true});gate.promise.then(resolve,reject);});}
  return answer(path,options);};
 const v=await mount(s);try{
  await choose(v,csvFile(CSV));await v.click('Validar');v.button('Importar 2 produtos').props.onClick();await v.flush();assert.equal(held,true);
  s.setRole('vendas');for(let i=0;i<5;i++)await v.flush();
  assert.match(v.text(),/Importar planilhas é uma ferramenta do administrador da empresa/);
  s.setRole('admin');await v.flush();
  assert.match(v.text(),/Não foi possível confirmar a importação deste lote/);assert.equal(v.button('Importar 2 produtos')?.disabled??true,true,'no second import of the same rows');
  assert.equal(v.guard().busy,true,'the uncertain batch keeps the screen');
  await v.click('Conferir resultado');
  const real=s.calls.filter(c=>c.body?.dry_run===false);assert.equal(real.length,2);assert.deepEqual(real[1].body,real[0].body,'the same command, job and rows');
  assert.match(v.text(),/Importação concluída/);
 }finally{gate.resolve();v.unmount();}
});
