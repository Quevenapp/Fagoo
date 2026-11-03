import {checkedProposalAck,checkedProposalBody,checkedProposalCurrent,checkedProposalPage,checkedProposalPreview,proposalListPath,proposalIssueLabels,type ProposalApply,type ProposalAck,type ProposalBody,type ProposalCurrent,type ProposalPreview,type ProposalPolicy} from './origin-proposal-import-model.ts';

export const PROPOSAL_IMPORT_V2_BASE='/v1/importacao-orcamentos-origin-v2';
export const PROPOSAL_IMPORT_V2_POLICY='origin-open-proposal-v2' as const;
export const proposalV2IssueLabels:Record<string,string>={...proposalIssueLabels,DISCOUNT_UNSUPPORTED:'O desconto observado não atende ao formato e à precisão deste perfil.',COMMERCIAL_REFERENCE_UNSUPPORTED:'Uma referência comercial declarada possui identificador ou conteúdo inválido.'};
export const proposalTransformationLabels={
 UNIT_PRICES_ARE_SOURCE_NET:'Os preços unitários já são líquidos na origem e serão conservados exatamente.',
 SOURCE_LINE_DISCOUNTS_NOT_REAPPLIED:'O desconto original de cada item ficará como evidência histórica, com unidade não informada. Não será reaplicado.',
 GLOBAL_DISCOUNT_RECONCILED_AS_AMOUNT:'O desconto global será conservado como valor em reais, conferido com os totais da origem.',
 EXTERNAL_REFERENCES_ARE_UNLINKED:'As referências comerciais do Origin serão declaradas no rascunho. Não vinculam usuários, vendedores, lojas ou outros cadastros nativos.',
 ZERO_NEXT_CONTACT_PRESERVED_AS_UNSPECIFIED:'A data 0000-00-00 de próximo contato será tratada como não informada. O valor original ficará na evidência.',
} as const;
export type ProposalTransformation=keyof typeof proposalTransformationLabels;
export interface ProposalSourceEvidence {schema_version:1;price_basis:'source_net';discount_semantics:'original_line_unit_unspecified';products_total:string;global_discount_observed:string;freight:string;other_expenses:string;total:string;items:{position:number;quantity:string;unit_price:string;discount_observed:string;discount_unit:'unspecified'}[];next_contact:{state:'missing'|'null'|'empty'|'zero_date'|'date';value:string|null};}
export interface ProposalV2Preview extends ProposalPreview {policy:typeof PROPOSAL_IMPORT_V2_POLICY;source_evidence:ProposalSourceEvidence|null;transformations:ProposalTransformation[];}
export interface ProposalHistoricalEvidence {source_evidence:ProposalSourceEvidence;normalized_body:ProposalBody;transformations:ProposalTransformation[];item_links:{source_position:number;native_item_id:string}[];}
export interface ProposalV2Current extends ProposalCurrent {policy:typeof PROPOSAL_IMPORT_V2_POLICY;historical_evidence:ProposalHistoricalEvidence;}
type Obj=Record<string,unknown>;
const object=(v:unknown):v is Obj=>!!v&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:unknown,keys:string[]):v is Obj=>object(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const decimal=(v:unknown,whole:number,fraction:number):v is string=>typeof v==='string'&&new RegExp(`^(?:0|[1-9][0-9]{0,${whole-1}})\\.[0-9]{${fraction}}$`).test(v);
function fail():never{throw new Error('Não foi possível validar a evidência da importação.');}
const canonical=(v:unknown):string=>JSON.stringify(v,(_k,x)=>object(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
export const proposalV2ListPath=(q:string,after:string|null=null)=>proposalListPath(q,after).replace('/v1/importacao-orcamentos-origin?',PROPOSAL_IMPORT_V2_BASE+'?');
export const checkedProposalV2Page=(v:unknown,after:string|null=null)=>checkedProposalPage(v,after,PROPOSAL_IMPORT_V2_POLICY);
function evidence(v:unknown,body:ProposalBody):ProposalSourceEvidence{
 if(!exact(v,['schema_version','price_basis','discount_semantics','products_total','global_discount_observed','freight','other_expenses','total','items','next_contact'])||v.schema_version!==1||v.price_basis!=='source_net'||v.discount_semantics!=='original_line_unit_unspecified'||!Array.isArray(v.items)||v.items.length!==body.items.length||!exact(v.next_contact,['state','value']))fail();
 for(const[k,value]of Object.entries({products_total:body.totals.gross,global_discount_observed:body.discount_value,freight:body.freight,other_expenses:body.other_expenses,total:body.totals.total}))if(v[k]!==value)fail();
 const n=v.next_contact;if(typeof n.state!=='string'||!['missing','null','empty','zero_date','date'].includes(n.state)||(['missing','null'].includes(String(n.state))?n.value!==null:n.state==='empty'?n.value!=='':n.state==='zero_date'?n.value!=='0000-00-00':n.value!==body.next_contact||body.next_contact===null)||body.next_contact!==(n.state==='date'?n.value:null))fail();
 const items=v.items.map((line,i)=>{if(!exact(line,['position','quantity','unit_price','discount_observed','discount_unit'])||line.position!==i+1||line.quantity!==body.items[i].quantity||line.unit_price!==body.items[i].unit_price||!decimal(line.discount_observed,12,6)||line.discount_unit!=='unspecified')fail();return{position:i+1,quantity:body.items[i].quantity,unit_price:body.items[i].unit_price,discount_observed:line.discount_observed,discount_unit:'unspecified' as const};});
 return{schema_version:1,price_basis:'source_net',discount_semantics:'original_line_unit_unspecified',products_total:v.products_total as string,global_discount_observed:v.global_discount_observed as string,freight:v.freight as string,other_expenses:v.other_expenses as string,total:v.total as string,items,next_contact:{state:n.state as ProposalSourceEvidence['next_contact']['state'],value:n.value as string|null}};
}
function transformations(v:unknown,e:ProposalSourceEvidence|null):ProposalTransformation[]{const expected=e?(Object.keys(proposalTransformationLabels) as ProposalTransformation[]).slice(0,e.next_contact.state==='zero_date'?5:4):[];if(!Array.isArray(v)||v.length!==expected.length||v.some((x,i)=>x!==expected[i]))fail();return expected;}
export function checkedProposalV2Preview(v:unknown,id:string):ProposalV2Preview{
 const preview=checkedProposalPreview(v,id,PROPOSAL_IMPORT_V2_POLICY);if(!object(v))fail();const source_evidence=preview.proposed?evidence(v.source_evidence,preview.proposed):null;if(!preview.proposed&&v.source_evidence!==null)fail();return{...preview,policy:PROPOSAL_IMPORT_V2_POLICY,source_evidence,transformations:transformations(v.transformations,source_evidence)};
}
export const checkedProposalV2Ack=(v:unknown,request:ProposalApply,preview:ProposalV2Preview):ProposalAck=>checkedProposalAck(v,request,preview,PROPOSAL_IMPORT_V2_POLICY);
export function checkedProposalV2Current(v:unknown,options:Parameters<typeof checkedProposalCurrent>[1]):ProposalV2Current{
 const current=checkedProposalCurrent(v,options,PROPOSAL_IMPORT_V2_POLICY);if(!object(v)||!exact(v.historical_evidence,['source_evidence','normalized_body','transformations','item_links']))fail();
 const h=v.historical_evidence,body=checkedProposalBody(h.normalized_body,PROPOSAL_IMPORT_V2_POLICY),source_evidence=evidence(h.source_evidence,body),changed=transformations(h.transformations,source_evidence);
 if(body.date!==current.receipt.document.date||body.contact_id!==current.receipt.document.contact_id||body.totals.total!==current.receipt.document.total||!Array.isArray(h.item_links)||h.item_links.length!==body.items.length)fail();
 const ids=new Set<string>(),item_links=h.item_links.map((x,i)=>{if(!exact(x,['source_position','native_item_id'])||x.source_position!==i+1||!uuid(x.native_item_id)||ids.has(x.native_item_id))fail();ids.add(x.native_item_id);return{source_position:i+1,native_item_id:x.native_item_id};});
 if(options.preview){const p=options.preview as ProposalV2Preview;if(canonical(body)!==canonical(p.proposed)||canonical(source_evidence)!==canonical(p.source_evidence)||canonical(changed)!==canonical(p.transformations))fail();}
 if(current.current_document.version===1){const d=v.current_document;if(!object(d)||!Array.isArray(d.items)||d.items.length!==body.items.length)fail();const initial=checkedProposalBody({...d,items:d.items.map((x,i)=>{if(!object(x)||x.id!==item_links[i].native_item_id)fail();return{...x,id:null};})},PROPOSAL_IMPORT_V2_POLICY);if(canonical(initial)!==canonical(body))fail();}
 return{...current,policy:PROPOSAL_IMPORT_V2_POLICY,historical_evidence:{normalized_body:body,source_evidence,transformations:changed,item_links}};
}
export function checkedProposalOriginPolicy(v:unknown,documentId:string,sourceId:string):ProposalPolicy{
 if(!object(v)||v.data_mode!=='erp_native'||v.read_only!==true||v.document_id!==documentId||v.kind!=='sales_proposals'||!object(v.origin)||v.origin.system!=='origin'||v.origin.entity!=='sales_proposals'||v.origin.source_id!==sourceId||!uuid(v.origin.command_id)||typeof v.origin.policy!=='string'||!['origin-open-proposal-v1','origin-open-proposal-v2'].includes(v.origin.policy))fail();return v.origin.policy as ProposalPolicy;
}
