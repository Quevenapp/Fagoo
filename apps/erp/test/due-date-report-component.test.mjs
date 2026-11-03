import assert from 'node:assert/strict';
import test from 'node:test';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { dueFixture } from './fixtures/due-report-fixture.mjs';

function server(before=()=>{}) {
 const calls=[];return {calls,controller:{async dueReport(path,options={}){
  const call={path,...options};calls.push(call);await before(call,calls.length);
  const query=new URL(path,'https://synthetic.invalid').searchParams,from=query.get('from')??'2026-10-16',to=query.get('to')??'2026-11-14';
  assert.equal(options.method,undefined);assert.equal(options.body,undefined);
  return dueFixture(from,to,{receivable:from==='2026-10-17'?'333':'101',payable:'201'});
 }}};
}
const mount=(source,location='/relatorio-vencimentos?from=2026-10-16&to=2026-10-16',extra={})=>mountComponent('DueDateReport.tsx',{controller:source.controller,...extra},{expandChildren:['NativeListLayout'],location});

test('due report keeps applied period explicit, validates before fetch, and restores the period from URL navigation',async()=>{
 const source=server(),view=await mount(source);
 try{
  assert.equal(source.calls.length,1);assert.match(view.text(),/16\/10\/2026 a 16\/10\/2026/);assert.match(view.text(),/R\$ 1,01/);
  await view.change('due-to','2027-10-17');await view.submit();assert.equal(source.calls.length,1);assert.match(view.text(),/até 366 dias/);
  await view.change('due-from','2026-10-17');await view.change('due-to','2026-10-17');await view.submit();
  assert.equal(source.calls.length,2);assert.match(view.location().search,/from=2026-10-17/);assert.match(view.text(),/17\/10\/2026 a 17\/10\/2026/);assert.match(view.text(),/R\$ 3,33/);
  await view.navigate('/relatorio-vencimentos?from=2026-10-16&to=2026-10-16');assert.equal(source.calls.length,3);assert.equal(view.input('due-from').props.value,'2026-10-16');
  assert.match(view.text(),/16\/10\/2026 a 16\/10\/2026/);
 }finally{view.unmount();}
});
test('late old-period response is aborted and cannot replace the newer report or enable stale export',async()=>{
 let release;const source=server((call,index)=>index===1?new Promise(resolve=>{release=resolve;}):undefined),view=await mount(source);
 try{
  assert.equal(view.button('Exportar CSV agregado').disabled,true);
  await view.navigate('/relatorio-vencimentos?from=2026-10-17&to=2026-10-17');assert.equal(source.calls[0].signal.aborted,true);
  assert.match(view.text(),/R\$ 3,33/);release();await view.flush();assert.match(view.text(),/17\/10\/2026 a 17\/10\/2026/);assert.doesNotMatch(view.text(),/R\$ 1,01/);
  assert.equal(view.button('Exportar CSV agregado').disabled,false);
 }finally{view.unmount();}
});
test('failed refresh hides prior totals and export until a fresh valid response; only read requests are sent',async()=>{
 const source=server((call,index)=>{if(index===2)throw new AccessError(503);}),view=await mount(source);
 try{
  await view.click('Atualizar consulta');assert.equal(view.button('Exportar CSV agregado').disabled,true);assert.doesNotMatch(view.text(),/R\$ 1,01/);assert.match(view.text(),/Não foi possível conferir/);
  await view.click('Tentar novamente');assert.equal(source.calls.length,3);assert.equal(view.button('Exportar CSV agregado').disabled,false);assert.match(view.text(),/R\$ 1,01/);
 }finally{view.unmount();}
});
test('default dates are populated from server period without overwriting a filter typed while loading',async()=>{
 const standard=server(),normal=await mount(standard,'/relatorio-vencimentos');
 try{assert.equal(normal.input('due-from').props.value,'2026-10-16');assert.equal(normal.input('due-to').props.value,'2026-11-14');assert.match(normal.text(),/30 dia\(s\)/);}finally{normal.unmount();}
 let release;const source=server(()=>new Promise(resolve=>{release=resolve;})),view=await mount(source,'/relatorio-vencimentos');
 try{await view.change('due-from','2026-11-01');release();await view.flush();assert.equal(view.input('due-from').props.value,'2026-11-01');assert.match(view.text(),/16\/10\/2026 a 14\/11\/2026/);}
 finally{view.unmount();}
});
test('invalid URL never requests data, and unmount aborts a pending read without follow-up actions',async()=>{
 const source=server(),invalid=await mount(source,'/relatorio-vencimentos?from=broken&to=2026-10-16');
 try{assert.equal(source.calls.length,0);assert.equal(invalid.button('Exportar CSV agregado').disabled,true);await invalid.click('Limpar período');assert.equal(source.calls.length,1);}finally{invalid.unmount();}
 let release;const pending=server(()=>new Promise(resolve=>{release=resolve;})),view=await mount(pending);
 view.unmount();assert.equal(pending.calls[0].signal.aborted,true);release();await new Promise(resolve=>setTimeout(resolve,5));assert.equal(pending.calls.length,1);
});
test('optional drilldown receives the exact applied kind/date range, without assuming unsupported finance URL filters',async()=>{
 const source=server(),opened=[],view=await mount(source,'/relatorio-vencimentos?from=2026-10-16&to=2026-10-18',{onOpenTitles:value=>opened.push(value)});
 try{
  await view.click('Ver todos os títulos a receber');assert.deepEqual(opened[0],{from:'2026-10-16',to:'2026-10-18',kind:'receivable'});
  const day=view.find(node=>node.props['aria-label']==='Ver todos os títulos a pagar de 16/10/2026');day.props.onClick();await view.flush();assert.deepEqual(opened[1],{from:'2026-10-16',to:'2026-10-16',kind:'payable'});
  const hide=view.find(node=>node.type==='input'&&node.props.type==='checkbox');hide.props.onChange({target:{checked:true}});await view.flush();assert.match(view.text(),/1 dia\(s\) exibido\(s\) de 3/);assert.equal(source.calls.length,1);
  assert.match(view.text(),/R\$ 1,01/);assert.match(view.text(),/R\$ 2,01/);
 }finally{view.unmount();}
});
test('30-day shortcut resets an unapplied date draft even when the current URL already uses the default period',async()=>{
 const source=server(),view=await mount(source,'/relatorio-vencimentos');
 try{await view.change('due-from','2026-12-01');await view.change('due-to','2026-12-31');await view.click('Próximos 30 dias');
  assert.equal(view.input('due-from').props.value,'2026-10-16');assert.equal(view.input('due-to').props.value,'2026-11-14');assert.equal(source.calls.length,2);
 }finally{view.unmount();}
});
