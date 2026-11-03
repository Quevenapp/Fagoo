import test from 'node:test';
import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {unsignedFixture,unsignedUuid,numberFlags} from './helpers/fiscal-unsigned-fixtures.mjs';
import {UNSIGNED_FLAGS} from '../src/lib/fiscal-unsigned-model.ts';
const copy=structuredClone;
const text=v=>Array.isArray(v)?v.map(text).join(''):v&&typeof v==='object'?text(v.props?.children):v==null||typeof v==='boolean'?'':String(v);
// Match the actual checkbox by its containing label; node wrappers are copies in the hook harness.
const checkbox=(v,label)=>{const l=v.find(n=>n.type==='label'&&text(n).includes(label)),walk=x=>Array.isArray(x)?x.map(walk).find(Boolean):x?.type==='input'?x:undefined;return walk(l.props.children);};
const toggle=async(v,label,yes=true)=>{const n=checkbox(v,label);n.props.onChange({target:{checked:yes}});await v.flush();};
const seriesField=v=>v.find(n=>n.type==='select');
function service({reserved=false,jobState=null,before=()=>{},after=()=>{},model='55',count=1}={}){
 const f=unsignedFixture({model,count}),s={f,reserved,job:null,calls:[],counts:{},numberCommands:new Map(),jobCommands:new Map(),role:'admin'};
 if(jobState)s.job=jobState==='pending'?{...copy(f.job),status:'pending',xml_generated:false,current:{...f.job.current,artifact_current:false,lease_until:'2026-10-16T12:01:00Z'},artifact:null}:copy(f.job);
 const history=body=>({...UNSIGNED_FLAGS,read_only:true,reservation_id:f.reservation.id,items:s.job&&(!body.before||s.job.job_version<body.before)?[copy(s.job)]:[],limit:25,has_more:false,next_cursor:null});
 const call=async(channel,path,o={})=>{
  const kind=channel==='completion'?'completion':path.includes('/series?')?'series':path.includes('/drafts/')?'reservation':path.endsWith('/reservations')?'reserve':path.endsWith('/preview')?'preview':path.endsWith('/generate')?'generate':path.endsWith('/history')?'history':path.includes('/commands/')?channel==='numbering'?'numberCommand':'jobCommand':'job';
  const c={kind,path,method:o.method??'GET',body:copy(o.body),signal:o.signal};s.calls.push(c);s.counts[kind]=(s.counts[kind]??0)+1;await before(c,s);let value;
  if(kind==='completion')value=f.completion;
  else if(kind==='series')value={...numberFlags,read_only:true,items:[copy(f.series)],limit:25,has_more:false,next_cursor:null};
  else if(kind==='reservation')value=s.reserved?f.reserveEnvelope:{...numberFlags,read_only:true,receipt:null,current_series:null,current_basis:null};
  else if(kind==='reserve'){
   let result=s.numberCommands.get(o.body.command_id);if(!result){s.reserved=true;result={...copy(f.reserveEnvelope),read_only:undefined,action:'reserve',command_id:o.body.command_id,replayed:false};s.numberCommands.set(o.body.command_id,result);}value={...result,replayed:s.counts.reserve>1};
  }else if(kind==='numberCommand'){value=s.numberCommands.get(path.split('/').at(-1));if(!value)throw new AccessError(404);}
  else if(kind==='preview')value=f.preview;
  else if(kind==='generate'){
   if(!s.job)s.job=copy(f.job);s.jobCommands.set(o.body.command_id,copy(o.body));value={...copy(s.job),read_only:undefined,command_id:o.body.command_id};
  }else if(kind==='jobCommand'){const command=path.split('/').at(-1);if(!s.jobCommands.has(command))throw new AccessError(404);value={...copy(s.job),read_only:true,command_id:command};}
  else if(kind==='job'){if(!s.job)throw new AccessError(404);value={...copy(s.job),read_only:true};}
  else value=history(o.body);
  await after(c,s);return copy(value);
 };
 s.controller={getSnapshot:()=>({phase:'ready',membership:{user_id:unsignedUuid(99),role:s.role}}),fiscalCompletion:(p,o)=>call('completion',p,o),fiscalNumbering:(p,o)=>call('numbering',p,o),fiscalUnsigned:(p,o)=>call('unsigned',p,o)};
 return s;
}
const mount=(s,props={})=>mountComponent('FiscalUnsignedPreview.tsx',{controller:s.controller,value:copy(s.f.draft),...props});
const writes=s=>s.calls.filter(c=>['reserve','generate'].includes(c.kind));
async function preview(v){await v.click('Conferir conteúdo e somas');}
async function prepareReserve(s,v){await preview(v);await v.change(seriesField(v).props.id,s.f.series.id);await toggle(v,'reserva permanente');}
async function prepareGenerate(v){await preview(v);await toggle(v,'Confirmo a geração');}

test('048 starts without automatic series/reservation/generation; explicit reservation and generation remain separate',async()=>{
 const s=service({count:250,model:'65'}),v=await mount(s);try{
  assert.equal(writes(s).length,0);assert.equal(seriesField(v).props.value,'');assert.equal(v.button('Reservar número de homologação').disabled,true);assert.equal(v.button('Gerar XML sem assinatura').disabled,true);assert.match(v.text(),/250 itens/);
  await prepareReserve(s,v);assert.equal(checkbox(v,'Confirmo a geração').props.checked,false);await v.click('Reservar número de homologação');
  assert.equal(s.counts.reserve,1);assert.equal(s.counts.generate,undefined);assert.equal(s.counts.numberCommand,1);assert.equal(v.guard().busy,false);assert.match(v.text(),/999999998/);assert.equal(v.button('Gerar XML sem assinatura').disabled,true);
  await toggle(v,'Confirmo a geração');await v.click('Gerar XML sem assinatura');assert.equal(s.counts.generate,1);assert.equal(s.counts.jobCommand,1);assert.equal(s.counts.job,1);assert.match(v.text(),/Arquivo sem assinatura guardado/);assert.equal(v.guard().busy,false);assert.equal(v.guard().changed,false);assert.match(v.text(),new RegExp(s.f.job.artifact.sha256));assert.equal(s.job.basis_hash,s.f.job.basis_hash);assert.equal(s.job.completion_hash,s.f.job.completion_hash);assert.equal(v.button('Gerar XML sem assinatura').disabled,true);
  const payload=writes(s).find(c=>c.kind==='generate').body;assert.equal('cNF'in payload,false);assert.equal('number'in payload,false);assert.equal('actor'in payload,false);assert.equal(payload.reservation_id,s.f.reservation.id);
 }finally{v.unmount();}
});
for(const action of['reserve','generate'])for(const status of[403,409])test(`048 lost ${action} reply then read${status} freezes intent and recovers with GET only`,async()=>{
 const s=service({reserved:action==='generate',after(c,s){if(c.kind===action&&s.counts[action]===1)throw new AccessError(503);},before(c,s){if(c.kind===(action==='reserve'?'numberCommand':'jobCommand')&&s.counts[c.kind]===1)throw new AccessError(status);}}),v=await mount(s);try{
  if(action==='reserve')await prepareReserve(s,v);else await prepareGenerate(v);
  const old=[v.button('Recarregar conferência'),v.button('Descartar conferência local'),v.button('Conferir conteúdo e somas')],stale=checkbox(v,action==='reserve'?'reserva permanente':'Confirmo a geração');
  await v.click(action==='reserve'?'Reservar número de homologação':'Gerar XML sem assinatura');assert.equal(v.guard().busy,true);await v.click('Conferir resultado da operação');assert.equal(v.guard().busy,true);
  const calls=s.calls.length;for(const node of old){node.props.onClick();await v.flush();}stale.props.onChange({target:{checked:false}});await v.flush();await v.updateProps({refreshKey:1});assert.equal(s.calls.length,calls);assert.equal(v.guard().busy,true);
  await v.click('Conferir resultado da operação');assert.equal(s.counts[action],1);assert.equal(s.numberCommands.size+s.jobCommands.size,1);assert.equal(v.guard().busy,false);
 }finally{v.unmount();}
});
test('048 uncertain absence requires explicit same-command resend, never an automatic POST after404',async()=>{
 const s=service({reserved:true,before(c,s){if(c.kind==='generate'&&s.counts.generate===1)throw new AccessError(503);}}),v=await mount(s);try{
  await prepareGenerate(v);await v.click('Gerar XML sem assinatura');await v.click('Conferir resultado da operação');assert.equal(s.counts.generate,1);assert.equal(v.guard().busy,true);await v.click('Reenviar a mesma confirmação');assert.equal(s.counts.generate,2);const posts=writes(s);assert.deepEqual(posts[0].body,posts[1].body);assert.equal(s.jobCommands.size,1);assert.equal(v.guard().busy,false);
 }finally{v.unmount();}
});
test('048 acknowledged write with failed current GET only rereads; a swapped current job stays blocked',async()=>{
 const s=service({reserved:true,before(c,s){if(c.kind==='job'&&s.counts.job===1)throw new AccessError(503);}}),v=await mount(s);try{
  await prepareGenerate(v);await v.click('Gerar XML sem assinatura');assert.equal(s.counts.generate,1);assert.equal(v.guard().busy,true);s.job.basis_hash='b'.repeat(64);await v.click('Conferir resultado da operação');assert.equal(v.guard().busy,true);s.job.basis_hash=s.f.job.basis_hash;await v.click('Conferir resultado da operação');assert.equal(s.counts.generate,1);assert.equal(v.guard().busy,false);assert.equal(v.nodes().some(n=>n.type==='button'&&text(n)==='Reenviar a mesma confirmação'),false);
 }finally{v.unmount();}
});
test('048 pending job guards parent and allows explicit resume, preserving original command when known',async()=>{
 const s=service({reserved:true}),v=await mount(s);try{
  await prepareGenerate(v);s.job={...copy(s.f.job),status:'pending',xml_generated:false,current:{...s.f.job.current,artifact_current:false,lease_until:'2026-10-16T12:01:00Z'},artifact:null};
  await v.click('Gerar XML sem assinatura');assert.equal(v.guard().busy,true);assert.equal(v.button('Recarregar conferência').disabled,true);assert.equal(v.button('Solicitar retomada da geração pendente').disabled,true);
  await toggle(v,'Confirmo a geração');assert.equal(v.button('Solicitar retomada da geração pendente').disabled,false);s.job=copy(s.f.job);await v.click('Solicitar retomada da geração pendente');assert.equal(s.counts.generate,2);assert.deepEqual(writes(s)[0].body,writes(s)[1].body);assert.equal(s.jobCommands.size,1);assert.equal(v.guard().busy,false);
 }finally{v.unmount();}
});
test('048 pending reopen never auto-resumes; explicit request uses same job bases and a new actor command',async()=>{
 const s=service({reserved:true,jobState:'pending'}),v=await mount(s);try{
  assert.equal(s.counts.generate,undefined);assert.equal(v.guard().busy,true);await toggle(v,'Confirmo a geração');s.job=copy(s.f.job);await v.click('Solicitar retomada da geração pendente');assert.equal(s.counts.reserve,undefined);assert.equal(writes(s)[0].body.reservation_id,s.f.reservation.id);assert.equal(writes(s)[0].body.basis_hash,s.f.job.basis_hash);
 }finally{v.unmount();}
});
test('048 confirmed stored by later status GET clears local dirty choices but preserves reservation, result and exact hashes',async()=>{
 const s=service({reserved:true}),v=await mount(s);try{
  await prepareGenerate(v);s.job={...copy(s.f.job),status:'pending',xml_generated:false,current:{...s.f.job.current,artifact_current:false,lease_until:'2026-10-16T12:01:00Z'},artifact:null};await v.click('Gerar XML sem assinatura');assert.equal(v.guard().changed,true);assert.equal(v.guard().busy,true);
  s.job=copy(s.f.job);const original=copy(s.job);await v.click('Consultar andamento da geração');assert.equal(v.guard().changed,false);assert.equal(v.guard().busy,false);assert.deepEqual(s.job,original);assert.match(v.text(),new RegExp(original.artifact.sha256));assert.match(v.text(),/Série 123 · número 999999998/);assert.equal(s.counts.generate,1);assert.equal(v.button('Gerar XML sem assinatura').disabled,true);
 }finally{v.unmount();}
});
test('048 durable pending with changed bases can release local monitoring without cancellation, writes or lost reservation',async()=>{
 const events=[],s=service({reserved:true,jobState:'pending'});s.job.current.basis_changed=true;const v=await mount(s,{onBusy:x=>events.push(x)});try{
  assert.equal(v.guard().busy,true);assert.equal(v.button('Solicitar retomada da geração pendente').disabled,true);const calls=s.calls.length;
  await v.click('Deixar geração para consultar depois');assert.equal(v.guard().busy,false);assert.equal(v.guard().changed,false);assert.equal(events.at(-1),false);assert.equal(s.calls.length,calls);assert.equal(s.reserved,true);assert.equal(s.job.status,'pending');assert.match(v.text(),/nenhuma ação fiscal foi cancelada/);assert.equal(v.button('Recarregar conferência').disabled,false);
  await v.click('Recarregar conferência');assert.equal(v.guard().busy,true);assert.equal(s.reserved,true);assert.equal(writes(s).length,0);
 }finally{v.unmount();}
});
test('048 unmount aborts write and ignores late ACK without any readback',async()=>{
 let release;const gate=new Promise(r=>release=r),events=[],s=service({reserved:true,after(c){if(c.kind==='generate')return gate;}}),v=await mount(s,{onBusy:x=>events.push(x)});await prepareGenerate(v);v.button('Gerar XML sem assinatura').props.onClick();await v.flush();const write=writes(s)[0];v.unmount();const count=events.length;release();await new Promise(r=>setTimeout(r,10));assert.equal(write.signal.aborted,true);assert.equal(s.counts.jobCommand,undefined);assert.equal(events.length,count);
});
test('048 changed parent bases do not reset a local preview; history reads remain metadata-only',async()=>{
 const s=service({reserved:true,jobState:'stored'}),v=await mount(s);try{
  await preview(v);await v.updateProps({refreshKey:1});assert.equal(v.button('Gerar XML sem assinatura').disabled,true);assert.match(v.text(),/conferência foi preservada/);await v.click('Recarregar conferência');assert.equal(v.guard().changed,false);await v.click('Consultar histórico de gerações');assert.equal(v.find(n=>n.props.role==='region').props.tabIndex,0);assert.match(v.text(),/Arquivo corresponde às bases consultadas/);assert.equal(writes(s).length,0);
 }finally{v.unmount();}
});
