import assert from 'node:assert/strict';
import test from 'node:test';
import {dueAddDays,duePeriod,duePeriodFromParams,duePeriodParams,dueReport,dueReportCsv,dueCount} from '../src/lib/due-date-report-model.ts';
import {dueReportResponse} from '../../../workers/erp-api/src/due-report.mjs';
import {dueFixture} from './fixtures/due-report-fixture.mjs';
test('due report periods include both endpoints, leap days, and reject invalid or duplicated parameters',()=>{
 assert.equal(dueAddDays('2024-02-28',1),'2024-02-29');assert.equal(dueAddDays('2024-02-28',2),'2024-03-01');
 assert.deepEqual(duePeriod('2024-01-01','2024-12-31'),{from:'2024-01-01',to:'2024-12-31'});
 for(const [from,to]of[['2024-01-01','2025-01-01'],['2023-02-29','2023-03-01'],['2026-02-30','2026-03-01'],['2026-10-17','2026-10-16']])assert.throws(()=>duePeriod(from,to));
 const period=duePeriod('2026-10-16','2026-11-14');assert.deepEqual(duePeriodFromParams(duePeriodParams(period)),period);assert.equal(duePeriodFromParams(new URLSearchParams()),null);
 for(const query of ['from=2026-10-16','from=2026-10-16&to=2026-10-16&to=2026-10-17','unknown=1'])assert.throws(()=>duePeriodFromParams(new URLSearchParams(query)));
});
test('due report validates default server São Paulo period rather than UTC or browser date',()=>{
 const raw=dueFixture('2026-10-16','2026-11-14');const value=dueReport(raw);
 assert.equal(value.business_date,'2026-10-16');assert.equal(value.as_of.slice(0,10),'2026-10-17');assert.equal(value.day_count,30);
 const wrong=structuredClone(raw);wrong.business_date='2026-10-17';assert.throws(()=>dueReport(wrong));
});
test('complete periods and exact sums above Number precision are independently validated in browser and Worker',()=>{
 const raw=dueFixture('2026-10-16','2026-10-17'),period={from:raw.from,to:raw.to};
 raw.days[0].receivable_count='10000';raw.days[0].receivable_cents='9999999999999990000';raw.days[0].difference_cents='9999999999999989799';
 raw.totals={...raw.days[0]};delete raw.totals.day;
 const value=dueReport(raw,period);assert.equal(value.totals.receivable_cents,'9999999999999990000');assert.equal(dueCount('1234567890123456789'),'1.234.567.890.123.456.789');
 assert.deepEqual(dueReportResponse(raw,{p_from:period.from,p_to:period.to}),value);
 for(const mutate of [v=>v.days.reverse(),v=>v.days.pop(),v=>v.days[0].receivable_cents=100,v=>v.days[0].receivable_count='0',v=>v.days[0].difference_cents='-0',v=>v.totals.payable_count='2',v=>v.basis='cash',v=>v.as_of='2026-10-17T24:00:00Z',v=>v.business_date='2026-10-17']){
  const bad=structuredClone(raw);mutate(bad);assert.throws(()=>dueReport(bad,period));assert.throws(()=>dueReportResponse(bad,{p_from:period.from,p_to:period.to}));
 }
});
test('CSV contains the full period and exact aggregate decimals only, neutralizes negative formula prefixes, rejects untrusted fields',()=>{
 const raw=dueFixture('2026-10-16','2026-10-18');raw.customer='=SECRET()';raw.days[0].customer='Some private person';
 const value=dueReport(raw,{from:raw.from,to:raw.to}),csv=dueReportCsv(value);
 assert.equal(value.customer,undefined);assert.equal(value.days[0].customer,undefined);assert.doesNotMatch(csv,/SECRET|private|uuid|actor/i);
 assert.match(csv,/"2026-10-16";"1";"1,01";"1";"2,01";"'-1,00"/);assert.match(csv,/"2026-10-18";"0";"0,00"/);
 assert.match(csv,/"TOTAL DO PERÍODO";"1";"1,01";"1";"2,01";"'-1,00"/);
 assert.equal(csv.split('\r\n').length,6);const bad=structuredClone(raw);bad.days[0].receivable_cents='=1+1';assert.throws(()=>dueReportCsv(bad));
});
