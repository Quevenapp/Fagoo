const MAX=8*1024*1024,BUCKET='origin-fiscal-xml';
const digest=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
export class XmlStorage {
 constructor(repo){this.base=repo.base;this.key=repo.key;this.fetch=repo.fetch;}
 async ensure({hash,size,bytes},{deadline=Date.now()+15000,signal}={}){
  const checkTime=()=>{if(typeof deadline!=='number'||!Number.isFinite(deadline)||Date.now()>=deadline)throw new Error('XML_STORAGE_TIMEOUT');};
  checkTime();if(signal?.aborted)throw new Error('XML_STORAGE_ABORTED');
  if(!/^[a-f0-9]{64}$/.test(hash)||!(bytes instanceof Uint8Array)||bytes.length!==size||size<1||size>MAX||await digest(bytes)!==hash)throw new Error('XML_STORAGE_INPUT_INVALID');
  const url=`${this.base}/storage/v1/object/${BUCKET}/objects/${hash}.xml`,controller=new AbortController();
  const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)controller.abort();
  let timer;const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('XML_STORAGE_TIMEOUT'));},Math.max(1,deadline-Date.now()));});
  const headers={apikey:this.key,Authorization:`Bearer ${this.key}`};
  const request=async(method,requestUrl,extra={})=>{checkTime();if(controller.signal.aborted)throw new Error('XML_STORAGE_ABORTED');const response=await this.fetch(requestUrl,{...extra,method,redirect:'manual',signal:controller.signal,headers:{...headers,...extra.headers}});
   if(response.redirected||(response.status>=300&&response.status<400)){await response.body?.cancel();throw new Error('XML_STORAGE_REDIRECT_BLOCKED');}return response;};
  const verify=async()=>{
   const response=await request('GET',url.replace('/object/','/object/authenticated/'));
   if(!response.ok||!response.body){await response.body?.cancel();throw new Error('XML_STORAGE_READ_FAILED');}
   const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)!==size)){await response.body.cancel();throw new Error('XML_STORAGE_SIZE_MISMATCH');}
   const reader=response.body.getReader(),stored=new Uint8Array(size);let offset=0;
   try{for(;;){const{done,value}=await reader.read();if(controller.signal.aborted)throw new Error('XML_STORAGE_ABORTED');if(done)break;if(offset+value.length>size)throw new Error('XML_STORAGE_SIZE_MISMATCH');stored.set(value,offset);offset+=value.length;}}
   finally{try{await reader.cancel();}catch{}reader.releaseLock();}
   if(offset!==size||await digest(stored)!==hash)throw new Error('XML_STORAGE_INTEGRITY_FAILURE');
  };
  try{await Promise.race([(async()=>{
    let response;try{response=await request('POST',url,{headers:{...headers,'Content-Type':'application/xml','x-upsert':'false'},body:bytes});}
    catch(error){if(controller.signal.aborted||error.message==='XML_STORAGE_REDIRECT_BLOCKED')throw error;/* Unknown upload result is recovered by reading the immutable path. */}
    if(response){const accepted=response.ok||[400,409].includes(response.status);await response.body?.cancel();if(!accepted)throw new Error('XML_STORAGE_UPLOAD_FAILED');}
    await verify();
   })(),timeout]);}
  finally{clearTimeout(timer);controller.abort();signal?.removeEventListener('abort',abort);}
 }
}
