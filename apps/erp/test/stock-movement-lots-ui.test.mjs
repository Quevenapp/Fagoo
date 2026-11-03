import test from 'node:test';
import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {allocation,freeQuantity,lotsBody,offeredLots,parseMovementLots,parseSourceLots,NEW_LOT_CHOICE} from '../src/lib/stock-movement-lots-model.ts';

// 278 (estoque, onda F): "Informar lotes de produtos" of a recorded line and the "Informações de lote lançado" of an item. Synthetic data only.
globalThis.document??={activeElement:null,getElementById:()=>null,addEventListener(){},removeEventListener(){},body:{classList:{add(){},remove(){}},append(){},style:{}}};
const M='81000000-0000-4000-8000-000000000001',P='82000000-0000-4000-8000-000000000001',W='83000000-0000-4000-8000-000000000001',L1='84000000-0000-4000-8000-000000000001',L2='84000000-0000-4000-8000-000000000002',D='85000000-0000-4000-8000-000000000001';
const settings={require_expiry:false,require_manufacture:false,warning_days:0};
const line=(patch={})=>({movement_id:M,product_id:P,warehouse_id:W,warehouse_name:'Geral',kind:'receipt',direction:'receipt',occurred_on:'2026-10-20',reason:'Lançamento manual',
 quantity:'10.000000',assigned:'0.000000',unassigned:'10.000000',lots_version:0,assignable:true,reason_code:null,origin:{type:'none',document_id:null,document_kind:null,document_number:null,via:null},lots:[],...patch});
const view=(patch={},linePatch={})=>({scope:'stock_movement_lots',data_mode:'erp_native',line:line(linePatch),product:{id:P,name:'Remédio sintético',code:'RS-1',unit:'UN',lot_control:true},room:'10.000000',
 candidates:[{id:L1,code:'L-1',manufactured_on:null,expires_on:'2027-01-31',quantity:'4.000000'},{id:L2,code:'L-2',manufactured_on:null,expires_on:null,quantity:'0.000000'}],settings,can_write:true,...patch});

test('278 model: rows of the panel become the exact body; Novo lote only in an Entrada; never more than the room',()=>{
 const v=parseMovementLots(view(),M,P,W);
 const rows=[{...allocation(L1,'4'),key:'a'},{...allocation(NEW_LOT_CHOICE,'2,5'),key:'b',code:' N-1 ',expires_on:'2027-05-01'}];
 assert.deepEqual(lotsBody(v,rows),{product_id:P,warehouse_id:W,expected_lots:0,lots:[{lot_id:L1,quantity:'4'},{code:'N-1',manufactured_on:null,expires_on:'2027-05-01',quantity:'2.5'}]});
 assert.equal(freeQuantity(rows,v.room),'3,5','Dividir os lotes proposes what is still free');
 assert.throws(()=>lotsBody(v,[{...allocation(L1,'4'),key:'a'},{...allocation(L1,'1'),key:'b'}]),/escolhido mais de uma vez/);
 assert.throws(()=>lotsBody(v,[{...allocation(L1,'11'),key:'a'}]),/passa da quantidade sem lote/);
 assert.throws(()=>lotsBody(v,[{...allocation(NEW_LOT_CHOICE,'1'),key:'a',code:'l-1'}]),/já existe/);
 assert.throws(()=>lotsBody(v,[{...allocation('','1'),key:'a'}]),/Selecione o lote/);
 assert.throws(()=>lotsBody(v,[{...allocation(L1,'0'),key:'a'}]),/quantidade positiva/);
 assert.throws(()=>lotsBody(parseMovementLots(view({settings:{...settings,require_expiry:true}}),M,P,W),[{...allocation(NEW_LOT_CHOICE,'1'),key:'a',code:'N-2'}]),/data de validade/);
 const exit=parseMovementLots(view({},{direction:'issue',kind:'issue'}),M,P,W);
 assert.throws(()=>lotsBody(exit,[{...allocation(NEW_LOT_CHOICE,'1'),key:'a',code:'N-3'}]),/só entra por uma Entrada/);
 assert.throws(()=>lotsBody(exit,[{...allocation(L1,'5'),key:'a'}]),/não tem saldo suficiente/);
 const tight=parseMovementLots(view({room:'1.000000'}),M,P,W);
 assert.throws(()=>lotsBody(tight,[{...allocation(L1,'2'),key:'a'}]),/“Sem lote” do depósito/);
 assert.throws(()=>lotsBody(parseMovementLots(view({can_write:false}),M,P,W),[{...allocation(L1,'1'),key:'a'}]),/administrador e estoque/);
 // Answers that do not add up are refused.
 assert.throws(()=>parseMovementLots(view({},{assigned:'1.000000'}),M,P,W));
 assert.throws(()=>parseMovementLots(view({room:'11.000000'}),M,P,W));
 assert.throws(()=>parseMovementLots(view({},{movement_id:D}),M,P,W));
});

function service({lose=false,refuse=null}={}){
 const calls=[];let state=view();let lost=lose;
 const stock=async(path,options={})=>{calls.push({path,...options,body:options.body?structuredClone(options.body):undefined});
  if(path.startsWith(`/v1/estoque/lotes/movimentos/${M}`)&&!options.method)return structuredClone(state);
  if(path===`/v1/estoque/lotes/movimentos/${M}`&&options.method==='POST'){
   if(refuse)throw new AccessError(refuse);
   const lots=options.body.lots.map((l,i)=>({lot_id:l.lot_id??`86000000-0000-4000-8000-00000000000${i}`,code:l.code??'L-1',manufactured_on:null,expires_on:null,quantity:`${l.quantity}${l.quantity.includes('.')?'':'.'}`.padEnd(l.quantity.includes('.')?l.quantity.split('.')[0].length+7:l.quantity.length+7,'0')}));
   const assigned=lots.reduce((s,l)=>s+BigInt(l.quantity.replace('.','')),0n),total=10000000n;
   const fmt=n=>`${n/1000000n}.${(n%1000000n).toString().padStart(6,'0')}`;
   state=view({room:fmt(total-assigned)},{assigned:fmt(assigned),unassigned:fmt(total-assigned),lots_version:lots.length,lots});
   const answer={...structuredClone(state),scope:'stock_movement_lots_assign',entries:lots.map(l=>({warehouse_id:W,quantity:l.quantity,balance_after:l.quantity,lot_id:l.lot_id,code:l.code,created:!l.lot_id.startsWith('84')})),replayed:false};
   if(lost){lost=false;throw new Error('network');}
   return answer;}
  throw new Error(`unexpected ${path}`);};
 return{calls,controller:{stock},posts:()=>calls.filter(c=>c.method==='POST')};
}
const mountPanel=(s,props={})=>mountComponent('StockMovementLots.tsx',{controller:s.controller,movementId:M,productId:P,warehouseId:W,onClose(){},onSaved(){},...props},
 {componentName:'MovementLotsPanel',expandChildren:['StockSidePanel','InformedLots']});
const rowIds=v=>v.nodes().filter(n=>n.type==='select'&&String(n.props.id).endsWith('-lot')).map(n=>String(n.props.id).replace(/-lot$/,''));

test('278 Informar lotes de produtos: rows (Dividir os lotes, Adicionar novo lote, Remover lote), Salvar and Conferir resultado',async()=>{
 const s=service({lose:true}),saved=[];const v=await mountPanel(s,{onSaved:value=>saved.push(value)});
 try{
  assert.match(v.text(),/Informar lotes de produtos/);assert.match(v.text(),/Entrada de 20\/10\/2026 · Lançamento manual/);assert.match(v.text(),/Sem lote: 10 UN/);
  let [first]=rowIds(v);assert.equal(v.input(`${first}-quantity`).props.value,'10','the first row proposes what is free');
  await v.change(`${first}-lot`,L1);await v.change(`${first}-quantity`,'4');
  await v.click('Adicionar novo lote');
  const [,second]=rowIds(v);assert.equal(v.input(`${second}-lot`).props.value,NEW_LOT_CHOICE);assert.equal(v.input(`${second}-quantity`).props.value,'6');
  await v.change(`${second}-code`,'N-9');await v.change(`${second}-quantity`,'2');
  await v.click('Dividir os lotes');assert.equal(rowIds(v).length,3);
  const third=rowIds(v)[2];assert.equal(v.input(`${third}-quantity`).props.value,'4');
  const removes=v.nodes().filter(n=>n.type==='button'&&/Remover lote/.test(JSON.stringify(n.props.children)));
  removes[2].props.onClick();await v.flush();assert.equal(rowIds(v).length,2);
  await v.click('Salvar');
  assert.equal(s.posts().length,1);assert.deepEqual(s.posts()[0].body.lots,[{lot_id:L1,quantity:'4'},{code:'N-9',manufactured_on:null,expires_on:null,quantity:'2'}]);
  assert.match(v.text(),/Use “Conferir resultado”/);assert.equal(v.button('Cancelar').disabled,true,'an unknown result keeps the panel');
  await v.click('Conferir resultado');
  assert.equal(s.posts()[1].body.command_id,s.posts()[0].body.command_id,'the same command');
  assert.equal(saved.length,1);assert.equal(saved[0].line.assigned,'6.000000');
 }finally{v.unmount();}
 // A refusal shows the reason and keeps the rows to correct; a reader sees the lots without editing.
 const r=service({refuse:400});const refused=await mountPanel(r);
 try{const [row]=rowIds(refused);await refused.change(`${row}-lot`,L1);await refused.change(`${row}-quantity`,'1');await refused.click('Salvar');
  assert.match(refused.text(),/Confira os lotes/);assert.equal(rowIds(refused).length,1);}finally{refused.unmount();}
 const reader=service();reader.controller.stock=async()=>view({can_write:false});const read=await mountPanel(reader);
 try{assert.equal(rowIds(read).length,0);assert.match(read.text(),/Somente administrador e estoque informam lotes/);assert.equal(read.nodes().some(n=>n.type==='button'&&n.props.children==='Salvar'),false);}finally{read.unmount();}
 const reversed=service();reversed.controller.stock=async()=>view({room:'0.000000',candidates:[]},{assignable:false,reason_code:'reversed'});const old=await mountPanel(reversed);
 try{assert.match(old.text(),/O lançamento foi estornado/);assert.equal(rowIds(old).length,0);}finally{old.unmount();}
});

test('278 Informações de lote lançado: the lines of the document with their lots; Informar lotes opens the line',async()=>{
 const source=(patch={})=>({scope:'stock_source_lots',data_mode:'erp_native',source:'document',source_id:D,posted:true,reference:null,product:{id:P,name:'Remédio sintético',code:'RS-1',unit:'UN',lot_control:true},
  lines:[line({kind:'issue',direction:'issue',quantity:'3.000000',unassigned:'1.000000',assigned:'2.000000',lots_version:1,lots:[{lot_id:L1,code:'L-1',manufactured_on:null,expires_on:'2027-01-31',quantity:'2.000000'}],
   origin:{type:'sales',document_id:D,document_kind:'sales_orders',document_number:'31',via:'document_stock'}})],settings,can_write:true,...patch});
 assert.equal(parseSourceLots(source(),'document',D,P).lines[0].lots[0].code,'L-1');
 assert.throws(()=>parseSourceLots(source({posted:false}),'document',D,P));
 const calls=[];let answer=source();
 const controller={async stock(path){calls.push(path);if(path.startsWith('/v1/estoque/lotes/origem'))return structuredClone(answer);return view({},{kind:'issue',direction:'issue'});}};
 const v=await mountComponent('StockMovementLots.tsx',{controller,source:'document',sourceId:D,productId:P,description:'Remédio sintético',onClose(){}},
  {componentName:'SourceLotsPanel',expandChildren:['StockSidePanel','InformedLots','MovementLotsPanel']});
 try{
  assert.equal(calls[0],`/v1/estoque/lotes/origem?documento=${D}&product_id=${P}`);
  assert.match(v.text(),/Saída de 20\/10\/2026 · Geral · 3 UN/);assert.match(v.text(),/L-1/);assert.match(v.text(),/Sem lote: 1 UN/);
  await v.click('Informar lotes');
  assert.ok(calls.some(path=>path.startsWith(`/v1/estoque/lotes/movimentos/${M}?`)),'the line opens in Informar lotes de produtos');
  assert.match(v.text(),/Informar lotes de produtos/);
 }finally{v.unmount();}
 answer=source({posted:false,lines:[]});
 const none=await mountComponent('StockMovementLots.tsx',{controller,source:'invoice',sourceId:D,productId:P,description:'Item',onClose(){}},{componentName:'SourceLotsPanel',expandChildren:['StockSidePanel']});
 try{assert.match(none.text(),/Não foi possível consultar os lotes/,'an answer of another source fails closed');}finally{none.unmount();}
 answer={...source({posted:false,lines:[]}),source:'invoice'};
 const empty=await mountComponent('StockMovementLots.tsx',{controller,source:'invoice',sourceId:D,productId:P,description:'Item',onClose(){}},{componentName:'SourceLotsPanel',expandChildren:['StockSidePanel']});
 try{assert.match(empty.text(),/O estoque desta nota ainda não foi lançado/);}finally{empty.unmount();}
});

test('278 a lot already informed in the line is not offered again (one lot line per lot)',async()=>{
 const informed={lots:[{lot_id:L1,code:'L-1',manufactured_on:null,expires_on:'2027-01-31',quantity:'2.000000'}],lots_version:1,assigned:'2.000000',unassigned:'8.000000'};
 const v=parseMovementLots(view({room:'8.000000'},informed),M,P,W);
 assert.deepEqual(offeredLots(v).map(lot=>lot.code),['L-2']);
 assert.throws(()=>lotsBody(v,[{...allocation(L1,'1'),key:'a'}]),/O lote L-1 já foi informado neste lançamento/);
 assert.deepEqual(lotsBody(v,[{...allocation(L2,'1'),key:'a'}]).lots,[{lot_id:L2,quantity:'1'}]);
 const calls=[];const controller={async stock(path,options={}){calls.push({path,...options});return view({room:'8.000000'},informed);}};
 const panel=await mountComponent('StockMovementLots.tsx',{controller,movementId:M,productId:P,warehouseId:W,onClose(){},onSaved(){}},{componentName:'MovementLotsPanel',expandChildren:['StockSidePanel']});
 try{
  const select=panel.find(n=>n.type==='select'&&String(n.props.id).endsWith('-lot'));
  const values=panel.nodes().filter(n=>n.type==='option').map(n=>n.props.value);
  assert.ok(select);assert.equal(values.includes(L1),false,'L-1 is already in the line');assert.equal(values.includes(L2),true);
 }finally{panel.unmount();}
});
