import test from'node:test';import assert from'node:assert/strict';
import{mountComponent}from'./helpers/component-recovery-harness.mjs';
import{financialFilters,financialRow,financialPage,financialDetail}from'./fixtures/financial-cutover.mjs';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const filtersOf=path=>{const p=new URL(path,'https://synthetic.invalid').searchParams;return{entity:p.get('entity'),status:p.get('status'),q:p.get('q')||'',from:p.get('from')||'',to:p.get('to')||''};};
test('038 list cancels stale responses, binds applied filters and sends only GET',async()=>{
 const old=deferred(),calls=[];const controller={async financialCutover(path,options){calls.push({path,options});if(calls.length===1)return old.promise;const f=filtersOf(path);return financialPage([financialRow('PAY-2',f.entity)],f);}};
 const ui=await mountComponent('FinancialCutoverReview.tsx',{controller},{expandChildren:true});
 try{await ui.change('financial-cutover-entity','payables');await ui.submit();assert.equal(calls[0].options.signal.aborted,true);assert.match(ui.text(),/PAY-2/);old.resolve(financialPage([financialRow('STALE')]));await ui.flush();assert.doesNotMatch(ui.text(),/STALE/);assert.equal(calls.every(c=>c.options.method==='GET'&&!Object.hasOwn(c.options,'body')),true);assert.equal(calls.length,2);}finally{ui.unmount();}assert.equal(calls.at(-1).options.signal.aborted,true);
});
test('038 pagination uses an exact cursor and resets on filter apply/clear',async()=>{
 const calls=[];const controller={async financialCutover(path,options){calls.push({path,options});const u=new URL(path,'https://synthetic.invalid'),f=filtersOf(path);if(u.searchParams.has('after')||f.q)return financialPage([financialRow('LAST',f.entity)],f);const rows=Array.from({length:25},(_,i)=>financialRow(String(i+1).padStart(4,'0'),f.entity));return financialPage(rows,f,'0025');}};
 const ui=await mountComponent('FinancialCutoverReview.tsx',{controller},{expandChildren:true});
 try{await ui.click('Próxima página');assert.equal(new URL(calls.at(-1).path,'https://synthetic.invalid').searchParams.get('after'),'0025');assert.match(ui.text(),/Página 2/);await ui.change('financial-cutover-query','00%');await ui.submit();assert.equal(new URL(calls.at(-1).path,'https://synthetic.invalid').searchParams.has('after'),false);assert.match(ui.text(),/Página 1/);await ui.click('Limpar filtros');assert.equal(ui.input('financial-cutover-query').props.value,'');assert.equal(new URL(calls.at(-1).path,'https://synthetic.invalid').searchParams.has('q'),false);}finally{ui.unmount();}
});
test('038 detail ignores an old selection, closes/aborts safely and never claims import or settlement',async()=>{
 const first=deferred(),calls=[];const controller={async financialCutover(path,options){calls.push({path,options});if(path.includes('?'))return financialPage([financialRow('0001'),financialRow('0002')]);if(path.endsWith('/0001'))return first.promise;return financialDetail('0002');}};
 const ui=await mountComponent('FinancialCutoverReview.tsx',{controller},{expandChildren:true});
 try{await ui.click('Conferir 0001');await ui.click('Conferir 0002');assert.equal(calls.find(c=>c.path.endsWith('/0001')).options.signal.aborted,true);first.resolve(financialDetail('0001'));await ui.flush();assert.match(ui.text(),/Conferência · 0002/);assert.doesNotMatch(ui.text(),/Conferência · 0001/);assert.match(ui.text(),/não comprovam quitação/);assert.match(ui.text(),/Não importa títulos/);assert.match(ui.text(),/000123/);await ui.click('Fechar conferência');assert.equal(calls.find(c=>c.path.endsWith('/0002')).options.signal.aborted,true);assert.doesNotMatch(ui.text(),/000123/);}finally{ui.unmount();}
});
test('038 list errors hide stale totals and retry validates the entire response before showing values',async()=>{
 let count=0;const controller={async financialCutover(){count++;if(count===2)throw new Error('private response must not be displayed');if(count===3){const page=financialPage();page.page_totals.balance_cents='0';return page;}return financialPage();}};
 const ui=await mountComponent('FinancialCutoverReview.tsx',{controller},{expandChildren:true});
 try{assert.match(ui.text(),/R\$ 123,45/);await ui.click('Atualizar observações');assert.doesNotMatch(ui.text(),/R\$ 123,45|private response|0 título\(s\)/);assert.match(ui.text(),/Consulta indisponível/);await ui.click('Tentar consulta novamente');assert.doesNotMatch(ui.text(),/R\$ 123,45|0 título\(s\)/);await ui.click('Tentar consulta novamente');assert.match(ui.text(),/R\$ 123,45/);}finally{ui.unmount();}
});
test('038 incomplete update evidence stays readable with an explicit pending review and no success claim',async()=>{
 const detail=financialDetail();Object.assign(detail.record.refresh,{state:'incomplete',last_finished_at:null,error_code:null,http_status:null,current_source_matches_result:null});detail.record.issues.push({code:'REFRESH_EVIDENCE_INCOMPLETE',level:'review'});
 const controller={async financialCutover(path){return path.includes('?')?financialPage():detail;}};const ui=await mountComponent('FinancialCutoverReview.tsx',{controller},{expandChildren:true});
 try{await ui.click('Conferir 0001');assert.match(ui.text(),/Histórico de atualização incompleto/);assert.match(ui.text(),/R\$ 123,45/);assert.match(ui.text(),/Não há resultado armazenado comparável/);assert.doesNotMatch(ui.text(),/A tentativa armazenada corresponde/);}finally{ui.unmount();}
});
