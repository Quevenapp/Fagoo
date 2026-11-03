import test from'node:test';import assert from'node:assert/strict';
import{parsePreferencesRoute as parse,preferencesMethods,executePreferencesRoute}from'../src/preferences.mjs';
import{REPORT_BASES,REPORT_BASES_149,parseReports}from'../../../packages/erp-domain/src/reports-labels.mjs';

// Wave D routes of Preferências, Sistema and Meu Negócio. Synthetic data only.
const ACTOR='10000000-0000-4000-8000-000000000230',INVOICE='20000000-0000-4000-8000-000000000230',PRODUCT='30000000-0000-4000-8000-000000000230';
const req=(path,init)=>new Request('https://synthetic.invalid'+path,init);
const products=(over={})=>({scope:'label_invoice_products',data_mode:'erp_native',invoice:{id:INVOICE,model:'55',number:'12',series:'1'},
 items:[{position:1,product_id:PRODUCT,quantity:'2.5',values:{codigo:'P-1',descricao:'Peça',preco:'50',unidade:'UN',gtin:null,ncm:null}}],...over});

test('230 GET /v1/sistema/etiquetas/nota?id=: strict route and a closed answer',async()=>{
 assert.deepEqual(preferencesMethods('/v1/sistema/etiquetas/nota'),['GET']);
 const route=await parse(req(`/v1/sistema/etiquetas/nota?id=${INVOICE}`));assert.equal(route.rpc,'erp_preferences_label_invoice_products');assert.deepEqual({...route.args},{p_invoice_id:INVOICE});
 for(const path of['/v1/sistema/etiquetas/nota','/v1/sistema/etiquetas/nota?id=x',`/v1/sistema/etiquetas/nota?id=${INVOICE}&x=1`,`/v1/sistema/etiquetas/nota?id=${INVOICE}&id=${INVOICE}`])
  await assert.rejects(()=>parse(req(path)),e=>e.status===400,path);
 const out=await executePreferencesRoute(route,{userId:ACTOR,rpc:async(name,args)=>{assert.equal(name,'erp_preferences_label_invoice_products');assert.deepEqual(args,{p_invoice_id:INVOICE,p_user_id:ACTOR});return products();}});
 assert.equal(out.items[0].quantity,'2.5');
 for(const mutate of[v=>v.invoice.id=PRODUCT,v=>v.items[0].quantity='0',v=>v.items[0].quantity='1.23456',v=>v.items.push({...v.items[0]}),v=>v.items[0].values.extra='x',v=>v.items[0].product_id='x',v=>v.invoice.model='57'])
 {const v=structuredClone(products());mutate(v);await assert.rejects(()=>executePreferencesRoute(route,{userId:ACTOR,rpc:async()=>v}),e=>e.status===502,String(mutate));}
});

test('230 the report bases: the three notes bases come after the 149 ones and an older answer still parses',()=>{
 assert.deepEqual(REPORT_BASES.slice(8,11).map(b=>[b.base,b.group,b.title]),[['notas_saida','vendas','NF-e de saída'],['notas_entrada','suprimentos','NF-e de entrada'],['nfce','vendas','NFC-e']]);
 assert.deepEqual(REPORT_BASES_149.map(b=>b.base),['produtos','contatos','contas_receber','contas_pagar','vendas','propostas','pedidos_compra','ordens_servico']);
 const older={scope:'reports',data_mode:'erp_native',can_manage:false,bases:JSON.parse(JSON.stringify(REPORT_BASES_149)),reports:[],directory:null};assert.equal(parseReports(older).bases.length,8);
});
