import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {PROFILES,title} from '../../../packages/cnab-core/test/fixtures.mjs';
import {operationalEncodingTerms,validateOperationalRemittanceV2} from '../../../packages/cnab-core/src/index.mjs';
import {parseCnabOperationalV2Route as parse,executeCnabOperationalV2Route as execute,cnabOperationalV2Methods as methods,
 cnabOperationalV2Route as matches,CNAB_OPERATIONAL_V2_PREFIX as PREFIX,CNAB_OPERATIONAL_V2_BODY_BYTES} from '../src/cnab-operational-v2.mjs';

const ID=n=>`${n.toString(16).padStart(8,'0')}-1111-4111-a111-111111111111`;
const actor=ID(1),profileId=ID(2),accountId=ID(3),commandId=ID(4),remittanceId=ID(5),titleId=ID(6),contactId=ID(7),billingId=ID(8);
const LEGACY='itau109-no-charges-v1',OBSERVED='itau109-origin-observed-v1',H='a'.repeat(64),POLICY='b'.repeat(64),DAY='2026-10-16';
const FLAGS={purpose:'operational',productionReady:false,bankTransmissionPerformed:false,financialMutationPerformed:false,originAuthenticated:false,contract:'itau109-operational-v2'};
const clone=v=>structuredClone(v),code=v=>e=>e.code===v;
function request(path,value,init={}){return new Request('https://erp.example'+PREFIX+path,{...(value===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)}),...init});}
const input=(encoding=OBSERVED,amount='12345')=>({command_id:commandId,profile_id:profileId,expected_version:1,expected_approval_version:1,generated_on:DAY,
 titles:[{title_id:titleId,expected_version:1,document_number:'TESTE0001'}],confirm_operational:true,encoding_profile:encoding,confirm_encoding_profile:true,zero_daily_title_ids:[],preview_hash:H});
function previewInput(value=input()){const{preview_hash,...b}=value;return{...b,confirm_operational:false,confirm_encoding_profile:false};}
function fixture({encoding=OBSERVED,amount='12345',zero=false}={}){
 const calls=[],objects=new Map(),commands=new Map();let state='reserved',fileHash=null,fileSize=null,path=null,approvalVersion=1;
 const snap={profile:clone(PROFILES.itau),titles:[title({id:billingId,control:'SYNTHETIC0001',amountCents:amount})],generatedOn:DAY,remittanceSequence:'1',purpose:'operational',
  operational_authorization:{approval_version:1,profile_config_hash:'c'.repeat(64),identity_version:1},preview_hash:H,encoding_profile:encoding,
  encoding_authorization:{approval_version:1,policy_hash:POLICY,reference:'SYNTHETIC ONLY',confirmed_on:DAY,compatibility_confirmed:encoding===OBSERVED,permanent_instructions_acknowledged:encoding===OBSERVED}};
 if(encoding===OBSERVED)snap.titles[0].encodingTerms=operationalEncodingTerms({amountCents:amount,dueOn:snap.titles[0].dueOn,zeroDailyInterestConfirmed:zero});
 const approval={profile_id:profileId,approval_version:1,enabled:true,effective_enabled:true,profile_version:1,identity_version:1,reference:'SYNTHETIC ONLY',confirmed_on:DAY,reviewed_at:DAY+'T12:00:00+00:00',issues:[],allowed_encoding_profiles:[encoding],encoding_policy:{policy_hash:POLICY,compatibility_confirmed:encoding===OBSERVED,permanent_instructions_acknowledged:encoding===OBSERVED}};
 const profile={id:profileId,account_id:accountId,account_name:'SYNTHETIC BANK',bank:'341',wallet:'109',account_mask:'***345',company_name:'SYNTHETIC COMPANY',version:1,contract_verified:true,policy_verified:true,next_sequence:'1'};
 const ack=(ready=false)=>({...FLAGS,replayed:false,id:remittanceId,profile_id:profileId,sequence:'1',state:ready?'ready':'reserved',encoding_profile:encoding,approval_version:approvalVersion,...(ready?{file_hash:fileHash,byte_size:fileSize}:{})});
 const current=()=>({id:remittanceId,profile_id:profileId,state,sequence:'1',encoding_profile:encoding,file_hash:fileHash,byte_size:fileSize,created_at:DAY+'T12:00:00+00:00',finalized_at:state==='ready'?DAY+'T12:00:01+00:00':null});
 const sqlPreview=()=>{const{id,control,...t}=snap.titles[0],validation=validateOperationalRemittanceV2(snap,{allowPending:true});return{...FLAGS,snapshot:snap,profile_id:profileId,profile_version:1,preview:true,preview_hash:H,
  preview_items:[{finance_title_id:titleId,finance_title_version:1,contact_version:1,contact_id:contactId,title:t}],encoding_profile:encoding,can_reserve:validation.canReserve,pending:validation.pending.map(p=>({...p,title_id:titleId}))};};
 const rpc=async(name,args,options)=>{
  calls.push({name,args:clone(args),options});assert.equal(args.p_user_id,actor);assert.ok(options.signal instanceof AbortSignal);assert.ok(Number.isFinite(options.deadline));
  switch(name){
   case 'erp_cnab_operational_profiles_v2':return{...FLAGS,items:[{profile,approval}]};
   case 'erp_cnab_operational_approve_v2':return{...FLAGS,profile_id:profileId,replayed:false,approval};
   case 'erp_cnab_operational_reserve_v2':if(args.p_preview)return sqlPreview();{const old=commands.get(args.p_command_id);if(old){if(JSON.stringify(old.args)!==JSON.stringify(args))throw{code:'40001'};return{...old.receipt,replayed:true};}const receipt=ack();commands.set(args.p_command_id,{args:clone(args),receipt});return receipt;}
   case 'erp_cnab_operational_reservation_v2':return{...FLAGS,id:remittanceId,profile_id:profileId,state,snapshot:snap,file_hash:fileHash,object_path:path,byte_size:fileSize,approval_version:approvalVersion,encoding_profile:encoding};
   case 'erp_cnab_operational_finalize_v2':state='ready';fileHash=args.p_hash;fileSize=args.p_size;path=args.p_path;{const old=commands.get(args.p_command_id),receipt=ack(true);if(!old)commands.set(args.p_command_id,{args:clone(args),receipt});return{...receipt,replayed:!!old};}
   case 'erp_cnab_operational_command_v2':{const c=commands.get(args.p_command_id);if(!c)throw{code:'P0002',message:'PRIVATE SQL'};return{...FLAGS,read_only:true,command_id:args.p_command_id,kind:'remittance',receipt:c.receipt,current:current()};}
   case 'erp_cnab_operational_file_v2':return{...FLAGS,id:remittanceId,profile_id:profileId,hash:fileHash,size:fileSize,path,filename:'ITAU_COBRANCA_0000001.REM',approval_version:approvalVersion,encoding_profile:encoding};
   case 'erp_cnab_operational_files_v2':return{...FLAGS,items:[],limit:args.p_limit,has_more:false,next_cursor:null};
   default:throw new Error('UNEXPECTED RPC');
  }
 };
 const storeFile=async v=>{assert.equal(v.upsert,false);assert.equal(v.bucket,'brufap-cnab');objects.set(v.path,new Uint8Array(v.bytes));};
 const getFile=async v=>new Uint8Array(objects.get(v.path));
 const ports={userId:actor,rpc,storeFile,getFile};
 return{snap,profile,approval,calls,objects,commands,sqlPreview,ports,current,ack,setApproval:n=>{approvalVersion=n;},
  api:async(path,b,patch={})=>execute(await parse(request(path,b)),{...ports,...patch})};
}

test('v2 route families are closed, branded, with explicit methods and mandatory discriminator',async()=>{
 assert.equal(await parse(new Request('https://erp.example/v1/cobranca-operacional/profiles')),null);
 assert.equal(matches(PREFIX+'/commands/'+commandId),true);assert.deepEqual(methods(PREFIX+'/remittances'),['GET','POST']);assert.equal(methods(PREFIX+'/returns'),null);
 await assert.rejects(()=>execute({kind:'profiles'},{userId:actor,rpc:()=>{assert.fail();}}),code('ERP_NOT_FOUND'));
 for(const req of[request('/profiles',{}),request('/commands/'+commandId,{}),request('/unknown'),request('/remittances?limit=31'),request('/profiles?foo=1'),request('/remittances?limit=1&limit=1')])await assert.rejects(()=>parse(req));
 for(const patch of[{encoding_profile:undefined},{encoding_profile:'inter112'},{confirm_encoding_profile:false},{zero_daily_title_ids:[titleId,titleId]},{zero_daily_title_ids:[ID(99)]},{titles:[{...input().titles[0],payment_limit_days:1}]},{generated_on:'2026-02-30'},{p_user_id:actor}])await assert.rejects(()=>parse(request('/remittances',{...input(),...patch})));
 await assert.rejects(()=>parse(request('/remittances/preview',{...previewInput(),confirm_operational:true})));
 await assert.rejects(()=>parse(request('/remittances/preview',{...previewInput(),preview_hash:null})));
 const r=await parse(request('/remittances',input()));assert.ok(Object.isFrozen(r.body.titles[0]));
});
test('bounded JSON refuses compression, invalid UTF8, mismatched lengths and cancels aborted body',async()=>{
 for(const req of[request('/remittances',input(),{headers:{'content-type':'text/plain'}}),request('/remittances',input(),{headers:{'content-type':'application/json','content-encoding':'gzip'}}),request('/remittances',input(),{headers:{'content-type':'application/json','content-length':'2'}}),request('/remittances',input(),{headers:{'content-type':'application/json','content-length':String(CNAB_OPERATIONAL_V2_BODY_BYTES+1)}}),request('/remittances',undefined,{method:'POST',headers:{'content-type':'application/json'},body:new Uint8Array([255])})])await assert.rejects(()=>parse(req));
 let cancelled=false;const ac=new AbortController();const r=request('/remittances',undefined,{method:'POST',headers:{'content-type':'application/json'},body:new ReadableStream({cancel(){cancelled=true;}}),duplex:'half',signal:ac.signal});
 const pending=parse(r);ac.abort();await assert.rejects(()=>pending,code('ERP_REQUEST_ABORTED'));assert.equal(cancelled,true);
});
test('profiles expose minimal Itaú data and preserve legacy financial account whitespace',async()=>{
 const f=fixture();f.profile.account_name='A\tB\rC'+'A'.repeat(190);const result=(await f.api('/profiles')).body;
 assert.equal(result.items[0].profile.account_name,f.profile.account_name);assert.doesNotMatch(JSON.stringify(result),/"cnpj"|"agency"|"accountDigit"|"snapshot"|"path"/);
 f.profile.wallet='112';await assert.rejects(()=>f.api('/profiles'),code('ERP_CNAB_OPERATIONAL_V2_INVALID_RESPONSE'));
});
test('approval captures exact confirmations and checks historical ACK against input',async()=>{
 const f=fixture(),b={command_id:commandId,expected_approval_version:0,expected_profile_version:1,expected_identity_version:1,enabled:true,confirmed_on:DAY,reference:'SYNTHETIC ONLY',allowed_encoding_profiles:[OBSERVED],compatibility_confirmed:true,permanent_instructions_acknowledged:true};
 const result=(await f.api(`/profiles/${profileId}/approval`,b)).body;assert.equal(result.approval.approval_version,1);assert.equal(f.calls[0].args.p_compatibility_confirmed,true);
 await assert.rejects(()=>f.api(`/profiles/${profileId}/approval`,{...b,permanent_instructions_acknowledged:false}));
 await assert.rejects(()=>f.api(`/profiles/${profileId}/approval`,b,{rpc:async(n,a,o)=>({...await f.ports.rpc(n,a,o),approval:{...f.approval,reference:'DIFFERENT'}})}),code('ERP_RESULT_UNCONFIRMED'));
});
test('preview validates proof/snapshot exact terms, returns masked payer and zero pending without file IO',async()=>{
 const f=fixture({amount:'1'}),result=(await f.api('/remittances/preview',previewInput())).body;
 assert.equal(result.can_reserve,false);assert.equal(result.persisted,false);assert.deepEqual(result.pending,[{code:'ZERO_DAILY_FIELD_UNCONFIRMED',title_id:titleId}]);assert.equal(result.items[0].encoding_terms.dailyInterestCents,'0');assert.equal(result.total_cents,'1');
 assert.equal(result.items[0].payer.document_mask,'*******8909');assert.equal(f.objects.size,0);assert.equal(f.commands.size,0);
 assert.doesNotMatch(JSON.stringify(result),/12345678909|"control"|"ourNumber"|"snapshot"|"account"|"contact_id"/);
 for(const tweak of[v=>{v.preview_items[0].title.payer.name='OTHER';},v=>{v.can_reserve=true;},v=>{v.pending=[];},v=>{v.snapshot.encoding_authorization.policy_hash='bad';}]){
  await assert.rejects(()=>f.api('/remittances/preview',previewInput(),{rpc:async()=>{const v=clone(f.sqlPreview());v.preview_items=clone(v.preview_items);tweak(v);return v;}}),code('ERP_CNAB_OPERATIONAL_V2_INVALID_RESPONSE'));
 }
});
test('both encodings generate immutable bytes with readback and command receipt/current separation',async()=>{
 for(const encoding of[LEGACY,OBSERVED]){
  const f=fixture({encoding}),b=input(encoding),ack=(await f.api('/remittances',b)).body;
  assert.equal(ack.state,'ready');assert.equal(ack.command_id,commandId);assert.equal(ack.byte_size,encoding===LEGACY?1206:1608);assert.equal(ack.encoding_profile,encoding);
  const final=f.calls.find(x=>x.name==='erp_cnab_operational_finalize_v2');assert.equal(Object.hasOwn(final.args.p_manifest[0],'encodingTerms'),encoding===OBSERVED);
  const bytes=[...f.objects.values()][0];assert.equal(createHash('sha256').update(bytes).digest('hex'),ack.file_hash);
  const result=(await f.api('/commands/'+commandId)).body;assert.equal(result.receipt.state,'reserved');assert.equal(result.current.state,'ready');assert.equal(result.receipt.replayed,false);
  const download=await f.api('/files/remittance/'+remittanceId);assert.deepEqual(download.bytes,bytes);assert.equal(download.contentType,'application/octet-stream');
  assert.equal(f.calls.filter(x=>x.name==='erp_cnab_operational_file_v2').length,2);
 }
});
test('zero daily interest needs title-specific confirmation; no silent substitution',async()=>{
 const f=fixture({amount:'1'});await assert.rejects(()=>f.api('/remittances',input()),code('ERP_RESULT_UNCONFIRMED'));assert.equal(f.objects.size,0);
 const confirmed=fixture({amount:'1',zero:true}),b={...input(),zero_daily_title_ids:[titleId]};assert.equal((await confirmed.api('/remittances',b)).body.state,'ready');
});
test('reservation ACK loss triggers no upload/retry; recovery GET uses the same original command',async()=>{
 const f=fixture();let once=true;
 await assert.rejects(()=>f.api('/remittances',input(),{rpc:async(n,a,o)=>{const v=await f.ports.rpc(n,a,o);if(n==='erp_cnab_operational_reserve_v2'&&once){once=false;throw new Error('PRIVATE PROVIDER BODY');}return v;}}),code('ERP_RESULT_UNCONFIRMED'));
 assert.equal(f.objects.size,0);assert.equal(f.calls.filter(x=>x.name.includes('reserve_v2')).length,1);
 const read=(await f.api('/commands/'+commandId)).body;assert.equal(read.current.state,'reserved');assert.equal(f.commands.size,1);
});
test('finish ACK loss recovers only via GET; original receipt never rebased by current approval',async()=>{
 const f=fixture();await assert.rejects(()=>f.api('/remittances',input(),{rpc:async(n,a,o)=>{const v=await f.ports.rpc(n,a,o);if(n.endsWith('finalize_v2'))throw new Error('LOST ACK');return v;}}),code('ERP_RESULT_UNCONFIRMED'));
 const writes=f.calls.filter(x=>/reserve_v2|finalize_v2/.test(x.name)).length;f.setApproval(9);
 const read=(await f.api('/commands/'+commandId)).body;assert.equal(read.receipt.approval_version,1);assert.equal(read.current.state,'ready');assert.equal(f.calls.filter(x=>/reserve_v2|finalize_v2/.test(x.name)).length,writes);
});
test('explicit resume uses its own captured command and current approval with historical terms',async()=>{
 const f=fixture();await assert.rejects(()=>f.api('/remittances',input(),{storeFile:async()=>{throw new Error('lost upload');}}),code('ERP_RESULT_UNCONFIRMED'));
 f.setApproval(3);const resumeId=ID(20),b={command_id:resumeId,expected_approval_version:3,encoding_profile:OBSERVED};
 const result=(await f.api(`/remittances/${remittanceId}/resume`,b)).body;assert.equal(result.approval_version,3);assert.equal(result.command_id,resumeId);
 assert.equal(f.calls.findLast(x=>x.name==='erp_cnab_operational_finalize_v2').args.p_command_id,resumeId);
 assert.equal((await f.api('/commands/'+resumeId)).body.receipt.state,'ready');
});
test('storage corruption and revoked authority cannot return a successful download or finalize',async()=>{
 const f=fixture();await assert.rejects(()=>f.api('/remittances',input(),{getFile:async()=>new Uint8Array(1608)}),code('ERP_RESULT_UNCONFIRMED'));assert.equal(f.calls.some(x=>x.name.endsWith('finalize_v2')),false);
 const good=fixture();await good.api('/remittances',input());let reads=0;
 await assert.rejects(()=>good.api('/files/remittance/'+remittanceId,undefined,{rpc:async(n,a,o)=>{if(n.endsWith('file_v2')&&++reads===2)throw{code:'42501',message:'PRIVATE'};return good.ports.rpc(n,a,o);}}),code('ERP_FORBIDDEN'));
 await assert.rejects(()=>good.api('/files/remittance/'+remittanceId,undefined,{getFile:async()=>new Response('wrong',{status:302,headers:{location:'https://evil.invalid'}})}),code('ERP_CNAB_OPERATIONAL_V2_INVALID_RESPONSE'));
});
test('snapshot is captured before encoder awaits and ports never receive mutable caller input',async()=>{
 const f=fixture();let graph;
 const result=await f.api('/remittances',input(),{rpc:async(n,a,o)=>{const v=await f.ports.rpc(n,a,o);if(n.endsWith('reservation_v2'))graph=v;return v;},storeFile:async v=>{graph.snapshot.titles[0].amountCents='99999';graph.snapshot.profile.account='99999';await f.ports.storeFile(v);}});
 assert.equal(result.body.state,'ready');assert.equal(f.calls.find(x=>x.name.endsWith('finalize_v2')).args.p_manifest[0].amountCents,'12345');
 const r=await parse(request('/profiles'));let touched=0;const options={userId:actor,get rpc(){touched++;return f.ports.rpc;}};
 await assert.rejects(()=>execute(r,options),code('ERP_CNAB_OPERATIONAL_V2_INVALID_RESPONSE'));assert.equal(touched,0);
 await assert.rejects(()=>f.api('/profiles',undefined,{rpc:async()=>{const x={...FLAGS,items:[]};Object.defineProperty(x,'private',{get(){touched++;return'PRIVATE';},enumerable:true});return x;}}),code('ERP_CNAB_OPERATIONAL_V2_INVALID_RESPONSE'));assert.equal(touched,0);
});
test('abort before dispatch has zero effects; abort after reservation is uncertain and closes ports',async()=>{
 const f=fixture(),ac=new AbortController();ac.abort();await assert.rejects(()=>f.api('/remittances',input(),{signal:ac.signal}),code('ERP_REQUEST_ABORTED'));assert.equal(f.calls.length,0);
 const active=new AbortController();await assert.rejects(()=>f.api('/remittances',input(),{signal:active.signal,storeFile:async()=>{active.abort();await new Promise(()=>{});}}),code('ERP_RESULT_UNCONFIRMED'));
 assert.equal(f.calls.some(x=>x.name.endsWith('finalize_v2')),false);assert.ok(f.calls.every(x=>x.options.signal.aborted));
});
test('total deadline bounds slow body/readback and prevents later finalize',async()=>{
 const f=fixture();let cancelled=false;
 await assert.rejects(()=>f.api('/remittances',input(),{timeoutMs:25,getFile:async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}))}),code('ERP_RESULT_UNCONFIRMED'));
 assert.equal(cancelled,true);assert.equal(f.calls.some(x=>x.name.endsWith('finalize_v2')),false);
});
test('closed SQL errors sanitize messages and unknown codes; no mutation retry after unconfirmed',async()=>{
 const f=fixture();for(const[c,status]of[['42501',403],['40001',409],['22023',400],['P0002',404]])await assert.rejects(()=>f.api('/profiles',undefined,{rpc:async()=>{throw{code:c,message:'PRIVATE SECRET'};}}),e=>e.status===status&&!e.message.includes('PRIVATE'));
 for(const c of['UNKNOWN','toString'])await assert.rejects(()=>f.api('/profiles',undefined,{rpc:async()=>{throw{code:c,message:'PRIVATE'};}}),code('ERP_UPSTREAM_UNAVAILABLE'));
 await assert.rejects(()=>f.api('/remittances',input(),{rpc:async()=>{throw new Error('PRIVATE');}}),code('ERP_RESULT_UNCONFIRMED'));
});
test('list discriminates v1 null from v2 without promoting history or accepting duplicate cursor',async()=>{
 const f=fixture();const row={id:remittanceId,profile_id:profileId,kind:'remittance',state:'reserved',sequence:'1',generated_on:DAY,created_at:DAY+'T12:00:00Z',file_hash:null,byte_size:null,titles:1,filename:'ITAU_COBRANCA_0000001.REM',encoding_profile:null};
 const raw={...FLAGS,items:[row],limit:1,has_more:true,next_cursor:remittanceId};const result=(await f.api('/remittances?limit=1',undefined,{rpc:async()=>raw})).body;assert.equal(result.items[0].encoding_profile,null);
 await assert.rejects(()=>f.api('/remittances?limit=1&after='+remittanceId,undefined,{rpc:async()=>raw}),code('ERP_CNAB_OPERATIONAL_V2_INVALID_RESPONSE'));
});

test('every public nested shape is closed and unsafe accessors cannot run through error mapping',async()=>{
 const f=fixture();for(const mutate of[v=>{v.extra='PRIVATE';},v=>{v.items[0].approval.extra='PRIVATE';},v=>{v.items[0].profile.account='PRIVATE';}]){
  await assert.rejects(()=>f.api('/profiles',undefined,{rpc:async(n,a,o)=>{const v=clone(await f.ports.rpc(n,a,o));mutate(v);return v;}}),code('ERP_CNAB_OPERATIONAL_V2_INVALID_RESPONSE'));
 }
 let touches=0;await assert.rejects(()=>f.api('/profiles',undefined,{rpc:async()=>{throw Object.defineProperty(new Error('PRIVATE'),'code',{get(){touches++;return'42501';}});}}),code('ERP_UPSTREAM_UNAVAILABLE'));assert.equal(touches,0);
 await assert.rejects(()=>f.api('/profiles',undefined,{rpc:async()=>({ ...FLAGS,items:Array(101).fill({profile:f.profile,approval:f.approval})})}),code('ERP_CNAB_OPERATIONAL_V2_INVALID_RESPONSE'));
});
test('late Storage completion after timeout never reaches finalize and receives the captured aborted signal',async()=>{
 const f=fixture();let release,entered;const ready=new Promise(r=>{entered=r;});let activeSignal,storedCopy;
 const result=f.api('/remittances',input(),{timeoutMs:25,storeFile:async v=>{activeSignal=v.signal;storedCopy=v.bytes;entered();await new Promise(r=>{release=r;});}});
 await ready;await assert.rejects(()=>result,code('ERP_RESULT_UNCONFIRMED'));assert.equal(activeSignal.aborted,true);
 // A port still unwinding has its own immutable byte copy until that operation settles.
 assert.ok(storedCopy.some(x=>x!==0));release();await new Promise(r=>setImmediate(r));assert.ok(storedCopy.every(x=>x===0));
 assert.equal(f.calls.some(x=>x.name.endsWith('finalize_v2')),false);
});
test('file bytes are copied before the asynchronous digest and rejected if the backing memory is shared',async()=>{
 const f=fixture();await f.api('/remittances',input());const bytes=[...f.objects.values()][0],portCopy=new Uint8Array(bytes);
 const pending=f.api('/files/remittance/'+remittanceId,undefined,{getFile:async()=>portCopy});
 const download=await pending;portCopy.fill(0);assert.deepEqual(download.bytes,bytes);
 await assert.rejects(()=>f.api('/files/remittance/'+remittanceId,undefined,{getFile:async()=>new Uint8Array(new SharedArrayBuffer(bytes.length))}),code('ERP_CNAB_OPERATIONAL_V2_INVALID_RESPONSE'));
});

test('empty body chunks cannot starve the absolute deadline or byte budget',async()=>{
 let pulls=0,cancelled=false;
 const r=request('/remittances',undefined,{method:'POST',headers:{'content-type':'application/json'},duplex:'half',body:new ReadableStream({pull(controller){pulls++;controller.enqueue(new Uint8Array());},cancel(){cancelled=true;}})});
 await assert.rejects(()=>parse(r),code('ERP_CNAB_OPERATIONAL_V2_INVALID_INPUT'));assert.equal(cancelled,true);assert.ok(pulls<=2);
});
