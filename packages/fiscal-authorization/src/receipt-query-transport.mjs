/** Fixed receipt-query089 SOAP1.2 transport. Mandatory driver; no fetch/network/environment defaults. */
import {Agent} from 'node:https';
import {SecureContext,checkServerIdentity} from 'node:tls';
import {createHash} from 'node:crypto';
import {encodeReviewedReceiptSoap} from './receipt-soap-binding.mjs';
import {data,need,sha,AuthorizationServiceError} from './service-common.mjs';
import {stamp} from './service-dto.mjs';
import {receiptQueryGrant,RECEIPT_QUERY_LEDGER_FLAGS} from './receipt-query-ledger-dto.mjs';
import {requireReceiptQueryServerContext,SP_RECEIPT_QUERY_SERVER_TRUST,SP_RECEIPT_QUERY_ROOT_HASH} from './receipt-query-server-trust.mjs';
const close=v=>{try{v?.destroy?.();}catch{}};
const hash=b=>createHash('sha256').update(b).digest('hex');
function scoped(signal,deadline){const controller=new AbortController();let timer,code;const stop=c=>{if(code)return;code=c;controller.abort();},abort=()=>stop('AUTHORIZATION_SERVICE_ABORTED');signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();timer=setTimeout(()=>stop('AUTHORIZATION_SERVICE_TIMEOUT'),Math.max(1,deadline-Date.now()));return{signal:controller.signal,check(){if(Date.now()>=deadline)stop('AUTHORIZATION_SERVICE_TIMEOUT');if(signal.aborted)abort();need(!code,code);},abort(){stop('AUTHORIZATION_SERVICE_ABORTED');},close(){clearTimeout(timer);signal.removeEventListener('abort',abort);stop('AUTHORIZATION_SERVICE_ABORTED');}};}
function read(requestImpl,plan,secureContext,s,body,trust,checkWindow){
 need(secureContext instanceof SecureContext,'RECEIPT_QUERY_TRANSPORT_INVALID');s.check();
 const agent=new Agent({keepAlive:false,maxCachedSessions:0,maxSockets:1,proxyEnv:{}});
 return new Promise((resolve,reject)=>{
  let req,socket,response,tls,done=false,written=false,ended=false,used=0;const chunks=[];
  const finish=(code,result)=>{if(done)return;done=true;s.signal.removeEventListener('abort',abort);close(req);close(response);close(socket);close(agent);for(const c of chunks)c.fill(0);code?reject(new AuthorizationServiceError(code)):resolve(result);};
  const abort=()=>{let code='AUTHORIZATION_SERVICE_ABORTED';try{s.check();}catch(e){code=e.code;}finish(code);};
  const onResponse=res=>{
   if(done){res?.on?.('error',()=>{});close(res);return;}response=res;
   if(!res||typeof res.on!=='function'||typeof res.destroy!=='function'){finish('RECEIPT_QUERY_TRANSPORT_INVALID');return;}
   res.on('error',()=>finish('RECEIPT_QUERY_TRANSPORT_INVALID'));res.on('aborted',()=>finish('RECEIPT_QUERY_TRANSPORT_INVALID'));res.on('close',()=>{if(!ended)finish('RECEIPT_QUERY_TRANSPORT_INVALID');});
   if(!written){finish('RECEIPT_QUERY_TRANSPORT_INVALID');return;}
   const raw=res.rawHeaders,headers=res.headers;
   if(!Array.isArray(raw)||raw.length%2||raw.some(x=>typeof x!=='string')||raw.reduce((n,x)=>n+Buffer.byteLength(x)+2,0)>8192||!headers){finish('RECEIPT_QUERY_TRANSPORT_INVALID');return;}
   const observed=new Map();for(let i=0;i<raw.length;i+=2){const k=raw[i].toLowerCase();if(observed.has(k)&&['content-type','content-length','content-encoding','transfer-encoding','location'].includes(k)){finish('RECEIPT_QUERY_TRANSPORT_INVALID');return;}observed.set(k,raw[i+1]);}
   for(const k of ['content-type','content-length','content-encoding','transfer-encoding'])if(headers[k]!==observed.get(k)){finish('RECEIPT_QUERY_TRANSPORT_INVALID');return;}
   if(![200,500].includes(res.statusCode)){finish(res.statusCode>=300&&res.statusCode<400?'RECEIPT_QUERY_TRANSPORT_INVALID':'RECEIPT_QUERY_TRANSPORT_INVALID');return;}
   const type=headers['content-type'],encoding=headers['content-encoding'],length=headers['content-length'],transfer=headers['transfer-encoding'];
   if(typeof type!=='string'||!/^application\/soap\+xml(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(type)||encoding!==undefined&&encoding!=='identity'||length!==undefined&&(typeof length!=='string'||!/^[0-9]{1,9}$/.test(length)||Number(length)<1||Number(length)>512000)||transfer!==undefined&&(transfer!=='chunked'||length!==undefined)){finish('RECEIPT_QUERY_TRANSPORT_INVALID');return;}
   res.on('data',part=>{if(done)return;try{s.check();}catch(e){finish(e.code);return;}if(!(part instanceof Uint8Array)||part.length===0||(used+=part.length)>512000){finish('RECEIPT_QUERY_TRANSPORT_INVALID');return;}chunks.push(Buffer.from(part));});
   res.on('end',()=>{ended=true;if(done)return;try{s.check();}catch(e){finish(e.code);return;}if(res.complete!==true||used<1||length!==undefined&&Number(length)!==used){finish('RECEIPT_QUERY_TRANSPORT_INVALID');return;}const bytes=Buffer.concat(chunks,used);finish(null,{bytes,tls,status:res.statusCode});});
  };
  const ready=()=>{if(done||written)return;try{s.check();}catch(e){finish(e.code);return;}
   if(socket?.encrypted!==true||socket.authorized!==true||typeof socket.getProtocol!=='function'||!['TLSv1.2','TLSv1.3'].includes(socket.getProtocol())){finish('RECEIPT_QUERY_TRANSPORT_INVALID');return;}
   tls=Object.freeze({origin:'operational',protocol:socket.getProtocol(),server_identity_verified:true,...trust});
   try{checkWindow();written=true;req.end(body);}catch(e){finish(e instanceof AuthorizationServiceError?e.code:'RECEIPT_QUERY_TRANSPORT_INVALID');}
  };
  s.signal.addEventListener('abort',abort,{once:true});
  try{
   s.check();checkWindow();req=requestImpl({protocol:'https:',hostname:plan.hostname,port:443,path:plan.path,method:'POST',servername:plan.hostname,secureContext,minVersion:'TLSv1.2',maxVersion:'TLSv1.3',rejectUnauthorized:true,checkServerIdentity,ALPNProtocols:['http/1.1'],agent,maxHeaderSize:8192,insecureHTTPParser:false,headers:{Host:plan.hostname,Accept:'application/soap+xml','Content-Type':plan.contentType,'Content-Length':String(body.length),'Accept-Encoding':'identity',Connection:'close'}},onResponse);
   if(!req||typeof req.on!=='function'||typeof req.end!=='function'||typeof req.destroy!=='function'){finish('RECEIPT_QUERY_TRANSPORT_INVALID');return;}
   req.on('error',()=>finish('RECEIPT_QUERY_TRANSPORT_INVALID'));
   req.on('socket',value=>{if(done){value?.on?.('error',()=>{});close(value);return;}socket=value;
    if(!socket||typeof socket.once!=='function'||typeof socket.destroy!=='function'){finish('RECEIPT_QUERY_TRANSPORT_INVALID');return;}
    socket.on('error',()=>finish('RECEIPT_QUERY_TRANSPORT_INVALID'));socket.once('secureConnect',ready);socket.once('close',()=>{if(!ended)finish('RECEIPT_QUERY_TRANSPORT_INVALID');});
   });if(done)close(req);
  }catch(e){finish(e instanceof AuthorizationServiceError?e.code:'RECEIPT_QUERY_TRANSPORT_INVALID');}
 });
}

/** Dedicated consReciNFe transport. It cannot encode an authorization request.
 * A literal successful use089 envelope is mandatory; no RPC or custody defaults.
 */
export function createReceiptQueryTransport(configuration){
 const p=data(configuration,['requestImpl']);need(typeof p.requestImpl==='function','RECEIPT_QUERY_TRANSPORT_INVALID');
 const requestImpl=p.requestImpl,used=new Map();
 return async(input,session,options)=>{let bytes,s;
  try{
   const v=data(input,['request','used']),ss=data(session,['secureContext','metadata','signal','deadline']),o=data(options,['signal','deadline']);
   const u=data(v.used,['grant','private_executor_only',...Object.keys(RECEIPT_QUERY_LEDGER_FLAGS)]),g=data(u.grant,[],Object.keys(u.grant));
   const checked=receiptQueryGrant(u,{p_user_id:g.actor,p_query_id:g.query_id,p_lease_id:g.lease_id}),grant=checked.grant,plan=v.request;
   const secureContext=ss.secureContext,sessionSignal=ss.signal,sessionDeadline=ss.deadline,signal=o.signal,deadline=o.deadline;
   need(signal instanceof AbortSignal&&sessionSignal instanceof AbortSignal&&!sessionSignal.aborted&&Number.isSafeInteger(deadline)&&Number.isSafeInteger(sessionDeadline)&&deadline>Date.now()&&deadline<=Date.now()+20000&&deadline<=sessionDeadline,'RECEIPT_QUERY_TRANSPORT_INVALID');
   const key=grant.query_id+':'+grant.nonce;
   need(Date.parse(grant.expires_at)>Date.now()&&Date.parse(grant.expires_at)<=Date.now()+60000&&Date.parse(grant.issued_at)<=Date.now()+5000&&secureContext instanceof SecureContext&&!used.has(key),'RECEIPT_QUERY_GRANT_MISMATCH');
   const metadata=data(ss.metadata,['fingerprint_sha256','holder_cnpj','not_before','not_after','client_auth_usage','presented_chain_links_checked','icp_brasil_chain_validated','revocation_checked','a1_policy_verified','can_emit','can_transmit']);
   need(metadata.fingerprint_sha256===grant.certificate_fingerprint&&metadata.holder_cnpj===grant.issuer_cnpj&&stamp(metadata.not_before)&&stamp(metadata.not_after)&&Date.parse(metadata.not_before)<=Date.now()&&Date.parse(metadata.not_after)>=Date.now()&&['explicit_client_auth','unrestricted_absent','unrestricted_any'].includes(metadata.client_auth_usage)&&typeof metadata.presented_chain_links_checked==='boolean'&&['icp_brasil_chain_validated','revocation_checked','a1_policy_verified','can_emit','can_transmit'].every(k=>metadata[k]===false),'RECEIPT_QUERY_GRANT_MISMATCH');
   const trust=data(requireReceiptQueryServerContext(secureContext,grant.certificate_fingerprint),['server_trust_profile','server_trust_anchor_sha256']);
   need(trust.server_trust_profile===SP_RECEIPT_QUERY_SERVER_TRUST&&trust.server_trust_anchor_sha256===SP_RECEIPT_QUERY_ROOT_HASH,'RECEIPT_QUERY_TRANSPORT_INVALID');
   bytes=Buffer.from(encodeReviewedReceiptSoap(plan));
   need(bytes.length===grant.request_size&&hash(bytes)===grant.request_hash&&plan.signedHash===grant.signed_hash&&plan.model===grant.model&&plan.authorizationCommandId===grant.authorization_command_id&&plan.profile===grant.policy.binding_profile&&plan.operation==='receipt'&&plan.method==='POST','RECEIPT_QUERY_GRANT_MISMATCH');
   const url=new URL(plan.endpoint);need(url.protocol==='https:'&&url.port===''&&url.username===''&&url.password===''&&url.search===''&&url.hash==='','RECEIPT_QUERY_GRANT_MISMATCH');
   s=scoped(signal,Math.min(deadline,Date.parse(grant.expires_at)));s.check();for(const[k,v]of used)if(v<=Date.now())used.delete(k);need(used.size<1024,'RECEIPT_QUERY_GRANT_MISMATCH');used.set(key,Date.parse(grant.expires_at));
   const onAbort=()=>s.abort();sessionSignal.addEventListener('abort',onAbort,{once:true});if(sessionSignal.aborted)onAbort();
   let received;try{received=await read(requestImpl,{hostname:url.hostname,path:url.pathname,contentType:plan.contentType},secureContext,s,bytes,trust,()=>s.check());}finally{sessionSignal.removeEventListener('abort',onAbort);}
   try{s.check();need(!sessionSignal.aborted,'AUTHORIZATION_SERVICE_ABORTED');return Object.freeze({response:new Response(new Uint8Array(received.bytes),{status:received.status,headers:{'content-type':'application/soap+xml; charset=utf-8','content-length':String(received.bytes.length),'cache-control':'no-store'}}),tls:received.tls});}finally{received.bytes.fill(0);}
  }catch(e){if(e instanceof AuthorizationServiceError)throw e;throw new AuthorizationServiceError('RECEIPT_QUERY_TRANSPORT_INVALID');}
  finally{s?.close();bytes?.fill(0);}
 };
}
