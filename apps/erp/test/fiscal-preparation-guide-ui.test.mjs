import test from 'node:test';import assert from 'node:assert/strict';
import {mountComponent} from './helpers/component-recovery-harness.mjs';
import {guideFixture,actor} from './helpers/fiscal-preparation-guide-fixture.mjs';
import {unsignedFixture,unsignedUuid} from './helpers/fiscal-unsigned-fixtures.mjs';
const mount=s=>mountComponent('FiscalPreparationGuide.tsx',{controller:s.controller,model:s.model});
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
for(const model of ['55','65'])test(`guide${model} starts without IO, performs five GETs on click and only navigates existing screens`,async()=>{
 const s=guideFixture({model}),v=await mount(s);try{assert.equal(s.calls.length,0);await v.click('Conferir preparação');assert.equal(s.calls.length,5);assert.ok(s.calls.every(c=>(c.method??'GET')==='GET'&&c.body===undefined));assert.ok(s.calls.some(c=>c.path.endsWith('model='+model)));assert.match(v.text(),/Metadados do certificado/);assert.doesNotMatch(v.text(),/CLIENTE PRIVADO SINTÉTICO/);await v.click('Ver pedidos de venda');assert.equal(v.location().pathname,'/documentos-empresa');assert.equal(v.location().search,'?tipo=sales_orders');assert.equal(s.calls.length,5);}finally{v.unmount();}
});
test('missing and partial setup remains actionable without filling a form or treating errors as absence',async()=>{
 const s=guideFixture({empty:true,before(path){if(path==='/v1/a1')throw new Error('private backend diagnostic');}}),v=await mount(s);try{await v.click('Conferir preparação');assert.match(v.text(),/Falta cadastrar a empresa/);assert.match(v.text(),/Consulta indisponível/);assert.match(v.text(),/Nenhum pedido de venda cadastrado/);assert.doesNotMatch(v.text(),/private backend diagnostic|Certificado ainda não configurado/);assert.equal(v.nodes().filter(n=>['input','select','textarea'].includes(n.type)).length,0);}finally{v.unmount();}
});
for(const change of ['role','actor','logout','phase','model'])test(`guide fences late ${change} reads, erases old results and rejects retained handlers`,async()=>{
 const wait=deferred(),s=guideFixture({before:()=>wait.promise}),v=await mount(s);try{const old=v.button('Conferir preparação').props.onClick;await v.click('Conferir preparação');assert.equal(s.calls.length,5);const signals=s.calls.map(c=>c.signal);
  if(change==='role')s.setState({membership:{...s.state.membership,role:'vendas'}});else if(change==='actor')s.setState({membership:{...s.state.membership,user_id:unsignedUuid(99)}});else if(change==='logout')s.setState({phase:'signed_out',membership:null});else if(change==='phase')s.setState({phase:'checking'});else await v.updateProps({model:'65'});await v.flush();old();wait.resolve(undefined);await v.flush();assert.equal(s.calls.length,5);assert.ok(signals.every(x=>x.aborted));assert.doesNotMatch(v.text(),/Metadados do certificado disponíveis|série\(s\) habilitada|pedido\(s\) não cancelado/);
  s.setState({phase:'ready',membership:{user_id:actor,role:'fiscal'}});if(change==='model')await v.updateProps({model:'55'});await v.flush();assert.equal(s.calls.length,5);
 }finally{wait.resolve(undefined);v.unmount();}
});
test('reload rechecks current versions and model changes invalidate results without reusing selections',async()=>{
 const s=guideFixture(),v=await mount(s);try{await v.click('Conferir preparação');const oldLink=v.button('Ver certificado A1').props.onClick;s.company.record.version=2;await v.click('Conferir preparação');assert.match(v.text(),/Regime tributário precisa/);assert.match(v.text(),/Certificado precisa/);assert.equal(s.calls.length,10);await v.updateProps({model:'65'});oldLink();await v.flush();assert.equal(v.location().pathname,'/qa');assert.doesNotMatch(v.text(),/Regime tributário precisa/);assert.equal(s.calls.length,10);}finally{v.unmount();}
});
test('blank model does not infer55 and unmount discards results before a new opening',async()=>{
 const s=guideFixture();let v=await mountComponent('FiscalPreparationGuide.tsx',{controller:s.controller,model:''});try{assert.equal(v.button('Conferir preparação').disabled,true);assert.equal(s.calls.length,0);await v.updateProps({model:'55'});await v.click('Conferir preparação');v.unmount();v=await mount(s);assert.doesNotMatch(v.text(),/Metadados do certificado disponíveis/);assert.equal(s.calls.length,5);}finally{v.unmount();}
});
test('real draft list mounts guide only with available read ports and opening creation never performs fiscal writes',async()=>{
 const s=guideFixture({empty:true}),v=await mountComponent('RealFiscalDrafts.tsx',{controller:s.controller,initialModel:'55'},{expandChildren:['FiscalPreparationGuide','CreateDraft','OrderPicker','NativeListLayout']});try{assert.match(v.text(),/Preparar NF-e/);assert.equal(s.calls.length,1);await v.click('Conferir preparação');await v.click('Incluir rascunho');assert.doesNotMatch(v.text(),/Conferir preparação/);assert.match(v.text(),/Nenhum pedido encontrado/);assert.ok(s.calls.every(c=>(c.method??'GET')==='GET'));}finally{v.unmount();}
});
test('draft editor copy summary stays independent of later artifact state across current revisions',async()=>{
 const f=unsignedFixture();let draft=structuredClone(f.draft);draft.pending.push('FISCAL_XML_NOT_BUILT','XSD_NOT_VALIDATED','SIGNATURE_NOT_CREATED');draft.pending=[...new Set(draft.pending)];const calls=[];
 const controller={fiscalDraft:async(path,o)=>{calls.push({path,...o});return structuredClone(draft);},documents:async()=>{throw new Error('unexpected');}};
 const v=await mountComponent('RealFiscalDrafts.tsx',{controller,id:draft.record.id,onClose(){}},{componentName:'DraftEditor'});try{assert.match(v.text(),/Conferências da cópia do pedido/);assert.doesNotMatch(v.text(),/XML fiscal ainda não gerado|Assinatura digital ainda não realizada|Validação do leiaute fiscal ainda não realizada/);draft.record.version=2;draft.current.version=2;await v.click('Recarregar versão atual');assert.match(v.text(),/Revisão 2/);assert.doesNotMatch(v.text(),/XML fiscal ainda não gerado/);assert.ok(calls.every(c=>(c.method??'GET')==='GET'));}finally{v.unmount();}
});
