import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createSecureContext,checkServerIdentity} from 'node:tls';
import {createHash} from 'node:crypto';
import {prepareDistributionExchange,createDistributionTransport,DFE_TRANSPORT_LIMITS} from '../src/distribution-transport.mjs';
import {parseDistributionResponse,planDistributionContinuation} from '../../fiscal-xml/src/distribution.mjs';
const input={environment:'2',authorUf:'35',interestedCnpj:'11222333000181',lastNsu:'000000000000005'};
const prepared=()=>prepareDistributionExchange(input),context=()=>createSecureContext({minVersion:'TLSv1.2',maxVersion:'TLSv1.3'});
const hash=v=>createHash('sha256').update(v).digest('hex');
const responseXml='<retDistDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01"><tpAmb>2</tpAmb><verAplic>FIXTURE</verAplic><cStat>137</cStat><xMotivo>NENHUM DOCUMENTO FICTICIO</xMotivo><dhResp>2026-10-16T10:00:00-03:00</dhResp><ultNSU>000000000000005</ultNSU><maxNSU>000000000000005</maxNSU></retDistDFeInt>';
const responseBytes=Buffer.from(responseXml);
const error=(code,sent)=>e=>e.code===code&&e.may_have_been_sent===sent&&e.retry_automatically===false&&!/SECRET|PASSWORD/.test(e.message);
function fixture(config={}){
 const state={calls:0,writes:0,destroyedRequest:false,destroyedSocket:false,destroyedResponse:false,wire:null};
 state.requestImpl=(options,callback)=>{
  state.calls++;state.options=options;if(config.throwCreate)throw new Error('SECRET_PASSWORD');
  const req=new EventEmitter(),socket=new EventEmitter(),res=new EventEmitter();state.req=req;state.socket=socket;state.res=res;
  req.destroy=()=>{state.destroyedRequest=true;};socket.destroy=()=>{state.destroyedSocket=true;};res.destroy=()=>{state.destroyedResponse=true;};
  socket.encrypted=config.encrypted??true;socket.authorized=config.authorized??true;socket.getProtocol=()=>config.protocol??'TLSv1.3';
  const bytes=config.bytes??responseBytes;res.statusCode=config.status??200;res.complete=config.complete??true;
  res.headers={'content-type':'text/xml; charset=utf-8','content-length':String(bytes.length),...config.headers};
  for(const key of Object.keys(res.headers))if(res.headers[key]===undefined)delete res.headers[key];
  res.rawHeaders=config.rawHeaders??Object.entries(res.headers).flat();
  req.end=wire=>{
   state.writes++;state.wire=Buffer.from(wire);if(config.throwWrite)throw new Error('SECRET_PASSWORD');
   if(config.noResponse)return;
   queueMicrotask(()=>{
    callback(res);if(state.destroyedResponse)return;
    if(config.responseError){res.emit('error',new Error('SECRET_PASSWORD'));return;}
    if(config.responseAbort){res.emit('aborted');return;}
    if(config.closeOnly){res.emit('close');return;}
    if(config.stallBody)return;
    if(config.data!==false)res.emit('data',bytes);
    if(config.closeAfterData)res.emit('close');else res.emit('end');
   });
  };
  queueMicrotask(()=>{req.emit('socket',socket);if(config.failConnection)req.emit('error',new Error('SECRET_PASSWORD'));else if(!config.noHandshake)socket.emit('secureConnect');});
  return req;
 };return state;
}
const exchange=(f,options={})=>createDistributionTransport({requestImpl:f.requestImpl}).exchange(prepared(),{secureContext:context(),...options});

test('wire plan derives fixed official endpoint and SOAP1.1 from exact fields, never caller XML or URLs',()=>{
 const p=prepared();assert.equal(p.endpoint,'https://hom1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx');assert.equal(prepareDistributionExchange({...input,environment:'1'}).hostname,'www1.nfe.fazenda.gov.br');
 assert.match(p.wire_xml,/http:\/\/schemas.xmlsoap.org\/soap\/envelope\//);assert.match(p.wire_xml,/<nfeDistDFeInteresse xmlns="http:\/\/www.portalfiscal.inf.br\/nfe\/wsdl\/NFeDistribuicaoDFe">/);assert.equal(p.request.lastNsu,input.lastNsu);assert.equal(p.wire_hash,hash(p.wire_xml));assert.notEqual(p.request_hash,p.wire_hash);
 assert.equal(p.binding_verified,false);assert.equal(p.can_query,false);assert.equal(p.operation_authorized,false);assert.ok(Object.isFrozen(p));assert.ok(Object.isFrozen(p.request));
 for(const extra of [{url:'https://evil.invalid'},{wire_xml:'<evil/>'},{headers:{}},{environment:'3'},{lastNsu:5},{interestedCnpj:'bad'},{authorUf:'99'}])assert.throws(()=>prepareDistributionExchange({...input,...extra}));
});

test('there is no default driver; fabricated plans, invalid TLS inputs, aborts and expired deadlines perform zero requests',async()=>{
 assert.throws(()=>createDistributionTransport(),error('DFE_TRANSPORT_DRIVER_REQUIRED',false));const f=fixture(),driver=createDistributionTransport({requestImpl:f.requestImpl}),p=prepared();
 await assert.rejects(()=>driver.exchange({...p},{secureContext:context()}),error('DFE_TRANSPORT_PLAN_UNATTESTED',false));
 for(const options of [{secureContext:{}},{secureContext:context(),url:'https://evil.invalid'},{secureContext:context(),deadline:1},{secureContext:context(),deadline:Date.now()+31000},{secureContext:context(),signal:AbortSignal.abort()}])await assert.rejects(()=>driver.exchange(p,options));assert.equal(f.calls,0);
});

test('one-shot transport writes only after authenticated TLS, fixes TLS/HTTP settings and closes every resource',async()=>{
 const f=fixture(),p=prepared(),driver=createDistributionTransport({requestImpl:f.requestImpl});const result=await driver.exchange(p,{secureContext:context()});
 assert.equal(f.calls,1);assert.equal(f.writes,1);assert.equal(f.wire.toString(),p.wire_xml);assert.deepEqual(result.bytes,responseBytes);assert.equal(result.response_hash,hash(responseBytes));assert.equal(result.request_hash,p.request_hash);assert.equal(result.binding_verified,false);assert.equal(result.tls_origin_verified,false);assert.equal(result.requires_parser_validation,true);
 const o=f.options;assert.equal(o.method,'POST');assert.equal(o.port,443);assert.equal(o.hostname,p.hostname);assert.equal(o.servername,p.hostname);assert.equal(o.path,p.path);assert.equal(o.rejectUnauthorized,true);assert.equal(o.checkServerIdentity,checkServerIdentity);assert.deepEqual(o.ALPNProtocols,['http/1.1']);assert.equal(o.minVersion,'TLSv1.2');assert.equal(o.maxVersion,'TLSv1.3');assert.equal(o.agent.options.keepAlive,false);assert.equal(o.agent.maxCachedSessions,0);assert.deepEqual(o.agent.options.proxyEnv,{});assert.equal(o.headers['Accept-Encoding'],'identity');assert.equal(o.headers.Connection,'close');assert.equal(o.headers.SOAPAction,`"${p.soap_action}"`);
 assert.ok(f.destroyedRequest&&f.destroyedSocket&&f.destroyedResponse);await assert.rejects(()=>driver.exchange(p,{secureContext:context()}),error('DFE_TRANSPORT_PLAN_CONSUMED',false));assert.equal(f.calls,1);
});

test('failed TLS and connection setup never write an HTTP query and do not expose raw errors',async()=>{
 for(const config of [{authorized:false},{encrypted:false},{protocol:'TLSv1.1'},{protocol:'unknown'}]){const f=fixture(config);await assert.rejects(()=>exchange(f),error('DFE_TRANSPORT_TLS_REJECTED',false));assert.equal(f.writes,0);assert.ok(f.destroyedRequest&&f.destroyedSocket);}
 for(const config of [{failConnection:true},{throwCreate:true}]){const f=fixture(config);await assert.rejects(()=>exchange(f),error('DFE_TRANSPORT_CONNECTION_FAILED',false));assert.equal(f.writes,0);}
 await assert.rejects(()=>createDistributionTransport({requestImpl:()=>({})}).exchange(prepared(),{secureContext:context()}),error('DFE_TRANSPORT_DRIVER_INVALID',false));
});

test('once writing starts every failure is uncertain, with no retry or SOAP downgrade',async()=>{
 for(const [config,code]of [[{throwWrite:true},'DFE_TRANSPORT_WRITE_FAILED'],[{responseError:true},'DFE_TRANSPORT_RESPONSE_LOST'],[{responseAbort:true},'DFE_TRANSPORT_RESPONSE_LOST'],[{closeOnly:true},'DFE_TRANSPORT_RESPONSE_PARTIAL'],[{closeAfterData:true},'DFE_TRANSPORT_RESPONSE_PARTIAL']]){
  const f=fixture(config);await assert.rejects(()=>exchange(f),error(code,true));assert.equal(f.calls,1);assert.equal(f.writes,1);assert.ok(f.destroyedRequest&&f.destroyedSocket);
 }
});

test('redirects, HTTP errors, SOAP1.2, compressed bodies and ambiguous headers are rejected after exactly one write',async()=>{
 const cases=[{status:301},{status:302},{status:307},{status:500},{status:206},{headers:{'content-type':'application/soap+xml'}},{headers:{'content-type':'text/html'}},{headers:{'content-type':'text/xml; charset=iso-8859-1'}},{headers:{'content-encoding':'gzip'}},{headers:{'content-encoding':'br'}},{headers:{'content-length':'1e3'}},{headers:{'content-length':'0'}},{headers:{'transfer-encoding':'chunked'}},{rawHeaders:['Content-Type','text/xml','Content-Type','text/xml']},{rawHeaders:['x-long','x'.repeat(16384)]}];
 for(const config of cases){const f=fixture(config);await assert.rejects(()=>exchange(f),e=>e.may_have_been_sent===true&&e.retry_automatically===false);assert.equal(f.calls,1);assert.equal(f.writes,1);assert.ok(f.destroyedRequest&&f.destroyedSocket&&f.destroyedResponse);}
});

test('body completeness, exact declared size and eight MiB cap are enforced without partial output',async()=>{
 for(const config of [{complete:false},{data:false},{headers:{'content-length':String(responseBytes.length+1)}},{bytes:Buffer.alloc(DFE_TRANSPORT_LIMITS.response_bytes+1),headers:{'content-length':undefined}},{headers:{'content-length':String(DFE_TRANSPORT_LIMITS.response_bytes+1)}}]){const f=fixture(config);await assert.rejects(()=>exchange(f),e=>e.may_have_been_sent);assert.ok(f.destroyedResponse);}
 const f=fixture({headers:{'content-length':undefined,'transfer-encoding':'chunked'}});assert.deepEqual((await exchange(f)).bytes,responseBytes);
});

test('a single wall-clock deadline covers handshake and body, closes sockets and conservatively distinguishes writing',async()=>{
 for(const [config,sent]of [[{noHandshake:true},false],[{noResponse:true},true],[{stallBody:true},true]]){const f=fixture(config);await assert.rejects(()=>exchange(f,{deadline:Date.now()+15}),error('DFE_TRANSPORT_TIMEOUT',sent));assert.ok(f.destroyedRequest&&f.destroyedSocket);assert.equal(f.calls,1);}
 const f=fixture({stallBody:true}),abort=new AbortController();const promise=exchange(f,{signal:abort.signal});setTimeout(()=>abort.abort(),5);await assert.rejects(()=>promise,error('DFE_TRANSPORT_ABORTED',true));assert.ok(f.destroyedResponse&&f.destroyedSocket);
});

test('a consumed plan stays consumed after uncertainty and a late response is destroyed without delivery',async()=>{
 const f=fixture({noResponse:true}),p=prepared(),driver=createDistributionTransport({requestImpl:f.requestImpl});await assert.rejects(()=>driver.exchange(p,{secureContext:context(),deadline:Date.now()+10}),error('DFE_TRANSPORT_TIMEOUT',true));await assert.rejects(()=>driver.exchange(p,{secureContext:context()}),error('DFE_TRANSPORT_PLAN_CONSUMED',false));assert.equal(f.calls,1);
 let cb;const req=new EventEmitter();req.end=()=>{};req.destroy=()=>{};
 const late=createDistributionTransport({requestImpl:(_options,callback)=>{cb=callback;return req;}});await assert.rejects(()=>late.exchange(prepared(),{secureContext:context(),deadline:Date.now()+5}),error('DFE_TRANSPORT_TIMEOUT',false));let destroyed=false;const res=new EventEmitter();res.destroy=()=>destroyed=true;cb(res);assert.equal(destroyed,true);
});

test('transport bytes require the existing attested parser and coordination remains a separate blocking decision',async()=>{
 const output=await exchange(fixture());const parsed=await parseDistributionResponse(output.bytes,{request:input});assert.equal(parsed.status,'137');assert.equal(parsed.requestHash,output.request_hash);assert.equal(parsed.responseHash,output.response_hash);
 const coordination={coordinator:'external',checkpointConfirmed:false,otherConsumersReviewed:false,lastNsu:null};const plan=planDistributionContinuation({response:parsed,coordination,receivedAt:'2026-10-16T13:00:00Z'});assert.equal(plan.canQuery,false);assert.equal(plan.action,'coordination_required');
});
