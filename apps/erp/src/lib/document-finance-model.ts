import {moneyInput,validFinanceDate} from './real-finance-model.ts';
import type {DocumentKind,DocumentRecord} from './real-documents-model';
export interface DocumentPosting {id:string;document_id:string;source_document_version:number;group_id:string;state:'active'|'reversed';version:number;kind:DocumentKind;number:string;direction:'receivable'|'payable';total_cents:string;installments:number;plan_source:'document'|'explicit';created_at:string;reversed_at:string|null;reason:string|null;}
export interface LinkedTitle {id:string;position:number;version:number;due_on:string;amount_cents:string;settled_cents:string;balance_cents:string;cancelled:boolean;category_id:string|null;description:string;cnab_linked:boolean;}
export interface DocumentFinancePage {document_id:string;document_version:number;active_posting:DocumentPosting|null;items:DocumentPosting[];has_more:boolean;next_cursor:string|null;}
export interface PostingDetail {document_id:string;document_version:number;posting:DocumentPosting;titles:LinkedTitle[];}
export interface PostingPreview {document_id:string;document_version:number;kind:DocumentKind;number:string;contact_name:string;direction:'receivable'|'payable';total_cents:string;category_name:string|null;plan_source:'document'|'explicit';preview_hash:string;installments:{position:number;amount_cents:string;due_on:string;method:string|null}[];}
export interface ReversalPreview extends PostingDetail {preview_hash:string;}
export interface DraftInstallment {amount:string;due_on:string;method:string;}
export const FINANCE_ELIGIBLE:Partial<Record<DocumentKind,string[]>>={sales_orders:['verified','in_progress','partially_fulfilled','fulfilled'],purchase_orders:['open','in_progress','partially_fulfilled','fulfilled'],service_orders:['approved','in_progress','waiting_parts','service_done','finalized']};
export const financialEligible=(record:DocumentRecord)=>Boolean(FINANCE_ELIGIBLE[record.kind]?.includes(record.status));
export function explicitDocumentPlan(record:DocumentRecord,rows:DraftInstallment[]){
 if(record.installments.length)return null;
 if(!rows.length||rows.length>120)throw new Error('Informe de uma a 120 parcelas e confira seus vencimentos.');
 const plan=rows.map(row=>{const amount=moneyInput(row.amount),due=validFinanceDate(row.due_on);if(BigInt(amount)<=0n||due<record.date)throw new Error('Cada parcela deve ter valor positivo e vencimento a partir da data do documento.');if(row.method.length>100||/[\x00-\x1f\x7f]/.test(row.method))throw new Error('Confira a forma prevista da parcela.');return {amount_cents:amount,due_on:due,method:row.method.trim()||null};});
 const match=/^(\d+)\.(\d{2})$/.exec(record.totals.total);if(!match||plan.reduce((sum,p)=>sum+BigInt(p.amount_cents),0n)!==BigInt(match[1])*100n+BigInt(match[2]))throw new Error('A soma das parcelas deve ser igual ao total salvo do documento.');return plan;
}
export function reverseDocumentInput(record:DocumentRecord,preview:ReversalPreview,reason:string){
 if(preview.document_id!==record.id||preview.document_version!==record.version||preview.posting.state!=='active')throw new Error('Atualize o documento e confira novamente o lançamento.');
 if(reason.trim().length<3||reason.length>1000||/[\x00-\x1f\x7f]/.test(reason))throw new Error('Informe um motivo entre 3 e 1.000 caracteres.');
 if(preview.titles.some(row=>row.settled_cents!=='0'||row.cnab_linked))throw new Error('O grupo tem principal liquidado ou vínculo de cobrança CNAB.');
 return {expected_document_version:record.version,expected_posting_version:preview.posting.version,preview_hash:preview.preview_hash,title_versions:preview.titles.map(row=>({id:row.id,version:row.version})),reason:reason.trim()};
}
