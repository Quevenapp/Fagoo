import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createSecureContext,checkServerIdentity} from 'node:tls';
import {createHash} from 'node:crypto';
import {prepareWsdlRequest,inspectWsdl,createWsdlEvidenceClient,WSDL_LIMITS} from '../src/index.mjs';
import {fixture,plan,wsdl} from './fixtures.mjs';
const error=code=>e=>e.code===code&&e.retry_automatically===false&&!/SECRET/.test(e.message);
const changed=fn=>Buffer.from(fn(wsdl().toString()));

test('eight fixed homologation WSDL targets accept no caller URL, action, body, environment or getters',()=>{
 const targets=new Set();for(const model of ['55','65'])for(const operation of ['protocol','status','authorization','receipt']){const p=plan(model,operation);assert.equal(p.method,'GET');assert.match(p.url,/^https:\/\/homologacao\.(?:nfe|nfce)\.fazenda\.sp\.gov\.br\/ws\/\w+4\.asmx\?WSDL$/);assert.equal(p.binding_verified,false);assert.equal(p.can_transmit,false);assert.ok(Object.isFrozen(p));targets.add(p.url);}assert.equal(targets.size,8);
 for(const extra of [{url:'https://evil.invalid'},{environment:'1'},{method:'POST'},{operation:['status']},{model:55}])assert.throws(()=>prepareWsdlRequest({model:'55',operation:'status',requestId:'a',...extra}));
 let read=false;assert.throws(()=>prepareWsdlRequest({model:'55',operation:'status',get requestId(){read=true;return'a';}}));assert.equal(read,false);
});
test('parser extracts both literal bindings, never verifies their actions or authorizes SOAP',()=>{
 const p=plan(),bytes=wsdl(p),v=inspectWsdl(bytes,p);assert.deepEqual(v.bindings.map(b=>b.soap_version),['1.1','1.2']);assert.equal(v.addresses.length,2);assert.equal(v.wsdl_hash,createHash('sha256').update(bytes).digest('hex'));assert.equal(v.binding_verified,false);assert.equal(v.requires_binding_review,true);assert.equal(v.validation,'structural_evidence_only');assert.equal(v.bindings[1].operations[0].soap_action,'http://synthetic.invalid/service/query');assert.ok(Object.isFrozen(v.bindings[1].operations));
 assert.throws(()=>inspectWsdl(bytes,{...p}),error('WSDL_PLAN_UNATTESTED'));
});
test('absent SOAP binding style defaults to document; explicit invalid and operation rpc stay unsupported',()=>{
 const p=plan();
 for(const explicitOperation of [false,true]){
  const bytes=changed(s=>{s=s.replaceAll(' style="document"','');return explicitOperation?s.replaceAll('soapAction="http://synthetic.invalid/service/query"','soapAction="http://synthetic.invalid/service/query" style="document"'):s;});
  const v=inspectWsdl(bytes,p);assert.equal(v.inspection_status,'supported');assert.deepEqual(v.bindings.map(b=>b.style),['document','document']);assert.equal(v.binding_verified,false);assert.equal(v.can_transmit,false);
 }
 for(const style of ['','rpc','Document','document ']){
  const bytes=changed(s=>s.replaceAll('style="document"',`style="${style}"`));assert.equal(inspectWsdl(bytes,p).code,'WSDL_BINDING_UNSUPPORTED');
 }
 const rpcOperation=changed(s=>s.replaceAll(' style="document"','').replaceAll('soapAction="http://synthetic.invalid/service/query"','soapAction="http://synthetic.invalid/service/query" style="rpc"'));
 assert.equal(inspectWsdl(rpcOperation,p).code,'WSDL_BINDING_UNSUPPORTED');
});
test('DTD/entities, active PI and invalid UTF-8 fail before evidence while inert comments remain evidence',()=>{
 const cases=[Buffer.from('<!DOCTYPE x [<!ENTITY e SYSTEM "file:///SECRET">]>'+wsdl()),Buffer.from('<?evil SECRET?>'+wsdl()),Buffer.from([0xc0,0xaf]),changed(s=>s.replace('<wsdl:message','<![CDATA[SECRET]]><wsdl:message'))];for(const bytes of cases)assert.throws(()=>inspectWsdl(bytes,plan()),e=>e.code?.startsWith('WSDL_')&&!e.message.includes('SECRET'));
 const commented=changed(s=>s.replace('<wsdl:message','<!-- inert <? text <!DOCTYPE fake> --><wsdl:message'));assert.equal(inspectWsdl(commented,plan()).inspection_status,'supported');
});
test('unsupported bindings, imports and address substitutions preserve private bytes without trusting or following them',async()=>{
 const cases=[changed(s=>s.replace('name="response"','name="request"')),changed(s=>s.replace('type="tns:portType"','type="tns:missing"')),changed(s=>s.replace('message="tns:request"','message="alien:request"')),changed(s=>s.replaceAll('location="https://homologacao.nfe.fazenda.sp.gov.br','location="https://evil.invalid')),changed(s=>s.replace('use="literal"','use="encoded"')),changed(s=>s.replace('<wsdl:input><soap:body','<wsdl:input><soap:header/><soap:body')),changed(s=>s.replace('style="document"','style="rpc"')),Buffer.from('<wrapper>'+wsdl().toString().replace(/^<\?[^>]+>/,'')+'</wrapper>'),changed(s=>s.replace('<wsdl:message','<wsdl:import namespace="http://evil.invalid" location="https://evil.invalid"/><wsdl:message')),changed(s=>s.replace('<wsdl:message','<wsdl:types><x:include xmlns:x="http://www.w3.org/2001/XMLSchema" schemaLocation="https://evil.invalid"/></wsdl:types><wsdl:message')),changed(s=>s.replace('targetNamespace=', 'xml:base="https://evil.invalid" targetNamespace='))];
 for(const bytes of cases){const f=fixture({bytes}),result=await f.client.obtain(f.plan),v=result.inspection;assert.deepEqual(result.bytes,bytes);assert.equal(f.calls,1);assert.equal(v.inspection_status,'unsupported');assert.ok(v.code.startsWith('WSDL_'));assert.equal(v.target_namespace,null);assert.equal(v.bindings,null);assert.equal(v.addresses,null);assert.equal(v.binding_verified,false);assert.equal(v.can_transmit,false);}
});
test('size, lexical depth, attribute count, expired parser budget and empty bodies remain bounded',()=>{
 for(const bytes of [Buffer.alloc(WSDL_LIMITS.body_bytes+1),Buffer.alloc(0),Buffer.from('<a>'.repeat(66)+'</a>'.repeat(66)),changed(s=>s.replace('<wsdl:definitions ',`<wsdl:definitions ${Array.from({length:41},(_,i)=>`a${i}="1"`).join(' ')} `))])assert.throws(()=>inspectWsdl(bytes,plan()));
 assert.throws(()=>inspectWsdl(wsdl(),plan(),{deadline:1}),error('WSDL_DEADLINE_INVALID'));
});
test('GET starts only after TLS, fixes all security options and returns owned private evidence bytes',async()=>{
 const f=fixture(),out=await f.client.obtain(f.plan);assert.equal(f.calls,1);assert.equal(f.writes,1);assert.deepEqual(f.args,[]);assert.equal(out.private_evidence_only,true);assert.deepEqual(out.bytes,wsdl());assert.equal(out.binding_verified,false);assert.equal(out.can_query,false);assert.equal(out.operation_authorized,false);assert.equal(out.wsdl_hash,out.inspection.wsdl_hash);assert.deepEqual(out.tls,{protocol:'TLSv1.3',server_identity_verified:true});
 const o=f.options;assert.equal(o.method,'GET');assert.equal(o.path,f.plan.path);assert.equal(o.servername,f.plan.hostname);assert.equal(o.hostname,f.plan.hostname);assert.equal(o.port,443);assert.equal(o.checkServerIdentity,checkServerIdentity);assert.equal(o.rejectUnauthorized,true);assert.equal(o.minVersion,'TLSv1.2');assert.equal(o.maxVersion,'TLSv1.3');assert.equal(o.agent.maxCachedSessions,0);assert.deepEqual(o.agent.options.proxyEnv,{});assert.equal(o.headers.Authorization,undefined);assert.equal(o.headers.SOAPAction,undefined);assert.equal(o.headers['Accept-Encoding'],'identity');assert.ok(f.closedRequest&&f.closedSocket&&f.closedResponse);assert.equal(f.context.purpose,'sefaz-sp-wsdl-readonly-v1');assert.ok(Object.isFrozen(f.context));
 await assert.rejects(()=>f.client.obtain(f.plan),error('WSDL_PLAN_CONSUMED'));assert.equal(f.calls,1);
});
test('missing ports, fabricated plan, unauthorized session, expired deadline and preabort make no request',async()=>{
 assert.throws(()=>createWsdlEvidenceClient({}));const f=fixture();for(const opts of [{deadline:1},{deadline:Date.now()+31000},{signal:AbortSignal.abort()},{url:'https://evil.invalid'}])await assert.rejects(()=>f.client.obtain(plan(),opts));await assert.rejects(()=>f.client.obtain({...plan()}));assert.equal(f.calls,0);
 const bad=fixture({port:async()=>{throw new Error('SECRET_AUTH');}});await assert.rejects(()=>bad.client.obtain(bad.plan),error('WSDL_SESSION_FAILED'));assert.equal(bad.calls,0);
});
test('TLS refusal and raw driver errors are sanitized and do not write any HTTP body',async()=>{
 for(const config of [{authorized:false},{encrypted:false},{protocol:'TLSv1.1'}]){const f=fixture(config);await assert.rejects(()=>f.client.obtain(f.plan),error('WSDL_TLS_REJECTED'));assert.equal(f.writes,0);}
 for(const config of [{throwDriver:true},{connectionFail:true},{throwWrite:true}]){const f=fixture(config);await assert.rejects(()=>f.client.obtain(f.plan),e=>e.code.startsWith('WSDL_')&&!e.message.includes('SECRET'));assert.equal(f.calls,1);}
});
test('redirects never follow; HTTP failures, compression and conflicting header representations fail closed',async()=>{
 for(const config of [{status:301,headers:{location:'https://evil.invalid'}},{status:307},{status:403},{status:500},{headers:{'content-type':'text/html'}},{headers:{'content-encoding':'gzip'}},{headers:{'content-type':'text/xml; charset=iso-8859-1'}},{headers:{'transfer-encoding':'chunked'}},{rawHeaders:['Content-Type','text/xml','Content-Type','text/xml']},{rawHeaders:['Content-Type','text/xml','Content-Length','1']},{rawHeaders:['x-big','a'.repeat(16384)]}]){const f=fixture(config);await assert.rejects(()=>f.client.obtain(f.plan));assert.equal(f.calls,1);assert.equal(f.writes,1);assert.ok(f.closedResponse);}
});
test('complete body and content-length are mandatory when present; streaming limit and partial close destroy resources',async()=>{
 for(const config of [{complete:false},{closeOnly:true},{headers:{'content-length':'1'}},{bytes:Buffer.alloc(WSDL_LIMITS.body_bytes+1),headers:{'content-length':undefined}},{headers:{'content-length':String(WSDL_LIMITS.body_bytes+1)}}]){const f=fixture(config);await assert.rejects(()=>f.client.obtain(f.plan));assert.ok(f.closedResponse&&f.closedSocket);}
 const f=fixture({headers:{'content-length':undefined,'transfer-encoding':'chunked'}});assert.deepEqual((await f.client.obtain(f.plan)).bytes,wsdl());
});
test('one deadline covers session, handshake, headers and body, with abort and late response cleanup',async()=>{
 for(const config of [{port:()=>new Promise(()=>{})},{noHandshake:true},{noResponse:true},{stallBody:true}]){const f=fixture(config);await assert.rejects(()=>f.client.obtain(f.plan,{deadline:Date.now()+30}),error('WSDL_TIMEOUT'));if(f.calls)assert.ok(f.closedRequest&&f.closedSocket);}
 const f=fixture({stallBody:true}),ac=new AbortController(),p=f.client.obtain(f.plan,{signal:ac.signal});setTimeout(()=>ac.abort(),5);await assert.rejects(()=>p,error('WSDL_ABORTED'));assert.ok(f.closedResponse);
 const late=new EventEmitter();let destroyed=0;late.destroy=()=>destroyed++;f.callback(late);assert.equal(destroyed,1);
});
test('session must await exactly one callback; missing, repeated, premature and late callbacks cannot escape scope',async()=>{
 let callback;const late=fixture({port:async(_c,action)=>{callback=action;}});await assert.rejects(()=>late.client.obtain(late.plan),error('WSDL_TLS_CALLBACK_NOT_AWAITED'));assert.throws(()=>callback(createSecureContext()));assert.equal(late.calls,0);
 const early=fixture({noResponse:true,port:async(_c,action)=>{action(createSecureContext());}});await assert.rejects(()=>early.client.obtain(early.plan),error('WSDL_TLS_CALLBACK_NOT_AWAITED'));assert.ok(early.closedSocket||early.closedRequest);
 const repeated=fixture({port:async(_c,action)=>{await action(createSecureContext());try{await action(createSecureContext());}catch{}}});await assert.rejects(()=>repeated.client.obtain(repeated.plan),error('WSDL_TLS_CALLBACK_NOT_AWAITED'));assert.equal(repeated.calls,1);
});
test('options are captured and cleanup always removes the original caller signal listener',async()=>{
 const f=fixture({stallBody:true}),old=new AbortController(),other=new AbortController();let added=0,removed=0;const add=old.signal.addEventListener.bind(old.signal),remove=old.signal.removeEventListener.bind(old.signal);old.signal.addEventListener=(...a)=>{added++;return add(...a);};old.signal.removeEventListener=(...a)=>{removed++;return remove(...a);};
 const options={signal:old.signal,deadline:Date.now()+30},p=f.client.obtain(f.plan,options);options.signal=other.signal;await assert.rejects(()=>p,error('WSDL_TIMEOUT'));assert.equal(added,removed);assert.equal(other.signal.aborted,false);
});
