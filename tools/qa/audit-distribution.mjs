import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir,readdir,stat} from 'node:fs/promises';
import {resolve,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../../',import.meta.url)),out=resolve(root,'docs/legal');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const safeRead=async p=>{try{return await readFile(p);}catch{return null;}};
const files=[...new Set(execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean))].sort();
const locks=files.filter(p=>p.endsWith('package-lock.json'));
const packages=[],notices=[],missingTexts=[];
for(const lockfile of locks){
 const lock=JSON.parse(await readFile(resolve(root,lockfile),'utf8'));
 for(const [location,data] of Object.entries(lock.packages??{})){
  if(!location||data.link)continue;
  const directory=resolve(root,dirname(lockfile),location),raw=await safeRead(resolve(directory,'package.json'));
  const installed=raw?JSON.parse(raw):null;
  const name=data.name??location.split('node_modules/').at(-1),license=data.license??installed?.license??'UNKNOWN';
  const entry={lockfile,location,name,version:data.version,license,developmentOnly:Boolean(data.dev),optional:Boolean(data.optional),integrity:data.integrity??null,installedVersion:installed?.version??null,noticeFiles:[]};
  if(installed?.version===data.version){
   const names=await readdir(directory);
   for(const file of names.filter(f=>/^(?:licen[cs]e|copying|notice)(?:$|[.-])/i.test(f)).sort()){
    const full=resolve(directory,file);if(!(await stat(full)).isFile())continue;
    const bytes=await readFile(full);entry.noticeFiles.push({file,sha256:sha(bytes)});
    notices.push('='.repeat(72)+'\n'+name+'@'+data.version+' · '+lockfile+' · '+file+'\n'+'='.repeat(72)+'\n'+bytes.toString('utf8')+'\n');
   }
  }
  if(!entry.noticeFiles.length)missingTexts.push({lockfile,name,version:data.version,reason:installed?'license text not found at package root':'package not installed on this platform'});
  packages.push(entry);
 }
}
const assetPaths=files.filter(p=>/\.(?:woff2?|ttf|otf|png|jpe?g|webp|gif|svg|ico|xsd|wsdl|pem|pdf)$/i.test(p));
const assets=[];
for(const path of assetPaths){const bytes=await readFile(resolve(root,path));assets.push({path,bytes:bytes.length,sha256:sha(bytes),group:path.includes('/fonts/')?'font':/\.(xsd|wsdl)$/.test(path)?'fiscal-schema':path.includes('/trust/')?'public-trust-anchor':'image-or-document'});}
await mkdir(out,{recursive:true});
const byLicense={};for(const p of packages)byLicense[typeof p.license==='string'?p.license:JSON.stringify(p.license)]=(byLicense[typeof p.license==='string'?p.license:JSON.stringify(p.license)]??0)+1;
const inventory={format:1,method:'All lockfile entries, including build tools and optional packages. License fields are declared metadata, not a compatibility opinion.',lockfiles:locks,packages,summary:{entries:packages.length,uniquePackages:new Set(packages.map(p=>p.name+'@'+p.version)).size,byLicense,unknown:packages.filter(p=>p.license==='UNKNOWN').map(p=>({name:p.name,version:p.version,lockfile:p.lockfile})),missingTexts}};
await writeFile(resolve(out,'dependency-inventory.json'),JSON.stringify(inventory,null,2)+'\n');
await writeFile(resolve(out,'asset-inventory.json'),JSON.stringify({format:1,assets},null,2)+'\n');
await writeFile(resolve(out,'npm-license-texts.txt'),notices.join('\n'));
console.log(JSON.stringify({lockfiles:locks,entries:packages.length,uniquePackages:inventory.summary.uniquePackages,byLicense,unknown:inventory.summary.unknown,missingNoticeTexts:missingTexts.length,assets:assets.length}));
