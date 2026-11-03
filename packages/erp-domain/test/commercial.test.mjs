import assert from 'node:assert/strict';
import {test} from 'node:test';
import {normalizeDocument,normalizeCommercial,normalizeCommercialReference,calculateDocument} from '../src/index.mjs';
export const reference=()=>({system:'origin',source_id:'1234567890123456789012345678901234567890',label:'Referência externa sintética'});
export const commercial=()=>({introduction:'Introdução\nCondição comercial',attention_to:'Pessoa sintética',seller_reference:reference(),store_reference:null,business_unit_reference:null,
 transport:{freight_mode:'0',volume_count:'1.234567',gross_weight:'999999999999.999999',delivery_days:'0',carrier_reference:reference(),service_reference:null,tracking_code:'Código sintético'}});
export const fixture=()=>({date:'2026-10-16',contact_id:'11111111-1111-4111-8111-111111111111',commercial:commercial(),
 items:[{description:'Produto sintético',detailed_description:'Detalhe\ncomercial',unit:'UN',quantity:'2.5',unit_price:'40',discount_percent:'0'}],
 discount_mode:'amount',discount_value:'2',freight:'0',other_expenses:'3',installments:[{due_date:'2026-11-16',amount:'101',method:null,note:'Parcela planejada',payment_reference:reference()}]});
test('commercial fields are explicit, exact and do not change the document arithmetic',()=>{
 const input=fixture(),before=structuredClone(input),result=normalizeDocument('sales_proposals',input);
 assert.deepEqual(input,before);assert.equal(result.totals.total,'101.00');assert.equal(result.totals.line_discount,'0.00');
 assert.deepEqual(result.commercial,commercial());assert.equal(result.items[0].detailed_description,'Detalhe\ncomercial');assert.deepEqual(result.installments[0].payment_reference,reference());
 assert.equal(calculateDocument({...input,commercial:{untrusted:true}}).total,'101.00');
 for(const kind of ['sales_proposals','sales_orders','purchase_orders','service_orders'])assert.deepEqual(normalizeDocument(kind,input).commercial,result.commercial);
});
test('missing legacy extensions remain missing; explicit null remains explicit',()=>{
 const input=fixture();delete input.commercial;delete input.items[0].detailed_description;delete input.installments[0].note;delete input.installments[0].payment_reference;
 const old=normalizeDocument('sales_proposals',input);assert.equal(Object.hasOwn(old,'commercial'),false);assert.equal(Object.hasOwn(old.items[0],'detailed_description'),false);assert.equal(Object.hasOwn(old.installments[0],'note'),false);
 const explicit=normalizeDocument('sales_proposals',{...input,commercial:null,items:input.items.map(i=>({...i,detailed_description:null})),installments:input.installments.map(i=>({...i,note:null,payment_reference:null}))});
 assert.equal(explicit.commercial,null);assert.equal(explicit.items[0].detailed_description,null);assert.equal(explicit.installments[0].payment_reference,null);
});
test('no native binding, historical discount, actor or computed data may enter commercial fields',()=>{
 for(const patch of [{native_id:'11111111-1111-4111-8111-111111111111'},{verified:true},{system:'native'},{source_id:123},{source_id:'0123'},{source_id:'0'},{source_id:'1'.repeat(41)},{source_id:['123']}])assert.throws(()=>normalizeCommercialReference({...reference(),...patch}));
 for(const fn of [v=>delete v.attention_to,v=>v.transport={},v=>v.seller_reference={system:'origin',source_id:'1'},v=>v.transport.freight_mode=0,v=>v.transport.volume_count='1.0000001',v=>v.transport.gross_weight='1000000000000',v=>v.transport.delivery_days='1000000',v=>v.transport.delivery_days='00',v=>v.transport.freight_mode='5',v=>v.source_hash='a'.repeat(64),v=>v.original_discount='10']){const v=commercial();fn(v);assert.throws(()=>normalizeCommercial(v));}
 for(const path of ['detailed_description','note']){const v=fixture();if(path==='note')v.installments[0].note='x'.repeat(2001);else v.items[0].detailed_description='x'.repeat(4001);assert.throws(()=>normalizeDocument('sales_proposals',v));}
 const v=fixture();v.items[0].source_discount='10';assert.throws(()=>normalizeDocument('sales_proposals',v));
});
test('new text limits use code points, strip only boundary ASCII spaces and never interpret markup',()=>{
 const c=commercial();c.introduction='🧪'.repeat(4000);c.attention_to='  Teste  ';c.seller_reference.label='🧪'.repeat(200);
 assert.equal(normalizeCommercial(c).attention_to,'Teste');assert.equal(normalizeCommercial(c).introduction,c.introduction);
 c.introduction+='🧪';assert.throws(()=>normalizeCommercial(c));
 c.introduction='<texto>Literal</texto>\nSem renderização HTML';assert.equal(normalizeCommercial(c).introduction,c.introduction);
 c.attention_to='A\nB';assert.throws(()=>normalizeCommercial(c));c.attention_to='A';c.introduction='A\u0000B';assert.throws(()=>normalizeCommercial(c));
});
test('zero differs from missing transport values; mode9 cannot describe positive freight',()=>{
 const v=fixture();v.commercial.transport={...v.commercial.transport,freight_mode:null,volume_count:null,gross_weight:'0',delivery_days:null};
 const r=normalizeDocument('sales_proposals',v);assert.equal(r.commercial.transport.volume_count,null);assert.equal(r.commercial.transport.gross_weight,'0.000000');assert.equal(r.commercial.transport.delivery_days,null);
 v.commercial.transport.freight_mode='9';v.freight='1';v.installments=[];assert.throws(()=>normalizeDocument('sales_proposals',v),/TRANSPORT_CONFLICT/);
});

test('new text bounds are measured after ASCII boundary trim, matching SQL',()=>{
 const v=fixture();v.commercial.introduction=' '+ '🧪'.repeat(4000)+' ';v.commercial.attention_to=' '+ 'x'.repeat(200)+' ';v.commercial.seller_reference.label=' '+ '🧪'.repeat(200)+' ';v.items[0].detailed_description=' '+ 'x'.repeat(4000)+' ';v.installments[0].note=' '+ '🧪'.repeat(2000)+' ';
 const r=normalizeDocument('sales_proposals',v);assert.equal(r.commercial.introduction,'🧪'.repeat(4000));assert.equal(r.commercial.attention_to,'x'.repeat(200));assert.equal(r.commercial.seller_reference.label,'🧪'.repeat(200));assert.equal(r.items[0].detailed_description,'x'.repeat(4000));assert.equal(r.installments[0].note,'🧪'.repeat(2000));
 v.commercial.attention_to=' '+ 'x'.repeat(201)+' ';assert.throws(()=>normalizeDocument('sales_proposals',v));
});
