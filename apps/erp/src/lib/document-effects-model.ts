import type {DocumentKind} from './real-documents-model';

// The SQL bridge is authoritative; this projection hides transitions that active effects reject.
const FORWARD:Partial<Record<DocumentKind,Record<string,string[]>>>={
 // 202610200245: Atendido parcialmente <-> Faturado parcialmente also keep active effects.
 // 202610200291: Em aberto ↔ Checkout parcial and Checkout parcial → Verificado (the Checkout de pedidos of a pedido with stock).
 sales_orders:{verified:['in_progress'],in_progress:['partially_fulfilled','fulfilled'],partially_fulfilled:['fulfilled','partially_invoiced'],partially_invoiced:['partially_fulfilled'],open:['checkout_partial'],checkout_partial:['open','verified']},
 purchase_orders:{in_progress:['partially_fulfilled','fulfilled'],partially_fulfilled:['fulfilled']},
 service_orders:{approved:['in_progress'],in_progress:['waiting_parts','service_done'],waiting_parts:['in_progress'],service_done:['finalized']},
};
// 202610200279 (estoque): Em aberto posts stock and goes forward with it (Verificado, Em andamento, Atendido); the stock, receipt and
// reservation guards accept it, the contas guard does not (finance unknown counts as active).
const STOCK_FORWARD:Partial<Record<DocumentKind,Record<string,string[]>>>={sales_orders:{open:['verified','in_progress','fulfilled']}};
export function effectTransitionAllowed(kind:DocumentKind,from:string,to:string,finance=true){return from===to||Boolean(FORWARD[kind]?.[from]?.includes(to))||!finance&&Boolean(STOCK_FORWARD[kind]?.[from]?.includes(to));}
export function documentEffectState(flags:unknown,financeObserved:boolean|null,stockObserved:boolean|null){
 const value=flags as {finance_active?:unknown;stock_active?:unknown;origin_finance?:unknown;origin_invoice?:unknown}|null;
 const known=Boolean(value&&typeof value.finance_active==='boolean'&&typeof value.stock_active==='boolean');
 const finance=value?.finance_active===true||financeObserved===true,stock=value?.stock_active===true||stockObserved===true;
 // 016: contas lançadas or nota gerada in the Origin lock a converted document (only Observações), apart from the native effects so the
 // transitions keep their rules.
 const originFinance=value?.origin_finance===true,originInvoice=value?.origin_invoice===true;
 return {known,finance,stock,active:finance||stock,originFinance,originInvoice,origin:originFinance||originInvoice};
}
