/** Checks only built artifacts; diagnostics never include matching bytes or secret values. */
import {readFile,readdir} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve,relative,basename} from 'node:path';
const root=fileURLToPath(new URL('../../',import.meta.url));
const markers=['QA_SYNTHETIC_','QA_LOGIN_DISABLED','qa-synthetic-token','QA_PRIVATE_INTERNAL_NOTE','SYNTHETIC_QA_MODULE_LOAD_FAILURE','http://127.0.0.1:9011','LOCAL_QA_ONLY','BRUFAP_A1_SYNTHETIC_QA_ONLY','A1_QA_LOCAL_ONLY','senha-de-teste'];
const secretKeys=/secret|password|access.?token|refresh.?token|service.?role.?key|encryption.?key|admin.?token|^(?:transport|fingerprint|kek)$|kek_ring_json/i;
export function privateValues(value,key=''){
 if(typeof value==='string')return secretKeys.test(key)&&value.length>=12?[value]:[];
 if(!value||typeof value!=='object')return[];
 return Object.entries(value).flatMap(([name,v])=>privateValues(v,name));
}
export function inspectBuildFile(name,bytes,secrets=[]){
 const failures=[];
 if(/\.map$|(?:^|[\\/])\.env(?:\.|$)|\.(?:pem|key)$|(?:^|[\\/])(?:qa|review)\.html$/i.test(name))failures.push('forbidden_file');
 const contents=Buffer.from(bytes).toString('utf8');
 if(markers.some(marker=>contents.includes(marker)))failures.push('qa_marker');
 if(['brufap.erp.demo.','Restaurar dados de demonstração','Prévia de layout · dados de demonstração','Conhecer a prévia com dados fictícios','Demonstração do layout'].some(marker=>contents.includes(marker)))failures.push('unsupported_entry');
 if(secrets.some(secret=>typeof secret==='string'&&secret.length>=12&&contents.includes(secret)))failures.push('private_value');
 return{file:name,failures};
}
export async function checkBuild(directory=resolve(root,'apps/erp/dist')){
 const secrets=[];let loaded=0;
 for(const file of ['worker-secrets.json','erp-api-secrets.json','origin-app.json','origin-upload.json']){
  try{secrets.push(...privateValues(JSON.parse(await readFile(resolve(root,'private/integration',file),'utf8'))));loaded++;}
  catch(error){if(error.code!=='ENOENT')throw new Error('PRIVATE_CONFIGURATION_UNREADABLE');}
 }
 for(const file of ['a1-keys.json','a1-executor-secrets.json','a1-gateway-secrets.json']){
  try{secrets.push(...privateValues(JSON.parse(await readFile(resolve(root,'private/fiscal',file),'utf8'))));loaded++;}
  catch(error){if(error.code!=='ENOENT')throw new Error('PRIVATE_CONFIGURATION_UNREADABLE');}
 }
 try{const value=(await readFile(resolve(root,'private/integration/backup-service-key.txt'),'utf8')).trim();if(value.length>=12)secrets.push(value);loaded++;}catch(error){if(error.code!=='ENOENT')throw new Error('PRIVATE_CONFIGURATION_UNREADABLE');}
 const files=[];
 async function walk(dir){for(const entry of await readdir(dir,{withFileTypes:true})){const path=resolve(dir,entry.name);if(entry.isSymbolicLink())throw new Error('BUILD_SYMLINK_REJECTED');if(entry.isDirectory())await walk(path);else if(entry.isFile())files.push(path);}}
 await walk(directory);if(!files.length||!files.some(path=>basename(path)==='index.html'))throw new Error('BUILD_ENTRY_MISSING');
 const reports=await Promise.all(files.map(async path=>inspectBuildFile(relative(directory,path),await readFile(path),secrets)));
 return{passed:reports.every(r=>r.failures.length===0),checked_files:files.length,private_configurations_checked:loaded,findings:reports.filter(r=>r.failures.length)};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 try{const result=await checkBuild();console.log(JSON.stringify(result,null,2));if(!result.passed)process.exitCode=1;}
 catch{console.error(JSON.stringify({passed:false,error:'BUILD_CHECK_FAILED'}));process.exitCode=1;}
}
