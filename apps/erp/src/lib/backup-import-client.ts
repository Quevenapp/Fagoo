import {BACKUP_IMPORT_BASE,checkBackupAbort,type BackupProgress,type BackupRequestOptions} from './backup-import.ts';
export class BackupImportHttpError extends Error {status:number;constructor(status:number){super('BACKUP_IMPORT_REQUEST_FAILED');this.status=status;}}
export function captureBackupRequest(path:string,options:BackupRequestOptions={}){
  if(!options||typeof options!=='object')throw new BackupImportHttpError(400);
  const descriptors=Object.getOwnPropertyDescriptors(options);
  if(Reflect.ownKeys(descriptors).some(k=>typeof k!=='string'||!['method','body','manifestHash','signal','onProgress'].includes(k)||!Object.hasOwn(descriptors[k],'value')))throw new BackupImportHttpError(400);
  const method=descriptors.method?.value??'GET',body=descriptors.body?.value,manifestHash=descriptors.manifestHash?.value,signal=descriptors.signal?.value,onProgress=descriptors.onProgress?.value;
  if(signal!==undefined&&!(signal instanceof AbortSignal)||onProgress!==undefined&&typeof onProgress!=='function')throw new BackupImportHttpError(400);
  let type:string|undefined;
  if(path===BACKUP_IMPORT_BASE+'/capabilities'){if(method!=='GET'||body!==undefined||onProgress!==undefined||manifestHash!==undefined)throw new BackupImportHttpError(400);}
  else if(path===BACKUP_IMPORT_BASE+'/begin'||path===BACKUP_IMPORT_BASE+'/finish'){if(method!=='POST'||body!==undefined||onProgress!==undefined&&!path.endsWith('/finish'))throw new BackupImportHttpError(400);}
  else {
    const object=/^\/v1\/backup-import\/objects\/[a-f0-9]{64}\.(zip|csv|xml|bin)$/.exec(path),chunk=/^\/v1\/backup-import\/chunks\/(file|csv|xml|issue)\/[a-f0-9]{64}$/.test(path);
    if(!(body instanceof Blob)||onProgress!==undefined||!object&&!chunk||method!==(object?'PUT':'POST')||body.size>(chunk?2:object![1]==='xml'?8:40)*1024*1024)throw new BackupImportHttpError(400);
    type=chunk?'application/json':({zip:'application/zip',csv:'text/csv',xml:'application/xml',bin:'application/octet-stream'} as Record<string,string>)[object![1]];
  }
  if(method!=='GET'&&(typeof manifestHash!=='string'||!/^[a-f0-9]{64}$/.test(manifestHash)))throw new BackupImportHttpError(400);
  return Object.freeze({path,method:method as 'GET'|'POST'|'PUT',body:body as Blob|undefined,manifestHash:manifestHash as string|undefined,signal:signal as AbortSignal|undefined,onProgress:onProgress as ((p:BackupProgress)=>void)|undefined,type,finish:path.endsWith('/finish')});
}
type Captured=ReturnType<typeof captureBackupRequest>;
function invalid():never{throw new BackupImportHttpError(502);}
export async function readBackupResponse(response:Response,selected:Captured,check:()=>void):Promise<unknown>{
  if(!response.ok){try{await response.body?.cancel();}catch{}throw new BackupImportHttpError(response.status);}
  const mime=response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase();
  if(mime!==(selected.finish?'text/event-stream':'application/json')||!response.body)invalid();
  const limit=selected.finish?16*1024*1024:selected.path.endsWith('/capabilities')?16*1024*1024:65536;
  const length=response.headers.get('Content-Length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>limit))invalid();
  const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let bytes=0,text='',terminal:unknown,events=0,previous=0;
  const consume=(frame:string)=>{
    if(frame.length>8192)invalid();if(!frame.trim()||frame.startsWith(':')&&!frame.includes('\nevent:'))return;
    let event='',data='';for(const line of frame.split('\n')){if(line.startsWith(':'))continue;if(line.startsWith('event:')){if(event)invalid();event=line.slice(6).trim();}else if(line.startsWith('data:'))data+=line.slice(5).trimStart();else if(line)invalid();}
    if(!event||!data||terminal!==undefined)invalid();let value:any;try{value=JSON.parse(data);}catch{invalid();}if(!value||typeof value!=='object'||Array.isArray(value))invalid();
    if(event==='error')throw new BackupImportHttpError(503);
    if(event==='result'){terminal=value;return;}
    if(event!=='progress'||value.profile!=='origin-backup-import-progress-v1'||value.phase!=='verifying_objects'||!Number.isSafeInteger(value.completed)||!Number.isSafeInteger(value.total)||value.total<1||value.total>9000||value.completed<previous||value.completed>value.total||!Number.isSafeInteger(value.verified_bytes)||value.verified_bytes<0||value.verified_bytes>512*1024*1024)invalid();
    previous=value.completed;selected.onProgress?.({phase:'verifying_objects',completed:value.completed,total:value.total});
  };
  try{
    while(true){check();const item=await reader.read();check();if(item.done)break;if(!(item.value instanceof Uint8Array)||(bytes+=item.value.length)>limit)invalid();text+=decoder.decode(item.value,{stream:true});
      if(selected.finish){text=text.replace(/\r\n/g,'\n');let boundary;while((boundary=text.indexOf('\n\n'))!==-1){if(++events>18050)invalid();const frame=text.slice(0,boundary);text=text.slice(boundary+2);consume(frame);}if(text.length>8192)invalid();}
    }
    text+=decoder.decode();check();if(length!==null&&Number(length)!==bytes)invalid();
    if(selected.finish){if(text.trim()||terminal===undefined)invalid();return terminal;}
    try{return JSON.parse(text);}catch{return invalid();}
  }finally{void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{}}
}
export async function fetchBackupRequest(origin:string,selected:Captured,bearer:string,fetcher:typeof fetch,check:()=>void):Promise<unknown>{
  const base=new URL(origin);if(!(base.protocol==='https:'||base.protocol==='http:'&&['localhost','127.0.0.1'].includes(base.hostname))||base.username||base.password||base.search||base.hash||base.pathname!=='/')throw new BackupImportHttpError(400);
  checkBackupAbort(selected.signal);check();
  const response=await fetcher(base.origin+selected.path,{method:selected.method,headers:{Authorization:`Bearer ${bearer}`,Accept:selected.finish?'text/event-stream':'application/json',...(selected.type?{'Content-Type':selected.type}:{}),...(selected.manifestHash?{'X-Backup-Manifest':selected.manifestHash}:{})},body:selected.body,signal:selected.signal,credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer'});
  try{check();return await readBackupResponse(response,selected,check);}catch(error){try{await response.body?.cancel();}catch{}throw error;}
}
