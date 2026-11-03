import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';

// Synthetic controller responses only: these tests invoke the production editor
// handlers, but never start a browser, call an API or create banking instructions.
const oldDocument=globalThis.document;
before(()=>{globalThis.document={activeElement:null};});
after(()=>{if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;});
const clone=value=>structuredClone(value);
const text=value=>Array.isArray(value)?value.map(text).join(''):value&&typeof value==='object'?text(value.props?.children):value===null||value===undefined||typeof value==='boolean'?'':String(value);
const profile={id:'10000000-0000-4000-8000-000000000001',account_id:'20000000-0000-4000-8000-000000000001',account_name:'CONTA FICTICIA',bank:'341',wallet:'109',account_mask:'****00000',company_name:'EMPRESA FICTICIA',version:1,contract_verified:true,policy_verified:true,next_sequence:'1'};
const title={id:'40000000-0000-4000-8000-000000000001',version:1,kind:'receivable',cancelled:false,settled_cents:'0',amount_cents:'2570',issued_on:'2020-01-01',due_on:'2099-12-31',description:'TITULO FICTICIO',contact_name:'PAGADOR FICTICIO',installment:1,installments:1};
const fixtureFile=new File(['SYNTHETIC UI RECOVERY FIXTURE'.padEnd(400,' ')+'\r\n'],'SYNTHETIC.RET',{type:'application/octet-stream'});
const reservedFile={id:'30000000-0000-4000-8000-000000000001',profile_id:profile.id,kind:'remittance',state:'reserved',file_hash:null,byte_size:null,sequence:'7',titles:1,filename:'SYNTHETIC.REM',generated_on:'2026-10-16',created_at:'2026-10-16T12:00:00Z'};
function server({before=()=>{},after=()=>{}}={}){
 const state={profiles:[clone(profile)],files:[]},calls=[],commands=new Map(),counts={profile:0,approval:0,remittance:0,return:0,resume:0,preview:0,profiles:0,files:0};
 const controller={
  async finance(path){return path.includes('/accounts')?{items:[{id:profile.account_id,name:profile.account_name,active:true}],has_more:false,next_cursor:null}:{items:[clone(title)],has_more:false,next_cursor:null};},
  async cnab(path,options={}){
   const op=options.method==='POST'?path.endsWith('/approval')?'approval':path.endsWith('/resume')?'resume':path.endsWith('/preview')?'preview':path.endsWith('/profiles')?'profile':path.endsWith('/remittances')?'remittance':'return':path==='/v1/cnab/profiles'?'profiles':'files';
   const call={op,path,...options};calls.push(call);counts[op]++;await before(call,{state,calls,commands,counts});let result;
   if(op==='profiles')result={items:clone(state.profiles)};
   else if(op==='files'){
    const url=new URL(path,'https://synthetic.invalid'),kind=url.pathname.endsWith('/remittances')?'remittance':'return';
    const rows=state.files.filter(row=>row.kind===kind&&row.id>(url.searchParams.get('after')||'')).sort((a,b)=>a.id.localeCompare(b.id));
    result={items:clone(rows.slice(0,Number(url.searchParams.get('limit')||25))),has_more:false,next_cursor:null,limit:1};
   }else if(op==='preview')result={preview:true,profile_id:profile.id,sequence:'1',total_cents:'2570',titles:1,warnings:[],productionReady:false};
   else if(op==='resume'){
    const row=state.files.find(file=>path.includes(file.id));assert.ok(row,'resume must target an existing reservation');
    row.state='ready';row.file_hash='b'.repeat(64);row.byte_size=402;result={id:row.id,file_hash:row.file_hash,replayed:counts.resume>1};
   }
   else{
    result=commands.get(options.body.command_id);
    if(result)result={...clone(result),replayed:true};
    else{
     if(op==='profile'){
      const data=options.body.data,row={...clone(profile),company_name:data.companyName};state.profiles=[row];result={profile:clone(row),replayed:false};
     }else if(op==='approval'){
      const row=state.profiles[0];Object.assign(row,options.body.data,{version:row.version+1});result={profile:clone(row),replayed:false};
     }else{
      const row={id:'30000000-0000-4000-8000-000000000001',profile_id:profile.id,kind:op,state:'ready',file_hash:'a'.repeat(64),byte_size:402,sequence:op==='remittance'?'1':null,titles:1,filename:'SYNTHETIC.RET',generated_on:'2026-10-16',created_at:'2026-10-16T12:00:00Z'};
      state.files.push(row);result={id:row.id,file_hash:row.file_hash,replayed:false};
     }
     commands.set(options.body.command_id,clone(result));
    }
   }
   await after(call,{state,calls,commands,counts});return clone(result);
  },
 };return{controller,state,calls,commands,counts};
}
async function mount(name,service){
 const saved=[],closed=[];
 const view=await mountComponent('RealCnab.tsx',{controller:service.controller,profile:clone(profile),profiles:[clone(profile)],file:clone(reservedFile),onSaved:id=>saved.push(id),onClose:()=>closed.push(true)},{componentName:name,expandChildren:true});
 return{view,saved,closed};
}
function inputFor(view,label){const node=view.find(n=>n.type==='label'&&text(n)===label);return view.input(node.props.htmlFor);}
async function change(view,label,value){await view.change(inputFor(view,label).props.id,value);}
async function checked(view,predicate,value=true){const node=view.find(n=>n.type==='input'&&n.props.type==='checkbox'&&predicate(n));assert.equal(node.disabled,false);node.props.onChange({target:{checked:value}});await view.flush();}
async function prepareProfile(view){
 await view.click(profile.account_name);
 for(const[label,value]of[
  ['Nome no arquivo · maiúsculas sem acento *','EMPRESA FICTICIA'],['CNPJ numérico do beneficiário *','00000000000000'],
  ['Agência · 4 dígitos *','0000'],['Conta · 5 dígitos *','00000'],['Dígito da conta *','0'],
  ['Sequência interna inicial FAGOO *','1'],['Próximo nosso número · 8 dígitos sem DV *','00000001'],['Referência da conferência / contrato *','FIXTURE SEM CONTRATO REAL'],
 ])await change(view,label,value);
 await view.submit();
}
async function prepareApproval(view){await change(view,'Referência da conferência *','REVISAO FICTICIA');await view.submit();}
async function prepareRemittance(view){
 await change(view,'Perfil de cobrança *',profile.id);
 await checked(view,n=>n.props['aria-label']?.startsWith('Selecionar '));
 await change(view,'Documento · TITULO FICTICIO *','TESTE-1');await view.submit();
 assert.match(view.text(),/Reservar números e gerar homologação/);
}
async function prepareReturn(view){
 await change(view,'Perfil de cobrança *',profile.id);
 const input=inputFor(view,'Arquivo CNAB 400 *');input.props.onChange({target:{files:[fixtureFile]}});await view.flush();await view.submit();
 assert.match(view.text(),/Guardar o retorno e preparar a revisão/);
}
function writes(service){return service.calls.filter(call=>['profile','approval','remittance','return','resume'].includes(call.op));}

test('new profiles expose only Itaú109 and reject an injected Inter bank or wallet without clearing reviewed data',async()=>{
 const service=server(),{view}=await mount('ProfileEditor',service);
 try{
  const option=view.find(n=>n.type==='option'&&n.props.value==='077');assert.equal(option.props.disabled,true);assert.match(text(option),/indisponível por enquanto/);
  await prepareProfile(view);await view.click('Voltar e conferir');
  await change(view,'Banco *','077');assert.equal(inputFor(view,'Banco *').props.value,'341');assert.equal(inputFor(view,'Carteira *').props.value,'109');
  assert.equal(inputFor(view,'Conta · 5 dígitos *').props.value,'00000');assert.equal(inputFor(view,'Sequência interna inicial FAGOO *').props.value,'1');assert.match(view.text(),/somente para Itaú/);
  await change(view,'Carteira *','110');assert.equal(inputFor(view,'Carteira *').props.value,'109');assert.equal(writes(service).length,0);
  await view.submit();await view.click('Salvar perfil');assert.equal(writes(service).length,1);assert.equal(writes(service)[0].body.data.bank,'341');assert.equal(writes(service)[0].body.data.wallet,'109');
 }finally{view.unmount();}
});

test('existing Inter110 profile remains readable and its approval recovery preserves the same command',async()=>{
 const service=server({after(call,{counts}){if(call.op==='approval'&&counts.approval===1)throw new AccessError(503);}}),{view,saved}=await mount('Approval',service);
 try{
  const existing={...clone(profile),bank:'077',wallet:'110'};service.state.profiles=[clone(existing)];await view.updateProps({profile:existing});
  assert.match(view.text(),/Inter/);assert.match(view.text(),/carteira 110/);assert.match(view.text(),/Faixa reservada original reconferida/);
  await prepareApproval(view);await view.click('Confirmar');assert.equal(view.guard().busy,true);await view.click('Repetir a mesma confirmação');
  const calls=writes(service);assert.equal(calls.length,2);assert.ok(calls.every(call=>call.op==='approval'));assert.deepEqual(calls[0].body,calls[1].body);assert.equal(calls[0].body.data.range_verified,false);assert.equal(service.commands.size,1);assert.equal(saved.length,1);assert.equal(service.state.profiles[0].bank,'077');
 }finally{view.unmount();}
});

test('new profile: accepted POST with lost reply freezes fields and repeats one identical command',async()=>{
 const service=server({after(call,{counts}){if(call.op==='profile'&&counts.profile===1)throw new AccessError(503);}}),{view,saved}=await mount('ProfileEditor',service);
 try{
  await prepareProfile(view);const oldBank=inputFor(view,'Banco *').props.onChange,oldWallet=inputFor(view,'Carteira *').props.onChange;await view.click('Salvar perfil');oldBank({target:{value:'077'}});oldWallet({target:{value:'110'}});await view.flush();assert.equal(inputFor(view,'Banco *').props.value,'341');assert.equal(inputFor(view,'Carteira *').props.value,'109');
  assert.equal(inputFor(view,'Nome no arquivo · maiúsculas sem acento *').disabled,true);assert.equal(view.button('Conferir perfil').disabled,true);assert.equal(view.button('Voltar').disabled,true);assert.equal(view.guard().busy,true);assert.equal(saved.length,0);
  await assert.rejects(change(view,'Nome no arquivo · maiúsculas sem acento *','OUTRO NOME'),/Disabled input/);
  await view.submit();assert.equal(service.counts.profile,1);
  await view.click('Repetir a mesma confirmação');
  assert.equal(service.commands.size,1);assert.equal(service.counts.profile,2);assert.deepEqual(writes(service)[0].body,writes(service)[1].body);assert.equal(service.counts.profiles,1);assert.deepEqual(saved,[profile.id]);assert.equal(view.guard().busy,false);
 }finally{view.unmount();}
});

test('approval: confirmed replay followed by failed current GET retries GET only and accepts newer profile version',async()=>{
 const service=server({after(call,{counts}){if(call.op==='approval'&&counts.approval===1)throw new AccessError(503);},before(call,{counts}){if(call.op==='profiles'&&counts.profiles===1)throw new AccessError(503);}}),{view,saved}=await mount('Approval',service);
 try{
  await prepareApproval(view);await view.click('Confirmar');await view.click('Repetir a mesma confirmação');
  assert.equal(service.counts.approval,2);assert.equal(service.counts.profiles,1);assert.equal(view.guard().busy,true);assert.equal(saved.length,0);assert.equal(inputFor(view,'Referência da conferência *').disabled,true);
  // Replay carries version2, but another administrator may already have saved version3.
  service.state.profiles[0].version=3;service.state.profiles[0].contract_verified=false;
  await view.click('Consultar resultado registrado');assert.equal(service.counts.approval,2);assert.equal(service.counts.profiles,2);assert.equal(service.commands.size,1);assert.deepEqual(saved,[profile.id]);assert.deepEqual(writes(service)[0].body,writes(service)[1].body);assert.equal(view.guard().busy,false);
 }finally{view.unmount();}
});

test('approval: stale readback cannot close the editor or reuse the replay as current state',async()=>{
 const service=server({after(call,{state}){if(call.op==='approval')state.profiles[0].version=1;}}),{view,saved}=await mount('Approval',service);
 try{
  await prepareApproval(view);await view.click('Confirmar');assert.equal(view.guard().busy,true);assert.equal(saved.length,0);
  await view.click('Consultar resultado registrado');assert.equal(service.counts.approval,1);assert.equal(service.counts.profiles,2);assert.equal(saved.length,0);
  service.state.profiles[0].version=2;await view.click('Consultar resultado registrado');assert.equal(service.counts.approval,1);assert.deepEqual(saved,[profile.id]);
 }finally{view.unmount();}
});

test('remittance: a possible reservation followed by409 retains the exact command, numbers and locked selection',async()=>{
 const service=server({after(call,{state,counts}){if(call.op==='remittance'&&counts.remittance===1){state.files[0].state='reserved';throw new AccessError(409);}if(call.op==='remittance')state.files[0].state='ready';}}),{view,saved}=await mount('RemittanceEditor',service);
 try{
  await prepareRemittance(view);await view.click('Reservar e gerar arquivo');
  assert.equal(view.guard().busy,true);assert.equal(inputFor(view,'Perfil de cobrança *').disabled,true);assert.equal(inputFor(view,'Documento · TITULO FICTICIO *').disabled,true);assert.equal(view.button('Conferir antes de reservar').disabled,true);assert.equal(service.state.files[0].state,'reserved');assert.equal(saved.length,0);
  await view.submit();assert.equal(service.counts.preview,1);assert.equal(service.counts.remittance,1);
  await view.click('Repetir a mesma confirmação');assert.equal(service.counts.remittance,2);assert.equal(service.commands.size,1);assert.equal(service.state.files.length,1);assert.equal(service.state.files[0].sequence,'1');assert.deepEqual(writes(service)[0].body,writes(service)[1].body);assert.equal(saved.length,1);assert.equal(service.counts.files,1);
  const current=new URL(service.calls.find(call=>call.op==='files').path,'https://synthetic.invalid');assert.equal(current.searchParams.get('after'),'30000000-0000-4000-8000-000000000000');assert.equal(current.searchParams.get('limit'),'1');
 }finally{view.unmount();}
});

test('return: lost reply preserves exact file bytes and identity, then a failed GET retries without another upload',async()=>{
 const service=server({after(call,{counts}){if(call.op==='return'&&counts.return===1)throw new AccessError(503);},before(call,{counts}){if(call.op==='files'&&counts.files===1)throw new AccessError(503);}}),{view,saved}=await mount('ReturnEditor',service);
 try{
  await prepareReturn(view);await view.click('Importar para revisão');assert.equal(inputFor(view,'Arquivo CNAB 400 *').disabled,true);assert.equal(inputFor(view,'Século das datas de dois dígitos *').disabled,true);assert.equal(view.guard().busy,true);
  await view.click('Repetir a mesma confirmação');assert.equal(service.counts.return,2);assert.equal(saved.length,0);assert.equal(view.guard().busy,true);
  await view.click('Consultar resultado registrado');assert.equal(service.counts.return,2);assert.equal(service.counts.files,2);assert.deepEqual(writes(service)[0].body,writes(service)[1].body);assert.equal(Buffer.from(writes(service)[0].body.file_base64,'base64').toString(),await fixtureFile.text());assert.equal(service.commands.size,1);assert.equal(service.state.files.length,1);assert.equal(saved.length,1);assert.equal(view.guard().busy,false);
 }finally{view.unmount();}
});

test('a known rejected initial profile confirmation remains editable without a false commit',async()=>{
 const service=server({before(call){if(call.op==='approval')throw new AccessError(409);}}),{view,saved}=await mount('Approval',service);
 try{await prepareApproval(view);await view.click('Confirmar');assert.equal(view.guard().busy,false);assert.equal(inputFor(view,'Referência da conferência *').disabled,false);assert.equal(service.commands.size,0);assert.equal(saved.length,0);assert.equal(service.counts.profiles,0);}
 finally{view.unmount();}
});

for(const status of[403,409])test(`a ${status} retry cannot erase an earlier uncertain profile command`,async()=>{
 const service=server({after(call,{counts}){if(call.op==='approval'&&counts.approval===1)throw new AccessError(503);},before(call,{counts}){if(call.op==='approval'&&counts.approval===2)throw new AccessError(status);}}),{view,saved}=await mount('Approval',service);
 try{
  await prepareApproval(view);await view.click('Confirmar');await view.click('Repetir a mesma confirmação');
  assert.equal(view.guard().busy,true);assert.equal(inputFor(view,'Referência da conferência *').disabled,true);assert.equal(saved.length,0);
  await view.click('Repetir a mesma confirmação');assert.equal(service.counts.approval,3);const calls=writes(service);assert.deepEqual(calls[0].body,calls[1].body);assert.deepEqual(calls[0].body,calls[2].body);assert.equal(service.commands.size,1);assert.deepEqual(saved,[profile.id]);
 }finally{view.unmount();}
});

test('unmount aborts a pending CNAB confirmation and ignores its late response',async()=>{
 let release,signal;const service=server({before(call){if(call.op==='approval'){signal=call.signal;return new Promise(resolve=>{release=resolve;});}}}),{view,saved}=await mount('Approval',service);
 await prepareApproval(view);await view.click('Confirmar');assert.equal(view.guard().busy,true);view.unmount();assert.equal(signal.aborted,true);release();await new Promise(resolve=>setTimeout(resolve,10));assert.equal(service.counts.profiles,0);assert.equal(saved.length,0);
});

test('resuming an existing reservation keeps its UUID through lost POST reply and readback failure',async()=>{
 const service=server({after(call,{counts}){if(call.op==='resume'&&counts.resume===1)throw new AccessError(503);},before(call,{counts}){if(call.op==='files'&&counts.files===1)throw new AccessError(503);}});service.state.files.push(clone(reservedFile));
 const{view,saved,closed}=await mount('ResumeConfirmation',service);
 try{
  await view.click('Retomar mesma reserva');assert.equal(view.guard().busy,true);assert.equal(saved.length,0);assert.equal(closed.length,0);assert.equal(service.state.files[0].state,'ready');
  await view.click('Repetir a mesma confirmação');assert.equal(view.guard().busy,true);assert.equal(service.counts.resume,2);assert.equal(saved.length,0);
  await view.click('Consultar resultado registrado');assert.equal(service.counts.resume,2);assert.equal(service.counts.files,2);assert.equal(service.state.files.length,1);assert.equal(service.state.files[0].sequence,'7');assert.equal(view.guard().busy,false);assert.equal(saved.length,1);
  const calls=writes(service);assert.equal(calls[0].path,`/v1/cnab/remittances/${reservedFile.id}/resume`);assert.equal(calls[0].path,calls[1].path);assert.deepEqual(calls[0].body,{});assert.deepEqual(calls[0].body,calls[1].body);assert.equal(service.commands.size,0);
 }finally{view.unmount();}
});

test('resume conflict remains guarded because the existing reservation may still be finalizing',async()=>{
 const service=server({before(call,{counts}){if(call.op==='resume'&&counts.resume===1)throw new AccessError(409);}});service.state.files.push(clone(reservedFile));
 const{view,saved}=await mount('ResumeConfirmation',service);
 try{
  await view.click('Retomar mesma reserva');assert.equal(view.guard().busy,true);assert.equal(service.state.files[0].state,'reserved');assert.equal(saved.length,0);
  await view.click('Repetir a mesma confirmação');assert.equal(service.state.files.length,1);assert.equal(service.state.files[0].sequence,'7');assert.equal(service.counts.resume,2);assert.equal(saved.length,1);assert.equal(view.guard().busy,false);
 }finally{view.unmount();}
});

test('pending resume sets the navigation guard and aborts on leaving without later readback',async()=>{
 let release,signal;const service=server({before(call){if(call.op==='resume'){signal=call.signal;return new Promise(resolve=>{release=resolve;});}}});service.state.files.push(clone(reservedFile));
 const{view,saved}=await mount('ResumeConfirmation',service);
 await view.click('Retomar mesma reserva');assert.equal(view.guard().busy,true);assert.equal(view.button('Voltar e conferir').disabled,true);view.unmount();assert.equal(signal.aborted,true);release();await new Promise(resolve=>setTimeout(resolve,10));assert.equal(service.counts.files,0);assert.equal(saved.length,0);
});
