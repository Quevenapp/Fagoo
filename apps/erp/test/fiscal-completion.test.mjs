import test from 'node:test';
import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {reviewBasis,reviewIds} from '../../../packages/fiscal-core/test/review-fixtures.mjs';
import {prepareFiscalItems,ITEM_PREPARATION_FLAGS} from '../../../packages/fiscal-core/src/item-preparation.mjs';
import {buildFiscalReview} from '../../../packages/fiscal-core/src/review.mjs';
import {resolveTaxItems,TAX_PREPARATION_FLAGS} from '../../../packages/fiscal-core/src/tax-preparation.mjs';
import {COMPLETION_FLAGS,resolveBusinessCompletion} from '../../../packages/fiscal-core/src/business-completion.mjs';
import {completionEnvelope,completionHistory,completionBasis,completionFromReceipt,completionWrite,completionKey,completionInput,completionDisplay,emptyCompletion} from '../src/lib/fiscal-completion-model.ts';
import {fiscalItemEnvelope} from '../src/lib/fiscal-item-model.ts';
import {taxEnvelope} from '../src/lib/fiscal-tax-model.ts';

const clone=structuredClone,text=v=>Array.isArray(v)?v.map(text).join(''):v&&typeof v==='object'?text(v.props?.children):v==null||typeof v==='boolean'?'':String(v);
const field=(v,label)=>v.input(v.find(n=>n.type==='label'&&text(n)===label).props.htmlFor),change=(v,label,value)=>v.change(field(v,label).props.id,value);
const invoke=async(v,n)=>{n.props.onClick?.();await v.flush();};
function service({count=1,model='55',branch='102',before=()=>{},after=()=>{}}={}){
 const basis=reviewBasis({itemCount:count,model});basis.draft.record.snapshot.company={identity_version:1,fiscal_version:1,crt:'1',regime_confirmed:true,identity:{legal_name:'Empresa fictícia',trade_name:null,cnpj:'11222333000181',ie:null,postal_code:'13400000',street:'Rua fictícia',number:'1',complement:null,district:'Centro',city:'Piracicaba',municipality_code:'3538709',state:'SP'}};basis.draft.current.identity_version=basis.draft.current.fiscal_version=1;basis.draft.pending=basis.draft.pending.filter(x=>!['COMPANY_IDENTITY_MISSING','REGIME_UNCONFIRMED'].includes(x));
 const state={basis,current:null,version:0,itemVersion:1,taxVersion:1,branch},receipts=new Map(),commands=new Map(),revisions=new Map([[1,clone(basis.draft.record)]]),calls=[],counts={writes:0,gets:0,readbacks:0,previews:0};
 const s={state,receipts,commands,revisions,calls,counts};
 s.prepare=()=>{const d=state.basis.draft,p=prepareFiscalItems({basis:state.basis,expected:{draft_id:d.record.id,draft_version:d.record.version,snapshot_hash:d.record.snapshot_hash},decisions:[]});return{data_mode:'fiscal_item_preparation',profile:'item-identification-v1',schema_profile:'pl010f-v1.04',...ITEM_PREPARATION_FLAGS,record:{draft_id:reviewIds.draft,version:state.itemVersion,draft_version:d.record.version,snapshot_hash:d.record.snapshot_hash,model:d.record.model,environment:'2',source_document_id:reviewIds.order,source_document_version:d.record.source_document_version,created_at:'2026-10-16T13:00:00Z',items:p.items},draft:clone(d),current:{preparation_version:state.itemVersion,draft_version:d.current.version,matches_current_draft:d.current.version===d.record.version}};};
 s.tax=()=>{const d=state.basis.draft,b=s.prepare().record.items.map(i=>({item_id:i.item_id,position:i.position,product_id:i.product_id,identifiers:Object.fromEntries(Object.entries(i.fields).map(([k,v])=>[k,v.value]))})),sn=state.branch==='101'?{csosn:'101',credit_rate:null,credit_period:null,credit_evidence:null}:state.branch==='500'?{csosn:'500',retention:{base:null,rate:null,substitute_icms:null,retained_icms:null},fcp:{base:null,rate:null,amount:null},effective:{reduction_rate:null,base:null,rate:null,amount:null}}:state.branch===null?null:{csosn:'102'};
  return{data_mode:'fiscal_tax_preparation',profile:'sn-internal-sale-preparation-v1',schema_profile:'pl010f-v1.04',...TAX_PREPARATION_FLAGS,record:{draft_id:d.record.id,version:state.taxVersion,draft_version:d.record.version,snapshot_hash:d.record.snapshot_hash,item_preparation_version:state.itemVersion,model:d.record.model,environment:'2',operation:'internal_normal_sale',crt:'1',company_identity_version:1,company_fiscal_version:1,source_document_id:reviewIds.order,source_document_version:d.record.source_document_version,created_at:'2026-10-16T13:00:00Z',items:resolveTaxItems({model:d.record.model,items:b,decisions:b.map(i=>({item_id:i.item_id,cfop:'5102',icms:clone(sn),pis:null,cofins:null,review_note:null}))})},current:{tax_version:state.taxVersion,draft_version:d.current.version,item_preparation_version:state.itemVersion,draft_status:d.current.status,source_status:d.current.source_status,source_changed:d.current.source_changed,company_changed:d.current.company_changed,matches_current_draft:true,matches_current_item_preparation:true}};};
 s.envelope=(record,extras={})=>{const d=state.basis.draft;return{...COMPLETION_FLAGS,record:clone(record),current:{completion_version:state.version,draft_version:d.current.version,draft_status:d.current.status,source_document_version:d.current.source_document_version,source_status:d.current.source_status,source_changed:d.current.source_changed,company_changed:d.current.company_changed,identity_version:d.current.identity_version,fiscal_version:d.current.fiscal_version,item_preparation_version:state.itemVersion,tax_preparation_version:state.taxVersion,matches_current_draft:record!==null&&record.draft_version===d.current.version,matches_current_item_preparation:record!==null&&record.item_preparation_version===state.itemVersion,matches_current_tax_preparation:record!==null&&record.tax_preparation_version===state.taxVersion,matches_current_company:record!==null&&record.company_identity_version===d.current.identity_version&&record.company_fiscal_version===d.current.fiscal_version},...extras};};
 s.basis=()=>completionBasis(state.basis.draft,fiscalItemEnvelope(s.prepare(),reviewIds.draft),taxEnvelope(s.tax(),reviewIds.draft),s.envelope(state.current).current);
 const resolve=body=>{const d=state.basis.draft,b=s.basis();return{draft_id:d.record.id,version:body.expected_completion_version+1,draft_version:body.expected_draft_version,snapshot_hash:body.snapshot_hash,item_preparation_version:body.item_preparation_version,tax_preparation_version:body.tax_preparation_version,item_preparation_hash:'c'.repeat(64),tax_preparation_hash:'d'.repeat(64),model:d.record.model,environment:'2',company_identity_version:body.expected_identity_version,company_fiscal_version:body.expected_fiscal_version,source_document_id:reviewIds.order,source_document_version:d.record.source_document_version,created_at:'2026-10-16T13:00:00.123456Z',item_basis:clone(b.items),...resolveBusinessCompletion(body.completion,b)};};
 s.controller={async fiscalItem(){return s.prepare();},async fiscalTax(){return s.tax();},async fiscalDraft(path){const d=clone(state.basis.draft),version=Number(path.split('/revisions/')[1]);if(version)d.record=clone(revisions.get(version));return d;},async fiscalCompletion(path,options={}){
  const call={path,method:options.method??'GET',body:clone(options.body),signal:options.signal};calls.push(call);
  if(path.includes('/history?')){await before(call,s);const beforeVersion=Number(new URL(path,'https://fixture.invalid').searchParams.get('before')||2147483648),rows=[...receipts.values()].sort((a,b)=>b.version-a.version).filter(r=>r.version<beforeVersion);return{...COMPLETION_FLAGS,draft_id:reviewIds.draft,items:rows.slice(0,25).map(({item_basis,completion,pending,...meta})=>clone(meta)),limit:25,has_more:rows.length>25,next_cursor:rows.length>25?rows[24].version:null};}
  if(call.method==='GET'){counts.gets++;if(commands.size)counts.readbacks++;await before(call,s);const version=new URL(path,'https://fixture.invalid').searchParams.get('version');return s.envelope(version?receipts.get(Number(version)):state.current);}
  if(path.endsWith('/preview')){counts.previews++;await before(call,s);return s.envelope({...resolve(call.body),created_at:null},{persisted:false,expected_completion_version:call.body.expected_completion_version});}
  counts.writes++;await before(call,s);let record=commands.get(call.body.command_id),replayed=Boolean(record);if(!record){record=resolve(call.body);commands.set(call.body.command_id,clone(record));receipts.set(record.version,clone(record));state.current=clone(record);state.version=record.version;}await after(call,s);return s.envelope(record,{replayed});
 }};
 s.seed=(completion=emptyCompletion(state.basis.draft.record.snapshot.items.map(i=>i.id)))=>{const body=completionWrite(state.basis.draft,s.basis(),s.envelope(state.current).current,completion),r=resolve(body);receipts.set(r.version,clone(r));state.current=r;state.version=r.version;return r;};return s;
}
const mount=(s,props={})=>mountComponent('FiscalBusinessCompletion.tsx',{controller:s.controller,value:clone(s.state.basis.draft),...props},{expandChildren:true});
const writes=s=>s.calls.filter(c=>c.path.endsWith('/save'));
test('057 completion displays commercial price10 without copying it into tributary price',async()=>{
 const s=service();s.state.basis.draft.record.snapshot.items[0].unit_price='10.0000000001';const view=await mount(s);
 try{assert.match(view.text(),/preço R\$ 10,0000000001/);assert.equal(field(view,'Preço unitário tributário').props.value,'');assert.equal(field(view,'Quantidade tributária').props.value,'');assert.equal(s.counts.writes,0);assert.equal(s.counts.previews,0);assert.equal(view.guard().changed,false);}finally{view.unmount();}
});
async function preview(v){await v.click('Conferir prévia do complemento');const checkbox=v.find(n=>n.type==='input'&&n.props.type==='checkbox');assert.equal(checkbox.props.checked,false);checkbox.props.onChange({target:{checked:true}});await v.flush();}

test('047 commercial reuse fills only five empty totals locally and persists only through the existing explicit save',async()=>{
 const s=service(),v=await mount(s);try{
  await change(v,'Total · PIS','1,01');await change(v,'Frete destinado ao item','5,03');const before=s.calls.length;
  await v.click('Preencher totais do pedido');assert.equal(s.calls.length,before);assert.equal(s.counts.writes,0);assert.equal(field(v,'Total · Produtos').props.value,'12,30');assert.equal(field(v,'Total · Desconto').props.value,'0,00');assert.equal(field(v,'Total · Frete').props.value,'0,00');assert.equal(field(v,'Total · Outras despesas').props.value,'0,00');assert.equal(field(v,'Total · Total da nota').props.value,'12,30');assert.equal(field(v,'Total · PIS').props.value,'1,01');assert.equal(field(v,'Total · ICMS').props.value,'');assert.equal(field(v,'Frete destinado ao item').props.value,'5,03');assert.equal(field(v,'Troco declarado').props.value,'');assert.equal(v.guard().changed,true);
  assert.equal(v.nodes().some(n=>n.type==='button'&&text(n)==='Aplicar totais do pedido'),false);await preview(v);const oldSave=v.button('Salvar versão do complemento');await v.click('Preencher totais do pedido');await invoke(v,oldSave);assert.equal(s.counts.writes,0);await preview(v);await v.click('Salvar versão do complemento');assert.equal(s.state.current.completion.totals.vNF,'12.30');assert.equal(s.state.current.completion.totals.vPIS,'1.01');assert.equal(v.guard().changed,false);await v.click('Preencher totais do pedido');assert.equal(v.guard().changed,false);
 }finally{v.unmount();}
});
test('047 differing commercial values show current versus proposed, with explicit apply/cancel and no checkbox',async()=>{
 const s=service(),v=await mount(s);try{
  await change(v,'Total · Total da nota','99,99');await v.click('Preencher totais do pedido');assert.equal(field(v,'Total · Total da nota').props.value,'99,99');assert.match(v.text(),/Conferir substituição dos totais/);assert.match(v.text(),/99,99/);assert.equal(v.nodes().some(n=>n.type==='input'&&n.props.type==='checkbox'),false);assert.equal(v.button('Conferir prévia do complemento').disabled,true);
  const oldApply=v.button('Aplicar totais do pedido');await v.click('Cancelar substituição');await invoke(v,oldApply);assert.equal(field(v,'Total · Total da nota').props.value,'99,99');await v.click('Preencher totais do pedido');await v.click('Aplicar totais do pedido');assert.equal(field(v,'Total · Total da nota').props.value,'12,30');assert.equal(s.counts.writes,0);assert.equal(s.counts.previews,0);
 }finally{v.unmount();}
});
test('047 commercial review is invalidated by edits and refreshed bases; stale handlers cannot override either',async()=>{
 const s=service(),v=await mount(s);try{
  await change(v,'Total · Frete','7,00');await v.click('Preencher totais do pedido');const first=v.button('Aplicar totais do pedido');await change(v,'Total · Frete','8,00');await invoke(v,first);assert.equal(field(v,'Total · Frete').props.value,'8,00');await v.click('Preencher totais do pedido');const second=v.button('Aplicar totais do pedido');await v.updateProps({blocked:true});await invoke(v,second);assert.equal(field(v,'Total · Frete').props.value,'8,00');await v.updateProps({blocked:false});s.state.taxVersion++;await v.updateProps({refreshKey:1});await invoke(v,second);assert.equal(field(v,'Total · Frete').props.value,'8,00');assert.equal(v.button('Preencher totais do pedido').disabled,true);assert.equal(s.counts.writes,0);
 }finally{v.unmount();}
});
test('047 commercial reuse refuses inconsistent snapshot totals and stays unavailable in history',async()=>{
 const s=service(),v=await mount(s);try{const invalid=clone(s.state.basis.draft);invalid.record.snapshot.totals.total='99.00';await v.updateProps({value:invalid});await v.click('Preencher totais do pedido');assert.match(v.text(),/Não foi possível reaproveitar/);assert.equal(field(v,'Total · Produtos').props.value,'');assert.equal(field(v,'Total · Total da nota').props.value,'');assert.equal(v.guard().changed,false);assert.equal(s.counts.writes,0);}finally{v.unmount();}
 const historic=service();historic.seed();const w=await mount(historic);try{const old=w.button('Preencher totais do pedido');await w.click('Histórico do complemento');await w.click('Consultar complemento 1');await invoke(w,old);assert.equal(w.nodes().some(n=>n.type==='button'&&text(n)==='Preencher totais do pedido'),false);assert.equal(field(w,'Total · Produtos').props.value,'');assert.equal(historic.counts.writes,0);}finally{w.unmount();}
});
test('047 payment indicator uses explicit amounts and change without filling methods, taxes or financial records',async()=>{
 const s=service(),v=await mount(s);try{
  await v.click('Preencher totais do pedido');await v.click('Adicionar pagamento declarado');await change(v,'Valor do pagamento 1','12,30');assert.match(v.text(),/Comparação indisponível/);assert.equal(field(v,'Troco declarado').props.value,'');await change(v,'Troco declarado','0,00');assert.match(v.text(),/Pagamentos menos troco coincidem/);assert.equal(field(v,'Forma do pagamento 1').props.value,'');assert.equal(field(v,'Prazo do pagamento 1').props.value,'');await change(v,'Valor do pagamento 1','12,29');assert.match(v.text(),/R\$ 0,01 abaixo/);await change(v,'Valor do pagamento 1','12,31');assert.match(v.text(),/R\$ 0,01 acima/);await change(v,'Valor do pagamento 1','');assert.match(v.text(),/Comparação indisponível/);assert.equal(s.counts.writes,0);
 }finally{v.unmount();}
});

test('047 UI starts with explicit nulls for250 items, keeps zero/precision exact and saves only after preview/confirmation',async()=>{
 const s=service({count:250}),v=await mount(s);try{
  assert.equal(field(v,'Tipo da operação').props.value,'');assert.equal(field(v,'Quantidade tributária').props.value,'');assert.equal(field(v,'Total · Total da nota').props.value,'');assert.equal(s.counts.writes,0);
  await change(v,'Quantidade tributária','1,234500');await change(v,'Preço unitário tributário','99999999999,1234567890');await change(v,'Frete destinado ao item','0,00');await change(v,'Total · Total da nota','9999999999999,99');
  await v.click('Conferir prévia do complemento');assert.equal(v.button('Salvar versão do complemento').disabled,true);v.find(n=>n.type==='input'&&n.props.type==='checkbox').props.onChange({target:{checked:true}});await v.flush();await v.click('Salvar versão do complemento');
  const r=s.state.current;assert.equal(r.completion.items.length,250);assert.equal(r.completion.items[0].tributary.quantity,'1.234500');assert.equal(r.completion.items[0].tributary.unit_price,'99999999999.1234567890');assert.equal(r.completion.items[0].allocations.freight,'0.00');assert.equal(r.completion.items[1].tributary.quantity,null);assert.equal(r.completion.totals.vNF,'9999999999999.99');assert.equal(r.completion.totals.vICMS,null);assert.equal(v.guard().changed,false);assert.equal(v.guard().busy,false);assert.equal(s.commands.size,1);assert.match(v.text(),/Nenhum tributo, número ou XML/);assert.equal(s.state.basis.draft.record.snapshot.items[0].quantity,'1.230000');assert.equal(s.calls.some(c=>/reserv|xml|sign|emit/.test(c.path)),false);
 }finally{v.unmount();}
});
test('047 branch101/500 controls follow captured tax choice, payments are explicit and comma conversion never rounds',async()=>{
 const s=service({branch:'101'}),v=await mount(s);try{
  assert.equal(field(v,'Base declarada do crédito de ICMS').props.value,'');await change(v,'Valor declarado do crédito de ICMS','0,00');await v.click('Adicionar pagamento declarado');assert.equal(field(v,'Forma do pagamento 1').props.value,'');await change(v,'Forma do pagamento 1','15');await change(v,'Valor do pagamento 1','12,34');await change(v,'Quantidade tributária','1,234567');await preview(v);assert.match(v.text(),/precisão que exige revisão/);await v.click('Salvar versão do complemento');assert.equal(s.state.current.completion.items[0].icms.credit.base,null);assert.equal(s.state.current.completion.items[0].icms.credit.amount,'0.00');assert.equal(s.state.current.completion.payments.items[0].timing,null);assert.equal(s.state.current.completion.payments.items[0].amount,'12.34');
 }finally{v.unmount();}
 const other=service({branch:'500',model:'65'}),w=await mount(other);try{assert.equal(w.nodes().some(n=>n.type==='label'&&text(n)==='Base declarada do crédito de ICMS'),false);await change(w,'Grupo de ICMS retido anteriormente','omit');await change(w,'Grupo de fundo de combate à pobreza retido','include');await preview(w);await w.click('Salvar versão do complemento');assert.deepEqual(other.state.current.completion.items[0].icms.groups500,{retention:'omit',fcp:'include',effective:null});}finally{w.unmount();}
});
for(const status of[403,409])test(`047 lost committed reply then${status} preserves command/body and guards every stale mutation/reset handler`,async()=>{
 const s=service({after(c,s){if(s.counts.writes===1)throw new AccessError(503);},before(c,s){if(c.path.endsWith('/save')&&s.counts.writes===2)throw new AccessError(status);}}),v=await mount(s);try{
  await change(v,'Total · Frete','12,34');await preview(v);const stale=[v.button('Recarregar bases do complemento'),v.button('Histórico do complemento'),v.button('Descartar escolhas do complemento'),v.button('Conferir prévia do complemento'),v.button('Salvar versão do complemento'),v.button('Preencher totais do pedido')],old=field(v,'Total · Frete');await v.click('Salvar versão do complemento');await v.click('Repetir a mesma confirmação do complemento');assert.equal(v.guard().busy,true);assert.equal(field(v,'Total · Frete').disabled,true);const count=s.calls.length;for(const n of stale)await invoke(v,n);old.props.onChange({target:{value:'99,99'}});await v.flush();await v.updateProps({refreshKey:1});assert.equal(s.calls.length,count);assert.equal(field(v,'Total · Frete').props.value,'12,34');await v.click('Repetir a mesma confirmação do complemento');assert.equal(s.commands.size,1);assert.equal(s.counts.writes,3);for(const c of writes(s))assert.deepEqual(c.body,writes(s)[0].body);assert.equal(v.guard().busy,false);
 }finally{v.unmount();}
});
test('047 afterACK and failed readback only GET repeats, current newer receipt replaces historical acknowledgement',async()=>{
 const s=service({before(c,s){if(c.method==='GET'&&s.counts.readbacks===1)throw new AccessError(503);}}),v=await mount(s);try{await preview(v);await v.click('Salvar versão do complemento');assert.equal(v.guard().busy,true);assert.equal(s.counts.writes,1);const newer=emptyCompletion([reviewIds.item]);newer.totals.vFrete='25.00';s.seed(newer);await v.click('Consultar complemento salvo');assert.equal(s.counts.writes,1);assert.equal(field(v,'Total · Frete').props.value,'25,00');assert.equal(v.guard().changed,false);assert.equal(v.guard().busy,false);}finally{v.unmount();}
});
test('047 known conflict requires explicit fresh bases; failed reload never enables editing',async()=>{
 let failReload=true;const s=service({before(c,s){if(c.path.endsWith('/save')&&s.counts.writes===1)throw new AccessError(409);if(c.method==='GET'&&s.counts.gets===2&&failReload)throw new AccessError(503);}}),v=await mount(s);try{await preview(v);await v.click('Salvar versão do complemento');assert.equal(v.button('Conferir prévia do complemento').disabled,true);await v.click('Recarregar bases do complemento');assert.equal(v.nodes().some(n=>n.type==='button'&&text(n)==='Conferir prévia do complemento'&&!n.disabled),false);failReload=false;await v.click('Recarregar bases do complemento');await preview(v);await v.click('Salvar versão do complemento');assert.equal(s.commands.size,1);assert.notEqual(writes(s)[0].body.command_id,writes(s)[1].body.command_id);}finally{v.unmount();}
});
test('047 changed tax base never inherits old choices and dirty form survives refresh until explicit discard/reload',async()=>{
 const s=service(),form=emptyCompletion([reviewIds.item]);form.totals.vFrete='25.00';s.seed(form);const v=await mount(s);try{
  assert.equal(field(v,'Total · Frete').props.value,'25,00');s.state.taxVersion=2;await v.updateProps({refreshKey:1});assert.equal(field(v,'Total · Frete').props.value,'');assert.match(v.text(),/não foram transferidas/);await change(v,'Total · Frete','3,00');s.state.taxVersion=3;await v.updateProps({refreshKey:2});assert.equal(field(v,'Total · Frete').props.value,'3,00');assert.equal(v.button('Conferir prévia do complemento').disabled,true);assert.match(v.text(),/escolhas locais foram preservadas/);await v.click('Recarregar bases do complemento');assert.equal(field(v,'Total · Frete').props.value,'');assert.equal(v.guard().changed,false);
 }finally{v.unmount();}
});
test('047 history is metadata-paginated and readonly, restores exact draft snapshot without carrying its fields into current',async()=>{
 const s=service();for(let i=0;i<27;i++){const f=emptyCompletion([reviewIds.item]);f.totals.vFrete=`${i}.00`;s.seed(f);}const v=await mount(s);try{
  await v.click('Histórico do complemento');assert.equal(v.nodes().filter(n=>n.type==='tbody')[0].props.children.length,25);await v.click('Complementos mais antigos');await v.click('Consultar complemento 1');assert.match(v.text(),/Consulta histórica imutável/);assert.equal(field(v,'Total · Frete').props.value,'0,00');assert.equal(field(v,'Total · Frete').disabled,true);assert.equal(v.nodes().some(n=>n.type==='button'&&text(n)==='Salvar versão do complemento'),false);await v.click('Voltar ao complemento atual');assert.equal(field(v,'Total · Frete').props.value,'26,00');assert.equal(s.counts.writes,0);
 }finally{v.unmount();}
});
test('047 invalid formats never reach preview; blocked or archived parent never enables writing',async()=>{
 const s=service(),v=await mount(s);try{await change(v,'Total · Frete','1,001');assert.equal(field(v,'Total · Frete').props['aria-invalid'],true);await v.click('Conferir prévia do complemento');assert.equal(s.counts.previews,0);await change(v,'Total · Frete','');assert.equal(field(v,'Total · Frete').props['aria-invalid'],false);await v.updateProps({blocked:true});assert.equal(v.button('Conferir prévia do complemento').disabled,true);}finally{v.unmount();}
 s.state.basis.draft.current.status='archived';const w=await mount(s);try{assert.equal(w.nodes().some(n=>n.type==='button'&&text(n)==='Conferir prévia do complemento'),false);assert.equal(s.counts.writes,0);}finally{w.unmount();}
});
test('047 unmount aborts a pending write; late ACK cannot read back or affect parent',async()=>{
 let release;const pending=new Promise(r=>release=r),events=[],s=service({after:()=>pending}),v=await mount(s,{onBusy:x=>events.push(x)});await preview(v);v.button('Salvar versão do complemento').props.onClick();await v.flush();const write=writes(s)[0];assert.equal(write.signal.aborted,false);v.unmount();const count=events.length;release();await new Promise(r=>setTimeout(r,10));assert.equal(write.signal.aborted,true);assert.equal(s.counts.readbacks,0);assert.equal(events.length,count);
});
test('047 integrated DraftEditor freezes siorigin/general handlers through dirty, pending, uncertain and ACK/readback recovery',async()=>{
 let releasePost;const postGate=new Promise(resolve=>releasePost=resolve),closed=[],otherCalls=[];
 const s=service({after:async(c,s)=>{if(s.counts.writes===1){await postGate;throw new AccessError(503);}},before(c,s){if(c.method==='GET'&&s.counts.readbacks===1)throw new AccessError(503);}});
 for(const method of['fiscalDraft','fiscalItem','fiscalTax']){const original=s.controller[method];s.controller[method]=async(path,options={})=>{otherCalls.push({method,path,verb:options.method??'GET'});return method==='fiscalDraft'&&path.includes('/conferencia?')?buildFiscalReview(s.state.basis):original(path,options);};}
 const v=await mountComponent('RealFiscalDrafts.tsx',{controller:s.controller,id:reviewIds.draft,onClose:()=>closed.push(true)},{componentName:'DraftEditor',expandChildren:['FiscalItemPreparation','FiscalTaxPreparation','FiscalBusinessCompletion','TaxValue','ReceiptValues','PreparationFields','TaskMessage','Choice','Value','Pending']});
 try{
  const labels=['Recarregar versão atual','Conferir atualização da cópia','Arquivar rascunho','Conferir prévia dos itens','Conferir prévia tributária'];
  const old=Object.fromEntries([...labels,'Voltar à listagem','Descartar alterações'].map(name=>[name,v.button(name)]));
  const oldNcm=field(v,'Escolha para NCM'),oldCfop=field(v,'CFOP declarado'),oldGeneralForm=v.nodes().find(n=>n.type==='form');
  assert.equal(field(v,'Natureza da operação').disabled,false);assert.equal(oldNcm.disabled,false);assert.equal(oldCfop.disabled,false);
  await change(v,'Total · Frete','12,34');
  for(const name of labels)assert.equal(v.button(name).disabled,true,name);
  for(const label of['Natureza da operação','Escolha para NCM','CFOP declarado'])assert.equal(field(v,label).disabled,true,label);
  const unchanged=otherCalls.length;
  for(const name of labels)await invoke(v,old[name]);
  oldNcm.props.onChange({target:{value:'manual'}});oldCfop.props.onChange({target:{value:'5101'}});
  oldGeneralForm.props.onSubmit({preventDefault(){}});await v.flush();
  assert.equal(otherCalls.length,unchanged);assert.equal(field(v,'CFOP declarado').props.value,'5102');assert.equal(field(v,'Escolha para NCM').props.value,oldNcm.props.value);
  await preview(v);v.button('Salvar versão do complemento').props.onClick();await v.flush();
  assert.equal(s.counts.writes,1);assert.equal(s.commands.size,1);assert.equal(field(v,'Total · Frete').disabled,true);
  const assertLocked=async(expectedWrites=1)=>{
   const count=otherCalls.length;
   for(const name of [...labels,'Voltar à listagem','Descartar alterações']){assert.equal(v.button(name).disabled,true,name);await invoke(v,old[name]);}
   oldGeneralForm.props.onSubmit({preventDefault(){}});await v.flush();
   assert.equal(closed.length,0);assert.equal(otherCalls.length,count);assert.equal(s.counts.writes,expectedWrites);assert.equal(field(v,'Total · Frete').props.value,'12,34');
  };
  await assertLocked(); // The write is still in flight, even though synthetic storage committed.
  releasePost();await v.flush();await assertLocked(); // Lost response must keep the same command.
  await v.click('Repetir a mesma confirmação do complemento');
  assert.equal(s.counts.writes,2);assert.deepEqual(writes(s)[0].body,writes(s)[1].body);
  await assertLocked(2);
  assert.equal(field(v,'Total · Frete').disabled,true);assert.equal(v.button('Consultar complemento salvo').disabled,false);
  const beforeGet=s.counts.writes;await v.click('Consultar complemento salvo');assert.equal(s.counts.writes,beforeGet);assert.equal(s.commands.size,1);
  for(const name of [...labels,'Voltar à listagem'])assert.equal(v.button(name).disabled,false,name);
  for(const label of['Natureza da operação','Escolha para NCM','CFOP declarado','Total · Frete'])assert.equal(field(v,label).disabled,false,label);
  assert.equal(otherCalls.some(c=>c.verb!=='GET'),false);await v.click('Voltar à listagem');assert.equal(closed.length,1);
 }finally{releasePost();v.unmount();}
});
test('047 model strips metadata extras, validates calendar/claims/currentbindings and preserves canonical keys and exact decimals',()=>{
 const s=service(),f=emptyCompletion([reviewIds.item]);f.items[0].tributary.quantity='1.234500';f.totals.vNF='9999999999999.99';const r=s.seed(f),raw=s.envelope(r);
 assert.equal(completionEnvelope(raw,reviewIds.draft).record.completion.totals.vNF,'9999999999999.99');for(const mutate of[v=>v.can_emit=true,v=>v.record.pending.general=[],v=>v.record.created_at='2026-02-30T12:00:00Z',v=>v.record.completion.totals.vNF=10,v=>v.record.item_basis[0].item_id='b0000000-0000-4000-8000-000000000001',v=>v.current.matches_current_company=false,v=>v.current.draft_version=0]){const bad=clone(raw);mutate(bad);assert.throws(()=>completionEnvelope(bad,reviewIds.draft));}
 const extra=clone(raw);extra.secret='PRIVATE';extra.record.actor='PRIVATE';assert.doesNotMatch(JSON.stringify(completionEnvelope(extra,reviewIds.draft)),/PRIVATE/);
 const reverse=v=>Array.isArray(v)?v.map(reverse):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).reverse().map(([k,x])=>[k,reverse(x)])):v;
 assert.equal(completionKey(f),completionKey(reverse(f)));assert.equal(completionInput('99999999999,1234567890'),'99999999999.1234567890');assert.equal(completionInput(''),null);assert.equal(completionDisplay(null),'');assert.equal(completionDisplay('0.00'),'0,00');assert.equal(completionDisplay('1.234500'),'1,234500');
 const basis=s.basis();assert.deepEqual(completionFromReceipt(r,s.state.basis.draft,basis),f);s.state.taxVersion++;assert.deepEqual(completionFromReceipt(r,s.state.basis.draft,s.basis()),emptyCompletion([reviewIds.item]));assert.throws(()=>completionHistory({...COMPLETION_FLAGS,draft_id:reviewIds.draft,items:[r,r],limit:25,has_more:false,next_cursor:null},reviewIds.draft,null));
});

test('215 a completion without receipt starts with the Contribuinte of the contact as indIEDest; a typed choice or a model 65 draft is never overwritten', async () => {
  const s = service(), contactId = s.state.basis.draft.record.snapshot.contact_id, asked = [];
  const contact = { contact_id: contactId, name: 'Cliente fictício', code: null, active: true, trade_name: null, person_type: 'J', document: null, ie: null, email: null, phone: null, mobile: null, postal_code: null, street: null,
    number: null, complement: null, district: null, city: null, state: null, taxpayer: '1', country: null, nfe_email: null };
  s.controller.fiscalInvoices = async path => { asked.push(path); return { contact, nature: null, seller: null, writable: true, data_mode: 'erp_native' }; };
  const view = await mount(s);
  try {
    await view.flush();
    assert.deepEqual(asked, [`/v1/notas-fiscais/contato/${contactId}?direction=1`]);
    assert.equal(field(view, 'Condição do destinatário perante o ICMS').props.value, '1');
    assert.equal(view.guard().changed, false, 'the cadastro value is the starting point, not an unsaved change');
    assert.match(view.text(), /Contribuinte do cadastro do contato/);
  } finally { view.unmount(); }
  const typed = service(); let release; const slow = new Promise(resolve => { release = resolve; });
  typed.controller.fiscalInvoices = async () => { await slow; return { contact: { ...contact, contact_id: typed.state.basis.draft.record.snapshot.contact_id }, nature: null, seller: null, writable: true, data_mode: 'erp_native' }; };
  const second = await mount(typed);
  try {
    await change(second, 'Condição do destinatário perante o ICMS', '9');
    release(); await new Promise(r => setTimeout(r, 20)); await second.flush();
    assert.equal(field(second, 'Condição do destinatário perante o ICMS').props.value, '9', 'a late answer never replaces the choice of the user');
  } finally { second.unmount(); }
  const nfce = service({ model: '65' }), calls = [];
  nfce.controller.fiscalInvoices = async path => { calls.push(path); return null; };
  const third = await mount(nfce);
  try { await third.flush(); assert.deepEqual(calls, [], 'the NFC-e recipient is always não contribuinte'); } finally { third.unmount(); }
});
