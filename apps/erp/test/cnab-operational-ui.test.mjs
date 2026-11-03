import test from 'node:test';
import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {OPERATIONAL_FLAGS as FLAGS,operationalProfiles,operationalPage,operationalPreview,operationalAck,operationalApprovalBody,precedingUuid} from '../src/lib/cnab-operational-model.ts';
import {todaySP} from '../src/lib/real-finance-model.ts';
const clone=x=>structuredClone(x),text=v=>Array.isArray(v)?v.map(text).join(''):v&&typeof v==='object'?text(v.props?.children):v===null||v===undefined||typeof v==='boolean'?'':String(v);
const profile={id:'10000000-0000-4000-8000-000000000001',account_id:'20000000-0000-4000-8000-000000000001',account_name:'CONTA FICTICIA',bank:'341',wallet:'109',account_mask:'***000',company_name:'EMPRESA FICTICIA',version:1,contract_verified:true,policy_verified:true,next_sequence:'1'};
const approval={profile_id:profile.id,approval_version:1,enabled:true,effective_enabled:true,profile_version:1,identity_version:1,reference:'CONFERENCIA FICTICIA',confirmed_on:todaySP(),reviewed_at:new Date().toISOString(),issues:[]};
const entry={profile,approval};
const title={id:'30000000-0000-4000-8000-000000000001',version:1,kind:'receivable',description:'TITULO FICTICIO',contact_name:'PAGADOR FICTICIO',amount_cents:'2570',settled_cents:'0',cancelled:false,issued_on:todaySP(),due_on:'2099-12-31'};
const warnings=['BANK_CLEARANCE_DECLARED_BY_OPERATOR','FILE_DOES_NOT_ENCODE_TEST_ENVIRONMENT','NO_BANK_TRANSMISSION_PERFORMED'];
const file={id:'40000000-0000-4000-8000-000000000001',profile_id:profile.id,kind:'remittance',state:'ready',sequence:'1',generated_on:todaySP(),created_at:new Date().toISOString(),file_hash:'a'.repeat(64),byte_size:1206,titles:1,filename:'ITAU_COBRANCA_0000001.REM'};
const ack={...FLAGS,...Object.fromEntries(['id','profile_id','state','sequence','file_hash','byte_size','filename'].map(k=>[k,file[k]])),replayed:false,warnings};
const body={command_id:'50000000-0000-4000-8000-000000000001',profile_id:profile.id,expected_version:1,expected_approval_version:1,generated_on:todaySP(),confirm_operational:false,titles:[{title_id:title.id,expected_version:1,document_number:'TESTE-1'}]};
function preview(b=body){return{...FLAGS,preview:true,persisted:false,preview_hash:'b'.repeat(64),profile_id:b.profile_id,profile_version:b.expected_version,approval_version:b.expected_approval_version,sequence:'1',total_cents:'2570',titles:1,warnings:[...warnings],items:[{title_id:title.id,title_version:1,contact_version:1,document_number:b.titles[0].document_number,amount_cents:'2570',issued_on:title.issued_on,due_on:title.due_on,payer:{name:'PAGADOR FICTICIO',document_mask:'*******8909',address:'RUA FICTICIA 1',neighborhood:'CENTRO',city:'PIRACICABA',state:'SP',postal_code:'13400000'}}]};}
const page=(items=[file],limit=25)=>({...FLAGS,items:clone(items),limit,has_more:false,next_cursor:null});
function service({before=()=>{},after=()=>{},rights={read:true,write:true,configure:true}}={}){
 const state={profiles:[clone(entry)],files:[]},calls=[],stored=new Map(),counts={approval:0,generate:0,resume:0,preview:0,profiles:0,files:0};
 const controller={async cnab(){return rights;},async finance(){return{data_mode:'erp_native',entity:'titles',items:[clone(title)],has_more:false,next_cursor:null,limit:15};},async cnabOperationalDownload(){throw Error('No network in this fixture');},async cnabOperational(path,options={}){
  const op=options.method==='POST'?(path.endsWith('/approval')?'approval':path.endsWith('/resume')?'resume':path.endsWith('/preview')?'preview':'generate'):path.endsWith('/profiles')?'profiles':'files';const call={op,path,body:clone(options.body),signal:options.signal};calls.push(call);counts[op]++;await before(call,{state,calls,counts,stored});let value;
  if(op==='profiles')value={...FLAGS,items:clone(state.profiles)};
  else if(op==='files'){const query=new URL(path,'https://fixture.invalid').searchParams,limit=Number(query.get('limit')||25),rows=state.files.filter(x=>x.id>(query.get('after')||'')).slice(0,limit);value=page(rows,limit);}
  else if(op==='preview')value=preview(options.body);
  else if(op==='resume'){const found=state.files.find(x=>path.includes(x.id));assert.ok(found);Object.assign(found,clone(file));value={...ack,replayed:counts.resume>1};}
  else{value=stored.get(options.body.command_id);if(value)value={...clone(value),replayed:true};else{if(op==='approval'){state.profiles[0].approval={...state.profiles[0].approval,approval_version:options.body.expected_approval_version+1,enabled:options.body.enabled,effective_enabled:options.body.enabled,issues:options.body.enabled?[]:['OPERATIONAL_APPROVAL_DISABLED'],reference:options.body.reference.replace(/^ +| +$/g,''),confirmed_on:options.body.confirmed_on};value={...FLAGS,approval:clone(state.profiles[0].approval),replayed:false};}else{state.files.push(clone(file));value=clone(ack);}stored.set(options.body.command_id,clone(value));}}
  await after(call,{state,calls,counts,stored});return clone(value);
 }};return{controller,state,calls,counts,stored};
}
async function mount(componentName,s){const saved=[],closed=[],view=await mountComponent('RealCnabOperational.tsx',{controller:s.controller,entry:clone(entry),profiles:[clone(entry)],file:{...clone(file),state:'reserved',file_hash:null,byte_size:null},onSaved:()=>saved.push(true),onClose:()=>closed.push(true)},{componentName,expandChildren:true});return{view,saved,closed};}
function input(view,label){const node=view.find(n=>n.type==='label'&&text(n)===label);return view.input(node.props.htmlFor);}
async function set(view,label,value){await view.change(input(view,label).props.id,value);}
async function check(view,predicate,value=true){const node=view.find(n=>n.type==='input'&&n.props.type==='checkbox'&&predicate(n));assert.equal(node.disabled,false);node.props.onChange({target:{checked:value}});await view.flush();}
async function prepareApproval(view){await set(view,'Decisão *','yes');await set(view,'Data da conferência *',todaySP());await set(view,'Referência da conferência *','CONFERENCIA SINTETICA');await check(view,()=>true);await view.submit();}
async function prepareRemittance(view){await set(view,'Perfil operacional *',profile.id);await check(view,n=>n.props['aria-label']==='Selecionar TITULO FICTICIO');await set(view,'Documento · TITULO FICTICIO *','TESTE-1');await view.submit();await check(view,n=>!n.props['aria-label']);}
const posts=s=>s.calls.filter(x=>['generate','approval','resume'].includes(x.op));

test('042 UI model keeps strict purpose/flags, exact totals and binding, and excludes private payloads',()=>{
 const p={...FLAGS,items:[{profile:{...profile,cnpj:'PRIVATE'},approval}]};assert.equal(operationalProfiles(p)[0].profile.cnpj,undefined);
 for(const value of [{...p,purpose:'homologation'},{...p,financialMutationPerformed:true},{...p,items:[...p.items,...p.items]}])assert.throws(()=>operationalProfiles(value));
 assert.equal(operationalPreview(preview(),body).total_cents,'2570');
 for(const mutate of [v=>v.total_cents='2571',v=>v.items[0].amount_cents=25.70,v=>v.items[0].title_id=file.id,v=>v.items[0].payer.document_mask='12345678909',v=>v.warnings.push('UNKNOWN'),v=>v.approval_version++]){const v=preview();mutate(v);assert.throws(()=>operationalPreview(v,body));}
 assert.equal(operationalAck(ack,{profileId:profile.id}).id,file.id);assert.throws(()=>operationalAck({...ack,profile_id:title.id},{profileId:profile.id}));
 assert.equal(operationalPage(page()).items[0].sequence,'1');assert.throws(()=>operationalPage({...page(),has_more:true}));assert.throws(()=>operationalPage(page([{...file,state:'reserved'}])));
 assert.equal(precedingUuid('00000000-0000-0000-0000-000000000000'),null);assert.equal(precedingUuid(file.id),'40000000-0000-4000-8000-000000000000');
});
test('042 declaration requires deliberate decision, exact versions and meaningful reference',()=>{
 assert.throws(()=>operationalApprovalBody(entry,true,todaySP(),'CONFIRMACAO',todaySP(),false));assert.throws(()=>operationalApprovalBody(entry,true,todaySP(),'\u00a0'.repeat(3),todaySP(),true));assert.throws(()=>operationalApprovalBody(entry,true,'2099-12-31','CONFIRMACAO',todaySP(),true));
 const b=operationalApprovalBody(entry,false,todaySP(),'DECLARACAO',todaySP(),true);assert.equal(b.expected_approval_version,1);assert.equal(b.expected_identity_version,1);assert.equal(b.enabled,false);
});
test('042 thirty maximum-value titles preserve exact cents without floating point and malformed current file cannot unlock',()=>{
 const input={...clone(body),titles:Array.from({length:30},(_,i)=>({title_id:`30000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,expected_version:1,document_number:`MAX${i+1}`}))};
 const p={...preview(),titles:30,total_cents:(9999999999999n*30n).toString(),items:input.titles.map(t=>({...preview().items[0],title_id:t.title_id,document_number:t.document_number,amount_cents:'9999999999999'}))};
 assert.equal(operationalPreview(p,input).total_cents,'299999999999970');
 assert.throws(()=>operationalPage(page([{...file,id:title.id},file]),25,file.id));
});
test('042 approval handlers freeze after POST response loss and later 403; ACK + failed current GET retries only GET',async()=>{
 const s=service({before(call,{counts}){if(call.op==='approval'&&counts.approval===2)throw new AccessError(403);if(call.op==='profiles'&&counts.profiles===1)throw new AccessError(503);},after(call,{counts}){if(call.op==='approval'&&counts.approval===1)throw new AccessError(503);}}),{view,saved}=await mount('OperationalApprovalEditor',s);
 await prepareApproval(view);await view.click('Registrar declaração');assert.equal(view.guard().busy,true);assert.equal(input(view,'Referência da conferência *').disabled,true);assert.equal(view.button('Voltar e corrigir').disabled,true);
 await view.click('Repetir a mesma confirmação');assert.equal(input(view,'Referência da conferência *').disabled,true);await view.click('Repetir a mesma confirmação');assert.match(view.text(),/Consultar resultado registrado/);assert.equal(saved.length,0);
 await view.click('Consultar resultado registrado');assert.equal(saved.length,1);assert.equal(s.counts.approval,3);assert.equal(s.counts.profiles,2);assert.deepEqual(posts(s)[0].body,posts(s)[1].body);assert.deepEqual(posts(s)[1].body,posts(s)[2].body);view.unmount();
});
test('042 genuine initial approval conflict releases editing without treating it as a previous uncertain commit',async()=>{
 const s=service({before(call){if(call.op==='approval')throw new AccessError(409);}}),{view}=await mount('OperationalApprovalEditor',s);await prepareApproval(view);await view.click('Registrar declaração');assert.doesNotMatch(view.text(),/Repetir a mesma confirmação/);assert.equal(view.button('Voltar e corrigir').disabled,false);await view.click('Voltar e corrigir');assert.equal(input(view,'Referência da conferência *').disabled,false);view.unmount();
});
test('042 generation uses read-only preview, freezes exact body after possible reservation and does not replay POST after ACK',async()=>{
 const s=service({before(call,{counts}){if(call.op==='generate'&&counts.generate===2)throw new AccessError(409);if(call.op==='files'&&counts.files===1)throw new AccessError(503);},after(call,{counts}){if(call.op==='generate'&&counts.generate===1)throw new AccessError(503);}}),{view,saved}=await mount('OperationalRemittanceEditor',s);
 const oldSelect=input(view,'Perfil operacional *').props.onChange;await prepareRemittance(view);assert.equal(s.counts.preview,1);assert.equal(posts(s).length,0);assert.match(view.text(),/R\$ 25,70/);assert.match(view.text(),/PAGADOR FICTICIO/);
 await view.click('Reservar e gerar remessa operacional');oldSelect({target:{value:'other'}});await view.flush();assert.equal(input(view,'Perfil operacional *').props.value,profile.id);assert.equal(view.guard().busy,true);assert.equal(view.button('Voltar e corrigir').disabled,true);
 await view.click('Repetir a mesma confirmação');assert.equal(view.button('Voltar e corrigir').disabled,true);await view.click('Repetir a mesma confirmação');assert.match(view.text(),/Consultar resultado registrado/);await view.click('Consultar resultado registrado');assert.equal(saved.length,1);assert.equal(s.counts.generate,3);assert.equal(s.counts.files,2);assert.deepEqual(posts(s)[0].body,posts(s)[1].body);assert.deepEqual(posts(s)[1].body,posts(s)[2].body);assert.equal(posts(s)[0].body.preview_hash,'b'.repeat(64));assert.equal(s.state.files.length,1);view.unmount();
});
test('042 a first generation 409 can follow a reservation and remains uncertain; no fresh command is generated',async()=>{
 const s=service({before(call){if(call.op==='generate')throw new AccessError(409);}}),{view}=await mount('OperationalRemittanceEditor',s);await prepareRemittance(view);await view.click('Reservar e gerar remessa operacional');assert.equal(view.guard().busy,true);assert.equal(input(view,'Documento · TITULO FICTICIO *').disabled,true);await view.click('Repetir a mesma confirmação');assert.deepEqual(posts(s)[0].body,posts(s)[1].body);view.unmount();
});
test('042 acknowledged generation does not unlock when current file hash differs, and recovers with GET only',async()=>{
 const s=service({before(call,{state,counts}){if(call.op==='files'&&counts.files===1)state.files[0].file_hash='c'.repeat(64);else if(call.op==='files')state.files[0].file_hash=file.file_hash;}}),{view,saved}=await mount('OperationalRemittanceEditor',s);await prepareRemittance(view);await view.click('Reservar e gerar remessa operacional');assert.equal(saved.length,0);assert.equal(view.guard().busy,true);await view.click('Consultar resultado registrado');assert.equal(saved.length,1);assert.equal(s.counts.generate,1);assert.equal(s.counts.files,2);view.unmount();
});
test('042 resume recovery preserves reservation and approval version, with guard and current GET',async()=>{
 const s=service({after(call,{counts}){if(call.op==='resume'&&counts.resume===1)throw new AccessError(503);}});s.state.files=[{...clone(file),state:'reserved',file_hash:null,byte_size:null}];const{view,saved}=await mount('OperationalResume',s);await check(view,()=>true);await view.click('Retomar reserva existente');assert.equal(view.guard().busy,true);await view.click('Repetir a mesma confirmação');assert.equal(saved.length,1);assert.equal(s.counts.resume,2);assert.equal(s.state.files.length,1);assert.deepEqual(posts(s)[0].body,posts(s)[1].body);assert.equal(posts(s)[0].body.expected_approval_version,1);view.unmount();
});
test('042 late acknowledged response after unmount cannot invoke a completion callback or issue current GET',async()=>{
 let release;const gate=new Promise(r=>release=r);const s=service({after:async call=>{if(call.op==='approval')await gate;}}),{view,saved}=await mount('OperationalApprovalEditor',s);await prepareApproval(view);await view.click('Registrar declaração');assert.equal(view.button('Registrar declaração').disabled,true);view.unmount();release();await new Promise(r=>setTimeout(r,20));assert.equal(saved.length,0);assert.equal(s.counts.profiles,0);
});
test('042 read-only role sees current authorization and files without write controls or any POST',async()=>{
 const s=service({rights:{read:true,write:false,configure:false}});s.state.files=[clone(file)];const view=await mountComponent('RealCnabOperational.tsx',{controller:s.controller},{expandChildren:true});assert.doesNotMatch(view.text(),/Incluir remessa/i);await view.click('Autorizações por perfil');assert.doesNotMatch(view.text(),/Revisar declaração/);assert.match(view.text(),/Declaração vigente/);assert.equal(posts(s).length,0);view.unmount();
});
