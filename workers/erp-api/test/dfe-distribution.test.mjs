import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildAccessKey} from '../../../packages/fiscal-core/src/identity.mjs';
import {parseDfeDistributionRoute,executeDfeDistributionRoute,dfeDistributionMethods} from '../src/dfe-distribution.mjs';
const user='20000000-0000-4000-8000-000000000001',channelId='30000000-0000-4000-8000-000000000001',id='40000000-0000-4000-8000-000000000001',other='40000000-0000-4000-8000-000000000002',commandId='50000000-0000-4000-8000-000000000001';
const flags={data_mode:'received_dfe',model:'55',transport_enabled:false,can_query:false,can_manifest:false,can_emit:false,origin_authenticated:false,signature_verified:false,xsd_validated:false,sefaz_authorized:false,financial_mutation_performed:false,stock_mutation_performed:false};
const current={id:channelId,environment:'2',identity_version:1,version:1,coordinator:'external',other_consumers_reviewed:false,checkpoint:null,checkpoint_confirmed:false,collection_requested:false,paused:false,active_attempt_id:null,not_before:null,updated_at:'2026-10-16T12:00:00.123456+00:00',company_changed:false};
const body={command_id:commandId,environment:'2',expected_version:0,expected_identity_version:1,coordinator:'external',checkpoint:null,checkpoint_confirmed:false,other_consumers_reviewed:false,collection_requested:false,reason:'Coordenação externa ainda pendente'};
const key=buildAccessKey({cUF:'35',cnpj:'12345678000195',model:'55',environment:'2',series:'1',number:'1',issuedAt:'2026-10-16T10:00:00-03:00',cNF:'12345678',tpEmis:'1'});
const bytes=new TextEncoder().encode('<resNFe>FIXTURE FICTICIA</resNFe>'),sha=createHash('sha256').update(bytes).digest('hex');
const row={id,channel_id:channelId,nsu:'000000000000001',kind:'invoice_summary',schema:'resNFe_v1.01.xsd',model:'55',access_key:key,recipient_match:null,quarantined:false,xml_hash:sha,size_bytes:bytes.length,collected_at:'2026-10-16T12:00:00Z',is_complete_invoice:false};
const page=items=>({...flags,channel_id:channelId,items,limit:25,has_more:false,next_cursor:null});
const receipt=(patch={})=>({...flags,command_id:commandId,action:'configure',state:'committed',receipt:current,current,replayed:false,...patch});
const meta={...flags,document:row,bucket:'brufap-received-dfe',object_key:`objects/${sha}.xml`,filename:`RESUMO_NFE_${id}.xml`};
const request=(suffix,options={})=>new Request(`https://synthetic.invalid/v1/notas-recebidas${suffix}`,options);
const parse=(suffix,options)=>parseDfeDistributionRoute(request(suffix,options));
const post=(value=body,options={})=>parse('/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value),...options});
const status=code=>e=>e.status===code;
async function run(route,value,ports={}){return executeDfeDistributionRoute(await route,{userId:user,rpc:async()=>value,...ports});}
const listing=(value,suffix='')=>run(parse(`/documents?channel_id=${channelId}${suffix}`),value);
const response=(content=bytes,options={})=>new Response(content,{...options,headers:{'Content-Type':'application/octet-stream',...options.headers}});
const download=(fetchObject=async()=>response(),get=async()=>meta,extra={})=>run(parse(`/documents/${id}/download`),null,{rpc:get,fetchObject,...extra});

test('exact routes expose only settings/configuration receipts/documents and normalize identifiers',async()=>{
 assert.deepEqual(dfeDistributionMethods('/v1/notas-recebidas/settings'),['GET','POST']);assert.equal(dfeDistributionMethods('/v1/other'),null);
 assert.equal(await parseDfeDistributionRoute(new Request('https://synthetic.invalid/v1/other')),null);
 assert.equal((await parse(`/commands/${commandId.toUpperCase()}`)).commandId,commandId);
 for(const suffix of ['/reserve','/dispatch','/finalize','/renew','/uncertain','/recover','/abandon','/settings/','/documents/bad/download'])await assert.rejects(()=>parse(suffix),status(404));
 for(const suffix of ['/settings','/settings?environment=3','/settings?environment=2&environment=1','/settings?environment=2&cnpj=123','/documents','/documents?channel_id=bad',`/documents?channel_id=${channelId}&limit=51`,`/documents?channel_id=${channelId}&limit=0`,`/documents?channel_id=${channelId}&after=bad`,`/documents?channel_id=${channelId}&kind=xml`,`/documents/${id}/download?path=../x`])await assert.rejects(()=>parse(suffix),status(400));
 for(const method of ['PUT','PATCH','DELETE'])await assert.rejects(()=>parse('/settings?environment=2',{method}),status(405));
 await assert.rejects(()=>parse('/settings?environment=2',{headers:{'Content-Encoding':'gzip'}}),status(400));
 const r=await parse(`/documents?channel_id=${channelId}&limit=50&after=${id}&kind=event`);assert.deepEqual(r.args,{p_channel_id:channelId,p_kind:'event',p_limit:50,p_after:id});assert.ok(Object.isFrozen(r.args));
});

test('settings input has no implicit checkpoint, rejects actor/activation/body ambiguities and preserves command bytes',async()=>{
 const r=await post();assert.equal(r.args.p_checkpoint,null);assert.equal(r.args.p_reason,body.reason);
 for(const patch of [{user_id:user},{checkpoint:0},{checkpoint:'0'},{checkpoint_confirmed:true},{collection_requested:true},{coordinator:'auto'},{expected_version:2147483647},{reason:'\u00a0\u00a0\u00a0'},{reason:'a\nb'},{reason:'x'.repeat(241)},{environment:2}])await assert.rejects(()=>post({...body,...patch}),status(400));
 await assert.rejects(()=>post(body,{headers:{'Content-Type':'application/json','Content-Encoding':'br'}}),status(400));
 await assert.rejects(()=>post(body,{body:'x'.repeat(8193)}),status(413));
 await assert.rejects(()=>post(body,{body:new Uint8Array([0xff])}),status(400));
 await assert.rejects(()=>post(body,{headers:{'Content-Type':'text/plain'}}),status(400));
 const ready={...body,coordinator:'brufap',checkpoint:'000000000000000',checkpoint_confirmed:true,other_consumers_reviewed:true,collection_requested:true};assert.equal((await post(ready)).args.p_checkpoint,ready.checkpoint);
});

test('actor and branded route are checked before any RPC; SQL failures are sanitized',async()=>{
 const r=await parse('/settings?environment=2');let calls=0;
 await assert.rejects(()=>executeDfeDistributionRoute(r,{userId:'bad',rpc:()=>calls++}),status(401));
 await assert.rejects(()=>executeDfeDistributionRoute({...r},{userId:user,rpc:()=>calls++}),status(404));assert.equal(calls,0);
 for(const [code,http]of [['42501',403],['22023',400],['40001',409],['23505',409],['55000',503],['P0002',404],['XX000',502]]){
  await assert.rejects(()=>run(Promise.resolve(r),null,{rpc:async()=>{throw Object.assign(new Error('PRIVATE RAW SECRET'),{code});}}),e=>e.status===http&&!e.message.includes('PRIVATE'));
 }
 await assert.rejects(()=>run(Promise.resolve(r),null,{rpc:async()=>{throw Object.assign(new Error('PRIVATE RAW MESSAGE'),{status:400,code:'ERP_INVALID_QUERY'});}}),e=>e.status===400&&e.code==='ERP_INVALID_QUERY'&&!e.message.includes('PRIVATE'));
 await run(Promise.resolve(r),null,{userId:user.toUpperCase(),rpc:async(name,args)=>{assert.equal(name,'erp_dfe_settings');assert.deepEqual(args,{p_environment:'2',p_user_id:user});return{...flags,current:null};}});
});

test('public current strips runtime identifiers and private extras without asserting activation',async()=>{
 const value=await run(parse('/settings?environment=2'),{...flags,current:{...current,active_attempt_id:id,cnpj:'PRIVATE',lease_id:'PRIVATE',request:{secret:'PRIVATE'}}});
 assert.equal(value.body.current.has_active_attempt,true);assert.equal(value.body.can_query,false);assert.doesNotMatch(JSON.stringify(value),/PRIVATE|active_attempt_id|lease_id|"request"/);
 for(const patch of [{environment:'1'},{checkpoint_confirmed:true},{updated_at:'2026-02-30T12:00:00Z'},{collection_requested:true}])await assert.rejects(()=>run(parse('/settings?environment=2'),{...flags,current:{...current,...patch}}),status(502));
 for(const field of Object.keys(flags).filter(x=>flags[x]===false))await assert.rejects(()=>run(parse('/settings?environment=2'),{...flags,[field]:true,current:null}),status(502));
});

test('configuration receipt is bound to submitted choices; historical/current and runtime commands remain distinct',async()=>{
 const next={...current,version:2,identity_version:2,company_changed:true,active_attempt_id:id};const got=await run(post(),receipt({current:next,replayed:true}));assert.equal(got.body.receipt.version,1);assert.equal(got.body.current.version,2);assert.equal(got.body.current.has_active_attempt,true);
 for(const patch of [{checkpoint:'000000000000001'},{coordinator:'brufap'},{version:2},{identity_version:2},{paused:true}])await assert.rejects(()=>run(post(),receipt({receipt:{...current,...patch}})),status(502));
 await assert.rejects(()=>run(parse(`/commands/${commandId}`),receipt({action:'collect',receipt:{lease_id:'PRIVATE'}})),status(404));
 assert.equal((await run(parse(`/commands/${commandId}`),receipt({current:next,replayed:true}))).body.replayed,true);
 await assert.rejects(()=>run(post(),receipt({command_id:other})),status(502));
});

test('document projection keeps summary, full invoice, event and quarantine meanings separate',async()=>{
 const variants=[row,{...row,id:other,kind:'invoice',schema:'procNFe_v4.00.xsd',recipient_match:true,is_complete_invoice:true},{...row,kind:'event_summary',schema:'resEvento_v1.01.xsd'},{...row,kind:'event',schema:'procEventoNFe_v1.00.xsd'},{...row,kind:'unsupported',schema:'future_v1.00.xsd',model:null,access_key:null,quarantined:true}];
 for(const entry of variants){const got=await listing(page([{...entry,xml:'PRIVATE',object_key:'PRIVATE',cnpj:'PRIVATE'}]));assert.deepEqual(got.body.items,[entry]);assert.doesNotMatch(JSON.stringify(got),/PRIVATE|object_key/);}
 for(const patch of [{is_complete_invoice:true},{kind:'invoice'},{model:'65'},{access_key:key.slice(0,-1)+'x'},{recipient_match:true},{quarantined:true},{size_bytes:8388609},{schema:'../../auth.xsd'},{collected_at:'2026-13-01T00:00:00Z'}])await assert.rejects(()=>listing(page([{...row,...patch}])),status(502));
});

test('pagination binds channel/filter/order/limit/cursor instead of trusting arbitrary RPC pages',async()=>{
 const one={...page([row]),limit:1,has_more:true,next_cursor:id};assert.equal((await listing(one,'&limit=1')).body.next_cursor,id);
 for(const value of [{...one,next_cursor:other},{...one,items:[]},{...page([row]),limit:50},page([row,row]),page([{...row,id:other},row]),{...page([]),next_cursor:id},page([{...row,channel_id:other}])])await assert.rejects(()=>listing(value,value.limit===1?'&limit=1':''),status(502));
 await assert.rejects(()=>listing(page([row]),`&after=${id}`),status(502));await assert.rejects(()=>listing(page([row]),'&kind=invoice'),status(502));
});

test('download fixes its storage path, verifies full size/hash and reauthorizes before delivery',async()=>{
 const order=[];const got=await download(async(path,options)=>{order.push('storage');assert.equal(path,`/storage/v1/object/authenticated/brufap-received-dfe/objects/${sha}.xml`);assert.equal(options.redirect,'manual');assert.ok(options.signal instanceof AbortSignal);return response(bytes,{headers:{'Content-Length':String(bytes.length)}});},async(name,args)=>{order.push('auth');assert.equal(name,'erp_dfe_object');assert.deepEqual(args,{p_document_id:id,p_user_id:user});return meta;});
 assert.deepEqual(order,['auth','storage','auth']);assert.deepEqual(got.bytes,bytes);assert.equal(got.filename,meta.filename);assert.equal(got.headers['Cache-Control'],'no-store');assert.equal(got.headers['X-Content-Type-Options'],'nosniff');assert.match(got.headers['Content-Security-Policy'],/sandbox/);assert.match(got.headers['Content-Disposition'],/^attachment;/);
});

test('malicious metadata is rejected before storage access; summaries cannot acquire full-invoice filenames',async()=>{
 for(const patch of [{bucket:'public'},{object_key:'../../auth'},{object_key:`objects/${sha}.xml?token=PRIVATE`},{filename:'NFE_'+id+'.xml'},{filename:'a\r\nSet-Cookie:x'},{document:{...row,id:other}},{document:{...row,size_bytes:0}}])await assert.rejects(()=>download(()=>assert.fail('must not access Storage'),async()=>({...meta,...patch})),status(502));
});

test('download rejects corrupt, truncated, oversized, partial, redirected, encoded and wrong-MIME bytes',async()=>{
 for(const content of [bytes.slice(1),new Uint8Array(bytes.length+1),new Uint8Array(bytes.length)])await assert.rejects(()=>download(async()=>response(content)),status(502));
 for(const headers of [{'Content-Length':'1'},{'Content-Type':'text/xml'},{'Content-Type':'application/xml'},{'Content-Encoding':'gzip'}])await assert.rejects(()=>download(async()=>response(bytes,{headers})),status(502));
 await assert.rejects(()=>download(async()=>new Response(bytes)),status(502));
 for(const http of [206,302,404])await assert.rejects(()=>download(async()=>response(null,{status:http})),status(502));
 await assert.rejects(()=>download(async()=>{const r=response();Object.defineProperty(r,'redirected',{value:true});return r;}),status(502));
});

test('revoked role or changed metadata after the object read prevents every byte from being returned',async()=>{
 let calls=0;await assert.rejects(()=>download(undefined,async()=>{if(++calls===2)throw Object.assign(new Error('private denied'),{code:'42501'});return meta;}),status(403));
 for(const patch of [{document:{...row,collected_at:'2026-10-17T12:00:00Z'}},{document:{...row,nsu:'000000000000002'}}]){calls=0;await assert.rejects(()=>download(undefined,async()=>++calls===1?meta:{...meta,...patch}),status(502));}
});

test('one deadline bounds initial authorization, Storage headers/body and final authorization, cancelling late streams',async()=>{
 let accesses=0;await assert.rejects(()=>download(()=>{accesses++;return response();},()=>new Promise(()=>{}),{timeoutMs:5}),status(504));assert.equal(accesses,0);
 let cancelled=false;await assert.rejects(()=>download(async()=>response(new ReadableStream({cancel(){cancelled=true;}})),undefined,{timeoutMs:5}),status(504));assert.equal(cancelled,true);
 let resolve;const late=new Promise(done=>resolve=done);cancelled=false;await assert.rejects(()=>download(()=>late,undefined,{timeoutMs:5}),status(504));resolve(response(new ReadableStream({cancel(){cancelled=true;}})));await new Promise(done=>setTimeout(done,0));assert.equal(cancelled,true);
 let calls=0;await assert.rejects(()=>download(undefined,()=>++calls===1?meta:new Promise(()=>{}),{timeoutMs:5}),status(504));assert.equal(calls,2);
});
