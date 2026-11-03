// QA_SYNTHETIC_ACTIVITY — synthetic local ports for Registro de atividades, Consulta de exclusões and Gerenciador de arquivos.
import {AccessError,type AccessState,type AccessRole,type NativeRequestOptions,type AttachmentRequestOptions} from '../lib/real-access.ts';
import {captureSystemRequest} from '../lib/activity-request.ts';
import {captureActivityQuery,captureFilesQuery,type ActivityEntry,type FileEntry} from '../../../../packages/erp-domain/src/activity.mjs';
export const ACTIVITY_QA_ADMIN='10000000-0000-4000-8000-000000000118';
const STAMP='2026-10-20T12:00:00.000000+00:00',DOC='40000000-0000-4000-8000-000000000118';
export const ACTIVITY_QA_ENTRIES:ActivityEntry[]=[
 {source:'users',id:'3',created_at:'2026-10-20T15:00:00.000000+00:00',actor:{user_id:ACTIVITY_QA_ADMIN,label:'Administrador Sintético'},module:'usuarios',operation:'exclusao',code:null,description:'Usuário Vendas Sintético'},
 {source:'stock',id:'60000000-0000-4000-8000-000000000001',created_at:'2026-10-20T14:00:00.000000+00:00',actor:{user_id:ACTIVITY_QA_ADMIN,label:'Administrador Sintético'},module:'estoque',operation:'lancamento',code:'REF-1',description:'Entrada sintética'},
 {source:'catalog',id:'1',created_at:STAMP,actor:{user_id:ACTIVITY_QA_ADMIN,label:'Administrador Sintético'},module:'produtos',operation:'criacao',code:'SINT-1',description:'Produto sintético'},
];
// 263: a product image (PNG) beside the document attachment, for the Miniatura and the origins of the Gerenciador de arquivos.
const PNG=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9kAAAAASUVORK5CYII='),c=>c.charCodeAt(0));
const PRODUCT='70000000-0000-4000-8000-000000000263',IMAGE='80000000-0000-4000-8000-000000000263';
// 301: `failUploadOnce` loses the first answer of an Inserir Arquivo upload (the bytes are kept), for "Conferir resultado";
// `uploadFailure` makes the first upload fail before the bytes arrive ('unsent', 503) or meet another request that holds it ('conflict', 409); 'quota' refuses every reservation (ERP_ATTACHMENT_QUOTA).
export function createActivityFixture({role='admin',before,failDeleteOnce=false,failUploadOnce=false,uploadFailure=null}:{role?:AccessRole;before?:(path:string)=>unknown|Promise<unknown>;failDeleteOnce?:boolean;failUploadOnce?:boolean;uploadFailure?:'unsent'|'conflict'|'quota'|null}={}){
 let state:AccessState={phase:'ready',membership:{user_id:ACTIVITY_QA_ADMIN,role,resources:[],data_mode:'staging_readonly'},records:null,listPending:false,loginPending:false,message:null,logoutFailed:false};
 const listeners=new Set<()=>void>(),calls:string[]=[],downloads:string[]=[],deletions:{path:string;command:string}[]=[];let deleteFailures=failDeleteOnce?1:0,uploadFailures=failUploadOnce?1:0,earlyFailure=uploadFailure;
 // Inserir Arquivo: the reservations by command and the uploads, as erp_company_file_* answer them.
 const reservations=new Map<string,{id:string;filename:string;mime_type:string;size_bytes:number;sha256:string;status:'reserved'|'ready'|'aborted'}>(),uploads:{path:string;command?:string;body?:unknown}[]=[];
 const file:FileEntry={id:'50000000-0000-4000-8000-000000000118',origin:'documentos',filename:'contrato.pdf',mime_type:'application/pdf',size_bytes:3,sha256:'',created_at:STAMP,owner:{user_id:ACTIVITY_QA_ADMIN,label:'Administrador Sintético'},source:{kind:'sales_orders',id:DOC,code:'1001',label:'Cliente Sintético'}};
 const image:FileEntry={id:IMAGE,origin:'produtos',filename:'anexo-caneta.png',mime_type:'image/png',size_bytes:PNG.length,sha256:'',created_at:STAMP,owner:{user_id:ACTIVITY_QA_ADMIN,label:'Administrador Sintético'},source:{kind:'product',id:PRODUCT,code:'CAN-1',label:'Caneta sintética'}};
 const content=new Blob([new Uint8Array([1,2,3])]),picture=new Blob([PNG]);let files=[file,image];
 const controller={getSnapshot:()=>state,subscribe:(fn:()=>void)=>{listeners.add(fn);return()=>{listeners.delete(fn);};},
  async systemLog(path:string,options:NativeRequestOptions={}){
   captureSystemRequest(path,options);calls.push(path);const replacement=await before?.(path);if(replacement!==undefined)return replacement;
   if(state.membership?.role!=='admin')throw new AccessError(403);
   const [pathname,search='']=path.split('?'),p=new URLSearchParams(search);
   if(pathname==='/v1/registro-atividades'){const q=captureActivityQuery({from:p.get('de')!,to:p.get('ate')!,module:p.get('modulo') as never,operation:p.get('operacao') as never,actor:p.get('usuario'),q:p.get('q')});
    const items=ACTIVITY_QA_ENTRIES.filter(e=>(!q.module||e.module===q.module)&&(!q.operation||e.operation===q.operation)&&(!q.q||(e.description??'').toLowerCase().includes(q.q)||(e.code??'').toLowerCase().includes(q.q)));
    return structuredClone({scope:'activity',data_mode:'erp_native',from:q.from,to:q.to,module:q.module,operation:q.operation,actor:q.actor,query:q.q,limit:q.limit,offset:q.offset,total:items.length,has_more:false,items});}
   // 148: antes e depois of one entry (stock keeps none).
   if(pathname==='/v1/registro-atividades/detalhe'){const source=p.get('origem')!,id=p.get('id')!,available=source!=='stock';
    return{scope:'activity_detail',data_mode:'erp_native',source,id,available,truncated:false,before:available?{name:'Produto antigo',price:'1.00',active:true}:null,after:available?{name:'Produto sintético',price:'1.00',active:true}:null};}
   const q=captureFilesQuery({q:p.get('q'),from:p.get('de'),to:p.get('ate'),order:(p.get('ordem')??'data') as never,origin:p.get('origem') as never});
   const hex=async(blob:Blob)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(b=>b.toString(16).padStart(2,'0')).join('');
   if(!file.sha256){file.sha256=await hex(content);image.sha256=await hex(picture);}
   const items=files.filter(f=>(!q.q||f.filename.includes(q.q))&&(!q.origin||f.origin===q.origin));
   return structuredClone({scope:'files',data_mode:'erp_native',query:q.q,from:q.from,to:q.to,order:q.order,origin:q.origin,limit:q.limit,offset:q.offset,total:items.length,total_bytes:String(items.reduce((s,f)=>s+f.size_bytes,0)),has_more:false,items});
  },
  async attachments(path:string,options:AttachmentRequestOptions={}){
   const fileDto=(r:{id:string;filename:string;mime_type:string;size_bytes:number;sha256:string;status:string})=>({...r,created_at:STAMP,finished_at:r.status==='reserved'?null:STAMP,deleted:false,owner_name:'Administrador Sintético'});
   if(path==='/v1/anexos-empresa/arquivos'&&options.method==='POST'){const body=options.body as {command_id:string;filename:string;mime_type:string;size_bytes:number;sha256:string};uploads.push({path,command:body.command_id,body});
    const known=reservations.get(body.command_id);if(known)return{file:fileDto(known),replayed:true,data_mode:'erp_native'};
    if(earlyFailure==='quota')throw new AccessError(409,'ERP_ATTACHMENT_QUOTA');
    const stem=body.filename.replace(/\.[^.]+$/,'').normalize('NFKD').replace(/[̀-ͯ]/g,'').replace(/[^A-Za-z0-9_-]+/g,'-').replace(/^[^A-Za-z0-9]+/,'').slice(0,80)||'empresa';
    const row={id:`90000000-0000-4000-8000-${String(reservations.size+1).padStart(12,'0')}`,filename:`arquivo-${stem}.${({'application/pdf':'pdf','image/png':'png','image/jpeg':'jpg','application/xml':'xml','text/plain':'txt'} as Record<string,string>)[body.mime_type]}`,
     mime_type:body.mime_type,size_bytes:body.size_bytes,sha256:body.sha256,status:'reserved' as const};
    reservations.set(body.command_id,row);return{file:fileDto(row),replayed:false,data_mode:'erp_native'};}
   if(/^\/v1\/anexos-empresa\/arquivos\/[^/]+\/(upload|abort)$/.test(path)){uploads.push({path});const id=path.split('/').at(-2)!,row=[...reservations.values()].find(r=>r.id===id);if(!row)throw new AccessError(404);
    // erp_company_file_stop refuses to abort a ready file; erp_company_file_object refuses to upload an aborted one.
    if(path.endsWith('/abort')){if(row.status==='ready')throw new AccessError(409);row.status='aborted';return{file:fileDto(row),data_mode:'erp_native'};}
    if(row.status==='aborted')throw new AccessError(409);
    if(earlyFailure){const failure=earlyFailure;earlyFailure=null;throw new AccessError(failure==='conflict'?409:503);}
    const first=row.status==='reserved';row.status='ready';
    if(first)files=[{id:row.id,origin:'empresa',filename:row.filename,mime_type:row.mime_type,size_bytes:row.size_bytes,sha256:row.sha256,created_at:STAMP,owner:{user_id:ACTIVITY_QA_ADMIN,label:'Administrador Sintético'},
     source:{kind:'company_file',id:row.id,code:null,label:'Arquivo da empresa'}} as FileEntry,...files];
    if(uploadFailures-->0)throw new AccessError(503);
    return{file:fileDto(row),replayed:!first,data_mode:'erp_native'};}
   if(path.endsWith('/exclusao')){const body=options.body as {command_id:string};deletions.push({path,command:body.command_id});if(deleteFailures-->0)throw new AccessError(503);
    const id=path.split('/').at(-2)!;files=files.filter(f=>f.id!==id);return path.includes('/anexos-cadastros/produtos/')?{image:{id,deleted:true},replayed:false,data_mode:'erp_native'}:{attachment:{id,deleted:true},replayed:false,data_mode:'erp_native'};}
   downloads.push(path);if(!options.download)throw new AccessError(400);return path.includes(IMAGE)?picture:content;},
 };
 return{controller,calls,downloads,deletions,uploads,setAccess(patch:{role?:AccessRole}){state={...state,membership:{...state.membership!,role:patch.role??state.membership!.role}};for(const fn of listeners)fn();}};
}
