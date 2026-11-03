import test from 'node:test';import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import * as v1 from './helpers/proposal-import-fixtures.mjs';
import * as v2 from './helpers/proposal-import-v2-fixtures.mjs';
const body={source_id:'9520000001',preview_hash:v1.previewHash,command_id:'f0000000-0000-4000-8000-000000000001',confirm_import:true,duplicate_reviewed:true};
const mount=controller=>mountComponent('RealImportProposals.tsx',{controller},{expandChildren:['NativeListLayout']});
function server({existing=false,policy=v2.POLICY,intercept=()=>{}}={}){const calls=[],s={access:v2.state()};let saved;
 const controller={getSnapshot:()=>s.access,async proposalImport(path,options={}){const call={path,...options};calls.push(call);const custom=await intercept(call);if(custom!==undefined)return custom;
 if(path.startsWith(v2.BASE+'?'))return v2.page([{...v2.row(),document_id:existing?v2.document:null}]);
 if(path===v1.BASE+'/documents/'+v1.document+'/origin')return v2.originMetadata(policy);
 if(path===v2.BASE+'/preview')return v2.preview();
 if(path===v2.BASE+'/apply'){saved=v2.ack(options.body);return saved;}
 if(path.startsWith(v2.BASE+'/commands/')){if(!saved)throw new AccessError(404);return v2.current(saved);}
 if(path.startsWith(v1.BASE+'/origins/'))return v1.current(v1.ack(body));
 if(path.startsWith(v2.BASE+'/origins/'))return v2.current(v2.ack(body));
 throw new Error('Unexpected synthetic path');
 }};return{controller,calls,s};}
test('055 review explains net prices, original discounts, zero-date and declared references without links or an extra deduction',async()=>{
 const s=server(),ui=await mount(s.controller);try{await ui.click('Conferir prévia 9520000001');assert.match(ui.text(),/preços unitários já são líquidos/);assert.match(ui.text(),/Não será reaplicado/);assert.match(ui.text(),/0000-00-00/);assert.match(ui.text(),/unidade não informada/);assert.match(ui.text(),/Origin · ID 9555000001 · Vendedor declarado/);assert.match(ui.text(),/Detalhe sintético <literal>/);assert.match(ui.text(),/Nota da parcela/);assert.match(ui.text(),/26,71/);assert.equal(ui.nodes().filter(n=>n.type==='a'||n.type==='test-router-link').length,0);
 await ui.change('proposal-import-duplicates',true);await ui.change('proposal-import-confirm',true);await ui.click('Criar rascunho revisado');assert.match(ui.text(),/Evidência imutável da importação v2/);assert.match(ui.text(),/Não acompanha edições posteriores/);assert.match(ui.text(),/Conteúdo original do rascunho/);assert.match(ui.text(),/Política da importação: v2/);const writes=s.calls.filter(c=>c.method==='POST'&&c.path.endsWith('/apply'));assert.equal(writes.length,1);assert.deepEqual(Object.keys(writes[0].body),Object.keys(body));assert.equal(writes[0].path,v2.BASE+'/apply');
 }finally{ui.unmount();}
});
test('055 read-only preview stays clean; only explicit confirmations mark the review dirty',async()=>{
 const s=server(),ui=await mount(s.controller);try{
  await ui.click('Conferir prévia 9520000001');assert.deepEqual(ui.guard(),{changed:false,busy:false});
  await ui.click('Voltar à lista');assert.doesNotMatch(ui.text(),/Conferir orçamento/);assert.equal(s.calls.filter(c=>c.path.endsWith('/apply')).length,0);
  await ui.click('Conferir prévia 9520000001');await ui.change('proposal-import-duplicates',true);assert.equal(ui.guard().changed,true);
  await ui.change('proposal-import-duplicates',false);assert.equal(ui.guard().changed,false);
  await ui.change('proposal-import-confirm',true);assert.equal(ui.guard().changed,true);
  await ui.change('proposal-import-confirm',false);assert.equal(ui.guard().changed,false);assert.equal(s.calls.filter(c=>c.path.endsWith('/apply')).length,0);
 }finally{ui.unmount();}
});
test('055 existing v1 origin explicitly resolves its policy and keeps legacy receipt without inventing v2 evidence',async()=>{
 const s=server({existing:true,policy:'origin-open-proposal-v1'}),ui=await mount(s.controller);try{await ui.click('Consultar importação 9520000001');assert.deepEqual(s.calls.slice(1).map(x=>x.path),[v1.BASE+'/documents/'+v1.document+'/origin',v1.BASE+'/origins/'+body.source_id]);assert.match(ui.text(),/Política da importação: v1/);assert.match(ui.text(),/não são atribuídas retroativamente/);assert.doesNotMatch(ui.text(),/Evidência imutável da importação v2|Transformações conferidas/);assert.equal(s.calls.filter(x=>x.method==='POST').length,0);}finally{ui.unmount();}
});
test('055 existing v2 origin shows immutable evidence and never requests its legacy receipt',async()=>{
 const s=server({existing:true,intercept(call){if(call.path.startsWith(v2.BASE+'/origins/')){const value=v2.current(v2.ack(body));value.current_document.version=2;value.current_document.totals.total='30.00';delete value.current_document.commercial;return value;}}}),ui=await mount(s.controller);try{await ui.click('Consultar importação 9520000001');assert.match(ui.text(),/Evidência imutável da importação v2/);assert.match(ui.text(),/26,71/);assert.match(ui.text(),/30,00/);assert.equal(s.calls.filter(x=>x.path===v1.BASE+'/origins/'+body.source_id).length,0);assert.equal(s.calls.filter(x=>x.method==='POST').length,0);}finally{ui.unmount();}
});
test('055 origin metadata absent or changed policy does not trigger a guessed fallback endpoint',async()=>{
 for(const policy of [null,'origin-open-proposal-v3']){const s=server({existing:true,policy}),ui=await mount(s.controller);try{await ui.click('Consultar importação 9520000001');assert.match(ui.text(),/Não foi possível concluir/);assert.equal(s.calls.length,2);assert.equal(s.calls.filter(x=>x.path.includes('/origins/')).length,0);}finally{ui.unmount();}}
});
test('055 uncertain recovery rejects a v1 response on the captured v2 command and preserves GET-only retry',async()=>{
 let commandReads=0;const s=server({intercept(call){if(call.path.includes('/commands/')&&++commandReads===1)return v1.current(v1.ack({...body,command_id:call.path.split('/').at(-1)}));}}),ui=await mount(s.controller);try{await ui.click('Conferir prévia 9520000001');await ui.change('proposal-import-duplicates',true);await ui.change('proposal-import-confirm',true);await ui.click('Criar rascunho revisado');assert.match(ui.text(),/Recibo confirmado/);assert.equal(ui.guard().busy,true);assert.throws(()=>ui.button('Reenviar a mesma confirmação'));await ui.click('Consultar resultado');assert.equal(ui.guard().busy,false);assert.equal(s.calls.filter(x=>x.path.endsWith('/apply')).length,1);assert.ok(s.calls.filter(x=>x.path.includes('/commands/')).every(x=>x.path.startsWith(v2.BASE+'/commands/')));}finally{ui.unmount();}
});
