// In-memory HTTPS driver. This fixture creates no socket.
import {EventEmitter} from 'node:events';
export function wire({status=200,type='application/soap+xml; charset=utf-8',encoding,partial=false,noTls=false,noBody=false,earlyResponse=false,body=Buffer.from('<synthetic-soap/>')}={}){
 const trace={requests:0,ends:0,destroyed:0,bytes:null,options:null};const destroy=e=>{e.destroy=()=>{trace.destroyed++;};return e;};
 const requestImpl=(options,callback)=>{trace.requests++;trace.options=options;const req=destroy(new EventEmitter()),socket=destroy(new EventEmitter());socket.encrypted=true;socket.authorized=true;socket.getProtocol=()=> 'TLSv1.3';
  const respond=()=>{const res=destroy(new EventEmitter());res.statusCode=status;res.complete=!partial;res.headers={'content-type':type,'content-length':String(body.length+(partial?1:0)),...(encoding?{'content-encoding':encoding}:{})};res.rawHeaders=Object.entries(res.headers).flat();callback(res);if(noBody)return;queueMicrotask(()=>{res.emit('data',Buffer.from(body));res.emit('end');});};
  req.end=bytes=>{trace.ends++;trace.bytes=Buffer.from(bytes);respond();};queueMicrotask(()=>{req.emit('socket',socket);if(earlyResponse)respond();if(!noTls)socket.emit('secureConnect');});return req;
 };return{requestImpl,trace};
}
