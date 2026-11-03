import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHandler} from '../src/index.mjs';
import {documentsResponse} from '../src/documents.mjs';
import {documentCopyResponse,parseDocumentCopyRoute} from '../src/document-copy.mjs';
import {actor,docId,input,record} from '../../../apps/erp/test/helpers/document-commercial-fixtures.mjs';

const command='e0000000-0000-4000-8000-000000000054';
const env={SUPABASE_URL:'https://project.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-key',ALLOWED_ORIGINS:'https://erp.example.test'};
const envelope=doc=>({data_mode:'erp_native',operational_effects:false,kind:doc.kind,document:doc});
function harness(result){const calls=[];return{calls,handler:createHandler({fetchImpl:async(url,options)=>{calls.push({url,...options});return new Response(JSON.stringify(url.endsWith('/auth/v1/user')?{id:actor}:result));}})};}
const request=(path,method='GET',body)=>new Request(`https://api.example.test${path}`,{method,headers:{Authorization:'Bearer synthetic-session',Origin:'https://erp.example.test',...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
const check=value=>documentsResponse(envelope(value),{kind:value.kind,id:docId},{type:'document'}).document;

test('054 HTTP saves exact declared references and decimal strings with the authenticated actor, then projects all four document kinds',async()=>{
 for(const kind of ['sales_proposals','sales_orders','purchase_orders','service_orders']){
  const data=input(),doc=record(kind,data),h=harness({...envelope(doc),private_token:'DO_NOT_PROJECT'});
  const response=await h.handler(request(`/v1/documentos/${kind}/${docId}`,'PATCH',{command_id:command,expected_version:1,data}),env);
  assert.equal(response.status,200);const result=await response.json();
  assert.deepEqual(JSON.parse(h.calls[1].body),{p_kind:kind,p_id:docId,p_expected_version:1,p_command_id:command,p_body:data,p_user_id:actor});
  assert.deepEqual(result.document.commercial,doc.commercial);assert.equal(result.document.commercial.transport.volume_count,'999999999999.000001');
  assert.equal(result.document.items[0].detailed_description,data.items[0].detailed_description);assert.deepEqual(result.document.installments,doc.installments);
  assert.equal(result.private_token,undefined);assert.equal(result.operational_effects,false);
 }
});

test('054 invalid nested shapes, reference identities and excessive precision are refused before authentication or RPC',async()=>{
 const variants=[
  data=>{data.commercial.transport.volume_count='1.0000001';},
  data=>{data.commercial.transport.gross_weight=0;},
  data=>{data.commercial.seller_reference.source_id='054';},
  data=>{data.commercial.seller_reference.url='https://example.invalid/';},
  data=>{delete data.commercial.attention_to;},
  data=>{data.items[0].detailed_description='x'.repeat(4001);},
  data=>{data.installments[0].payment_reference.system='native';},
  data=>{data.installments[0].note='bad\u0000text';},
 ];
 for(const mutate of variants){const data=input();mutate(data);const h=harness(envelope(record()));
  assert.equal((await h.handler(request(`/v1/documentos/sales_proposals/${docId}`,'PATCH',{command_id:command,expected_version:1,data}),env)).status,400);assert.equal(h.calls.length,0);
  const malformed=record();mutate(malformed);assert.throws(()=>check(malformed),error=>error.code==='ERP_UPSTREAM_INVALID_RESPONSE');
 }
});

test('054 projection preserves legacy absence, explicit null clearing and strips unknown private fields',()=>{
 const legacy=input();delete legacy.commercial;delete legacy.items[0].detailed_description;delete legacy.installments[0].note;delete legacy.installments[0].payment_reference;
 const projected=check(record('sales_proposals',legacy));assert.equal(Object.hasOwn(projected,'commercial'),false);assert.equal(Object.hasOwn(projected.items[0],'detailed_description'),false);assert.equal(Object.hasOwn(projected.installments[0],'note'),false);
 const clear=input();clear.commercial=null;clear.items[0].detailed_description=null;clear.installments[0].note=null;clear.installments[0].payment_reference=null;
 const doc=record('sales_proposals',clear);doc.raw_payload='DO_NOT_PROJECT';doc.items[0].private_origin='DO_NOT_PROJECT';doc.installments[0].private_origin='DO_NOT_PROJECT';
 const result=check(doc);assert.equal(result.commercial,null);assert.equal(result.items[0].detailed_description,null);assert.equal(result.installments[0].note,null);assert.equal(result.installments[0].payment_reference,null);assert.doesNotMatch(JSON.stringify(result),/DO_NOT_PROJECT/);
});

test('054 copy preview and submitted copy keep commercial details while the preview explicitly resets installments',async()=>{
 const data=input();data.installments=[];data.items[0].id=null;
 const route={type:'preview',args:{p_kind:'sales_proposals',p_source_id:docId}};
 const source={id:docId,kind:'sales_proposals',number:'54',version:3};
 const preview=documentCopyResponse({data_mode:'erp_native',operational_effects:false,persisted:false,source,data,reset_fields:['date','expected_date','valid_until','next_contact','installments','template','equipment','serial_number','technician','defect','solution']},route);
 assert.deepEqual(preview.data.commercial,record().commercial);assert.equal(preview.data.items[0].detailed_description,input().items[0].detailed_description);assert.deepEqual(preview.data.installments,[]);
 const submitted={command_id:command,expected_source_version:3,data:preview.data};
 const parsed=await parseDocumentCopyRoute(request(`/v1/duplicacao-documentos/sales_proposals/${docId}`,'POST',submitted));assert.deepEqual(parsed.args.p_body,preview.data);
 const target=record('sales_proposals',{...preview.data,items:preview.data.items.map(item=>({...item,id:'d0000000-0000-4000-8000-000000000055'}))});target.id='b0000000-0000-4000-8000-000000000055';
 const copied=documentCopyResponse({...envelope(target),replayed:false,copy_source:source},parsed);
 assert.deepEqual(copied.document.commercial,preview.data.commercial);assert.equal(copied.document.items[0].detailed_description,preview.data.items[0].detailed_description);assert.deepEqual(copied.document.installments,[]);
});
