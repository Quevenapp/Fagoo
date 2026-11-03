import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {stockLaneGFixture} from './helpers/stock-lane-g-fixture.mjs';
import {parseDocumentStockRoute,executeDocumentStockRoute} from '../src/document-stock.mjs';

// 296 through the Worker with the real SQL on PGlite (synthetic data only): the lots of the items in the conferência of the lançamento
// and of the estorno of a document, projected and cross-checked (a forged lot fails closed with 502).
let f;
before(async()=>{f=await stockLaneGFixture();});
after(()=>f?.close());
const post=(path,body)=>new Request(`https://api.example.test${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const call=async(path,body,{user=f.users.estoque,forge=null}={})=>executeDocumentStockRoute(await parseDocumentStockRoute(post(path,body)),{userId:user,
 rpc:async(name,args)=>{const value=await f.rpc(name,args);if(forge)forge(value);return value;}});
const bad=async(path,body,forge)=>assert.rejects(call(path,body,{forge}),error=>error.status===502&&error.code==='ERP_UPSTREAM_INVALID_RESPONSE');
const docVersion=id=>f.scalar('select version v from erp_documents.document where id=$1',[id]);

test('296 the lots of the conferência through the Worker: lançamento with the items of each lot, estorno with the lots that come back',async()=>{
 const target=await f.warehouse('HTTP depósito lotes'),item=await f.lotProduct('HTTP produto lote');
 const a=await f.lotSave(item.id,{code:'H-1',expires_on:'2027-03-31'}),b=await f.lotSave(item.id,{code:'H-2'});
 await f.lotLaunch(item.id,target.id,'receipt','6',{lot_id:a.id});await f.lotLaunch(item.id,target.id,'receipt','2',{lot_id:b.id});
 const sale=await f.order('sales_orders',[f.item(item,'3'),f.item(item,'2')],target.id);
 const lines=await f.rows('select id::text from erp_documents.item where document_id=$1 order by position',[sale.id]);
 await f.db.query("update erp_documents.item set data=jsonb_set(data,'{lots}',$2::jsonb) where id=$1",[lines[0].id,JSON.stringify([{lot_id:a.id,quantity:'2'},{lot_id:b.id,quantity:'1'}])]);
 await f.db.query("update erp_documents.item set data=jsonb_set(data,'{lots}',$2::jsonb) where id=$1",[lines[1].id,JSON.stringify([{lot_id:a.id,quantity:'1'}])]);
 const base=`/v1/documentos-estoque/sales_orders/${sale.id}`,day='2026-10-20';
 const input={expected_document_version:await docVersion(sale.id),occurred_on:day,reason:'Venda HTTP 296'};
 const {preview}=await call(`${base}/preview`,input);
 assert.deepEqual(preview.positions[0].lots,[
  {lot_id:a.id,code:'H-1',expires_on:'2027-03-31',quantity:'-3.000000',balance_before:'6.000000',balance_after:'3.000000',sources:[{id:lines[0].id,position:1,quantity:'2.000000'},{id:lines[1].id,position:2,quantity:'1.000000'}]},
  {lot_id:b.id,code:'H-2',expires_on:null,quantity:'-1.000000',balance_before:'2.000000',balance_after:'1.000000',sources:[{id:lines[0].id,position:1,quantity:'1.000000'}]}]);
 const lot=fn=>v=>fn(v.preview.positions[0].lots);
 await bad(`${base}/preview`,input,lot(l=>{l[0].quantity='3.000000';l[0].balance_after='9.000000';}));
 await bad(`${base}/preview`,input,lot(l=>{l[0].balance_after='4.000000';}));
 await bad(`${base}/preview`,input,lot(l=>{l[1].balance_before='0.000000';l[1].balance_after='-1.000000';}));
 await bad(`${base}/preview`,input,lot(l=>{l[0].sources[0].quantity='1.000000';}));
 await bad(`${base}/preview`,input,lot(l=>{l[0].sources[0].id=randomUUID();}));
 await bad(`${base}/preview`,input,lot(l=>{l[0].sources[0].position=2;}));
 await bad(`${base}/preview`,input,lot(l=>{l[1].lot_id=l[0].lot_id;}));
 await bad(`${base}/preview`,input,lot(l=>{l.push({...l[1],lot_id:randomUUID(),quantity:'-2.000000',balance_after:'0.000000',sources:[{id:lines[1].id,position:2,quantity:'2.000000'}]});}));
 await bad(`${base}/preview`,input,lot(l=>{l[0].extra=true;}));
 await bad(`${base}/preview`,input,lot(l=>{delete l[0].sources;}));
 await bad(`${base}/preview`,input,v=>{v.preview.positions[0].lots=[];});
 const posted=await call(`${base}/post`,{...input,command_id:randomUUID(),preview_hash:preview.preview_hash,ignored_item_ids:[]});
 assert.deepEqual([await f.lotBalance(a.id,target.id),await f.lotBalance(b.id,target.id)],['3.000000','1.000000']);
 const reverse={expected_document_version:await docVersion(sale.id),occurred_on:'2026-10-21',reason:'Estorno HTTP 296',expected_posting_version:1};
 const back=await call(`${base}/${posted.posting.id}/reverse-preview`,reverse);
 assert.deepEqual(back.preview.positions[0].lots.map(l=>[l.code,l.quantity,l.balance_before,l.balance_after,Object.hasOwn(l,'sources')]),
  [['H-1','3.000000','3.000000','6.000000',false],['H-2','1.000000','1.000000','2.000000',false]]);
 await bad(`${base}/${posted.posting.id}/reverse-preview`,reverse,v=>{v.preview.positions[0].lots[0].sources=[];});
 await bad(`${base}/${posted.posting.id}/reverse-preview`,reverse,v=>{v.preview.positions[0].lots[0].quantity='-3.000000';v.preview.positions[0].lots[0].balance_after='0.000000';});
});
