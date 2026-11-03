// QA_SYNTHETIC_REPORTS — synthetic local port for /v1/sistema relatórios and etiquetas (migration 149); no network and no
// real data. The rows follow the base catalog of the domain contract.
import {AccessError,type AccessState,type AccessRole,type NativeRequestOptions} from '../lib/real-access.ts';
import {captureSystemPortRequest} from '../lib/system-request.ts';
import {sumDecimals} from '../lib/reports-model.ts';
import {REPORT_BASES,LABEL_DEFAULTS,reportBase,type ReportRunInput,type ReportSaveInput,type FrameworkDeleteInput,type LabelSaveInput,type SavedReport,type LabelTemplate} from '../../../../packages/erp-domain/src/reports-labels.mjs';
export const REPORTS_QA_ACTOR='10000000-0000-4000-8000-000000000149';
export const REPORTS_QA_USER='10000000-0000-4000-8000-000000001491';
const STAMP='2026-10-20T12:00:00.000000+00:00';
export type ReportsQaCall={path:string;method:string;body?:unknown};
const ROWS:Record<string,Record<string,string|null>[]>={
 vendas:[{numero:'1',data:'2026-10-01',contato:'Ana Sintética',situacao:'Em aberto',vendedor:null,itens:'1',total:'5.00'},{numero:'2',data:'2026-10-02',contato:'Bia Sintética',situacao:'Atendido',vendedor:'Carlos',itens:'2',total:'10.00'},
  {numero:'3',data:'2026-10-03',contato:'Ana Sintética',situacao:'Atendido',vendedor:null,itens:'1',total:'2.50'}],
 produtos:[{codigo:'BOR-1',descricao:'Borracha',unidade:'UN',preco:'1.2500',tipo:'Produto',situacao:'Ativo',gtin:null,ncm:null},{codigo:'CAN-1',descricao:'Caneta azul',unidade:'UN',preco:'2.5000',tipo:'Produto',situacao:'Ativo',gtin:'7891234567895',ncm:'96081000'}],
};
const VENDAS_BASES=['produtos','contatos','vendas','propostas','ordens_servico'];
export const REPORTS_QA_INVOICE='70000000-0000-4000-8000-000000000230';
export function createReportsFixture({role='admin',lostAck=false,actor=REPORTS_QA_ACTOR}:{role?:AccessRole;lostAck?:boolean;actor?:string}={}){
 let state:AccessState={phase:'ready',membership:{user_id:actor,role,resources:[],data_mode:'staging_readonly'},records:null,listPending:false,loginPending:false,message:null,logoutFailed:false};
 const listeners=new Set<()=>void>(),calls:ReportsQaCall[]=[],commands=new Map<string,unknown>(),reports:SavedReport[]=[],labels:LabelTemplate[]=[];let lose=lostAck,ids=0;
 const uuid=()=>`50000000-0000-4000-8000-${String(++ids).padStart(12,'0')}`;
 const r=()=>state.membership!.role;
 const finish=(id:string,result:object)=>{commands.set(id,result);if(lose){lose=false;throw new AccessError(503);}return{...result,replayed:false};};
 const receipt=(scope:string,command_id:string,action:string,target:string|null,count:number)=>({scope,data_mode:'erp_native',receipt:{command_id,action,target,count,changed_at:STAMP}});
 const controller={getSnapshot:()=>state,subscribe:(fn:()=>void)=>{listeners.add(fn);return()=>{listeners.delete(fn);};},
  async system(path:string,options:NativeRequestOptions={}){
   const captured=captureSystemPortRequest(path,options),call={path,method:captured.options.method,body:captured.options.body};calls.push(call);
   const [pathname,search='']=path.split('?'),rest=pathname.slice('/v1/sistema/'.length),params=new URLSearchParams(search),admin=r()==='admin';
   const body=call.body as {command_id?:string}|undefined,known=body?.command_id?commands.get(body.command_id):undefined;if(known)return{...(known as object),replayed:true};
   if(rest==='relatorios'&&call.method==='GET'){const bases=REPORT_BASES.filter(b=>admin||VENDAS_BASES.includes(b.base));
    return{scope:'reports',data_mode:'erp_native',can_manage:admin,bases:structuredClone(bases),reports:structuredClone(reports.filter(x=>bases.some(b=>b.base===x.base)&&(admin||x.users.includes(state.membership!.user_id)))),
     directory:admin?[{user_id:actor,role:'admin',label:'Ana Administradora'},{user_id:REPORTS_QA_USER,role:'vendas',label:'Vendas Sintético'}]:null};}
   if(rest==='relatorios/execucao'){const q=call.body as ReportRunInput,base=reportBase(q.base)!;if(!admin&&!VENDAS_BASES.includes(q.base))throw new AccessError(403);
    const numeric=(c:string)=>['money','decimal','int'].includes(base.columns.find(k=>k.id===c)!.type);
    const all=(ROWS[q.base]??[]).filter(row=>q.filters.every(f=>numeric(f.column)?row[f.column]!==null&&Number(row[f.column])===Number(f.value):(row[f.column]??'').toLowerCase().includes(f.value.toLowerCase())));
    const limited=all.slice(0,q.view_limit),totals=Object.fromEntries(q.columns.filter(c=>['money','decimal'].includes(base.columns.find(k=>k.id===c)!.type)).map(c=>[c,sumDecimals(limited.map(x=>x[c]??null))]));
    return{scope:'report_rows',data_mode:'erp_native',base:q.base,columns:[...q.columns],rows:limited.slice(q.offset,q.offset+q.page).map(row=>q.columns.map(c=>row[c]??null)),offset:q.offset,total_rows:limited.length,truncated:all.length>q.view_limit,totals};}
   if(rest==='relatorios'){if(!admin)throw new AccessError(403);const b=call.body as ReportSaveInput;if(reports.some(x=>x.id!==b.id&&x.title.toLowerCase()===b.data.title.toLowerCase()))throw new AccessError(409);
    let id=b.id;if(!id){id=uuid();reports.push({...structuredClone(b.data),id,version:1,updated_at:STAMP} as SavedReport);}
    else{const x=reports.find(y=>y.id===b.id);if(!x)throw new AccessError(404);if(x.version!==b.expected_version)throw new AccessError(409);Object.assign(x,structuredClone(b.data),{version:x.version+1});}
    return finish(b.command_id,receipt('reports_command',b.command_id,b.id?'report_update':'report_create',id,1));}
   if(rest==='relatorios/exclusao'||rest==='etiquetas/exclusao'){if(!admin)throw new AccessError(403);const b=call.body as FrameworkDeleteInput,list:{id:string;version:number}[]=rest==='relatorios/exclusao'?reports:labels;
    for(const i of b.items){const x=list.find(y=>y.id===i.id);if(!x)throw new AccessError(404);if(x.version!==i.expected_version)throw new AccessError(409);}for(const i of b.items)list.splice(list.findIndex(y=>y.id===i.id),1);
    const area=rest==='relatorios/exclusao'?'reports':'labels';return finish(b.command_id,receipt(`${area}_command`,b.command_id,`${area}_delete`,null,b.items.length));}
   if(rest==='etiquetas'&&call.method==='GET'){if(!admin)throw new AccessError(403);
    return{scope:'labels',data_mode:'erp_native',items:[...LABEL_DEFAULTS.map(t=>({...structuredClone(t),default:true,version:0,updated_at:null})),...structuredClone(labels)]};}
   if(rest==='etiquetas'){if(!admin)throw new AccessError(403);const b=call.body as LabelSaveInput;
    if(labels.some(x=>x.id!==b.id&&x.type===b.data.type&&x.description.toLowerCase()===b.data.description.toLowerCase())||LABEL_DEFAULTS.some(x=>x.type===b.data.type&&x.description.toLowerCase()===b.data.description.toLowerCase()))throw new AccessError(409);
    let id=b.id;if(!id){id=uuid();labels.push({id,type:b.data.type,description:b.data.description,default:false,config:structuredClone(b.data.config),version:1,updated_at:STAMP});}
    else{const x=labels.find(y=>y.id===b.id);if(!x)throw new AccessError(404);if(x.version!==b.expected_version)throw new AccessError(409);Object.assign(x,{description:b.data.description,config:structuredClone(b.data.config),version:x.version+1});}
    return finish(b.command_id,receipt('labels_command',b.command_id,b.id?'label_update':'label_create',id,1));}
   if(rest==='etiquetas/registros'){const type=params.get('tipo'),q=(params.get('busca')??'').toLowerCase();
    if(type==='produto')return{scope:'label_records',data_mode:'erp_native',type,items:ROWS.produtos!.filter(p=>!q||p.descricao!.toLowerCase().includes(q)).map((p,i)=>({id:`60000000-0000-4000-8000-00000000000${i+1}`,
     values:{codigo:p.codigo,descricao:p.descricao,preco:p.preco,unidade:p.unidade,gtin:p.gtin,ncm:p.ncm}}))};
    return{scope:'label_records',data_mode:'erp_native',type,items:[]};}
   // 230: the product labels of one synthetic note (Imprimir etiquetas of the notas list).
   if(rest==='etiquetas/nota'){const id=params.get('id');if(!admin)throw new AccessError(403);if(id!==REPORTS_QA_INVOICE)throw new AccessError(404);
    return{scope:'label_invoice_products',data_mode:'erp_native',invoice:{id,model:'55',number:null,series:'1'},items:[
     {position:1,product_id:'60000000-0000-4000-8000-000000000001',quantity:'2.5',values:{codigo:'P-1',descricao:'Peça sintética',preco:'50',unidade:'UN',gtin:'7891234567895',ncm:'84713012'}},
     {position:2,product_id:null,quantity:'1',values:{codigo:'AV-1',descricao:'Item avulso',preco:'20',unidade:'UN',gtin:null,ncm:null}}]};}
   throw new AccessError(404);
  }};
 return{controller,calls,reports,labels,setAccess(patch:{role?:AccessRole;actor?:string}){state={...state,membership:{...state.membership!,role:patch.role??state.membership!.role,user_id:patch.actor??state.membership!.user_id}};for(const fn of listeners)fn();}};
}
