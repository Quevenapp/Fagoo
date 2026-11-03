/** Local transport prototype. No default network driver, credential loader or runtime route. */
import {Agent} from 'node:https';
import {SecureContext,checkServerIdentity} from 'node:tls';
import {createHash} from 'node:crypto';
import {buildDistributionRequest,DISTRIBUTION_LIMITS} from '../../fiscal-xml/src/distribution.mjs';

const PATH='/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx';
const HOSTS=Object.freeze({'1':'www1.nfe.fazenda.gov.br','2':'hom1.nfe.fazenda.gov.br'});
const ACTION='http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe/nfeDistDFeInteresse';
const plans=new WeakSet(),consumed=new WeakSet();
const FLAGS=Object.freeze({offline_prototype:true,binding_verified:false,operation_authorized:false,can_query:false,can_manifest:false,can_emit:false,tls_origin_verified:false,sefaz_authorized:false});
export const DFE_TRANSPORT_LIMITS=Object.freeze({request_bytes:10240,response_bytes:DISTRIBUTION_LIMITS.responseBytes,header_bytes:16384,default_timeout_ms:20000,max_timeout_ms:30000});
const hash=v=>createHash('sha256').update(v).digest('hex');
export class DfeTransportError extends Error{
 constructor(code,{writeStarted=false}={}){super(code);this.name='DfeTransportError';this.code=code;this.request_write_started=writeStarted;this.may_have_been_sent=writeStarted;this.outcome=writeStarted?'uncertain':'not_written';this.retry_automatically=false;}
}
const need=(condition,code)=>{if(!condition)throw new DfeTransportError(code);};
const shape=(v,keys)=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v))&&Object.keys(v).every(k=>keys.includes(k));

/** Endpoint/operation come from the official registry and NT, never caller-supplied XML or URLs. */
export function prepareDistributionExchange(input){
 need(shape(input,['environment','authorUf','interestedCnpj','lastNsu']),'DFE_TRANSPORT_INPUT_INVALID');
 let prepared;try{prepared=buildDistributionRequest(input);}catch{throw new DfeTransportError('DFE_TRANSPORT_REQUEST_INVALID');}
 const wire=prepared.envelopeXml;need(Buffer.byteLength(wire)<=DFE_TRANSPORT_LIMITS.request_bytes,'DFE_TRANSPORT_REQUEST_LIMIT');
 const plan=Object.freeze({profile:'an-distribution-soap11-local-v1',environment:input.environment,endpoint:`https://${HOSTS[input.environment]}${PATH}`,hostname:HOSTS[input.environment],path:PATH,
  method:'POST',soap_action:ACTION,content_type:'text/xml; charset=utf-8',wire_xml:wire,wire_hash:hash(wire),request_hash:prepared.requestHash,request:prepared.request,
  binding_status:prepared.bindingStatus,...FLAGS});plans.add(plan);return plan;
}

/**
 * requestImpl has the node:https.request signature and is mandatory. This package
 * never imports its default driver. Tests inject event fixtures or loopback TLS.
 * A SecureContext is a scoped internal input, not proof of custody/policy/permission.
 */
export function createDistributionTransport({requestImpl}={}){
 need(typeof requestImpl==='function','DFE_TRANSPORT_DRIVER_REQUIRED');
 return Object.freeze({
  async exchange(plan,options={}){
   need(plans.has(plan),'DFE_TRANSPORT_PLAN_UNATTESTED');need(!consumed.has(plan),'DFE_TRANSPORT_PLAN_CONSUMED');
   need(shape(options,['secureContext','deadline','signal']),'DFE_TRANSPORT_OPTIONS_INVALID');
   const {secureContext,signal}=options,deadline=options.deadline??Date.now()+DFE_TRANSPORT_LIMITS.default_timeout_ms;
   need(secureContext instanceof SecureContext,'DFE_TRANSPORT_CONTEXT_REQUIRED');
   need(signal===undefined||signal instanceof AbortSignal,'DFE_TRANSPORT_SIGNAL_INVALID');
   need(Number.isSafeInteger(deadline)&&deadline>Date.now()&&deadline<=Date.now()+DFE_TRANSPORT_LIMITS.max_timeout_ms,'DFE_TRANSPORT_DEADLINE_INVALID');
   need(!signal?.aborted,'DFE_TRANSPORT_ABORTED');consumed.add(plan);
   // One connection, no session cache, no global agent/proxy settings or retries.
   const agent=new Agent({keepAlive:false,maxCachedSessions:0,maxSockets:1,proxyEnv:{}});
   const wire=Buffer.from(plan.wire_xml,'utf8');
   return new Promise((resolve,reject)=>{
    let req,socket,response,timer,done=false,writeStarted=false,ended=false,used=0;const chunks=[];
    const close=v=>{try{v?.destroy?.();}catch{/* A broken injected driver must not prevent settlement/cleanup. */}};
    const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);close(req);close(response);close(socket);close(agent);wire.fill(0);};
    const finish=(code,result)=>{
     if(done)return;done=true;cleanup();
     if(code){for(const c of chunks)c.fill(0);reject(new DfeTransportError(code,{writeStarted}));}else resolve(result);
    };
    const abort=()=>finish('DFE_TRANSPORT_ABORTED');
    const onResponse=res=>{
     if(done){res?.on?.('error',()=>{});res?.destroy?.();return;}
     response=res;
     if(!res||typeof res.on!=='function'||typeof res.destroy!=='function'){finish('DFE_TRANSPORT_DRIVER_INVALID');return;}
     res.on('error',()=>finish('DFE_TRANSPORT_RESPONSE_LOST'));res.on('aborted',()=>finish('DFE_TRANSPORT_RESPONSE_LOST'));
     res.on('close',()=>{if(!ended)finish('DFE_TRANSPORT_RESPONSE_PARTIAL');});
     if(!writeStarted){finish('DFE_TRANSPORT_RESPONSE_BEFORE_WRITE');return;}
     const raw=res.rawHeaders;const headers=res.headers;
     if(!Array.isArray(raw)||raw.length%2!==0||!headers||raw.some(x=>typeof x!=='string')||raw.reduce((n,x)=>n+Buffer.byteLength(x)+2,0)>DFE_TRANSPORT_LIMITS.header_bytes){finish('DFE_TRANSPORT_HEADERS_INVALID');return;}
     const seen=new Set();for(let i=0;i<raw.length;i+=2){const key=raw[i].toLowerCase();if(['content-type','content-length','content-encoding','transfer-encoding'].includes(key)&&seen.has(key)){finish('DFE_TRANSPORT_HEADERS_INVALID');return;}seen.add(key);}
     if(res.statusCode!==200){finish(res.statusCode>=300&&res.statusCode<400?'DFE_TRANSPORT_REDIRECT_REJECTED':'DFE_TRANSPORT_HTTP_REJECTED');return;}
     const type=headers['content-type'],encoding=headers['content-encoding'],length=headers['content-length'],transfer=headers['transfer-encoding'];
     // SOAP1.1 only. A different binding is a review, never an automatic retry.
     if(typeof type!=='string'||!/^text\/xml(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(type)||encoding!==undefined&&encoding!=='identity'||length!==undefined&&(typeof length!=='string'||!/^\d+$/.test(length)||Number(length)<1||Number(length)>DFE_TRANSPORT_LIMITS.response_bytes)||transfer!==undefined&&(transfer!=='chunked'||length!==undefined)){
      finish('DFE_TRANSPORT_HEADERS_INVALID');return;
     }
     res.on('data',part=>{
      if(done)return;if(Date.now()>=deadline){finish('DFE_TRANSPORT_TIMEOUT');return;}
      if(!(part instanceof Uint8Array)||(used+=part.length)>DFE_TRANSPORT_LIMITS.response_bytes){finish('DFE_TRANSPORT_RESPONSE_LIMIT');return;}
      chunks.push(Buffer.from(part));
     });
     res.on('end',()=>{
      ended=true;if(done)return;
      if(Date.now()>=deadline){finish('DFE_TRANSPORT_TIMEOUT');return;}
      if(res.complete!==true||used<1||length!==undefined&&Number(length)!==used){finish('DFE_TRANSPORT_RESPONSE_PARTIAL');return;}
      const bytes=Buffer.concat(chunks,used);for(const c of chunks)c.fill(0);
      const responseHash=hash(bytes);if(Date.now()>=deadline){bytes.fill(0);finish('DFE_TRANSPORT_TIMEOUT');return;}
      finish(null,Object.freeze({profile:plan.profile,status_code:200,bytes,response_hash:responseHash,size_bytes:used,request_hash:plan.request_hash,wire_hash:plan.wire_hash,
       request_write_started:true,body_received:true,requires_parser_validation:true,retry_automatically:false,...FLAGS}));
     });
    };
    const ready=()=>{
     if(done||writeStarted)return;
     if(Date.now()>=deadline){finish('DFE_TRANSPORT_TIMEOUT');return;}
     if(socket?.encrypted!==true||socket.authorized!==true||typeof socket.getProtocol!=='function'||!['TLSv1.2','TLSv1.3'].includes(socket.getProtocol())){finish('DFE_TRANSPORT_TLS_REJECTED');return;}
     // Mark before end(): an exception or lost response cannot prove non-delivery.
     writeStarted=true;try{req.end(wire);}catch{finish('DFE_TRANSPORT_WRITE_FAILED');}
    };
    timer=setTimeout(()=>finish('DFE_TRANSPORT_TIMEOUT'),Math.max(1,deadline-Date.now()));signal?.addEventListener('abort',abort,{once:true});
    try{
     if(signal?.aborted){abort();return;}if(Date.now()>=deadline){finish('DFE_TRANSPORT_TIMEOUT');return;}
     req=requestImpl({protocol:'https:',hostname:plan.hostname,port:443,path:PATH,method:'POST',servername:plan.hostname,secureContext,
      minVersion:'TLSv1.2',maxVersion:'TLSv1.3',rejectUnauthorized:true,checkServerIdentity,ALPNProtocols:['http/1.1'],agent,maxHeaderSize:DFE_TRANSPORT_LIMITS.header_bytes,insecureHTTPParser:false,
      headers:{Host:plan.hostname,'Content-Type':plan.content_type,SOAPAction:`"${ACTION}"`,'Content-Length':String(wire.length),'Accept':'text/xml','Accept-Encoding':'identity',Connection:'close'}},onResponse);
     if(!req||typeof req.on!=='function'||typeof req.end!=='function'||typeof req.destroy!=='function'){finish('DFE_TRANSPORT_DRIVER_INVALID');return;}
     req.on('error',()=>finish('DFE_TRANSPORT_CONNECTION_FAILED'));
     req.on('socket',s=>{if(done){s?.on?.('error',()=>{});s?.destroy?.();return;}socket=s;
      if(!s||typeof s.once!=='function'||typeof s.destroy!=='function'){finish('DFE_TRANSPORT_DRIVER_INVALID');return;}
      s.on('error',()=>finish('DFE_TRANSPORT_CONNECTION_FAILED'));s.once('secureConnect',ready);
      s.once('close',()=>{if(!ended)finish('DFE_TRANSPORT_CONNECTION_CLOSED');});
     });
     if(done)req.destroy();
    }catch{finish('DFE_TRANSPORT_CONNECTION_FAILED');}
   });
  }
 });
}
