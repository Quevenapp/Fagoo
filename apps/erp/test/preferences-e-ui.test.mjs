import test from'node:test';import assert from'node:assert/strict';
import{mountComponent}from'./helpers/component-recovery-harness.mjs';
import{createBusinessFixture}from'../src/qa/business-fixture.ts';
import{captureSystemPortRequest}from'../src/lib/system-request.ts';
import{SCREEN_TEMPLATES}from'../src/lib/spreadsheet-import.ts';
import{resolvePreferences}from'../src/lib/origin-menu.ts';
import{parsePreferencesPath}from'../src/lib/preferences-route.ts';
import{normalizedValue,invalidText}from'../src/lib/preferences-model.ts';
import{preferencePage}from'../../../packages/erp-domain/src/preferences/catalog.mjs';

// Wave E of Preferências and Meu Negócio (264-265). Synthetic data only.
let previous;test.before(()=>{previous=globalThis.document;globalThis.document={activeElement:null,documentElement:{dataset:{}},addEventListener(){},removeEventListener(){},querySelector:()=>null,
 body:{append(){},classList:{add(){},remove(){}}},createElement:()=>({click(){},remove(){}})};globalThis.URL.createObjectURL??=()=>'blob:synthetic';globalThis.URL.revokeObjectURL??=()=>{};});
test.after(()=>{globalThis.document=previous;});
const ADMIN='a0000000-0000-4000-8000-000000000265',REC='c0000000-0000-4000-8000-000000000265';

test('265 Previsão de Estoque: Variações + Simples + Composições and Desmembrados, Produtos disabled with the reason',async()=>{
 const f=createBusinessFixture(),v=await mountComponent('BusinessDashboards.tsx',{controller:f.controller},{location:'/meu-negocio?painel=previsao-estoque',expandChildren:true});try{
  const forecast=()=>f.calls.filter(c=>c.path.startsWith('/v1/meu-negocio/previsao-estoque')).map(c=>c.path);
  assert.doesNotMatch(forecast()[0],/modo=/,'the first view is the default');
  assert.match(v.text(),/Variações \+ Simples \+ ComposiçõesProdutosDesmembrados/);assert.match(v.text(),/Composição/);
  const produtos=v.button('Produtos');assert.equal(produtos.disabled,true);assert.match(produtos.props.title,/não tem produtos com variações/);
  await v.click('Desmembrados');assert.match(forecast().at(-1),/modo=desmembrados/);
  assert.match(v.text(),/Cada composição com estrutura vendida entra pelos seus componentes/);
  await v.click('Variações + Simples + Composições');assert.doesNotMatch(forecast().at(-1),/modo=/);
  await v.click('Como funciona');assert.match(v.text(),/custo médio do estoque/);
 }finally{v.unmount();}
 const g=createBusinessFixture(),w=await mountComponent('BusinessDashboards.tsx',{controller:g.controller},{location:'/meu-negocio?painel=margem-pedido',expandChildren:true});try{
  const select=w.nodes().find(n=>n.type==='select'&&n.props.id==='business-cost-type');assert.equal(select.props.value,'aplicado');assert.equal(select.props.disabled,true);
  // Leva H (374): the cost applied at the confirmation of each pedido; changing the current cost does not change old sales.
  assert.match(w.text(),/custo é o aplicado na confirmação comercial de cada pedido/);assert.match(w.text(),/Mudar o custo atual do produto não altera vendas antigas/);
 }finally{w.unmount();}
});

function importServer(){
 const snapshot={phase:'ready',membership:{user_id:ADMIN,role:'admin',resources:['products','contacts']}},calls=[];
 const kinds={composicoes:'compositions','campos-customizados':'custom_fields','fornecedores-produtos':'product_suppliers'};
 const controller={getSnapshot:()=>snapshot,subscribe:()=>()=>{},
  async system(path,options={}){const captured=captureSystemPortRequest(path,options),body=captured.options.body;calls.push({path,body});
   const kind=kinds[path.split('/')[3]];
   const items=body.items.map(i=>body.dry_run?{row:i.row,status:'valid',action:'create',reason:null,field:null,record_id:null,reference:null}
    :{row:i.row,status:'created',action:'create',reason:null,field:null,record_id:REC,reference:`Composição ${i.data.code}`});
   return{scope:'import_batch',data_mode:'erp_native',kind,dry_run:body.dry_run,replayed:false,items,job:body.dry_run?null:{id:body.job_id,kind,file_name:body.file_name,total_rows:body.total_rows,rows_done:items.length,
    created:items.length,updated:0,unchanged:0,invalid:0,status:'concluida',actor:{user_id:ADMIN,label:'Admin sintético'},created_at:'2026-10-20T12:00:00Z',updated_at:'2026-10-20T12:00:01Z',finished_at:'2026-10-20T12:00:01Z'}};},
  async catalog(){return{items:[],can_create:false,can_delete:false};}};
 return{controller,calls};
}
const choose=async(v,file)=>{v.input('import-file').props.onChange({target:{files:[file]}});for(let i=0;i<20;i++)await v.flush();};

test('265 Importar composições: the lines of one Código do produto form one structure, sent to its strict route',async()=>{
 const s=importServer(),v=await mountComponent('SpreadsheetImport.tsx',{controller:s.controller,kind:'compositions'});try{
  assert.match(v.text(),/Importar composições/);assert.match(v.text(),/Uma linha por componente/);
  await choose(v,new File(['Código do produto;Descrição;Tipo de estoque;Lançar estoque;Código do componente;Descrição do componente;Quantidade\r\nKIT-1;Kit;Virtual;;A;Caneta;2\r\nKIT-1;Kit;Virtual;;B;Tampa;0,5\r\n'],'composicoes.csv',{type:'text/csv'}));
  await v.click('Validar');
  const dry=s.calls.filter(c=>c.body?.dry_run===true);assert.equal(dry.length,1);assert.equal(dry[0].path,'/v1/importacoes/composicoes/lote');
  assert.deepEqual(dry[0].body.items,[{row:2,lines:[2,3],data:{code:'KIT-1',stock_type:'virtual',items:[{code:'A',quantity:'2'},{code:'B',quantity:'0.5'}]}}]);
  assert.match(v.text(),/Composição KIT-1 · 2 componentes/);
  await v.click('Importar 1 composição');
  const real=s.calls.filter(c=>c.body?.dry_run===false);assert.equal(real.length,1);assert.match(real[0].body.command_id,/^[0-9a-f-]{36}$/);
  assert.match(v.text(),/Importação concluída: 1 incluído/);
 }finally{v.unmount();}
});

test('265 the hub lists the new imports and the lista de preços link; every screen has its model sheet',async()=>{
 const imports=resolvePreferences({role:'admin',resources:[]}).find(c=>c.id==='importacoes').entries;
 for(const[label,to]of[['Importar composições','/preferencias/importacoes/composicoes'],['Importar campos customizados','/preferencias/importacoes/campos-customizados'],
  ['Importar fornecedores de produto','/preferencias/importacoes/fornecedores-produtos'],['Importar lista de preços','/listas-precos']])assert.ok(imports.some(i=>i.label===label&&i.to===to),label);
 for(const[slug,kind]of[['composicoes','compositions'],['campos-customizados','custom_fields'],['fornecedores-produtos','product_suppliers']]){
  assert.deepEqual(parsePreferencesPath(`/preferencias/importacoes/${slug}`),{kind:'import',importKind:kind});assert.equal(typeof SCREEN_TEMPLATES[kind]?.identity,'function',kind);}
});

test('264 Prefixo GS1: only 7 to 11 digits leave the page, with the Origin message',()=>{
 const field=preferencePage('cadastros-produtos').fields.find(f=>f.key==='produtos.ean_prefixo');
 assert.equal(field.format,'digits');assert.equal(field.minLength,7);assert.equal(field.maxLength,11);
 for(const bad of['123','789123456789','78912a4'])assert.equal(normalizedValue(field,bad),undefined,bad);
 assert.equal(normalizedValue(field,'7891234'),'7891234');assert.equal(normalizedValue(field,''),'');
 assert.equal(invalidText(field),'Use só números, de 7 a 11 dígitos.');
});
