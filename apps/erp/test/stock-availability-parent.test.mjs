import test from 'node:test';import assert from 'node:assert/strict';
import {mountComponent} from './helpers/component-recovery-harness.mjs';
import {createStockAvailabilityFixture,stockAvailabilityIds as ids} from '../src/qa/stock-availability-fixture.ts';
const child=(v,name)=>v.nodes().find(n=>typeof n.type==='function'&&n.type.name===name);
const queries=f=>f.calls.filter(c=>c.path.startsWith('/v1/reservas-estoque/'));
const productReads=f=>f.calls.filter(c=>/^\/v1\/estoque\/(saldos|movimentos)\?/.test(c.path));
// The extrato opens from the URL (EST-067: /estoque-empresa?produto=<uuid>), in the depósito padrão of the fixture.
async function open(f){const v=await mountComponent('RealStock.tsx',{controller:f.controller},{expandChildren:['StockAvailability'],location:`/estoque-empresa?produto=${ids.product}`});await v.flush();return v;}
const select=(v,id)=>v.change(v.find(n=>n.type==='select'&&String(n.props.id).endsWith('-warehouse')).props.id,id);
test('real stock product keeps its two product reads; availability is separate and refresh invalidates it without fan-out',async()=>{const f=createStockAvailabilityFixture(),v=await open(f);try{
 assert.equal(productReads(f).length,2);assert.equal(queries(f).length,0);await select(v,ids.recorded);await v.click('Conferir disponível');assert.equal(queries(f).length,1);assert.ok(v.nodes().some(n=>n.type==='time'));
 const old=v.button('Conferir disponível');await v.click('Atualizar saldos');old.props.onClick();await v.flush();assert.equal(queries(f).length,1);assert.equal(productReads(f).length,4);assert.equal(v.nodes().some(n=>n.type==='time'),false);
 assert.equal(v.find(n=>n.type==='select'&&String(n.props.id).endsWith('-warehouse')).props.value,'');
 child(v,'StockProductSearch').props.onSelect(null);await v.flush();assert.equal(v.location().search,'');assert.equal(child(v,'StockAvailability'),undefined);assert.equal(queries(f).length,1);
 assert.ok(f.calls.every(c=>(c.options.method??'GET')==='GET'&&c.options.body===undefined));}finally{v.unmount();}});
test('an open lançamento panel blocks new availability handlers; close requires a fresh explicit selection',async()=>{const f=createStockAvailabilityFixture();f.setSession({...f.controller.getSnapshot(),membership:{...f.controller.getSnapshot().membership,role:'admin'}});const v=await open(f);try{
 await select(v,ids.recorded);await v.click('Conferir disponível');const old=v.button('Conferir disponível');await v.click('Incluir lançamento');assert.ok(child(v,'StockLaunchPanel'));assert.equal(v.button('Conferir disponível').disabled,true);
 old.props.onClick();await v.flush();assert.equal(queries(f).length,1);assert.equal(v.nodes().some(n=>n.type==='time'),false);child(v,'StockLaunchPanel').props.onClose();await v.flush();
 assert.equal(v.find(n=>n.type==='select'&&String(n.props.id).endsWith('-warehouse')).props.value,'');assert.equal(queries(f).length,1);assert.ok(f.calls.every(c=>(c.options.method??'GET')==='GET'));}finally{v.unmount();}});
test('no configured warehouses provides no selectable query and does not fabricate a balance',async()=>{const f=createStockAvailabilityFixture(),read=f.controller.stock;f.controller.stock=async(p,o)=>{const raw=await read(p,o);return p.startsWith('/v1/estoque/saldos')?{...raw,items:[]}:raw;};const v=await open(f);try{assert.match(v.text(),/Cadastre um depósito/);assert.equal(v.button('Conferir disponível').disabled,true);assert.equal(queries(f).length,0);}finally{v.unmount();}});
