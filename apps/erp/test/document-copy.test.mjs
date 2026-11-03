import test from 'node:test';
import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {normalizeDocument} from '../../../packages/erp-domain/src/index.mjs';
import {documentInput} from '../src/lib/real-documents-model.ts';
import {COPY_RESET_FIELDS,readCopyPreview,readCopyResult,readCopyOrigin,CopyPreviewChanged} from '../src/lib/document-copy-model.ts';
import {createAccessController} from '../src/lib/real-access.ts';
const sourceId='10000000-0000-4000-8000-000000000001',targetId='10000000-0000-4000-8000-000000000002',contactId='20000000-0000-4000-8000-000000000001',actor='30000000-0000-4000-8000-000000000001';
const clone=value=>structuredClone(value),kind='sales_proposals';
const source={...normalizeDocument(kind,{date:'2026-10-16',contact_id:contactId,items:[{id:'40000000-0000-4000-8000-000000000001',description:'Item sintético',unit:'UN',quantity:'0.123456',unit_price:'100',discount_percent:'0'}],notes:'Fonte sintética'}),id:sourceId,kind,number:'7',version:3,status:'approved',contact_snapshot:{id:contactId,name:'Contato sintético'},effect_flags:{finance_active:false,stock_active:false},source_proposal_id:null,created_at:'2026-10-16T07:00:00Z',updated_at:'2026-10-16T07:00:00Z'};
function preview(){const data=documentInput(source);for(const key of COPY_RESET_FIELDS)if(!['date','installments','template'].includes(key))data[key]=null;data.date='2026-10-17';data.items=data.items.map(item=>({...item,id:null}));data.installments=[];data.template=false;return{source:{id:sourceId,kind,number:source.number,version:source.version},data,reset_fields:[...COPY_RESET_FIELDS],persisted:false,data_mode:'erp_native',operational_effects:false};}
const draft=()=>({preview:preview(),contact:{id:contactId,name:'Contato sintético'}});
function outcome(body=preview().data){return{document:{...clone(source),...normalizeDocument(kind,body),id:targetId,number:'10',version:1,status:'draft',items:normalizeDocument(kind,body).items.map((item,index)=>({...item,id:`40000000-0000-4000-8000-${String(index+2).padStart(12,'0')}`,product_snapshot:null}))},kind,copy_source:clone(preview().source),replayed:false,data_mode:'erp_native',operational_effects:false};}
const child=(view,name)=>view.nodes().find(node=>typeof node.type==='function'&&node.type.name===name);
function server({before,after}={}){
 const calls=[],commands=new Map(),saved=[],prepared=[],closed=[];let writes=0,reads=0,previewReads=0;
 const controller={getSnapshot:()=>({membership:{role:'vendas',user_id:actor}}),catalog:async()=>({read:[],write:[]}),async documentCopy(path,options={}){
  const call={path,...options,body:options.body?clone(options.body):undefined};calls.push(call);
  if(!options.method){previewReads++;const value=await before?.(call,{writes,reads,previewReads});return value??preview();}
  writes++;await before?.(call,{writes,reads,previewReads});const prior=commands.get(options.body.command_id);if(prior)assert.deepEqual(prior.body,call.body);else commands.set(options.body.command_id,call);
  await after?.(call,{writes,reads,previewReads});return{...outcome(call.body.data),replayed:Boolean(prior)};
 },async documents(path,options={}){const call={path,...options};calls.push(call);reads++;const value=await before?.(call,{writes,reads,previewReads});return value??{document:{...outcome([...commands.values()][0]?.body.data).document,version:5,status:'open'}};}};
 return{calls,commands,saved,prepared,closed,controller,counts:()=>({writes,reads,previewReads})};
}
const mount=(service,{copy=true,...props}={})=>mountComponent('RealDocuments.tsx',{controller:service.controller,kind,record:copy?null:clone(source),copyDraft:copy?draft():null,writable:true,onClose:()=>service.closed.push(true),onSaved:value=>service.saved.push(value),onCopied:value=>service.saved.push(value),onCopyPrepared:value=>service.prepared.push(value),onConverted(){},...props},{componentName:'Editor',expandChildren:['DocumentCopyNotice']});

test('copy models bind previews, commands and origins without accepting source changes or asserted effects',()=>{
 assert.deepEqual(readCopyPreview(preview(),source),preview());assert.equal(readCopyResult(outcome(),preview()).document.id,targetId);
 for(const mutate of [v=>v.persisted=true,v=>v.operational_effects=true,v=>v.source.id=targetId,v=>v.data.template=true,v=>v.data.items[0].id=source.items[0].id,v=>v.data.solution='Execução antiga',v=>v.data.contact_id=actor]){const v=preview();mutate(v);assert.throws(()=>readCopyPreview(v,source));}
 const changed=preview();changed.source.version++;assert.throws(()=>readCopyPreview(changed,source),CopyPreviewChanged);
 for(const mutate of [v=>v.copy_source.version++,v=>v.document.id=sourceId,v=>v.document.kind='service_orders',v=>v.document.version=2,v=>v.document.source_proposal_id=sourceId,v=>v.document.status='completed']){const v=outcome();mutate(v);assert.throws(()=>readCopyResult(v,preview()));}
 const origin={document_id:targetId,kind,copy_source:preview().source,data_mode:'erp_native',operational_effects:false};assert.equal(readCopyOrigin(origin,{id:targetId,kind}).copy_source.id,sourceId);
 assert.throws(()=>readCopyOrigin({...origin,document_id:sourceId},{id:targetId,kind}));assert.throws(()=>readCopyOrigin({...origin,copy_source:{...preview().source,id:targetId}},{id:targetId,kind}));
});
test('saved document opens a read-only preparation; form save alone creates an edited copy and reads current state',async()=>{
 const service=server(),sourceView=await mount(service,{copy:false});
 try{await sourceView.click('Duplicar como novo');assert.deepEqual(service.counts(),{writes:0,reads:0,previewReads:1});assert.equal(service.prepared.length,1);assert.equal(service.prepared[0].preview.source.version,3);}finally{sourceView.unmount();}
 const view=await mount(service);
 try{assert.equal(view.guard().changed,true);assert.match(view.text(),/número 7 · versão 3/);assert.match(view.text(),/não são copiados/);assert.equal(view.input('doc-date').props.value,'2026-10-17');
  await view.change('doc-date','2026-09-10');await view.change('doc-notes','Conferido na cópia');await view.submit();assert.deepEqual(service.counts(),{writes:1,reads:1,previewReads:1});assert.equal(service.saved[0].version,5);assert.equal(service.saved[0].date,'2026-09-10');
  const post=service.calls.find(call=>call.method);assert.equal(post.path,`/v1/duplicacao-documentos/${kind}/${sourceId}`);assert.equal(post.body.expected_source_version,3);assert.equal(post.body.data.notes,'Conferido na cópia');assert.equal(post.body.data.effect_flags,undefined);assert.equal(post.body.data.items[0].id,null);
 }finally{view.unmount();}
});
for(const status of [403,409])test(`lost copy acknowledgement followed by ${status} freezes the same command until replay and readback`,async()=>{
 const service=server({after(call,{writes}){if(writes===1)throw new AccessError(503);},before(call,{writes}){if(call.method&&writes===2)throw new AccessError(status);}}),view=await mount(service);
 try{await view.submit();await view.click('Conferir resultado');assert.equal(view.guard().busy,true);assert.equal(view.input('doc-date').disabled,true);assert.equal(view.button('Salvar').disabled,true);assert.equal(view.button('Cancelar').disabled,true);assert.equal(service.saved.length,0);
  view.button('Cancelar').props.onClick();await view.flush();assert.equal(service.closed.length,0);
  await view.submit();assert.equal(service.counts().writes,2);await view.click('Conferir resultado');assert.equal(service.commands.size,1);assert.equal(service.saved.length,1);assert.deepEqual(service.counts(),{writes:3,reads:1,previewReads:0});const posts=service.calls.filter(call=>call.method);assert.deepEqual(posts[0].body,posts[2].body);
 }finally{view.unmount();}
});
test('copy acknowledgement with failed or mismatched readback retries GET only',async()=>{
 const service=server({before(call,{reads}){if(call.path.startsWith('/v1/documentos/')){if(reads===1)throw new AccessError(503);if(reads===2)return{document:{...outcome().document,id:sourceId}};}}}),view=await mount(service);
 try{await view.submit();assert.equal(service.saved.length,0);await view.click('Conferir resultado');assert.equal(service.saved.length,0);await view.click('Conferir resultado');assert.deepEqual(service.counts(),{writes:1,reads:3,previewReads:0});assert.equal(service.saved.length,1);}finally{view.unmount();}
});
test('first definitive copy rejection preserves editable preparation without pretending it was saved',async()=>{
 const service=server({before(call){if(call.method)throw new AccessError(409);}}),view=await mount(service);
 try{await view.submit();assert.equal(service.saved.length,0);assert.equal(service.commands.size,0);assert.equal(view.guard().busy,false);assert.equal(view.guard().changed,true);assert.equal(view.input('doc-date').disabled,false);await view.click('Cancelar');assert.equal(service.closed.length,1);}finally{view.unmount();}
});
test('stale preparation rejects before editing and child drafts block opening a copy',async()=>{
 const service=server({before(){const result=preview();result.source.version++;return result;}}),view=await mount(service,{copy:false});
 try{await view.change('doc-reason','Conferência');assert.equal(view.button('Duplicar como novo').disabled,true);await view.change('doc-reason','');await view.click('Ver / adicionar anexos');child(view,'DocumentAttachments').props.onDraft(true);await view.flush();assert.equal(view.button('Duplicar como novo').disabled,true);child(view,'DocumentAttachments').props.onDraft(false);await view.flush();await view.click('Duplicar como novo');assert.match(view.text(),/origem mudou/);assert.equal(service.prepared.length,0);assert.equal(service.commands.size,0);}finally{view.unmount();}
});
test('late preview or acknowledgement is ignored after leaving, with no readback or navigation',async()=>{
 for(const copy of [false,true]){let release;const service=server({before(){return new Promise(resolve=>{release=resolve;});}}),view=await mount(service,{copy});if(copy)await view.submit();else await view.click('Duplicar como novo');view.unmount();assert.equal(service.calls[0].signal.aborted,true);release();await new Promise(resolve=>setTimeout(resolve,10));assert.equal(service.saved.length,0);assert.equal(service.prepared.length,0);assert.equal(service.counts().reads,0);}
});
test('origin is fetched on reopen, minimally shown, bound to destination and safely retried',async()=>{
 const opened=[];let reads=0;const origin={document_id:targetId,kind,copy_source:preview().source,data_mode:'erp_native',operational_effects:false};
 const request=async()=>{reads++;if(reads===1)return{...origin,document_id:sourceId};return origin;};
 const view=await mountComponent('DocumentCopyOrigin.tsx',{request,record:outcome().document,blocked:false,onOpen:id=>opened.push(id)});
 try{assert.match(view.text(),/Não foi possível/);await view.click('Conferir origem novamente');assert.match(view.text(),/documento 7, versão 3/);await view.click('Abrir documento de origem');assert.deepEqual(opened,[sourceId]);await view.updateProps({blocked:true});assert.equal(view.button('Abrir documento de origem').disabled,true);view.button('Abrir documento de origem').props.onClick();assert.equal(opened.length,1);}finally{view.unmount();}
});
test('parent discards only the unsaved copy and returns to source; successful copy navigates to the destination UUID',async()=>{
 const service=server();service.controller.documents=async path=>path==='/v1/documentos'?{read:[kind],write:[kind],data_mode:'erp_native'}:path.includes('?')?{items:[],has_more:false,next_cursor:null}: {document:path.endsWith(targetId)?{...outcome().document,version:5}:clone(source)};
 const view=await mountComponent('RealDocuments.tsx',{controller:service.controller,initialKind:kind},{location:`/documentos-empresa?tipo=${kind}&documento=${sourceId}`});
 try{child(view,'Editor').props.onCopyPrepared(draft());await view.flush();assert.equal(child(view,'Editor').props.record,null);assert.equal(child(view,'Editor').props.copyDraft.preview.source.id,sourceId);child(view,'Editor').props.onClose();await view.flush();assert.equal(child(view,'Editor').props.record.id,sourceId);assert.equal(child(view,'Editor').props.copyDraft,null);
  child(view,'Editor').props.onCopyPrepared(draft());await view.flush();child(view,'Editor').props.onCopied({...outcome().document,version:5});await view.flush();assert.equal(new URLSearchParams(view.location().search).get('documento'),targetId);assert.equal(child(view,'Editor').props.record.id,targetId);assert.equal(child(view,'Editor').props.copyDraft,null);
 }finally{view.unmount();}
});
test('documentCopy controller keeps authenticated requests within its own API prefix',async()=>{
 const session={access_token:'synthetic-test-token',user:{id:actor}},calls=[];const auth={getSession:async()=>({data:{session},error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signInWithPassword:async()=>({data:{session},error:null}),signOut:async()=>({error:null})};
 const controller=createAccessController(auth,'https://synthetic.invalid',async(url,options)=>{calls.push({url,options});return Response.json(url.endsWith('/me')?{user_id:actor,role:'vendas',resources:[],data_mode:'staging_readonly'}:{ok:true});});const stop=controller.start();await new Promise(resolve=>setTimeout(resolve,5));
 try{await controller.documentCopy(`/v1/duplicacao-documentos/${kind}/${sourceId}/preview`);assert.equal(calls[1].options.headers.Authorization,'Bearer synthetic-test-token');assert.equal(calls[1].options.credentials,'omit');for(const path of ['https://elsewhere.invalid/v1/duplicacao-documentos/x','/v1/documentos/x','/v1/duplicacao-documentos-evil/x'])await assert.rejects(()=>controller.documentCopy(path));assert.equal(calls.length,2);}finally{stop();}
});
