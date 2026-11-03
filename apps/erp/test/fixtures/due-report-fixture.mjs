export function dueFixture(from='2026-10-16',to=from,{receivable='101',payable='201'}={}) {
  const days=[]; for(let time=Date.parse(`${from}T00:00:00Z`);time<=Date.parse(`${to}T00:00:00Z`);time+=86400000) {
    const day=new Date(time).toISOString().slice(0,10),first=!days.length;
    days.push({day,receivable_count:first&&receivable!=='0'?'1':'0',receivable_cents:first?receivable:'0',payable_count:first&&payable!=='0'?'1':'0',payable_cents:first?payable:'0',difference_cents:first?(BigInt(receivable)-BigInt(payable)).toString():'0'});
  }
  const totals={...days[0]};delete totals.day;
  return{scope:'due_report',data_mode:'erp_native',basis:'outstanding_principal',role:'consulta',timezone:'America/Sao_Paulo',business_date:'2026-10-16',as_of:'2026-10-17T01:30:00.123456Z',from,to,day_count:days.length,days,totals};
}
