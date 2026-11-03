import test from 'node:test';import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {BASE,page,row,preview,ack,current,state,actor} from './helpers/proposal-import-v2-fixtures.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
function server({before=()=>{},after=()=>{},rows=[row()]}={}){
 const calls=[],commands=new Map(),s={access:state(),counts:{list:0,preview:0,apply:0,command:0,origin:0},changed:false};
 const controller={getSnapshot:()=>s.access,async proposalImport(path,options={}){
  const u=new URL(path,'https://synthetic.invalid'),op=u.pathname===BASE?'list':u.pathname.split('/').at(-2)==='commands'?'command':u.pathname.split('/').at(-2)==='origins'?'origin':u.pathname.split('/').at(-1),call={path,op,...options,body:options.body?structuredClone(options.body):undefined};calls.push(call);s.counts[op]++;await before(call,s);
  let value;if(op==='list')value=page(rows,u.searchParams.get('after'));else if(op==='preview')value=preview(options.body.source_id);else if(op==='apply'){
   const old=commands.get(options.body.command_id);if(old){assert.deepEqual(old.body,options.body);value={...structuredClone(old.ack),replayed:true};}else{value=ack(options.body);commands.set(options.body.command_id,{body:structuredClone(options.body),ack:structuredClone(value)});}
  }else{const saved=op==='command'?commands.get(u.pathname.split('/').at(-1)):[...commands.values()].find(x=>x.body.source_id===u.pathname.split('/').at(-1));if(!saved)throw new AccessError(404);value=current(saved.ack);if(s.changed){Object.assign(value.current_document,{version:2,status:'approved'});value.current_document.totals.total='32.00';}}
  return structuredClone(await after(call,s,value)??value);
 }};return{controller,s,calls,commands};
}
const mount=s=>mountComponent('RealImportProposals.tsx',{controller:s.controller},{expandChildren:['NativeListLayout']});
const review=async ui=>{await ui.click('Conferir prévia 9520000001');await ui.change('proposal-import-duplicates',true);await ui.change('proposal-import-confirm',true);};
test('lost apply response freezes choices; first recovery is GET only and displays current separately',async()=>{
 const s=server({after(c,x){if(c.op==='apply'&&x.counts.apply===1)throw new AccessError(503);}}),ui=await mount(s);
 try{await review(ui);assert.equal(ui.guard().changed,true);const stale=ui.button('Voltar à lista');await ui.click('Criar rascunho revisado');assert.equal(ui.guard().busy,true);assert.equal(ui.button('Voltar à lista').disabled,true);assert.equal(ui.input('proposal-import-confirm').disabled,true);stale.props.onClick();await ui.flush();assert.match(ui.text(),/resultado pendente/);assert.equal(s.s.counts.command,0);
  s.s.changed=true;await ui.click('Consultar resultado');assert.equal(s.s.counts.apply,1);assert.equal(s.s.counts.command,1);assert.equal(s.commands.size,1);assert.equal(ui.guard().busy,false);assert.match(ui.text(),/Recibo original/);assert.match(ui.text(),/Documento consultado agora/);assert.match(ui.text(),/versão 2/);assert.match(ui.text(),/26,71/);assert.match(ui.text(),/32,00/);assert.equal(s.s.counts.list,1);
 }finally{ui.unmount();}
});
test('ACK plus failed readback retains receipt and subsequent lookup never posts again',async()=>{
 const s=server({before(c,x){if(c.op==='command'&&x.counts.command===1)throw new AccessError(503);}}),ui=await mount(s);
 try{await review(ui);await ui.click('Criar rascunho revisado');assert.match(ui.text(),/Recibo confirmado/);assert.equal(ui.guard().busy,true);await ui.click('Consultar resultado');assert.equal(s.s.counts.apply,1);assert.equal(s.s.counts.command,2);assert.equal(ui.guard().busy,false);}finally{ui.unmount();}
});
test('404 lookup permits only explicit same-body retry; uncertainty survives a later 409',async()=>{
 const s=server({before(c,x){if(c.op==='apply'&&x.counts.apply===1)throw new AccessError(503);if(c.op==='apply'&&x.counts.apply===2)throw new AccessError(409);}}),ui=await mount(s);
 try{await review(ui);await ui.click('Criar rascunho revisado');assert.equal(s.s.counts.apply,1);await ui.click('Consultar resultado');assert.equal(s.s.counts.apply,1);assert.equal(ui.guard().busy,true);await ui.click('Reenviar a mesma confirmação');assert.equal(ui.guard().busy,true);assert.equal(s.commands.size,0);await ui.click('Consultar resultado');await ui.click('Reenviar a mesma confirmação');const writes=s.calls.filter(x=>x.op==='apply');assert.equal(writes.length,3);assert.deepEqual(writes[0].body,writes[2].body);assert.equal(s.commands.size,1);assert.equal(ui.guard().busy,false);}finally{ui.unmount();}
});
test('a definitive first conflict releases the uncommitted review and requires new confirmations',async()=>{
 const s=server({before(c){if(c.op==='apply')throw new AccessError(409);}}),ui=await mount(s);try{await review(ui);await ui.click('Criar rascunho revisado');assert.equal(ui.guard().busy,false);assert.equal(s.commands.size,0);assert.equal(ui.button('Atualizar lista').disabled,false);assert.match(ui.text(),/outra prévia/);await ui.click('Conferir prévia 9520000001');assert.equal(ui.button('Criar rascunho revisado').disabled,true);}finally{ui.unmount();}
});
test('blocked previews explain pending data and expose no apply control',async()=>{
 const s=server({after(c,x,v){if(c.op==='preview')return{...v,can_apply:false,proposed:null,source_evidence:null,transformations:[],issues:[{code:'SOURCE_DATE_INVALID',field:'dataProximoContato',position:null},{code:'PRODUCT_MAPPING_UNAVAILABLE',field:'produto.id',position:1}]};}}),ui=await mount(s);try{await ui.click('Conferir prévia 9520000001');assert.match(ui.text(),/Próximo contato: Há uma data ausente ou inválida/);assert.match(ui.text(),/correspondência exata/);assert.equal(ui.nodes().some(n=>n.type==='button'&&n.props.children==='Criar rascunho revisado'),false);assert.equal(s.s.counts.apply,0);assert.equal(ui.guard().changed,false);assert.equal(ui.guard().busy,false);await ui.click('Voltar à lista');assert.equal(ui.guard().changed,false);assert.equal(s.s.counts.apply,0);}finally{ui.unmount();}
});
test('unmount aborts in-flight write and prevents late ACK from starting GET',async()=>{
 const gate=deferred();let signal;const s=server({after(c){if(c.op==='apply'){signal=c.signal;return gate.promise;}}}),ui=await mount(s);await review(ui);await ui.click('Criar rascunho revisado');assert.equal(ui.guard().busy,true);ui.unmount();assert.equal(signal.aborted,true);gate.resolve();await new Promise(r=>setTimeout(r,5));assert.equal(s.s.counts.command,0);
});
test('actor change and role loss deny stale handlers and late reads',async()=>{
 const gate=deferred(),s=server({after(c){if(c.op==='preview')return gate.promise;}}),ui=await mount(s);try{await ui.click('Conferir prévia 9520000001');s.s.access={...state(),membership:{...state().membership,user_id:actor.replace(/1$/,'2')}};await ui.updateProps({controller:s.controller});gate.resolve();await ui.flush();assert.match(ui.text(),/Somente administradores/);assert.doesNotMatch(ui.text(),/Produto sintético/);assert.equal(s.s.counts.apply,0);}finally{ui.unmount();}
 const other=server(),v=await mount(other);try{await review(v);const stale=v.button('Criar rascunho revisado');other.s.access.membership.role='consulta';stale.props.onClick();await v.flush();assert.equal(other.s.counts.apply,0);}finally{v.unmount();}
});
test('old list cannot overwrite a newer cursor or search result',async()=>{
 const gate=deferred(),s=server({before(c,x){if(c.op==='list'&&x.counts.list===1)return gate.promise;},rows:Array.from({length:26},(_,i)=>row(String(9520000001+i)))}),ui=await mount(s);
 try{await ui.change('proposal-import-query','QA/001');await ui.submit();gate.resolve();await ui.flush();assert.equal(s.s.counts.list,2);assert.match(s.calls.filter(x=>x.op==='list').at(-1).path,/q=QA%2F001/);await ui.click('Próxima');assert.match(ui.text(),/Página 2/);assert.equal(ui.button('Conferir prévia 9520000026').disabled,false);assert.throws(()=>ui.button('Conferir prévia 9520000001'));}finally{ui.unmount();}
});
