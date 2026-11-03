import test from 'node:test';
import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';

const BASE='/v1/transferencias-internas',actor='10000000-0000-4000-8000-000000000001',otherActor='10000000-0000-4000-8000-000000000002';
const uuid=(prefix,n)=>`${prefix}0000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const fromId=uuid('2',1),toId=uuid('2',2),copy=structuredClone;
const FLAGS={scope:'finance_internal_transfer',data_mode:'erp_native',bank_operation_performed:false,title_mutation_performed:false,opening_mutation_performed:false};
const account=(id,name,balance='100000',version=3)=>({id,name,kind:'bank',active:true,opening_recorded:true,version,balance_cents:balance,opening_on:'2026-01-01'});
function server({role='admin',accounts=[account(fromId,'Origem fictícia'),account(toId,'Destino fictício','5000',7)],before=()=>{},after=()=>{}}={}){
 const state={actor,role,phase:'ready',accounts:new Map(accounts.map(a=>[a.id,copy(a)])),transfers:[],counts:{list:0,get:0,command:0,post:0,accounts:0,account:0}},calls=[];
 const current=r=>({from_account:copy(state.accounts.get(r.from_account.id)),to_account:copy(state.accounts.get(r.to_account.id))});
 const make=body=>{
  const a=state.accounts.get(body.from_account_id),b=state.accounts.get(body.to_account_id);
  if(!a.active||!b.active||a.version!==body.expected_from_version||b.version!==body.expected_to_version)throw new AccessError(409);
  const snap=(v,amount)=>({id:v.id,name:v.name,kind:v.kind,version_before:v.version,version_after:v.version+1,balance_before_cents:v.balance_cents,balance_after_cents:(BigInt(v.balance_cents)+amount).toString(),opening_on:v.opening_on});
  const amount=BigInt(body.amount_cents),from=snap(a,-amount),to=snap(b,amount);
  const receipt={id:uuid('3',state.transfers.length+1),command_id:body.command_id,from_account:from,to_account:to,amount_cents:body.amount_cents,posted_on:body.posted_on,note:body.note,created_at:'2026-10-16T15:00:00.123456+00:00',movements:[{id:crypto.randomUUID(),account_id:a.id,kind:'transfer_out',delta_cents:(-amount).toString()},{id:crypto.randomUUID(),account_id:b.id,kind:'transfer_in',delta_cents:amount.toString()}]};
  for(const [v,s]of [[a,from],[b,to]]){v.version=s.version_after;v.balance_cents=s.balance_after_cents;}
  state.transfers.push(receipt);return receipt;
 };
 const controller={getSnapshot:()=>({phase:state.phase,membership:state.phase==='ready'?{user_id:state.actor,role:state.role}:null}),
  async finance(path,options={}){
   const url=new URL(path,'https://synthetic.invalid'),id=url.pathname.split('/')[4],op=id?'account':'accounts',call={path,op,...options};calls.push(call);state.counts[op]++;await before(call,state);
   let result;if(id){const record=state.accounts.get(id);if(!record)throw new AccessError(404);result={entity:'accounts',data_mode:'erp_native',record:copy(record)};}
   else{assert.equal(url.searchParams.has('active'),false);const q=url.searchParams.get('q')??'',cursor=url.searchParams.get('after')??'',all=[...state.accounts.values()].filter(a=>a.id>cursor&&a.name.includes(q)).sort((a,b)=>a.id.localeCompare(b.id)),items=all.slice(0,25);result={entity:'accounts',data_mode:'erp_native',limit:25,items:copy(items),has_more:all.length>25,next_cursor:all.length>25?items.at(-1).id:null};}
   await after(call,state,result);return copy(result);
  },
  async financeTransfers(path,options={}){
   const url=new URL(path,'https://synthetic.invalid'),segments=url.pathname.split('/'),op=options.method==='POST'?'post':segments[3]==='commands'?'command':segments[3]?'get':'list',call={path,op,...options,body:options.body?copy(options.body):undefined};calls.push(call);state.counts[op]++;await before(call,state);
   let result;if(op==='post'){const old=state.transfers.find(r=>r.command_id===options.body.command_id),receipt=old??make(options.body);result={...FLAGS,receipt:copy(receipt),current:current(receipt),replayed:Boolean(old)};}
   else if(op==='command'||op==='get'){const receipt=state.transfers.find(r=>op==='command'?r.command_id===segments[4]:r.id===segments[3]);if(!receipt)throw new AccessError(404);result={...FLAGS,receipt:copy(receipt),current:current(receipt),read_only:true};}
   else{const cursor=url.searchParams.get('after')??'',all=state.transfers.filter(r=>r.id>cursor).sort((a,b)=>a.id.localeCompare(b.id)),items=all.slice(0,25).map(r=>({receipt:copy(r),current:current(r)}));result={...FLAGS,read_only:true,items,limit:25,has_more:all.length>25,next_cursor:all.length>25?items.at(-1).receipt.id:null};}
   await after(call,state,result);return copy(result);
  }};
 return{state,calls,controller,make};
}
const mount=(s,props={})=>mountComponent('FinanceTransfers.tsx',{controller:s.controller,onBack:()=>{},...props},{expandChildren:true});
async function fill(view,{amount='12,34',date='2026-01-15',note='Transferência sintética conferida'}={}){
 await view.click('Registrar transferência');await view.click('Origem fictícia');await view.click('Destino fictício');
 await view.change('transfer-amount',amount);await view.change('transfer-date',date);await view.change('transfer-note',note);
}
const posts=s=>s.calls.filter(c=>c.op==='post');
const invoke=node=>node.props.onClick?.({preventDefault(){}});

test('053 preview reads both current accounts, captures exact versions and confirms only by an explicit click',async()=>{
 const s=server({before(call,state){if(call.op==='account'){const id=call.path.split('/').at(-1),a=state.accounts.get(id);a.version++;a.balance_cents=id===fromId?'1234567890123456789':'7000';}}}),view=await mount(s);
 try{
  assert.match(view.text(),/não envia dinheiro ao banco/);assert.equal(s.state.counts.post,0);
  await fill(view,{amount:'9999999999999,99'});await view.submit();assert.equal(s.state.counts.account,2);assert.equal(s.state.counts.post,0);assert.match(view.text(),/R\$ 12\.335\.678\.901\.234\.567,90/);
  assert.equal(view.input('transfer-amount').disabled,true);await view.click('Confirmar registro interno');
  assert.equal(posts(s).length,1);const body=posts(s)[0].body;assert.equal(body.expected_from_version,4);assert.equal(body.expected_to_version,8);assert.equal(body.amount_cents,'999999999999999');assert.equal(body.confirmed,true);
  assert.deepEqual(Object.keys(body).sort(),['command_id','from_account_id','to_account_id','expected_from_version','expected_to_version','amount_cents','posted_on','note','confirmed'].sort());
  assert.match(view.text(),/Transferência confirmada e consultada/);assert.match(view.text(),/Saldos capturados no registro/);assert.match(view.text(),/Saldos atuais consultados/);assert.equal(view.guard().busy,false);assert.equal(view.guard().changed,false);
 }finally{view.unmount();}
});

test('053 lost ACK then failed command reads never resends automatically and blocks stale editing/discard handlers',async()=>{
 const s=server({before(call,state){if(call.op==='command'&&state.counts.command<=2)throw new AccessError(state.counts.command===1?503:403);},after(call,state){if(call.op==='post'&&state.counts.post===1)throw new AccessError(503);}}),backCalls=[],view=await mount(s,{onBack:()=>backCalls.push(1)});
 try{
  await fill(view);const oldChange=view.input('transfer-amount').props.onChange,oldCancel=view.button('Cancelar'),oldBack=view.button('Voltar ao financeiro'),oldSubmit=view.nodes().find(n=>n.type==='form').props.onSubmit;
  await view.submit();const oldEdit=view.button('Editar dados'),oldConfirm=view.button('Confirmar registro interno');await view.click('Confirmar registro interno');
  oldChange({target:{value:'999,99'}});invoke(oldCancel);invoke(oldBack);invoke(oldEdit);invoke(oldConfirm);oldSubmit({preventDefault(){}});await view.flush();
  assert.equal(view.input('transfer-amount').props.value,'12,34');assert.equal(posts(s).length,1);assert.equal(backCalls.length,0);assert.equal(view.guard().busy,true);assert.doesNotMatch(view.text(),/Nenhuma transferência registrada/);
  await view.click('Conferir resultado');await view.click('Conferir resultado');assert.equal(posts(s).length,1);assert.equal(view.guard().busy,true);
  await view.click('Conferir resultado');assert.equal(s.state.transfers.length,1);assert.equal(posts(s).length,1);assert.equal(s.state.counts.command,3);assert.equal(view.guard().busy,false);
 }finally{view.unmount();}
});

test('053 uncertain POST then command404 offers exact explicit replay; later409 does not release the frozen command',async()=>{
 const s=server({before(call,state){if(call.op==='post'&&state.counts.post<=2)throw new AccessError(state.counts.post===1?503:409);}}),view=await mount(s);
 try{
  await fill(view);await view.submit();await view.click('Confirmar registro interno');assert.equal(posts(s).length,1);
  await view.click('Conferir resultado');assert.equal(posts(s).length,1);assert.match(view.text(),/não comprova que foi rejeitado/);assert.equal(view.guard().busy,true);
  const retry=view.button('Reenviar a mesma confirmação');await view.click('Reenviar a mesma confirmação');assert.equal(view.guard().busy,true);assert.equal(view.input('transfer-note').disabled,true);
  invoke(retry);await view.flush();assert.equal(posts(s).length,2);await view.click('Conferir resultado');await view.click('Reenviar a mesma confirmação');
  assert.equal(s.state.transfers.length,1);assert.equal(posts(s).length,3);for(const call of posts(s))assert.deepEqual(call.body,posts(s)[0].body);assert.equal(view.guard().busy,false);
 }finally{view.unmount();}
});

test('053 acknowledged POST followed by failed or mismatched readback retries only GET and keeps historical versus current balances distinct',async()=>{
 const s=server({before(call,state){if(call.op==='command'&&state.counts.command===1)throw new AccessError(503);},after(call,state,result){if(call.op==='command'&&state.counts.command===2)result.receipt.note='Outro recibo';if(call.op==='command'&&state.counts.command===3){result.current.from_account.balance_cents='54321';result.current.from_account.version++;}}}),view=await mount(s);
 try{
  await fill(view);await view.submit();await view.click('Confirmar registro interno');assert.match(view.text(),/registro já foi confirmado/);assert.equal(view.guard().busy,true);
  await view.click('Consultar registro confirmado');assert.equal(view.guard().busy,true);await view.click('Consultar registro confirmado');assert.equal(posts(s).length,1);assert.equal(s.state.transfers.length,1);assert.match(view.text(),/R\$ 543,21/);assert.match(view.text(),/R\$ 987,66/);assert.equal(view.guard().busy,false);
 }finally{view.unmount();}
});

test('053 definitive initial CAS conflict preserves draft and requires a fresh account preview before a new confirmation',async()=>{
 const s=server({before(call,state){if(call.op==='post'&&state.counts.post===1)state.accounts.get(fromId).version++;}}),view=await mount(s);
 try{await fill(view);await view.submit();await view.click('Confirmar registro interno');assert.equal(view.guard().busy,false);assert.equal(view.guard().changed,true);assert.equal(view.input('transfer-amount').disabled,false);assert.match(view.text(),/Uma das contas mudou/);
  await view.submit();await view.click('Confirmar registro interno');assert.equal(s.state.transfers.length,1);assert.equal(posts(s).length,2);assert.notEqual(posts(s)[0].body.command_id,posts(s)[1].body.command_id);assert.equal(posts(s)[1].body.expected_from_version,4);
 }finally{view.unmount();}
});

test('053 validates empty/same/inactive accounts and invalid amounts/dates before allowing a confirmation',async()=>{
 const s=server(),view=await mount(s);
 try{await view.click('Registrar transferência');await view.submit();assert.match(view.text(),/Selecione as contas/);await view.click('Origem fictícia');await view.click('Origem fictícia');await view.change('transfer-amount','0,00');await view.change('transfer-date','2026-01-15');await view.change('transfer-note','Conta repetida sintética');await view.submit();assert.match(view.text(),/ativas e diferentes/);
  await view.click('Trocar conta de entrada');await view.click('Destino fictício');await view.submit();assert.match(view.text(),/maior que zero/);await view.change('transfer-amount','1,005');await view.submit();assert.match(view.text(),/até duas casas/);await view.change('transfer-amount','1,00');await view.change('transfer-date','2026-02-30');await view.submit();assert.match(view.text(),/data válida/);assert.equal(s.state.counts.account,0);
  await view.change('transfer-date','2026-01-15');s.state.accounts.get(toId).active=false;await view.submit();assert.equal(posts(s).length,0);assert.equal(view.nodes().some(n=>n.type==='button'&&n.props.children==='Confirmar registro interno'),false);
 }finally{view.unmount();}
});

test('053 account search uses q and25-row cursors, filters inactive locally, and never sends unsupported active query',async()=>{
 const accounts=Array.from({length:26},(_,i)=>({...account(uuid('2',i+1),`Conta sintética ${i+1}`),active:i===25})),s=server({accounts}),view=await mount(s);
 try{await view.click('Registrar transferência');assert.match(view.text(),/Nenhuma conta ativa nesta página/);await view.click('Mais contas');await view.click('Conta sintética 26');assert.match(view.text(),/Trocar conta de saída/);
  await view.change('transfer-to-query','Conta sintética 26');const search=view.nodes().find(n=>n.type==='button'&&n.props.children==='Buscar');invoke(search);await view.flush();assert.ok(s.calls.some(c=>c.op==='accounts'&&new URL(c.path,'https://synthetic.invalid').searchParams.get('q')==='Conta sintética 26'));assert.ok(s.calls.some(c=>c.path.includes('after=')));for(const call of s.calls.filter(c=>c.op==='accounts'))assert.equal(new URL(call.path,'https://synthetic.invalid').searchParams.has('active'),false);
 }finally{view.unmount();}
});

test('053 list pagination and detail read preserve receipt history while consultation cannot write',async()=>{
 const s=server({role:'consulta'});for(let i=0;i<27;i++)s.make({command_id:crypto.randomUUID(),from_account_id:fromId,to_account_id:toId,expected_from_version:s.state.accounts.get(fromId).version,expected_to_version:s.state.accounts.get(toId).version,amount_cents:'1',posted_on:'2026-01-15',note:`Transferência fictícia ${i+1}`});const view=await mount(s);
 try{assert.match(view.text(),/25 registro\(s\)/);assert.equal(view.nodes().some(n=>n.type==='button'&&n.props.children==='Registrar transferência'),false);await view.click('Próxima');assert.match(view.text(),/2 registro\(s\)/);assert.match(view.text(),/Transferência fictícia 27/);await view.click('Anterior');assert.match(view.text(),/25 registro\(s\)/);
  const row=view.nodes().find(n=>n.type==='button'&&n.props['aria-label']?.startsWith('Ver transferência'));invoke(row);await view.flush();assert.match(view.text(),/Saldos atuais consultados/);assert.equal(s.state.counts.get,1);assert.equal(posts(s).length,0);
 }finally{view.unmount();}
});

test('053 same actor role changes preserve uncertain command, allow read recovery, and never enable a stale write callback',async()=>{
 const s=server({after(call){if(call.op==='post')throw new AccessError(503);}}),view=await mount(s);
 try{await fill(view);await view.submit();const oldConfirm=view.button('Confirmar registro interno');await view.click('Confirmar registro interno');s.state.role='consulta';await view.updateProps({});invoke(oldConfirm);await view.flush();assert.equal(posts(s).length,1);assert.equal(view.guard().busy,true);await view.click('Conferir resultado');assert.equal(view.guard().busy,false);assert.equal(s.state.transfers.length,1);assert.equal(view.nodes().some(n=>n.type==='button'&&n.props.children==='Registrar outra transferência'),false);
 }finally{view.unmount();}
});

test('053 actor change, logout and unmount abort requests and discard late mutation results without readback',async()=>{
 for(const action of ['actor','logout','unmount']){
  let release,signal;const s=server({before(call){if(call.op==='post'){signal=call.signal;return new Promise(resolve=>release=resolve);}}}),view=await mount(s);
  await fill(view);await view.submit();await view.click('Confirmar registro interno');assert.equal(view.guard().busy,true);
  if(action==='unmount')view.unmount();else{s.state.actor=action==='actor'?otherActor:actor;s.state.phase=action==='logout'?'signed_out':'ready';await view.updateProps({});}
  assert.equal(signal.aborted,true);release();await view.flush();assert.equal(s.state.counts.command,0);if(action!=='unmount'){assert.doesNotMatch(view.text(),/Transferência confirmada e consultada/);assert.equal(view.guard().busy,false);view.unmount();}
 }
});

test('053 read failures invalidate list/detail rather than displaying stale balances, and leaving a draft uses the guard',async()=>{
 const actions=[],s=server({before(call,state){if(call.op==='list'&&state.counts.list===2)throw new AccessError(503);}}),view=await mountComponent('FinanceTransfers.tsx',{controller:s.controller,onBack:()=>actions.push('back')},{expandChildren:true,ports:{useUnsavedChanges(){return{confirmLeave:run=>actions.push(run)};}}});
 try{await view.click('Atualizar transferências');assert.doesNotMatch(view.text(),/Nenhuma transferência registrada/);assert.match(view.text(),/Atualize a consulta/);await fill(view);await view.click('Voltar ao financeiro');assert.equal(actions.length,1);assert.equal(typeof actions[0],'function');assert.equal(view.input('transfer-amount').props.value,'12,34');actions[0]();assert.equal(actions[1],'back');}
 finally{view.unmount();}
});
