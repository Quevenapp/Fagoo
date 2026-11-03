import type {NativeRequestOptions} from './real-access';
import type {FiscalDraftEnvelope} from './fiscal-drafts-model';
import type {FiscalItemEnvelope} from './fiscal-item-model';
import {taxBasisReady,taxChoicesFromReceipt,type TaxEnvelope} from './fiscal-tax-model.ts';
import {COMPLETION_FLAGS,COMPLETION_TOTAL_FIELDS,COMPLETION_EXCLUDED_FIELDS,resolveBusinessCompletion,type CompletionItemBasis} from '../../../../packages/fiscal-core/src/business-completion.mjs';

export const COMPLETION_BASE='/v1/complemento-fiscal';
export interface FiscalCompletionController{
 fiscalCompletion(path:string,options?:NativeRequestOptions):Promise<unknown>;
 fiscalItem(path:string,options?:NativeRequestOptions):Promise<unknown>;
 fiscalTax(path:string,options?:NativeRequestOptions):Promise<unknown>;
 fiscalDraft(path:string,options?:NativeRequestOptions):Promise<unknown>;
 /** 202610200215: the contact cadastro (Contribuinte) for the initial indIEDest; optional, an older shell has no notes route. */
 fiscalInvoices?(path:string,options?:NativeRequestOptions):Promise<unknown>;
}
export type CompletionMoney=string|null;
export type CompletionItem={item_id:string;tributary:{unit:string|null;quantity:string|null;unit_price:string|null};allocations:{global_discount:CompletionMoney;freight:CompletionMoney;other:CompletionMoney};cest_absence:'omit'|null;icms:{credit:null|{base:CompletionMoney;amount:CompletionMoney};groups500:null|{retention:'include'|'omit'|null;fcp:'include'|'omit'|null;effective:'include'|'omit'|null}}};
export type CompletionPayment={type:'01'|'15'|null;timing:'0'|'1'|null;amount:CompletionMoney};
export interface Completion{
 operation:{tpNF:'1'|null;idDest:'1'|null;finNFe:'1'|null;indFinal:'0'|'1'|null;indPres:'1'|null};
 recipient:{municipality_code:string|null;indIEDest:'1'|'2'|'9'|null};items:CompletionItem[];
 totals:Record<string,CompletionMoney>;payments:{items:CompletionPayment[];change:CompletionMoney};
 transport_mode:'0'|'1'|'2'|'3'|'4'|'9'|null;excluded_groups:Record<string,'not_included_in_profile'|null>;
 homologation_labels:'apply_test_labels'|null;additional_information:string|null;
}
export interface CompletionPending{general:string[];items:{item_id:string;position:number;codes:string[]}[];}
export interface CompletionSummary{draft_id:string;version:number;draft_version:number;snapshot_hash:string;item_preparation_version:number;tax_preparation_version:number;item_preparation_hash:string;tax_preparation_hash:string;model:'55'|'65';environment:'2';company_identity_version:number;company_fiscal_version:number;source_document_id:string;source_document_version:number;created_at:string|null;}
export interface CompletionReceipt extends CompletionSummary{item_basis:CompletionItemBasis[];completion:Completion;pending:CompletionPending;}
export interface CompletionCurrent{completion_version:number;draft_version:number;draft_status:'draft'|'archived';source_document_version:number;source_status:string;source_changed:boolean;company_changed:boolean;identity_version:number|null;fiscal_version:number|null;item_preparation_version:number;tax_preparation_version:number;matches_current_draft:boolean;matches_current_item_preparation:boolean;matches_current_tax_preparation:boolean;matches_current_company:boolean;}
export interface CompletionEnvelope{record:CompletionReceipt|null;current:CompletionCurrent;persisted?:false;expected_completion_version?:number;replayed?:boolean;}
export interface CompletionHistory{draft_id:string;items:CompletionSummary[];limit:25;has_more:boolean;next_cursor:number|null;}
export interface CompletionWrite{expected_draft_version:number;snapshot_hash:string;item_preparation_version:number;tax_preparation_version:number;expected_identity_version:number;expected_fiscal_version:number;expected_completion_version:number;completion:Completion;command_id?:string;}
export interface CompletionBasis{model:'55'|'65';items:CompletionItemBasis[];itemVersion:number;taxVersion:number;identityVersion:number;fiscalVersion:number;}
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/,HASH=/^[a-f0-9]{64}$/;
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&UUID.test(v),hash=(v:unknown)=>typeof v==='string'&&HASH.test(v);
const version=(v:unknown,min=1):v is number=>Number.isInteger(v)&&(v as number)>=min&&(v as number)<=2147483647;
const equal=(a:unknown,b:unknown):boolean=>a===b||Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((v,i)=>equal(v,b[i]))||object(a)&&object(b)&&Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>Object.hasOwn(b,k)&&equal(a[k],b[k]));
function bad():never{throw new Error('Não foi possível conferir o complemento fiscal. Consulte novamente as versões atuais.');}
function stamp(v:unknown):v is string{if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(v))return false;const[y,m,d,h,mi,s]=v.slice(0,19).split(/[-T:]/).map(Number),off=v.endsWith('Z')?[0,0]:v.slice(-5).split(':').map(Number);return y>=2000&&m>=1&&m<=12&&d>=1&&d<=new Date(Date.UTC(y,m,0)).getUTCDate()&&h<=23&&mi<=59&&s<=59&&off[0]<=14&&off[1]<=59&&(off[0]!==14||off[1]===0)&&Number.isFinite(Date.parse(v));}
function flags(v:unknown):asserts v is Record<string,unknown>{if(!object(v)||Object.entries(COMPLETION_FLAGS).some(([k,x])=>v[k]!==x))bad();}
const metaKeys=['draft_id','version','draft_version','snapshot_hash','item_preparation_version','tax_preparation_version','item_preparation_hash','tax_preparation_hash','model','environment','company_identity_version','company_fiscal_version','source_document_id','source_document_version','created_at'] as const;
function summary(v:unknown,draftId:string,preview=false):CompletionSummary{
 if(!object(v)||v.draft_id!==draftId||!['version','draft_version','item_preparation_version','tax_preparation_version','company_identity_version','company_fiscal_version','source_document_version'].every(k=>version(v[k]))||!['snapshot_hash','item_preparation_hash','tax_preparation_hash'].every(k=>hash(v[k]))||!['55','65'].includes(String(v.model))||v.environment!=='2'||!id(v.source_document_id)||(preview?v.created_at!==null:!stamp(v.created_at)))bad();
 return Object.fromEntries(metaKeys.map(k=>[k,v[k]])) as unknown as CompletionSummary;
}
export function completionEnvelope(raw:unknown,draftId:string,options:{version?:number;request?:CompletionWrite;preview?:boolean}={}):CompletionEnvelope{
 flags(raw);if(!id(draftId))bad();let record:CompletionReceipt|null=null;
 if(raw.record!==null){const meta=summary(raw.record,draftId,options.preview),r=raw.record as Record<string,unknown>;let resolved:ReturnType<typeof resolveBusinessCompletion>;
  try{resolved=resolveBusinessCompletion(r.completion,{model:meta.model,items:r.item_basis as CompletionItemBasis[]});}catch{bad();}
  if(!equal(resolved.pending,r.pending))bad();record={...meta,item_basis:structuredClone(r.item_basis as CompletionItemBasis[]),completion:resolved.completion as unknown as Completion,pending:resolved.pending};
  if(options.request){const p=options.request;if(meta.version!==p.expected_completion_version+1||meta.draft_version!==p.expected_draft_version||meta.snapshot_hash!==p.snapshot_hash||meta.item_preparation_version!==p.item_preparation_version||meta.tax_preparation_version!==p.tax_preparation_version||meta.company_identity_version!==p.expected_identity_version||meta.company_fiscal_version!==p.expected_fiscal_version||!equal(record.completion,p.completion))bad();}
 }
 const c=raw.current;if(!object(c)||!version(c.completion_version,0)||!version(c.draft_version)||!version(c.source_document_version)||!['draft','archived'].includes(String(c.draft_status))||!['draft','open','verified','in_progress','agency_sale','checkout_partial','partially_fulfilled','partially_invoiced','fulfilled','cancelled'].includes(String(c.source_status))||!['identity_version','fiscal_version'].every(k=>c[k]===null||version(c[k]))||!['item_preparation_version','tax_preparation_version'].every(k=>version(c[k],0))||!['source_changed','company_changed','matches_current_draft','matches_current_item_preparation','matches_current_tax_preparation','matches_current_company'].every(k=>typeof c[k]==='boolean'))bad();
 const matches={matches_current_draft:record!==null&&record.draft_version===c.draft_version,matches_current_item_preparation:record!==null&&record.item_preparation_version===c.item_preparation_version,matches_current_tax_preparation:record!==null&&record.tax_preparation_version===c.tax_preparation_version,matches_current_company:record!==null&&record.company_identity_version===c.identity_version&&record.company_fiscal_version===c.fiscal_version};
 if(Object.entries(matches).some(([k,v])=>c[k]!==v))bad();
 if(record&&(c.draft_version<record.draft_version||c.source_document_version<record.source_document_version||(c.item_preparation_version as number)<record.item_preparation_version||(c.tax_preparation_version as number)<record.tax_preparation_version))bad();
 if(matches.matches_current_draft&&(c.source_changed!==(c.source_document_version!==record!.source_document_version)||c.company_changed!==!matches.matches_current_company))bad();
 if(record===null){if(options.request||options.version!==undefined||c.completion_version!==0)bad();}
 else if(options.preview?record.version!==c.completion_version+1:record.version>c.completion_version)bad();
 if(!options.request&&record&&record.version!==(options.version??c.completion_version))bad();
 if(options.preview){if(!options.request||!record||raw.persisted!==false||raw.expected_completion_version!==options.request.expected_completion_version||Object.values(matches).some(v=>!v)||c.source_changed||c.company_changed||c.draft_status!=='draft'||c.source_status==='cancelled')bad();}else if(options.request&&typeof raw.replayed!=='boolean')bad();
 const keys=['completion_version','draft_version','draft_status','source_document_version','source_status','source_changed','company_changed','identity_version','fiscal_version','item_preparation_version','tax_preparation_version','matches_current_draft','matches_current_item_preparation','matches_current_tax_preparation','matches_current_company'];
 return{record,current:Object.fromEntries(keys.map(k=>[k,c[k]])) as unknown as CompletionCurrent,...(options.preview?{persisted:false,expected_completion_version:raw.expected_completion_version as number}:options.request?{replayed:raw.replayed as boolean}:{})};
}
export function completionHistory(raw:unknown,draftId:string,before:number|null):CompletionHistory{
 flags(raw);if(raw.draft_id!==draftId||raw.limit!==25||!Array.isArray(raw.items)||raw.items.length>25||typeof raw.has_more!=='boolean'||raw.has_more&&raw.items.length!==25)bad();let previous=before??2147483648,model:string|null=null,source:string|null=null;
 const items=raw.items.map(v=>{const row=summary(v,draftId);if(row.version>=previous||model!==null&&model!==row.model||source!==null&&source!==row.source_document_id)bad();previous=row.version;model=row.model;source=row.source_document_id;return row;});const next=raw.has_more?items.at(-1)?.version:null;if(raw.next_cursor!==next)bad();return{draft_id:draftId,items,limit:25,has_more:raw.has_more,next_cursor:next??null};
}
export function completionBasis(draft:FiscalDraftEnvelope,items:FiscalItemEnvelope|null,tax:TaxEnvelope|null,current:CompletionCurrent):CompletionBasis|null{
 if(!items?.record||!tax?.record||!taxBasisReady(draft,items)||!tax.current.matches_current_draft||!tax.current.matches_current_item_preparation||tax.current.tax_version!==tax.record.version||tax.current.draft_status!=='draft'||tax.current.source_status==='cancelled'||tax.current.source_changed||tax.current.company_changed)return null;
 const d=draft.record,t=tax.record,company=d.snapshot.company;
 if(!company||current.draft_version!==d.version||current.draft_status!=='draft'||current.source_status==='cancelled'||current.source_changed||current.company_changed||current.source_document_version!==d.source_document_version||current.identity_version!==company.identity_version||current.fiscal_version!==company.fiscal_version||current.item_preparation_version!==items.record.version||current.tax_preparation_version!==t.version||tax.current.item_preparation_version!==items.record.version)return null;
 const choices=taxChoicesFromReceipt(t,draft,items);if(Object.keys(choices).length!==d.snapshot.items.length)return null;
 return{model:d.model,items:t.items.map(i=>({item_id:i.item_id,position:i.position,cest:i.identifiers.cest,csosn:i.decisions.icms?.csosn??null})),itemVersion:items.record.version,taxVersion:t.version,identityVersion:company.identity_version!,fiscalVersion:company.fiscal_version!};
}
export function emptyCompletion(itemIds:string[]):Completion{return{operation:{tpNF:null,idDest:null,finNFe:null,indFinal:null,indPres:null},recipient:{municipality_code:null,indIEDest:null},items:itemIds.map(item_id=>({item_id,tributary:{unit:null,quantity:null,unit_price:null},allocations:{global_discount:null,freight:null,other:null},cest_absence:null,icms:{credit:null,groups500:null}})),totals:Object.fromEntries(COMPLETION_TOTAL_FIELDS.map(k=>[k,null])),payments:{items:[],change:null},transport_mode:null,excluded_groups:Object.fromEntries(COMPLETION_EXCLUDED_FIELDS.map(k=>[k,null])),homologation_labels:null,additional_information:null};}
export function completionFromReceipt(receipt:CompletionReceipt|null,draft:FiscalDraftEnvelope,basis:CompletionBasis|null):Completion{
 const blank=()=>emptyCompletion(draft.record.snapshot.items.map(i=>i.id));if(!receipt||!basis)return blank();const d=draft.record;
 if(receipt.draft_id!==d.id||receipt.draft_version!==d.version||receipt.snapshot_hash!==d.snapshot_hash||receipt.item_preparation_version!==basis.itemVersion||receipt.tax_preparation_version!==basis.taxVersion||receipt.company_identity_version!==basis.identityVersion||receipt.company_fiscal_version!==basis.fiscalVersion)return blank();
 if(receipt.source_document_id!==d.source_document_id||receipt.source_document_version!==d.source_document_version||receipt.model!==d.model||!equal(receipt.item_basis,basis.items))bad();return structuredClone(receipt.completion);
}
export function completionKey(value:Completion):string{const canonical=(v:unknown):unknown=>Array.isArray(v)?v.map(canonical):object(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;return JSON.stringify(canonical(value));}
export function completionWrite(draft:FiscalDraftEnvelope,basis:CompletionBasis|null,current:CompletionCurrent,value:Completion):CompletionWrite{
 if(!basis||!version(current.completion_version,0)||current.completion_version===2147483647)throw new Error('Recarregue o rascunho, os identificadores e a preparação tributária atuais antes de continuar.');
 try{resolveBusinessCompletion(value,basis);}catch{throw new Error('Confira os formatos dos campos. Deixe vazio o que ainda não foi informado; use duas casas decimais nos valores monetários.');}
 const body:CompletionWrite={expected_draft_version:draft.record.version,snapshot_hash:draft.record.snapshot_hash,item_preparation_version:basis.itemVersion,tax_preparation_version:basis.taxVersion,expected_identity_version:basis.identityVersion,expected_fiscal_version:basis.fiscalVersion,expected_completion_version:current.completion_version,completion:structuredClone(value)};
 if(new TextEncoder().encode(JSON.stringify(body)).length>523000)throw new Error('O complemento ultrapassa o tamanho permitido. Reduza as observações.');return body;
}
export function completionHistoricalDraft(record:CompletionReceipt,draft:FiscalDraftEnvelope):void{if(record.draft_id!==draft.record.id||record.draft_version!==draft.record.version||record.snapshot_hash!==draft.record.snapshot_hash||record.model!==draft.record.model||record.source_document_id!==draft.record.source_document_id||record.source_document_version!==draft.record.source_document_version||record.item_basis.length!==draft.record.snapshot.items.length||record.item_basis.some((i,n)=>i.item_id!==draft.record.snapshot.items[n].id||i.position!==draft.record.snapshot.items[n].position))bad();}
export const completionInput=(v:string):string|null=>v===''?null:v.replace(/,/g,'.');
export const completionDisplay=(v:string|null):string=>v===null?'':v.replace('.',',');
export const COMPLETION_TOTAL_LABELS:Record<string,string>={vBC:'Base de cálculo do ICMS',vICMS:'ICMS',vICMSDeson:'ICMS desonerado',vFCP:'Fundo de combate à pobreza',vBCST:'Base do ICMS por substituição tributária',vST:'ICMS por substituição tributária',vFCPST:'Fundo de combate à pobreza por substituição',vFCPSTRet:'Fundo de combate à pobreza retido',vProd:'Produtos',vFrete:'Frete',vSeg:'Seguro',vDesc:'Desconto',vII:'Imposto de importação',vIPI:'IPI',vIPIDevol:'IPI devolvido',vPIS:'PIS',vCOFINS:'Cofins',vOutro:'Outras despesas',vNF:'Total da nota'};
export const COMPLETION_EXCLUDED_LABELS:Record<string,string>={ipi:'IPI',ii:'Imposto de importação',issqn:'Imposto sobre serviços',ibs_cbs:'IBS e CBS',is:'Imposto seletivo',monophase:'Tributação monofásica',destination_icms:'ICMS de destino'};
export const COMPLETION_PENDING:Record<string,string>={ARITHMETIC_NOT_CHECKED:'Os valores e somas ainda não foram conferidos.',TAX_APPLICABILITY_UNVERIFIED:'A aplicabilidade tributária precisa de revisão.',RTC_APPLICABILITY_UNVERIFIED:'As regras da reforma tributária precisam de revisão.',NUMBERING_NOT_BOUND:'Nenhum número fiscal está vinculado a este complemento.',XML_NOT_GENERATED:'Nenhum XML foi gerado.',OPERATION_UNPREPARED:'Complete as escolhas da operação.',RECIPIENT_UNPREPARED:'Complete as informações fiscais do destinatário.',TOTALS_UNPREPARED:'Há totais ainda não informados.',PAYMENTS_UNPREPARED:'A declaração dos pagamentos e do troco está incompleta.',TRANSPORT_UNPREPARED:'A responsabilidade pelo transporte não foi escolhida.',EXCLUDED_GROUPS_UNREVIEWED:'Há grupos tributários cuja ausência ainda não foi revisada.',HOMOLOGATION_LABELS_UNREVIEWED:'Os textos obrigatórios de teste ainda não foram confirmados.',TRIBUTARY_UNPREPARED:'Unidade, quantidade ou preço tributário não informado.',QUANTITY_PRECISION_REVIEW:'A quantidade tem precisão que exige revisão antes de gerar XML; nenhum arredondamento foi feito.',ALLOCATIONS_UNPREPARED:'Desconto, frete ou outras despesas do item não informados.',CEST_OMISSION_UNREVIEWED:'A ausência de CEST ainda não foi revisada.',ICMS_BRANCH_UNPREPARED:'O enquadramento de ICMS ainda não foi escolhido na preparação tributária.',CREDIT_UNPREPARED:'A base ou o valor do crédito de ICMS não foi informado.',RETENTION_GROUPS_UNREVIEWED:'A inclusão dos grupos de retenção, fundo e ICMS efetivo precisa de revisão.'};
