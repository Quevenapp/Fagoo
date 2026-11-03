import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {stockLaneDFixture,migrationSql} from './helpers/stock-lane-d-fixture.mjs';
import {stockRoute,stockOperation,stockResponse} from '../src/stock.mjs';

// 227 on PGlite (published migrations up to 190, then 222-227) with synthetic data only: the saldo virtual of a Virtual composition in
// the "Saldos do produto" (extrato and "Todos os depósitos" of the document items).
let f;
before(async()=>{f=await stockLaneDFixture({upto:6});});
after(()=>f?.close());
const balances=async(id,user=f.users.vendas)=>{const url=new URL(`https://api.example.test/v1/estoque/saldos?product_id=${id}`),route=stockRoute(url.pathname);
 const operation=await stockOperation(new Request(url),route,url.searchParams);const raw=await f.rpc(operation.rpc,{p_user_id:user,...operation.args});return{raw,route,operation,out:stockResponse(raw,route,operation)};};

test('227 guard: published body only and a second run is refused',async()=>{
 await assert.rejects(f.db.exec(await migrationSql('202610200227_stock_composition_balances.sql')),/stock_composition_balances_227_previous_definition_changed/);await f.db.exec('rollback');
});

test('227 Saldos do produto: a Virtual composition shows its saldo virtual per warehouse (version 0); other products are unchanged',async()=>{
 const one=await f.warehouse('Saldo virtual 1'),two=await f.warehouse('Saldo virtual 2');
 const a=await f.product('Saldo virtual A');await f.launch(a.id,one.id,'receipt','7');await f.launch(a.id,two.id,'receipt','2');
 const virtual=await f.kit('Kit saldo virtual',[[a,'2']]);
 const physical=await f.kit('Kit saldo físico',[[a,'1']],{stock_type:'physical',post_mode:'product'});await f.launch(physical.id,one.id,'receipt','4');
 const {out,raw,route,operation}=await balances(virtual.id);
 const by=Object.fromEntries(out.items.map(i=>[i.warehouse_id,i]));
 assert.deepEqual([by[one.id].quantity,by[one.id].version,by[one.id].virtual,by[two.id].quantity],['3.000000',0,true,'1.000000']);
 const forged=structuredClone(raw);forged.items[0].version=1;assert.throws(()=>stockResponse(forged,route,operation),error=>error.status===502);
 const mixed=structuredClone(raw);delete mixed.items[0].virtual;assert.throws(()=>stockResponse(mixed,route,operation),error=>error.status===502);
 const own=(await balances(physical.id)).out.items.find(i=>i.warehouse_id===one.id);
 assert.deepEqual([own.quantity,own.version,Object.hasOwn(own,'virtual')],['4.000000',1,false]);
 const plain=(await balances(a.id)).raw.items.find(i=>i.warehouse_id===one.id);assert.equal(Object.hasOwn(plain,'virtual'),false,'the published shape for every other product');
});
