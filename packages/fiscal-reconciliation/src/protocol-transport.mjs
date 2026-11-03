/** Fixed protocol SOAP1.2 transport. Mandatory driver; no fetch/network/environment defaults. */
import {Agent} from 'node:https';
import {SecureContext,checkServerIdentity} from 'node:tls';
import {createHash} from 'node:crypto';
import {encodeReviewedProtocolSoap} from '../../fiscal-xml/src/protocol-binding.mjs';
import {requireProtocolServerContext} from '../../fiscal-runtime/src/protocol-server-trust.mjs';
import {need,fields,context,ReconciliationError} from './dto.mjs';
import {OPERATIONAL_PROFILE} from './profiles.mjs';
const close=v=>{try{v?.destroy?.();}catch{}};
const hash=b=>createHash('sha256').update(b).digest('hex');
function scoped(signal,deadline){const controller=new AbortController();let timer,code;const stop=c=>{if(code)return;code=c;controller.abort();},abort=()=>stop('RECONCILIATION_ABORTED');signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();timer=setTimeout(()=>stop('RECONCILIATION_TIMEOUT'),Math.max(1,deadline-Date.now()));return{signal:controller.signal,check(){if(Date.now()>=deadline)stop('RECONCILIATION_TIMEOUT');if(signal.aborted)abort();need(!code,code);},abort(){stop('RECONCILIATION_ABORTED');},close(){clearTimeout(timer);signal.removeEventListener('abort',abort);stop('RECONCILIATION_ABORTED');}};}
function read(requestImpl,plan,secureContext,s,body,trust){
 need(secureContext instanceof SecureContext,'RECONCILIATION_TRANSPORT_INVALID');s.check();
 const agent=new Agent({keepAlive:false,maxCachedSessions:0,maxSockets:1,proxyEnv:{}});
 return new Promise((resolve,reject)=>{
  let req,socket,response,tls,done=false,written=false,ended=false,used=0;const chunks=[];
  const finish=(code,result)=>{if(done)return;done=true;s.signal.removeEventListener('abort',abort);close(req);close(response);close(socket);close(agent);for(const c of chunks)c.fill(0);code?reject(new ReconciliationError(code)):resolve(result);};
  const abort=()=>{let code='RECONCILIATION_ABORTED';try{s.check();}catch(e){code=e.code;}finish(code);};
  const onResponse=res=>{
   if(done){res?.on?.('error',()=>{});close(res);return;}response=res;
   if(!res||typeof res.on!=='function'||typeof res.destroy!=='function'){finish('RECONCILIATION_TRANSPORT_INVALID');return;}
   res.on('error',()=>finish('RECONCILIATION_TRANSPORT_INVALID'));res.on('aborted',()=>finish('RECONCILIATION_TRANSPORT_INVALID'));res.on('close',()=>{if(!ended)finish('RECONCILIATION_TRANSPORT_INVALID');});
   if(!written){finish('RECONCILIATION_TRANSPORT_INVALID');return;}
   const raw=res.rawHeaders,headers=res.headers;
   if(!Array.isArray(raw)||raw.length%2||raw.some(x=>typeof x!=='string')||raw.reduce((n,x)=>n+Buffer.byteLength(x)+2,0)>8192||!headers){finish('RECONCILIATION_TRANSPORT_INVALID');return;}
   const observed=new Map();for(let i=0;i<raw.length;i+=2){const k=raw[i].toLowerCase();if(observed.has(k)&&['content-type','content-length','content-encoding','transfer-encoding','location'].includes(k)){finish('RECONCILIATION_TRANSPORT_INVALID');return;}observed.set(k,raw[i+1]);}
   for(const k of ['content-type','content-length','content-encoding','transfer-encoding'])if(headers[k]!==observed.get(k)){finish('RECONCILIATION_TRANSPORT_INVALID');return;}
   if(![200,500].includes(res.statusCode)){finish(res.statusCode>=300&&res.statusCode<400?'RECONCILIATION_TRANSPORT_INVALID':'RECONCILIATION_TRANSPORT_INVALID');return;}
   const type=headers['content-type'],encoding=headers['content-encoding'],length=headers['content-length'],transfer=headers['transfer-encoding'];
   if(typeof type!=='string'||!/^application\/soap\+xml(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(type)||encoding!==undefined&&encoding!=='identity'||length!==undefined&&(typeof length!=='string'||!/^[0-9]{1,9}$/.test(length)||Number(length)<1||Number(length)>512000)||transfer!==undefined&&(transfer!=='chunked'||length!==undefined)){finish('RECONCILIATION_TRANSPORT_INVALID');return;}
   res.on('data',part=>{if(done)return;try{s.check();}catch(e){finish(e.code);return;}if(!(part instanceof Uint8Array)||(used+=part.length)>512000){finish('RECONCILIATION_TRANSPORT_INVALID');return;}chunks.push(Buffer.from(part));});
   res.on('end',()=>{ended=true;if(done)return;try{s.check();}catch(e){finish(e.code);return;}if(res.complete!==true||used<1||length!==undefined&&Number(length)!==used){finish('RECONCILIATION_TRANSPORT_INVALID');return;}const bytes=Buffer.concat(chunks,used);finish(null,{bytes,tls,status:res.statusCode});});
  };
  const ready=()=>{if(done||written)return;try{s.check();}catch(e){finish(e.code);return;}
   if(socket?.encrypted!==true||socket.authorized!==true||typeof socket.getProtocol!=='function'||!['TLSv1.2','TLSv1.3'].includes(socket.getProtocol())){finish('RECONCILIATION_TRANSPORT_INVALID');return;}
   tls=Object.freeze({protocol:socket.getProtocol(),server_identity_verified:true,...trust});written=true;try{req.end(body);}catch{finish('RECONCILIATION_TRANSPORT_INVALID');}
  };
  s.signal.addEventListener('abort',abort,{once:true});
  try{
   s.check();req=requestImpl({protocol:'https:',hostname:plan.hostname,port:443,path:plan.path,method:'POST',servername:plan.hostname,secureContext,minVersion:'TLSv1.2',maxVersion:'TLSv1.3',rejectUnauthorized:true,checkServerIdentity,ALPNProtocols:['http/1.1'],agent,maxHeaderSize:8192,insecureHTTPParser:false,headers:{Host:plan.hostname,Accept:'application/soap+xml','Content-Type':plan.contentType,'Content-Length':String(body.length),'Accept-Encoding':'identity',Connection:'close'}},onResponse);
   if(!req||typeof req.on!=='function'||typeof req.end!=='function'||typeof req.destroy!=='function'){finish('RECONCILIATION_TRANSPORT_INVALID');return;}
   req.on('error',()=>finish('RECONCILIATION_TRANSPORT_INVALID'));
   req.on('socket',value=>{if(done){value?.on?.('error',()=>{});close(value);return;}socket=value;
    if(!socket||typeof socket.once!=='function'||typeof socket.destroy!=='function'){finish('RECONCILIATION_TRANSPORT_INVALID');return;}
    socket.on('error',()=>finish('RECONCILIATION_TRANSPORT_INVALID'));socket.once('secureConnect',ready);socket.once('close',()=>{if(!ended)finish('RECONCILIATION_TRANSPORT_INVALID');});
   });if(done)close(req);
  }catch(e){finish(e instanceof ReconciliationError?e.code:'RECONCILIATION_TRANSPORT_INVALID');}
 });
}

/** A local trust brand proves the configured server roots, not authority to use A1. SQL062 consumes the grant before this call. */
export function createProtocolTransport(configuration){
 need(fields(configuration,['requestImpl'])&&typeof configuration.requestImpl==='function','RECONCILIATION_PORTS_REQUIRED');const requestImpl=configuration.requestImpl,used=new Map();
 return async function transport(input,session,options){let bytes,s;
  try{
   need(fields(input,['request','grant'])&&fields(session,['secureContext','metadata','signal','deadline'])&&fields(options,['signal','deadline']),'RECONCILIATION_INPUT_INVALID');
   const plan=input.request,grant=context(input.grant,{},true),secureContext=session.secureContext,sessionSignal=session.signal,sessionDeadline=session.deadline,signal=options.signal,deadline=options.deadline,metadata=session.metadata;
   need(signal instanceof AbortSignal&&sessionSignal instanceof AbortSignal&&!sessionSignal.aborted&&Number.isSafeInteger(deadline)&&deadline>Date.now()&&deadline<=Date.now()+20000&&deadline<=sessionDeadline,'RECONCILIATION_OPTIONS_INVALID');
   need(grant.purpose===OPERATIONAL_PROFILE&&Date.parse(grant.expires_at)>Date.now()&&Date.parse(grant.issued_at)<=Date.now()+5000&&secureContext instanceof SecureContext&&!used.has(grant.attempt_id+':'+grant.nonce),'RECONCILIATION_GRANT_MISMATCH');
   need(fields(metadata,['fingerprint_sha256','holder_cnpj','not_before','not_after','client_auth_usage','presented_chain_links_checked','icp_brasil_chain_validated','revocation_checked','a1_policy_verified','can_emit','can_transmit'])&&metadata.fingerprint_sha256===grant.certificate_fingerprint&&metadata.holder_cnpj===grant.issuer_cnpj&&Date.parse(metadata.not_before)<=Date.now()&&Date.parse(metadata.not_after)>=Date.now(),'RECONCILIATION_GRANT_MISMATCH');
   const trust=requireProtocolServerContext(secureContext);bytes=Buffer.from(encodeReviewedProtocolSoap(plan));need(bytes.length===grant.request_size&&hash(bytes)===grant.request_hash&&plan.accessKey===grant.access_key&&plan.model===grant.model&&plan.endpoint===grant.endpoint&&plan.method==='POST','RECONCILIATION_GRANT_MISMATCH');
   const url=new URL(plan.endpoint),fixed={hostname:url.hostname,path:url.pathname,contentType:plan.contentType};need(url.protocol==='https:'&&url.port===''&&url.username===''&&url.password===''&&url.search===''&&url.hash==='','RECONCILIATION_GRANT_MISMATCH');
   s=scoped(signal,Math.min(deadline,Date.parse(grant.expires_at)));s.check();for(const[k,v]of used)if(v<=Date.now())used.delete(k);need(used.size<1024&&Date.parse(grant.expires_at)<=Date.now()+60000,'RECONCILIATION_GRANT_MISMATCH');used.set(grant.attempt_id+':'+grant.nonce,Date.parse(grant.expires_at));
   const sessionAbort=()=>s.abort();sessionSignal.addEventListener('abort',sessionAbort,{once:true});if(sessionSignal.aborted)sessionAbort();
   let received;try{received=await read(requestImpl,fixed,secureContext,s,bytes,trust);}finally{sessionSignal.removeEventListener('abort',sessionAbort);}
   try{s.check();need(!sessionSignal.aborted,'RECONCILIATION_ABORTED');return Object.freeze({response:new Response(new Uint8Array(received.bytes),{status:received.status,headers:{'content-type':'application/soap+xml; charset=utf-8','content-length':String(received.bytes.length),'cache-control':'no-store'}}),tls:received.tls});}finally{received.bytes.fill(0);}
  }catch(error){if(error instanceof ReconciliationError)throw error;throw new ReconciliationError('RECONCILIATION_TRANSPORT_INVALID');}
  finally{s?.close();bytes?.fill(0);}
 };
}
