import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {purchaseFixture} from '../../workers/erp-api/test/helpers/purchase-readiness-fixture.mjs';
import {parseSalesPriceJson,salesPriceCapture} from '../../workers/origin-sync/src/sales-price-json.mjs';

async function load078(f) {
  await f.db.exec(await readFile(new URL('../../supabase/migrations/202610160078_origin_sales_price_capture.sql',import.meta.url),'utf8'));
}
async function report(f) {
  const results=await f.db.exec(await readFile(new URL('./origin_sales_readiness_summary.sql',import.meta.url),'utf8'));
  return results.flatMap(r=>r.rows??[]).find(r=>r.sales_readiness_summary)?.sales_readiness_summary;
}

test('sales inspection groups real bindings and limits without changing the test order or ledgers', async () => {
  const f = await purchaseFixture();
  try {
    await load078(f);
    const payload = id => ({id,numero:1,contato:{id:21},situacao:{id:7,valor:999},notaFiscal:{id:0},
      itens:[{produto:{id:22},unidade:'UN',quantidade:1,valor:1.25,desconto:0,aliquotaIPI:0}],
      desconto:{valor:0,unidade:'REAL'},tributacao:{},parcelas:[]});
    await f.stage('sales_orders','101',JSON.stringify(payload('101')).replace('"valor":1.25','"valor":9999999999.1234567891'));
    const repeated = payload('102');
    repeated.contato.id = 901; repeated.itens = [501,501,502].map(id=>({...repeated.itens[0],produto:{id}}));
    repeated.itens[0].desconto=2; repeated.itens[0].aliquotaIPI=5;
    repeated.notaFiscal={id:800}; repeated.parcelas=[{valor:1}];
    await f.stage('products','501',{id:501,nome:'PRIVATE_PRODUCT_SENTINEL'});
    await f.stage('sales_orders','102',repeated);
    const reviewedProduct=await f.catalog('products','23');
    await f.db.query('update erp_catalog.record set human_edited=true where id=$1',[reviewedProduct]);
    const review=payload('103'); review.itens[0].produto.id=23; review.itens[0].unidade='CX';
    await f.stage('sales_orders','103',review);
    const unsupported=payload('104'); unsupported.itens=Array.from({length:251},()=>unsupported.itens[0]);
    await f.stage('sales_orders','104',unsupported);
    const invalid=payload('999'); invalid.contato.id='021'; invalid.situacao.valor='0';
    invalid.itens[0].quantidade=0; invalid.itens[0].valor=-1; invalid.itens[0].desconto=101;
    invalid.itens[0].unidade='UN\u0085'; invalid.notaFiscal={id:'01'};
    await f.stage('sales_orders','105',invalid);
    const huge=payload('106'); huge.private_extra='PRIVATE_PAYLOAD_SENTINEL'.repeat(25000);
    await f.stage('sales_orders','106',huge);
    await f.db.exec("insert into origin_backup.batch(backup_sha,manifest,status,finished_at)values(repeat('a',64),'{}','stored',clock_timestamp())");
    for (let n=1;n<=2;n++) await f.db.query("insert into origin_backup.record(backup_sha,kind,file_id,record_no,data)values(repeat('a',64),'csv',repeat('b',64),$1,$2::jsonb)",
      [n,JSON.stringify({entity:'sales_orders',source_id:null,payload:{'Número pedido':'1',SKU:'PRIVATE_BACKUP_SENTINEL'}})]);
    const nativeId=randomUUID();
    await f.db.query("insert into erp_documents.document(id,kind,number,status,contact_id,contact_snapshot,body,total,created_by,updated_by)values($1,'sales_orders',1,'draft',$2,'{}','{}',1,$3,$3)",[nativeId,f.contact,f.users.admin]);
    await f.db.exec("update erp_documents.numbering set last_number=1 where kind='sales_orders'");
    const before=await f.fingerprint();
    const summary=await report(f);
    assert.ok(summary);
    assert.equal(summary.can_import,false); assert.equal(summary.coverage_certified,false);
    assert.equal(summary.commercial_observations.price_precision_proven,false);
    assert.equal(summary.profile,'origin-sales-readiness-inspection-v2');
    assert.deepEqual(summary.price_capture.states,{absent:6,other_profile:0,unbound:0,bound:0});
    assert.equal(summary.pending_contracts.includes('SALES_PRICE_LEXEME_CAPTURE_NOT_IMPLEMENTED'),false);
    assert.equal(summary.source_counts.total,6); assert.equal(summary.source_counts.inspected,6);
    assert.equal(summary.source_counts.item_rows_observed,258);
    assert.equal(summary.source_counts.item_rows_inspected,6);
    assert.equal(summary.source_counts.omitted_source_details,2);
    assert.equal(summary.source_counts.without_local_issues,1);
    assert.equal(summary.source_counts.truncated,false);
    const states=Object.fromEntries(summary.product_bindings.map(r=>[r.state,r]));
    assert.deepEqual(states.missing_native,{state:'missing_native',line_occurrences:2,unique_ids:1});
    assert.deepEqual(states.missing_staging,{state:'missing_staging',line_occurrences:1,unique_ids:1});
    assert.deepEqual(states.needs_review,{state:'needs_review',line_occurrences:1,unique_ids:1});
    const issues=Object.fromEntries(summary.issues.map(r=>[r.code,r]));
    assert.equal(issues.PRODUCT_BINDING_UNAVAILABLE.occurrences,4);
    assert.equal(issues.PRODUCT_BINDING_UNAVAILABLE.sources,2);
    for(const code of ['SOURCE_ID_INVALID_OR_MISMATCHED','SOURCE_TOO_LARGE','ITEM_COUNT_OUTSIDE_LIMIT','UNIT_INVALID','QUANTITY_OUTSIDE_NATIVE_LIMIT','PRICE_OUTSIDE_NATIVE_LIMIT','LINE_DISCOUNT_OUTSIDE_OBSERVED_PERCENT_LIMIT']) assert.equal(issues[code].occurrences,1,code);
    assert.equal(issues.UNIT_DIFFERS_FROM_LINK.occurrences,2);
    assert.equal(issues.INVOICE_REFERENCE_UNVERIFIED.occurrences,2);
    assert.equal(summary.invoice_references.find(x=>x.state==='zero').sources,4);
    assert.equal(summary.situations.find(x=>x.value==='999').sources,5);
    assert.equal(summary.commercial_observations.positive_line_discounts,2);
    assert.equal(summary.commercial_observations.positive_ipi_lines,1);
    assert.equal(summary.backup.rows,2); assert.equal(summary.backup.rows_without_source_id,2);
    assert.equal(summary.lowest_local_issue_samples.length,5);
    assert.equal(summary.lowest_local_issue_samples[0].source_id,'101');
    assert.equal(summary.lowest_local_issue_samples[0].local_issue_occurrences,0);
    assert.equal(summary.native.test_order_1.id,nativeId);
    assert.equal(summary.native.test_order_1.version,1);
    assert.equal(summary.native.numbering_last_number,'1');
    assert.equal(summary.native.sales_orders,1);
    assert.deepEqual(await f.fingerprint(),before);
    assert.doesNotMatch(JSON.stringify(summary),/PRIVATE_|9999999999\.1234567891|contato|customer_name|document_links/);
  } finally { await f.close(); }
});

test('078 diagnostic revalidates exact tokens and metadata, preserves zero/null and changes no rows or persistent objects',async()=>{
  const f=await purchaseFixture();
  try {
    await load078(f);
    const add=async(id,price='84.8062444176',change=null)=>{
      const body=`{"id":"${id}","numero":"SYNTHETIC","contato":{"id":21},"situacao":{"id":6,"valor":0},"itens":[{"produto":{"id":22},"unidade":"UN","quantidade":1,"valor":${price},"desconto":0}],"parcelas":[]}`;
      const wire=`{"data":${body}}`;
      const parsed=await parseSalesPriceJson(wire,new TextEncoder().encode(wire),'sales_detail');
      await f.stage('sales_orders',id,JSON.stringify(parsed.data));
      let capture=structuredClone(salesPriceCapture(parsed.data));
      const source=await f.scalar("select jsonb_build_object('source_hash',version_hash,'source_version',version::text,'capture_id',$2::text,'observed_at','2026-10-17T05:00:00Z')v from origin_sync.raw_record where entity='sales_orders' and source_id=$1",[id,randomUUID()]);
      capture={...capture,...source};
      if(change)capture=change(capture);
      await f.db.query("update origin_sync.raw_record set price_capture=$2::jsonb where entity='sales_orders' and source_id=$1",[id,capture===null?null:JSON.stringify(capture)]);
    };
    await add('201'); // Ten-place decimal survives parser and SQL validation.
    await add('202','0e-2'); // Explicit zero is a captured numeric value.
    await add('203','null'); // Empty tokens are valid, but do not certify a price.
    await add('204','1',()=>null);
    await add('205','1',c=>({...c,profile:'origin-purchase-price-json-v1'}));
    await add('206','1',c=>({...c,profile:'origin-price-json-v1'}));
    await add('207','1',c=>({...c,source_hash:'f'.repeat(64)}));
    await add('208','1',c=>({...c,source_version:'2'}));
    await add('209','1',c=>({...c,tokens:[{path:'/itens/0/valor',lexeme:'2'}]}));
    await add('210','1',c=>({...c,tokens:[]}));
    await add('211','1',c=>({...c,source:'list_fallback'}));
    await add('212','1',c=>({...c,observed_at:'infinity'}));
    await add('213','1',c=>({...c,observed_at:'invalid'}));
    await add('214','1',c=>({...c,response_sha256:'invalid'}));
    await add('215','1',c=>({...c,capture_id:'invalid'}));
    await add('216','1',c=>({...c,tokens:[{path:'/valorLista',lexeme:'1'}]}));
    await add('217','1',c=>({...c,private_extra:'x'.repeat(131072)}));
    const before=await f.fingerprint();
    const catalogSql="select jsonb_build_object('relations',(select jsonb_agg(to_jsonb(c) order by oid)from pg_class c where relnamespace in(select oid from pg_namespace where nspname not like 'pg_%')),'functions',(select jsonb_agg(to_jsonb(p)order by oid)from pg_proc p where pronamespace in(select oid from pg_namespace where nspname not like 'pg_%')))v";
    const catalogBefore=await f.scalar(catalogSql);
    const result=await report(f);
    assert.deepEqual(result.price_capture.states,{absent:1,other_profile:2,unbound:11,bound:3});
    assert.equal(result.price_capture.inspected_sources,17);
    assert.equal(result.price_capture.validated_numeric_tokens,2);
    for(const key of ['coverage_certified','commercial_math_reconciled','current_capture_is_history'])assert.equal(result.price_capture[key],false,key);
    assert.equal(result.can_import,false);assert.equal(result.native_effects,false);
    assert.equal(result.commercial_observations.price_precision_proven,false);
    assert.equal(result.backup.per_order_comparison,'not_available_without_exact_identity');
    assert.doesNotMatch(JSON.stringify(result),/84\.8062444176|"tokens"|"response_sha256"|"capture_id"/);
    assert.deepEqual(await f.fingerprint(),before);
    assert.deepEqual(await f.scalar(catalogSql),catalogBefore);
    assert.ok([null,''].includes(await f.scalar("select current_setting('brufap.sales_readiness_capture',true)v")),'COMMIT clears the transaction-local aggregate');
  }finally{await f.close();}
});
