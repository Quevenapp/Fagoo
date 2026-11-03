import test from 'node:test';import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {createStockObservationsFixture,stockQaRow,stockQaRows,stockQaWarehouse,stockQaFlags} from '../src/qa/stock-observations-fixture.ts';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const mount=(f,warehouseSourceId='007')=>mountComponent('OriginStockObservations.tsx',{controller:f.controller,warehouseSourceId},{expandChildren:true});
const detailCall=c=>new URL(c.path,'https://synthetic.invalid').pathname!=='/v1/estoque-origin-observado';
test('087 loads one page without fan-out; explicit product GET separates depot quantities from general totals',async()=>{
 const f=createStockObservationsFixture(),v=await mount(f);try{
  assert.equal(f.calls.length,1);assert.match(v.text(),/12,125/);assert.match(v.text(),/Estoque ainda não observado/);assert.match(v.text(),/Sem valor declarado/);assert.equal(v.nodes().some(n=>n.type==='button'&&/Importar|Reservar|Salvar/.test(n.props.children)),false);
  await v.click('Conferir produto 001');assert.equal(f.calls.length,2);assert.equal(f.calls[1].method,'GET');assert.match(v.text(),/12,125/);assert.match(v.text(),/25,125/);
  const totals=v.nodes().find(n=>n.type==='details'&&JSON.stringify(n.props.children).includes('Totais gerais'));assert.ok(totals);assert.ok(!totals.props.open);assert.match(v.text(),/não compara unidades/);
 }finally{v.unmount();}
});
test('087 absent/invalid quantities never render as zero; positive zero remains explicit',async()=>{
 const f=createStockObservationsFixture(),v=await mount(f);try{
  await v.click('Conferir produto 002');const amounts=()=>v.nodes().filter(n=>n.type==='dd').map(n=>n.props.children);assert.ok(amounts().includes('0'));assert.ok(amounts().includes('-0,125'));
  await v.click('Voltar à lista');await v.click('Conferir produto 003');assert.ok(!amounts().includes('0'));assert.match(v.text(),/Estoque ainda não observado/);
  await v.click('Voltar à lista');await v.click('Conferir produto 004');assert.ok(amounts().includes('Valor não conferido'));assert.ok(amounts().includes('Sem valor declarado'));assert.ok(!amounts().includes('0'));
 }finally{v.unmount();}
});
test('087 warehouse current inactive/missing remains readable and is not promoted to the captured origin',async()=>{
 const warehouse={...stockQaWarehouse(),source:null,source_state:'missing',record_state:'changed',record:{name:'Nome atual alterado',active:false,human_edited:true,version:2}},f=createStockObservationsFixture({warehouse}),v=await mount(f);try{assert.equal(f.calls.length,1);assert.match(v.text(),/Nome atual alterado/);assert.match(v.text(),/Cadastro inativo/);assert.match(v.text(),/vínculo anterior permanece/);await v.click('Conferir produto 001');assert.equal(f.calls.length,2);}finally{v.unmount();}
});
test('087 pagination and search are explicit bounded GETs and retire old row callbacks',async()=>{
 const rows=Array.from({length:26},(_,i)=>stockQaRow(String(i+1).padStart(3,'0'))),f=createStockObservationsFixture({rows}),v=await mount(f);try{
  const stale=v.button('Conferir produto 001').props.onClick;await v.click('Próxima página');assert.equal(new URL(f.calls[1].path,'https://synthetic.invalid').searchParams.get('after'),'025');assert.match(v.text(),/Produto demonstrativo 026/);stale();await v.flush();assert.equal(f.calls.length,2);
  await v.change('stock-observed-query','QA-002');await v.submit();assert.equal(f.calls.length,3);assert.equal(new URL(f.calls[2].path,'https://synthetic.invalid').searchParams.has('after'),false);assert.match(v.text(),/1 produto\(s\)/);assert.match(v.text(),/QA-002/);assert.equal(v.button('Página anterior').disabled,true);
 }finally{v.unmount();}
});
for(const mode of['role','actor','logout','phase','warehouse','controller'])test(`087 ${mode} change aborts an in-flight detail and old callbacks cannot disclose or request again`,async()=>{
 const hold=deferred(),f=createStockObservationsFixture({before:c=>detailCall(c)?hold.promise:undefined}),v=await mount(f);try{
  const old=v.button('Conferir produto 001').props.onClick;await v.click('Conferir produto 001');const call=f.calls[1],back=v.button('Voltar à lista').props.onClick;
  if(mode==='role')f.setAccess({role:'consulta'});if(mode==='actor')f.setAccess({actor:'87000000-0000-4000-8000-000000000002'});if(mode==='logout')f.setAccess({actor:null,phase:'signed_out'});if(mode==='phase')f.setAccess({phase:'checking'});
  if(mode==='warehouse')await v.updateProps({warehouseSourceId:'008'});if(mode==='controller')await v.updateProps({controller:createStockObservationsFixture().controller});await v.flush();
  assert.equal(call.signal.aborted,true);const n=f.calls.length;old();back();hold.resolve({...stockQaFlags(),warehouse:stockQaWarehouse(),item:{...stockQaRow(),product:{...stockQaRow().product,source_name:{state:'value',value:'Resposta antiga sigilosa'}}}});await v.flush();assert.equal(f.calls.length,n);assert.doesNotMatch(v.text(),/Resposta antiga sigilosa/);
  if(['role','logout','phase'].includes(mode))assert.doesNotMatch(v.text(),/Produto demonstrativo|Geral demonstrativo/);
 }finally{hold.resolve(null);v.unmount();}
});
test('087 role restoration starts a new read; no cached data or old selection is reused',async()=>{
 const f=createStockObservationsFixture(),v=await mount(f);try{await v.click('Conferir produto 001');const stale=v.button('Atualizar produto').props.onClick;f.setAccess({role:'consulta'});await v.flush();f.setAccess({role:'admin'});await v.flush();assert.equal(f.calls.length,3);stale();await v.flush();assert.equal(f.calls.length,3);assert.equal(v.nodes().some(n=>n.props['aria-label']==='Estoque observado do produto'),false);}finally{v.unmount();}
});
test('087 back cancels detail; retired detail controls cannot close or refresh a new selection',async()=>{
 const f=createStockObservationsFixture(),v=await mount(f);try{await v.click('Conferir produto 001');const oldBack=v.button('Voltar à lista').props.onClick,oldRefresh=v.button('Atualizar produto').props.onClick;await v.click('Voltar à lista');await v.click('Conferir produto 002');const n=f.calls.length;oldBack();oldRefresh();await v.flush();assert.equal(f.calls.length,n);assert.match(v.text(),/Produto demonstrativo 002/);assert.equal(v.nodes().filter(n=>n.props['aria-label']==='Estoque observado do produto').length,1);}finally{v.unmount();}
});
test('087 detail gets a fresh observation explicitly, without claiming the previous snapshot is unchanged',async()=>{
 let reads=0;const f=createStockObservationsFixture({after(c,r){if(detailCall(c)){reads++;return{...r,observed_at:'2026-10-17T12:10:00Z',item:{...r.item,observation:{...r.item.observation,source:{...r.item.observation.source,source_version:String(reads+1),source_hash:'b'.repeat(64)},warehouse:{...r.item.observation.warehouse,physical:{state:'value',value:'99.000001'}}}}};}return r;}}),v=await mount(f);try{await v.click('Conferir produto 001');assert.match(v.text(),/99,000001/);assert.match(v.text(),/atualizada desde a lista/);await v.click('Atualizar produto');assert.equal(reads,2);assert.equal(f.calls.length,3);}finally{v.unmount();}
});
test('087 wrong depot/product or effects in a response are rejected before display',async()=>{
 for(const mutation of[r=>({...r,warehouse:{...r.warehouse,source_id:'7'}}),r=>({...r,item:{...r.item,product_source_id:'1'}}),r=>({...r,native_effects:true})]){
  const f=createStockObservationsFixture({after(c,r){return detailCall(c)?mutation(r):r;}}),v=await mount(f);try{await v.click('Conferir produto 001');assert.match(v.text(),/Não foi possível concluir/);assert.equal(v.nodes().filter(n=>n.props['aria-label']==='Estoque observado do produto').length,0);assert.equal(f.calls.length,2);}finally{v.unmount();}
 }
});
test('087 404 and503 remain failed reads, never synthetic zero or follow-up writes',async()=>{
 for(const status of[404,503]){const f=createStockObservationsFixture({before(){throw new AccessError(status);}}),v=await mount(f);try{assert.equal(f.calls.length,1);assert.match(v.text(),status===404?/não significa estoque zero/:/Não foi possível concluir/);assert.equal(v.nodes().filter(n=>n.type==='td').length,0);await v.click('Atualizar lista');assert.equal(f.calls.length,2);assert.ok(f.calls.every(c=>c.method==='GET'));}finally{v.unmount();}}
});
test('087 initial invalid warehouse or non-admin/phase cannot read',async()=>{
 for(const params of[{role:'estoque'},{role:'fiscal'},{role:'consulta'},{phase:'checking'},{phase:'error'},{phase:'signed_out'}]){const f=createStockObservationsFixture();f.setAccess(params);const v=await mount(f);try{assert.equal(f.calls.length,0);}finally{v.unmount();}}
 for(const id of['','0','all','7/8']){const f=createStockObservationsFixture(),v=await mount(f,id);try{assert.equal(f.calls.length,0);}finally{v.unmount();}}
});
