import { readFile,stat } from 'node:fs/promises';
import { resolve,sep,extname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(process.env.FAGOO_WEB_DIR||fileURLToPath(new URL('../../web/dist/',import.meta.url)));
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.json':'application/json','.woff2':'font/woff2'};
export async function staticResponse(path){
 if(path.startsWith('/api')||path.startsWith('/.well-known')||path.startsWith('/health'))return null;
 let decoded;try{decoded=decodeURIComponent(path);}catch{return new Response(null,{status:400});}
 const target=resolve(root,'.'+decoded);if(target!==root&&!target.startsWith(root+sep))return new Response(null,{status:404});
 let file=target;try{if(!(await stat(file)).isFile())file=resolve(root,'index.html');}catch{if(extname(path))return new Response(null,{status:404});file=resolve(root,'index.html');}
 try{return new Response(await readFile(file),{headers:{'Content-Type':mime[extname(file)]||'application/octet-stream','Cache-Control':extname(file)==='.html'?'no-store':'public, max-age=3600','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'same-origin'}});}catch{return null;}
}
