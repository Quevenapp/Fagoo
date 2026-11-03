import test from 'node:test';import assert from 'node:assert/strict';
import {documentFinanceTitlePath,checkedDocumentFinanceTitle,financeLinkActor} from '../src/lib/document-finance-link.ts';
import {financeListRoute,financeTitlePageApiPath,financeListParams} from '../src/lib/finance-list-route.ts';
import {createDocumentFinanceLinkFixture,financeLinkQaIds as ids} from '../src/qa/document-finance-link-fixture.ts';
import {parseFinanceRoute} from '../../../workers/erp-api/src/finance.mjs';
test('document title destinations preserve exact UUID and direction while list API receives no new SQL filters',async()=>{
 for(const kind of ['sales_orders','purchase_orders','service_orders']){const f=createDocumentFinanceLinkFixture(kind),url=new URL(documentFinanceTitlePath(kind,checkedDocumentFinanceTitle(f.record,f.detail,ids.title)),'https://synthetic.invalid'),route=financeListRoute(url.searchParams);
  assert.equal(route.titleId,ids.title);assert.equal(route.area,kind==='purchase_orders'?'payable':'receivable');assert.deepEqual(financeListRoute(financeListParams(route)),route);
  const path=financeTitlePageApiPath(route,'2026-10-20');assert.doesNotMatch(path,/titulo/);const parsed=await parseFinanceRoute(new Request('https://synthetic.invalid'+path));assert.equal(parsed.args.p_kind,route.area);assert.equal(parsed.args.p_option,'open');
 }
});
test('title navigation rejects ambiguous/incomplete routes, proposals and a title outside the shown posting',()=>{
 for(const q of [`titulo=${ids.title}`,`area=accounts&titulo=${ids.title}`,`area=categories&titulo=${ids.title}`,`area=receivable&titulo=bad`,`area=receivable&titulo=${ids.title}&titulo=${ids.title}`,`area=receivable&title=${ids.title}`])assert.throws(()=>financeListRoute(new URLSearchParams(q)));
 assert.throws(()=>documentFinanceTitlePath('sales_proposals',ids.title));assert.throws(()=>documentFinanceTitlePath('sales_orders','bad')); 
});
test('posting membership and document/version/kind/direction are checked independently of title UUID',()=>{
 const f=createDocumentFinanceLinkFixture();assert.throws(()=>checkedDocumentFinanceTitle(f.record,f.detail,ids.actor));
 for(const change of [x=>x.document_id=ids.actor,x=>x.document_version++,x=>x.posting.document_id=ids.actor,x=>x.posting.kind='purchase_orders',x=>x.posting.direction='payable',x=>x.titles.push({...x.titles[0]})]){const d=structuredClone(f.detail);change(d);assert.throws(()=>checkedDocumentFinanceTitle(f.record,d,ids.title));}
 assert.equal(checkedDocumentFinanceTitle(f.record,{...f.detail,posting:{...f.detail.posting,state:'reversed'}},ids.title),ids.title,'historical cancelled titles remain readable');
});
test('financial link actor requires a ready current financial reader',()=>{for(const role of ['admin','financeiro','consulta'])assert.equal(financeLinkActor({phase:'ready',membership:{role,user_id:ids.actor}}),ids.actor);for(const state of [null,{phase:'ready',membership:{role:'vendas',user_id:ids.actor}},{phase:'checking',membership:{role:'admin',user_id:ids.actor}},{phase:'ready',membership:{role:'admin',user_id:'bad'}}])assert.equal(financeLinkActor(state),null);});
