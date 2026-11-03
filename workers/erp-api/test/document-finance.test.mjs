import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {parseDocumentFinanceRoute,executeDocumentFinanceRoute,documentFinanceMethods} from '../src/document-finance.mjs';
import {createHandler} from '../src/index.mjs';
const user=randomUUID(),documentId=randomUUID(),postingId=randomUUID(),titleId=randomUUID(),base=`/v1/documentos/sales_orders/${documentId}/financeiro`;
const parse=(path,method='GET',body)=>parseDocumentFinanceRoute(new Request(`https://api.example.test${path}`,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined}));
const status=n=>error=>error.status===n;
const summary=()=>({id:postingId,document_id:documentId,source_document_version:3,group_id:randomUUID(),state:'active',version:1,kind:'sales_orders',number:'1',direction:'receivable',total_cents:'302',installments:1,plan_source:'document',created_at:'2026-10-16T12:00:00Z',reversed_at:null,reason:null});
const title=()=>({id:titleId,position:1,version:1,due_on:'2026-11-01',amount_cents:'302',settled_cents:'0',balance_cents:'302',cancelled:false,category_id:null,description:'Pedido de venda nº 1',cnab_linked:false});
const detail=()=>({document_id:documentId,document_version:4,posting:summary(),titles:[title()],data_mode:'erp_native'});
const preview=()=>({document_id:documentId,kind:'sales_orders',number:'1',document_version:3,status:'verified',contact_id:randomUUID(),contact_name:'Cliente fictício',contact_version:1,issued_on:'2026-10-16',direction:'receivable',total_cents:'302',category_id:null,category_name:null,category_version:null,plan_source:'document',preview_hash:'a'.repeat(64),installments:[{position:1,amount_cents:'302',due_on:'2026-11-01',method:null}]});
test('strict routes, methods, query and actor/body fields reject unintended or malformed operations',async()=>{
 assert.equal(await parse('/v1/financeiro/titles'),null);assert.deepEqual(documentFinanceMethods(`${base}/post`),['POST']);
 for(const path of [`${base}?limit=`,`${base}?limit=101`,`${base}?limit=1&limit=2`,`${base}?raw=true`,`${base}?after=x`])await assert.rejects(()=>parse(path),status(400));
 await assert.rejects(()=>parse(base,'POST',{}),status(405));await assert.rejects(()=>parse(`${base}/preview`),status(405));
 await assert.rejects(()=>parse(base.replace('sales_orders','sales_proposals')),status(404));
 for(const body of [{expected_document_version:0},{expected_document_version:3,actor:user},{expected_document_version:3,category_id:'bad'},{expected_document_version:3,installments:[{amount_cents:302,due_on:'2026-11-01'}]},{expected_document_version:3,installments:[{amount_cents:'302',due_on:'2026-02-30'}]}])await assert.rejects(()=>parse(`${base}/preview`,'POST',body),status(400));
 const invalidReverse={expected_document_version:4,expected_posting_version:1,command_id:randomUUID(),preview_hash:'a'.repeat(64),title_versions:[{id:titleId,version:1},{id:titleId.toUpperCase(),version:1}],reason:'Conferido'};
 await assert.rejects(()=>parse(`${base}/${postingId}/reverse`,'POST',invalidReverse),status(400));
 const huge=new Request(`https://api.example.test${base}/preview`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expected_document_version:3,padding:'x'.repeat(66000)})});await assert.rejects(()=>parseDocumentFinanceRoute(huge),status(400));
});
test('parser canonicalizes accepted UUIDs and adapter sends only the verified actor to its fixed RPC',async()=>{
 const route=await parse(base.replace(documentId,documentId.toUpperCase())+`/${postingId.toUpperCase()}`);assert.equal(route.args.p_document_id,documentId);assert.equal(route.args.p_posting_id,postingId);
 const value=detail();value.raw='PRIVATE_RAW';value.posting.actor=user;value.titles[0].bank_secret='PRIVATE_SECRET';let call;
 const result=await executeDocumentFinanceRoute(route,{userId:user,rpc:async(name,args)=>{call={name,args};return value;}});
 assert.equal(call.name,'erp_document_finance_get');assert.equal(call.args.p_user_id,user);assert.equal(result.raw,undefined);assert.equal(result.posting.actor,undefined);assert.equal(result.titles[0].bank_secret,undefined);
});
test('response DTOs bind to requested document, kind and posting; swapped well-formed data fail closed',async()=>{
 const getRoute=await parse(`${base}/${postingId}`);
 for(const mutate of [v=>{v.document_id=v.posting.document_id=randomUUID();},v=>{v.posting.id=randomUUID();},v=>{v.posting.kind='purchase_orders';v.posting.direction='payable';},v=>{v.titles[0].balance_cents='301';},v=>{v.posting.total_cents='999';}]){
  const value=detail();mutate(value);await assert.rejects(()=>executeDocumentFinanceRoute(getRoute,{userId:user,rpc:async()=>value}),status(502));
 }
 const previewRoute=await parse(`${base}/preview`,'POST',{expected_document_version:3});
 for(const mutate of [v=>{v.document_id=randomUUID();},v=>{v.kind='purchase_orders';v.direction='payable';},v=>{v.total_cents='301';},v=>{v.installments[0].amount_cents=302;}]){
  const value=preview();mutate(value);await assert.rejects(()=>executeDocumentFinanceRoute(previewRoute,{userId:user,rpc:async()=>({data_mode:'erp_native',cash_movement_performed:false,preview:value})}),status(502));
 }
 const reverseRoute=await parse(`${base}/${postingId}/reverse-preview`,'POST',{expected_document_version:4,expected_posting_version:1});
 const wrong=detail();wrong.posting.id=randomUUID();await assert.rejects(()=>executeDocumentFinanceRoute(reverseRoute,{userId:user,rpc:async()=>({data_mode:'erp_native',cash_movement_performed:false,preview:{...wrong,preview_hash:'a'.repeat(64)}})}),status(502));
});
test('preview is read-only, exact cents are strings and mutations cannot claim cash effects',async()=>{
 const pr=await parse(`${base}/preview`,'POST',{expected_document_version:3});const v=preview();
 const result=await executeDocumentFinanceRoute(pr,{userId:user,rpc:async()=>({data_mode:'erp_native',cash_movement_performed:false,preview:{...v,internal_notes:'PRIVATE'}})});
 assert.equal(result.preview.total_cents,'302');assert.equal(result.preview.internal_notes,undefined);assert.equal(result.cash_movement_performed,false);
 const postRoute=await parse(`${base}/post`,'POST',{expected_document_version:3,command_id:randomUUID(),preview_hash:'a'.repeat(64)});
 const value={...detail(),action:'post',replayed:false,cash_movement_performed:true};
 await assert.rejects(()=>executeDocumentFinanceRoute(postRoute,{userId:user,rpc:async()=>value}),status(502));
 value.cash_movement_performed=false;value.document_id=value.posting.document_id=randomUUID();
 await assert.rejects(()=>executeDocumentFinanceRoute(postRoute,{userId:user,rpc:async()=>value}),status(502));
});
const env={SUPABASE_URL:'https://project.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service',ALLOWED_ORIGINS:'https://erp.example.test'};
const request=(path,method='GET',body)=>new Request(`https://api.example.test${path}`,{method,headers:{Authorization:'Bearer synthetic-token',Origin:'https://erp.example.test',...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
test('Worker integration authenticates actor, isolates SQL errors and enforces CORS for document effects',async()=>{
 const calls=[];let fail=null;const handler=createHandler({fetchImpl:async(url,options)=>{calls.push({url,options});if(url.endsWith('/auth/v1/user'))return Response.json({id:user});if(fail)return Response.json({code:fail,message:'PRIVATE_SQL_DETAILS'},{status:400});return Response.json({...detail(),private:'PRIVATE_RAW'});}});
 const response=await handler(request(`${base}/${postingId}`),env);assert.equal(response.status,200);assert.equal(calls.length,2);assert.equal(JSON.parse(calls[1].options.body).p_user_id,user);assert.ok(calls[1].url.endsWith('/erp_document_finance_get'));assert.doesNotMatch(await response.text(),/PRIVATE/);
 for(const [code,statusCode]of [['42501',403],['22023',400],['P0002',404],['40001',409],['23505',409]]){fail=code;const r=await handler(request(`${base}/${postingId}`),env);assert.equal(r.status,statusCode);assert.doesNotMatch(await r.text(),/PRIVATE_SQL/);}
 const noAuth=request(base);noAuth.headers.delete('Authorization');assert.equal((await handler(noAuth,env)).status,401);
 for(const prefix of [`${base}/post`,`/v1/documentos-estoque/sales_orders/${documentId}/post`]){const preflight=new Request(`https://api.example.test${prefix}`,{method:'OPTIONS',headers:{Origin:'https://erp.example.test','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'Authorization,Content-Type'}});const r=await handler(preflight,env);assert.equal(r.status,204);assert.equal(r.headers.get('Access-Control-Allow-Methods'),'POST');preflight.headers.set('Origin','https://other.invalid');assert.equal((await handler(preflight,env)).status,403);}
});
