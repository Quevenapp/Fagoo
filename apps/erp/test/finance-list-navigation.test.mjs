import assert from 'node:assert/strict';
import test from 'node:test';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {todaySP} from '../src/lib/real-finance-model.ts';
import {defaultTitlePeriod} from '../src/lib/finance-list-route.ts';
const id='10000000-0000-4000-8000-000000000001',other='10000000-0000-4000-8000-000000000002';
const payments={settled_on:null,fee_cents:'0',interest_cents:'0',penalty_cents:'0',discount_cents:'0',settled_by_return:false};
const record=(kind='receivable',date='2026-10-16')=>({id,kind,version:1,group_id:id,installment:1,installments:1,contact_id:other,contact_name:'Contato fictício',category_id:null,category_name:null,description:`Título ${date}`,source_reference:null,issued_on:'2026-10-01',due_on:date,amount_cents:'101',settled_cents:'0',balance_cents:'101',cancelled:false,status:'open',overdue:false,document_linked:false,
 competence_on:'2026-10-01',account_id:null,bank_number:null,interest_month_bp:0,penalty_bp:0,original_due_on:date,deleted_at:null});
// 109 numbered page: 100 per page, Opção, vencimento order and totals of the filtered set.
const page=(kind='receivable',date='2026-10-16',option='open')=>({entity:'titles',data_mode:'erp_native',kind,option,page:1,limit:100,order:'due_asc',total:1,totals:{count:1,amount_cents:'101',balance_cents:'101',fee_cents:'0'},items:[{...record(kind,date),origin:null,account_name:null,remittance:null,imported:false,payments}]});
const component=(view,name)=>view.nodes().find(node=>typeof node.type==='function'&&node.type.name===name);
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
function server(before=()=>{}){
 const calls=[];return{calls,lists:()=>calls.filter(call=>call.path.startsWith('/v1/financeiro/titles?')),controller:{async finance(path,options={}){
  calls.push({path,...options});const injected=await before(path,options);if(injected!==undefined)return injected;
  if(path==='/v1/financeiro')return{read:true,write:true,data_mode:'erp_native'};
  if(path.startsWith('/v1/financeiro/accounts?'))return{entity:'accounts',data_mode:'erp_native',limit:100,has_more:false,next_cursor:null,items:[]};
  if(path.includes('?')){const params=new URL(path,'https://synthetic.invalid').searchParams;return page(params.get('kind')??'receivable',params.get('from')??'2026-10-16',params.get('option')??'issued');}
  return{entity:'titles',data_mode:'erp_native',record:record()};
 }}};
}
const first='/financeiro-empresa?area=receivable&from=2026-10-16&to=2026-10-16';
const mount=(source,location=first,expand=['NativeListLayout','Field','PageControls'])=>mountComponent('RealFinance.tsx',{controller:source.controller},{location,expandChildren:expand});
test('period drilldown reaches the API in Em aberto; applying and clearing keep URL and controls coherent',async()=>{
 const source=server(),view=await mount(source);
 try{
  const firstRead=source.lists()[0];assert.match(firstRead.path,/option=open&from=2026-10-16&to=2026-10-16/);assert.doesNotMatch(firstRead.path,/status=/);
  assert.doesNotMatch(view.text(),/A listagem inclui todas as situações/,'Em aberto already matches the due report');
  assert.deepEqual([component(view,'PeriodPicker').props.from,component(view,'PeriodPicker').props.to],['2026-10-16','2026-10-16']);
  component(view,'PeriodPicker').props.onApply({from:'2026-10-17',to:'2026-10-17',dateType:'Data de Vencimento'});await view.flush();
  assert.match(view.location().search,/from=2026-10-17&to=2026-10-17/);assert.match(view.text(),/Título 2026-10-17/);
  await view.click('Limpar filtros');assert.equal(view.location().search,'?area=receivable');
  const period=defaultTitlePeriod(todaySP());assert.deepEqual([component(view,'PeriodPicker').props.from,component(view,'PeriodPicker').props.to],[period.from,period.to],'Limpar returns to the Origin default period');
  await view.navigate(`${first}&opcao=issued`);assert.match(view.text(),/A listagem inclui todas as situações/,'Emitidas with a vencimento period explain the difference to the report');
  await view.navigate(first);assert.equal(component(view,'PeriodPicker').props.from,'2026-10-16');assert.match(view.text(),/Título 2026-10-16/);
 }finally{view.unmount();}
});
test('unknown or malformed URL filters show no unfiltered list and provide an explicit recovery',async()=>{
 const source=server(),view=await mount(source,'/financeiro-empresa?area=payable&status=outstanding');
 try{assert.equal(source.calls.filter(call=>call.path.includes('?')).length,0);assert.match(view.text(),/Confira os filtros/);assert.equal(component(view,'FinanceTitleDrawer'),undefined);
  await view.click('Limpar filtros da URL');assert.equal(view.location().search,'?area=receivable');assert.equal(source.lists().length,1);
 }finally{view.unmount();}
});
test('a late list cannot restore the old period after accepted URL navigation',async()=>{
 const late=deferred(),source=server(path=>path.startsWith('/v1/financeiro/titles?')&&path.includes('from=2026-10-16')?late.promise:undefined),view=await mount(source);
 try{const old=source.lists()[0];await view.navigate('/financeiro-empresa?area=receivable&from=2026-10-17&to=2026-10-17');assert.equal(old.signal.aborted,true);
  late.resolve(page());await view.flush();assert.match(view.text(),/Título 2026-10-17/);assert.doesNotMatch(view.text(),/Título 2026-10-16/);
 }finally{view.unmount();}
});
test('detail fetch is isolated, bound to record/kind, and cancelled when a new period is accepted',async()=>{
 const late=deferred(),source=server(path=>path.endsWith(id)?late.promise:undefined),view=await mount(source);
 try{await view.click('Título 2026-10-16');assert.match(view.text(),/Carregando registro financeiro/);assert.equal(component(view,'FinanceTitleDrawer'),undefined);
  const call=source.calls.find(item=>item.path.endsWith(id));await view.navigate('/financeiro-empresa?area=payable&from=2026-10-17&to=2026-10-17');assert.equal(call.signal.aborted,true);
  late.resolve({entity:'titles',data_mode:'erp_native',record:record()});await view.flush();assert.equal(component(view,'FinanceTitleDrawer'),undefined);assert.match(view.text(),/Contas a pagar/);
 }finally{view.unmount();}
});
test('failed or mismatched detail retries the detail GET; local editor survives ordinary rerenders',async()=>{
 let attempts=0;const source=server(path=>{if(path.endsWith(id)){attempts++;if(attempts===1)throw new AccessError(503);return{entity:'titles',data_mode:'erp_native',record:record(attempts===2?'payable':'receivable')};}}),view=await mount(source);
 try{await view.click('Título 2026-10-16');assert.equal(component(view,'FinanceTitleDrawer'),undefined);await view.click('Tentar consultar registro novamente');assert.equal(component(view,'FinanceTitleDrawer'),undefined);
  await view.click('Tentar consultar registro novamente');assert.equal(component(view,'FinanceTitleDrawer').props.title.id,id);component(view,'FinanceTitleDrawer').props.onClose();await view.flush();
  await view.click('Incluir conta');assert.ok(component(view,'FinanceTitleDrawer'));await view.updateProps({});assert.ok(component(view,'FinanceTitleDrawer'),'a harmless rerender must retain a local draft');
  await view.navigate('/financeiro-empresa?area=receivable&from=2026-10-17&to=2026-10-17');assert.equal(component(view,'FinanceTitleDrawer'),undefined,'only a committed navigation clears the editor');
 }finally{view.unmount();}
});
