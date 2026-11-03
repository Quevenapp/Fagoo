import test from 'node:test';
import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {journalPage,journalEnvelope,journalTextError,journalPath} from '../src/lib/service-journal-model.ts';
const documentId='10000000-0000-4000-8000-000000000001',actorId='20000000-0000-4000-8000-000000000001';
const base=(version=3,id=documentId,write=true)=>({scope:'service_order_journal',document_id:id,document_version:version,can_write:write,data_mode:'erp_native',operational_effects:false});
const row=(n,id=documentId)=>({id:crypto.randomUUID(),document_id:id,sequence:String(n),document_version:3,text:`Registro sintético ${n}`,actor_id:actorId,recorded_at:'2026-10-16T13:00:00.123456+00:00'});
const copy=v=>structuredClone(v);
function server({count=0,before=()=>{},after=()=>{}}={}){
 const calls=[],commands=new Map(),state={version:3,entries:Array.from({length:count},(_,i)=>row(i+1)),counts:{append:0,get:0,list:0}};
 const controller={async serviceJournal(path,options={}){
  const url=new URL(path,'https://synthetic.invalid'),parts=url.pathname.split('/'),id=parts[3],entryId=parts[5],operation=options.method==='POST'?'append':entryId?'get':'list';
  const call={path,operation,documentId:id,...options};calls.push(call);state.counts[operation]++;await before(call,state);
  let result;
  if(operation==='append'){
   const prior=commands.get(options.body.command_id);
   if(prior){assert.deepEqual(prior.body,options.body);result={...base(state.version,id),entry:prior.entry,replayed:true};}
   else{if(options.body.expected_document_version!==state.version)throw new AccessError(409);
    const entry={...row(state.entries.filter(e=>e.document_id===id).length+1,id),text:options.body.text.replace(/^ +| +$/g,''),document_version:state.version};
    state.entries.push(entry);commands.set(options.body.command_id,{body:copy(options.body),entry:copy(entry)});result={...base(state.version,id),entry,replayed:false};}
  }else if(operation==='get'){
   const entry=state.entries.find(e=>e.document_id===id&&e.id===entryId);if(!entry)throw new AccessError(404);result={...base(state.version,id),entry};
  }else{
   const cursor=url.searchParams.get('before'),limit=Number(url.searchParams.get('limit'));
   const matches=state.entries.filter(e=>e.document_id===id&&(!cursor||BigInt(e.sequence)<BigInt(cursor))).sort((a,b)=>Number(BigInt(b.sequence)-BigInt(a.sequence))),items=matches.slice(0,limit);
   result={...base(state.version,id),items,limit,has_more:matches.length>limit,next_before:matches.length>limit?items.at(-1).sequence:null};
  }
  await after(call,state);return copy(result);
 }};return{controller,calls,commands,state};
}
const mount=(s,props={})=>mountComponent('ServiceOrderJournal.tsx',{controller:s.controller,documentId,documentVersion:3,writable:true,actorId,...props});
const write=async(view,text='Atividade sintética')=>{await view.change('service-journal-text',text);await view.submit();};

test('journal model validates exact document/entry/version/actor and descending exclusive sequence pages',()=>{
 const a=row(2),b=row(1),page={...base(),items:[a,b],limit:2,has_more:true,next_before:'1'};
 assert.equal(journalPage(page,documentId,null,2).items.length,2);
 for(const mutate of [v=>v.items.reverse(),v=>v.items[0].sequence='02',v=>v.items[0].document_id=crypto.randomUUID(),v=>v.items[0].document_version=4,v=>v.items[0].text='\n',v=>v.operational_effects=true,v=>v.next_before='2']){const bad=copy(page);mutate(bad);assert.throws(()=>journalPage(bad,documentId,null,2));}
 const command={command_id:crypto.randomUUID(),text:a.text,expected_document_version:3},response={...base(),entry:a,replayed:false};
 assert.equal(journalEnvelope(response,documentId,{command,actorId}).entry.id,a.id);
 assert.throws(()=>journalEnvelope(response,documentId,{entryId:crypto.randomUUID()}));assert.throws(()=>journalEnvelope(response,documentId,{command:{...command,text:'Outro texto'},actorId}));
 assert.equal(journalTextError('😀'.repeat(4000)),null);assert.ok(journalTextError('x'.repeat(4001)));assert.ok(journalTextError(' \n\t '));assert.throws(()=>journalPath('../secret'));
});
test('journal lost POST response freezes exact command/text through403 and recovers one immutable entry',async()=>{
 const s=server({before(call,state){if(call.operation==='append'&&state.counts.append===2)throw new AccessError(403);},after(call,state){if(call.operation==='append'&&state.counts.append===1)throw new AccessError(503);}}),view=await mount(s);
 try{await write(view);assert.equal(view.guard().busy,true);assert.equal(view.input('service-journal-text').disabled,true);assert.equal(view.button('Limpar texto').disabled,true);
  view.input('service-journal-text').props.onChange({target:{value:'Texto trocado'}});view.button('Limpar texto').props.onClick();view.button('Atualizar diário').props.onClick();await view.flush();
  assert.equal(view.input('service-journal-text').props.value,'Atividade sintética');await view.click('Repetir a mesma confirmação');assert.equal(view.guard().busy,true);
  await view.click('Repetir a mesma confirmação');assert.equal(s.commands.size,1);assert.equal(s.state.entries.length,1);const writes=s.calls.filter(c=>c.operation==='append');assert.equal(writes.length,3);assert.deepEqual(writes[0].body,writes[2].body);
  assert.equal(view.guard().busy,false);assert.equal(view.guard().changed,false);assert.match(view.text(),/Registro 1 incluído/);assert.match(view.text(),/Registrado por você/);
 }finally{view.unmount();}
});
test('journal confirmed append with failed readback retries GET only and never clears the draft early',async()=>{
 const s=server({before(call,state){if(call.operation==='get'&&state.counts.get===1)throw new AccessError(503);}}),view=await mount(s);
 try{await write(view);assert.equal(view.guard().busy,true);assert.equal(view.input('service-journal-text').props.value,'Atividade sintética');assert.match(view.text(),/Consultar registro confirmado/);
  await view.click('Consultar registro confirmado');assert.equal(s.state.counts.append,1);assert.equal(s.state.counts.get,2);assert.equal(view.guard().busy,false);assert.equal(s.state.entries.length,1);
 }finally{view.unmount();}
});
test('journal known CAS conflict preserves text and requires current document before another append',async()=>{
 let refreshes=0;const s=server({before(call,state){if(call.operation==='append'&&state.counts.append===1)state.version++;}}),view=await mount(s,{onRefreshDocument:()=>refreshes++});
 try{await write(view);assert.equal(s.commands.size,0);assert.equal(view.guard().busy,false);assert.equal(view.input('service-journal-text').props.value,'Atividade sintética');assert.equal(view.button('Registrar atividade').disabled,true);assert.match(view.text(),/A OS mudou/);
  assert.equal(view.button('Atualizar documento').disabled,true);await view.click('Limpar texto');await view.click('Atualizar documento');assert.equal(refreshes,1);
  await view.updateProps({documentVersion:4});await write(view,'Registro com versão atual');assert.equal(s.commands.size,1);assert.equal(s.calls.filter(c=>c.operation==='append').at(-1).body.expected_document_version,4);
 }finally{view.unmount();}
});
test('journal paging is chronological; refresh returns latest while local text remains guarded',async()=>{
 const s=server({count:30}),view=await mount(s);
 try{assert.match(view.text(),/Registro sintético 30/);assert.doesNotMatch(view.text(),/Registro sintético 5\b/);await view.change('service-journal-text','Texto ainda não salvo');await view.click('Mais antigos');assert.match(view.text(),/Registro sintético 5/);assert.equal(view.guard().changed,true);
  s.state.entries.push(row(31));await view.click('Atualizar diário');assert.match(view.text(),/Registro sintético 31/);assert.equal(view.input('service-journal-text').props.value,'Texto ainda não salvo');
 }finally{view.unmount();}
});
test('journal ignores old document reads and aborts pending append on unmount without starting readback',async()=>{
 let release,signal;const s=server({before(call,state){if(call.operation==='list'&&state.counts.list===1)return new Promise(resolve=>{release=resolve;signal=call.signal;});}}),view=await mount(s);
 const other='10000000-0000-4000-8000-000000000002';await view.updateProps({documentId:other});assert.equal(signal.aborted,true);release();await view.flush();await write(view);assert.equal(s.calls.find(c=>c.operation==='append').documentId,other);view.unmount();
 let finish,postSignal;const t=server({before(call){if(call.operation==='append')return new Promise(resolve=>{finish=resolve;postSignal=call.signal;});}}),flags=[];
 const pending=await mount(t,{onBusy:v=>flags.push(v)});await write(pending);assert.equal(pending.guard().busy,true);pending.unmount();assert.equal(postSignal.aborted,true);assert.equal(flags.at(-1),false);finish();await new Promise(resolve=>setTimeout(resolve,5));assert.equal(t.state.counts.get,0);
});
test('journal initial read failure and read-only membership cannot create a misleading writable form',async()=>{
 const s=server({before(call,state){if(call.operation==='list'&&state.counts.list===1)throw new AccessError(503);}}),view=await mount(s);
 try{assert.equal(view.button('Registrar atividade').disabled,true);await view.click('Atualizar diário');assert.equal(view.button('Registrar atividade').disabled,false);await view.updateProps({blocked:true});assert.equal(view.button('Registrar atividade').disabled,true);}finally{view.unmount();}
 const readonly=await mount(server(),{writable:false});try{assert.equal(readonly.nodes().filter(n=>n.type==='form').length,0);}finally{readonly.unmount();}
});
