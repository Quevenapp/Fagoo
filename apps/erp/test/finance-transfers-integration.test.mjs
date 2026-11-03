import test from 'node:test';
import assert from 'node:assert/strict';
import {mountComponent} from './helpers/component-recovery-harness.mjs';

const actor='10000000-0000-4000-8000-000000000001',id='20000000-0000-4000-8000-000000000001';
const flags={scope:'finance_internal_transfer',data_mode:'erp_native',bank_operation_performed:false,title_mutation_performed:false,opening_mutation_performed:false};
const component=(view,name)=>view.nodes().find(n=>typeof n.type==='function'&&n.type.name===name);
function source(role='admin'){
 const calls=[],state={role};return{calls,state,controller:{getSnapshot:()=>({phase:'ready',membership:{user_id:actor,role:state.role}}),
  async finance(path,options={}){calls.push({path,...options});if(path==='/v1/financeiro')return{data_mode:'erp_native',read:true,write:role!=='consulta'};
   const u=new URL(path,'https://synthetic.invalid'),entity=u.pathname.split('/')[3];return{entity,data_mode:'erp_native',items:entity==='accounts'?[{id,name:'Conta sintética',kind:'bank',version:1,balance_cents:'0',active:true,opening_recorded:false}]:[],limit:25,has_more:false,next_cursor:null};},
  async financeTransfers(path,options={}){calls.push({path,...options});return{...flags,read_only:true,items:[],limit:25,has_more:false,next_cursor:null};}
 }};
}
const mount=(s,location='/financeiro-empresa?area=accounts&q=Conta',extra={})=>mountComponent('RealFinance.tsx',{controller:s.controller},{location,expandChildren:['NativeListLayout','Field','PageControls','FinanceTransfers'],...extra});

test('053 accounts menu opens transfers, preserves filters and reloads balances on return',async()=>{
 const s=source(),view=await mount(s);try{
  const staleInclude=view.button('Incluir conta financeira'),staleOpen=view.button('Conta sintética');
  await view.click('Transferência entre contas');assert.match(view.text(),/não envia dinheiro ao banco/);assert.ok(view.button('Registrar transferência'));
  staleInclude.props.onClick();staleOpen.props.onClick();await view.flush();assert.equal(component(view,'FinanceEditor'),undefined);assert.equal(s.calls.some(c=>c.path.endsWith('/'+id)),false);
  const before=s.calls.filter(c=>c.path.startsWith('/v1/financeiro/accounts?')).length;
  await view.click('Voltar ao financeiro');assert.equal(view.location().search,'?area=accounts&q=Conta');assert.equal(view.input('finance-search').props.value,'Conta');assert.ok(view.button('Transferência entre contas'));
  assert.equal(s.calls.filter(c=>c.path.startsWith('/v1/financeiro/accounts?')).length,before+1);assert.equal(s.calls.some(c=>c.method==='POST'),false);
 }finally{view.unmount();}
});
test('053 menu is only in accounts; read-only access opens history without a creation action',async()=>{
 for(const role of ['admin','financeiro','consulta']){
  const s=source(role),view=await mount(s);try{await view.click('Transferência entre contas');assert.equal(view.nodes().some(n=>n.type==='button'&&n.props.children==='Registrar transferência'),role!=='consulta');await view.click('Voltar ao financeiro');await view.click('Contas a receber');assert.throws(()=>view.button('Transferência entre contas'));assert.equal(s.calls.some(c=>c.method==='POST'),false);}finally{view.unmount();}
 }
});
test('053 old list handler cannot replace an open account editor; transfer form owns the leave guard',async()=>{
 const s=source(),leaves=[],view=await mount(s,undefined,{ports:{useUnsavedChanges(changed,busy){return{confirmLeave:action=>leaves.push({changed,busy,action})};}}});
 try{
  const staleTransfer=view.button('Transferência entre contas');await view.click('Incluir conta financeira');staleTransfer.props.onClick();await view.flush();assert.ok(component(view,'FinanceEditor'));
  component(view,'FinanceEditor').props.onClose();await view.flush();await view.click('Transferência entre contas');await view.click('Registrar transferência');
  await view.change('transfer-amount','1,00');await view.click('Voltar ao financeiro');assert.equal(leaves.length,1);assert.equal(leaves[0].changed,true);assert.equal(leaves[0].busy,false);assert.equal(view.input('transfer-amount').props.value,'1,00');
  leaves[0].action();await view.flush();assert.ok(view.button('Transferência entre contas'));assert.equal(s.calls.some(c=>c.method==='POST'),false);
 }finally{view.unmount();}
});
test('053 committed module navigation clears the transfer panel without reviving it on back',async()=>{
 const s=source(),view=await mount(s);try{await view.click('Transferência entre contas');await view.navigate('/financeiro-empresa?area=payable');assert.match(view.text(),/Contas a pagar/);assert.throws(()=>view.button('Voltar ao financeiro'));await view.navigate('/financeiro-empresa?area=accounts&q=Conta');assert.ok(view.button('Transferência entre contas'));assert.throws(()=>view.button('Voltar ao financeiro'));}finally{view.unmount();}
});
