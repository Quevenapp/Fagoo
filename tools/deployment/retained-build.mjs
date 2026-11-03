/** Local build history. Never retains HTML, configuration, maps or arbitrary dist files. */
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,lstat,readdir,readFile,writeFile,rename,rm} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';

export const RETENTION=Object.freeze({previousBuilds:2,maxAgeMs:7*24*60*60*1000,maxFileBytes:8*1024*1024,maxBuildBytes:32*1024*1024,maxFiles:1000});
const FILE=/^[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8,64}\.(?:js|css|woff2?|ttf|otf|png|jpe?g|gif|webp|avif|ico|svg)$/;
const HASH=/^[a-f0-9]{64}$/;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=code=>{throw new Error(code);};
async function stat(path){try{return await lstat(path);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function directory(path,required=true){const s=await stat(path);if(!s){if(required)fail('RETENTION_DIRECTORY_MISSING');return false;}if(!s.isDirectory()||s.isSymbolicLink())fail('RETENTION_DIRECTORY_INVALID');return true;}
async function bytes(path,max){const s=await stat(path);if(!s||!s.isFile()||s.isSymbolicLink()||s.size>max)fail('RETENTION_FILE_INVALID');const value=await readFile(path);if(value.length!==s.size||value.length>max)fail('RETENTION_FILE_CHANGED');return value;}
function assetContent(name,value){
 if(!FILE.test(name)||!value.length)fail('RETENTION_ASSET_INVALID');
 if(/\.(?:js|css|svg)$/.test(name)){
  let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(value);}catch{fail('RETENTION_TEXT_INVALID');}
  if(/^[\s\ufeff]*<(?:!doctype\s+html|html|head|body)(?:\s|>)/i.test(text)||/sourceMappingURL\s*=/.test(text))fail('RETENTION_CONTENT_REJECTED');
 }
}
async function capture(path,now){
 await directory(path);const assets=join(path,'assets');await directory(assets);
 const files=[];let total=0;
 for(const entry of (await readdir(assets,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
  if(!entry.isFile()||entry.isSymbolicLink()||!FILE.test(entry.name))fail('RETENTION_ASSET_INVALID');
  const value=await bytes(join(assets,entry.name),RETENTION.maxFileBytes);assetContent(entry.name,value);total+=value.length;
  if(total>RETENTION.maxBuildBytes||files.length>=RETENTION.maxFiles)fail('RETENTION_BUILD_LIMIT');
  files.push({name:entry.name,sha256:hash(value),size:value.length});
 }
 if(!files.length)fail('RETENTION_ASSETS_MISSING');
 const html=await bytes(join(path,'index.html'),RETENTION.maxFileBytes);
 return{id:hash(JSON.stringify(files)),created_at:now,html_sha256:hash(html),files};
}
function snapshot(value,now){
 if(!value||typeof value!=='object'||!HASH.test(value.id)||!HASH.test(value.html_sha256)||!Number.isSafeInteger(value.created_at)||value.created_at<0||value.created_at>now||!Array.isArray(value.files)||value.files.length<1||value.files.length>RETENTION.maxFiles)fail('RETENTION_MANIFEST_INVALID');
 let total=0;const names=new Set();
 for(const file of value.files){if(!file||!FILE.test(file.name)||names.has(file.name)||!HASH.test(file.sha256)||!Number.isSafeInteger(file.size)||file.size<1||file.size>RETENTION.maxFileBytes)fail('RETENTION_MANIFEST_INVALID');names.add(file.name);total+=file.size;}
 if(total>RETENTION.maxBuildBytes||value.id!==hash(JSON.stringify(value.files)))fail('RETENTION_MANIFEST_INVALID');
 return value;
}
async function load(cache,now){
 if(!await directory(cache,false))return[];
 let manifest;try{manifest=JSON.parse((await bytes(join(cache,'manifest.json'),2*1024*1024)).toString('utf8'));}catch{fail('RETENTION_MANIFEST_INVALID');}
 if(manifest?.version!==1||!Array.isArray(manifest.builds)||manifest.builds.length>3)fail('RETENTION_MANIFEST_INVALID');
 const builds=manifest.builds.map(v=>snapshot(v,now));if(new Set(builds.map(b=>b.id)).size!==builds.length)fail('RETENTION_MANIFEST_INVALID');
 await directory(join(cache,'objects'));
 const expected=new Set(builds.flatMap(b=>b.files.map(f=>f.sha256)));
 for(const entry of await readdir(join(cache,'objects'),{withFileTypes:true}))if(!entry.isFile()||entry.isSymbolicLink()||!expected.has(entry.name))fail('RETENTION_CACHE_INVALID');
 for(const build of builds)for(const file of build.files){const value=await bytes(join(cache,'objects',file.sha256),RETENTION.maxFileBytes);if(value.length!==file.size||hash(value)!==file.sha256)fail('RETENTION_CACHE_HASH_MISMATCH');assetContent(file.name,value);}
 return builds;
}
async function verify(check,path){const result=await check(path);if(result!==true&&result?.passed!==true)fail('RETENTION_BUILD_CHECK_FAILED');}

/** Two directory replacements with rollback. No publisher runs until this resolves. */
export async function publishDirectories(pairs,move=rename){
 const records=[];
 try{
  for(const {source,target,backup} of pairs){
   const record={source,target,backup,old:false,published:false};records.push(record);
   if(await stat(target)){await move(target,backup);record.old=true;}
   await move(source,target);record.published=true;
  }
 }catch(error){
  let rollbackFailed=false;
  for(const record of records.reverse()){
   try{if(record.published)await rm(record.target,{recursive:true,force:true});if(record.old)await rename(record.backup,record.target);}catch{rollbackFailed=true;}
  }
  if(rollbackFailed)fail('RETENTION_ROLLBACK_REQUIRED');
  throw error;
 }
}

/** build(output) must write only to output; check(output) scans the complete public bundle. */
export async function retainedBuild({dist,cache,build,check,now=Date.now()}={}){
 if(typeof dist!=='string'||typeof cache!=='string'||typeof build!=='function'||typeof check!=='function'||!Number.isSafeInteger(now)||now<0)fail('RETENTION_OPTIONS_INVALID');
 dist=resolve(dist);cache=resolve(cache);if(dist===cache||cache.startsWith(dist+'/')||dist.startsWith(cache+'/'))fail('RETENTION_PATH_INVALID');
 // All mutable temporary/cache paths are ignored local build artifacts.
 await mkdir(dirname(cache),{recursive:true});await directory(dirname(cache));await directory(dirname(dist));
 const lock=join(dirname(cache),'erp-build.lock');try{await mkdir(lock);}catch{fail('RETENTION_BUILD_LOCKED');}
 const work=join(dirname(cache),`erp-build-${randomUUID()}`),output=join(work,'output'),nextCache=join(work,'cache');
 let preserveRecovery=false;
 try{
  await mkdir(work);await mkdir(output);await mkdir(nextCache);await mkdir(join(nextCache,'objects'));
  const history=await load(cache,now),hasDist=await directory(dist,false);
  if(hasDist){
   await verify(check,dist);
   if(!history.length)history.push(await capture(dist,now));
   else{
    // A merged output is not a new build. Only the private manifest identifies its current assets.
    if(hash(await bytes(join(dist,'index.html'),RETENTION.maxFileBytes))!==history[0].html_sha256)fail('RETENTION_CURRENT_BUILD_MISMATCH');
    const known=new Map(history.flatMap(b=>b.files.map(f=>[f.name,f.sha256])));
    await directory(join(dist,'assets'));
    for(const entry of await readdir(join(dist,'assets'),{withFileTypes:true})){
     if(!entry.isFile()||entry.isSymbolicLink()||!known.has(entry.name)||hash(await bytes(join(dist,'assets',entry.name),RETENTION.maxFileBytes))!==known.get(entry.name))fail('RETENTION_CURRENT_BUILD_MISMATCH');
    }
    for(const file of history[0].files)if(hash(await bytes(join(dist,'assets',file.name),RETENTION.maxFileBytes))!==file.sha256)fail('RETENTION_CURRENT_BUILD_MISMATCH');
   }
  }
  // Capture previous bytes before invoking Vite. No process may empty dist under this wrapper.
  const objectBytes=new Map();
  for(const previous of history)for(const file of previous.files){if(objectBytes.has(file.sha256))continue;const source=history.length&&await stat(join(cache,'objects',file.sha256))?join(cache,'objects',file.sha256):join(dist,'assets',file.name);const value=await bytes(source,RETENTION.maxFileBytes);if(hash(value)!==file.sha256)fail('RETENTION_CACHE_HASH_MISMATCH');objectBytes.set(file.sha256,value);}
  await build(output);const current=await capture(output,now);await verify(check,output);
  // Identical assets do not evict a useful previous build during repeated QA builds.
  const previous=history.filter(b=>b.id!==current.id&&now-b.created_at<=RETENTION.maxAgeMs).slice(0,RETENTION.previousBuilds);
  const builds=[current,...previous],destinations=new Map(current.files.map(f=>[f.name,f.sha256]));let retained=0;
  for(const file of current.files)objectBytes.set(file.sha256,await bytes(join(output,'assets',file.name),RETENTION.maxFileBytes));
  for(const old of previous)for(const file of old.files){
   if(destinations.has(file.name)){if(destinations.get(file.name)!==file.sha256)fail('RETENTION_FILENAME_COLLISION');continue;}
   await writeFile(join(output,'assets',file.name),objectBytes.get(file.sha256),{flag:'wx'});destinations.set(file.name,file.sha256);retained++;
  }
  await verify(check,output);
  const hashes=new Set(builds.flatMap(b=>b.files.map(f=>f.sha256)));for(const digest of hashes)await writeFile(join(nextCache,'objects',digest),objectBytes.get(digest),{flag:'wx',mode:0o600});
  await writeFile(join(nextCache,'manifest.json'),JSON.stringify({version:1,builds}),{flag:'wx',mode:0o600});
  await publishDirectories([{source:output,target:dist,backup:join(work,'dist-before')},{source:nextCache,target:cache,backup:join(work,'cache-before')}]);
  return{passed:true,current_assets:current.files.length,retained_assets:retained,previous_builds:previous.length};
 }catch(error){preserveRecovery=error.message==='RETENTION_ROLLBACK_REQUIRED';throw error;
 }finally{
  // On any prepublication failure the original dist/cache remain unchanged.
  if(!preserveRecovery){await rm(work,{recursive:true,force:true});await rm(lock,{recursive:true,force:true});}
 }
}
