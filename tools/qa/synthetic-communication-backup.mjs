#!/usr/bin/env node
// Actual local Wrangler D1/R2 rehearsal. Never contacts or writes production resources.
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile, writeFile, cp, appendFile, readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createRequire} from 'node:module';

const root=fileURLToPath(new URL('../../',import.meta.url));
const worker=path.join(root,'workers/communication');
const wrangler=path.join(worker,'node_modules/wrangler/bin/wrangler.js');
const runId=randomUUID();
const home=path.join(root,'.cache/qa/communication-backup-'+runId);
await mkdir(home,{recursive:true});
function run(file,args,{success=true}={}) {
  const result=spawnSync(process.execPath,[file,...args],{cwd:home,encoding:'utf8',windowsHide:true,maxBuffer:64*1024*1024,timeout:120000,env:{...process.env,CI:'1',WRANGLER_SEND_METRICS:'false'}});
  if(success&&result.status!==0) throw Error((result.stdout||'')+'\n'+(result.stderr||'')+'\n'+(result.error?.message||''));
  if(!success) assert.notEqual(result.status,0,'unsafe restore must be refused');
  return result;
}
async function config(label) {
  const dir=path.join(home,label);await mkdir(dir);
  const value={name:'fagoo-qa-'+label,compatibility_date:'2026-10-01',d1_databases:[{binding:'DB',database_name:'fagoo-qa-'+label,database_id:randomUUID()}],r2_buckets:[{binding:'MEDIA',bucket_name:'fagoo-qa-'+label+'-'+runId}]};
  const file=path.join(dir,'wrangler.json');await writeFile(file,JSON.stringify(value));return {dir,file,value};
}
const source=await config('source'),target=await config('restored'),untouched=await config('tampered');
function cli(cfg,args){return run(wrangler,[...args,'--config',cfg.file,'--local']);}
function query(cfg,sql){return JSON.parse(cli(cfg,['d1','execute','DB','--command',sql,'--json']).stdout).flatMap(x=>x.results||[]);}
const sql=`CREATE TABLE media(id TEXT PRIMARY KEY,object_key TEXT NOT NULL,type TEXT);
CREATE TABLE inbox(id TEXT PRIMARY KEY,body TEXT NOT NULL,status TEXT);
CREATE VIRTUAL TABLE chunks USING fts5(profile_id UNINDEXED,document_id UNINDEXED,text,url UNINDEXED);
INSERT INTO media VALUES('qa_media','qa/folder/bytes.bin','application/x-fagoo-qa');
INSERT INTO inbox VALUES('evt-1','Olá, d''água\nlinha dois','pending'),('evt-2','already accepted','done');
INSERT INTO chunks(rowid,profile_id,document_id,text,url) VALUES(17,'profile-qa','doc-qa','Restaurar café d''água','https://example.invalid/document');`;
const seed=path.join(home,'seed.sql');await writeFile(seed,sql);cli(source,['d1','execute','DB','--file',seed]);
const bytes=Buffer.from([0,1,2,10,13,27,127,128,255,...Buffer.from('mídia sintética\n')]);
const mediaFile=path.join(home,'source.bin');await writeFile(mediaFile,bytes);
cli(source,['r2','object','put',source.value.r2_buckets[0].bucket_name+'/qa/folder/bytes.bin','--file',mediaFile,'--content-type','application/x-fagoo-qa']);
const backup=path.join(home,'backup');
run(path.join(worker,'scripts/backup.mjs'),[source.file,backup,'--local']);
const manifest=JSON.parse(await readFile(path.join(backup,'manifest.json'),'utf8'));
assert.equal(manifest.version,2);assert.equal(manifest.complete,true);
assert.equal(manifest.source.database_id,source.value.d1_databases[0].database_id);
const hash=x=>createHash('sha256').update(x).digest('hex');
assert.equal(manifest.sha256['media/qa_media'],hash(bytes));
run(path.join(worker,'scripts/restore.mjs'),[target.file,backup,'--empty-target','--local']);
assert.deepEqual(query(target,'SELECT * FROM inbox ORDER BY id'),query(source,'SELECT * FROM inbox ORDER BY id'));
assert.deepEqual(query(target,"SELECT rowid,* FROM chunks WHERE chunks MATCH 'Restaurar'"),query(source,"SELECT rowid,* FROM chunks WHERE chunks MATCH 'Restaurar'"));
assert.deepEqual(query(target,'SELECT * FROM media'),query(source,'SELECT * FROM media'));
const restored=path.join(home,'restored.bin');cli(target,['r2','object','get',target.value.r2_buckets[0].bucket_name+'/qa/folder/bytes.bin','--file',restored]);
assert.equal(hash(await readFile(restored)),hash(bytes));
// Inspect metadata through the same local R2 implementation used by Wrangler.
const require=createRequire(path.join(worker,'package.json'));
const {Miniflare,convertV4MiniflareOptions}=require('miniflare');
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("qa")}}',r2Buckets:{MEDIA:target.value.r2_buckets[0].bucket_name},resourcePersistencePath:path.join(target.dir,'.wrangler/state/v3')}));
try {assert.equal((await (await mf.getR2Bucket('MEDIA')).head('qa/folder/bytes.bin'))?.httpMetadata.contentType,'application/x-fagoo-qa');} finally {await mf.dispose();}
const changed=path.join(home,'corrupt');await cp(backup,changed,{recursive:true});await appendFile(path.join(changed,'media/qa_media'),'changed');
const rejected=run(path.join(worker,'scripts/restore.mjs'),[untouched.file,changed,'--empty-target','--local'],{success:false});
assert.match(rejected.stderr,/Backup corrompido/);
assert.deepEqual(await readdir(untouched.dir),['wrangler.json'],'checksum rejection must precede local engine initialization/write');
assert.match(run(path.join(worker,'scripts/restore.mjs'),[source.file,backup,'--empty-target','--local'],{success:false}).stderr,/recursos novos/);
assert.match(run(path.join(worker,'scripts/restore.mjs'),[target.file,backup,'--empty-target','--local'],{success:false}).stderr,/Destino contém tabelas/);
const report={status:'passed',runId,source_id:manifest.source.database_id,destination_id:target.value.d1_databases[0].database_id,checks:['D1 operational rows','FTS rowid/text/query','R2 bytes SHA256','R2 content-type','manifest integrity','corruption refused before write','source reuse refused','nonempty destination refused'],synthetic:true,productionWrites:0};
await writeFile(path.join(home,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({...report,artifacts:home},null,2));
