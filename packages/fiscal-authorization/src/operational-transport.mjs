/** Fixed protocol SOAP1.2 transport. Mandatory driver; no fetch/network/environment defaults. */
import {Agent} from 'node:https';
import {SecureContext,checkServerIdentity} from 'node:tls';
import {createHash} from 'node:crypto';
import {encodeReviewedAuthorizationSoap} from './authorization-soap-binding.mjs';
import {data,need,sha,AuthorizationServiceError} from './service-common.mjs';
import {context,stamp} from './service-dto.mjs';
import {reviewProof,checkLocalContext} from './operational-dto.mjs';
const close=v=>{try{v?.destroy?.();}catch{}};
const hash=b=>createHash('sha256').update(b).digest('hex');
function scoped(signal,deadline){const controller=new AbortController();let timer,code;const stop=c=>{if(code)return;code=c;controller.abort();},abort=()=>stop('AUTHORIZATION_SERVICE_ABORTED');signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();timer=setTimeout(()=>stop('AUTHORIZATION_SERVICE_TIMEOUT'),Math.max(1,deadline-Date.now()));return{signal:controller.signal,check(){if(Date.now()>=deadline)stop('AUTHORIZATION_SERVICE_TIMEOUT');if(signal.aborted)abort();need(!code,code);},abort(){stop('AUTHORIZATION_SERVICE_ABORTED');},close(){clearTimeout(timer);signal.removeEventListener('abort',abort);stop('AUTHORIZATION_SERVICE_ABORTED');}};}
function read(requestImpl,plan,secureContext,s,body,trust){
 need(secureContext instanceof SecureContext,'AUTHORIZATION_TRANSPORT_INVALID');s.check();
 const agent=new Agent({keepAlive:false,maxCachedSessions:0,maxSockets:1,proxyEnv:{}});
 return new Promise((resolve,reject)=>{
  let req,socket,response,tls,done=false,written=false,ended=false,used=0;const chunks=[];
  const finish=(code,result)=>{if(done)return;done=true;s.signal.removeEventListener('abort',abort);close(req);close(response);close(socket);close(agent);for(const c of chunks)c.fill(0);code?reject(new AuthorizationServiceError(code)):resolve(result);};
  const abort=()=>{let code='AUTHORIZATION_SERVICE_ABORTED';try{s.check();}catch(e){code=e.code;}finish(code);};
  const onResponse=res=>{
   if(done){res?.on?.('error',()=>{});close(res);return;}response=res;
   if(!res||typeof res.on!=='function'||typeof res.destroy!=='function'){finish('AUTHORIZATION_TRANSPORT_INVALID');return;}
   res.on('error',()=>finish('AUTHORIZATION_TRANSPORT_INVALID'));res.on('aborted',()=>finish('AUTHORIZATION_TRANSPORT_INVALID'));res.on('close',()=>{if(!ended)finish('AUTHORIZATION_TRANSPORT_INVALID');});
   if(!written){finish('AUTHORIZATION_TRANSPORT_INVALID');return;}
   const raw=res.rawHeaders,headers=res.headers;
   if(!Array.isArray(raw)||raw.length%2||raw.some(x=>typeof x!=='string')||raw.reduce((n,x)=>n+Buffer.byteLength(x)+2,0)>8192||!headers){finish('AUTHORIZATION_TRANSPORT_INVALID');return;}
   const observed=new Map();for(let i=0;i<raw.length;i+=2){const k=raw[i].toLowerCase();if(observed.has(k)&&['content-type','content-length','content-encoding','transfer-encoding','location'].includes(k)){finish('AUTHORIZATION_TRANSPORT_INVALID');return;}observed.set(k,raw[i+1]);}
   for(const k of ['content-type','content-length','content-encoding','transfer-encoding'])if(headers[k]!==observed.get(k)){finish('AUTHORIZATION_TRANSPORT_INVALID');return;}
   if(![200,500].includes(res.statusCode)){finish(res.statusCode>=300&&res.statusCode<400?'AUTHORIZATION_TRANSPORT_INVALID':'AUTHORIZATION_TRANSPORT_INVALID');return;}
   const type=headers['content-type'],encoding=headers['content-encoding'],length=headers['content-length'],transfer=headers['transfer-encoding'];
   if(typeof type!=='string'||!/^application\/soap\+xml(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(type)||encoding!==undefined&&encoding!=='identity'||length!==undefined&&(typeof length!=='string'||!/^[0-9]{1,9}$/.test(length)||Number(length)<1||Number(length)>512000)||transfer!==undefined&&(transfer!=='chunked'||length!==undefined)){finish('AUTHORIZATION_TRANSPORT_INVALID');return;}
   res.on('data',part=>{if(done)return;try{s.check();}catch(e){finish(e.code);return;}if(!(part instanceof Uint8Array)||part.length===0||(used+=part.length)>512000){finish('AUTHORIZATION_TRANSPORT_INVALID');return;}chunks.push(Buffer.from(part));});
   res.on('end',()=>{ended=true;if(done)return;try{s.check();}catch(e){finish(e.code);return;}if(res.complete!==true||used<1||length!==undefined&&Number(length)!==used){finish('AUTHORIZATION_TRANSPORT_INVALID');return;}const bytes=Buffer.concat(chunks,used);finish(null,{bytes,tls,status:res.statusCode});});
  };
  const ready=()=>{if(done||written)return;try{s.check();}catch(e){finish(e.code);return;}
   if(socket?.encrypted!==true||socket.authorized!==true||typeof socket.getProtocol!=='function'||!['TLSv1.2','TLSv1.3'].includes(socket.getProtocol())){finish('AUTHORIZATION_TRANSPORT_INVALID');return;}
   tls=Object.freeze({origin:'synthetic',protocol:socket.getProtocol(),server_identity_verified:true,...trust});written=true;try{req.end(body);}catch{finish('AUTHORIZATION_TRANSPORT_INVALID');}
  };
  s.signal.addEventListener('abort',abort,{once:true});
  try{
   s.check();req=requestImpl({protocol:'https:',hostname:plan.hostname,port:443,path:plan.path,method:'POST',servername:plan.hostname,secureContext,minVersion:'TLSv1.2',maxVersion:'TLSv1.3',rejectUnauthorized:true,checkServerIdentity,ALPNProtocols:['http/1.1'],agent,maxHeaderSize:8192,insecureHTTPParser:false,headers:{Host:plan.hostname,Accept:'application/soap+xml','Content-Type':plan.contentType,'Content-Length':String(body.length),'Accept-Encoding':'identity',Connection:'close'}},onResponse);
   if(!req||typeof req.on!=='function'||typeof req.end!=='function'||typeof req.destroy!=='function'){finish('AUTHORIZATION_TRANSPORT_INVALID');return;}
   req.on('error',()=>finish('AUTHORIZATION_TRANSPORT_INVALID'));
   req.on('socket',value=>{if(done){value?.on?.('error',()=>{});close(value);return;}socket=value;
    if(!socket||typeof socket.once!=='function'||typeof socket.destroy!=='function'){finish('AUTHORIZATION_TRANSPORT_INVALID');return;}
    socket.on('error',()=>finish('AUTHORIZATION_TRANSPORT_INVALID'));socket.once('secureConnect',ready);socket.once('close',()=>{if(!ended)finish('AUTHORIZATION_TRANSPORT_INVALID');});
   });if(done)close(req);
  }catch(e){finish(e instanceof AuthorizationServiceError?e.code:'AUTHORIZATION_TRANSPORT_INVALID');}
 });
}

/** Mandatory private driver and trust attestor; this local entrypoint accepts synthetic grants only. */
export function createReviewedAuthorizationTransport(configuration){
 const p=data(configuration,['requestImpl','attestServerContext','serverTrustAnchorSha256']);need(typeof p.requestImpl==='function'&&typeof p.attestServerContext==='function'&&sha(p.serverTrustAnchorSha256),'AUTHORIZATION_TRANSPORT_INVALID');
 const requestImpl=p.requestImpl,attest=p.attestServerContext,anchor=p.serverTrustAnchorSha256,used=new Map();
 return async function transport(input,session,options){let bytes,s;
  try{
   const v=data(input,['request','grant','rule_review']),ss=data(session,['secureContext','metadata','signal','deadline']),o=data(options,['signal','deadline']);
   const plan=v.request,grant=context(v.grant,{},true),secureContext=ss.secureContext,sessionSignal=ss.signal,sessionDeadline=ss.deadline,signal=o.signal,deadline=o.deadline;
   const proof=reviewProof(v.rule_review,{candidate_id:grant.candidate_id,signed_hash:grant.signed_hash});checkLocalContext(grant);
   need(signal instanceof AbortSignal&&sessionSignal instanceof AbortSignal&&!sessionSignal.aborted&&Number.isSafeInteger(deadline)&&Number.isSafeInteger(sessionDeadline)&&deadline>Date.now()&&deadline<=Date.now()+20000&&deadline<=sessionDeadline,'AUTHORIZATION_TRANSPORT_INVALID');
   need(Date.parse(grant.expires_at)>Date.now()&&Date.parse(grant.issued_at)<=Date.now()+5000&&Date.parse(proof.valid_until)>Date.now()&&secureContext instanceof SecureContext&&!used.has(grant.attempt_id+':'+grant.nonce),'AUTHORIZATION_GRANT_MISMATCH');
   const metadata=data(ss.metadata,['fingerprint_sha256','holder_cnpj','not_before','not_after','client_auth_usage','presented_chain_links_checked','icp_brasil_chain_validated','revocation_checked','a1_policy_verified','can_emit','can_transmit']);
   need(metadata.fingerprint_sha256===grant.certificate_fingerprint&&metadata.holder_cnpj===grant.issuer_cnpj&&stamp(metadata.not_before)&&stamp(metadata.not_after)&&Date.parse(metadata.not_before)<=Date.now()&&Date.parse(metadata.not_after)>=Date.now()&&['explicit_client_auth','unrestricted_absent','unrestricted_any'].includes(metadata.client_auth_usage)&&typeof metadata.presented_chain_links_checked==='boolean'&&['icp_brasil_chain_validated','revocation_checked','a1_policy_verified','can_emit','can_transmit'].every(k=>metadata[k]===false),'AUTHORIZATION_GRANT_MISMATCH');
   const trust=data(attest(secureContext),['server_trust_profile','server_trust_anchor_sha256']);need(trust.server_trust_profile==='synthetic-mtls-v1'&&trust.server_trust_anchor_sha256===anchor,'AUTHORIZATION_TRANSPORT_INVALID');
   bytes=Buffer.from(encodeReviewedAuthorizationSoap(plan));need(bytes.length===grant.request_size&&hash(bytes)===grant.request_hash&&plan.signedHash===grant.signed_hash&&plan.batchId===grant.batch_id&&plan.model===grant.model&&plan.profile===grant.binding_profile&&plan.method==='POST','AUTHORIZATION_GRANT_MISMATCH');
   const url=new URL(plan.endpoint),fixed={hostname:url.hostname,path:url.pathname,contentType:plan.contentType};need(url.protocol==='https:'&&url.port===''&&url.username===''&&url.password===''&&url.search===''&&url.hash==='','AUTHORIZATION_GRANT_MISMATCH');
   s=scoped(signal,Math.min(deadline,Date.parse(grant.expires_at),Date.parse(proof.valid_until)));s.check();for(const[k,v]of used)if(v<=Date.now())used.delete(k);need(used.size<1024&&Date.parse(grant.expires_at)<=Date.now()+60000,'AUTHORIZATION_GRANT_MISMATCH');used.set(grant.attempt_id+':'+grant.nonce,Date.parse(grant.expires_at));
   const sessionAbort=()=>s.abort();sessionSignal.addEventListener('abort',sessionAbort,{once:true});if(sessionSignal.aborted)sessionAbort();
   let received;try{received=await read(requestImpl,fixed,secureContext,s,bytes,trust);}finally{sessionSignal.removeEventListener('abort',sessionAbort);}
   try{s.check();need(!sessionSignal.aborted,'AUTHORIZATION_SERVICE_ABORTED');return Object.freeze({response:new Response(new Uint8Array(received.bytes),{status:received.status,headers:{'content-type':'application/soap+xml; charset=utf-8','content-length':String(received.bytes.length),'cache-control':'no-store'}}),tls:received.tls});}finally{received.bytes.fill(0);}
  }catch(error){if(error instanceof AuthorizationServiceError)throw error;throw new AuthorizationServiceError('AUTHORIZATION_TRANSPORT_INVALID');}
  finally{s?.close();bytes?.fill(0);}
 };
}
