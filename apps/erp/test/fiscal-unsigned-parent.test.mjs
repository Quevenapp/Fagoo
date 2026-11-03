import test from 'node:test';
import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {unsignedFixture,unsignedUuid} from './helpers/fiscal-unsigned-fixtures.mjs';
import {businessFixture} from '../../../packages/fiscal-core/test/business-fixtures.mjs';
import {prepareFiscalItems} from '../../../packages/fiscal-core/src/item-preparation.mjs';
import {buildFiscalReview} from '../../../packages/fiscal-core/src/review.mjs';
import {resolveTaxItems} from '../../../packages/fiscal-core/src/tax-preparation.mjs';
import {resolveBusinessCompletion} from '../../../packages/fiscal-core/src/business-completion.mjs';
import {UNSIGNED_FLAGS} from '../src/lib/fiscal-unsigned-model.ts';
import {signedFixture} from './helpers/fiscal-signed-ui-fixture.mjs';
const copy=structuredClone,text=v=>Array.isArray(v)?v.map(text).join(''):v&&typeof v==='object'?text(v.props?.children):v==null||typeof v==='boolean'?'':String(v);
const field=(v,label)=>v.input(v.find(n=>n.type==='label'&&text(n)===label).props.htmlFor);
const toggle=async(v,label)=>{const labels=v.nodes().filter(n=>n.type==='label'),l=labels.find(n=>text(n).includes(label));assert.ok(l,`Missing ${label}; alerts: ${v.nodes().filter(n=>n.props.role==='alert').map(text).join(' | ')}`);const find=x=>Array.isArray(x)?x.map(find).find(Boolean):x?.type==='input'?x:undefined;find(l.props.children).props.onChange({target:{checked:true}});await v.flush();};
const expand=['FiscalUnsignedPreview','FiscalSignedCandidate','FiscalItemPreparation','FiscalTaxPreparation','FiscalBusinessCompletion','PreparationFields','TaskMessage','Choice','Value','Pending','TaxValue','ReceiptValues'];
function service({pending=false,before=()=>{},after=()=>{},signed=null}={}){
 const f=unsignedFixture(),b=businessFixture(),p=f.draft.record.snapshot.items[0].product,basis={draft:f.draft,catalog:[{product_id:p.id,record:{...p,active:true,origin:'0',cest:null,gtin_tax:'SEM GTIN'}}],observed_at:'2026-10-16T12:00:00Z'};
 const initialDecisions=b.itemPreparation.record.items.map(i=>({item_id:i.item_id,fields:Object.fromEntries(Object.entries(i.fields).map(([k,v])=>[k,{source:'manual',value:v.value}]))}));
 const prepare=decisions=>prepareFiscalItems({basis,expected:{draft_id:f.draft.record.id,draft_version:1,snapshot_hash:f.draft.record.snapshot_hash},decisions}).items;
 const state={f,basis,item:{...b.itemPreparation.record,items:prepare(initialDecisions)},tax:copy(b.taxPreparation.record),completion:copy(f.completion.record),job:pending?{...copy(f.job),status:'pending',xml_generated:false,current:{...f.job.current,artifact_current:false,lease_until:'2026-10-16T12:01:00Z'},artifact:null}:null,calls:[],counts:{},commands:new Map(),closed:[]};
 const items=()=>({...b.itemPreparation,record:copy(state.item),draft:copy(f.draft),current:{preparation_version:state.item.version,draft_version:1,matches_current_draft:true}});
 const tax=()=>({...b.taxPreparation,record:copy(state.tax),current:{...b.taxPreparation.current,tax_version:state.tax.version,item_preparation_version:state.item.version,matches_current_item_preparation:state.tax.item_preparation_version===state.item.version}});
 const completion=()=>({...copy(f.completion),record:copy(state.completion),current:{...f.completion.current,completion_version:state.completion.version,item_preparation_version:state.item.version,tax_preparation_version:state.tax.version,matches_current_item_preparation:state.completion.item_preparation_version===state.item.version,matches_current_tax_preparation:state.completion.tax_preparation_version===state.tax.version}});
 const recordCompletion=(body,preview)=>{const item_basis=state.tax.items.map(i=>({item_id:i.item_id,position:i.position,cest:i.identifiers.cest,csosn:i.decisions.icms?.csosn??null}));return{...state.completion,version:body.expected_completion_version+1,item_preparation_version:body.item_preparation_version,tax_preparation_version:body.tax_preparation_version,item_basis,...resolveBusinessCompletion(body.completion,{model:'55',items:item_basis}),created_at:preview?null:f.completion.record.created_at};};
 const call=async(channel,path,o={})=>{
  const method=o.method??'GET',op=`${channel}:${method}:${path.endsWith('/preview')?'preview':path.endsWith('/save')?'save':path.endsWith('/generate')?'generate':path.includes('/commands/')?'command':path.includes('/jobs/')?'job':path.endsWith('/history')?'history':path.includes('/conferencia?')?'review':'get'}`,c={channel,path,method,op,body:copy(o.body),signal:o.signal};state.calls.push(c);state.counts[op]=(state.counts[op]??0)+1;await before(c,state);let result;
  if(channel==='draft'){assert.equal(method,'GET','parent mutation unexpectedly dispatched');result=path.includes('/conferencia?')?buildFiscalReview(basis):f.draft;}
  if(channel==='number')result=f.reserveEnvelope;
  if(channel==='item'){
   if(method==='GET')result=items();
   else{const preview=path.endsWith('/preview'),r={...state.item,version:o.body.expected_version+1,items:prepare(o.body.decisions),created_at:preview?null:state.item.created_at};if(!preview)state.item=r;result={...items(),record:r,...(preview?{persisted:false,expected_version:o.body.expected_version}:{replayed:false})};}
  }
  if(channel==='tax'){
   if(method==='GET')result=tax();
   else{const preview=path.endsWith('/preview'),r={...state.tax,version:o.body.expected_version+1,item_preparation_version:state.item.version,items:resolveTaxItems({model:'55',items:state.item.items.map(i=>({item_id:i.item_id,position:i.position,product_id:i.product_id,identifiers:Object.fromEntries(Object.entries(i.fields).map(([k,v])=>[k,v.value]))})),decisions:o.body.decisions}),created_at:preview?null:state.tax.created_at};if(!preview)state.tax=r;result={...tax(),current:{...tax().current,matches_current_item_preparation:true},record:r,...(preview?{persisted:false,expected_version:o.body.expected_version}:{replayed:false})};}
  }
  if(channel==='completion'){
   if(method==='GET')result=completion();
   else{const preview=path.endsWith('/preview'),r=recordCompletion(o.body,preview);if(!preview)state.completion=r;result={...completion(),current:{...completion().current,matches_current_item_preparation:true,matches_current_tax_preparation:true},record:r,...(preview?{persisted:false,expected_completion_version:o.body.expected_completion_version}:{replayed:false})};}
  }
  if(channel==='unsigned'){
   if(path.endsWith('/history'))result={...UNSIGNED_FLAGS,read_only:true,reservation_id:f.reservation.id,items:state.job?[copy(state.job)]:[],limit:25,has_more:false,next_cursor:null};
   else if(path.endsWith('/preview'))result={...f.preview,completion_version:state.completion.version};
   else if(path.endsWith('/generate')){state.job??=copy(f.job);state.commands.set(o.body.command_id,copy(o.body));result={...state.job,read_only:undefined,command_id:o.body.command_id};}
   else if(path.includes('/commands/')){const id=path.split('/').at(-1);if(!state.commands.has(id))throw new AccessError(404);result={...state.job,command_id:id,read_only:true};}
   else result={...state.job,read_only:true};
  }
  await after(c,state);return copy(result);
 };
 state.controller={getSnapshot:()=>({phase:'ready',membership:{user_id:unsignedUuid(99),role:'admin'}}),fiscalDraft:(p,o)=>call('draft',p,o),fiscalItem:(p,o)=>call('item',p,o),fiscalTax:(p,o)=>call('tax',p,o),fiscalCompletion:(p,o)=>call('completion',p,o),fiscalUnsigned:(p,o)=>call('unsigned',p,o),fiscalNumbering:(p,o)=>call('number',p,o)};
 if(signed){state.job=copy(f.job);state.signed=signedFixture(signed);state.controller.a1=state.signed.controller.a1;state.controller.fiscalSigned=state.signed.controller.fiscalSigned;}return state;
}
const mount=s=>mountComponent('RealFiscalDrafts.tsx',{controller:s.controller,id:s.f.draft.record.id,onClose:()=>s.closed.push(true)},{componentName:'DraftEditor',expandChildren:expand});
const mutations=s=>s.calls.filter(c=>c.method!=='GET'&&!c.path.endsWith('/history'));
test('050 parent protects every siorigin and unsigned reload while signing confirmation is dirty',async()=>{
 const s=service({signed:{}}),v=await mount(s);try{
  const labels=['Conferir prévia dos itens','Conferir prévia tributária','Conferir prévia do complemento','Recarregar versão atual','Conferir atualização da cópia','Arquivar rascunho','Conferir conteúdo e somas','Recarregar conferência','Consultar andamento da geração','Consultar histórico de gerações'];
  const old=labels.map(x=>v.button(x)),fieldBefore=field(v,'Total · Frete');await toggle(v,'Confirmo a assinatura deste XML');
  for(const label of labels)assert.equal(v.button(label).disabled,true,label);assert.equal(field(v,'Total · Frete').disabled,true);const count=s.calls.length,sc=s.signed.calls.length;
  for(const n of old)n.props.onClick();fieldBefore.props.onChange({target:{value:'4,00'}});await v.flush();assert.equal(s.calls.length,count);assert.equal(s.signed.calls.length,sc);assert.equal(field(v,'Total · Frete').props.value,'0,00');
  await v.click('Descartar confirmação de assinatura');assert.equal(v.button('Conferir prévia dos itens').disabled,false);assert.equal(v.button('Recarregar conferência').disabled,false);
 }finally{v.unmount();}
});
test('050 parent preserves signed attempt and blocks stale actions through lost ACK and failed readback, then clears all guards',async()=>{
 const s=service({signed:{after(c,s){if(c.kind==='run'&&s.counts.run===1)throw new AccessError(503);},before(c,s){if(c.kind==='candidate'&&s.counts.candidate===1)throw new AccessError(503);}}}),v=await mount(s);try{
  const back=v.button('Voltar à listagem'),reload=v.button('Recarregar conferência'),general=v.find(n=>n.type==='form');await toggle(v,'Confirmo a assinatura deste XML');await v.click('Assinar XML de homologação');
  const check=async()=>{assert.equal(v.button('Voltar à listagem').disabled,true);assert.equal(field(v,'Total · Frete').disabled,true);assert.equal(v.button('Conferir prévia tributária').disabled,true);const n=s.calls.length;back.props.onClick();reload.props.onClick();general.props.onSubmit({preventDefault(){}});await v.flush();assert.equal(s.calls.length,n);assert.equal(s.closed.length,0);};
  await check();await v.click('Conferir resultado da assinatura');await check();await v.click('Conferir resultado da assinatura');assert.equal(s.signed.counts.run,1);assert.equal(s.signed.commands.size,1);assert.equal(v.button('Voltar à listagem').disabled,false);assert.equal(field(v,'Total · Frete').disabled,false);await v.click('Voltar à listagem');assert.equal(s.closed.length,1);
 }finally{v.unmount();}
});

test('048 parent blocks all siorigin fields/previews and stale callbacks while unsigned review is dirty',async()=>{
 const s=service(),v=await mount(s);try{
  const controls=['Conferir prévia dos itens','Conferir prévia tributária','Conferir prévia do complemento','Recarregar versão atual','Conferir atualização da cópia','Arquivar rascunho'],old=controls.map(label=>v.button(label)),oldCompletion=field(v,'Total · Frete');
  assert.equal(oldCompletion.disabled,false);await v.click('Conferir conteúdo e somas');
  for(const label of controls)assert.equal(v.button(label).disabled,true,label);
  for(const label of['Natureza da operação','Escolha para NCM','CFOP declarado','Total · Frete'])assert.equal(field(v,label).disabled,true,label);
  const count=s.calls.length;for(const node of old){node.props.onClick();await v.flush();}oldCompletion.props.onChange({target:{value:'99,00'}});await v.flush();assert.equal(s.calls.length,count);assert.equal(field(v,'Total · Frete').props.value,'0,00');
  await v.click('Descartar conferência local');assert.equal(field(v,'Total · Frete').disabled,false);assert.equal(v.button('Conferir conteúdo e somas').disabled,false);
 }finally{v.unmount();}
});
test('048 parent freezes through in-flight/uncertain/ACK-readback and releases only after exact current job',async()=>{
 let release;const gate=new Promise(r=>release=r),s=service({after(c,s){if(c.path.endsWith('/generate')&&s.counts[c.op]===1)return gate.then(()=>{throw new AccessError(503);});},before(c,s){if(c.op==='unsigned:GET:job'&&s.counts[c.op]===1)throw new AccessError(503);}}),v=await mount(s);try{
  const back=v.button('Voltar à listagem'),reset=v.button('Recarregar versão atual'),general=v.find(n=>n.type==='form'),oldCompletion=field(v,'Total · Frete');
  await v.click('Conferir conteúdo e somas');await toggle(v,'Confirmo a geração');v.button('Gerar XML sem assinatura').props.onClick();await v.flush();
  const assertLocked=async()=>{for(const label of['Voltar à listagem','Recarregar versão atual','Conferir prévia dos itens','Conferir prévia tributária','Conferir prévia do complemento'])assert.equal(v.button(label).disabled,true,label);const count=s.calls.length;back.props.onClick();reset.props.onClick();general.props.onSubmit({preventDefault(){}});oldCompletion.props.onChange({target:{value:'44,00'}});await v.flush();assert.equal(s.calls.length,count);assert.equal(s.closed.length,0);assert.equal(field(v,'Total · Frete').props.value,'0,00');};
  await assertLocked();release();await v.flush();await assertLocked();await v.click('Conferir resultado da operação');await assertLocked();await v.click('Conferir resultado da operação');assert.equal(s.commands.size,1);assert.equal(s.calls.filter(c=>c.path.endsWith('/generate')).length,1);assert.equal(v.button('Voltar à listagem').disabled,false);assert.equal(v.button('Descartar conferência local').disabled,true);assert.equal(field(v,'Total · Frete').disabled,false);await v.click('Voltar à listagem');assert.equal(s.closed.length,1);
 }finally{release();v.unmount();}
});
test('048 parent can leave or correct bases after explicit release of known pending job, without consuming another number',async()=>{
 const s=service({pending:true});s.job.current.basis_changed=true;const v=await mount(s);try{
  assert.equal(v.button('Voltar à listagem').disabled,true);assert.equal(field(v,'Total · Frete').disabled,true);const count=s.calls.length;await v.click('Deixar geração para consultar depois');assert.equal(s.calls.length,count);assert.equal(v.button('Voltar à listagem').disabled,false);assert.equal(field(v,'Natureza da operação').disabled,false);assert.equal(field(v,'Total · Frete').disabled,false);await v.click('Voltar à listagem');assert.equal(s.closed.length,1);assert.equal(s.job.status,'pending');assert.equal(mutations(s).length,0);
 }finally{v.unmount();}
});
test('048 completion changed after releasing pending monitoring invalidates that generation without changing its original binding',async()=>{
 const s=service({pending:true,after(c,s){if(c.channel==='completion'&&c.path.endsWith('/save')){s.job.current.basis_changed=true;s.job.current.completion_version=s.completion.version;}}}),original=copy(s.job),v=await mount(s);try{
  await v.click('Deixar geração para consultar depois');await v.change(field(v,'Total · Frete').props.id,'2,00');await v.click('Conferir prévia do complemento');await toggle(v,'Conferi as declarações e quero registrar esta versão, sem cálculo');await v.click('Salvar versão do complemento');
  assert.equal(s.completion.version,2);assert.equal(s.job.completion_version,1);assert.equal(s.job.basis_hash,original.basis_hash);assert.equal(s.job.completion_hash,original.completion_hash);assert.equal(s.job.reservation_id,original.reservation_id);
  assert.equal(v.button('Solicitar retomada da geração pendente').disabled,true);assert.equal(v.button('Conferir conteúdo e somas').disabled,true);assert.match(v.text(),/resultado usou bases anteriores/);await v.click('Deixar geração para consultar depois');assert.equal(v.button('Voltar à listagem').disabled,false);await v.click('Voltar à listagem');assert.equal(s.closed.length,1);assert.equal(s.calls.some(c=>c.path.endsWith('/generate')||c.path.endsWith('/reservations')),false);
 }finally{v.unmount();}
});
test('048 parent refreshes unsigned after actual completion save and only uses the saved new version for preview',async()=>{
 const s=service(),v=await mount(s);try{
  const initialReads=s.calls.filter(c=>c.channel==='completion'&&c.method==='GET').length;
  await v.change(field(v,'Total · Frete').props.id,'2,00');assert.equal(v.button('Conferir conteúdo e somas').disabled,true);await v.click('Conferir prévia do complemento');await toggle(v,'Conferi as declarações e quero registrar esta versão, sem cálculo');await v.click('Salvar versão do complemento');
  assert.equal(s.completion.version,2);assert.ok(s.calls.filter(c=>c.channel==='completion'&&c.method==='GET').length>=initialReads+2);assert.equal(v.button('Conferir conteúdo e somas').disabled,false);await v.click('Conferir conteúdo e somas');assert.equal(s.calls.filter(c=>c.channel==='unsigned'&&c.path.endsWith('/preview')).at(-1).body.completion_version,2);
 }finally{v.unmount();}
});
test('048 parent refreshes unsigned on item and tax changes, leaving stale completion unavailable instead of inheriting it',async()=>{
 const s=service(),v=await mount(s);try{
  let initial=s.calls.filter(c=>c.channel==='completion'&&c.method==='GET').length;
  await v.click('Conferir prévia dos itens');await toggle(v,'Conferi as escolhas e quero registrar esta versão sem emissão');await v.click('Salvar versão da preparação');assert.equal(s.item.version,2);assert.ok(s.calls.filter(c=>c.channel==='completion'&&c.method==='GET').length>initial);assert.equal(v.button('Conferir conteúdo e somas').disabled,true);assert.match(v.text(),/salve identificadores, tributos e complemento/);
  initial=s.calls.filter(c=>c.channel==='completion'&&c.method==='GET').length;assert.equal(v.button('Conferir prévia tributária').disabled,false);assert.equal(field(v,'Operação declarada para esta preparação').props.value,'');await v.change(field(v,'Operação declarada para esta preparação').props.id,'internal_normal_sale');await v.click('Conferir prévia tributária');await toggle(v,'Conferi as declarações e quero registrar esta versão sem cálculo');await v.click('Salvar versão tributária');assert.equal(s.tax.version,2);assert.ok(s.calls.filter(c=>c.channel==='completion'&&c.method==='GET').length>initial);assert.equal(v.button('Conferir conteúdo e somas').disabled,true);assert.equal(s.calls.some(c=>c.path.endsWith('/generate')||c.path.endsWith('/reservations')),false);
 }finally{v.unmount();}
});
