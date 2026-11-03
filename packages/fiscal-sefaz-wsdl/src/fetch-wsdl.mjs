import {Agent} from 'node:https';
import {SecureContext,checkServerIdentity} from 'node:tls';
import {need,fields,hash,requirePlan,scope,WSDL_FLAGS,WSDL_LIMITS,WsdlEvidenceError} from './profile.mjs';
import {inspectWsdl} from './inspect-wsdl.mjs';
const close=v=>{try{v?.destroy?.();}catch{/* Driver cleanup never leaks its error. */}};

function read(requestImpl,plan,secureContext,s){
 need(secureContext instanceof SecureContext,'WSDL_TLS_CONTEXT_REQUIRED');s.check();
 const agent=new Agent({keepAlive:false,maxCachedSessions:0,maxSockets:1,proxyEnv:{}});
 return new Promise((resolve,reject)=>{
  let req,socket,response,tls,done=false,written=false,ended=false,used=0;const chunks=[];
  const finish=(code,result)=>{if(done)return;done=true;s.signal.removeEventListener('abort',abort);close(req);close(response);close(socket);close(agent);for(const c of chunks)c.fill(0);code?reject(new WsdlEvidenceError(code)):resolve(result);};
  const abort=()=>{let code='WSDL_ABORTED';try{s.check();}catch(e){code=e.code;}finish(code);};
  const onResponse=res=>{
   if(done){res?.on?.('error',()=>{});close(res);return;}response=res;
   if(!res||typeof res.on!=='function'||typeof res.destroy!=='function'){finish('WSDL_DRIVER_INVALID');return;}
   res.on('error',()=>finish('WSDL_RESPONSE_LOST'));res.on('aborted',()=>finish('WSDL_RESPONSE_LOST'));res.on('close',()=>{if(!ended)finish('WSDL_RESPONSE_PARTIAL');});
   if(!written){finish('WSDL_RESPONSE_BEFORE_TLS');return;}
   const raw=res.rawHeaders,headers=res.headers;
   if(!Array.isArray(raw)||raw.length%2||raw.some(x=>typeof x!=='string')||raw.reduce((n,x)=>n+Buffer.byteLength(x)+2,0)>WSDL_LIMITS.header_bytes||!headers){finish('WSDL_HEADERS_INVALID');return;}
   const observed=new Map();for(let i=0;i<raw.length;i+=2){const k=raw[i].toLowerCase();if(observed.has(k)&&['content-type','content-length','content-encoding','transfer-encoding','location'].includes(k)){finish('WSDL_HEADERS_INVALID');return;}observed.set(k,raw[i+1]);}
   for(const k of ['content-type','content-length','content-encoding','transfer-encoding'])if(headers[k]!==observed.get(k)){finish('WSDL_HEADERS_INVALID');return;}
   if(res.statusCode!==200){finish(res.statusCode>=300&&res.statusCode<400?'WSDL_REDIRECT_REJECTED':'WSDL_HTTP_REJECTED');return;}
   const type=headers['content-type'],encoding=headers['content-encoding'],length=headers['content-length'],transfer=headers['transfer-encoding'];
   if(typeof type!=='string'||!/^(?:text|application)\/xml(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(type)||encoding!==undefined&&encoding!=='identity'||length!==undefined&&(typeof length!=='string'||!/^[0-9]{1,9}$/.test(length)||Number(length)<1||Number(length)>WSDL_LIMITS.body_bytes)||transfer!==undefined&&(transfer!=='chunked'||length!==undefined)){finish('WSDL_HEADERS_INVALID');return;}
   res.on('data',part=>{if(done)return;try{s.check();}catch(e){finish(e.code);return;}if(!(part instanceof Uint8Array)||(used+=part.length)>WSDL_LIMITS.body_bytes){finish('WSDL_RESPONSE_LIMIT');return;}chunks.push(Buffer.from(part));});
   res.on('end',()=>{ended=true;if(done)return;try{s.check();}catch(e){finish(e.code);return;}if(res.complete!==true||used<1||length!==undefined&&Number(length)!==used){finish('WSDL_RESPONSE_PARTIAL');return;}const bytes=Buffer.concat(chunks,used);finish(null,{bytes,tls});});
  };
  const ready=()=>{if(done||written)return;try{s.check();}catch(e){finish(e.code);return;}
   if(socket?.encrypted!==true||socket.authorized!==true||typeof socket.getProtocol!=='function'||!['TLSv1.2','TLSv1.3'].includes(socket.getProtocol())){finish('WSDL_TLS_REJECTED');return;}
   tls=Object.freeze({protocol:socket.getProtocol(),server_identity_verified:true});written=true;try{req.end();}catch{finish('WSDL_REQUEST_FAILED');}
  };
  s.signal.addEventListener('abort',abort,{once:true});
  try{
   s.check();req=requestImpl({protocol:'https:',hostname:plan.hostname,port:443,path:plan.path,method:'GET',servername:plan.hostname,secureContext,minVersion:'TLSv1.2',maxVersion:'TLSv1.3',rejectUnauthorized:true,checkServerIdentity,ALPNProtocols:['http/1.1'],agent,maxHeaderSize:WSDL_LIMITS.header_bytes,insecureHTTPParser:false,headers:{Host:plan.hostname,Accept:'application/xml, text/xml','Accept-Encoding':'identity',Connection:'close'}},onResponse);
   if(!req||typeof req.on!=='function'||typeof req.end!=='function'||typeof req.destroy!=='function'){finish('WSDL_DRIVER_INVALID');return;}
   req.on('error',()=>finish('WSDL_CONNECTION_FAILED'));
   req.on('socket',value=>{if(done){value?.on?.('error',()=>{});close(value);return;}socket=value;
    if(!socket||typeof socket.once!=='function'||typeof socket.destroy!=='function'){finish('WSDL_DRIVER_INVALID');return;}
    socket.on('error',()=>finish('WSDL_CONNECTION_FAILED'));socket.once('secureConnect',ready);socket.once('close',()=>{if(!ended)finish('WSDL_CONNECTION_CLOSED');});
   });if(done)close(req);
  }catch(e){finish(e instanceof WsdlEvidenceError?e.code:'WSDL_CONNECTION_FAILED');}
 });
}

/** No network default or A1 integration. Both privileged dependencies are mandatory. */
export function createWsdlEvidenceClient(config){
 const {requestImpl,withAuthorizedTlsSession}=fields(config,['requestImpl','withAuthorizedTlsSession']);need(typeof requestImpl==='function'&&typeof withAuthorizedTlsSession==='function','WSDL_PORTS_REQUIRED');
 const used=new WeakSet();
 return Object.freeze({async obtain(plan,options={}){
  let s,bytes,result,closed=false,called=0,completed=false,callbackTask,abortHandler;
  try{
   requirePlan(plan);need(!used.has(plan),'WSDL_PLAN_CONSUMED');s=scope(options);s.check();used.add(plan);
   const context=Object.freeze({purpose:plan.purpose,environment:'2',model:plan.model,operation:plan.operation,request_id:plan.request_id,method:'GET',endpoint:plan.url,deadline:s.deadline});
   const stopped=new Promise((_,reject)=>{abortHandler=()=>{try{s.check();}catch(e){reject(e);}};s.signal.addEventListener('abort',abortHandler,{once:true});if(s.signal.aborted)abortHandler();});
   const execution=(async()=>{
    await withAuthorizedTlsSession(context,secureContext=>{
     called++;s.check();need(!closed&&called===1,'WSDL_TLS_CALLBACK_INVALID');
     callbackTask=(async()=>{const readback=await read(requestImpl,plan,secureContext,s);bytes=readback.bytes;s.check();need(!closed,'WSDL_TLS_CALLBACK_INVALID');const inspection=inspectWsdl(bytes,plan,{deadline:s.deadline});s.check();result=Object.freeze({private_evidence_only:true,request_id:plan.request_id,endpoint:plan.url,received_at:new Date().toISOString(),bytes,wsdl_hash:hash(bytes),size_bytes:bytes.length,inspection,tls:readback.tls,tls_verification_required:true,requires_binding_review:true,...WSDL_FLAGS});completed=true;return undefined;})();
     // Observe rejections even when an invalid injected port fails to await its callback.
     callbackTask.catch(()=>{});return callbackTask;
    },Object.freeze({signal:s.signal,deadline:s.deadline}));
    need(called===1&&completed,'WSDL_TLS_CALLBACK_NOT_AWAITED');s.check();return result;
   })();
   return await Promise.race([execution,stopped]);
  }catch(e){bytes?.fill(0);throw e instanceof WsdlEvidenceError?e:new WsdlEvidenceError('WSDL_SESSION_FAILED');}
  finally{closed=true;if(s){s.signal.removeEventListener('abort',abortHandler);s.close();}if(!completed)callbackTask?.then(()=>bytes?.fill(0),()=>bytes?.fill(0));}
 }});
}
