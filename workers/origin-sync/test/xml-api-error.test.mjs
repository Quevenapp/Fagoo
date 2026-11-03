import test from 'node:test';
import assert from 'node:assert/strict';
import {OriginClient} from '../src/client.mjs';
import {xmlApiErrorCode} from '../src/xml-api-error.mjs';
const key='9'.repeat(44),path='/nfe/documento/'+key;
const body=()=>({error:{type:'VALIDATION_ERROR',message:'PRIVATE_MESSAGE',description:'PRIVATE_DESCRIPTION',fields:[{code:38,msg:'PRIVATE_FIELD',element:'',namespace:'NOTA_FISCAL'}]}});
const response=value=>new Response(typeof value==='string'?value:JSON.stringify(value),{status:400,headers:{'Content-Type':'application/json'}});
function client(value,options={}){let calls=0;return{get calls(){return calls;},instance:new OriginClient('SYNTHETIC_PRIVATE_TOKEN',{ apiOrigin: 'https://api.provider.example',intervalMs:0,maxRequests:1,fetchImpl:async()=>{calls++;return value;},...options})};}
test('XML400 emits only the allowlisted unavailable code without provider text or extra calls',async()=>{
 const c=client(response(body()));
 await assert.rejects(c.instance.get(path,{formato:'xml'}),error=>{
  assert.equal(error.code,'ORIGIN_XML_DOCUMENT_UNAVAILABLE');assert.equal(error.status,400);assert.equal(error.retryable,false);
  assert.doesNotMatch(String(error)+JSON.stringify(error),/PRIVATE_|https|999999|fields|description|namespace/);return true;
 });assert.equal(c.calls,1);assert.equal(c.instance.remainingRequests,0);
});
test('same body outside XML remains generic and is not parsed',async()=>{
 let pulls=0,cancelled=false;
 const r=new Response(new ReadableStream({pull(){pulls++;},cancel(){cancelled=true;}}),{status:400,headers:{'Content-Type':'application/json'}});
 const c=client(r);await assert.rejects(c.instance.get('/nfe/123'),{code:'ORIGIN_HTTP_ERROR'});assert.equal(cancelled,true);assert.ok(pulls<=1);
});
test('type, numeric code, namespace and sole-field shape must match exactly',async()=>{
 const variants=[];
 for(const [field,value]of [['code','38'],['code',39],['namespace','OTHER']]){const x=body();x.error.fields[0][field]=value;variants.push(x);}
 const wrong=body();wrong.error.type='OTHER';variants.push(wrong);
 for(const fields of [[],{},[...body().error.fields,{code:99,namespace:'NOTA_FISCAL'}]]){const x=body();x.error.fields=fields;variants.push(x);}
 variants.push({...body(),data:[]},null,[],'PRIVATE_MALFORMED');
 for(const value of variants){const c=client(response(value));await assert.rejects(c.instance.get(path,{formato:'xml'}),{code:'ORIGIN_HTTP_ERROR',status:400});assert.equal(c.calls,1);}
});
test('unrelated HTTP status retains auth, missing, rate and server behavior',async()=>{
 for(const [status,code]of [[401,'ORIGIN_UNAUTHORIZED'],[403,'ORIGIN_FORBIDDEN'],[404,'ORIGIN_NOT_FOUND'],[422,'ORIGIN_HTTP_ERROR'],[429,'ORIGIN_RATE_LIMITED'],[500,'ORIGIN_SERVER_ERROR']]){
  const c=client(new Response(JSON.stringify(body()),{status,headers:{'Content-Type':'application/json'}}));
  await assert.rejects(c.instance.get(path,{formato:'xml'},{maxAttempts:1}),{code,status});assert.equal(c.calls,1);
 }
});
test('oversized declared/body, non-JSON, invalid UTF8 and broken stream fall back without leaking',async()=>{
 const cases=[new Response(JSON.stringify(body()),{status:400,headers:{'Content-Type':'text/html'}}),new Response(JSON.stringify(body()),{status:400,headers:{'Content-Type':'application/json','Content-Length':'16385'}}),response(' '.repeat(16385)+JSON.stringify(body())),new Response(new Uint8Array([0xff]),{status:400,headers:{'Content-Type':'application/json'}}),new Response(new ReadableStream({start(c){c.error(new Error('PRIVATE_STREAM'));}}),{status:400,headers:{'Content-Type':'application/json'}})];
 for(const r of cases){const c=client(r);await assert.rejects(c.instance.get(path,{formato:'xml'}),e=>{assert.equal(e.code,'ORIGIN_HTTP_ERROR');assert.doesNotMatch(String(e)+JSON.stringify(e),/PRIVATE_|999999/);return true;});}
});
test('a stalled error body stays inside the existing request timeout and is cancelled',async()=>{
 let cancelled=false;
 const stream=new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancelled=true;}});
 const c=client(new Response(stream,{status:400,headers:{'Content-Type':'application/json'}}),{timeoutMs:15});
 await assert.rejects(c.instance.get(path,{formato:'xml'}),{code:'ORIGIN_TIMEOUT'});assert.equal(cancelled,true);assert.equal(c.calls,1);
});
test('already aborted classification never consumes the provider body',async()=>{
 const signal=AbortSignal.abort();assert.equal(await xmlApiErrorCode(response(body()),signal),'ORIGIN_HTTP_ERROR');
});
