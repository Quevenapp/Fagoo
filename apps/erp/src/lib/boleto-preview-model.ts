import type {Itau109PrintPreview,Itau109OperationalPrintPreviewV2} from '../../../../packages/boleto-preview/src/index.mjs';
export const BOLETO_BASE='/v1/boletos-itau',BOLETO_RESPONSE_BYTES=196608;
const ID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/,HASH=/^[a-f0-9]{64}$/;
const id=(v:unknown):v is string=>typeof v==='string'&&ID.test(v),hash=(v:unknown)=>typeof v==='string'&&HASH.test(v);
const integer=(v:unknown):v is number=>Number.isInteger(v)&&Number(v)>0&&Number(v)<=2147483647;
const fail=():never=>{throw new Error('Não foi possível conferir esta prévia. Atualize a remessa e tente novamente.');};
function object(v:unknown,keys:string[]):Record<string,unknown>{
 if(!v||typeof v!=='object'||![null,Object.prototype].includes(Object.getPrototypeOf(v)))return fail();
 const ds=Object.getOwnPropertyDescriptors(v),own=Reflect.ownKeys(ds);
 if(own.length!==keys.length||own.some(k=>typeof k!=='string'||!keys.includes(k)||!ds[k].enumerable||!('value'in ds[k])))return fail();
 return Object.fromEntries(keys.map(k=>[k,ds[k].value]));
}
const day=(v:unknown)=>typeof v==='string'&&/^20\d{2}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
export interface BoletoSource {id:string;profile_id:string;file_hash:string|null;state:string;kind:string;}
export type BoletoPurpose='homologation'|'operational';
export interface BoletoItem {billing_title_id:string;finance_title_id:string;document_number:string;amount_cents:string;due_on:string;}
export interface BoletoItems {data_mode:'itau_boleto_items_readonly';read_only:true;can_pay:false;remittance_id:string;profile_id:string;source_purpose:BoletoPurpose;state:'ready';remittance_hash:string;items:readonly BoletoItem[];}
export type BoletoPreview = (Itau109PrintPreview|Itau109OperationalPrintPreviewV2) & {
 data_mode:'itau_boleto_preview_readonly';source_purpose:BoletoPurpose;persisted:false;counters_changed:false;persisted_number_binding_checked:true;beneficiary_address_source:'company_identity_current';
 source:{billing_title_id:string;remittance_id:string;profile_id:string;finance_title_id:string;remittance_hash:string;snapshot_hash:string;context_hash:string;company_identity_version:number};
 current:{title_version:number;contact_version:number;profile_version:number;approval_version:number|null;company_identity_version:number;title_status:'open';title_cancelled:false;settled_cents:'0'};
}
export function captureBoletoRead(path:string,options:unknown={}){
 if(typeof path!=='string'||!new RegExp(`^${BOLETO_BASE}/(?:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/preview|remittances/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/items)$`).test(path))return fail();
 if(!options||typeof options!=='object')return fail();
 const keys=Reflect.ownKeys(options);if(keys.some(k=>typeof k!=='string'||!['method','signal'].includes(k)))return fail();
 const v=object(options,keys as string[]);if(v.method!==undefined&&v.method!=='GET'||v.signal!==undefined&&!(v.signal instanceof AbortSignal))return fail();
 return Object.freeze({method:'GET' as const,...(v.signal?{signal:v.signal as AbortSignal}:{})});
}
export function boletoItems(value:unknown,file:BoletoSource,purpose:BoletoPurpose):BoletoItems{
 const v=object(value,['data_mode','read_only','can_pay','remittance_id','profile_id','source_purpose','state','remittance_hash','items']);
 if(v.data_mode!=='itau_boleto_items_readonly'||v.read_only!==true||v.can_pay!==false||v.remittance_id!==file.id||!id(v.remittance_id)||v.profile_id!==file.profile_id||!id(v.profile_id)||v.source_purpose!==purpose||v.state!=='ready'||file.state!=='ready'||file.kind!=='remittance'||v.remittance_hash!==file.file_hash||!hash(v.remittance_hash)||!Array.isArray(v.items)||v.items.length<1||v.items.length>30)return fail();
 let prior='';const seen=new Set();const items=v.items.map(raw=>{
  const r=object(raw,['billing_title_id','finance_title_id','document_number','amount_cents','due_on']);
  if(!id(r.billing_title_id)||r.billing_title_id<=prior||!id(r.finance_title_id)||seen.has(r.finance_title_id)||typeof r.document_number!=='string'||!/^[A-Z0-9 .&/-]{1,10}$/.test(r.document_number)||typeof r.amount_cents!=='string'||!/^[1-9][0-9]{0,12}$/.test(r.amount_cents)||!day(r.due_on))return fail();
  prior=r.billing_title_id;seen.add(r.finance_title_id);return Object.freeze(r) as unknown as BoletoItem;
 });return Object.freeze({...v,items:Object.freeze(items)}) as unknown as BoletoItems;
}
const CSP="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const TAGS=new Set('html head meta title style body main header h1 p section div span small strong br svg rect text g'.split(' '));
function inactiveHtml(html:string){
 if(!html.startsWith('<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">')||!html.endsWith('</body></html>')||/<!--|<!\[CDATA|<\?/.test(html))return fail();
 const meta=html.match(/<meta\b[^>]*>/g)??[];
 if(meta.length!==4||meta[0]!=='<meta charset="utf-8">'||meta[1]!=='<meta name="viewport" content="width=device-width, initial-scale=1">'||meta[2]!==`<meta http-equiv="Content-Security-Policy" content="${CSP}">`||meta[3]!=='<meta name="referrer" content="no-referrer">')return fail();
 const css=/<style>([\s\S]*?)<\/style>/.exec(html)?.[1];
 if(!css||(html.match(/<style>/g)??[]).length!==1||(html.match(/<\/style>/g)??[]).length!==1||/url\s*\(|@import|@font-face|expression\s*\(|behavior\s*:|\\/i.test(css))return fail();
 for(const m of html.matchAll(/<\/?([A-Za-z][A-Za-z0-9:-]*)\b([^>]*)>/g))if(!TAGS.has(m[1])||/\s(?:on[A-Za-z0-9_-]*|(?:xlink:)?href|src|srcset|action|formaction|style)\s*=/i.test(m[2]))return fail();
 if(!html.includes('PRÉVIA DE TESTE — NÃO PAGAR')||!html.includes('SEM VALIDADE PARA PAGAMENTO'))return fail();
}
const FALSE=['printedLayoutValidatedByBank','bankRegistered','bankAcceptanceVerified','homologationVerified','numberAllocationVerified','financialMutationPerformed','bankTransmissionPerformed','canIssue','canTransmit','canPay','persisted','counters_changed'];
export async function boletoPreview(value:unknown,list:BoletoItems,item:BoletoItem):Promise<BoletoPreview>{
 if(!value||typeof value!=='object')return fail();
 const profileDescriptor=Object.getOwnPropertyDescriptor(value,'renderProfile');
 const v2=!!profileDescriptor&&'value'in profileDescriptor&&profileDescriptor.value==='itau109-print-preview-v2';
 const v=object(value,['purpose','renderProfile','mimeType','html','htmlHash','sizeBytes','binding','fullBoletoRendered',...FALSE,'pending','dimensions','data_mode','source_purpose','persisted_number_binding_checked','beneficiary_address_source','source','current',...(v2?['encoding']:[])]);
 if(v.purpose!=='offline-print-preview'||(!v2&&v.renderProfile!=='itau109-print-preview-v1')||v.mimeType!=='text/html'||v.fullBoletoRendered!==true||FALSE.some(k=>v[k]!==false)||v.data_mode!=='itau_boleto_preview_readonly'||v.source_purpose!==list.source_purpose||v.persisted_number_binding_checked!==true||v.beneficiary_address_source!=='company_identity_current')return fail();
 const s=object(v.source,['billing_title_id','remittance_id','profile_id','finance_title_id','remittance_hash','snapshot_hash','context_hash','company_identity_version']);
 if(s.billing_title_id!==item.billing_title_id||s.finance_title_id!==item.finance_title_id||s.remittance_id!==list.remittance_id||s.profile_id!==list.profile_id||s.remittance_hash!==list.remittance_hash||!hash(s.snapshot_hash)||!hash(s.context_hash)||!integer(s.company_identity_version))return fail();
 const c=object(v.current,['title_version','contact_version','profile_version','approval_version','company_identity_version','title_status','title_cancelled','settled_cents']);
 if(!['title_version','contact_version','profile_version','company_identity_version'].every(k=>integer(c[k]))||c.company_identity_version!==s.company_identity_version||(list.source_purpose==='operational'?!integer(c.approval_version):c.approval_version!==null)||c.title_status!=='open'||c.title_cancelled!==false||c.settled_cents!=='0')return fail();
 const b=object(v.binding,['bank','wallet','barcode','digitableLine','amountCents','dueOn','referenceOn','ourNumberWithDigit','documentNumber']);
 if(b.bank!=='341'||b.wallet!=='109'||b.amountCents!==item.amount_cents||!/^[1-9][0-9]{0,9}$/.test(String(b.amountCents))||b.dueOn!==item.due_on||b.documentNumber!==item.document_number||!day(b.referenceOn)||typeof b.barcode!=='string'||!/^3419\d{40}$/.test(b.barcode)||typeof b.digitableLine!=='string'||!/^\d{47}$/.test(b.digitableLine)||typeof b.ourNumberWithDigit!=='string'||!/^\d{9}$/.test(b.ourNumberWithDigit)||b.barcode.slice(9,19)!==b.amountCents.padStart(10,'0'))return fail();
 if(v2){
  if(list.source_purpose!=='operational')return fail();
  const e=object(v.encoding,['profile','policyHash','approvalVersion','compatibilityConfirmed','permanentInstructionsAcknowledged','terms']);
  if(!hash(e.policyHash)||!integer(e.approvalVersion)||!integer(c.approval_version)||e.approvalVersion>c.approval_version)return fail();
  if(e.profile==='itau109-origin-observed-v1'){
   if(e.compatibilityConfirmed!==true||e.permanentInstructionsAcknowledged!==true)return fail();
   const t=object(e.terms,['profile','version','dailyInterestCents','interestDateField','penaltyPercentHundredths','penaltyDateField','zeroDailyInterestConfirmed']);
   if(t.profile!==e.profile||t.version!==1||typeof t.dailyInterestCents!=='string'||t.dailyInterestCents!==((BigInt(item.amount_cents)+1500n)/3000n).toString()||t.interestDateField!==item.due_on||t.penaltyPercentHundredths!=='200'||t.penaltyDateField!==new Date(Date.parse(item.due_on+'T00:00:00Z')+86400000).toISOString().slice(0,10)||t.zeroDailyInterestConfirmed!==(t.dailyInterestCents==='0'))return fail();
   e.terms=Object.freeze(t);
  }else if(e.profile!=='itau109-no-charges-v1'||e.compatibilityConfirmed!==false||e.permanentInstructionsAcknowledged!==false||e.terms!==null)return fail();
  v.encoding=Object.freeze(e);
 }
 const d=object(v.dimensions,['paper','slipWidthMm','slipHeightMm','barcodeWidthMm','barcodeHeightMm','quietZoneMm','barcodeCenterFromBottomMm']);
 const expected={paper:'A4',slipWidthMm:190,slipHeightMm:104,barcodeWidthMm:103,barcodeHeightMm:13,quietZoneMm:5,barcodeCenterFromBottomMm:13.5};if(Object.entries(expected).some(([k,n])=>d[k]!==n))return fail();
 const pending=['BANK_REGISTRATION_NOT_CHECKED','BANK_HOMOLOGATION_NOT_CHECKED','PRINTED_LAYOUT_NOT_VALIDATED','PRINTED_INSTRUCTIONS_NOT_VALIDATED'];if(!Array.isArray(v.pending)||v.pending.length!==pending.length||v.pending.some((p,i)=>p!==pending[i]))return fail();
 if(typeof v.html!=='string'||v.html.length>131072||!hash(v.htmlHash))return fail();const bytes=new TextEncoder().encode(v.html);if(bytes.length>131072||v.sizeBytes!==bytes.length)return fail();inactiveHtml(v.html);
 const result={...v,source:Object.freeze(s),current:Object.freeze(c),binding:Object.freeze(b),dimensions:Object.freeze(d),pending:Object.freeze([...pending])};if(new TextEncoder().encode(JSON.stringify(result)).length>BOLETO_RESPONSE_BYTES)return fail();
 const expectedHash=v.htmlHash;const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');if(digest!==expectedHash)return fail();
 return Object.freeze(result) as unknown as BoletoPreview;
}
