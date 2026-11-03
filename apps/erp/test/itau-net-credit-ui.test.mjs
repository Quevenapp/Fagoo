import test from 'node:test';
import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {uid,selection,category,categoryPage,netDetail,netPreview,netAck,netReadback} from './helpers/itau-net-credit-fixtures.mjs';
const clone=x=>structuredClone(x),tick=()=>new Promise(r=>setTimeout(r,10));
function service({role='admin',before=()=>{},after=()=>{},categories=categoryPage(),detail=netDetail()}={}){
 const calls=[],counts={},state={membership:{user_id:uid(1000),role},detail:clone(detail),preview:netPreview(detail),receipts:new Map(),categories};
 const controller={getSnapshot:()=>({phase:'ready',membership:state.membership}),async finance(path,options={}){const call={op:'categories',path,signal:options.signal};calls.push(call);counts.categories=(counts.categories??0)+1;await before(call,state,counts);return clone(typeof state.categories==='function'?state.categories(path):state.categories);},async cnabReturns(path,options={}){const op=path.includes('/settlements/')?'legacy':'detail',call={op,path,signal:options.signal};calls.push(call);counts[op]=(counts[op]??0)+1;await before(call,state,counts);if(op==='legacy')throw new AccessError(404);return clone(state.detail);},async itauNetCredit(path,options={}){
  const op=path.endsWith('/preview')?'preview':path.endsWith('/settle')?'settle':'command',call={op,path,body:clone(options.body),signal:options.signal};calls.push(call);counts[op]=(counts[op]??0)+1;await before(call,state,counts);let value;
  if(op==='preview')value=clone(state.preview);
  else if(op==='settle'){const ack=netAck(options.body,state.preview),exists=state.receipts.has(options.body.command_id);value={...ack,replayed:exists};if(!exists)state.receipts.set(options.body.command_id,netReadback(ack.receipt));}
  else{value=state.receipts.get(path.split('/').at(-1));if(!value)throw new AccessError(404);}
  await after(call,state,counts);return clone(value);
 }};return{calls,counts,state,controller};
}
async function mount(s,{parent=false}={}){const flags={busy:[],draft:[],closed:0},props={controller:s.controller,selection:clone(selection),context:clone(s.state.detail.context),onDraft:x=>flags.draft.push(x),onBusy:x=>flags.busy.push(x)};const view=await mountComponent(parent?'RealCnabOperationalReturns.tsx':'ItauNetCredit.tsx',parent?{controller:s.controller,selection:clone(selection),writeAllowed:true,onClose:()=>flags.closed++}:props,{expandChildren:true,...(parent?{componentName:'ReturnEventEditor'}:{})});return{view,flags};}
async function prepare(view){await view.click(category.name);await view.click('Conferir crédito e tarifa');}
async function confirm(view){const n=view.find(x=>x.type==='input'&&x.props.type==='checkbox');assert.equal(n.props.checked,false);n.props.onChange({target:{checked:true}});await view.flush();await view.click('Confirmar baixa e tarifa');}
const writes=s=>s.calls.filter(c=>c.op==='settle');

test('058 mount only reads categories; explicit category, preview and confirmation precede a write',async()=>{
 const s=service(),{view,flags}=await mount(s);assert.deepEqual(s.calls.map(c=>c.op),['categories']);assert.equal(view.button('Conferir crédito e tarifa').disabled,true);await prepare(view);assert.equal(writes(s).length,0);assert.match(view.text(),/R\$ 123,45/);assert.match(view.text(),/R\$ 3,45/);assert.match(view.text(),/R\$ 120,00/);assert.equal(view.button('Confirmar baixa e tarifa').disabled,true);await confirm(view);assert.equal(s.counts.settle,1);assert.equal(s.counts.command,1);assert.match(view.text(),/Baixa com tarifa registrada/);assert.equal(flags.busy.at(-1),false);assert.equal(flags.draft.at(-1),false);assert.equal(view.guard().changed,false);view.unmount();
});
test('058 lost POST then GET failure/404 offers only explicit resend of the exact same command',async()=>{
 for(const status of [403,409]){
  const s=service({before(call,_state,n){if(call.op==='command'&&n.command===1)throw new AccessError(503);if(call.op==='command'&&[2,3].includes(n.command))throw new AccessError(404);if(call.op==='settle'&&n.settle===2)throw new AccessError(status);},after(call,_state,n){if(call.op==='settle'&&n.settle===1)throw new AccessError(503);}}),{view,flags}=await mount(s,{parent:true});
  const oldBack=view.button('Voltar às ocorrências').props.onClick;await prepare(view);const discard=view.button('Descartar conferência da tarifa').props.onClick;await confirm(view);oldBack();discard();await view.flush();assert.equal(flags.closed,0);assert.equal(view.button('Voltar às ocorrências').disabled,true);assert.equal(view.button('Descartar conferência da tarifa').disabled,true);assert.equal(s.counts.command,undefined);assert.match(view.text(),new RegExp(writes(s)[0].body.command_id));
  await view.click('Consultar resultado da tarifa');assert.equal(writes(s).length,1);assert.doesNotMatch(view.text(),/Reenviar a mesma confirmação/);await view.click('Consultar resultado da tarifa');assert.equal(writes(s).length,1);await view.click('Reenviar a mesma confirmação da tarifa');assert.equal(view.button('Descartar conferência da tarifa').disabled,true);assert.doesNotMatch(view.text(),/Reenviar a mesma confirmação/);await view.click('Consultar resultado da tarifa');await view.click('Reenviar a mesma confirmação da tarifa');
  assert.equal(s.counts.settle,3);assert.equal(s.counts.command,4);assert.deepEqual(writes(s).map(x=>x.body),Array(3).fill(writes(s)[0].body));assert.equal(s.state.receipts.size,1);assert.match(view.text(),/Baixa com tarifa registrada/);assert.equal(view.button('Voltar às ocorrências').disabled,false);view.unmount();
 }
});
test('058 ACK plus unavailable or mismatched current readback permits GET only, including after404',async()=>{
 const s=service({before(call,state,n){if(call.op==='command'&&n.command===1)throw new AccessError(503);if(call.op==='command'&&n.command===2)throw new AccessError(404);if(call.op==='command'){const v=state.receipts.values().next().value;v.current_title.id=n.command===3?uid(99):v.receipt.title_id;}}}),{view}=await mount(s);await prepare(view);await confirm(view);assert.equal(s.counts.settle,1);
 for(let i=0;i<2;i++){await view.click('Consultar resultado da tarifa');assert.doesNotMatch(view.text(),/Reenviar a mesma confirmação/);assert.equal(view.guard().busy,true);}await view.click('Consultar resultado da tarifa');assert.equal(s.counts.settle,1);assert.match(view.text(),/Baixa com tarifa registrada/);view.unmount();
});
test('058 first definitive conflict releases only the stale preview; category needs a fresh preview',async()=>{
 const s=service({before(c){if(c.op==='settle')throw new AccessError(409);}}),{view}=await mount(s);await prepare(view);await confirm(view);assert.doesNotMatch(view.text(),/Consultar resultado da tarifa/);assert.equal(view.button('Conferir crédito e tarifa').disabled,false);assert.equal(view.guard().busy,false);assert.equal(view.guard().changed,true);view.unmount();
});
test('058 blocked arithmetic never exposes confirmation; category pages filter active expense choices locally',async()=>{
 const rows=Array.from({length:25},(_,i)=>({...category,id:uid(100+i),name:'FICTICIA '+i,kind:'receivable'})),s=service({categories:path=>new URL(path,'https://test.invalid').searchParams.has('after')?categoryPage([{...category,id:uid(200),name:category.name}]):categoryPage(rows,true)}),{view}=await mount(s);assert.match(view.text(),/Nenhuma categoria de despesa ativa nesta página/);await view.click('Mais categorias');assert.match(s.calls.at(-1).path,/after=00000124/);assert.doesNotMatch(s.calls.at(-1).path,/active=/);assert.equal(view.button(category.name).disabled,false);view.unmount();
 const d=netDetail();d.context.event.adjustments.interest='1';const blocked=service({detail:d}),m=await mount(blocked);await prepare(m.view);assert.match(m.view.text(),/Juros ou multa exigem conciliação específica/);assert.doesNotMatch(m.view.text(),/Confirmar baixa e tarifa/);assert.equal(writes(blocked).length,0);m.view.unmount();
});
test('058 unmount or actor change aborts pending POST and rejects a late acknowledgement',async()=>{
 for(const changeActor of [false,true]){let release;const gate=new Promise(r=>release=r),s=service({after:async c=>{if(c.op==='settle')await gate;}}),{view}=await mount(s);await prepare(view);await confirm(view);const call=writes(s)[0];if(changeActor){s.state.membership={user_id:uid(1001),role:'admin'};await view.updateProps({});}else view.unmount();assert.equal(call.signal.aborted,true);release();await tick();if(changeActor){await view.flush();assert.doesNotMatch(view.text(),/Baixa com tarifa registrada|Consultar resultado da tarifa/);view.unmount();}assert.equal(s.counts.command,undefined);}
});
test('058 same actor changed to consulta can recover GET but cannot resend or lose the pending command',async()=>{
 const s=service({after(c,_state,n){if(c.op==='settle'&&n.settle===1)throw new AccessError(503);}}),{view}=await mount(s);await prepare(view);await confirm(view);s.state.membership.role='consulta';await view.updateProps({});assert.equal(view.button('Consultar resultado da tarifa').disabled,false);await view.click('Consultar resultado da tarifa');assert.equal(writes(s).length,1);assert.match(view.text(),/Baixa com tarifa registrada/);view.unmount();
});
test('058 existing receipt reopens after reversal with inactive account and no category query; forbidden never falls back043',async()=>{
 const body={command_id:uid(90),expected_approval_version:1,context_hash:'f'.repeat(64)},ack=netAck(body),d=netDetail();d.context.applied_command_id=body.command_id;d.context.settlement={allowed:false,issues:['OPERATIONAL_PAYMENT_ALREADY_APPLIED','PRIOR_SETTLEMENT_HISTORY']};
 const s=service({role:'consulta',detail:d});s.state.receipts.set(body.command_id,netReadback(ack.receipt,{reversed:true}));const {view}=await mount(s,{parent:true});assert.doesNotMatch(view.text(),/Pendências para liquidação|A baixa será registrada/);assert.match(view.text(),/Consulte o recibo e a situação atual desta ocorrência já aplicada/);await view.click('Ver recibo e situação atual');assert.match(view.text(),/duas movimentações foram estornadas/);assert.match(view.text(),/categoria capturada/);assert.equal(s.counts.categories,undefined);assert.equal(s.counts.legacy,undefined);assert.equal(writes(s).length,0);view.unmount();
 const forbidden=service({detail:d,before(c){if(c.op==='command')throw new AccessError(403);}}),m=await mount(forbidden,{parent:true});await m.view.click('Ver recibo e situação atual');assert.equal(forbidden.counts.legacy,undefined);assert.doesNotMatch(m.view.text(),/Baixa com tarifa registrada/);m.view.unmount();
});

test('058 inline success transfers only the validated current readback to the parent without stale context or another write',async()=>{
 let release;const gate=new Promise(resolve=>release=resolve),s=service({before:async call=>{if(call.op==='command')await gate;}}),original=clone(s.state.detail),{view,flags}=await mount(s,{parent:true});
 await prepare(view);const oldConfirm=view.button('Confirmar baixa e tarifa').props.onClick,oldDiscard=view.button('Descartar conferência da tarifa').props.onClick;
 await confirm(view);assert.equal(s.counts.settle,1);assert.equal(s.counts.command,1);assert.equal(view.button('Voltar às ocorrências').disabled,true);assert.doesNotMatch(view.text(),/Consulte o recibo e a situação atual desta ocorrência já aplicada|Baixa com tarifa registrada/);
 release();await tick();await view.flush();
 assert.match(view.text(),/Consulte o recibo e a situação atual desta ocorrência já aplicada/);assert.match(view.text(),/Esta cobrança já possui uma aplicação permanente/);assert.match(view.text(),/TITULO ATUAL FICTICIO · saldo R\$ 0,00/);assert.doesNotMatch(view.text(),/A baixa será registrada|TITULO FICTICIO · saldo|Pendências para liquidação|Confirmar baixa e tarifa|Conferir crédito e tarifa/);
 assert.equal(view.nodes().filter(n=>n.type==='section'&&n.props['aria-label']==='Recibo da baixa com tarifa e situação atual').length,1);assert.equal(view.button('Voltar às ocorrências').disabled,false);assert.deepEqual(s.state.detail,original);assert.equal(s.counts.detail,1);
 oldConfirm();oldDiscard();await view.flush();assert.equal(s.counts.settle,1);assert.equal(s.counts.command,1);await view.click('Voltar às ocorrências');assert.equal(flags.closed,1);view.unmount();
});
