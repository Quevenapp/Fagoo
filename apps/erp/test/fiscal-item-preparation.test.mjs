import test from 'node:test';
import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {reviewBasis,reviewIds} from '../../../packages/fiscal-core/test/review-fixtures.mjs';
import {buildFiscalReview} from '../../../packages/fiscal-core/src/review.mjs';
import {prepareFiscalItems,ITEM_PREPARATION_FLAGS} from '../../../packages/fiscal-core/src/item-preparation.mjs';
import {fiscalItemEnvelope,choicesFromReceipt,fiscalItemWrite,itemValueValid,itemChoicesKey} from '../src/lib/fiscal-item-model.ts';

const clone=structuredClone,flags={data_mode:'fiscal_item_preparation',profile:'item-identification-v1',schema_profile:'pl010f-v1.04',...ITEM_PREPARATION_FLAGS};
const text=v=>Array.isArray(v)?v.map(text).join(''):v&&typeof v==='object'?text(v.props?.children):v==null||typeof v==='boolean'?'':String(v);
const field=(view,label)=>view.input(view.find(n=>n.type==='label'&&text(n)===label).props.htmlFor);
const change=async(view,label,value)=>view.change(field(view,label).props.id,value);
const invoke=async(view,node)=>{node.props.onClick?.({preventDefault(){}});await view.flush();};
function service({basis=reviewBasis(),before=()=>{},after=()=>{}}={}){
 const state={basis:clone(basis),current:null,version:0},revisions=new Map([[basis.draft.record.version,clone(basis.draft.record)]]),receipts=new Map(),commands=new Map(),calls=[],counts={writes:0,gets:0,readbacks:0,previews:0};
 const s={state,revisions,receipts,commands,calls,counts};
 const envelope=(record,extras={})=>{const draft=clone(state.basis.draft);if(record){draft.record=clone(revisions.get(record.draft_version));draft.current.source_changed=draft.current.source_document_version!==draft.record.source_document_version;}
  return{...flags,record:clone(record),draft,current:{preparation_version:state.version,draft_version:state.basis.draft.current.version,matches_current_draft:record!==null&&record.draft_version===state.basis.draft.current.version},...extras};};
 const resolve=body=>{const prepared=prepareFiscalItems({basis:state.basis,expected:{draft_id:state.basis.draft.record.id,draft_version:body.expected_draft_version,snapshot_hash:body.snapshot_hash},decisions:body.decisions});
  return{draft_id:reviewIds.draft,version:body.expected_version+1,draft_version:body.expected_draft_version,snapshot_hash:body.snapshot_hash,model:state.basis.draft.record.model,environment:'2',source_document_id:reviewIds.order,source_document_version:state.basis.draft.record.source_document_version,created_at:'2026-10-16T13:00:00Z',items:prepared.items};};
 s.controller={async fiscalDraft(path){return path.includes('/conferencia?')?buildFiscalReview(state.basis):clone(state.basis.draft);},async fiscalItem(path,options={}){
  const call={path,method:options.method??'GET',body:clone(options.body),signal:options.signal};calls.push(call);
  if(path.includes('/history?')){await before(call,s);let rows=[...receipts.values()].sort((a,b)=>b.version-a.version);const url=new URL(path,'https://synthetic.invalid'),beforeValue=Number(url.searchParams.get('before')||2147483648);rows=rows.filter(r=>r.version<beforeValue);return{...flags,draft_id:reviewIds.draft,items:clone(rows.slice(0,25)).map(({items,...meta})=>meta),limit:25,has_more:rows.length>25,next_cursor:rows.length>25?rows[24].version:null};}
  if(call.method==='GET'){counts.gets++;if(commands.size)counts.readbacks++;await before(call,s);const version=new URL(path,'https://synthetic.invalid').searchParams.get('version');return envelope(version?receipts.get(Number(version)):state.current);}
  if(path.endsWith('/preview')){counts.previews++;await before(call,s);return envelope({...resolve(call.body),created_at:null},{persisted:false,expected_version:call.body.expected_version});}
  counts.writes++;await before(call,s);let record=commands.get(call.body.command_id);const replayed=Boolean(record);
  if(!record){record=resolve(call.body);commands.set(call.body.command_id,clone(record));receipts.set(record.version,clone(record));state.current=clone(record);state.version=record.version;}
  await after(call,s);return envelope(record,{replayed});
 }};
 s.snapshot=()=>envelope(state.current);s.seed=decisions=>{const body=fiscalItemWrite(state.basis.draft,state.version,decisions),record=resolve(body);receipts.set(record.version,clone(record));state.current=record;state.version=record.version;return record;};
 return s;
}
async function mount(s,extra={}){return mountComponent('FiscalItemPreparation.tsx',{controller:s.controller,value:clone(s.state.basis.draft),...extra});}
async function prepare(view){await change(view,'Escolha para NCM','manual');await change(view,'Valor de NCM','12345678');await view.click('Conferir prévia dos itens');const checkbox=view.find(n=>n.type==='input'&&n.props.type==='checkbox');checkbox.props.onChange({target:{checked:true}});await view.flush();}
const writes=s=>s.calls.filter(c=>c.method==='POST'&&!c.path.endsWith('/preview'));

test('057 item preparation displays exact commercial price10 while leaving all fiscal decisions untouched',async()=>{
 const basis=reviewBasis();basis.draft.record.snapshot.items[0].unit_price='10.0000000001';
 const s=service({basis}),view=await mount(s);
 try{assert.match(view.text(),/R\$ 10,0000000001/);assert.equal(field(view,'Escolha para NCM').props.value,'unreviewed');assert.equal(s.counts.writes,0);assert.equal(s.counts.previews,0);assert.equal(view.guard().changed,false);}finally{view.unmount();}
});

test('035 UI explicit manual/catalog/null/SEM GTIN preserves the commercial snapshot and only edits five fields at a time',async()=>{
 const s=service({basis:reviewBasis({itemCount:250})}),view=await mount(s);
 try{
  assert.equal(view.nodes().filter(n=>n.type==='fieldset').length,5);assert.equal(s.counts.writes,0);assert.equal(s.counts.previews,0);
  await view.click('Usar NCM do catálogo');await change(view,'Escolha para CEST','empty');await view.click('Declarar SEM GTIN para GTIN comercial');
  await view.click('Conferir prévia dos itens');const checkbox=view.find(n=>n.type==='input'&&n.props.type==='checkbox');checkbox.props.onChange({target:{checked:true}});await view.flush();await view.click('Salvar versão da preparação');
  assert.equal(s.counts.writes,1);assert.equal(s.state.current.items.length,250);const first=s.state.current.items[0];assert.equal(first.fields.ncm.provenance.source,'catalog');assert.equal(first.fields.cest.value,null);assert.equal(first.fields.cest.provenance.source,'manual');assert.equal(first.fields.gtin.value,'SEM GTIN');assert.equal(first.fields.origin.provenance.source,'unreviewed');
  assert.equal(view.guard().busy,false);assert.equal(view.guard().changed,false);assert.match(view.text(),/Preparação registrada/);
  assert.equal(s.state.basis.draft.record.snapshot.items[0].quantity,'1.230000');assert.equal(s.state.basis.draft.record.snapshot.items[0].unit_price,'10.0000');
 }finally{view.unmount();}
});
for(const status of[403,409])test(`035 UI lost committed response then ${status} preserves body/UUID and prevents all reset paths`,async()=>{
 const s=service({after(c,s){if(s.counts.writes===1)throw new AccessError(503);},before(c,s){if(c.method==='POST'&&!c.path.endsWith('/preview')&&s.counts.writes===2)throw new AccessError(status);}}),view=await mount(s);
 try{
  await prepare(view);const stale=[view.button('Recarregar preparação e catálogo'),view.button('Histórico da preparação'),view.button('Descartar escolhas locais'),view.button('Conferir prévia dos itens'),view.button('Salvar versão da preparação')],oldField=field(view,'Valor de NCM');
  await view.click('Salvar versão da preparação');await view.click('Repetir a mesma confirmação');assert.equal(view.guard().busy,true);assert.equal(field(view,'Valor de NCM').disabled,true);
  for(const name of['Recarregar preparação e catálogo','Histórico da preparação','Descartar escolhas locais'])assert.equal(view.button(name).disabled,true);
  const count=s.calls.length;for(const node of stale)await invoke(view,node);oldField.props.onChange({target:{value:'87654321'}});await view.flush();assert.equal(s.calls.length,count);assert.equal(field(view,'Valor de NCM').props.value,'12345678');
  await view.click('Repetir a mesma confirmação');assert.equal(s.commands.size,1);assert.equal(s.counts.writes,3);for(const c of writes(s))assert.deepEqual(c.body,writes(s)[0].body);assert.equal(view.guard().busy,false);assert.equal(view.guard().changed,false);
 }finally{view.unmount();}
});
test('035 UI committed replay plus failed GET repeats only GET and accepts the latest preparation',async()=>{
 const s=service({after(c,s){if(s.counts.writes===1)throw new AccessError(503);},before(c,s){if(c.method==='GET'&&s.counts.readbacks===1)throw new AccessError(503);}}),view=await mount(s);
 try{await prepare(view);await view.click('Salvar versão da preparação');await view.click('Repetir a mesma confirmação');assert.equal(s.counts.writes,2);assert.equal(view.guard().busy,true);
  s.seed({[reviewIds.item]:{ncm:{source:'manual',value:'87654321'}}});await view.click('Consultar preparação salva');assert.equal(s.counts.writes,2);assert.equal(s.counts.readbacks,2);assert.equal(s.commands.size,1);assert.equal(field(view,'Valor de NCM').props.value,'87654321');assert.equal(view.guard().busy,false);
 }finally{view.unmount();}
});
test('035 UI stale readback cannot unlock a confirmed preparation',async()=>{
 let hide=true;const s=service({before(c,s){if(c.method==='GET'&&s.counts.readbacks&&hide){s.state.current=null;s.state.version=0;}}}),view=await mount(s);
 try{await prepare(view);await view.click('Salvar versão da preparação');assert.equal(view.guard().busy,true);hide=false;s.state.current=clone([...s.commands.values()][0]);s.state.version=1;await view.click('Consultar preparação salva');assert.equal(s.counts.writes,1);assert.equal(view.guard().busy,false);}finally{view.unmount();}
});
test('035 first409 requires fresh query/preview and a new command only after known rejection',async()=>{
 const s=service({before(c,s){if(c.method==='POST'&&!c.path.endsWith('/preview')&&s.counts.writes===1)throw new AccessError(409);}}),view=await mount(s);
 try{await prepare(view);await view.click('Salvar versão da preparação');assert.equal(s.commands.size,0);assert.equal(view.button('Conferir prévia dos itens').disabled,true);await view.click('Recarregar preparação e catálogo');await prepare(view);await view.click('Salvar versão da preparação');assert.notEqual(writes(s)[0].body.command_id,writes(s)[1].body.command_id);assert.equal(s.commands.size,1);}finally{view.unmount();}
});
test('035 UI reopens same-binding receipt preserving provenance but never inherits it after022 refresh',async()=>{
 const s=service();s.seed({[reviewIds.item]:{ncm:{source:'manual',value:'12345678'},origin:{source:'catalog',expected_product_id:reviewIds.product,expected_version:1}}});
 let view=await mount(s);assert.equal(field(view,'Valor de NCM').props.value,'12345678');assert.equal(field(view,'Escolha para Origem').props.value,'catalog');view.unmount();
 s.state.basis.draft.record.version=s.state.basis.draft.current.version=2;s.state.basis.draft.record.snapshot_hash='b'.repeat(64);s.revisions.set(2,clone(s.state.basis.draft.record));
 view=await mount(s);try{assert.equal(field(view,'Escolha para NCM').props.value,'unreviewed');assert.equal(field(view,'Escolha para Origem').props.value,'unreviewed');assert.match(view.text(),/não foram aplicadas à revisão 2/);assert.equal(view.guard().changed,false);await prepare(view);assert.equal(s.calls.findLast(c=>c.path.endsWith('/preview')).body.expected_version,1);}finally{view.unmount();}
});
test('035 restoring equivalent choices clears dirty regardless of insertion order, but provenance stays significant',async()=>{
 const s=service();s.seed({[reviewIds.item]:{ncm:{source:'catalog',expected_product_id:reviewIds.product,expected_version:1},cest:{source:'manual',value:null},gtin:{source:'manual',value:'SEM GTIN'}}});const view=await mount(s);
 try{
  await change(view,'Escolha para CEST','unreviewed');assert.equal(view.guard().changed,true);
  await change(view,'Escolha para CEST','empty');assert.equal(view.guard().changed,false);assert.equal(view.button('Descartar escolhas locais').disabled,true);
  await change(view,'Escolha para NCM','manual');await change(view,'Valor de NCM',s.state.current.items[0].fields.ncm.value);assert.equal(view.guard().changed,true);
  await view.click('Usar NCM do catálogo');assert.equal(view.guard().changed,false);assert.equal(s.counts.writes,0);
  const first={b:{gtin:{source:'manual',value:'SEM GTIN'},cest:{source:'manual',value:null}},a:{ncm:{source:'catalog',expected_product_id:reviewIds.product,expected_version:1}}};
  const reordered={a:{ncm:{expected_version:1,expected_product_id:reviewIds.product,source:'catalog'}},b:{cest:{value:null,source:'manual'},gtin:{value:'SEM GTIN',source:'manual'}}};
  assert.equal(itemChoicesKey(first),itemChoicesKey(reordered));reordered.a.ncm.expected_version=2;assert.notEqual(itemChoicesKey(first),itemChoicesKey(reordered));
 }finally{view.unmount();}
});
test('035 UI historical receipt is read-only and cannot change current choices or post',async()=>{
 const s=service();s.seed({[reviewIds.item]:{ncm:{source:'manual',value:'12345678'}}});s.seed({[reviewIds.item]:{ncm:{source:'manual',value:'87654321'}}});const view=await mount(s);
 try{await view.click('Histórico da preparação');await view.click('Consultar preparação 1');assert.match(view.text(),/Consulta imutável da preparação 1/);assert.match(view.text(),/selecione um item para consultar/);assert.doesNotMatch(view.text(),/item selecionado é editado/);assert.match(view.text(),/12345678/);assert.equal(view.nodes().filter(n=>n.type==='input').length,0);assert.equal(view.nodes().filter(n=>n.type==='fieldset'&&!n.disabled).length,0);assert.equal(s.counts.writes,0);await view.click('Voltar à preparação atual');assert.equal(field(view,'Valor de NCM').props.value,'87654321');assert.equal(view.guard().changed,false);}finally{view.unmount();}
});
test('035 UI blocked parent, invalid GTIN and read-only historical draft prevent preparation writes',async()=>{
 const s=service();let view=await mount(s,{blocked:true});assert.equal(view.button('Conferir prévia dos itens').disabled,true);assert.equal(field(view,'Escolha para NCM').disabled,true);view.unmount();
 view=await mount(s);try{await change(view,'Escolha para GTIN comercial','manual');await change(view,'Valor de GTIN comercial','6291041500214');assert.equal(field(view,'Valor de GTIN comercial').props['aria-invalid'],true);await view.click('Conferir prévia dos itens');assert.equal(s.counts.previews,0);assert.match(view.text(),/dígito verificador/);}finally{view.unmount();}
 s.state.basis.draft.current.version=2;view=await mount(s);try{assert.match(view.text(),/somente para consulta/);assert.equal(view.nodes().filter(n=>n.type==='fieldset'&&!n.disabled).length,0);assert.equal(s.counts.writes,0);}finally{view.unmount();}
});
test('035 parent editor blocks refresh/archive/save/navigation during uncertain child writes',async()=>{
 const s=service({after(){throw new AccessError(503);}}),closed=[];
 const view=await mountComponent('RealFiscalDrafts.tsx',{controller:s.controller,id:reviewIds.draft,onClose:()=>closed.push(true)},{componentName:'DraftEditor',expandChildren:['FiscalItemPreparation','PreparationFields','TaskMessage']});
 try{const stale=[view.button('Voltar à listagem'),view.button('Recarregar versão atual'),view.button('Conferir atualização da cópia'),view.button('Arquivar rascunho')];await prepare(view);
  assert.equal(field(view,'Natureza da operação').disabled,true);assert.equal(view.button('Recarregar versão atual').disabled,true);const before=s.counts.gets;await invoke(view,stale[1]);assert.equal(s.counts.gets,before);assert.equal(field(view,'Valor de NCM').props.value,'12345678');await view.click('Salvar versão da preparação');assert.equal(view.button('Voltar à listagem').disabled,true);assert.equal(view.button('Recarregar versão atual').disabled,true);for(const n of stale)await invoke(view,n);await view.submit();assert.equal(closed.length,0);assert.equal(s.counts.writes,1);assert.equal(view.button('Arquivar rascunho').disabled,true);
 }finally{view.unmount();}
});
test('035 model rejects malformed receipt/flags/provenance and preserves explicit null/SEM GTIN and decimals',async()=>{
 const s=service(),receipt=s.seed({[reviewIds.item]:{ncm:{source:'manual',value:'12345678'},cest:{source:'manual',value:null},gtin:{source:'manual',value:'SEM GTIN'}}}),raw=s.snapshot();
 const good=fiscalItemEnvelope(raw,reviewIds.draft);assert.equal(good.draft.record.snapshot.items[0].quantity,'1.230000');assert.deepEqual(choicesFromReceipt(receipt,s.state.basis.draft)[reviewIds.item].cest,{source:'manual',value:null});
 for(const mutate of[v=>v.can_emit=true,v=>v.record.draft_version=2,v=>v.record.items[0].fields.ncm.value='87654321 ',v=>v.record.items[0].fields.cest.value='0000000',v=>v.record.items[0].fields.gtin.check_digit_verified=true,v=>v.current.matches_current_draft=false]){const wrong=clone(raw);mutate(wrong);assert.throws(()=>fiscalItemEnvelope(wrong,reviewIds.draft));}
 assert.equal(itemValueValid('6291041500213','gtin'),true);assert.equal(itemValueValid('6291041500214','gtin'),false);assert.equal(itemValueValid('SEM GTIN','gtin'),true);assert.equal(itemValueValid(null,'cest'),true);assert.equal(itemValueValid('１２３４５６７','cest'),false);
});
