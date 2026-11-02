import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
export function createPrivateStorage(env=process.env) {
 const endpoint=env.FAGOO_R2_ENDPOINT,bucket=env.FAGOO_R2_BUCKET,keyId=env.FAGOO_R2_ACCESS_KEY_ID,secret=env.FAGOO_R2_SECRET_ACCESS_KEY;
 if(!endpoint&&!bucket&&!keyId&&!secret)return null;
 if(!endpoint||!bucket||!keyId||!secret)throw new Error('Incomplete R2 configuration');
 const url=new URL(endpoint);if(url.protocol!=='https:'||url.username||url.password)throw new Error('R2 endpoint must use HTTPS');
 const client=new S3Client({region:'auto',endpoint,maxAttempts:2,credentials:{accessKeyId:keyId,secretAccessKey:secret}});
 const send=command=>client.send(command,{abortSignal:AbortSignal.timeout(15000)});
 const valid=key=>{if(typeof key!=='string'||!/^companies\/[0-9a-f-]{36}\/received-invoices\/[0-9a-f]{64}\.xml$/.test(key))throw new Error('Invalid private object key');};
 return {
  async put(key,bytes,{contentType='application/xml',sha256}={}){valid(key);if(!/^[a-f0-9]{64}$/.test(sha256||''))throw new Error('Digest required');try{await send(new PutObjectCommand({Bucket:bucket,Key:key,Body:bytes,ContentType:contentType,Metadata:{sha256},IfNoneMatch:'*'}));}catch(error){if(error.$metadata?.httpStatusCode!==412)throw error;const existing=await send(new HeadObjectCommand({Bucket:bucket,Key:key}));if(existing.Metadata?.sha256!==sha256)throw new Error('Object digest conflict');}return{key,sha256};},
  async get(key){
   valid(key);const result=await send(new GetObjectCommand({Bucket:bucket,Key:key}));
   const stream=result.Body;const timer=setTimeout(()=>stream.destroy(new Error('Private storage read timed out')),15000);timer.unref();
   try{
    if(result.ContentLength>8*1024*1024)throw new Error('Object too large');
    let length=0;const chunks=[];
    for await(const chunk of stream){length+=chunk.length;if(length>8*1024*1024)throw new Error('Object too large');chunks.push(chunk);}
    return Buffer.concat(chunks,length);
   }finally{clearTimeout(timer);stream.destroy();}
  }
 };
}
