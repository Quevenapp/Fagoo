import {createHash} from 'node:crypto';
import {backupCrc32} from '../../src/lib/backup-import.ts';
export const hash=x=>createHash('sha256').update(x).digest('hex');
export function storedZip(files){
 const locals=[],centrals=[];let offset=0;
 for(const [path,raw]of files){const name=Buffer.from(path),bytes=Buffer.from(raw),crc=backupCrc32(bytes),l=Buffer.alloc(30),c=Buffer.alloc(46);
  l.writeUInt32LE(0x04034b50);l.writeUInt16LE(20,4);l.writeUInt32LE(crc,14);l.writeUInt32LE(bytes.length,18);l.writeUInt32LE(bytes.length,22);l.writeUInt16LE(name.length,26);
  c.writeUInt32LE(0x02014b50);c.writeUInt16LE(0x314,4);c.writeUInt16LE(20,6);c.writeUInt32LE(crc,16);c.writeUInt32LE(bytes.length,20);c.writeUInt32LE(bytes.length,24);c.writeUInt16LE(name.length,28);c.writeUInt32LE(0x81800000,38);c.writeUInt32LE(offset,42);
  locals.push(l,name,bytes);centrals.push(c,name);offset+=l.length+name.length+bytes.length;
 }
 const directory=Buffer.concat(centrals),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...locals,directory,end]);
}
export function backupFixture({objects=6,seed=''}={}){
 const files=[],descriptors=[],chunks=[];
 for(let i=0;i<objects;i++){const bytes=Buffer.from(`opaque original synthetic archive ${i}${seed}`),sha=hash(bytes),local=`objects/${sha}.zip`;files.push([local,bytes]);descriptors.push({local,key:local,sha256:sha,size:bytes.length,content_type:'application/zip'});}
 for(const [i,kind]of ['file','csv','xml','issue'].entries()){const bytes=Buffer.from(JSON.stringify([{file_id:'a'.repeat(64),record_no:1,data:{synthetic:kind}}])),sha=hash(bytes),local=`chunks/${kind}-${String(i).padStart(5,'0')}-${sha}.json`;files.push([local,bytes]);chunks.push({local,kind,id:sha,sha256:sha,size:bytes.length,records:1});}
 const summary={format_version:1,source_sha256:descriptors[0].sha256,source_size:descriptors[0].size,object_count:objects,object_bytes:descriptors.reduce((n,o)=>n+o.size,0),counts:{file:1,csv:1,xml:1,issue:1},operational_effects:false};
 const manifest=Buffer.from(JSON.stringify({summary,bucket:'origin-backups',objects:descriptors,chunks}));files.unshift(['manifest.json',manifest]);
 const capabilities={profile:'origin-backup-import-capabilities-v1',enabled:true,manifest_sha256:hash(manifest),backup_sha256:summary.source_sha256,summary,objects:descriptors,chunks,
  limits:{source_bytes:41943040,xml_bytes:8388608,chunk_bytes:2097152,chunk_records:250,objects:9000,archive_bytes:536870912,archive_entries:19001,concurrency:4}};
 const receipt={profile:'origin-backup-import-receipt-v1',backup_sha256:capabilities.backup_sha256,manifest_sha256:capabilities.manifest_sha256,operational_effects:false};
 const result={profile:'origin-backup-import-result-v1',backup_sha256:capabilities.backup_sha256,manifest_sha256:capabilities.manifest_sha256,status:'stored_with_issues',verified_objects:objects,verified_bytes:summary.object_bytes,counts:summary.counts,readback_verified:true,operational_effects:false};
 const calls=[];const request=async(path,options={})=>{calls.push({path,...options});if(path.endsWith('/capabilities'))return capabilities;if(path.endsWith('/begin'))return{...receipt,action:'begin',status:'uploading',replayed:true};if(path.endsWith('/finish'))return result;
  const o=descriptors.find(x=>path.endsWith('/'+x.key));if(o)return{...receipt,action:'object',key:o.key,sha256:o.sha256,size:o.size,verified:true};const c=chunks.find(x=>path.endsWith(`/chunks/${x.kind}/${x.sha256}`));if(c)return{...receipt,action:'chunk',kind:c.kind,id:c.id,sha256:c.sha256,records:c.records,replayed:true};throw Error('Unexpected fixture request');};
 return{files,capabilities,result,receipt,calls,request,zip:storedZip(files)};
}
