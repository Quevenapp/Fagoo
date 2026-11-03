import test from 'node:test';import assert from 'node:assert/strict';
import{financialCutoverCents,financialCutoverDate,financialCutoverDetail,financialCutoverDetailPath,financialCutoverFilters,financialCutoverMoneyText,financialCutoverPage,financialCutoverPath,financialIssueLabels}from'../src/lib/financial-cutover-model.ts';
import{financialFilters,financialRow,financialPage,financialDetail,financialMoney}from'./fixtures/financial-cutover.mjs';
const rejects=fn=>assert.throws(fn,/financial_cutover_invalid_response/);
test('038 exact cents preserve big values and never convert unavailable balances into zero',()=>{
 const r=financialRow();r.amount=financialMoney('99999999999999.99');r.balance={state:'missing',value:null,cents:null};r.issues=[{code:'BALANCE_UNAVAILABLE',level:'blocker'},{code:'AMOUNT_EXCEEDS_NATIVE_LIMIT',level:'blocker'}];
 const page=financialCutoverPage(financialPage([r]),financialFilters);assert.equal(page.page_totals.amount_cents,'9999999999999999');assert.equal(page.page_totals.balance_unavailable_count,1);assert.equal(financialCutoverCents(page.page_totals.amount_cents),'R$ 99.999.999.999.999,99');assert.equal(financialCutoverMoneyText(r.balance),'Não informado');
 for(const state of['null','invalid_type','invalid_value','out_of_range'])assert.notEqual(financialCutoverMoneyText({state,value:null,cents:null}),'R$ 0,00');
 for(const money of[{state:'available',value:'0.01',cents:'0'},{state:'available',value:'1.001',cents:'100'},{state:'missing',value:'0.00',cents:'0'},{state:'available',value:'-1.00',cents:'-100'},{state:'available',value:'1e3',cents:'100000'}]){const row=financialRow();row.balance=money;rejects(()=>financialCutoverPage(financialPage([row]),financialFilters));}
});
test('038 flags, totals, counts, identities and strict projections fail closed',()=>{
 for(const flag of['persisted','import_enabled','operational_effects','reconciled','coverage_certified'])rejects(()=>financialCutoverPage({...financialPage(),[flag]:true},financialFilters));
 for(const mutate of[p=>p.raw={private:'forbidden'},p=>p.items[0].cpf='forbidden',p=>p.page_totals.balance_cents='0',p=>p.page_totals.balance_available_count=0,p=>p.items.push(p.items[0]),p=>p.items[0].source_version=2,p=>p.items[0].source_id='x'.repeat(201),p=>p.items[0].contact.record_id='malformed',p=>p.items[0].issues=[{code:'UNKNOWN_ALLOW',level:'info'}],p=>p.items[0].issues=[{code:'BALANCE_UNAVAILABLE',level:'info'}]]){const p=financialPage();mutate(p);rejects(()=>financialCutoverPage(p,financialFilters));}
 assert.equal(financialCutoverPage(financialPage(),financialFilters).items[0].source_id,'0001');
});
test('038 filter response context and pagination are bound, unavailable dates cannot enter a filtered page',()=>{
 for(const f of[{...financialFilters,entity:'payables'},{...financialFilters,status:'all'},{...financialFilters,q:'other'},{...financialFilters,from:'2026-10-01'}])rejects(()=>financialCutoverPage(financialPage(),f));
 const rows=Array.from({length:25},(_,i)=>financialRow(String(i+1).padStart(4,'0')));assert.equal(financialCutoverPage(financialPage(rows,financialFilters,'0025'),financialFilters).next_cursor,'0025');
 rejects(()=>financialCutoverPage(financialPage(rows,financialFilters,'other'),financialFilters));rejects(()=>financialCutoverPage(financialPage([financialRow()],financialFilters,'0001'),financialFilters));
 const row=financialRow(),f={...financialFilters,from:'2026-10-01'};row.due_on=null;rejects(()=>financialCutoverPage(financialPage([row],f),f));
});
test('038 unknown and outside-open statuses remain explicit rather than settled claims',()=>{
 const r=financialRow();r.status={code:null,label:'Não reconhecida',scope:'unknown'};const f={...financialFilters,status:'unknown'};assert.equal(financialCutoverPage(financialPage([r],f),f).items[0].status.scope,'unknown');rejects(()=>financialCutoverPage(financialPage([r]),financialFilters));
 for(const[code,label]of[['2','Pago'],['4','Devolvido'],['5','Cancelado'],['6','Devolvido parcial'],['7','Confirmado']]){const row=financialRow();row.status={code,label,scope:'outside_open_scope'};assert.equal(financialCutoverPage(financialPage([row],{...f,status:'all'}),{...f,status:'all'}).items[0].status.code,code);}
 r.status={code:'7',label:'Confirmado',scope:'open'};rejects(()=>financialCutoverPage(financialPage([r]),financialFilters));
});
test('038 detail binds exact source and refuses fabricated banking/parcel links or private fields',()=>{
 const d=financialDetail();assert.equal(financialCutoverDetail(d,'receivables','0001').record.banking.bank_number,'000123');rejects(()=>financialCutoverDetail(d,'receivables','1'));rejects(()=>financialCutoverDetail(d,'payables','0001'));
 for(const mutate of[d=>d.record.banking.bank_mapping='matched',d=>d.record.installments.group_id='fake',d=>d.record.installments.index=1,d=>d.record.origin.url='https://private.invalid',d=>d.record.banking.bordero_ids=Array(101).fill('1'),d=>d.record.refresh.error_code='message with secret',d=>d.record.refresh.http_status=999,d=>d.record.contact.match='unmatched']){const detail=financialDetail();mutate(detail);rejects(()=>financialCutoverDetail(detail,'receivables','0001'));}
});
test('038 date validation and URL helpers preserve literal IDs and never expose arbitrary origins',()=>{
 assert.equal(financialCutoverDate('2000-02-29'),true);for(const d of['2100-01-01','2026-02-29','2026-13-01','1900-02-29'])assert.equal(financialCutoverDate(d),false);
 assert.throws(()=>financialCutoverFilters({...financialFilters,from:'2026-11-01',to:'2026-10-01'}));assert.throws(()=>financialCutoverFilters({...financialFilters,q:'x'.repeat(101)}));
 const url=new URL(financialCutoverPath({...financialFilters,q:'  00%1_  '},'0001'),'https://synthetic.invalid');assert.equal(url.searchParams.get('q'),'00%1_');assert.equal(url.searchParams.get('after'),'0001');
 assert.equal(financialCutoverDetailPath('receivables','001/02 ?#'),'/v1/conferencia-financeira-origin/receivables/001%2F02%20%3F%23');assert.throws(()=>financialCutoverDetailPath('evil','1'));
 assert.equal(Object.keys(financialIssueLabels).length,30);
});
test('038 presentation bounds count Unicode characters consistently with PostgreSQL and keep required status labels',()=>{
 const r=financialRow();r.contact.name='😀'.repeat(200);assert.equal(financialCutoverPage(financialPage([r]),financialFilters).items[0].contact.name,r.contact.name);r.contact.name+='😀';rejects(()=>financialCutoverPage(financialPage([r]),financialFilters));
 const p=financialPage();p.items[0].status.label='Quitação confirmada';rejects(()=>financialCutoverPage(p,financialFilters));
});
test('038 incomplete refresh history preserves own observed dates without borrowing a different attempt or proving freshness',()=>{
 const d=financialDetail();Object.assign(d.record.refresh,{state:'incomplete',last_finished_at:null,error_code:null,http_status:null,current_source_matches_result:null});d.record.issues.push({code:'REFRESH_EVIDENCE_INCOMPLETE',level:'review'});
 const result=financialCutoverDetail(d,'receivables','0001');assert.equal(result.record.refresh.last_attempt_at,'2026-10-16T14:49:00Z');assert.equal(result.record.refresh.last_success_at,'2026-10-16T14:50:00Z');assert.equal(result.record.balance.value,'123.45');
 for(const change of[{current_source_matches_result:true},{error_code:'FOREIGN_ATTEMPT'},{http_status:404},{last_finished_at:'2026-10-16T14:59:00Z'}]){const invalid=structuredClone(d);Object.assign(invalid.record.refresh,change);rejects(()=>financialCutoverDetail(invalid,'receivables','0001'));}
 const invalid=structuredClone(d);invalid.record.issues=[];rejects(()=>financialCutoverDetail(invalid,'receivables','0001'));
});
