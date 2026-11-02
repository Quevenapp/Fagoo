import http from 'node:http';
import { Pool } from 'pg';
import { configuration } from './config.mjs';
import { createAuth } from './auth.mjs';
import { createApp } from './app.mjs';
import { createPrivateStorage } from './storage.mjs';
import { staticResponse } from './static.mjs';

const config=configuration(),pool=new Pool({connectionString:config.databaseUrl,max:10,connectionTimeoutMillis:5000,statement_timeout:15000});
pool.on('error',()=>console.error(JSON.stringify({component:'database',error:'IDLE_CONNECTION_FAILED'})));
const app=createApp({pool,auth:createAuth(pool,config),config,storage:createPrivateStorage()});
const server=http.createServer(async(incoming,outgoing)=>{
  try{
    if(!incoming.url?.startsWith('/')||incoming.url.startsWith('//')){outgoing.writeHead(400);return outgoing.end();}
    const chunks=[];let length=0;const requestPath=incoming.url.split('?')[0];const bodyLimit=requestPath==='/api/v1/invoices/received/import'?2*1024*1024:/^\/api\/v1\/banking\/cnab\/profiles\/[^/]+\/return-preview$/.test(requestPath)?5_400_000:1024*1024;
    for await(const chunk of incoming){length+=chunk.length;if(length>bodyLimit){outgoing.writeHead(413);outgoing.end();return;}chunks.push(chunk);}
    const headers=new Headers();for(const [name,value]of Object.entries(incoming.headers)){if(Array.isArray(value)){for(const item of value)headers.append(name,item);}else if(value!==undefined)headers.set(name,value);}
    const request=new Request(config.publicUrl+incoming.url,{method:incoming.method,headers,...(!['GET','HEAD'].includes(incoming.method)?{body:Buffer.concat(chunks)}:{})});
    const response=(incoming.method==='GET'?await staticResponse(new URL(request.url).pathname):null)||await app(request);outgoing.statusCode=response.status;
    for(const [key,value]of response.headers){if(key!=='set-cookie')outgoing.setHeader(key,value);}
    const cookies=response.headers.getSetCookie();if(cookies.length)outgoing.setHeader('set-cookie',cookies);
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  }catch{if(!outgoing.headersSent)outgoing.writeHead(500,{'Content-Type':'application/json'});outgoing.end('{"error":"INTERNAL_ERROR"}');}
});
server.requestTimeout=30000;server.headersTimeout=15000;
server.listen(config.port,'0.0.0.0',()=>console.log(`FAGOO API listening on port ${config.port}`));
for(const event of ['SIGTERM','SIGINT'])process.on(event,()=>{server.close(async()=>{await pool.end();process.exit(0);});setTimeout(()=>process.exit(1),10000).unref();});
