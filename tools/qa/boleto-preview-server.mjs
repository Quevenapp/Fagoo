/** Synthetic GET-only loopback QA. No database, credentials, persistent state or outbound fetch. */
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {boletoFixture} from '../../workers/erp-api/test/helpers/boleto-preview-fixture.mjs';
export const BOLETO_QA_ORIGIN='http://127.0.0.1:9016';
const FRONTEND='http://127.0.0.1:5173';
export async function createBoletoQaHandler(){
 const fixtures=new Map(await Promise.all(['homologation','operational'].map(async purpose=>[purpose,await boletoFixture(purpose)])));
 return async request=>{
  const url=new URL(request.url),origin=request.headers.get('origin');
  const headers={'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff',...(origin===FRONTEND?{'access-control-allow-origin':FRONTEND,Vary:'Origin'}:{})};
  const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers});
  if(url.origin!==BOLETO_QA_ORIGIN||url.search||url.hash||origin&&origin!==FRONTEND)return json({error:'LOCAL_QA_ONLY'},403);
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{...headers,'access-control-allow-methods':'GET','access-control-allow-headers':'accept'}});
  if(request.method!=='GET')return json({error:'QA_GET_ONLY'},405);
  if(url.pathname==='/fixtures')return json({profile:'synthetic-itau-boleto-qa-v1',fixtures:[...fixtures.values()].map(f=>({purpose:f.purpose,file:f.file}))});
  const match=/^\/(homologation|operational)(\/v1\/boletos-itau\/[^?]+)$/.exec(url.pathname),f=match&&fixtures.get(match[1]);
  if(f&&match[2]===`/v1/boletos-itau/remittances/${f.file.id}/items`)return json(f.items);
  if(f&&match[2]===`/v1/boletos-itau/${f.billing}/preview`)return json(f.response);
  return json({error:'QA_NOT_FOUND'},404);
 };
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 const handler=await createBoletoQaHandler();
 const server=createServer(async(req,res)=>{
  try{
   if(req.headers.host!=='127.0.0.1:9016'){res.writeHead(403);res.end();return;}
   const result=await handler(new Request(new URL(req.url,BOLETO_QA_ORIGIN),{method:req.method,headers:req.headers}));
   res.writeHead(result.status,Object.fromEntries(result.headers));res.end(Buffer.from(await result.arrayBuffer()));
  }catch{res.writeHead(500,{'content-type':'application/json','cache-control':'no-store'});res.end('{"error":"SYNTHETIC_QA_FAILED"}');}
 });
 server.requestTimeout=10000;server.headersTimeout=10000;
 server.listen(9016,'127.0.0.1',()=>process.stdout.write('Synthetic boleto QA only: http://127.0.0.1:9016\n'));
}
