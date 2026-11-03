import test from 'node:test';
import assert from 'node:assert/strict';
import {AccessError,mountComponent} from './helpers/component-recovery-harness.mjs';

// Estoque lane, wave D (225): Pedidos de compra > ⋮ "Estornar estoque" — "Estorno de estoque - Confirmar estorno de estoque?" Sim | Não,
// one command for every active receipt, "Conferir resultado" with the same command. Synthetic data only.
globalThis.document??={activeElement:null,getElementById:()=>null,addEventListener(){},removeEventListener(){},body:{classList:{add(){},remove(){}},append(){},style:{}}};
const D='d9000000-0000-4000-8000-000000000025';

test('225 Estornar estoque: Origin confirmation, one command, Conferir resultado repeats it, refusals release it',async()=>{
 const calls=[];let answer='lost';
 const controller={async stock(path,request={}){calls.push({path,method:request.method,body:structuredClone(request.body)});
  if(answer==='lost'){answer='ok';throw new AccessError(503);}
  if(answer==='conflict')throw new AccessError(409);
  return{document_id:D,document_number:'57',document_version:7,occurred_on:'2026-10-20',reason:'Estorno do pedido de compra 57',reversed:[{receipt_id:'e9000000-0000-4000-8000-000000000001',movement_id:'f9000000-0000-4000-8000-000000000001',positions:1}],replayed:false,scope:'stock_purchase_reverse_all',data_mode:'erp_native'};}};
 const closed=[];
 const view=await mountComponent('PurchaseStockLaunch.tsx',{controller,documentId:D,number:'57',version:6,onClose:changed=>closed.push(changed)},{componentName:'PurchaseStockReverse',expandChildren:['Modal']});
 try{
  assert.match(view.text(),/Estorno de estoque/);assert.match(view.text(),/Confirmar estorno de estoque\?/);
  await view.click('Sim');
  assert.match(view.text(),/Conferir resultado/);assert.equal(view.button('Não').disabled,true,'an unknown outcome cannot be abandoned');
  await view.click('Conferir resultado');
  assert.equal(calls.length,2);assert.deepEqual(calls[1].body,calls[0].body);assert.deepEqual(Object.keys(calls[0].body).sort(),['command_id','expected_version']);
  assert.equal(calls[0].path,`/v1/estoque/compras/${D}/estorno`);assert.equal(calls[0].body.expected_version,6);
  assert.match(view.text(),/Estoque estornado no pedido de compra nº 57: 1 recebimento\(s\)\./);
  await view.click('Fechar');assert.deepEqual(closed,[true]);
 }finally{view.unmount();}
 answer='conflict';calls.length=0;
 const refused=await mountComponent('PurchaseStockLaunch.tsx',{controller,documentId:D,number:'57',version:6,onClose(){}},{componentName:'PurchaseStockReverse',expandChildren:['Modal']});
 try{
  await refused.click('Sim');assert.match(refused.text(),/O pedido ou os saldos mudaram/);
  answer='ok';await refused.click('Sim');assert.notEqual(calls[1].body.command_id,calls[0].body.command_id,'a known refusal releases the command');
 }finally{refused.unmount();}
});

test('224 receipt reversal conferência: a position that keeps its balance says so instead of the arithmetic Físico depois',async()=>{
 const {createPurchaseReceiptsFixture}=await import('../src/qa/purchase-receipts-fixture.ts');
 const s=createPurchaseReceiptsFixture({after(call,value){if(call.path.endsWith('/reverse-preview'))value.preview.positions[0].balance_kept=true;return value;}});
 const v=await mountComponent('PurchaseReceipts.tsx',{controller:s.controller,record:s.record,onChanged:async version=>{await v.updateProps({record:{...s.record,version}});},onBusy(){},onDraft(){}},{expandChildren:true});
 const prepare=async reverse=>{await v.click(reverse?'Estornar recebimento':'Receber produtos');for(const [end,value]of[...(reverse?[['-day','2026-10-17']]:[]),['-reason','Conferência sintética']])await v.change(v.find(n=>n.type==='input'&&n.props.id?.endsWith(end)).props.id,value);
  if(!reverse)await v.change(v.find(n=>n.type==='input'&&n.props.inputMode==='decimal').props.id,'1');await v.click(reverse?'Conferir estorno':'Conferir quantidades');};
 const confirm=async label=>{v.find(n=>n.type==='input'&&n.props.type==='checkbox').props.onChange({target:{checked:true}});await v.flush();await v.click(label);await v.flush();};
 try{
  await prepare(false);assert.doesNotMatch(v.text(),/Saldo mantido/);await confirm('Confirmar recebimento');
  await v.click('Ver recebimento 17/10/2026');await prepare(true);
  assert.match(v.text(),/Saldo mantido: há balanço depois do recebimento/);
 }finally{v.unmount();}
});
