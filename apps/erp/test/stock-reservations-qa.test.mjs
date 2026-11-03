import test from 'node:test';import assert from 'node:assert/strict';
import {createStockReservationsQaFixture} from '../src/qa/stock-reservations-fixture.ts';
import {reservationPage,reservationPreview,reservationAvailability,STOCK_RESERVATIONS_BASE as BASE} from '../src/lib/stock-reservations-model.ts';
for(const mode of ['available','active','consumed','readonly'])test(`070 visual fixture ${mode} uses real DTO and refuses all mutations without changing history`,async()=>{
 const f=createStockReservationsQaFixture(mode),id=f.record.id,url='https://stock.qa.invalid',read=async()=>reservationPage(await(await f.fetch(`${url}${BASE}/pedidos/${id}?limit=25`)).json(),id),before=await read();
 assert.equal(before.current.document.version,f.record.version);assert.equal(Boolean(before.current.active_reservation),mode==='active');
 const active=before.current.active_reservation;
 if(mode!=='consumed')for(const action of active?['release','consume']:['reserve']){const body={expected_document_version:f.record.version,occurred_on:'2026-10-16',reason:'Prévia local sintética',...(active?{expected_reservation_version:active.version}:{})},path=`${BASE}/pedidos/${id}/${active?active.id+'/'+action+'-preview':'preview'}`,raw=await(await f.fetch(url+path,{method:'POST',body:JSON.stringify(body)})).json();const p=reservationPreview(raw,id,action,body,active?.id??null);assert.equal(p.positions.length,2);assert.equal(p.ignored.length,1);}
 for(const item of f.record.items.filter(i=>i.product_id)){const path=`${BASE}/disponibilidade?product_id=${item.product_id}&warehouse_id=${f.record.warehouse_id}`,raw=await(await f.fetch(url+path)).json();assert.equal(reservationAvailability(raw,item.product_id,f.record.warehouse_id).position.state,'recorded');}
 for(const action of ['reserve','release','consume'])assert.equal((await f.fetch(`${url}${BASE}/pedidos/${id}/${action}`,{method:'POST',body:'{}'})).status,403);
 assert.deepEqual(await read(),before);assert.equal(f.counts.rejectedMutations,3);assert.equal((await f.fetch('https://outside.invalid/v1/me')).status,403);
});
