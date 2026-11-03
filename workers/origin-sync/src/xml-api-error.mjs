/** Return a fixed diagnostic code only. Never retain or expose provider text. */
export async function xmlApiErrorCode(response, signal) {
 const generic='ORIGIN_HTTP_ERROR';
 if(response.status!==400)return generic;
 const type=response.headers.get('content-type')||'';
 const max=16384;
 if(!/^application\/json(?:\s*;|$)/i.test(type)||Number(response.headers.get('content-length'))>max||!response.body){await response.body?.cancel().catch(()=>{});return generic;}
 const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let text='',bytes=0;
 const abort=()=>{void reader.cancel().catch(()=>{});};
 signal.addEventListener('abort',abort,{once:true});
 try{
  if(signal.aborted)return generic;
  for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>max)return generic;text+=decoder.decode(value,{stream:true});}
  if(signal.aborted)return generic;
  const payload=JSON.parse(text+decoder.decode());
  const error=payload?.error,fields=error?.fields;
  if(payload&&typeof payload==='object'&&!Array.isArray(payload)&&!Object.hasOwn(payload,'data')&&error?.type==='VALIDATION_ERROR'
   &&Array.isArray(fields)&&fields.length===1&&fields[0]?.code===38&&fields[0]?.namespace==='NOTA_FISCAL')return 'ORIGIN_XML_DOCUMENT_UNAVAILABLE';
  return generic;
 }catch{return generic;}
 finally{signal.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});reader.releaseLock();}
}
