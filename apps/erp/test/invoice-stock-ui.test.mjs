import test from 'node:test';
import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {invoiceFlagsPath,invoiceStockLetter,parseInvoiceFlags} from '../src/lib/invoice-stock-model.ts';
import {SCREENS,rowActions} from '../src/lib/fiscal-invoice-list-model.ts';

// Estoque lane, wave E (259): the letter E and ⋮ Lançar estoque / Estornar estoque of the Brufap notes, and the Finalizar of the
// check-in with "Lançar estoque ao finalizar Check-in". Synthetic data only.
globalThis.document??={activeElement:null,getElementById:()=>null,addEventListener(){},removeEventListener(){},body:{classList:{add(){},remove(){}},append(){},style:{}}};
const N='e1000000-0000-4000-8000-000000000001',W='e2000000-0000-4000-8000-000000000001',W2='e2000000-0000-4000-8000-000000000002',P='e3000000-0000-4000-8000-000000000001',PO='e4000000-0000-4000-8000-000000000001',M='e5000000-0000-4000-8000-000000000001';
const none={flag:null,warehouse:null,posting_id:null,posting_version:null,source:null,reference:null};
const posted={flag:'S',warehouse:{id:W,name:'Geral'},posting_id:PO,posting_version:1,source:'invoice',reference:null};
const invoice={id:N,model:'55',direction:'1',screen:'nfe_saida',number:123,series:1,status:1,version:3,label:'NF-e 000123',issue_date:'2026-10-20',exit_date:null,deleted:false};
const stateOf=(flag=none,block=null,can_manage=true,checkin_post=false)=>({scope:'stock_invoice',data_mode:'erp_native',invoice,flag,block,can_manage,occurred_on:'2026-10-20',date_mode:'data_atual',default_warehouse:{id:W,name:'Geral'},checkin_post,postings:[]});
const previewOf=(action='post')=>({action,...(action==='post'?{source:'invoice'}:{posting:{id:PO,version:1}}),invoice,direction:action==='post'?'issue':'reversal',occurred_on:'2026-10-20',
 reason:action==='post'?'Lançamento de estoque da NF-e 000123':'Estorno do estoque da NF-e 000123',warehouse:{id:W,name:'Geral',version:1,active:true},
 positions:[{product_id:P,product_name:'Peça nota',catalog_version:1,warehouse_id:W,unit:'UN',quantity:action==='post'?'-2.000000':'2.000000',balance_before:'5.000000',balance_after:action==='post'?'3.000000':'7.000000',expected_version:4,
  sources:action==='post'?[{position:1,quantity:'2.000000'}]:[]}],ignored:action==='post'?[{position:2,product_id:null,description:'Frete',quantity:'1.000000',unit:'UN',reason:'unlinked_item'}]:[],preview_hash:'a'.repeat(64)});
const resultOf=(scope,flag)=>({scope,data_mode:'erp_native',command_id:'x',invoice,posting:{id:PO,state:scope==='stock_invoice_reverse'?'reversed':'active',source:scope==='stock_checkin_post'?'checkin':'invoice'},
 movement:{id:M,kind:'issue',items:[]},flag,replayed:false,...(scope==='stock_invoice_reverse'?{balance_adjustments:[]}:{}),...(scope==='stock_checkin_post'?{checkin:{note:{},checkin:{state:'finished'}}}:{})});
function service({state=stateOf(),fail=()=>null}={}){
 const calls=[];let writes=0;
 const stock=async(path,options={})=>{calls.push({path,method:options.method,body:options.body?structuredClone(options.body):undefined});
  if(path==='/v1/estoque/depositos/opcoes')return{scope:'stock_warehouse_options',data_mode:'erp_native',total:2,items:[{id:W,name:'Geral',active:true,is_default:true,ignore_balance:false},{id:W2,name:'Loja',active:true,is_default:false,ignore_balance:false}]};
  if(path===`/v1/estoque/notas-fiscais/${N}`)return state;
  if(path.endsWith('/estorno/previa'))return{scope:'stock_invoice_reverse_preview',data_mode:'erp_native',preview:previewOf('reverse')};
  if(path.endsWith('/checkin/previa'))return{scope:'stock_checkin_post_preview',data_mode:'erp_native',checkin_version:options.body.expected_version,preview:{...previewOf(),source:'checkin',direction:'receipt',positions:[{...previewOf().positions[0],quantity:'4.000000',balance_after:'9.000000'}],ignored:[]}};
  if(path.endsWith('/previa'))return{scope:'stock_invoice_preview',data_mode:'erp_native',preview:previewOf()};
  writes++;const problem=fail(writes);if(problem)throw problem;
  if(path.endsWith('/lancamento'))return resultOf('stock_invoice_post',posted);
  if(path.endsWith('/checkin'))return resultOf('stock_checkin_post',{...posted,source:'checkin'});
  if(path.endsWith('/estorno'))return resultOf('stock_invoice_reverse',none);
  throw new Error(path);};
 return{calls,writes:()=>calls.filter(c=>c.method==='POST'&&!c.path.includes('previa')),controller:{stock}};
}

test('259 model: letter E (S blue, R dark blue), the flags of a page and the ⋮ stock actions of a FAGOO note',()=>{
 const flags=parseInvoiceFlags({scope:'stock_invoice_flags',data_mode:'erp_native',items:[{invoice_id:N,...posted}]},[N]);
 assert.deepEqual(invoiceStockLetter(flags.get(N)),{text:'E',color:'blue',title:'Estoque lançado - Depósito: Geral'});
 assert.deepEqual(invoiceStockLetter({...none,flag:'R',warehouse:{id:W,name:'Loja'},reference:{document_id:PO,kind:'sales_orders',number:'7',via:'document_stock'}}),
  {text:'E',color:'darkblue',title:'Estoque lançado pela referência - Depósito: Loja'});
 assert.equal(invoiceStockLetter(none),null);
 assert.throws(()=>parseInvoiceFlags({scope:'stock_invoice_flags',data_mode:'erp_native',items:[{invoice_id:W,...posted}]},[N]),'another note');
 assert.equal(invoiceFlagsPath([N,W]),`/v1/estoque/notas-fiscais/situacao?ids=${N}%2C${W}`);
 const row={id:N,origin:'brufap',status:1,number:123,orders:[],access_key:null,issue_type:'N'};
 const action=(stock,id='stock')=>rowActions(SCREENS.nfe,row,{writable:true,stock}).find(a=>a.id===id);
 assert.equal(action({flag:null,reference:null,manage:true}).enabled,true);
 assert.match(action({flag:null,reference:null,manage:false}).reason,/administrador e estoque/);
 assert.match(action({flag:'R',reference:'7',manage:true}).reason,/pela referência \(pedido 7\)/);
 assert.equal(action({flag:'S',reference:null,manage:true}),undefined,'S shows only Estornar estoque');
 assert.equal(action({flag:'S',reference:null,manage:true},'stock_reverse').enabled,true);
 assert.equal(rowActions(SCREENS.nfe,row,{writable:true,stock:{flag:'R',reference:'7',manage:true}}).some(a=>a.id==='stock_reverse'),false,'Origin hides the reversal of R');
 assert.match(action(null).reason,/Não foi possível consultar o estoque da nota/);
 assert.match(rowActions(SCREENS.nfe,{...row,status:3},{writable:true,stock:{flag:null,reference:null,manage:true}}).find(a=>a.id==='stock').reason,/cancelada ou denegada/);
});

test('259 Lançar estoque of a note: Depósito, Conferir lançamento, the confirmation and Conferir resultado with the same command',async()=>{
 const s=service({fail:writes=>writes===1?new AccessError(503):null}),done=[];
 const view=await mountComponent('InvoiceStock.tsx',{controller:s.controller,invoiceId:N,mode:'post',onClose(){},onDone:(m,r)=>done.push([m,r])},{expandChildren:['StockSidePanel']});
 try{
  assert.match(view.text(),/NotaNF-e 000123Saída do estoque/);assert.equal(view.input('invoice-stock-warehouse').props.value,W,'the depósito padrão');
  assert.match(view.text(),/Data do lançamento: 20\/10\/2026 \(data atual/);
  await view.change('invoice-stock-warehouse',W2);await view.click('Conferir lançamento');
  assert.deepEqual(s.calls.find(c=>c.path.endsWith('/previa')).body,{expected_version:3,warehouse_id:W2});
  assert.match(view.text(),/Peça nota−2 UN53/);assert.match(view.text(),/Ficam de fora: item 2 \(Frete: Item sem produto do cadastro\)/);
  await view.click('Lançar estoque');assert.match(view.text(),/Não foi possível confirmar o resultado/);
  assert.equal(view.input('invoice-stock-warehouse').disabled,true,'frozen while the result is unknown');
  await view.click('Conferir resultado');
  const [first,second]=s.writes();assert.deepEqual(first.body,second.body);assert.equal(first.path,`/v1/estoque/notas-fiscais/${N}/lancamento`);
  assert.deepEqual({...first.body,command_id:undefined},{command_id:undefined,expected_version:3,warehouse_id:W2,preview_hash:'a'.repeat(64)});
  assert.match(done[0][0],/Estoque lançado no depósito Geral/);
 }finally{view.unmount();}
 const blocked=await mountComponent('InvoiceStock.tsx',{controller:service({state:stateOf(none,'reference')}).controller,invoiceId:N,mode:'post',onClose(){},onDone(){}},{expandChildren:['StockSidePanel']});
 try{assert.match(blocked.text(),/lançado pela referência/);assert.throws(()=>blocked.button('Conferir lançamento'),/Missing component control/,'no review for an R note');}finally{blocked.unmount();}
 const reader=await mountComponent('InvoiceStock.tsx',{controller:service({state:stateOf(none,null,false)}).controller,invoiceId:N,mode:'post',onClose(){},onDone(){}},{expandChildren:['StockSidePanel']});
 try{assert.match(reader.text(),/o lançamento é de administrador e estoque/);}finally{reader.unmount();}
});

test('259 Estornar estoque of a note: the reversal prévia loads with the posting and the confirmation sends it',async()=>{
 const s=service({state:stateOf(posted,'posted')}),done=[];
 const view=await mountComponent('InvoiceStock.tsx',{controller:s.controller,invoiceId:N,mode:'reverse',onClose(){},onDone:m=>done.push(m)},{expandChildren:['StockSidePanel']});
 try{
  assert.deepEqual(s.calls.find(c=>c.path.endsWith('/estorno/previa')).body,{posting_id:PO,posting_version:1});
  assert.match(view.text(),/Peça nota2 UN57/);
  await view.click('Estornar estoque');
  const {command_id,...body}=s.writes()[0].body;assert.deepEqual(body,{posting_id:PO,posting_version:1,preview_hash:'a'.repeat(64)});
  assert.equal(done[0],'Estoque estornado.');
 }finally{view.unmount();}
});

test('259 Finalizar do check-in with "Lançar estoque ao finalizar Check-in": Depósito, prévia and one command',async()=>{
 const s=service({state:{...stateOf(),invoice:{...invoice,direction:'0',screen:'nfe_entrada'}}}),posted=[];let plain=0;
 const view=await mountComponent('InvoiceStock.tsx',{controller:s.controller,invoiceId:N,version:5,summary:{complete:2,issue:0,refused:1,pending:0},plainBusy:false,plainUncertain:false,
  onFinish:()=>plain++,onClose(){},onPosted:m=>posted.push(m)},{componentName:'CheckinFinishModal',expandChildren:['Modal']});
 try{
  assert.match(view.text(),/Itens conferidos: 2 · com pendência: 0 · recusados: 1/);
  await view.click('Sim');assert.equal(plain,1,'without the option the plain Finalizar runs');
  view.find(n=>n.type==='input'&&n.props.type==='checkbox').props.onChange({target:{checked:true}});await view.flush();
  assert.equal(view.input('checkin-stock-warehouse').props.value,W);
  await view.click('Conferir lançamento');
  assert.deepEqual(s.calls.find(c=>c.path.endsWith('/checkin/previa')).body,{expected_version:5,warehouse_id:W});
  assert.match(view.text(),/Peça nota4 UN9/);
  await view.click('Finalizar e lançar estoque');
  const {command_id,...body}=s.writes()[0].body;assert.deepEqual(body,{expected_version:5,warehouse_id:W,preview_hash:'a'.repeat(64)});
  assert.match(posted[0],/finalizado e registrado no sistema\. Estoque lançado no depósito Geral/);
 }finally{view.unmount();}
});

test('259 review: the depósito padrão is not an unsaved change; a reserved pedido blocks the note with the reason',async()=>{
 const view=await mountComponent('InvoiceStock.tsx',{controller:service().controller,invoiceId:N,mode:'post',onClose(){},onDone(){}},{expandChildren:['StockSidePanel']});
 try{
  assert.equal(view.input('invoice-stock-warehouse').props.value,W);assert.equal(view.guard().changed,false,'filled in on load');
  await view.change('invoice-stock-warehouse',W2);assert.equal(view.guard().changed,true,'another depósito is a change');
 }finally{view.unmount();}
 const reserved=await mountComponent('InvoiceStock.tsx',{controller:service({state:stateOf(none,'reserved')}).controller,invoiceId:N,mode:'post',onClose(){},onDone(){}},{expandChildren:['StockSidePanel']});
 try{assert.match(reserved.text(),/O pedido ligado à nota tem estoque reservado/);assert.throws(()=>reserved.button('Conferir lançamento'),/Missing component control/);}finally{reserved.unmount();}
});

test('259 review: "Lançar estoque ao finalizar Check-in na NF de Entrada" checks the option of Finalizar, unless the note cannot post',async()=>{
 const entry={...invoice,direction:'0',screen:'nfe_entrada'},props={invoiceId:N,version:5,summary:{complete:1,issue:0,refused:0,pending:0},plainBusy:false,plainUncertain:false,onFinish(){},onClose(){},onPosted(){}};
 const on=await mountComponent('InvoiceStock.tsx',{...props,controller:service({state:{...stateOf(none,null,true,true),invoice:entry}}).controller},{componentName:'CheckinFinishModal',expandChildren:['Modal']});
 try{
  assert.equal(on.find(n=>n.type==='input'&&n.props.type==='checkbox').props.checked,true);assert.equal(on.input('checkin-stock-warehouse').props.value,W);
  assert.ok(on.button('Conferir lançamento'));assert.throws(()=>on.button('Sim'),/Missing component control/,'Finalizar posts the stock');
  on.find(n=>n.type==='input'&&n.props.type==='checkbox').props.onChange({target:{checked:false}});await on.flush();
  assert.ok(on.button('Sim'),'the option can be unchecked');
 }finally{on.unmount();}
 const done=await mountComponent('InvoiceStock.tsx',{...props,controller:service({state:{...stateOf(posted,'posted',true,true),invoice:entry}}).controller},{componentName:'CheckinFinishModal',expandChildren:['Modal']});
 try{assert.equal(done.find(n=>n.type==='input'&&n.props.type==='checkbox').props.checked,false,'a note already posted');assert.ok(done.button('Sim'));}finally{done.unmount();}
 const off=await mountComponent('InvoiceStock.tsx',{...props,controller:service({state:{...stateOf(),invoice:entry}}).controller},{componentName:'CheckinFinishModal',expandChildren:['Modal']});
 try{assert.equal(off.find(n=>n.type==='input'&&n.props.type==='checkbox').props.checked,false);}finally{off.unmount();}
});
