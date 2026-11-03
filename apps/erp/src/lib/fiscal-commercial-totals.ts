import type {Completion} from './fiscal-completion-model.ts';
import type {FiscalDraftEnvelope} from './fiscal-drafts-model.ts';

export const COMMERCIAL_TOTAL_KEYS=['vProd','vDesc','vFrete','vOutro','vNF'] as const;
type TotalKey=typeof COMMERCIAL_TOTAL_KEYS[number];
export type CommercialTotals=Readonly<{draft_id:string;draft_version:number;snapshot_hash:string;source_document_id:string;source_document_version:number;order_number:string;totals:Readonly<Record<TotalKey,string>>}>;
const cents=(value:unknown):bigint|null=>typeof value==='string'&&/^(?:0|[1-9][0-9]{0,12})\.[0-9]{2}$/.test(value)?BigInt(value.replace('.','')):null;
const money=(value:bigint):string=>`${value/100n}.${(value%100n).toString().padStart(2,'0')}`;
const invalid=()=>{throw new Error('Não foi possível reaproveitar os totais desta cópia. Recarregue as bases e confira os valores do pedido. Nenhum campo foi alterado.');};

/** Only the immutable commercial snapshot is read. No tax or item allocation is inferred. */
export function commercialTotals(draft:FiscalDraftEnvelope):CommercialTotals{
 const {record,current}=draft,snapshot=record.snapshot;
 if(record.environment!=='2'||record.status!=='draft'||current.status!=='draft'||record.version!==current.version||current.source_changed||current.company_changed||current.source_status==='cancelled'||snapshot.kind!=='sales_orders'||snapshot.document_id!==record.source_document_id||snapshot.document_version!==record.source_document_version||current.source_document_version!==record.source_document_version||! /^[a-f0-9]{64}$/.test(record.snapshot_hash))return invalid();
 const t=snapshot.totals;if(!t||typeof t!=='object'||Array.isArray(t))return invalid();
 const gross=cents(t.gross),line=cents(t.line_discount),subtotal=cents(t.subtotal),discount=cents(t.discount),freight=cents(t.freight),other=cents(t.other_expenses),total=cents(t.total);
 if(gross===null||line===null||subtotal===null||discount===null||freight===null||other===null||total===null||gross-line!==subtotal||discount>subtotal||subtotal-discount+freight+other!==total)return invalid();
 return Object.freeze({draft_id:record.id,draft_version:record.version,snapshot_hash:record.snapshot_hash,source_document_id:record.source_document_id,source_document_version:record.source_document_version,order_number:snapshot.number,totals:Object.freeze({vProd:t.gross,vDesc:money(line+discount),vFrete:t.freight,vOutro:t.other_expenses,vNF:t.total})});
}
export function commercialTotalsReplaceValues(form:Completion,source:CommercialTotals):boolean{
 return COMMERCIAL_TOTAL_KEYS.some(key=>form.totals[key]!==null&&cents(form.totals[key])!==cents(source.totals[key]));
}
export function withCommercialTotals(form:Completion,source:CommercialTotals):Completion{
 return {...form,totals:{...form.totals,...source.totals}};
}
export type PaymentComparison={state:'incomplete'}|{state:'compared';declared:string;change:string;total:string;difference:string;direction:'equal'|'short'|'excess'};
/** Arithmetic display only: missing/invalid amounts never become zero, including change. */
export function compareDeclaredPayments(form:Completion):PaymentComparison{
 const total=cents(form.totals.vNF),change=cents(form.payments.change),items=form.payments.items;
 if(total===null||change===null||items.length===0||items.length>100)return{state:'incomplete'};
 let declared=0n;for(const item of items){const amount=cents(item.amount);if(amount===null)return{state:'incomplete'};declared+=amount;}
 const delta=declared-change-total;
 return {state:'compared',declared:money(declared),change:money(change),total:money(total),difference:money(delta<0n?-delta:delta),direction:delta===0n?'equal':delta<0n?'short':'excess'};
}
