import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {retainedBuild} from './retained-build.mjs';
import {checkBuild} from '../qa/check-erp-build.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
try{
 const result=await retainedBuild({dist:resolve(root,'apps/erp/dist'),cache:resolve(root,'.cache/erp-assets'),check:checkBuild,
  build:output=>new Promise((yes,no)=>{
   const child=spawn(process.execPath,[resolve(root,'node_modules/vite/bin/vite.js'),'build','--config','apps/erp/vite.config.ts','--outDir',output,'--emptyOutDir'],{cwd:root,stdio:'inherit'});
   child.once('error',()=>no(new Error('ERP_VITE_BUILD_FAILED')));child.once('exit',code=>code===0?yes():no(new Error('ERP_VITE_BUILD_FAILED')));
  })});
 console.log(JSON.stringify(result));
}catch(error){
 const code=/^(?:RETENTION_[A-Z_]+|ERP_VITE_BUILD_FAILED)$/.test(error?.message??'')?error.message:'ERP_BUILD_FAILED';
 console.error(code==='RETENTION_ROLLBACK_REQUIRED'?'ERP_BUILD_FAILED: recuperação local necessária; preserve o diretório temporário e o lock.':`${code}: publicação não iniciada; confira o build e o cache local.`);process.exitCode=1;
}
