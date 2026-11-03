import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {boletoItems,boletoPreview,captureBoletoRead} from '../src/lib/boleto-preview-model.ts';
import {boletoFixture,actor} from '../../../workers/erp-api/test/helpers/boleto-preview-fixture.mjs';
import {mountComponent} from './helpers/component-recovery-harness.mjs';
import {AccessError} from '../src/lib/real-access.ts';
import {OPERATIONAL_FLAGS} from '../src/lib/cnab-operational-model.ts';
const fixtures={homologation:await boletoFixture(),operational:await boletoFixture('operational')},copy=structuredClone;
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const frames=v=>v.nodes().filter(n=>n.type==='iframe'),PRINT='Imprimir prévia NÃO PAGAR';
function setup({purpose='homologation',read}={}){
 const f=fixtures[purpose],listeners=new Set(),calls=[];let state={phase:'ready',membership:{role:'financeiro',user_id:actor}},closed=0;
 const controller={getSnapshot:()=>state,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},async boletoPreview(path,options={}){const call={path,options};calls.push(call);if(read)return read(call);return copy(path.endsWith('/items')?f.items:f.response);}};
 return{f,controller,calls,close(){closed++;},closed:()=>closed,change(value){state=value;for(const fn of listeners)fn();},listeners:()=>listeners.size};
}
const mount=s=>mountComponent('ItauBoletoPreview.tsx',{controller:s.controller,file:copy(s.f.file),purpose:s.f.purpose,onClose:s.close},{ports:{AccessError}});
function frame(v){const node=v.find(n=>n.type==='iframe'),calls={print:0,focus:0},element={contentWindow:{focus(){calls.focus++;},print(){calls.print++;}}};node.props.ref.current=element;return{node,calls,element,async load(){node.props.onLoad({currentTarget:element});await v.flush();}};}
test('066 UI DTO accepts exact real renderer output for both persisted purposes and frozen snapshots',async()=>{
 for(const purpose of ['homologation','operational']){const f=fixtures[purpose],items=boletoItems(f.items,f.file,purpose),p=await boletoPreview(f.response,items,items.items[0]);assert.equal(p.canPay,false);assert.equal(p.htmlHash,f.response.htmlHash);assert.ok(Object.isFrozen(p)&&Object.isFrozen(p.source));}
 const f=fixtures.homologation,items=boletoItems(f.items,f.file,'homologation');
 for(const mutate of [v=>v.canPay=true,v=>v.source.remittance_hash='a'.repeat(64),v=>v.source.billing_title_id=randomUUID(),v=>v.binding.amountCents='999',v=>v.current.settled_cents='1',v=>v.htmlHash='a'.repeat(64),v=>v.sizeBytes++,v=>v.private_context=true]){const raw=copy(f.response);mutate(raw);await assert.rejects(()=>boletoPreview(raw,items,items.items[0]));}
 let invoked=false;const accessor=copy(f.response);Object.defineProperty(accessor,'html',{enumerable:true,get(){invoked=true;return f.response.html;}});await assert.rejects(()=>boletoPreview(accessor,items,items.items[0]));assert.equal(invoked,false);
});
test('066 HTML guard rejects active markup even when forged bytes/hash/size agree',async()=>{
 const f=fixtures.homologation,items=boletoItems(f.items,f.file,'homologation');
 for(const html of [f.response.html.replace('</body>','<script>alert(1)</script></body>'),f.response.html.replace('<main ','<main onclick="x()" '),f.response.html.replace('style-src', 'script-src'),f.response.html.replace('<style>','<style>@import "https://evil.invalid";'),f.response.html.replace('</body>','<img src="https://evil.invalid"></body>')]){
  const raw={...copy(f.response),html,htmlHash:createHash('sha256').update(html).digest('hex'),sizeBytes:Buffer.byteLength(html)};await assert.rejects(()=>boletoPreview(raw,items,items.items[0]));
 }
});
test('066 list reader and request capture reject foreign origins, extra inputs, duplicate identities and getters',()=>{
 const f=fixtures.homologation;
 for(const mutate of [v=>v.remittance_hash='b'.repeat(64),v=>v.items.push(v.items[0]),v=>v.items[0].due_on='2026-02-30',v=>v.raw='PRIVATE']){const raw=copy(f.items);mutate(raw);assert.throws(()=>boletoItems(raw,f.file,'homologation'));}
 const path=`/v1/boletos-itau/${f.billing}/preview`,c=new AbortController(),o={signal:c.signal};const own=captureBoletoRead(path,o);o.signal=new AbortController().signal;assert.equal(own.signal,c.signal);
 for(const bad of [{method:'POST'},{body:{}},{signal:3}])assert.throws(()=>captureBoletoRead(path,bad));
 for(const suffix of ['?x=1','#x','/x'])assert.throws(()=>captureBoletoRead(path+suffix));
 let invoked=false;assert.throws(()=>captureBoletoRead(path,Object.defineProperty({},'method',{enumerable:true,get(){invoked=true;return'GET';}})));assert.equal(invoked,false);
});
test('066 UI reads items only on mount, opens selected document by GET and prints only after an inert frame load',async()=>{
 for(const purpose of ['homologation','operational']){const s=setup({purpose}),v=await mount(s);try{
  assert.equal(s.calls.length,1);assert.match(s.calls[0].path,/\/items$/);assert.equal(frames(v).length,0);assert.match(v.text(),/NÃO PAGAR/);
  await v.click('Visualizar TESTE/001');assert.equal(s.calls.length,2);assert.ok(s.calls.every(c=>(c.options.method??'GET')==='GET'&&!c.options.body));
  const f=frame(v);assert.equal(f.node.props.srcDoc,s.f.response.html);assert.equal(f.node.props.sandbox,'allow-same-origin allow-modals');assert.equal(f.node.props.referrerPolicy,'no-referrer');assert.equal(f.node.props.src,undefined);
  assert.equal(v.button(PRINT).disabled,true);v.button(PRINT).props.onClick();assert.equal(f.calls.print,0);await f.load();await v.click(PRINT);assert.equal(f.calls.print,1);assert.equal(s.calls.length,2);
  assert.match(v.text(),/cadastro atual da empresa, versão 1/);assert.doesNotMatch(v.text(),/Emitir boleto|Enviar boleto/);
 }finally{v.unmount();assert.equal(s.listeners(),0);}}
});
test('066 closing, unmounting or changing the source aborts reads and ignores late HTML',async()=>{
 for(const action of ['back','unmount','source']){const g=gate(),s=setup({read:c=>c.path.endsWith('/items')?copy(fixtures.homologation.items):g.promise}),v=await mount(s);let gone=false;try{
  await v.click('Visualizar TESTE/001');assert.equal(v.guard().busy,true);
  if(action==='back'){await v.click('Voltar às remessas');assert.equal(s.closed(),1);}else if(action==='unmount'){v.unmount();gone=true;}else await v.updateProps({file:{...s.f.file,file_hash:'f'.repeat(64)}});
  assert.equal(s.calls[1].options.signal.aborted,true);g.resolve(copy(s.f.response));await v.flush();assert.equal(frames(v).length,0);assert.ok(s.calls.filter(c=>c.path.endsWith('/preview')).length===1);
 }finally{g.resolve(copy(s.f.response));if(!gone)v.unmount();}}
});
test('066 logout, actor/role changes and old callbacks cannot retain or print prior HTML',async()=>{
 for(const next of [{phase:'signed_out',membership:null},{phase:'ready',membership:{user_id:randomUUID(),role:'financeiro'}},{phase:'ready',membership:{user_id:actor,role:'vendas'}}]){
  const s=setup(),v=await mount(s);try{await v.click('Visualizar TESTE/001');const f=frame(v);await f.load();const print=v.button(PRINT).props.onClick;s.change(next);await v.flush();f.node.props.onLoad({currentTarget:f.element});print();assert.equal(f.calls.print,0);assert.equal(frames(v).length,0);}finally{v.unmount();}
 }
 const s=setup(),v=await mount(s);try{
  await v.click('Visualizar TESTE/001');const a=frame(v);await a.load();const old=v.button(PRINT).props.onClick;await v.click('Fechar prévia');
  await v.click('Visualizar TESTE/001');const b=frame(v);old();a.node.props.onLoad({currentTarget:a.element});await v.flush();assert.equal(b.calls.print,0);assert.equal(v.button(PRINT).disabled,true);await b.load();await v.click(PRINT);assert.equal(b.calls.print,1);
 }finally{v.unmount();}
});
test('066 changed binding or error cannot display HTML and read failures never retry automatically',async()=>{
 for(const code of [401,403,404,409,422,503]){const s=setup({read:c=>{if(c.path.endsWith('/items'))return copy(fixtures.homologation.items);throw new AccessError(code);}}),v=await mount(s);try{await v.click('Visualizar TESTE/001');assert.equal(frames(v).length,0);assert.ok(v.nodes().some(n=>n.props.role==='alert'));await v.flush();assert.equal(s.calls.length,2);assert.equal(v.guard().busy,false);}finally{v.unmount();}}
 const raw=copy(fixtures.homologation.response);raw.source.profile_id=randomUUID();const s=setup({read:c=>copy(c.path.endsWith('/items')?fixtures.homologation.items:raw)}),v=await mount(s);try{await v.click('Visualizar TESTE/001');assert.equal(frames(v).length,0);}finally{v.unmount();}
});

test('066 both remittance screens open the GET-only preview for ready Itaú109, including read-only roles',async()=>{
 for(const purpose of ['homologation','operational']){
  const s=setup({purpose}),f=s.f;
  const profile={id:f.file.profile_id,account_id:f.context.snapshot.profile.accountId,account_name:'CONTA FICTICIA',bank:'341',wallet:'109',account_mask:'***345',company_name:'EMPRESA FICTICIA',version:2,contract_verified:true,policy_verified:true,next_sequence:'2'};
  const approval={profile_id:profile.id,approval_version:1,enabled:true,effective_enabled:true,profile_version:2,identity_version:1,reference:'CONFERENCIA SINTETICA',confirmed_on:'2025-02-22',reviewed_at:'2025-02-22T12:00:00Z',issues:[]};
  const file={...f.file,filename:'ITAU_COBRANCA_0000001.REM'},reads=[];
  const rights={read:true,write:false,configure:false};
  s.change({phase:'ready',membership:{user_id:actor,role:'consulta'}});
  s.controller.cnab=async(path,options={})=>{reads.push({path,options});assert.equal(options.body,undefined);if(path==='/v1/cnab')return rights;if(path.endsWith('/profiles'))return{items:[profile]};return{items:[file],limit:25,has_more:false,next_cursor:null};};
  s.controller.cnabOperational=async(path,options={})=>{reads.push({path,options});assert.equal(options.body,undefined);return path.endsWith('/profiles')?{...OPERATIONAL_FLAGS,items:[{profile,approval}]}:{...OPERATIONAL_FLAGS,items:[file],limit:25,has_more:false,next_cursor:null};};
  const filename=purpose==='operational'?'RealCnabOperational.tsx':'RealCnab.tsx';
  const v=await mountComponent(filename,{controller:s.controller},{expandChildren:['ItauBoletoPreview','LegacyCnabOperational','NativeListLayout'],ports:{AccessError}});
  try{
   assert.equal(s.calls.length,0);assert.doesNotMatch(v.text(),/Incluir remessa/i);
   await v.click('Prévia NÃO PAGAR');assert.equal(s.calls.length,1);assert.match(s.calls[0].path,/\/items$/);
   await v.click('Visualizar TESTE/001');assert.equal(s.calls.length,2);assert.equal(frames(v).length,1);
   assert.match(v.text(),purpose==='operational'?/Origem: remessa operacional/:/Origem: remessa de homologação/);
   await v.click('Voltar às remessas');assert.equal(frames(v).length,0);assert.equal(s.calls.length,2);
   assert.ok([...reads,...s.calls].every(c=>(c.options.method??'GET')==='GET'&&c.options.body===undefined));
  }finally{v.unmount();}
  profile.bank='077';profile.wallet='110';
  const other=await mountComponent(filename,{controller:s.controller},{expandChildren:['ItauBoletoPreview','LegacyCnabOperational','NativeListLayout'],ports:{AccessError}});
  try{assert.doesNotMatch(other.text(),/Prévia NÃO PAGAR/);}finally{other.unmount();}
 }
});
