import test from 'node:test';
import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';

const hash='a'.repeat(64),previewHash='b'.repeat(64),clone=value=>structuredClone(value);
const source=(id,name=`Origem sintética ${id}`)=>({source_id:id,source_hash:hash,source_version:'1',last_seen_at:'2026-10-16T12:00:00Z',name,code:id,source_status:'A',record_id:null,record_version:null,local_name:null,human_edited:false,stock_locked:false,origin_state:null,candidate_retained:false,action:'create',operation_action:'create',error:null});
function importServer({before=()=>{},after=()=>{},rows=Array.from({length:28},(_,i)=>source(String(i+1).padStart(4,'0')))}={}){
 const calls=[],commands=new Map(),state={rows,counts:{list:0,preview:0,apply:0}};
 const controller={async catalogImport(path,options={}){
  const url=new URL(path,'https://example.invalid'),entity=url.pathname.split('/')[3],operation=options.method==='POST'?url.pathname.split('/').at(-1):'list';
  const call={path,entity,operation,...options};calls.push(call);state.counts[operation]++;await before(call,state);
  const base={entity,data_mode:'erp_native',operational_effects:false};let value;
  if(operation==='list'){
   const limit=Number(url.searchParams.get('limit')),cursor=url.searchParams.get('after'),q=url.searchParams.get('q');
   const visible=state.rows.filter(row=>(!cursor||row.source_id>cursor)&&(!q||row.name.toLowerCase().includes(q.toLowerCase()))),items=visible.slice(0,limit);
   value={...base,items:clone(items),source:'origin_staging',limit,has_more:visible.length>limit,next_cursor:visible.length>limit?items.at(-1).source_id:null};
  }else if(operation==='preview')value={...base,items:options.body.items.map(item=>({...clone(state.rows.find(row=>row.source_id===item.source_id)),changes:[]})),preview_hash:previewHash,dry_run:true};
  else if(operation==='apply'){
   const previous=commands.get(options.body.command_id);
   if(previous){assert.deepEqual(previous.body,options.body);value={...clone(previous.value),replayed:true};}
   else{
    value={...base,items:options.body.items.map(item=>({...item,source_version:'1',record_id:crypto.randomUUID(),action:'create',error:null})),preview_hash:options.body.preview_hash,dry_run:false,replayed:false};
    commands.set(options.body.command_id,{body:clone(options.body),value:clone(value)});
    for(const item of options.body.items){const row=state.rows.find(row=>row.source_id===item.source_id);row.action='unchanged';row.operation_action='unchanged';}
   }
  }else throw new Error('Unexpected operation');
  await after(call,state);return clone(value);
 }};return{controller,state,calls,commands};
}
const mount=server=>mountComponent('RealImportCatalog.tsx',{controller:server.controller});
async function select(view,id='0001'){
 const node=view.find(n=>n.type==='input'&&n.props['aria-label']===`Selecionar Origem sintética ${id}`);assert.equal(node.disabled,false);node.props.onChange({target:{checked:true}});await view.flush();
}
async function preview(view){await select(view);await view.click('Simular e conferir');}

test('uncertain import freezes the reviewed batch and reuses exact entity, hashes, IDs and command',async()=>{
 const server=importServer({after(call,state){if(call.operation==='apply'&&state.counts.apply===1)throw new AccessError(503);}}),view=await mount(server);
 try{
  await preview(view);await view.click('Aplicar lote revisado (1)');
  assert.equal(view.guard().busy,true);assert.equal(view.button('Voltar à seleção').disabled,true);assert.equal(view.button('Atualizar lista').disabled,true);assert.equal(view.button('Aplicar lote revisado (1)').disabled,true);
  // Even a dispatched stale/disabled handler cannot release this uncertain batch.
  view.button('Voltar à seleção').props.onClick();view.button('Atualizar lista').props.onClick();await view.flush();assert.match(view.text(),/Confirmar o mesmo lote/);
  server.state.rows[0].name='Cadastro atual sintético';server.state.rows[0].human_edited=true;server.state.rows[0].action='pending_human_review';server.state.rows[0].candidate_retained=true;
  await view.click('Confirmar o mesmo lote');const writes=server.calls.filter(c=>c.operation==='apply');
  assert.equal(writes.length,2);assert.deepEqual(writes[0].body,writes[1].body);assert.equal(server.commands.size,1);assert.equal(view.guard().busy,false);
  assert.match(view.text(),/resultado original do comando/);assert.match(view.text(),/Cadastro atual sintético/);assert.match(view.text(),/Lote confirmado novamente/);
  assert.equal(view.find(n=>n.type==='test-router-link').props.to,'/cadastros-reais?cadastro=contacts');
 }finally{view.unmount();}
});
test('known application and failed readback retries only the current list and keeps its search/cursor',async()=>{
 const server=importServer({before(call,state){if(call.operation==='list'&&state.counts.list===3)throw new AccessError(503);}}),view=await mount(server);
 try{
  await view.click('Próxima');await select(view,'0026');await view.click('Simular e conferir');await view.click('Aplicar lote revisado (1)');
  assert.equal(view.guard().busy,true);assert.match(view.text(),/Consultar lista atual/);assert.doesNotMatch(view.text(),/Lote processado/);
  await view.click('Consultar lista atual');assert.equal(server.state.counts.apply,1);assert.equal(server.state.counts.list,4);assert.equal(view.guard().busy,false);
  const reads=server.calls.filter(c=>c.operation==='list');assert.equal(new URL(reads.at(-1).path,'https://example.invalid').searchParams.get('after'),'0025');assert.match(view.text(),/Página 2/);
 }finally{view.unmount();}
});
test('an explicit conflict releases an uncommitted batch, while a conflict after uncertainty does not',async()=>{
 const rejected=importServer({before(call){if(call.operation==='apply')throw new AccessError(409);}}),a=await mount(rejected);
 try{await preview(a);await a.click('Aplicar lote revisado (1)');assert.equal(a.guard().busy,false);assert.equal(a.button('Atualizar lista').disabled,false);assert.equal(rejected.commands.size,0);}finally{a.unmount();}
 const server=importServer({before(call,state){if(call.operation==='apply'&&state.counts.apply===2)throw new AccessError(409);},after(call,state){if(call.operation==='apply'&&state.counts.apply===1)throw new AccessError(503);}}),view=await mount(server);
 try{await preview(view);await view.click('Aplicar lote revisado (1)');await view.click('Confirmar o mesmo lote');assert.equal(view.guard().busy,true);assert.equal(view.button('Voltar à seleção').disabled,true);
  await view.click('Confirmar o mesmo lote');const writes=server.calls.filter(c=>c.operation==='apply');assert.equal(writes.length,3);assert.deepEqual(writes[0].body,writes[2].body);assert.equal(server.commands.size,1);
 }finally{view.unmount();}
});
test('changing pages clears only the visible selection and never adds IDs from a previous page',async()=>{
 const server=importServer(),view=await mount(server);
 try{await select(view);assert.equal(view.guard().changed,true);await view.click('Próxima');assert.equal(view.guard().changed,false);assert.match(view.text(),/0 selecionado/);
  await select(view,'0026');await view.click('Simular e conferir');assert.deepEqual(server.calls.find(c=>c.operation==='preview').body.items,[{source_id:'0026',source_hash:hash}]);
  await view.click('Voltar à seleção');await view.click('Anterior');assert.equal(view.guard().changed,false);assert.match(view.text(),/Página 1/);
 }finally{view.unmount();}
});
test('a late list from an old entity cannot replace the current selection or preview',async()=>{
 let release;const server=importServer({before(call,state){if(call.operation==='list'&&state.counts.list===1)return new Promise(resolve=>{release=resolve;});}}),view=await mount(server);
 try{await view.change('import-entity','products');assert.equal(view.input('import-entity').props.value,'products');release();await view.flush();
  await preview(view);assert.equal(server.calls.find(c=>c.operation==='preview').entity,'products');
 }finally{view.unmount();}
});
test('leaving during application aborts the pending request and never starts readback from a late response',async()=>{
 let release,signal;const server=importServer({before(call){if(call.operation==='apply'){signal=call.signal;return new Promise(resolve=>{release=resolve;});}}}),view=await mount(server);
 await preview(view);await view.click('Aplicar lote revisado (1)');assert.equal(view.guard().busy,true);const reads=server.state.counts.list;
 view.unmount();assert.equal(signal.aborted,true);release();await new Promise(resolve=>setTimeout(resolve,5));assert.equal(server.state.counts.list,reads);
});
test('leaving during a read-only preview aborts it without sending any import command',async()=>{
 let release,signal;const server=importServer({before(call){if(call.operation==='preview'){signal=call.signal;return new Promise(resolve=>{release=resolve;});}}}),view=await mount(server);
 await select(view);await view.click('Simular e conferir');assert.equal(view.guard().busy,true);view.unmount();assert.equal(signal.aborted,true);release();await new Promise(resolve=>setTimeout(resolve,5));assert.equal(server.state.counts.apply,0);
});
