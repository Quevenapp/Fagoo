import test from 'node:test';import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {stockFixture,mutations,queries,ACTOR,PRODUCT,ignored} from './helpers/stock-reservations-fixtures.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const mount=s=>mountComponent('SalesOrderReservations.tsx',s.props);
const checkbox=(v,which=0)=>v.nodes().filter(n=>n.type==='input'&&n.props.type==='checkbox')[which];
async function prepare(v,action='reserve'){
 await v.click(({reserve:'Reservar produtos',release:'Liberar reserva',consume:'Baixar produtos reservados'})[action]);
 for(const [suffix,value]of [['-day','2026-10-16'],['-reason','Conferência sintética']])await v.change(v.find(n=>n.type==='input'&&n.props.id?.endsWith(suffix)).props.id,value);
 await v.click('Conferir '+({reserve:'reserva',release:'liberação',consume:'baixa'})[action]);
}
async function confirm(v,action='reserve'){const c=checkbox(v);c.props.onChange({target:{checked:true}});await v.flush();await v.click('Confirmar '+({reserve:'reserva',release:'liberação',consume:'baixa'})[action]);}

test('070 choices/date are explicit; preview has exact before/after balances and no mutation',async()=>{
 const s=stockFixture({AccessError}),v=await mount(s);try{assert.equal(s.calls.length,1);assert.equal(s.active,false);await v.click('Reservar produtos');assert.equal(v.find(n=>n.type==='input'&&n.props.type==='date').props.value,'');await v.click('Conferir reserva');assert.equal(s.calls.length,1);await v.click('Cancelar conferência');await prepare(v);assert.match(v.text(),/Saldos na conferência/);assert.match(v.text(),/FísicoReservadoDisponível/);assert.equal(mutations(s).length,0);assert.equal(v.button('Confirmar reserva').disabled,true);assert.equal(s.draft,true);}
 finally{v.unmount();}
});
for(const action of ['reserve','release','consume'])test(`070 ${action}: explicit POST followed by GET; receipt and current remain separated`,async()=>{
 const s=stockFixture({AccessError,active:action!=='reserve'}),v=await mount(s);try{await prepare(v,action);await confirm(v,action);assert.equal(mutations(s).length,1);assert.equal(queries(s).length,1);assert.equal(s.commands.size,1);assert.equal(s.changed.length,1);assert.equal(s.busy,false);assert.equal(s.draft,false);assert.equal(mutations(s)[0].body.command_id,queries(s)[0].path.split('/').at(-1));assert.match(v.text(),/registrad/);}
 finally{v.unmount();}
});
test('070 ignored items require separate confirmation and the exact IDs are captured',async()=>{
 const s=stockFixture({AccessError,ignore:true}),v=await mount(s);try{await prepare(v);checkbox(v,1).props.onChange({target:{checked:true}});await v.flush();assert.equal(v.button('Confirmar reserva').disabled,true);checkbox(v,0).props.onChange({target:{checked:true}});await v.flush();await v.click('Confirmar reserva');assert.deepEqual(mutations(s)[0].body.ignored_item_ids,[ignored().id]);}
 finally{v.unmount();}
});
test('070 ACK lost then GET unavailable/403 preserves UUID and blocks old edits, discard and new POST',async()=>{
 let lookups=0;const s=stockFixture({AccessError,before(c){if(c.path.includes('/comandos/')&&++lookups<=2)throw new AccessError(lookups===1?503:403);},after(c){if(c.method==='POST'&&!c.path.endsWith('preview'))throw new AccessError(503);}}),v=await mount(s);try{
  await prepare(v);const oldBack=v.button('Voltar à conferência').props.onClick,oldConfirm=v.button('Confirmar reserva').props.onClick;await confirm(v);assert.equal(mutations(s).length,1);assert.equal(queries(s).length,0);assert.equal(s.busy,true);assert.doesNotMatch(v.text(),/Nenhuma reserva registrada/);oldBack();oldConfirm();await v.flush();assert.equal(mutations(s).length,1);
  await v.click('Consultar resultado');await v.click('Consultar resultado');assert.equal(s.busy,true);assert.equal(s.draft,true);assert.equal(mutations(s).length,1);assert.match(v.text(),new RegExp(mutations(s)[0].body.command_id));await v.click('Consultar resultado');assert.equal(s.busy,false);assert.equal(mutations(s).length,1);assert.equal(s.changed.length,1);
 }finally{v.unmount();}
});
for(const status of [403,409])test(`070 unknown→GET404→explicit same POST${status} never loses the original intent`,async()=>{
 let posts=0;const s=stockFixture({AccessError,before(c){if(c.method==='POST'&&!c.path.endsWith('preview')){posts++;if(posts===1)throw new AccessError(503);if(posts===2)throw new AccessError(status);}}}),v=await mount(s);try{
  await prepare(v);await confirm(v);await v.click('Consultar resultado');assert.equal(mutations(s).length,1);await v.click('Reenviar a mesma confirmação');assert.equal(s.busy,true);assert.doesNotMatch(v.text(),/faça uma nova conferência|Reservar produtos/);await v.click('Consultar resultado');await v.click('Reenviar a mesma confirmação');assert.equal(s.commands.size,1);assert.equal(queries(s).length,3);assert.ok(mutations(s).every(c=>JSON.stringify(c.body)===JSON.stringify(mutations(s)[0].body)));assert.equal(s.busy,false);
 }finally{v.unmount();}
});
test('070 ACK known with failed GET permits only command reads, including unexpected404',async()=>{
 let n=0;const s=stockFixture({AccessError,before(c){if(c.path.includes('/comandos/')&&++n<=2)throw new AccessError(n===1?503:404);}}),v=await mount(s);try{await prepare(v);await confirm(v);assert.equal(mutations(s).length,1);await v.click('Consultar resultado');assert.doesNotMatch(v.text(),/Reenviar a mesma/);await v.click('Consultar resultado');assert.equal(mutations(s).length,1);assert.equal(s.busy,false);}finally{v.unmount();}
});
test('070 same actor loses READ after remote commit: intent remains hidden/inert and restoration only consults',async()=>{
 const ack=deferred(),s=stockFixture({AccessError,after(c){if(c.method==='POST'&&!c.path.endsWith('preview'))return ack.promise;}}),v=await mount(s);try{await prepare(v);await confirm(v);const stale=v.button('Consultar resultado').props.onClick;s.role='financeiro';await v.updateProps({});ack.resolve([...s.commands.values()][0]);await v.flush();stale();await v.flush();assert.equal(queries(s).length,0);const hidden=v.find(n=>n.type==='section'&&n.props.hidden);assert.equal(hidden.props.inert,true);assert.equal(hidden.props['aria-hidden'],true);assert.equal(s.busy,true);s.role='estoque';await v.updateProps({});assert.equal(queries(s).length,0);await v.click('Consultar resultado');assert.equal(mutations(s).length,1);assert.equal(queries(s).length,1);assert.equal(s.busy,false);}finally{ack.resolve({});v.unmount();}
});
for(const mode of ['actor','logout'])test(`070 ${mode} ignores late receipt and retained handlers`,async()=>{
 const ack=deferred(),s=stockFixture({AccessError,after(c){if(c.method==='POST'&&!c.path.endsWith('preview'))return ack.promise;}}),v=await mount(s);try{await prepare(v);await confirm(v);const stale=v.button('Consultar resultado').props.onClick;s.actor=mode==='actor'?PRODUCT:null;s.phase=mode==='logout'?'signed_out':'ready';await v.updateProps({});ack.resolve([...s.commands.values()][0]);await v.flush();stale();await v.flush();assert.equal(queries(s).length,0);assert.equal(s.changed.length,0);assert.equal(v.text(),'');}finally{ack.resolve({});v.unmount();}
});
test('070 consultation does not infer a zero physical balance; read-only roles have no mutation controls',async()=>{
 for(const role of ['vendas','consulta','fiscal']){const s=stockFixture({AccessError,role}),v=await mount(s);try{assert.equal(v.nodes().some(n=>n.type==='button'&&n.props.children==='Reservar produtos'),false);const select=v.find(n=>n.type==='select');await v.change(select.props.id,PRODUCT);assert.equal(s.calls.length,1);await v.click('Consultar saldo');assert.match(v.text(),/Ausência de saldo não significa estoque zero/);assert.match(v.text(),/FísicoNão conferido/);assert.equal(mutations(s).length,0);}finally{v.unmount();}}
});
test('070 stale preview may be discarded, and siorigin synchronous guard blocks a retained confirmation',async()=>{
 let permit=true;const s=stockFixture({AccessError,before(c){if(c.path.endsWith('/preview'))throw new AccessError(409);}});s.props.canAct=()=>permit;const v=await mount(s);try{await prepare(v);assert.match(v.text(),/versão salva mudou/);await v.click('Cancelar conferência');assert.equal(s.draft,false);}
 finally{v.unmount();}
 const f=stockFixture({AccessError});f.props.canAct=()=>permit;const w=await mount(f);try{await prepare(w);checkbox(w).props.onChange({target:{checked:true}});await w.flush();const old=w.button('Confirmar reserva').props.onClick;permit=false;old();await w.flush();assert.equal(mutations(f).length,0);}finally{w.unmount();}
});

for(const action of ['reserve','release','consume'])test(`070 ${action}: a parent version refresh cannot leave the old history after clearing intent`,async()=>{
 const s=stockFixture({AccessError,active:action!=='reserve'});let v,updated;s.props.onChanged=async version=>{s.changed.push(version);updated=v.updateProps({record:structuredClone(s.doc)});await updated;};v=await mount(s);
 try{await prepare(v,action);await confirm(v,action);await updated;await v.flush();assert.equal(mutations(s).length,1);assert.equal(queries(s).length,1);assert.equal(s.calls.filter(c=>c.path.includes('/pedidos/')&&!c.method?.includes('POST')).length,2);assert.doesNotMatch(v.text(),/Nenhuma reserva registrada|Consulte o resultado para atualizar o histórico/);assert.match(v.text(),({reserve:/Ativa/,release:/Liberada/,consume:/Baixada no estoque/})[action]);assert.equal(s.busy,false);}
 finally{v.unmount();}
});
for(const status of ['draft','partially_fulfilled','fulfilled','cancelled'])test(`070 ${status} never offers a new reservation even if the stock summary is eligible`,async()=>{
 const s=stockFixture({AccessError,after(c,_,raw){if(!c.method){raw.current.document.status=status;raw.current.document.eligible=true;}return raw;}}),v=await mount(s);
 try{assert.equal(v.nodes().some(n=>n.type==='button'&&n.props.children==='Reservar produtos'),false);assert.equal(mutations(s).length,0);}finally{v.unmount();}
});
test('070 an active partially fulfilled order still offers release and consume',async()=>{
 const s=stockFixture({AccessError,active:true,after(c,_,raw){if(!c.method){raw.current.document.status='partially_fulfilled';raw.current.document.eligible=true;}return raw;}}),v=await mount(s);
 try{assert.equal(v.button('Liberar reserva').disabled,false);assert.equal(v.button('Baixar produtos reservados').disabled,false);assert.equal(v.button('Página anterior').disabled,true);assert.equal(v.button('Próxima página').disabled,true);}finally{v.unmount();}
});

for(const status of ['verified','in_progress'])test(`070 ${status} with active stock posting never offers a new reservation despite eligible018`,async()=>{
 const s=stockFixture({AccessError});s.doc.status=status;s.doc.effect_flags.stock_active=true;const v=await mount(s);try{assert.equal(v.nodes().some(n=>n.type==='button'&&n.props.children==='Reservar produtos'),false);assert.equal(mutations(s).length,0);assert.match(v.text(),/sem lançamento de estoque ativo/);}finally{v.unmount();}
});
