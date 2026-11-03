import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,symlink,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {retainedBuild,publishDirectories,RETENTION} from './retained-build.mjs';
import {inspectBuildFile} from '../qa/check-erp-build.mjs';
const name=n=>`module-${String(n).padStart(8,'0')}.js`;
async function tree(path,n){await mkdir(join(path,'assets'),{recursive:true});await writeFile(join(path,'index.html'),`<!doctype html><script src="/assets/${name(n)}"></script>`);await writeFile(join(path,'_headers'),`headers ${n}`);await writeFile(join(path,'robots.txt'),`robots ${n}`);await writeFile(join(path,'assets',name(n)),`export const version = ${n};`);}
async function check(path){let ok=true;async function walk(dir){for(const entry of await readdir(dir,{withFileTypes:true})){if(entry.isSymbolicLink())return false;if(entry.isDirectory()){if(!await walk(join(dir,entry.name)))return false;}else if(inspectBuildFile(entry.name,await readFile(join(dir,entry.name)),['private-test-value-123456']).failures.length)ok=false;}return ok;}return{passed:await walk(path)};}
async function setup(){const root=await mkdtemp(join(tmpdir(),'brufap-retention-')),dist=join(root,'dist'),cache=join(root,'.cache','erp-assets');return{root,dist,cache,cleanup:()=>rm(root,{recursive:true,force:true}),run:(n,extra={})=>retainedBuild({dist,cache,build:p=>tree(p,n),check,now:1000000+n,...extra})};}
const assets=path=>readdir(join(path,'assets'));
test('retains exactly two distinct prior builds, never old HTML/headers or accumulated merged assets',async()=>{
 const f=await setup();try{
  await tree(f.dist,1);await writeFile(join(f.dist,'unused-config.json'),'old config');
  assert.equal((await f.run(2)).previous_builds,1);assert.deepEqual((await assets(f.dist)).sort(),[name(1),name(2)]);
  await f.run(3);assert.deepEqual((await assets(f.dist)).sort(),[name(1),name(2),name(3)]);
  await f.run(4);assert.deepEqual((await assets(f.dist)).sort(),[name(2),name(3),name(4)]);
  assert.equal(await readFile(join(f.dist,'_headers'),'utf8'),'headers 4');assert.match(await readFile(join(f.dist,'index.html'),'utf8'),/00000004/);await assert.rejects(readFile(join(f.dist,'unused-config.json')));
  const m=JSON.parse(await readFile(join(f.cache,'manifest.json'),'utf8'));assert.equal(m.builds.length,3);assert.ok(m.builds.every(b=>b.files.length===1));assert.deepEqual((await readdir(f.cache)).sort(),['manifest.json','objects']);assert.equal((await readdir(join(f.cache,'objects'))).length,3);
 }finally{await f.cleanup();}
});
test('identical rebuild does not evict an older useful chunk; retained snapshots expire after seven days',async()=>{
 const f=await setup();try{await f.run(1);await f.run(2);await f.run(3);await f.run(3,{now:1000100});assert.deepEqual((await assets(f.dist)).sort(),[name(1),name(2),name(3)]);await f.run(4,{now:1000101+RETENTION.maxAgeMs});assert.deepEqual(await assets(f.dist),[name(4)]);}finally{await f.cleanup();}
});

test('release build contains only current assets and resets history for subsequent updates',async()=>{
 const f=await setup();try{
  await f.run(1);await f.run(2);await f.run(3);
  const result=await f.run(4,{retainPrevious:false});
  assert.deepEqual(result,{passed:true,current_assets:1,retained_assets:0,previous_builds:0});
  assert.deepEqual(await assets(f.dist),[name(4)]);
  const manifest=JSON.parse(await readFile(join(f.cache,'manifest.json'),'utf8'));
  assert.equal(manifest.builds.length,1);
  assert.deepEqual(manifest.builds[0].files.map(f=>f.name),[name(4)]);
  assert.equal((await readdir(join(f.cache,'objects'))).length,1);
  await f.run(5);assert.deepEqual((await assets(f.dist)).sort(),[name(4),name(5)]);
 }finally{await f.cleanup();}
});

test('release failure preserves prior directories; success never reads or republishes their contents',async()=>{
 const f=await setup();try{
  await f.run(1);
  await writeFile(join(f.dist,'assets',name(1)),'brufap.erp.demo.list.');
  await writeFile(join(f.cache,'manifest.json'),'invalid cached manifest');
  const original=await readFile(join(f.dist,'assets',name(1)));
  for(const build of [
   async p=>{await tree(p,2);throw new Error('synthetic build failure');},
   async p=>{await tree(p,2);await writeFile(join(p,'assets',name(2)),'private-test-value-123456');}
  ]){
   await assert.rejects(f.run(2,{retainPrevious:false,build}));
   assert.deepEqual(await readFile(join(f.dist,'assets',name(1))),original);
   assert.equal(await readFile(join(f.cache,'manifest.json'),'utf8'),'invalid cached manifest');
   assert.deepEqual((await readdir(join(f.root,'.cache'))).sort(),['erp-assets']);
  }
  await f.run(2,{retainPrevious:false});
  assert.deepEqual(await assets(f.dist),[name(2)]);
  assert.equal(JSON.parse(await readFile(join(f.cache,'manifest.json'),'utf8')).builds.length,1);
 }finally{await f.cleanup();}
});
test('failed build or validation preserves original dist and cache byte for byte',async()=>{
 const f=await setup();try{
  await f.run(1);const before=await readFile(join(f.cache,'manifest.json'));
  await assert.rejects(f.run(2,{build:async p=>{await tree(p,2);throw new Error('synthetic build failure');}}));
  await assert.rejects(f.run(2,{build:async p=>{await tree(p,2);await writeFile(join(p,'assets',name(2)),'private-test-value-123456');}}),/RETENTION_BUILD_CHECK_FAILED/);
  assert.deepEqual(await readFile(join(f.cache,'manifest.json')),before);assert.deepEqual(await assets(f.dist),[name(1)]);assert.match(await readFile(join(f.dist,'index.html'),'utf8'),/00000001/);
  assert.deepEqual((await readdir(join(f.root,'.cache'))).sort(),['erp-assets']);
 }finally{await f.cleanup();}
});
test('source maps, unversioned files, HTML disguised as JS and symlinks cannot be retained',async()=>{
 for(const mode of ['map','plain','html','symlink','directory']){const f=await setup();try{
  await f.run(1);
  const build=async p=>{await tree(p,2);const dir=join(p,'assets');if(mode==='map')await writeFile(join(dir,'module-12345678.js.map'),'{}');if(mode==='plain')await writeFile(join(dir,'config.js'),'{}');if(mode==='html')await writeFile(join(dir,name(2)),'<!doctype html><html>fallback</html>');if(mode==='symlink')await symlink(process.platform==='win32'?f.dist:join(f.dist,'assets',name(1)),join(dir,'linked-12345678.js'),process.platform==='win32'?'junction':'file');if(mode==='directory')await mkdir(join(dir,'nested'));};
  await assert.rejects(f.run(2,{build}),/RETENTION_/);assert.deepEqual(await assets(f.dist),[name(1)]);
 }finally{await f.cleanup();}}
});
test('corrupt cached bytes or filenames fail closed before invoking a builder',async()=>{
 for(const mode of ['bytes','path']){const f=await setup();try{await f.run(1);let built=false;const m=JSON.parse(await readFile(join(f.cache,'manifest.json'),'utf8'));
  if(mode==='bytes')await writeFile(join(f.cache,'objects',m.builds[0].files[0].sha256),'different bytes');else{m.builds[0].files[0].name='../outside-12345678.js';await writeFile(join(f.cache,'manifest.json'),JSON.stringify(m));}
  await assert.rejects(f.run(2,{build:async p=>{built=true;await tree(p,2);}}),/RETENTION_/);assert.equal(built,false);assert.deepEqual(await assets(f.dist),[name(1)]);
 }finally{await f.cleanup();}}
});
test('hash filename collision rejects replacement instead of changing the bytes used by old tabs',async()=>{
 const f=await setup();try{await f.run(1);await assert.rejects(f.run(2,{build:async p=>{await tree(p,2);await writeFile(join(p,'assets',name(1)),'new bytes under old name');}}),/RETENTION_FILENAME_COLLISION/);assert.deepEqual(await assets(f.dist),[name(1)]);}finally{await f.cleanup();}
});
test('oversized asset and concurrent lock are rejected without modifying the previous bundle',async()=>{
 const f=await setup();try{await f.run(1);await assert.rejects(f.run(2,{build:async p=>{await tree(p,2);await writeFile(join(p,'assets',name(2)),Buffer.alloc(RETENTION.maxFileBytes+1));}}),/RETENTION_FILE_INVALID/);
  await mkdir(join(f.root,'.cache','erp-build.lock'));await assert.rejects(f.run(2),/RETENTION_BUILD_LOCKED/);assert.deepEqual(await assets(f.dist),[name(1)]);
 }finally{await f.cleanup();}
});
test('out-of-band dist replacement is not reclassified as another snapshot',async()=>{
 const f=await setup();try{await f.run(1);await writeFile(join(f.dist,'index.html'),'changed outside wrapper');await assert.rejects(f.run(2),/RETENTION_CURRENT_BUILD_MISMATCH/);assert.equal(await readFile(join(f.dist,'index.html'),'utf8'),'changed outside wrapper');}finally{await f.cleanup();}
});
test('a failure between directory promotions rolls back both old directories',async()=>{
 const f=await setup();try{
  const pairs=[0,1].map(n=>({source:join(f.root,`new-${n}`),target:join(f.root,`old-${n}`),backup:join(f.root,`backup-${n}`)}));
  for(const p of pairs){await mkdir(p.source);await mkdir(p.target);await writeFile(join(p.source,'value'),'new');await writeFile(join(p.target,'value'),'old');}
  await assert.rejects(publishDirectories(pairs,async(a,b)=>{if(a===pairs[1].source)throw new Error('synthetic promotion failure');return rename(a,b);}));
  for(const p of pairs)assert.equal(await readFile(join(p.target,'value'),'utf8'),'old');
 }finally{await f.cleanup();}
});
