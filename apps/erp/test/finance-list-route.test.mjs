import assert from 'node:assert/strict';
import test from 'node:test';
import {emptyFinanceRoute,financeListRoute,financeListParams,financeListApiPath,financeListPage,financeDetailRecord,financePeriodNotice,financeTitlePageApiPath,defaultTitlePeriod,effectivePeriod} from '../src/lib/finance-list-route.ts';
import {parseFinanceRoute} from '../../../workers/erp-api/src/finance.mjs';
import {dueReport} from '../src/lib/due-date-report-model.ts';
import {dueReportResponse} from '../../../workers/erp-api/src/due-report.mjs';
import {dueFixture} from './fixtures/due-report-fixture.mjs';
const id='10000000-0000-4000-8000-000000000001';
test('due report and financial drilldown share inclusive 1900–2100 date boundaries',async()=>{
 for(const day of ['1900-01-01','2100-12-31']){
  const period={from:day,to:day},raw=dueFixture(day,day);
  assert.deepEqual(dueReportResponse(raw,{p_from:day,p_to:day}),dueReport(raw,period));
  for(const area of ['receivable','payable']){
   const route=financeListRoute(new URLSearchParams({area,...period}));
   assert.deepEqual(financeListRoute(financeListParams(route)),route);
   const api=await parseFinanceRoute(new Request(`https://synthetic.invalid${financeTitlePageApiPath(route,'2026-10-20')}`));
   assert.equal(api.args.p_from,day);assert.equal(api.args.p_to,day);assert.equal(api.args.p_statuses,null);assert.equal(api.args.p_option,'open');
  }
 }
 for(const day of ['1899-12-31','2101-01-01','2100-02-29']){
  assert.throws(()=>dueReport(dueFixture(day,day),{from:day,to:day}));
  assert.throws(()=>financeListRoute(new URLSearchParams({area:'receivable',from:day,to:day})));
 }
});
test('109 Origin default period goes from the 1st day of the previous month to the last day of the next month',async()=>{
 assert.deepEqual(defaultTitlePeriod('2026-10-20'),{from:'2026-09-01',to:'2026-11-30'});
 assert.deepEqual(defaultTitlePeriod('2026-01-15'),{from:'2025-12-01',to:'2026-02-28'});
 assert.deepEqual(defaultTitlePeriod('2026-12-31'),{from:'2026-11-01',to:'2027-01-31'});
 assert.deepEqual(defaultTitlePeriod('2024-03-31'),{from:'2024-02-01',to:'2024-04-30'});
 assert.deepEqual(effectivePeriod({from:'2026-01-01',to:''},'2026-10-20'),{from:'2026-01-01',to:''},'an explicit period wins');
 const api=await parseFinanceRoute(new Request(`https://synthetic.invalid${financeTitlePageApiPath(emptyFinanceRoute('receivable'),'2026-10-20')}`));
 assert.deepEqual([api.args.p_from,api.args.p_to],['2026-09-01','2026-11-30']);
 assert.equal(financeListParams(emptyFinanceRoute('receivable')).toString(),'area=receivable','the default period stays out of the URL');
});
test('financial drilldown preserves real existing period filters and opens on Em aberto, never inventing a situação',async()=>{
 const route=financeListRoute(new URLSearchParams('area=payable&from=2026-10-16&to=2026-10-17&q=teste'));
 assert.deepEqual(route,{...emptyFinanceRoute('payable'),from:'2026-10-16',to:'2026-10-17',q:'teste'});
 assert.deepEqual(emptyFinanceRoute('payable'),{area:'payable',q:'',option:'open',status:'',from:'',to:'',date:'due',account:'',category:'',remittance:'',value:'',doc:'',order:'due_asc',page:1});
 assert.deepEqual(financeListRoute(financeListParams(route)),route);
 const api=await parseFinanceRoute(new Request(`https://synthetic.invalid${financeTitlePageApiPath(route,'2026-10-20')}`));
 assert.equal(api.args.p_kind,'payable');assert.equal(api.args.p_statuses,null);assert.equal(api.args.p_from,route.from);assert.equal(api.args.p_to,route.to);assert.equal(api.args.p_option,'open');
 assert.equal(financePeriodNotice(route),null,'Em aberto already matches the due report');
 const issued={...route,option:'issued'};assert.match(financePeriodNotice(issued),/inclui todas as situações/);
 for(const status of ['open','partial','paid','cancelled']){
  const value={...issued,status},parsed=await parseFinanceRoute(new Request(`https://synthetic.invalid${financeTitlePageApiPath(value,'2026-10-20')}`));assert.deepEqual(parsed.args.p_statuses,[status]);
 }
 for(const params of ['area=receivable&status=outstanding','area=receivable&status=open','area=receivable&opcao=issued&status=overdue','area=nope','area=receivable&from=2026-02-30','area=receivable&from=2026-10-17&to=2026-10-16','area=accounts&from=2026-10-16','area=categories&status=open','area=receivable&area=payable','area=receivable&from=2026-10-16&from=2026-10-17','area=receivable&q=%0A','actor=1','area=accounts&opcao=overdue'])assert.throws(()=>financeListRoute(new URLSearchParams(params)),params);
 assert.equal(financeListParams(emptyFinanceRoute('payable')).toString(),'area=payable');
});
test('financial page and detail are bound to the requested area, UUID and cursor',()=>{
 const route=financeListRoute(new URLSearchParams('area=accounts&q=banco'));
 const record={id,name:'Banco',kind:'bank',active:true};
 const page={entity:'accounts',data_mode:'erp_native',limit:25,items:[record],has_more:false,next_cursor:null};
 assert.equal(financeListPage(page,route,null),page);
 assert.match(financeListApiPath(route,null),/^\/v1\/financeiro\/accounts\?limit=25&q=banco$/);
 assert.throws(()=>financeListApiPath(emptyFinanceRoute('receivable'),null),'contas use the numbered page');
 for(const mutate of [v=>v.entity='categories',v=>v.items.push({...record}),v=>v.has_more=true]){
  const bad=structuredClone(page);mutate(bad);assert.throws(()=>financeListPage(bad,route,null));
 }
 assert.throws(()=>financeListPage(page,route,id));
 const title={id,kind:'receivable',due_on:'2026-10-16',status:'partial',overdue:false};
 assert.equal(financeDetailRecord({entity:'titles',data_mode:'erp_native',record:title},'titles',id,'receivable'),title);
 assert.throws(()=>financeDetailRecord({entity:'titles',data_mode:'erp_native',record:{...title,kind:'payable'}},'titles',id,'receivable'));
 assert.throws(()=>financeDetailRecord({entity:'titles',data_mode:'erp_native',record:title},'titles',crypto.randomUUID(),'receivable'));
});
