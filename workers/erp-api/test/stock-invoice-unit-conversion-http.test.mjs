import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {stockLaneGFixture,fails} from './helpers/stock-lane-g-fixture.mjs';
import {stockRoute,stockMethods,stockOperation,stockResponse} from '../src/stock.mjs';

// 295 through the Worker with the real SQL on PGlite (synthetic data only): "Conversão de unidades" of an entry note, the "Fator de
// conversão" command and the converted prévia, with strict bodies and projected responses that fail closed (502).
let f;
before(async()=>{f=await stockLaneGFixture();});
after(()=>f?.close());
const request=(path,method='GET',body)=>new Request(`https://api.example.test${path}`,{method,...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
const stock=async(path,{method='GET',body,user=f.users.estoque}={})=>{const url=new URL(`https://api.example.test${path}`),route=stockRoute(url.pathname);
 const operation=await stockOperation(request(path,method,body),route,url.searchParams);return{raw:await f.rpc(operation.rpc,{p_user_id:user,...operation.args}),route,operation};};
const run=async(path,options)=>{const{raw,route,operation}=await stock(path,options);return stockResponse(raw,route,operation);};
const tamper=(result,change)=>{const forged=structuredClone(result.raw);change(forged);assert.throws(()=>stockResponse(forged,result.route,result.operation),error=>error.status===502);};

test('295 routes: GET and POST of unidades, strict bodies refused before the database',async()=>{
 const id=randomUUID();
 assert.deepEqual(stockMethods(stockRoute(`/v1/estoque/notas-fiscais/${id}/unidades`)),['GET','POST']);
 assert.equal(stockRoute(`/v1/estoque/notas-fiscais/${id}/unidade`),null);
 const refuse=async(path,method='GET',body)=>{const url=new URL(`https://api.example.test${path}`);await assert.rejects(stockOperation(request(path,method,body),stockRoute(url.pathname),url.searchParams),error=>error.status===400,JSON.stringify(body));};
 const path=`/v1/estoque/notas-fiscais/${id}/unidades`,ok={command_id:randomUUID(),position:1,expected_version:0,factor:'12'};
 await refuse(`${path}?x=1`);
 for(const body of[{...ok,factor:'0'},{...ok,factor:'0.000'},{...ok,factor:'-1'},{...ok,factor:'1.1234567'},{...ok,factor:'1000000'},{...ok,factor:12},{...ok,factor:'1,5'},
  {...ok,factor:null},{...ok,position:0},{...ok,position:991},{...ok,expected_version:-1},{...ok,command_id:'x'},{...ok,extra:true},{command_id:ok.command_id,position:1,expected_version:0}])
  await refuse(path,'POST',body);
 const accepted=await stockOperation(request(path,'POST',{...ok,factor:null,expected_version:2}),stockRoute(path),new URLSearchParams());
 assert.deepEqual([accepted.rpc,accepted.args.p_factor,accepted.args.p_expected_version],['erp_stock_invoice_unit_save',null,2]);
});

test('295 Conversão de unidades through the Worker: read, Fator de conversão, converted prévia and lançamento, cross-checked',async()=>{
 const target=await f.warehouse('HTTP depósito conversão'),item=await f.product('HTTP produto caixa'),taxed=await f.product('HTTP produto tributável');
 const entry=await f.note('0',[f.noteLine(item,'2','120',{unit:'CX'}),f.noteLine(taxed,'3','36',{unit:'PCT',others:{tax_unit:'UN',tax_quantity:'36'}})]);
 const base=`/v1/estoque/notas-fiscais/${entry.id}`;
 const read=await stock(`${base}/unidades`,{user:f.users.fiscal});
 const view=stockResponse(read.raw,read.route,read.operation);
 assert.deepEqual({manage:view.can_manage,supplier:view.supplier.id,items:view.items.map(i=>[i.position,i.unit,i.product.unit,i.rule,i.converted_quantity,i.factor])},
  {manage:false,supplier:f.contact.id,items:[[1,'CX','UN',null,null,null],[2,'PCT','UN','tax_unit','36.000000',null]]});
 tamper(read,v=>{v.items[0].rule='supplier';});tamper(read,v=>{v.items[1].converted_quantity=null;});tamper(read,v=>{v.items[0].unit='un';});
 tamper(read,v=>{v.total=3;});tamper(read,v=>{v.items[1].position=1;});tamper(read,v=>{v.items[1].tax.unit='CX';});tamper(read,v=>{v.extra=1;});
 // Sem regra: the prévia refuses item 1 (400 through the error map).
 const version=await f.noteVersion(entry.id);
 await assert.rejects(run(`${base}/previa`,{method:'POST',body:{expected_version:version,warehouse_id:target.id}}),fails('22023'));
 const body={command_id:randomUUID(),position:1,expected_version:0,factor:'12.5'};
 const saved=await stock(`${base}/unidades`,{method:'POST',body});
 const out=stockResponse(saved.raw,saved.route,saved.operation);
 assert.deepEqual([out.unit,out.product_unit,out.before,out.after,out.replayed,out.units.items[0].rule,out.units.items[0].converted_quantity],['CX','UN',null,{factor:'12.500000',version:1},false,'supplier','25.000000']);
 tamper(saved,v=>{v.after.factor='12.000000';});tamper(saved,v=>{v.after.version=2;});tamper(saved,v=>{v.command_id=randomUUID();});tamper(saved,v=>{v.units.items[0].converted_quantity='24.000000';});
 tamper(saved,v=>{v.supplier_id=randomUUID();});
 assert.equal((await run(`${base}/unidades`,{method:'POST',body})).replayed,true);
 await assert.rejects(run(`${base}/unidades`,{method:'POST',body,user:f.users.fiscal}),fails('42501'));
 const previewed=await stock(`${base}/previa`,{method:'POST',body:{expected_version:version,warehouse_id:target.id}});
 const p=stockResponse(previewed.raw,previewed.route,previewed.operation).preview;
 const sources=Object.fromEntries(p.positions.map(x=>[x.product_id,x.sources]));
 assert.deepEqual(sources[item.id],[{position:1,quantity:'25.000000',invoice_quantity:'2.000000',invoice_unit:'CX',conversion:'supplier',factor:'12.500000'}]);
 assert.deepEqual(sources[taxed.id],[{position:2,quantity:'36.000000',invoice_quantity:'3.000000',invoice_unit:'PCT',conversion:'tax_unit'}]);
 const at=previewed.raw.preview.positions.findIndex(x=>x.product_id===item.id);
 tamper(previewed,v=>{v.preview.positions[at].sources[0].factor='12.000000';});
 tamper(previewed,v=>{v.preview.positions[at].sources[0].conversion='other';});
 tamper(previewed,v=>{delete v.preview.positions[at].sources[0].invoice_unit;});
 tamper(previewed,v=>{v.preview.positions[at].sources[0].kit_product_id=randomUUID();});
 const posted=await run(`${base}/lancamento`,{method:'POST',body:{command_id:randomUUID(),expected_version:version,warehouse_id:target.id,preview_hash:p.preview_hash}});
 assert.equal(posted.flag.flag,'S');
 assert.deepEqual([await f.balance(item.id,target.id),await f.balance(taxed.id,target.id)],['25.000000','36.000000']);
 // The extrato shows the price of the note per unit of the product (120 per CX ÷ 12.5; 36 per PCT × 3 ÷ 36).
 const ledger=await run(`/v1/estoque/movimentos?product_id=${item.id}&limit=100&offset=0&origin=invoices`,{user:f.users.admin});
 assert.deepEqual(ledger.items.map(r=>r.unit_price),['9.6000000000']);
 const other=await run(`/v1/estoque/movimentos?product_id=${taxed.id}&limit=100&offset=0&origin=invoices`,{user:f.users.admin});
 assert.deepEqual(other.items.map(r=>r.unit_price),['3.0000000000']);
});

test('295 review: Conversão de unidades accepts every product code the cadastro stores (up to 100 characters)',async()=>{
 const item=await f.product('HTTP produto código longo');
 const code='SKU-'+'9'.repeat(96);
 await f.db.query('update erp_catalog.record set code=$2,version=version+1 where id=$1',[item.id,code]);
 const entry=await f.note('0',[f.noteLine(item,'1','10',{unit:'CX'})]);
 const read=await stock(`/v1/estoque/notas-fiscais/${entry.id}/unidades`);
 const view=stockResponse(read.raw,read.route,read.operation);
 assert.deepEqual(view.items.map(i=>[i.position,i.product.code.length,i.unit]),[[1,100,'CX']]);
 tamper(read,v=>{v.items[0].product.code='X'.repeat(101);});
});
