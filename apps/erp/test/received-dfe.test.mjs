import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {dfeSettings,dfeCompany,dfeInitialForm,dfeConfigBody,dfeCommand,dfePage,dfeFilename,verifyDfeBlob} from '../src/lib/received-dfe-model.ts';
import {buildAccessKey} from '../../../packages/fiscal-core/src/identity.mjs';
const id=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`,channelId=id(1),commandId=id(2);
const FLAGS={data_mode:'received_dfe',model:'55',transport_enabled:false,can_query:false,can_manifest:false,can_emit:false,origin_authenticated:false,signature_verified:false,xsd_validated:false,sefaz_authorized:false,financial_mutation_performed:false,stock_mutation_performed:false};
const current={id:channelId,environment:'1',identity_version:1,version:1,coordinator:'external',other_consumers_reviewed:false,checkpoint:null,checkpoint_confirmed:false,collection_requested:false,paused:false,has_active_attempt:false,not_before:null,updated_at:'2026-10-16T12:00:00.123456Z',company_changed:false};
const company={section:'identity',data_mode:'erp_native',emission_enabled:false,record:{version:1,data:{legal_name:'EMPRESA INTEIRAMENTE FICTICIA',cnpj:'12345678000195',secret:'OMITTED'}}};
const key=buildAccessKey({cUF:'35',cnpj:'12345678000195',model:'55',environment:'2',series:'1',number:'1',issuedAt:'2026-10-16T10:00:00-03:00',cNF:'12345678',tpEmis:'1'});
const bytes=new TextEncoder().encode('<resNFe>FICTICIO</resNFe>'),hash=createHash('sha256').update(bytes).digest('hex');
const row={id:id(5),channel_id:channelId,nsu:'000000000000001',kind:'invoice_summary',schema:'resNFe_v1.01.xsd',model:'55',access_key:key,recipient_match:null,quarantined:false,xml_hash:hash,size_bytes:bytes.length,collected_at:'2026-10-16T12:00:00Z',is_complete_invoice:false};
const page=items=>({...FLAGS,channel_id:channelId,items,limit:25,has_more:false,next_cursor:null});
const clone=x=>structuredClone(x);

test('received DF-e model preserves unknown checkpoint, strict environment and false trust/activation flags',()=>{
 assert.equal(dfeSettings({...FLAGS,current:null},'1'),null);assert.equal(dfeSettings({...FLAGS,current:{...current,checkpoint:'000000000000000'}},'1').checkpoint,'000000000000000');
 for(const patch of [{can_query:true},{can_emit:true},{origin_authenticated:true},{signature_verified:true}])assert.throws(()=>dfeSettings({...FLAGS,...patch,current},'1'));
 for(const patch of [{environment:'2'},{checkpoint:0},{checkpoint_confirmed:true},{updated_at:'2026-02-30T00:00:00Z'},{has_active_attempt:null}])assert.throws(()=>dfeSettings({...FLAGS,current:{...current,...patch}},'1'));
 assert.deepEqual(dfeCompany(company),{version:1,legal_name:company.record.data.legal_name,cnpj:'12345678000195'});
});
test('company identity follows the016 legal-name limit by Unicode codepoints',()=>{
 for(const name of ['x'.repeat(200),'😀'.repeat(200)]){const value=clone(company);value.record.data.legal_name=name;assert.equal(dfeCompany(value).legal_name,name);}
 const tooLong=clone(company);tooLong.record.data.legal_name='x'.repeat(201);assert.throws(()=>dfeCompany(tooLong));
});
test('configuration always keeps collection off, leaves confirmations empty, and never invents a zero NSU',()=>{
 const form=dfeInitialForm(null);assert.equal(form.coordinator,'unconfirmed');assert.equal(form.checkpoint,'');assert.equal(form.checkpoint_confirmed,false);assert.equal(form.other_consumers_reviewed,false);
 const body=dfeConfigBody({...form,coordinator:'external',reason:'Outro consumidor ainda está em uso'},null,dfeCompany(company),'1',commandId);assert.equal(body.checkpoint,null);assert.equal(body.collection_requested,false);
 const ready=dfeConfigBody({...form,coordinator:'brufap',checkpoint:'000000000000001',checkpoint_confirmed:true,other_consumers_reviewed:true,reason:'Conferência futura documentada'},null,dfeCompany(company),'1',commandId);assert.equal(ready.collection_requested,false);
 for(const patch of [{checkpoint:'0'},{checkpoint_confirmed:true},{reason:'\u00a0\u00a0\u00a0'},{reason:'a\nb'},{reason:'x'.repeat(241)}])assert.throws(()=>dfeConfigBody({...form,reason:'referência',...patch},null,dfeCompany(company),'1',commandId));
 assert.throws(()=>dfeConfigBody({...form,reason:'referência'},null,null,'1',commandId));
});
test('historical receipt is bound to its command and original choices while current can be newer',()=>{
 const body=dfeConfigBody({...dfeInitialForm(null),coordinator:'external',reason:'referência'},null,dfeCompany(company),'1',commandId),value={...FLAGS,action:'configure',state:'committed',command_id:commandId,receipt:current,current:{...current,version:2,company_changed:true},replayed:true};
 const got=dfeCommand(value,commandId,body);assert.equal(got.receipt.version,1);assert.equal(got.current.version,2);
 for(const patch of [{coordinator:'brufap'},{checkpoint:'000000000000001'},{identity_version:2},{version:2},{paused:true}])assert.throws(()=>dfeCommand({...value,receipt:{...current,...patch}},commandId,body));
 assert.throws(()=>dfeCommand({...value,command_id:id(3)},commandId,body));
});
test('document kinds, ordering and private projections distinguish summaries from XML and quarantine',()=>{
 const variants=[row,{...row,kind:'invoice',schema:'procNFe_v4.00.xsd',recipient_match:true,is_complete_invoice:true},{...row,kind:'event',schema:'procEventoNFe_v1.00.xsd'},{...row,kind:'event_summary',schema:'resEvento_v1.01.xsd'},{...row,kind:'unsupported',schema:'unknown_v1.00.xsd',model:null,access_key:null,quarantined:true}];
 for(const v of variants){const got=dfePage(page([{...v,xml:'SECRET',cnpj:'SECRET',object_key:'SECRET'}]),channelId).items[0];assert.equal(got.kind,v.kind);assert.doesNotMatch(JSON.stringify(got),/SECRET/);}
 assert.match(dfeFilename(row),/^RESUMO_NFE_/);assert.match(dfeFilename(variants[1]),/^NFE_/);assert.match(dfeFilename(variants[4]),/^QUARENTENA_/);
 for(const patch of [{is_complete_invoice:true},{model:'65'},{nsu:1},{recipient_match:true},{size_bytes:8388609},{schema:'../../secret'}])assert.throws(()=>dfePage(page([{...row,...patch}]),channelId));
 assert.throws(()=>dfePage(page([row,row]),channelId));assert.throws(()=>dfePage(page([row]),channelId,'invoice'));assert.throws(()=>dfePage({...page([]),has_more:true,next_cursor:id(5)},channelId));
});
test('download checks complete hash and size, rejects late aborts, and does not render XML inline',async()=>{
 const signal=new AbortController().signal;const value=await verifyDfeBlob(new Blob([bytes]),row,signal);assert.equal(value.type,'application/octet-stream');
 for(const b of [new Blob([bytes.slice(1)]),new Blob([new Uint8Array(bytes.length)])])await assert.rejects(()=>verifyDfeBlob(b,row,signal));
 const c=new AbortController();c.abort();await assert.rejects(()=>verifyDfeBlob(new Blob([bytes]),row,c.signal),e=>e.name==='AbortError');
});

function service({before=()=>{},after=()=>{},initial=null,items=[row]}={}){
 const state={current:clone(initial),company:clone(company)},commands=new Map(),calls=[],counts={};
 const controller={async company(path,options={}){calls.push({op:'company',path,signal:options.signal});return clone(state.company);},async dfeDistributionDownload(){return new Blob([bytes]);},async dfeDistribution(path,options={}){
  const url=new URL(path,'https://synthetic.invalid'),op=url.pathname.endsWith('/summaries')?'summaries':url.pathname.endsWith('/summary')?'summary':options.method==='POST'?'save':url.pathname.includes('/commands/')?'command':url.pathname.endsWith('/documents')?'documents':'settings';const call={op,path,body:clone(options.body),signal:options.signal};calls.push(call);counts[op]=(counts[op]??0)+1;await before(call,{state,commands,counts});let value;
  if(op==='settings')value={...FLAGS,current:state.current};
  // Leva H (NFE-212): the readings of the page (none stored) and the reading of one kept document.
  else if(op==='summaries')value={...FLAGS,channel_id:url.searchParams.get('channel_id'),items:[]};
  else if(op==='summary')value={...FLAGS,summary:{document_id:url.pathname.split('/').at(-2),issue_date:'2026-10-15',total:'1234.50',supplier_name:'Fornecedor fictício',supplier_document:'12345678000195',situation:'1'},recorded:true};
  else if(op==='documents'){const list=items.filter(r=>(!url.searchParams.get('kind')||r.kind===url.searchParams.get('kind'))&&r.id>(url.searchParams.get('after')||''));value={...page(list.slice(0,25)),has_more:list.length>25,next_cursor:list.length>25?list[24].id:null};}
  else if(op==='save'){const body=options.body;let stored=commands.get(body.command_id);if(!stored){state.current={...current,environment:body.environment,version:body.expected_version+1,identity_version:body.expected_identity_version,coordinator:body.coordinator,checkpoint:body.checkpoint,checkpoint_confirmed:body.checkpoint_confirmed,other_consumers_reviewed:body.other_consumers_reviewed,collection_requested:body.collection_requested};stored=clone(state.current);commands.set(body.command_id,stored);}value={...FLAGS,command_id:body.command_id,action:'configure',state:'committed',receipt:stored,current:state.current,replayed:counts.save>1};}
  else{const commandId=url.pathname.split('/').at(-1);value={...FLAGS,command_id:commandId,action:'configure',state:'committed',receipt:commands.get(commandId),current:state.current,replayed:true};}
  await after(call,{state,commands,counts});return clone(value);
 }};return{controller,state,commands,calls,counts};
}
const mountEditor=async server=>{const saved=[],closed=[];const view=await mountComponent('RealReceivedDfe.tsx',{controller:server.controller,environment:'1',onSaved:()=>saved.push(1),onClose:()=>closed.push(1)},{componentName:'CoordinationEditor'});return{view,saved,closed};};
async function fill(view){await view.change('dfe-coordinator','external');await view.change('dfe-reason','Outro consumidor ainda está em uso');}
test('explicit environment is required; read roles see documents and accessible scrolling without configuration controls',async()=>{
 const s=service({initial:current}),view=await mountComponent('RealReceivedDfe.tsx',{controller:s.controller});
 try{assert.equal(s.calls.length,0);await view.change('received-environment','1');assert.equal(s.counts.settings,1);assert.equal(s.counts.documents,1);assert.doesNotMatch(view.text(),/Revisar coordenação|Salvar coordenação|Consultar SEFAZ|Manifestar/);assert.match(view.text(),/Resumo de NF-e/);assert.equal(view.find(n=>n.props.role==='region').props.tabIndex,0);assert.equal(s.counts.save,undefined);}finally{view.unmount();}
});
test('configuration only writes after submission and confirms command plus current settings before leaving',async()=>{
 const s=service(),{view,saved}=await mountEditor(s);try{assert.equal(s.counts.save,undefined);assert.equal(view.guard().changed,false);const checks=view.nodes().filter(n=>n.type==='input'&&n.props.type==='checkbox');assert.ok(checks.every(n=>n.props.checked===false));await fill(view);await view.submit();assert.equal(s.counts.save,1);assert.equal(s.counts.command,1);assert.equal(s.counts.settings,2);assert.equal(s.calls.find(c=>c.op==='save').body.collection_requested,false);assert.equal(s.calls.find(c=>c.op==='save').body.checkpoint,null);assert.equal(saved.length,1);}finally{view.unmount();}
});
test('lost response followed by 403 or409 preserves command/body and blocks stale edit callbacks',async()=>{
 for(const status of [403,409]){const s=service({before(c,{counts}){if(c.op==='save'&&counts.save===2)throw new AccessError(status);},after(c,{counts}){if(c.op==='save'&&counts.save===1)throw new AccessError(503);}}),{view,saved}=await mountEditor(s);
  try{await fill(view);const stale=view.input('dfe-reason').props.onChange;await view.submit();assert.equal(view.guard().busy,true);stale({target:{value:'troca indevida'}});await view.flush();assert.equal(view.input('dfe-reason').props.value,'Outro consumidor ainda está em uso');await view.click('Conferir a mesma operação');assert.equal(view.input('dfe-reason').disabled,true);assert.equal(saved.length,0);await view.click('Conferir a mesma operação');const writes=s.calls.filter(c=>c.op==='save');assert.equal(writes.length,3);assert.deepEqual(writes[0].body,writes[1].body);assert.deepEqual(writes[0].body,writes[2].body);assert.equal(s.commands.size,1);assert.equal(saved.length,1);}finally{view.unmount();}
 }
});
test('acknowledged write with failed current readback retries only GET; historical replay never replaces current',async()=>{
 const s=service({before(c,{counts}){if(c.op==='settings'&&counts.settings===2)throw new AccessError(503);}}),{view,saved}=await mountEditor(s);
 try{await fill(view);await view.submit();assert.equal(saved.length,0);assert.equal(view.guard().busy,true);s.state.current.version=3;await view.click('Consultar resultado e dados atuais');assert.equal(s.counts.save,1);assert.equal(s.counts.command,2);assert.equal(saved.length,1);}finally{view.unmount();}
});
test('definitive initial conflict requires fresh configuration and failed reload cannot unlock stale form',async()=>{
 let broken=false;const s=service({before(c){if(c.op==='save')throw new AccessError(409);if(c.op==='settings'&&broken)throw new AccessError(503);}}),{view}=await mountEditor(s);
 try{await fill(view);await view.submit();assert.equal(view.input('dfe-reason').disabled,true);assert.equal(view.guard().busy,false);broken=true;await view.click('Descartar alterações e recarregar');assert.equal(view.input('dfe-reason').disabled,true);await view.submit();assert.equal(s.counts.save,1);broken=false;await view.click('Descartar alterações e recarregar');assert.equal(view.input('dfe-reason').disabled,false);}finally{view.unmount();}
});
test('unmount aborts pending configuration and ignores late acknowledgements and old back handlers',async()=>{
 let release,signal;const s=service({before(c){if(c.op==='save'){signal=c.signal;return new Promise(r=>release=r);}}}),{view,saved,closed}=await mountEditor(s);
 await fill(view);const back=view.button('Voltar aos documentos').props.onClick;await view.submit();back();assert.equal(closed.length,0);view.unmount();assert.equal(signal.aborted,true);release();await new Promise(r=>setTimeout(r,10));assert.equal(saved.length,0);assert.equal(s.counts.command,undefined);
});
test('pagination and kind changes reset cursors without loading another channel',async()=>{
 const items=Array.from({length:26},(_,n)=>({...row,id:id(n+10)})),s=service({initial:current,items}),view=await mountComponent('RealReceivedDfe.tsx',{controller:s.controller,initialEnvironment:'1'});
 try{assert.match(view.text(),/25 documento\(s\)/);await view.click('Próxima');assert.match(view.text(),/1 documento\(s\)/);await view.change('received-kind','invoice');assert.match(view.text(),/0 documento\(s\)/);assert.equal(view.button('Anterior').disabled,true);const last=s.calls.filter(c=>c.op==='documents').at(-1);assert.ok(last.path.includes(`channel_id=${channelId}`));assert.ok(!last.path.includes('after='));assert.equal(s.counts.save,undefined);}finally{view.unmount();}
});
