import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {stockLaneEFixture,fails} from './helpers/stock-lane-e-fixture.mjs';
import {stockRoute,stockMethods,stockOperation,stockResponse} from '../src/stock.mjs';

// 259 through the Worker with the real SQL on PGlite (synthetic data only): routes, closed bodies, projected responses that fail
// closed (502), the extrato with the origin "Notas Fiscais" and the check-in that posts the received quantities.
let f,saleNature,buyNature;
before(async()=>{
 f=await stockLaneEFixture({upto:2});
 await f.db.query("insert into erp_company.identity(singleton,version,data,updated_by) values(true,1,'{\"state\":\"SP\",\"cnpj\":\"11222333000181\"}',$1) on conflict do nothing",[f.users.admin]);
 await f.db.query("insert into erp_company.fiscal(singleton,version,crt,confirmed_at,confirmed_by) values(true,1,'1',now(),$1) on conflict do nothing",[f.users.admin]);
 const nature=async data=>(await f.rpc('erp_fiscal_nature_execute',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_action:'create',p_data:{nature:data}})).nature;
 saleNature=await nature({description:'Venda HTTP 259',direction:'1',crt:'1'});buyNature=await nature({description:'Compra HTTP 259',direction:'0',crt:'1',presence:'9'});
});
after(()=>f?.close());
let numbers=800000;
const line=(product,quantity,price='10',over={})=>({product_id:product?.id??null,description:'Item HTTP',code:'H-1',unit:'UN',quantity,unit_price:price,...over});
const note=async(direction,items)=>{const total=items.reduce((sum,i)=>sum+Number(i.quantity)*Number(i.unit_price),0).toFixed(2);
 return(await f.rpc('erp_fiscal_invoice_execute',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_action:'create',p_data:{invoice:{model:'55',direction,issue_type:direction==='0'?'T':'N',series:'1',
  ...(direction==='0'?{number:String(++numbers)}:{}),nature_id:direction==='1'?saleNature.id:buyNature.id,issue_date:'2026-10-20',crt:'1',purpose:'1',presence:direction==='1'?'1':'9',final_consumer:false,
  recipient:{name:'Contato HTTP',person_type:'J',document:'12345678000190',state:'SP'},items,payment:{installments:[{date:'2026-11-20',amount:total}]}},orders:[]}})).invoice;};
const request=(path,method='GET',body)=>new Request(`https://api.example.test${path}`,{method,...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
const stock=async(path,{method='GET',body,user=f.users.estoque}={})=>{const url=new URL(`https://api.example.test${path}`),route=stockRoute(url.pathname);
 const operation=await stockOperation(request(path,method,body),route,url.searchParams);return{raw:await f.rpc(operation.rpc,{p_user_id:user,...operation.args}),route,operation};};
const run=async(path,options)=>{const{raw,route,operation}=await stock(path,options);return stockResponse(raw,route,operation);};
const tamper=(result,change)=>{const forged=structuredClone(result.raw);change(forged);assert.throws(()=>stockResponse(forged,result.route,result.operation),error=>error.status===502);};
const version=async id=>f.scalar('select version v from erp_fiscal_invoices.invoice where id=$1',[id]);

test('259 routes: methods, strict params and closed bodies are refused before the database',async()=>{
 const id=randomUUID();
 assert.deepEqual(stockMethods(stockRoute('/v1/estoque/notas-fiscais/situacao')),['GET']);
 assert.deepEqual(stockMethods(stockRoute(`/v1/estoque/notas-fiscais/${id}`)),['GET']);
 for(const tail of['previa','lancamento','estorno/previa','estorno','checkin/previa','checkin'])assert.deepEqual(stockMethods(stockRoute(`/v1/estoque/notas-fiscais/${id}/${tail}`)),['POST'],tail);
 assert.equal(stockRoute(`/v1/estoque/notas-fiscais/${id}/outra`),null);
 const refuse=async(path,method='GET',body)=>{const url=new URL(`https://api.example.test${path}`);await assert.rejects(stockOperation(request(path,method,body),stockRoute(url.pathname),url.searchParams),error=>error.status===400,path);};
 await refuse('/v1/estoque/notas-fiscais/situacao');await refuse(`/v1/estoque/notas-fiscais/situacao?ids=${id},${id}`);await refuse('/v1/estoque/notas-fiscais/situacao?ids=x');
 await refuse(`/v1/estoque/notas-fiscais/situacao?ids=${Array.from({length:101},()=>randomUUID()).join(',')}`);await refuse(`/v1/estoque/notas-fiscais/${id}?x=1`);
 await refuse(`/v1/estoque/notas-fiscais/${id}/previa`,'POST',{expected_version:0,warehouse_id:id});
 await refuse(`/v1/estoque/notas-fiscais/${id}/previa`,'POST',{expected_version:1,warehouse_id:id,extra:true});
 await refuse(`/v1/estoque/notas-fiscais/${id}/lancamento`,'POST',{command_id:randomUUID(),expected_version:1,warehouse_id:id,preview_hash:'x'});
 await refuse(`/v1/estoque/notas-fiscais/${id}/estorno`,'POST',{command_id:randomUUID(),posting_id:id,posting_version:0,preview_hash:'0'.repeat(64)});
 await refuse(`/v1/estoque/notas-fiscais/${id}/checkin`,'POST',{command_id:randomUUID(),expected_version:1,warehouse_id:id});
});

test('259 Lançar and Estornar estoque of a note through the Worker: state, prévia, command and letter, cross-checked',async()=>{
 const depot=await f.warehouse('HTTP nota depósito');
 const a=await f.product('HTTP nota A');await f.launch(a.id,depot.id,'receipt','9');
 const exit=await note('1',[line(a,'4','3.25'),line(null,'1','2')]);
 const state=await stock(`/v1/estoque/notas-fiscais/${exit.id}`,{user:f.users.fiscal});
 const view=stockResponse(state.raw,state.route,state.operation);
 assert.deepEqual([view.flag.flag,view.block,view.can_manage,view.invoice.screen],[null,null,false,'nfe_saida']);
 tamper(state,v=>{v.block='posted';});tamper(state,v=>{v.invoice.id=randomUUID();});
 const previewed=await stock(`/v1/estoque/notas-fiscais/${exit.id}/previa`,{method:'POST',body:{expected_version:await version(exit.id),warehouse_id:depot.id}});
 const p=stockResponse(previewed.raw,previewed.route,previewed.operation).preview;
 assert.deepEqual([p.positions[0].quantity,p.positions[0].balance_after,p.ignored[0].reason],['-4.000000','5.000000','unlinked_item']);
 tamper(previewed,v=>{v.preview.positions[0].balance_after='6.000000';});tamper(previewed,v=>{v.preview.positions[0].sources[0].quantity='3.000000';});
 tamper(previewed,v=>{v.preview.warehouse.id=randomUUID();});
 const body={command_id:randomUUID(),expected_version:await version(exit.id),warehouse_id:depot.id,preview_hash:p.preview_hash};
 const posted=await stock(`/v1/estoque/notas-fiscais/${exit.id}/lancamento`,{method:'POST',body});
 const out=stockResponse(posted.raw,posted.route,posted.operation);
 assert.deepEqual([out.flag.flag,out.posting.direction,out.movement.items[0].quantity,out.replayed],['S','issue','-4.000000',false]);
 tamper(posted,v=>{v.flag.flag=null;v.flag.warehouse=null;v.flag.posting_id=null;v.flag.posting_version=null;v.flag.source=null;});tamper(posted,v=>{v.posting.movement_id=randomUUID();});
 assert.equal((await run(`/v1/estoque/notas-fiscais/${exit.id}/lancamento`,{method:'POST',body})).replayed,true);
 await assert.rejects(run(`/v1/estoque/notas-fiscais/${exit.id}/lancamento`,{method:'POST',body:{...body,command_id:randomUUID()},user:f.users.fiscal}),fails('42501'));
 const letters=await stock(`/v1/estoque/notas-fiscais/situacao?ids=${exit.id},${randomUUID()}`,{user:f.users.fiscal});
 assert.deepEqual(stockResponse(letters.raw,letters.route,letters.operation).items.map(i=>[i.invoice_id,i.flag,i.warehouse.id]),[[exit.id,'S',depot.id]]);
 tamper(letters,v=>{v.items[0].invoice_id=randomUUID();});tamper(letters,v=>{v.items[0].flag='E';});
 // The extrato shows the origin Notas Fiscais through the ledger projection, with the note price for admin.
 const ledger=await run(`/v1/estoque/movimentos?product_id=${a.id}&limit=100&offset=0&origin=invoices`,{user:f.users.admin});
 assert.deepEqual(ledger.items.map(r=>[r.origin.type,r.origin.document_kind,r.unit_price]),[['invoices','nfe_saida','3.2500000000']]);
 // Estornar estoque.
 const rp=await run(`/v1/estoque/notas-fiscais/${exit.id}/estorno/previa`,{method:'POST',body:{posting_id:out.posting.id,posting_version:1}});
 assert.equal(rp.preview.positions[0].quantity,'4.000000');
 const reversed=await stock(`/v1/estoque/notas-fiscais/${exit.id}/estorno`,{method:'POST',body:{command_id:randomUUID(),posting_id:out.posting.id,posting_version:1,preview_hash:rp.preview.preview_hash}});
 const back=stockResponse(reversed.raw,reversed.route,reversed.operation);
 assert.deepEqual([back.flag.flag,back.posting.state,back.balance_adjustments],[null,'reversed',[]]);
 tamper(reversed,v=>{v.posting.state='active';});
 assert.equal(await f.balance(a.id,depot.id),'9.000000');
});

test('259 Finalizar do check-in with Lançar estoque through the Worker: the received quantities and the finished check-in',async()=>{
 const depot=await f.warehouse('HTTP check-in depósito');
 const a=await f.product('HTTP check-in A');
 const entry=await note('0',[line(a,'6','2')]);
 const saved=await f.rpc('erp_stock_checkin_save',{p_user_id:f.users.estoque,p_command_id:randomUUID(),p_invoice_id:entry.id,p_expected_version:0,p_items:[{position:1,received:'5'}]});
 const pv=await run(`/v1/estoque/notas-fiscais/${entry.id}/checkin/previa`,{method:'POST',body:{expected_version:saved.version,warehouse_id:depot.id}});
 assert.deepEqual([pv.checkin_version,pv.preview.source,pv.preview.positions[0].quantity],[saved.version,'checkin','5.000000']);
 const done=await stock(`/v1/estoque/notas-fiscais/${entry.id}/checkin`,{method:'POST',body:{command_id:randomUUID(),expected_version:saved.version,warehouse_id:depot.id,preview_hash:pv.preview.preview_hash}});
 const out=stockResponse(done.raw,done.route,done.operation);
 assert.deepEqual([out.checkin.checkin.state,out.flag.source,out.posting.source,out.movement.items[0].quantity],['finished','checkin','checkin','5.000000']);
 tamper(done,v=>{v.checkin.checkin.state='in_progress';v.checkin.note.checkin_state='in_progress';v.checkin.checkin.finished_at=null;});tamper(done,v=>{v.posting.source='invoice';});
 assert.equal(await f.balance(a.id,depot.id),'5.000000');
});

test('259 review: a cancelled note with its stock posted keeps S and opens for the reversal; the check-in preference is projected',async()=>{
 const depot=await f.warehouse('HTTP nota cancelada');
 const a=await f.product('HTTP nota cancelada A');await f.launch(a.id,depot.id,'receipt','3');
 const exit=await note('1',[line(a,'1')]);
 const p=await run(`/v1/estoque/notas-fiscais/${exit.id}/previa`,{method:'POST',body:{expected_version:await version(exit.id),warehouse_id:depot.id}});
 await run(`/v1/estoque/notas-fiscais/${exit.id}/lancamento`,{method:'POST',body:{command_id:randomUUID(),expected_version:await version(exit.id),warehouse_id:depot.id,preview_hash:p.preview.preview_hash}});
 await f.db.query('update erp_fiscal_invoices.invoice set status=3,version=version+1 where id=$1',[exit.id]);
 const state=await stock(`/v1/estoque/notas-fiscais/${exit.id}`);
 const view=stockResponse(state.raw,state.route,state.operation);
 assert.deepEqual([view.flag.flag,view.block,view.checkin_post],['S','cancelled',false]);
 tamper(state,v=>{v.block=null;});tamper(state,v=>{v.block='deleted';});tamper(state,v=>{delete v.checkin_post;});tamper(state,v=>{v.checkin_post='sim';});
 const rp=await run(`/v1/estoque/notas-fiscais/${exit.id}/estorno/previa`,{method:'POST',body:{posting_id:view.flag.posting_id,posting_version:view.flag.posting_version}});
 const back=await run(`/v1/estoque/notas-fiscais/${exit.id}/estorno`,{method:'POST',body:{command_id:randomUUID(),posting_id:view.flag.posting_id,posting_version:view.flag.posting_version,preview_hash:rp.preview.preview_hash}});
 assert.deepEqual([back.flag.flag,back.posting.state],[null,'reversed']);assert.equal(await f.balance(a.id,depot.id),'3.000000');
 await f.setPreferences('notas-nfe',{'nfe.estoque_checkin':true});
 assert.equal((await run(`/v1/estoque/notas-fiscais/${exit.id}`)).checkin_post,true);
 await f.setPreferences('notas-nfe',{'nfe.estoque_checkin':false});
});
