import http from 'node:http';
import { readFile } from 'node:fs/promises';
export async function updaterRequest(config,path,body) {
  const token=(await readFile(config.updaterTokenFile,'utf8')).trim();
  const payload=body===undefined?null:JSON.stringify(body);
  return new Promise((resolve,reject)=>{
    const request=http.request({socketPath:config.updaterSocket,path,method:payload?'POST':'GET',headers:{Authorization:`Bearer ${token}`,...(payload?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}:{})},timeout:30000},response=>{
      let data='';response.setEncoding('utf8');response.on('data',chunk=>{data+=chunk;if(data.length>1024*1024)request.destroy(new Error('Updater response too large'));});
      response.on('end',()=>{try{const result=JSON.parse(data);if(response.statusCode>=400){const error=new Error('Update service rejected the request');error.status=response.statusCode;reject(error);}else resolve(result);}catch(error){reject(error);}});
    });request.on('error',reject);request.on('timeout',()=>request.destroy(new Error('Updater timeout')));request.end(payload);
  });
}
