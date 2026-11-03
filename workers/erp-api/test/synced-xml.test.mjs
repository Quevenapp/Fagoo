import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {parseSyncedXmlRoute,executeSyncedXmlRoute,syncedXmlMethods} from '../src/synced-xml.mjs';
const id='10000000-0000-4000-8000-000000000001',other='10000000-0000-4000-8000-000000000002',user='20000000-0000-4000-8000-000000000001';
const bytes=new TextEncoder().encode('<synthetic>XML FICTICIO SEM DADOS REAIS</synthetic>');
const sha=createHash('sha256').update(bytes).digest('hex'),key='3'.repeat(20)+'55'+'0'.repeat(22);
const row={id,source_id:'10001',entity:'nfe',key,model:'55',environment:'1',kind:'invoice',revision:1,source_status:'6',collected_at:'2026-10-16T12:00:00Z',xml_hash:sha,size_bytes:bytes.length,
 protocol:'123456789012345',protocol_present:true,signature_present:true,event_type:null,event_sequence:null,issues:[],validation:'structural_only',signature_verified:false,xsd_validated:false,authorization_verified:false};
const meta={id,revision_id:other,bucket:'origin-fiscal-xml',object_key:`objects/${sha}.xml`,sha256:sha,size:bytes.length,model:'55'};
const page=items=>({items,limit:25,has_more:false,next_cursor:null,data_mode:'fiscal_archive_readonly'});
const parse=(path='',options={})=>parseSyncedXmlRoute(new Request(`https://synthetic.invalid/v1/xmls-sincronizados${path}`,options));
const list=(body,route=parse())=>executeSyncedXmlRoute(route,{userId:user,rpc:async(name,args)=>{assert.equal(name,'erp_synced_xml_list');assert.equal(args.p_user_id,user);return body;}});
const download=(fetchObject,metadata=async()=>meta,options={})=>executeSyncedXmlRoute(parse(`/${id}/download`),{userId:user,rpc:metadata,fetchObject,...options});
const status=code=>error=>error.status===code;

test('GET-only exact route/query contract normalizes UUIDs and rejects ambiguous or unsafe input',()=>{
 assert.deepEqual(syncedXmlMethods('/v1/xmls-sincronizados'),['GET']);assert.equal(syncedXmlMethods('/v1/other'),null);
 assert.equal(parseSyncedXmlRoute(new Request('https://synthetic.invalid/v1/other')),null);
 assert.deepEqual(parse('?model=65&kind=event&include_history=true&limit=100&q=35').args,{p_limit:100,p_after:null,p_query:'35',p_model:'65',p_kind:'event',p_include_history:true});
 assert.equal(parse(`/${id.toUpperCase()}/download`).args.p_id,id);
 for(const path of ['?q=a&q=b','?q=%00','?q='+('a'.repeat(65)),'?model=57','?kind=xml','?include_history=1','?limit=0','?limit=101','?limit=-1','?after=bad','?status=ready','?object_key=secret',`/${id}/download?key=secret`])assert.throws(()=>parse(path),status(400));
 for(const method of ['POST','PUT','PATCH','DELETE'])assert.throws(()=>parse('',{method}),status(405));
 for(const path of ['/bad/download',`/${id}`,'/signed-url'])assert.throws(()=>parse(path),status(404));
});

test('list projection preserves structural-only meaning and strips private storage/source payload',async()=>{
 const value=await list(page([{...row,object_key:'DO_NOT_EXPOSE',payload:{secret:'DO_NOT_EXPOSE'}}]));
 assert.equal(value.type,'json');assert.deepEqual(value.body.items[0],row);assert.doesNotMatch(JSON.stringify(value),/DO_NOT_EXPOSE|object_key|payload/);
 const event={...row,id:other,kind:'event',event_type:'110111',event_sequence:'1',protocol:null,protocol_present:false,issues:['EVENT_PROTOCOL_ABSENT']};
 assert.equal((await list(page([event]))).body.items[0].kind,'event');
 for(const field of ['signature_verified','xsd_validated','authorization_verified'])await assert.rejects(()=>list(page([{...row,[field]:true}])),status(502));
 for(const change of [{entity:'nfce'},{protocol_present:false}])await assert.rejects(()=>list(page([{...row,...change}])),status(502));
 await assert.rejects(()=>list(page([{...row,validation:'sefaz_authorized'}])),status(502));
 await assert.rejects(()=>executeSyncedXmlRoute(parse(),{userId:'not-verified',rpc:()=>assert.fail('auth must precede RPC')}),status(401));
});

test('list binds filters, cursor, ascending order, IDs, sizes and all paging claims',async()=>{
 const one={...page([row]),limit:1,has_more:true,next_cursor:id};assert.equal((await list(one,parse('?limit=1'))).body.next_cursor,id);
 for(const body of [{...one,next_cursor:other},{...one,items:[]},{...page([row]),limit:100},page([row,row]),page([{...row,id:other},row]),page([{...row,size_bytes:8388609}]),page([{...row,key:'bad'}]),page([{...row,protocol:'<private>'}])])
  await assert.rejects(()=>list(body,body.limit===1?parse('?limit=1'):parse()),status(502));
 for(const suffix of [`?after=${id}`,'?model=65','?kind=event','?q=987654'])await assert.rejects(()=>list(page([row]),parse(suffix)),status(502));
 await assert.rejects(()=>list({...page([]),next_cursor:id}),status(502));
});

test('download verifies immutable metadata, entire size/hash and reauthorizes before emitting bytes',async()=>{
 const order=[];
 const value=await download(async path=>{order.push('storage');assert.equal(path,`/storage/v1/object/authenticated/origin-fiscal-xml/objects/${sha}.xml`);return new Response(bytes);},async(name,args)=>{order.push('auth');assert.equal(name,'erp_synced_xml_object');assert.equal(args.p_user_id,user);assert.equal(args.p_id,id);return meta;});
 assert.deepEqual(order,['auth','storage','auth']);assert.deepEqual(value.bytes,bytes);assert.equal(value.filename,`origin-55-${sha.slice(0,12)}.xml`);
 assert.equal(value.headers['Cache-Control'],'no-store');assert.equal(value.headers['X-Content-Type-Options'],'nosniff');assert.match(value.headers['Content-Disposition'],/^attachment;/);assert.match(value.headers['Content-Security-Policy'],/sandbox/);
});

test('no arbitrary path, mismatched revision or revoked membership can deliver a download',async()=>{
 for(const changed of [{id:other},{bucket:'public'},{object_key:'../../auth'},{size:0},{size:8388609},{sha256:'bad'},{revision_id:'bad'},{model:'57'}])
  await assert.rejects(()=>download(()=>assert.fail('storage must not be read'),async()=>({...meta,...changed})),status(502));
 let calls=0;await assert.rejects(()=>download(async()=>new Response(bytes),async()=>{if(++calls===2)throw Object.assign(new Error('denied'),{status:403});return meta;}),status(403));
 for(const changed of [{revision_id:id},{size:bytes.length+1},{model:'65'}]){
  let calls=0;await assert.rejects(()=>download(async()=>new Response(bytes),async()=>++calls===1?meta:{...meta,...changed}),status(502));
 }
});

test('truncated, oversized, corrupt, redirected and partial storage responses never return bytes',async()=>{
 for(const content of [bytes.slice(1),new Uint8Array(bytes.length+1),new Uint8Array(bytes.length)])await assert.rejects(()=>download(async()=>new Response(content)),status(502));
 await assert.rejects(()=>download(async()=>new Response(bytes,{headers:{'Content-Length':'1'}})),status(502));
 await assert.rejects(()=>download(async()=>new Response(bytes,{status:206})),status(502));
 await assert.rejects(()=>download(async()=>new Response(null,{status:302,headers:{Location:'https://untrusted.invalid'}})),status(502));
 await assert.rejects(()=>download(async()=>{const response=new Response(bytes);Object.defineProperty(response,'redirected',{value:true});return response;}),status(502));
});

test('stalled XML bodies and late fetches are bounded and cancelled without authorizing delivery',async()=>{
 let cancelled=false;
 await assert.rejects(()=>download(async()=>new Response(new ReadableStream({cancel(){cancelled=true;}})),undefined,{timeoutMs:5}),status(504));assert.equal(cancelled,true);
 let resolve;const late=new Promise(done=>{resolve=done;});cancelled=false;
 await assert.rejects(()=>download(()=>late,undefined,{timeoutMs:5}),status(504));
 resolve(new Response(new ReadableStream({cancel(){cancelled=true;}})));await new Promise(done=>setTimeout(done,0));assert.equal(cancelled,true);
});
