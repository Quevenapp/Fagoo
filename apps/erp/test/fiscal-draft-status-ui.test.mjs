import test from 'node:test';import assert from 'node:assert/strict';
import {mountComponent} from './helpers/component-recovery-harness.mjs';
import {fixture,page,row,rows,id,OTHER,deferred} from './helpers/fiscal-draft-status-fixtures.mjs';
const mount=f=>mountComponent('FiscalDraftStatus.tsx',f.props,{expandChildren:true});
const field=(v,suffix)=>v.find(n=>n.type==='select'&&n.props.id.endsWith(suffix)).props.id;
const textOf=node=>Array.isArray(node)?node.map(textOf).join(''):node&&typeof node==='object'?textOf(node.props?.children):node===null||node===undefined||typeof node==='boolean'?'':String(node);

test('082 actual list shows prepared copies, original outcomes and complementary authorization without any send',async()=>{
 const f=fixture(),v=await mount(f);try{
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].method,undefined);assert.equal(f.calls[0].body,undefined);
  assert.match(v.text(),/900101/);assert.match(v.text(),/900102/);assert.match(v.text(),/900103/);assert.match(v.text(),/Em preparação/);assert.match(v.text(),/Resposta guardada; requer conferência/);assert.match(v.text(),/Conferência posterior da mesma resposta/);assert.match(v.text(),/Autorizada em homologação/);assert.match(v.text(),/SEFAZ 245/);assert.match(v.text(),/Sem tentativa de autorização registrada/);
  assert.equal(v.nodes().some(n=>n.type==='button'&&/Enviar|Emitir|Assinar|Reservar|Gerar/.test(n.props.children)),false);
  await v.click('Abrir preparação');assert.equal(f.opens[0].id,id(1));assert.equal(f.calls.length,1);
 }finally{v.unmount();}
});
test('082 compact row exposes the conclusive source while keeping both complete records in closed details',async()=>{
 const observed=page([rows()[0]]),original=structuredClone(observed.items[0].authorization.original),f=fixture({before:()=>observed}),v=await mount(f);try{
  const summary=v.find(n=>n.props['aria-label']==='Resumo do resultado registrado');assert.match(textOf(summary),/Autorizada em homologação.*conferência posterior/);assert.match(textOf(summary),/SEFAZ 100.*104/);assert.match(textOf(summary),/12345678901234567/);assert.doesNotMatch(textOf(summary),/SOAP_INVALID|requer conferência/);
  const records=v.find(n=>n.type==='details');assert.notEqual(records.props.open,true);assert.match(textOf(records),/Ver respostas registradas/);assert.match(textOf(records),/Resposta original.*requer conferência.*SOAP_INVALID/);assert.match(textOf(records),/Conferência posterior da mesma resposta.*Autorizada.*100/);assert.match(textOf(records),/não consulta a situação atual/);
  assert.deepEqual(observed.items[0].authorization.original,original);assert.equal(f.calls.length,1);assert.equal(f.calls[0].body,undefined);
 }finally{v.unmount();}
});
test('082 current A1 and policy configuration are not consulted to display historical records',async()=>{
 const f=fixture();f.controller.currentA1={enabled:false};f.controller.currentPolicy={enabled:false};const v=await mount(f);try{
  assert.match(v.text(),/Autorizada em homologação/);assert.match(v.text(),/mudanças posteriores do certificado ou da política não apagam/);
  f.controller.currentA1={enabled:true,version:999};await v.click('Atualizar resumo');assert.match(v.text(),/Autorizada em homologação/);assert.equal(f.calls.length,2);assert.ok(f.calls.every(c=>!c.body));
 }finally{v.unmount();}
});
test('082 a prepared attempt without a response is not presented as an authorization or SEFAZ response',async()=>{
 const r=row(2,'65');r.authorization.selection='active';Object.assign(r.authorization.original,{state:'request_ready',used_at:null,finished_at:null,result:null});
 const f=fixture({before:()=>page([r])}),v=await mount(f);try{assert.match(v.text(),/Tentativa original/);assert.match(v.text(),/envio não confirmado/);assert.doesNotMatch(v.text(),/Resposta original|SEFAZ|Autorizada em homologação|Protocolo/);assert.equal(f.calls.length,1);}finally{v.unmount();}
});
test('082 mismatch is explicit while the successful historical result stays intact',async()=>{
 const r=row();r.draft.version=2;Object.assign(r.authorization.basis,{matches_current_preparation:false,is_latest_candidate:false,is_latest_job:false,differences:['DRAFT_CHANGED','NEWER_SIGNED_CANDIDATE','NEWER_XML_JOB','COMPANY_CHANGED']});
 const f=fixture({before:()=>page([r])}),v=await mount(f);try{assert.match(v.text(),/preparação anterior/);assert.match(v.text(),/não confirma a versão atual/);assert.match(v.text(),/Autorizada em homologação/);assert.match(v.text(),/existe candidata posterior/);assert.match(v.text(),/empresa mudaram/);}finally{v.unmount();}
});
test('082 restricted results do not become absence claims and malformed evidence is not rendered',async()=>{
 const r=row();r.numbering={visibility:'restricted',reservation:null};r.authorization={visibility:'restricted',selection:null,original:null,revalidation:{visibility:'restricted',result:null},basis:null};
 const f=fixture({before:()=>page([r])}),v=await mount(f);try{assert.match(v.text(),/não disponível neste acesso/);assert.doesNotMatch(v.text(),/Sem tentativa|12345678901234567|900101/);}finally{v.unmount();}
 const bad=page();bad.items[0].authorization.revalidation.result.response_hash='0'.repeat(64);bad.items[0].draft.contact_name='PRIVATE_NOT_TO_DISPLAY';const b=fixture({before:()=>bad}),w=await mount(b);try{assert.match(w.text(),/Não foi possível conferir/);assert.doesNotMatch(w.text(),/PRIVATE_NOT_TO_DISPLAY|Autorizada em homologação|Nenhum rascunho/);}finally{w.unmount();}
});
test('082 model and preparation filters remain separate from authorization outcomes',async()=>{
 const f=fixture(),v=await mount(f);try{
  await v.change(field(v,'-model'),'65');assert.doesNotMatch(v.text(),/900101/);assert.match(v.text(),/900102|900103/);assert.match(f.calls.at(-1).path,/model=65/);
  await v.change(field(v,'-status'),'archived');assert.match(v.text(),/Nenhum rascunho/);assert.match(f.calls.at(-1).path,/status=archived/);await v.click('Limpar filtros');assert.match(v.text(),/900101/);
 }finally{v.unmount();}
});
test('082 pagination binds UUID cursor and invalidates a stale row callback before a refresh',async()=>{
 const first=Array.from({length:25},(_,i)=>row(i+1)),last=row(26);const f=fixture({before:c=>page(c.path.includes('after=')?[last]:first,!c.path.includes('after='))}),v=await mount(f);try{
  const old=v.button('Abrir preparação').props.onClick;const refresh=v.button('Atualizar resumo').props.onClick;refresh();old();assert.equal(f.opens.length,0);await v.flush();
  await v.click('Próxima página');assert.match(f.calls.at(-1).path,new RegExp(encodeURIComponent(id(25))));assert.match(v.text(),/900126/);assert.doesNotMatch(v.text(),/900101/);await v.click('Página anterior');assert.match(v.text(),/900101/);
 }finally{v.unmount();}
});
for(const kind of ['role','actor','logout'])test(`082 ${kind} change aborts and hides the previous actor's late fiscal summary`,async()=>{
 const gate=deferred();let held;const f=fixture({before:c=>{if(!held){held=c;return gate.promise;}return page([]);}}),v=await mount(f);try{
  f.setAccess(kind==='role'?{role:'vendas'}:kind==='actor'?{actor:OTHER}:{actor:null,phase:'signed_out'});await v.flush();assert.equal(held.signal.aborted,true);gate.resolve(page());await v.flush();assert.doesNotMatch(v.text(),/Destinatário sintético|12345678901234567|900101/);assert.equal(f.opens.length,0);
 }finally{gate.resolve(page());v.unmount();}
});
test('082 old controls cannot read or open after role loss, blocking or external model change',async()=>{
 const f=fixture();let v=await mount(f);try{
  const old=v.button('Abrir preparação').props.onClick,refresh=v.button('Atualizar resumo').props.onClick;await v.updateProps({blocked:true});old();refresh();await v.flush();assert.equal(f.opens.length,0);assert.equal(f.calls.length,1);
  // The production wrapper keys its child by actor/model/source. This hook runner
  // needs an explicit unmount to model a changed key on a single child element.
  v.unmount();f.props.initialModel='65';v=await mount(f);old();refresh();await v.flush();assert.equal(f.opens.length,0);assert.doesNotMatch(v.text(),/900101/);
  const current=v.button('Atualizar resumo').props.onClick;f.setAccess({role:'consulta'});await v.flush();const count=f.calls.length;current();await v.flush();assert.equal(f.calls.length,count);assert.doesNotMatch(v.text(),/Destinatário sintético/);
 }finally{v.unmount();}
});
test('082 a failed GET is not presented as an empty page and retry performs only another read',async()=>{
 let failed=true;const f=fixture({before:()=>{if(failed)throw new Error('PRIVATE_UPSTREAM_DETAIL');return page([]);}}),v=await mount(f);try{assert.match(v.text(),/Não foi possível conferir/);assert.doesNotMatch(v.text(),/PRIVATE_UPSTREAM_DETAIL|Nenhum rascunho/);failed=false;await v.click('Atualizar resumo');assert.match(v.text(),/Nenhum rascunho/);assert.equal(f.calls.length,2);assert.ok(f.calls.every(c=>!c.body));}finally{v.unmount();}
});
