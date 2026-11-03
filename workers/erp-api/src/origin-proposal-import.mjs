/** Reviewed staging proposal -> native draft. No Origin, financial, stock or fiscal writes. */
import {calculateDocument,STATES,normalizeCommercial,normalizeCommercialReference} from '../../../packages/erp-domain/src/index.mjs';
import {isCanonicalUnitPrice} from '../../../packages/erp-domain/src/unit-price.mjs';

export const ORIGIN_PROPOSAL_IMPORT_BASE='/v1/importacao-orcamentos-origin';
export const ORIGIN_PROPOSAL_IMPORT_RESPONSE_BYTES=1048576;
export const ORIGIN_PROPOSAL_IMPORT_ISSUES=Object.freeze(['ALREADY_IMPORTED','SOURCE_TOO_LARGE','SOURCE_ID_MISMATCH','STATUS_OUTSIDE_PROFILE','SOURCE_FIELDS_UNSUPPORTED','SOURCE_NUMBER_INVALID','SOURCE_DATE_INVALID','SOURCE_TEXT_INVALID','COMMERCIAL_FIELD_UNSUPPORTED','COMMERCIAL_REFERENCE_UNSUPPORTED','DISCOUNT_UNSUPPORTED','AMOUNTS_MISSING_OR_INVALID','TRANSPORT_INVALID','TRANSPORT_CONFLICT','TRANSPORT_FIELD_UNSUPPORTED','CONTACT_REFERENCE_INVALID','CONTACT_MAPPING_UNAVAILABLE','ITEMS_INVALID','ITEM_INVALID','ITEM_FIELDS_UNSUPPORTED','PRODUCT_REFERENCE_INVALID','PRODUCT_MAPPING_UNAVAILABLE','PRODUCT_UNIT_MISMATCH','ITEM_TEXT_INVALID','ITEM_DECIMAL_INVALID','ITEM_DETAIL_UNSUPPORTED','INSTALLMENTS_INVALID','INSTALLMENT_INVALID','INSTALLMENT_FIELD_UNSUPPORTED','INSTALLMENT_AMOUNT_INVALID','INSTALLMENT_DATE_INVALID','INSTALLMENT_DAYS_CONFLICT','INSTALLMENT_TOTAL_MISMATCH','NATIVE_CONTENT_TOO_LARGE','SOURCE_TOTAL_MISMATCH','NATIVE_FIELDS_INVALID']);
const FLAGS=Object.freeze({data_mode:'proposal_import_review',policy:'origin-open-proposal-v1',entity:'sales_proposals',creates_draft:true,stock_effects:false,financial_effects:false,fiscal_effects:false,coverage_certified:false,cutoff_at:null});
const WARNINGS=['SOURCE_FRESHNESS_NOT_CERTIFIED','MANUAL_DUPLICATES_NOT_DETECTABLE','NATIVE_NUMBER_ASSIGNED_ON_APPLY'];
const FIELDS=['id','situacao','numero','data','dataProximoContato','observacoes','observacaoInterna','prazoEntrega','garantia','totalOutrosItens','introducao','aosCuidadosDe','loja','vendedor','desconto','transporte','transporte.freteModalidade','contato.id','itens','produto.id','unidade','descricao','codigo','quantidade/valor','itens.desconto','descricaoDetalhada','parcelas','valor','dataVencimento','numeroDias'];
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i,HASH=/^[a-f0-9]{64}$/,ROUTES=new WeakSet();
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v),own=(v,k)=>Object.hasOwn(v,k);
const exact=(v,keys)=>object(v)&&Object.keys(v).length===keys.length&&keys.every(k=>own(v,k));
const pick=(v,keys)=>Object.fromEntries(keys.map(k=>[k,v[k]]));
const uuid=v=>typeof v==='string'&&UUID.test(v),source=v=>typeof v==='string'&&/^[1-9][0-9]{0,39}$/.test(v);
const hash=v=>typeof v==='string'&&HASH.test(v),version=v=>Number.isInteger(v)&&v>=1&&v<=2147483647;
const sourceVersion=v=>typeof v==='string'&&/^[1-9][0-9]{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
const text=(v,max,required=false,multiline=false)=>typeof v==='string'&&Array.from(v).length<=max&&(!required||v.replace(/^ +| +$/g,'').length>0)&&!(multiline?/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/:/[\x00-\x1f\x7f]/).test(v);
const nullable=(v,test)=>v===null||test(v);
const money=v=>typeof v==='string'&&/^(?:0|[1-9][0-9]{0,11})\.[0-9]{2}$/.test(v);
const decimal=(v,integers,scale)=>typeof v==='string'&&new RegExp(`^(?:0|[1-9][0-9]{0,${integers-1}})\\.[0-9]{${scale}}$`).test(v);
const cents=v=>BigInt(v.replace('.',''));
function freeze(v){if(object(v)||Array.isArray(v)){Object.values(v).forEach(freeze);Object.freeze(v);}return v;}
export class OriginProposalImportError extends Error{constructor(status,code){super(code);this.name='OriginProposalImportError';this.status=status;this.code=code;}}
const fail=(status=400,code='ERP_INVALID_QUERY')=>{throw new OriginProposalImportError(status,code);};
const bad=()=>fail(502,'ERP_UPSTREAM_INVALID_RESPONSE');
function day(v){return typeof v==='string'&&/^(19|20)\d{2}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;}
function stamp(v){
 if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(v))return false;
 const m=/([+-])(\d{2}):(\d{2})$/.exec(v),offset=m?(m[1]==='+'?1:-1)*(Number(m[2])*60+Number(m[3])):0;
 return(!m||Number(m[2])<=14&&Number(m[3])<=59&&(m[2]!=='14'||m[3]==='00'))&&Number.isFinite(Date.parse(v))&&new Date(Date.parse(v)+offset*60000).toISOString().slice(0,19)===v.slice(0,19);
}
function shape(path){
 const p=ORIGIN_PROPOSAL_IMPORT_BASE;if(path===p)return{type:'sources'};
 if(path===p+'/preview'||path===p+'/apply')return{type:path.slice(p.length+1)};
 let m=new RegExp(`^${p}/(commands|origins)/([^/]+)$`).exec(path);
 if(m)return m[1]==='commands'&&uuid(m[2])?{type:'command',id:m[2].toLowerCase()}:m[1]==='origins'&&source(m[2])?{type:'origin',id:m[2]}:null;
 m=new RegExp(`^${p}/documents/([^/]+)/origin$`).exec(path);return m&&uuid(m[1])?{type:'document_origin',id:m[1].toLowerCase()}:null;
}
export const originProposalImportRoute=path=>typeof path==='string'&&(path===ORIGIN_PROPOSAL_IMPORT_BASE||path.startsWith(ORIGIN_PROPOSAL_IMPORT_BASE+'/'));
export const originProposalImportMethods=path=>{const s=shape(path);return s?(['preview','apply'].includes(s.type)?['POST']:['GET']):null;};
async function body(request){
 if(!request.body||!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type')??''))fail();
 const length=request.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>4096))fail(413,'ERP_BODY_TOO_LARGE');
 const reader=request.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let size=0,raw='',timer,stop;
 const stopped=new Promise((_,reject)=>{stop=reject;timer=setTimeout(()=>reject(new OriginProposalImportError(408,'ERP_BODY_TIMEOUT')),5000);});stopped.catch(()=>{});
 const abort=()=>stop(new OriginProposalImportError(400,'ERP_REQUEST_ABORTED'));request.signal.addEventListener('abort',abort,{once:true});
 try{for(;;){if(request.signal.aborted)abort();const part=await Promise.race([reader.read(),stopped]);if(part.done)break;if(!(part.value instanceof Uint8Array)||(size+=part.value.length)>4096)fail(413,'ERP_BODY_TOO_LARGE');raw+=decoder.decode(part.value,{stream:true});}
  if(length!==null&&Number(length)!==size)fail();return JSON.parse(raw+decoder.decode());
 }catch(error){if(error instanceof OriginProposalImportError)throw error;fail();}
 finally{clearTimeout(timer);request.signal.removeEventListener('abort',abort);void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{}}
}
export async function parseOriginProposalImportRoute(request){
 const url=new URL(request.url);if(!originProposalImportRoute(url.pathname))return null;
 const s=shape(url.pathname);if(!s)fail(404,'ERP_NOT_FOUND');if(!originProposalImportMethods(url.pathname).includes(request.method))fail(405,'ERP_METHOD_NOT_ALLOWED');
 if(url.hash||request.headers.has('content-encoding')&&request.headers.get('content-encoding')!=='identity')fail();
 let args;
 if(request.method==='POST'){
  if(url.search)fail();const v=await body(request),keys=s.type==='preview'?['source_id']:['source_id','preview_hash','command_id','confirm_import','duplicate_reviewed'];
  if(!exact(v,keys)||!source(v.source_id))fail();args={p_source_id:v.source_id};
  if(s.type==='apply'){if(!uuid(v.command_id)||!hash(v.preview_hash)||v.confirm_import!==true||v.duplicate_reviewed!==true)fail();Object.assign(args,{p_preview_hash:v.preview_hash,p_command_id:v.command_id.toLowerCase(),p_confirm_import:true,p_duplicate_reviewed:true});}
 }else{
  if(request.body!==null)fail();
  if(s.type==='sources'){
   for(const key of url.searchParams.keys())if(!['limit','after','q'].includes(key)||url.searchParams.getAll(key).length!==1)fail();
   const limit=url.searchParams.get('limit')??'25',after=url.searchParams.get('after'),q=url.searchParams.get('q');
   if(!/^[1-9][0-9]?$/.test(limit)||Number(limit)>25||after!==null&&!source(after)||q!==null&&!text(q,100))fail();
   args={p_limit:Number(limit),p_after:after,p_query:q===null?null:q.replace(/^ +| +$/g,'')||null};
  }else{if(url.search)fail();args=s.type==='origin'?{p_source_id:s.id}:s.type==='command'?{p_command_id:s.id}:{p_document_id:s.id};}
 }
 const route=freeze({type:s.type,rpc:s.type==='document_origin'?'erp_origin_proposal_document_origin':'erp_origin_proposal_import_'+s.type,args});ROUTES.add(route);return route;
}
function sourceRow(v){
 if(!object(v)||!source(v.source_id)||!hash(v.source_hash)||!sourceVersion(v.source_version)||!stamp(v.source_seen_at)||!nullable(v.source_number,source)
  ||!nullable(v.source_status,x=>typeof x==='string'&&Array.from(x).length<=80))bad();
 return pick(v,['source_id','source_hash','source_version','source_seen_at','source_number','source_status']);
}
function binding(v,index){
 const keys=['entity','source_id','record_id','record_version','name','unit','active','human_edited','origin_state','candidate_pending','applied_hash','latest_hash','source_hash','source_version','valid'];
 if(!object(v)||v.entity!==(index===0?'contacts':'products')||!nullable(v.source_id,source)||!nullable(v.record_id,uuid)||!nullable(v.record_version,version)
  ||!nullable(v.name,x=>text(x,200,true))||!nullable(v.unit,x=>text(x,16,true))||!nullable(v.active,x=>typeof x==='boolean')||!nullable(v.human_edited,x=>typeof x==='boolean')
  ||!nullable(v.origin_state,x=>['synced','local_modified','source_changed','source_deleted'].includes(x))||typeof v.candidate_pending!=='boolean'||typeof v.valid!=='boolean'
  ||!['applied_hash','latest_hash','source_hash'].every(k=>nullable(v[k],hash))||!nullable(v.source_version,sourceVersion))bad();
 if(index===0&&own(v,'position')||index>0&&(!Number.isInteger(v.position)||v.position<1||v.position>250))bad();
 if(v.valid&&(!source(v.source_id)||!uuid(v.record_id)||!version(v.record_version)||!text(v.name,200,true)||!sourceVersion(v.source_version)||!hash(v.source_hash)
  ||v.active!==true||v.human_edited!==false||v.origin_state!=='synced'||v.candidate_pending||v.applied_hash!==v.source_hash||v.latest_hash!==v.source_hash))bad();
 return{...pick(v,keys),...(index?{position:v.position}:{})};
}
const TEXT_FIELDS={notes:4000,internal_notes:4000,payment_terms:4000,delivery_terms:2000,equipment:200,serial_number:100,technician:200,defect:4000,solution:4000};
function catalogSnapshot(v,id,contact){
 if(id===null){if(v!==null)bad();return null;}
 if(!object(v)||v.id!==id||!version(v.version)||!text(v.name,200,true))bad();
 const fields=contact?{name:200,code:100,document:30,trade_name:200,email:254,phone:40,mobile:40,street:200,number:30,complement:200,district:100,city:100,state:2,postal_code:20}:{name:200,code:100,unit:16,price:25,kind:1,format:1};
 const result={id,version:v.version};for(const[k,max]of Object.entries(fields)){const value=v[k]??null;if(!nullable(value,x=>text(x,max,false)))bad();result[k]=value;}if(!contact&&result.price!==null&&!isCanonicalUnitPrice(result.price,14))bad();return result;
}
function commercial(v,preview){
 if(!object(v)||!day(v.date)||!uuid(v.contact_id)||!nullable(v.warehouse_id,uuid)||!['expected_date','valid_until','next_contact'].every(k=>nullable(v[k],day))||typeof v.template!=='boolean'
  ||!['amount','percent'].includes(v.discount_mode)||!money(v.freight)||!money(v.other_expenses)||!Array.isArray(v.items)||v.items.length<1||v.items.length>250||!Array.isArray(v.installments)||v.installments.length>120)bad();
 if(!decimal(v.discount_value,v.discount_mode==='amount'?12:3,v.discount_mode==='amount'?2:4))bad();
 const result=pick(v,['date','contact_id','warehouse_id','expected_date','valid_until','next_contact','template','discount_mode','discount_value','freight','other_expenses']);
 if(own(v,'commercial')){try{result.commercial=normalizeCommercial(v.commercial);}catch{bad();}}
 for(const[k,max]of Object.entries(TEXT_FIELDS)){if(!nullable(v[k],x=>text(x,max,false,['notes','internal_notes','payment_terms','delivery_terms','defect','solution'].includes(k))))bad();result[k]=v[k];}
 if(['equipment','serial_number','technician','defect','solution'].some(k=>v[k]!==null))bad();
 const seen=new Set();result.items=v.items.map((line,i)=>{
  if(!object(line)||line.position!==i+1||!(preview?line.id===null:uuid(line.id)&&!seen.has(line.id))||!nullable(line.product_id,uuid)||!text(line.description,200,true)||!nullable(line.code,x=>text(x,100))||!text(line.unit,16,true)
   ||!decimal(line.quantity,9,6)||!(preview?decimal(line.unit_price,10,4):isCanonicalUnitPrice(line.unit_price,10))||!decimal(line.discount_percent,3,4))bad();seen.add(line.id);
  if(own(line,'detailed_description')&&!nullable(line.detailed_description,x=>text(x,4000,false,true)))bad();
  return{...pick(line,['id','product_id','description','code','unit','quantity','unit_price','discount_percent','position']),...(own(line,'detailed_description')?{detailed_description:line.detailed_description}:{}),...(preview?{}:{product_snapshot:catalogSnapshot(line.product_snapshot,line.product_id,false)})};
 });
 let calculated;try{calculated=calculateDocument({...result,items:result.items});}catch{bad();}
 if(!object(v.totals)||!Array.isArray(v.totals.items)||v.totals.items.length!==result.items.length)bad();
 for(const[k,value]of Object.entries(calculated))if(k!=='items'&&v.totals[k]!==value)bad();
 result.items=result.items.map((line,i)=>{for(const k of ['gross','discount','total'])if(v.items[i][k]!==calculated.items[i][k]||v.totals.items[i]?.[k]!==calculated.items[i][k])bad();return{...line,...calculated.items[i]};});result.totals=calculated;
 let sum=0n;result.installments=v.installments.map((row,i)=>{if(!object(row)||row.position!==i+1||!day(row.due_date)||!money(row.amount)||cents(row.amount)<=0n||!nullable(row.method,x=>text(x,100)))bad();sum+=cents(row.amount);const out=pick(row,['position','due_date','amount','method']);if(own(row,'note')){if(!nullable(row.note,x=>text(x,2000,false,true)))bad();out.note=row.note;}if(own(row,'payment_reference')){try{out.payment_reference=normalizeCommercialReference(row.payment_reference);}catch{bad();}}return out;});
 if(result.installments.length&&sum!==cents(calculated.total))bad();
 if(preview&&(v.template!==false||v.warehouse_id!==null||v.expected_date!==null||v.valid_until!==null||v.payment_terms!==null||v.discount_mode!=='amount'||v.discount_value!=='0.00'||result.items.some(l=>l.product_id===null||l.discount_percent!=='0.0000')||result.installments.some(r=>r.method!==null)))bad();
 return result;
}
function metadata(v){
 if(!object(v)||!uuid(v.id)||v.kind!=='sales_proposals'||!version(v.version)||typeof v.number!=='string'||!/^[1-9][0-9]{0,9}$/.test(v.number)||!Object.hasOwn(STATES.sales_proposals,v.status)||!stamp(v.created_at)||!stamp(v.updated_at))bad();
 return pick(v,['id','kind','number','status','version','created_at','updated_at']);
}
function documentSummary(v){const meta=metadata(v);if(!day(v.date)||!money(v.total)||!uuid(v.contact_id)||!text(v.contact_name,200,true))bad();return{...meta,...pick(v,['date','total','contact_id','contact_name'])};}
function receipt(v){
 if(!object(v)||!uuid(v.command_id)||v.entity!=='sales_proposals'||!source(v.source_id)||!hash(v.source_hash)||!sourceVersion(v.source_version)||!stamp(v.source_seen_at)||!source(v.source_number)
  ||!['Rascunho','Pendente','Aguardando'].includes(v.source_status)||!hash(v.preview_hash)||v.duplicate_reviewed!==true||!stamp(v.imported_at))bad();
 const document=documentSummary(v.document);if(document.version!==1||document.status!=='draft')bad();
 return{...pick(v,['command_id','entity','source_id','source_hash','source_version','source_seen_at','source_number','source_status','preview_hash','duplicate_reviewed','imported_at']),document};
}
function currentDocument(v,original){
 const meta=metadata(v);if(meta.id!==original.id||meta.number!==original.number||meta.version<original.version||meta.created_at!==original.created_at||v.source_proposal_id!==null||!object(v.effect_flags)||typeof v.effect_flags.finance_active!=='boolean'||typeof v.effect_flags.stock_active!=='boolean')bad();
 const body=commercial(v,false);if(meta.version===1&&(meta.status!=='draft'||body.template!==false||body.date!==original.date||body.contact_id!==original.contact_id||body.totals.total!==original.total))bad();
 return{...body,...meta,source_proposal_id:null,contact_snapshot:catalogSnapshot(v.contact_snapshot,body.contact_id,true),effect_flags:pick(v.effect_flags,['finance_active','stock_active'])};
}
export function originProposalImportResponse(raw,route){
 if(!object(raw))bad();
 if(route.type==='document_origin'){
  if(raw.data_mode!=='erp_native'||raw.read_only!==true||raw.document_id!==route.args.p_document_id||!Object.hasOwn(STATES,raw.kind))bad();let origin=null;
  if(raw.origin!==null){const o=raw.origin;if(!object(o)||raw.kind!=='sales_proposals'||o.system!=='origin'||o.entity!=='sales_proposals'||!source(o.source_id)||!source(o.source_number)||!hash(o.source_hash)||!sourceVersion(o.source_version)||!uuid(o.command_id)||!stamp(o.imported_at))bad();if(own(o,'policy')&&!['origin-open-proposal-v1','origin-open-proposal-v2'].includes(o.policy))bad();origin={...pick(o,['system','entity','source_id','source_number','source_hash','source_version','command_id','imported_at']),...(own(o,'policy')?{policy:o.policy}:{})};}
  return{data_mode:'erp_native',read_only:true,document_id:raw.document_id,kind:raw.kind,origin};
 }
 if(Object.entries(FLAGS).some(([k,v])=>raw[k]!==v))bad();
 if(route.type==='sources'){
  if(raw.read_only!==true||raw.limit!==route.args.p_limit||!Array.isArray(raw.items)||raw.items.length>raw.limit||typeof raw.has_more!=='boolean'||raw.has_more&&raw.items.length!==raw.limit)bad();
  let last=route.args.p_after;const rows=raw.items.map(v=>{const row=sourceRow(v);if(v.requires_preview!==true||!nullable(v.document_id,uuid)||last!==null&&row.source_id<=last||route.args.p_query!==null&&!row.source_id.includes(route.args.p_query)&&!row.source_number?.includes(route.args.p_query))bad();last=row.source_id;return{...row,document_id:v.document_id,requires_preview:true};});
  const next=raw.has_more?rows.at(-1).source_id:null;if(raw.next_cursor!==next)bad();
  return{...FLAGS,read_only:true,items:rows,limit:raw.limit,has_more:raw.has_more,next_cursor:next};
 }
 if(route.type==='preview'){
  const s=sourceRow(raw);if(s.source_id!==route.args.p_source_id||raw.dry_run!==true||raw.persisted!==false||!stamp(raw.source_changed_at)||!hash(raw.preview_hash)||typeof raw.can_apply!=='boolean'
   ||!Array.isArray(raw.issues)||raw.issues.length>4096||!Array.isArray(raw.bindings)||raw.bindings.length<1||raw.bindings.length>251||JSON.stringify(raw.warnings)!==JSON.stringify(WARNINGS))bad();
  const issues=raw.issues.map(v=>{if(!object(v)||!ORIGIN_PROPOSAL_IMPORT_ISSUES.includes(v.code)||!nullable(v.field,x=>FIELDS.includes(x))||!nullable(v.position,x=>Number.isInteger(x)&&x>=1&&x<=(v.code.startsWith('INSTALLMENT')?120:250)))bad();return pick(v,['code','field','position']);});
  const bindings=raw.bindings.map(binding);for(let i=2;i<bindings.length;i++)if(bindings[i].position<=bindings[i-1].position)bad();
  let existing=null;if(raw.existing!==null){const e=raw.existing;if(!object(e)||!uuid(e.document_id)||!uuid(e.command_id)||!stamp(e.imported_at))bad();existing=pick(e,['document_id','command_id','imported_at']);}
  if(raw.can_apply!==(issues.length===0)||Boolean(existing)!==issues.some(i=>i.code==='ALREADY_IMPORTED')||raw.can_apply&&(existing!==null||!['Rascunho','Pendente','Aguardando'].includes(s.source_status)||!source(s.source_number)))bad();
  let proposed=null;if(raw.can_apply){proposed=commercial(raw.proposed,true);if(bindings.length!==proposed.items.length+1||bindings.some(b=>!b.valid)||bindings[0].record_id!==proposed.contact_id)bad();for(const[i,item]of proposed.items.entries())if(bindings[i+1].position!==i+1||bindings[i+1].record_id!==item.product_id||bindings[i+1].unit!==item.unit)bad();}else if(raw.proposed!==null)bad();
  return{...FLAGS,...s,source_changed_at:raw.source_changed_at,dry_run:true,persisted:false,can_apply:raw.can_apply,issues,bindings,warnings:[...WARNINGS],proposed,existing,preview_hash:raw.preview_hash};
 }
 const r=receipt(raw.receipt);
 if(route.type==='apply'){
  if(raw.dry_run!==false||raw.persisted!==true||typeof raw.replayed!=='boolean'||r.command_id!==route.args.p_command_id||r.source_id!==route.args.p_source_id||r.preview_hash!==route.args.p_preview_hash)bad();
  return{...FLAGS,dry_run:false,persisted:true,replayed:raw.replayed,receipt:r};
 }
 if(raw.read_only!==true||route.type==='command'&&r.command_id!==route.args.p_command_id||route.type==='origin'&&r.source_id!==route.args.p_source_id)bad();
 return{...FLAGS,read_only:true,receipt:r,current_document:currentDocument(raw.current_document,r.document)};
}
function mapped(error,mutating,started){
 if(error instanceof OriginProposalImportError){if(mutating&&started&&error.status===502)fail(503,'ERP_RESULT_UNCONFIRMED');throw error;}
 const codes={42501:[403,'ERP_FORBIDDEN'],22023:[422,'ERP_VALIDATION_FAILED'],P0002:[404,'ERP_NOT_FOUND'],40001:[409,'ERP_CONFLICT'],23505:[409,'ERP_CONFLICT']};
 if(Object.hasOwn(codes,error?.code))fail(...codes[error.code]);
 if([400,401,403,404,409,422].includes(error?.status))fail(error.status,({400:'ERP_INVALID_QUERY',401:'ERP_UNAUTHORIZED',403:'ERP_FORBIDDEN',404:'ERP_NOT_FOUND',409:'ERP_CONFLICT',422:'ERP_VALIDATION_FAILED'})[error.status]);
 fail(mutating&&started?503:502,mutating&&started?'ERP_RESULT_UNCONFIRMED':'ERP_UPSTREAM_UNAVAILABLE');
}
export async function executeOriginProposalImportRoute(route,{userId,rpc,signal,timeoutMs=15000}={}){
 if(!route||!ROUTES.has(route))fail(404,'ERP_NOT_FOUND');if(!uuid(userId))fail(401,'ERP_UNAUTHORIZED');if(typeof rpc!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000||signal!==undefined&&!(signal instanceof AbortSignal))bad();
 const actor=userId.toLowerCase(),mutating=route.type==='apply',controller=new AbortController();let timer,stop,started=false;
 const interrupted=()=>new OriginProposalImportError(started&&mutating?503:400,started&&mutating?'ERP_RESULT_UNCONFIRMED':'ERP_REQUEST_ABORTED');
 const stopped=new Promise((_,reject)=>{stop=reject;timer=setTimeout(()=>{controller.abort();reject(new OriginProposalImportError(503,started&&mutating?'ERP_RESULT_UNCONFIRMED':'ERP_UPSTREAM_TIMEOUT'));},timeoutMs);});stopped.catch(()=>{});
 const abort=()=>{controller.abort();stop(interrupted());};signal?.addEventListener('abort',abort,{once:true});
 try{
  if(signal?.aborted)throw interrupted();const raw=await Promise.race([Promise.resolve().then(()=>{if(controller.signal.aborted)throw interrupted();started=true;return rpc(route.rpc,{...route.args,p_user_id:actor},{signal:controller.signal});}),stopped]);
  if(controller.signal.aborted)throw interrupted();const result=originProposalImportResponse(raw,route);if(new TextEncoder().encode(JSON.stringify(result)).length>ORIGIN_PROPOSAL_IMPORT_RESPONSE_BYTES)bad();return result;
 }catch(error){mapped(error,mutating,started);}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();}
}
