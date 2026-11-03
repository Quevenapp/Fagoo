import test from 'node:test';
import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {numberingCompany,numberingPage,numberingSeries,numberingMatchesCompany,numberingListPath,numberingLookup,numberingInitialForm,numberingConfigBody,numberingConfigCommand} from '../src/lib/fiscal-numbering-model.ts';

const id=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`,at='2026-10-16T12:00:00.123456Z';
const FLAGS={data_mode:'fiscal_numbering',policy:'brufap-homologation-exclusive-v1',environment:'2',can_emit:false,can_transmit:false,authorized:false,financial_mutation_performed:false,stock_mutation_performed:false};
const company={section:'identity',data_mode:'erp_native',emission_enabled:false,record:{version:1,data:{legal_name:'EMPRESA INTEIRAMENTE FICTÍCIA',cnpj:'11222333000181',state:'SP',secret:'DO_NOT_PROJECT'}}};
const initial={id:id(1),issuer_cnpj:'11222333000181',cuf:'35',model:'55',environment:'2',series:'10',first_number:'1',next_number:'1',exhausted:false,version:1,identity_version:1,enabled:true,exclusive_use_confirmed:true,reference:'Conferência sintética de exclusividade',created_at:at,updated_at:at,company_changed:false};
const page=(items,limit=25,more=false)=>({...FLAGS,read_only:true,items,limit,has_more:more,next_cursor:more?items.at(-1).id:null});
const clone=v=>structuredClone(v);
const form=()=>({...numberingInitialForm(null),model:'55',series:'10',initial_number:'1',enabled:'enabled',exclusive_use_confirmed:true,reference:'Uso exclusivo sintético conferido'});
const body=()=>numberingConfigBody(form(),null,numberingCompany(company),id(99));
const ack=(b,current={...initial,reference:b.reference})=>({...FLAGS,command_id:b.command_id,action:'configure',replayed:false,receipt:{...initial,reference:b.reference},current_series:current,current_basis:null});

test('series form has no model, series, number, status or exclusivity default; canonical ranges and explicit binding are enforced',()=>{
 const empty=numberingInitialForm(null);assert.deepEqual(empty,{model:'',series:'',initial_number:'',enabled:'',exclusive_use_confirmed:false,reference:''});
 const loaded=numberingInitialForm(initial);assert.equal(loaded.exclusive_use_confirmed,false);assert.equal(loaded.reference,'');assert.equal(loaded.series,'10');
 const b=body();assert.equal(b.environment,'2');assert.equal(b.expected_identity_version,1);assert.equal(b.expected_version,0);assert.equal(b.id,null);assert.equal(b.initial_number,'1');assert.equal('next_number'in b,false);
 for(const patch of [{model:''},{series:'001'},{series:'890'},{series:'-1'},{series:'1.0'},{initial_number:'01'},{initial_number:'0'},{initial_number:'1000000000'},{enabled:''},{exclusive_use_confirmed:false},{reference:'\u00a0'.repeat(3)},{reference:'x\ny'},{reference:'x'.repeat(241)}])assert.throws(()=>numberingConfigBody({...form(),...patch},null,numberingCompany(company),id(99)));
 const disabled=numberingConfigBody({...form(),enabled:'disabled',exclusive_use_confirmed:false},null,numberingCompany(company),id(99));assert.equal(disabled.enabled,false);assert.equal(disabled.exclusive_use_confirmed,false);
 assert.throws(()=>numberingConfigBody(form(),null,null,id(99)));assert.throws(()=>numberingConfigBody(form(),null,{...numberingCompany(company),state:'RJ'},id(99)));
 for(const patch of [{series:'11'},{initial_number:'2'},{model:'65'}])assert.throws(()=>numberingConfigBody({...loaded,reference:'Nova referência',exclusive_use_confirmed:true,...patch},initial,numberingCompany(company),id(99)));
});
test('company and series DTOs reject false readiness, impossible dates, invalid counter progress and private projections',()=>{
 assert.deepEqual(numberingCompany(company),{version:1,legal_name:company.record.data.legal_name,cnpj:initial.issuer_cnpj,state:'SP'});assert.equal(numberingCompany({...company,record:null}),null);
 const long=clone(company);long.record.data.legal_name='😀'.repeat(200);assert.equal(numberingCompany(long).legal_name.length,400);long.record.data.legal_name+='😀';assert.throws(()=>numberingCompany(long));
 assert.doesNotMatch(JSON.stringify(numberingSeries({...initial,xml:'DO_NOT_PROJECT',certificate:'DO_NOT_PROJECT'})),/DO_NOT_PROJECT/);
 for(const patch of [{series:'010'},{number:1,first_number:1},{next_number:'2'},{next_number:null},{enabled:true,exclusive_use_confirmed:false},{company_changed:null},{updated_at:'2026-02-30T12:00:00Z'},{updated_at:'2026-10-16T12:00:00+14:01'},{issuer_cnpj:'11111111111111'}])assert.throws(()=>numberingSeries({...initial,...patch}));
 for(const patch of [{can_emit:true},{can_transmit:true},{environment:'1'},{read_only:false}])assert.throws(()=>numberingPage({...page([initial]),...patch}));
 assert.throws(()=>numberingMatchesCompany(initial,{...numberingCompany(company),version:2}));numberingMatchesCompany({...initial,company_changed:true},{...numberingCompany(company),version:2});
});
test('page and exact lookup preserve UUID order, canonical cursor and model without adding unsupported filters',()=>{
 const a=initial,b={...initial,id:id(2),series:'11'};assert.equal(numberingPage(page([a,b],2,true),'55',null,2).next_cursor,b.id);
 for(const v of [page([b,a]),page([a,a]),{...page([a]),has_more:true,next_cursor:a.id},{...page([a]),next_cursor:b.id}])assert.throws(()=>numberingPage(v,'55'));
 assert.throws(()=>numberingPage(page([{...a,model:'65'}]),'55'));assert.throws(()=>numberingPage(page([a]),'55',a.id));
 const lookup=numberingLookup(a.id,'55');assert.equal(lookup.after,id(0));assert.match(lookup.path,/limit=1/);assert.match(lookup.path,/model=55/);assert.ok(a.id>lookup.after);
 assert.equal(numberingLookup('00000000-0000-0000-0000-000000000000','65').after,null);assert.equal(numberingListPath(),'/v1/numeracao-fiscal/series?limit=25');
});
test('configure replay preserves original receipt and validates current independently; exhaustion never wraps',()=>{
 const b=body(),current={...initial,reference:b.reference,version:4,next_number:'2',enabled:false,exclusive_use_confirmed:false},value=ack(b,current),result=numberingConfigCommand(value,b.command_id,b);
 assert.equal(result.receipt.version,1);assert.equal(result.current.version,4);assert.equal(result.current.enabled,false);
 for(const patch of [{reference:'Outra conferência'},{version:2},{identity_version:2},{company_changed:true},{series:'11'}])assert.throws(()=>numberingConfigCommand({...value,receipt:{...value.receipt,...patch}},b.command_id,b));
 assert.throws(()=>numberingConfigCommand({...value,command_id:id(98)},b.command_id,b));assert.throws(()=>numberingConfigCommand({...value,current_basis:{}},b.command_id,b));
 const exhausted=numberingSeries({...initial,version:2,first_number:'999999999',next_number:null,exhausted:true});assert.equal(exhausted.next_number,null);
});

function service({rows=[],before=()=>{},after=()=>{}}={}){
 const state={rows:clone(rows),company:clone(company)},commands=new Map(),calls=[],counts={};
 const controller={async company(path,options={}){const call={op:'company',path,signal:options.signal};calls.push(call);counts.company=(counts.company??0)+1;await before(call,{state,commands,counts});const result=clone(state.company);await after(call,{state,commands,counts});return result;},async fiscalNumbering(path,options={}){
  const url=new URL(path,'https://synthetic.invalid'),op=options.method==='POST'?'save':url.pathname.includes('/commands/')?'command':'series';const call={op,path,body:clone(options.body),signal:options.signal};calls.push(call);counts[op]=(counts[op]??0)+1;await before(call,{state,commands,counts});let value;
  if(op==='series'){const limit=Number(url.searchParams.get('limit')??25),list=state.rows.filter(r=>(!url.searchParams.get('model')||r.model===url.searchParams.get('model'))&&r.id>(url.searchParams.get('after')??'')).sort((a,b)=>a.id.localeCompare(b.id));value=page(list.slice(0,limit),limit,list.length>limit);}
  else if(op==='save'){const b=options.body;let receipt=commands.get(b.command_id);if(!receipt){const old=b.id?state.rows.find(r=>r.id===b.id):null;receipt={...initial,...old,id:old?.id??id(state.rows.length+1),version:b.expected_version+1,identity_version:b.expected_identity_version,model:b.model,series:b.series,first_number:b.initial_number,next_number:old?.next_number??b.initial_number,enabled:b.enabled,exclusive_use_confirmed:b.exclusive_use_confirmed,reference:b.reference};state.rows=state.rows.filter(r=>r.id!==receipt.id).concat(receipt);commands.set(b.command_id,clone(receipt));}value={...FLAGS,command_id:b.command_id,action:'configure',replayed:counts.save>1,receipt,current_series:state.rows.find(r=>r.id===receipt.id),current_basis:null};}
  else{const commandId=url.pathname.split('/').at(-1),receipt=commands.get(commandId);value={...FLAGS,command_id:commandId,action:'configure',replayed:true,receipt,current_series:state.rows.find(r=>r.id===receipt?.id),current_basis:null};}
  await after(call,{state,commands,counts});return clone(value);
 }};return{controller,state,commands,calls,counts};
}
async function mountEditor(server,selected=null,canManage=true){const saved=[],closed=[],view=await mountComponent('RealFiscalNumbering.tsx',{controller:server.controller,selected,canManage,onSaved:()=>saved.push(1),onClose:()=>closed.push(1)},{componentName:'NumberingSeriesEditor'});return{view,saved,closed};}
async function fill(view){await view.change('numbering-model','55');await view.change('numbering-series','10');await view.change('numbering-first','1');await view.change('numbering-enabled','enabled');await view.change('numbering-exclusive',true);await view.change('numbering-reference','Uso exclusivo sintético conferido');}

test('read role sees bounded series and accessible table, with no configure or reservation action',async()=>{
 const s=service({rows:[initial]}),view=await mountComponent('RealFiscalNumbering.tsx',{controller:s.controller});try{assert.match(view.text(),/Homologação|homologação/);assert.doesNotMatch(view.text(),/Incluir série|Salvar configuração|Reservar número/);assert.equal(view.find(n=>n.props.role==='region').props.tabIndex,0);assert.equal(s.counts.save,undefined);assert.ok(s.calls.every(c=>!c.path.includes('/reservations')));}finally{view.unmount();}
});
test('new series requires all explicit choices; successful save reads command, current series and issuer',async()=>{
 const s=service(),{view,saved}=await mountEditor(s);try{assert.equal(view.guard().changed,false);assert.equal(view.input('numbering-model').props.value,'');assert.equal(view.input('numbering-series').props.value,'');assert.equal(view.input('numbering-first').props.value,'');assert.equal(view.input('numbering-enabled').props.value,'');assert.equal(view.input('numbering-exclusive').props.checked,false);
  await view.submit();assert.equal(s.counts.save,undefined);await fill(view);await view.submit();assert.equal(s.counts.save,1);assert.equal(s.counts.command,1);assert.equal(saved.length,1);const write=s.calls.find(c=>c.op==='save');assert.equal(write.body.environment,'2');assert.equal(write.body.expected_identity_version,1);assert.equal('next_number'in write.body,false);assert.ok(s.calls.every(c=>!c.path.includes('/reservations')));
 }finally{view.unmount();}
});
test('editing reloads exact selected series; fixed fields stay readonly and disaorigin preserves the counter',async()=>{
 const existing={...initial,version:3,next_number:'3'},s=service({rows:[existing]}),{view,saved}=await mountEditor(s,{id:existing.id,model:'55'});try{assert.equal(view.input('numbering-model').disabled,true);assert.equal(view.input('numbering-series').props.readOnly,true);assert.equal(view.input('numbering-first').props.readOnly,true);assert.equal(view.input('numbering-exclusive').props.checked,false);assert.equal(view.guard().changed,false);
  await view.change('numbering-enabled','disabled');await view.change('numbering-reference','Desativação sintética conferida');await view.submit();assert.equal(saved.length,1);assert.equal(s.state.rows[0].next_number,'3');assert.equal(s.state.rows[0].enabled,false);assert.equal(s.calls.find(c=>c.op==='save').body.expected_version,3);
 }finally{view.unmount();}
});
test('unknown result followed by403/409 preserves the exact command/body and blocks stale field handlers',async()=>{
 for(const status of[403,409]){const s=service({before(c,{counts}){if(c.op==='save'&&counts.save===2)throw new AccessError(status);},after(c,{counts}){if(c.op==='save'&&counts.save===1)throw new AccessError(503);}}),{view,saved}=await mountEditor(s);
  try{await fill(view);const stale=view.input('numbering-reference').props.onChange;await view.submit();assert.equal(view.guard().busy,true);stale({target:{value:'Alteração indevida'}});await view.flush();assert.equal(view.input('numbering-reference').props.value,'Uso exclusivo sintético conferido');await view.click('Conferir a mesma operação');assert.equal(view.input('numbering-reference').disabled,true);assert.equal(saved.length,0);await view.click('Conferir a mesma operação');const writes=s.calls.filter(c=>c.op==='save');assert.equal(writes.length,3);assert.deepEqual(writes[0].body,writes[1].body);assert.deepEqual(writes[0].body,writes[2].body);assert.equal(s.commands.size,1);assert.equal(saved.length,1);
  }finally{view.unmount();}
 }
});
test('acknowledged save with failed readback retries GET only and accepts a newer current configuration',async()=>{
 const s=service({before(c,{counts}){if(c.op==='series'&&counts.series===1)throw new AccessError(503);}}),{view,saved}=await mountEditor(s);
 try{await fill(view);await view.submit();assert.equal(s.counts.save,1);assert.equal(saved.length,0);assert.equal(view.guard().busy,true);s.state.rows[0].version=3;s.state.rows[0].enabled=false;s.state.rows[0].exclusive_use_confirmed=false;
  await view.click('Consultar resultado e dados atuais');assert.equal(s.counts.save,1);assert.equal(s.counts.command,2);assert.equal(saved.length,1);assert.equal(s.state.rows[0].version,3);
 }finally{view.unmount();}
});
test('initial409 requires reloading and a failed issuer reload cannot unlock stale choices',async()=>{
 let broken=false;const s=service({before(c){if(c.op==='save')throw new AccessError(409);if(c.op==='company'&&broken)throw new AccessError(503);}}),{view}=await mountEditor(s);
 try{await fill(view);await view.submit();assert.equal(view.input('numbering-reference').disabled,true);assert.equal(view.guard().busy,false);broken=true;await view.click('Descartar alterações e recarregar');assert.equal(view.input('numbering-reference').disabled,true);await view.submit();assert.equal(s.counts.save,1);broken=false;await view.click('Descartar alterações e recarregar');assert.equal(view.input('numbering-reference').disabled,false);assert.equal(view.input('numbering-series').props.value,'');assert.equal(view.guard().changed,false);}finally{view.unmount();}
});
test('late replies after unmount and stale back callbacks cannot complete or navigate a pending save',async()=>{
 let release,signal;const s=service({before(c){if(c.op==='save'){signal=c.signal;return new Promise(r=>release=r);}}}),{view,saved,closed}=await mountEditor(s);
 await fill(view);const back=view.button('Voltar às séries').props.onClick;await view.submit();back();assert.equal(closed.length,0);view.unmount();assert.equal(signal.aborted,true);release();await new Promise(r=>setTimeout(r,10));assert.equal(saved.length,0);assert.equal(s.counts.command,undefined);
});
test('pagination and model changes clear old cursors, and missing identity never requests or writes series',async()=>{
 const rows=Array.from({length:26},(_,i)=>({...initial,id:id(i+1),series:String(i),model:i===25?'65':'55'})),s=service({rows}),view=await mountComponent('RealFiscalNumbering.tsx',{controller:s.controller,canManage:true});
 try{assert.match(view.text(),/25 nesta página/);await view.click('Próxima');assert.match(view.text(),/1 nesta página/);await view.change('numbering-filter-model','55');assert.equal(view.button('Anterior').disabled,true);const last=s.calls.filter(c=>c.op==='series').at(-1);assert.match(last.path,/model=55/);assert.doesNotMatch(last.path,/after=/);assert.equal(s.counts.save,undefined);}finally{view.unmount();}
 const empty=service();empty.state.company.record=null;const missing=await mountComponent('RealFiscalNumbering.tsx',{controller:empty.controller,canManage:true});try{assert.equal(empty.counts.series,undefined);assert.equal(missing.button('Incluir série').disabled,true);assert.match(missing.text(),/Cadastre a identidade/);}finally{missing.unmount();}
});
test('missing or foreign selected series and read-only editor cannot save',async()=>{
 for(const s of [service(),service({rows:[{...initial,issuer_cnpj:'11444777000161'}]})]){const{view}=await mountEditor(s,{id:initial.id,model:'55'});try{assert.equal(view.input('numbering-reference').disabled,true);await view.submit();assert.equal(s.counts.save,undefined);}finally{view.unmount();}}
 const s=service({rows:[initial]}),{view}=await mountEditor(s,{id:initial.id,model:'55'},false);try{assert.equal(view.input('numbering-reference').disabled,true);await view.submit();assert.equal(s.counts.save,undefined);}finally{view.unmount();}
});
