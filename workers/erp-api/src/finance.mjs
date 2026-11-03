/** Financial API contract, independent from staging and bank APIs. SQL is the authority for RBAC/CAS/arithmetic. */
import { BORDERO_ACTIONS, validateBorderoData, parseBorderoRead, projectBorderoResult } from './finance-borderos.mjs';
import { registryAction, parseRegistryRead, projectRegistryResult } from './finance-registry.mjs';
import { CASH_ACTIONS, cashAction, parseCashRead, projectCashResult } from './finance-cash.mjs';
import { RECONCILIATION_ACTIONS, STATEMENT_IMPORT_BODY_BYTES, reconciliationAction, parseReconciliationRead, projectReconciliationResult } from './finance-reconciliation.mjs';
import { RECURRENCE_ACTIONS, IMPORT_ACTIONS, IMPORT_BODY_BYTES, recurrenceAction, parseRecurrenceRead, projectRecurrenceResult } from './finance-recurrence.mjs';
// Onda C (SQL 171+): Comissões.
import { COMMISSION_ACTIONS, commissionAction, parseCommissionRead, projectCommissionResult } from './finance-commissions.mjs';
// Controle de caixa (SQL 173).
import { CASH_CONTROL_ACTIONS, cashControlAction, parseCashControlRead, projectCashControlResult } from './finance-cash-control.mjs';
// Faturamento agrupado (SQL 174).
import { GROUPED_BILLING_ACTIONS, GROUPED_BILLING_BODY_BYTES, groupedBillingAction, parseGroupedBillingRead, projectGroupedBillingResult } from './finance-grouped-billing.mjs';
// Relatórios financeiros (SQL 212).
import { parseFinanceReportRead, projectFinanceReport } from './finance-reports.mjs';
// Remessas e Retornos (CNAB) no padrão Origin (SQL 213).
import { CNAB_LIST_ACTIONS, cnabListAction, parseCnabListRead, projectCnabListResult } from './finance-cnab-lists.mjs';
// Contas lançadas pelas notas fiscais do Brufap (SQL 247).
import { INVOICE_FINANCE_ACTIONS, invoiceFinanceAction, parseInvoiceFinanceRead, projectInvoiceFinanceResult } from './finance-invoices.mjs';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ENTITIES = ['accounts','categories','titles','settlements','movements'];
const ACTIONS = {
  account_save: ['id','expected_version','name','kind','active'], category_save: ['id','expected_version','name','kind','active'],
  title_create_group: ['kind','contact_id','category_id','description','source_reference','issued_on','total_cents','installments'],
  title_update: ['id','expected_version','description','source_reference','due_on','amount_cents','category_id'],
  title_cancel: ['id','expected_version','note'],
  settle: ['id','expected_version','account_id','posted_on','principal_cents','interest_cents','penalty_cents','discount_cents','fee_cents','note'],
  reverse: ['id','expected_version','settlement_id','posted_on','note'], opening: ['id','expected_version','amount_cents','posted_on','note'],
  // Origin drawer (SQL 108): competência, conta financeira, nº no banco, juros/multa (centésimos de %) and logical exclusion.
  // SQL 175: the Forma de pagamento of the conta (payment_method_id, validated in SQL).
  // SQL 210: the Vendedor of a conta a receber (seller_id) and the Histórico of up to 2.000 characters.
  title_create: ['kind','contact_id','category_id','account_id','description','source_reference','bank_number','issued_on','competence_on','interest_month_bp','penalty_bp','total_cents','installments','payment_method_id','seller_id'],
  title_edit: ['id','expected_version','contact_id','category_id','account_id','description','source_reference','bank_number','issued_on','competence_on','due_on','amount_cents','interest_month_bp','penalty_bp','payment_method_id','seller_id'],
  title_delete: ['id','expected_version','note'],
};
const TITLE_DRAWER_ACTIONS=['title_create','title_edit','title_delete'];
// SQL 210: the gaveta keeps the whole Histórico (2.000); every other reader keeps its first 240 characters (description).
const HISTORY_LIMIT=2000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export class FinanceError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const invalid = () => { throw new FinanceError(400, 'ERP_INVALID_QUERY'); };
const upstreamInvalid = () => { throw new FinanceError(502, 'ERP_UPSTREAM_INVALID_RESPONSE'); };
function exact(value, keys) { if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) invalid(); }
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > '2100-12-31') invalid();
  const time = Date.parse(`${value}T00:00:00Z`); if (!Number.isFinite(time) || new Date(time).toISOString().slice(0,10) !== value) invalid();
  return value;
}
function validateData(action, data) {
  exact(data, ACTIONS[action]);
  for (const [key, value] of Object.entries(data)) {
    if (key.endsWith('_cents')) { if (typeof value !== 'string' || !(action === 'opening' && key === 'amount_cents' ? /^-?\d{1,15}$/ : /^\d{1,15}$/).test(value)) invalid(); }
    else if (key === 'id' || key.endsWith('_id')) { if (value !== null && (typeof value !== 'string' || !UUID.test(value))) invalid(); }
    else if (key.endsWith('_on')) date(value);
    else if (key === 'expected_version') { if (!Number.isInteger(value) || value < 0 || value > 2147483647) invalid(); }
    else if (key === 'active') { if (typeof value !== 'boolean') invalid(); }
    else if (key.endsWith('_bp')) { if (!Number.isInteger(value) || value < 0 || value > 10000) invalid(); }
    else if (key === 'installments') {
      if (!Array.isArray(value) || value.length < 1 || value.length > 120) invalid();
      value.forEach(part => { exact(part,['amount_cents','due_on']); if (typeof part.amount_cents !== 'string' || !/^\d{1,15}$/.test(part.amount_cents)) invalid(); date(part.due_on); });
    } else {
      const max = key === 'note' ? 500 : key === 'description' ? (TITLE_DRAWER_ACTIONS.includes(action) ? HISTORY_LIMIT : 240) : key === 'kind' ? 20 : key === 'bank_number' ? 60 : 200;
      if (value !== null && (typeof value !== 'string' || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))) invalid();
    }
  }
  const required = {
    account_save:['expected_version','name','kind'], category_save:['expected_version','name','kind'],
    title_create_group:['kind','contact_id','description','issued_on','total_cents','installments'],
    title_update:['id','expected_version'], title_cancel:['id','expected_version','note'],
    settle:['id','expected_version','account_id','posted_on','principal_cents'],
    reverse:['id','expected_version','settlement_id','posted_on','note'], opening:['id','expected_version','amount_cents','posted_on','note'],
    title_create:['kind','contact_id','description','issued_on','competence_on','total_cents','installments'], title_edit:['id','expected_version'], title_delete:['id','expected_version'],
  }[action];
  // The drawer never clears contato, emissão, competência, vencimento, valor, histórico or percentuais.
  if (action === 'title_edit' && ['contact_id','issued_on','competence_on','due_on','amount_cents','description','interest_month_bp','penalty_bp'].some(key => data[key] === null)) invalid();
  if (required.some(key => data[key] === undefined || data[key] === null || (typeof data[key] === 'string' && !data[key].trim()))) invalid();
  if (['account_save','category_save'].includes(action)) { if (data.id ? data.expected_version < 1 : data.expected_version !== 0) invalid(); }
  else if (!['title_create_group','title_create'].includes(action) && data.expected_version < 1) invalid();
  return data;
}
async function readBody(request, limit = 65536) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '') || !request.body || Number(request.headers.get('content-length')) > limit) invalid();
  const reader = request.body.getReader(); let size = 0; let text = ''; const decoder = new TextDecoder('utf-8',{fatal:true});
  try {
    while (true) { const {done,value}=await reader.read(); if(done)break; size+=value.byteLength; if(size>limit)invalid(); text+=decoder.decode(value,{stream:true}); }
    return JSON.parse(text+decoder.decode());
  } catch { return invalid(); }
  finally { try {await reader.cancel();} catch { /* No financial data is logged. */ } reader.releaseLock(); }
}

// Origin-style title list (SQL 109): numbered page, vencimento order, "Opção" and totals of the whole filtered set.
// The cursor list above stays unchanged for every other caller.
const TITLE_OPTIONS=['open','overdue','issued','settled'];
// SQL 281: Devolvido (returned), a cancelled conta marked by a devolução.
const TITLE_STATUSES=['open','partial','paid','cancelled','returned'];
const TITLE_PAGE_PARAMS=['page','limit','kind','order','q','option','status','date','from','to','account','category','remittance','amount_cents','document','payment_type','payment_method','seller'];
const TITLE_ORIGINS={receivable:['sales_orders','service_orders'],payable:['purchase_orders']};
const safeText=(value,max)=>{if(value!==null&&(value.length>max||/[\x00-\x1f\x7f]/.test(value)))invalid();return value?.trim()||null;};
function parseTitlePage(entity,params){
  if(entity!=='titles')invalid();
  for(const key of params.keys())if(!TITLE_PAGE_PARAMS.includes(key)||params.getAll(key).length!==1)invalid();
  const page=params.get('page'),limit=params.get('limit')??'100',kind=params.get('kind'),order=params.get('order')??'due_asc',option=params.get('option')??'issued';
  if(!/^[1-9]\d{0,5}$/.test(page)||Number(page)>100000||!/^\d{1,3}$/.test(limit)||Number(limit)<1||Number(limit)>100
    ||!['receivable','payable'].includes(kind)||!['due_asc','due_desc'].includes(order)||!TITLE_OPTIONS.includes(option))invalid();
  // The Opção fixes the date of the period, as in Origin; only Emitidas chooses it and the Situação.
  const dateField=params.get('date')??(option==='settled'?'settled':'due');
  if(!['due','issued','settled','competence'].includes(dateField)||(['open','overdue'].includes(option)&&dateField!=='due')||(option==='settled'&&dateField!=='settled'))invalid();
  const status=params.get('status');let statuses=null;
  if(status!==null){statuses=status.split(',');if(option!=='issued'||statuses.length>5||statuses.some(value=>!TITLE_STATUSES.includes(value))||new Set(statuses).size!==statuses.length)invalid();}
  const from=params.has('from')?date(params.get('from')):null;const to=params.has('to')?date(params.get('to')):null;if(from&&to&&from>to)invalid();
  const account=params.get('account');if(account!==null&&account!=='none'&&!UUID.test(account))invalid();
  const category=params.get('category');let categories=null;
  if(category!==null){categories=category.split(',').map(value=>value.toLowerCase());if(categories.length>50||categories.some(value=>value!=='none'&&!UUID.test(value))||new Set(categories).size!==categories.length)invalid();}
  const remittance=params.get('remittance');if(remittance!==null&&(!['yes','no'].includes(remittance)||option!=='open'))invalid();
  const amount=params.get('amount_cents');if(amount!==null&&!/^[1-9]\d{0,14}$/.test(amount))invalid();
  // SQL 210: Tipo de pagamento (tPag of the forma), Forma de pagamento and Vendedor (contas a receber), sent only when used.
  const paymentType=params.get('payment_type'),paymentMethod=params.get('payment_method'),seller=params.get('seller');
  if((paymentType!==null&&!/^\d{2}$/.test(paymentType))||(paymentMethod!==null&&!UUID.test(paymentMethod))||(seller!==null&&(!UUID.test(seller)||kind!=='receivable')))invalid();
  return {kind:'page',entity,rpc:'erp_finance_title_page_v2',args:{p_kind:kind,p_page:Number(page),p_limit:Number(limit),p_order:order,
    p_query:safeText(params.get('q'),120),p_option:option,p_statuses:statuses,p_date_field:dateField,p_from:from,p_to:to,p_account:account?.toLowerCase()??null,
    p_categories:categories,p_remittance:remittance,p_amount_cents:amount,p_document:safeText(params.get('document'),60),
    ...(paymentType!==null?{p_payment_type:paymentType}:{}),...(paymentMethod!==null?{p_payment_method:paymentMethod.toLowerCase()}:{}),...(seller!==null?{p_seller:seller.toLowerCase()}:{})}};
}
const PAGE_CENTS=/^\d{1,30}$/;
function projectPayments(value){
  if(!object(value)||(value.settled_on!==null&&(typeof value.settled_on!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value.settled_on)))||typeof value.settled_by_return!=='boolean'
    ||['fee_cents','interest_cents','penalty_cents','discount_cents'].some(key=>typeof value[key]!=='string'||!PAGE_CENTS.test(value[key])))upstreamInvalid();
  return {settled_on:value.settled_on,fee_cents:value.fee_cents,interest_cents:value.interest_cents,penalty_cents:value.penalty_cents,discount_cents:value.discount_cents,settled_by_return:value.settled_by_return};
}
function projectRemittance(value){
  if(value===null)return null;
  if(!object(value)||!UUID.test(value.id||'')||!Number.isSafeInteger(value.sequence)||value.sequence<1||!['reserved','ready'].includes(value.state)
    ||(value.our_number!==null&&(typeof value.our_number!=='string'||!/^[0-9A-Za-z-]{1,40}$/.test(value.our_number))))upstreamInvalid();
  return {id:value.id,sequence:value.sequence,state:value.state,our_number:value.our_number};
}
function projectOrigin(value,record){
  if(value===null){if(record.document_linked)upstreamInvalid();return null;}
  // SQL 247: "Nota fiscal de origem" of the contas lançadas by a note (saída: contas a receber; entrada: contas a pagar).
  if(object(value)&&value.kind==='fiscal_invoices'){
    if(!record.document_linked||typeof value.invoice_id!=='string'||!UUID.test(value.invoice_id)||!['55','65'].includes(value.model)||value.direction!==(record.kind==='payable'?'0':'1')
      ||(value.number!==null&&(typeof value.number!=='string'||!/^[1-9]\d{0,8}$/.test(value.number))))upstreamInvalid();
    return {invoice_id:value.invoice_id,kind:'fiscal_invoices',model:value.model,direction:value.direction,number:value.number};
  }
  if(!object(value)||!record.document_linked||typeof value.document_id!=='string'||!UUID.test(value.document_id)||!TITLE_ORIGINS[record.kind]?.includes(value.kind)
    ||typeof value.number!=='string'||!/^[1-9]\d{0,9}$/.test(value.number))upstreamInvalid();
  return {document_id:value.document_id,kind:value.kind,number:value.number};
}
function projectTitlePage(route,value){
  const {p_kind:kind,p_page:page,p_limit:limit,p_order:order,p_option:option,p_statuses:statuses,p_account:account,p_categories:categories,p_remittance:remittance,p_amount_cents:amount,
    p_payment_type:paymentType,p_payment_method:paymentMethod,p_seller:seller}=route.args,totals=value.totals;
  if(value.kind!==kind||value.page!==page||value.limit!==limit||value.order!==order||value.option!==option||!Number.isSafeInteger(value.total)||value.total<0
    ||!object(totals)||totals.count!==value.total||typeof totals.amount_cents!=='string'||!PAGE_CENTS.test(totals.amount_cents)
    ||typeof totals.balance_cents!=='string'||!PAGE_CENTS.test(totals.balance_cents)||BigInt(totals.balance_cents)>BigInt(totals.amount_cents)
    ||typeof totals.fee_cents!=='string'||!PAGE_CENTS.test(totals.fee_cents)
    ||!Array.isArray(value.items)||value.items.length!==Math.max(0,Math.min(limit,value.total-(page-1)*limit)))upstreamInvalid();
  const ids=new Set();let previous=null;
  const items=value.items.map(item=>{
    const record=projectRecord('titles',item);if(record.kind!==kind||ids.has(record.id)||record.deleted_at!==null)upstreamInvalid();ids.add(record.id);
    const key=`${record.due_on}:${record.id}`;if(previous!==null&&(order==='due_asc'?key<=previous:key>=previous))upstreamInvalid();previous=key;
    const payments=projectPayments(item.payments),remittanceRow=projectRemittance(item.remittance),open=!record.cancelled&&BigInt(record.balance_cents)>0n;
    if(item.account_name!==null&&(typeof item.account_name!=='string'||item.account_name.length>200))upstreamInvalid();
    if((item.account_name===null)!==(record.account_id===null)||typeof item.imported!=='boolean')upstreamInvalid();
    // SQL 246: the bank of the conta financeira of the forma (else of the conta) for the column Forma de pagamento.
    const bank=item.payment_bank===undefined?null:item.payment_bank;
    if(bank!==null&&(!object(bank)||typeof bank.code!=='string'||!/^\d{3}$/.test(bank.code)||typeof bank.name!=='string'||!bank.name||bank.name.length>80||record.payment_method_id===null))upstreamInvalid();
    // The row must belong to the Opção and to the filters that were asked for.
    if((option==='open'&&!open)||(option==='overdue'&&(!open||!record.overdue))||(option==='settled'&&(payments.settled_on===null||record.cancelled))
      ||(statuses&&!statuses.some(status=>status===(record.returned===true?'returned':record.status)))||(account&&(account==='none'?record.account_id!==null:record.account_id!==account))
      ||(categories&&!categories.some(category=>category==='none'?record.category_id===null:record.category_id===category))
      ||(remittance&&(remittance==='yes')!==(remittanceRow!==null))||(amount&&record.amount_cents!==amount)
      ||(paymentMethod&&record.payment_method_id!==paymentMethod)||(paymentType&&record.payment_type!==paymentType)||(seller&&record.seller_id!==seller))upstreamInvalid();
    return {...record,origin:projectOrigin(item.origin,record),account_name:item.account_name,remittance:remittanceRow,payments,imported:item.imported,...(bank!==null?{payment_bank:{code:bank.code,name:bank.name}}:{})};
  });
  return {entity:'titles',kind,option,items,page,limit,order,total:value.total,totals:{count:totals.count,amount_cents:totals.amount_cents,balance_cents:totals.balance_cents,fee_cents:totals.fee_cents},data_mode:'erp_native'};
}

export function financeMethods(path) { return /^\/v1\/financeiro\/actions\/[a-z_]+$/.test(path) ? ['POST'] : ['GET']; }
export async function parseFinanceRoute(request) {
  const url = new URL(request.url);
  if (url.pathname !== '/v1/financeiro' && !url.pathname.startsWith('/v1/financeiro/')) return null;
  if (!financeMethods(url.pathname).includes(request.method)) throw new FinanceError(405,'ERP_METHOD_NOT_ALLOWED');
  const actionMatch=/^\/v1\/financeiro\/actions\/([a-z_]+)$/.exec(url.pathname);
  if (actionMatch) {
    const action=actionMatch[1];
    // Borderôs (SQL 110): Baixa de lançamentos and Excluir borderô carry a list of contas.
    if (BORDERO_ACTIONS.includes(action)) {
      if(url.search)invalid(); const value=await readBody(request); exact(value,['command_id','data']);
      if(typeof value.command_id!=='string'||!UUID.test(value.command_id))invalid();
      return {kind:'execute',action,bordero:true,rpc:'erp_finance_bordero_execute',args:{p_command_id:value.command_id,p_action:action,p_data:validateBorderoData(action,value.data)}};
    }
    // Contas recorrentes and Importação de registros financeiros (SQL 138): the sheet lines travel in the body (up to 1 MiB).
    if (RECURRENCE_ACTIONS.includes(action)||IMPORT_ACTIONS.includes(action)) {
      if(url.search)invalid(); const value=await readBody(request,IMPORT_ACTIONS.includes(action)?IMPORT_BODY_BYTES:65536); exact(value,['command_id','data']);
      if(typeof value.command_id!=='string'||!UUID.test(value.command_id))invalid();
      return recurrenceAction(action,value);
    }
    // Conciliação bancária (SQL 137): the OFX file travels in the body of statement_import (up to 3 MiB).
    if (RECONCILIATION_ACTIONS.includes(action)) {
      if(url.search)invalid(); const value=await readBody(request,action==='statement_import'?STATEMENT_IMPORT_BODY_BYTES:65536); exact(value,['command_id','data']);
      if(typeof value.command_id!=='string'||!UUID.test(value.command_id))invalid();
      return reconciliationAction(action,value);
    }
    // Remessas e Retornos (SQL 213): Excluir a remessa reservada sem arquivo e tirar da listagem o retorno sem ocorrência aplicada.
    if (CNAB_LIST_ACTIONS.includes(action)) {
      if(url.search)invalid(); const value=await readBody(request,4096); exact(value,['command_id','data']);
      if(typeof value.command_id!=='string'||!UUID.test(value.command_id))invalid();
      return cnabListAction(action,value);
    }
    // Lançar contas / Estornar contas da nota fiscal (SQL 247).
    if (INVOICE_FINANCE_ACTIONS.includes(action)) {
      if(url.search)invalid(); const value=await readBody(request); exact(value,['command_id','data']);
      if(typeof value.command_id!=='string'||!UUID.test(value.command_id))invalid();
      return invoiceFinanceAction(action,value);
    }
    // Comissões (SQL 171): pagamento, outro lançamento, comissão manual e exclusões.
    if (COMMISSION_ACTIONS.includes(action)||CASH_CONTROL_ACTIONS.includes(action)||GROUPED_BILLING_ACTIONS.includes(action)) {
      if(url.search)invalid(); const value=await readBody(request,GROUPED_BILLING_ACTIONS.includes(action)?GROUPED_BILLING_BODY_BYTES:65536); exact(value,['command_id','data']);
      if(typeof value.command_id!=='string'||!UUID.test(value.command_id))invalid();
      return COMMISSION_ACTIONS.includes(action)?commissionAction(action,value):CASH_CONTROL_ACTIONS.includes(action)?cashControlAction(action,value):groupedBillingAction(action,value);
    }
    // Cadastros de contas financeiras e categorias (SQL 135) and Caixas e bancos (SQL 136).
    if ((/^(account|category)_/.test(action)&&!Object.hasOwn(ACTIONS,action))||CASH_ACTIONS.includes(action)) {
      if(url.search)invalid(); const value=await readBody(request); exact(value,['command_id','data']);
      if(typeof value.command_id!=='string'||!UUID.test(value.command_id))invalid();
      const route=CASH_ACTIONS.includes(action)?cashAction(action,value):registryAction(action,value); if(!route)throw new FinanceError(404,'ERP_NOT_FOUND'); return route;
    }
    if (!Object.hasOwn(ACTIONS,action)) throw new FinanceError(404,'ERP_NOT_FOUND');
    if(url.search)invalid(); const value=await readBody(request); exact(value,['command_id','data']);
    if(typeof value.command_id!=='string'||!UUID.test(value.command_id))invalid();
    return {kind:'execute',action,rpc:TITLE_DRAWER_ACTIONS.includes(action)?'erp_finance_title_execute':'erp_finance_execute',args:{p_command_id:value.command_id,p_action:action,p_data:validateData(action,value.data)}};
  }
  if(url.pathname==='/v1/financeiro') { if(url.search)invalid(); return {kind:'access',rpc:'erp_finance_access',args:{}}; }
  // SQL 175: the formas de pagamento a conta of the kind may use (gaveta and baixa).
  if(url.pathname==='/v1/financeiro/formas-pagamento') { for(const key of url.searchParams.keys())if(key!=='kind'||url.searchParams.getAll(key).length!==1)invalid(); const kind=url.searchParams.get('kind'); if(!['receivable','payable'].includes(kind))invalid(); return {kind:'payment_methods',rpc:'erp_finance_payment_methods',args:{p_kind:kind}}; }
  const borderoRead=parseBorderoRead(url); if(borderoRead)return borderoRead;
  const registryRead=parseRegistryRead(url); if(registryRead)return registryRead;
  const cashRead=parseCashRead(url); if(cashRead)return cashRead;
  const reconciliationRead=parseReconciliationRead(url); if(reconciliationRead)return reconciliationRead;
  const recurrenceRead=parseRecurrenceRead(url); if(recurrenceRead)return recurrenceRead;
  const commissionRead=parseCommissionRead(url); if(commissionRead)return commissionRead;
  const cashControlRead=parseCashControlRead(url); if(cashControlRead)return cashControlRead;
  const groupedRead=parseGroupedBillingRead(url); if(groupedRead)return groupedRead;
  const reportRead=parseFinanceReportRead(url); if(reportRead)return reportRead;
  const cnabListRead=parseCnabListRead(url); if(cnabListRead)return cnabListRead;
  const invoiceRead=parseInvoiceFinanceRead(url); if(invoiceRead)return invoiceRead;
  // Drawer read (SQL 108): title, origin, conta financeira, boleto and the creation snapshot.
  const detailMatch=/^\/v1\/financeiro\/titles\/([a-f0-9-]+)\/detalhe$/.exec(url.pathname);
  if(detailMatch){if(!UUID.test(detailMatch[1]))throw new FinanceError(404,'ERP_NOT_FOUND');if(url.search)invalid();return {kind:'detail',entity:'titles',rpc:'erp_finance_title_detail',args:{p_id:detailMatch[1].toLowerCase()}};}
  const match=/^\/v1\/financeiro\/(accounts|categories|titles|settlements|movements)(?:\/([a-f0-9-]+))?$/.exec(url.pathname);
  if(!match || (match[2]&&!UUID.test(match[2])))throw new FinanceError(404,'ERP_NOT_FOUND');
  const entity=match[1];
  if(match[2]){if(url.search)invalid();return {kind:'get',entity,rpc:'erp_finance_get',args:{p_entity:entity,p_id:match[2]}};}
  const params=url.searchParams;if(params.has('page'))return parseTitlePage(entity,params);
  const allowed=['limit','after','q','status','kind','from','to','parent_id'];
  for(const key of params.keys())if(!allowed.includes(key)||params.getAll(key).length!==1)invalid();
  const limit=params.get('limit')??'25'; const after=params.get('after'); const query=params.get('q'); const parent=params.get('parent_id');
  if(!/^\d{1,3}$/.test(limit)||Number(limit)<1||Number(limit)>100||(after!==null&&!UUID.test(after))||(parent!==null&&!UUID.test(parent))
    ||(query!==null&&(query.length>120||/[\x00-\x1f\x7f]/.test(query)))||(['settlements','movements'].includes(entity)&&parent===null))invalid();
  const from=params.has('from')?date(params.get('from')):null;const to=params.has('to')?date(params.get('to')):null;if(from&&to&&from>to)invalid();
  const status=params.get('status');const kind=params.get('kind');
  if(status!==null&&!['open','partial','paid','cancelled','overdue'].includes(status))invalid();
  if(kind!==null&&!['receivable','payable','both','bank','cash','other','payment','reversal','opening'].includes(kind))invalid();
  return {kind:'list',entity,rpc:'erp_finance_list',args:{p_entity:entity,p_limit:Number(limit),p_after:after,p_query:query?.trim()||null,p_status:status,p_kind:kind,p_from:from,p_to:to,p_parent_id:parent}};
}

const COMMON={id:'uuid',created_at:'text100'};
const DTO={
  accounts:{...COMMON,name:'text200',kind:'text20',active:'bool',opening_recorded:'bool',version:'int',updated_at:'text100',balance_cents:'signed_cents'},
  categories:{...COMMON,name:'text200',kind:'text20',active:'bool',version:'int',updated_at:'text100'},
  titles:{...COMMON,group_id:'uuid',installment:'int',installments:'int',kind:'text20',contact_id:'uuid',category_id:'uuid?',description:'text240',source_reference:'text200?',issued_on:'text10',due_on:'text10',amount_cents:'cents',settled_cents:'cents',balance_cents:'cents',cancelled:'bool',version:'int',updated_at:'text100',contact_name:'text200',category_name:'text200?',status:'text20',overdue:'bool',document_linked:'bool',
    // SQL 108 drawer fields; responses without them (older readers) are read as null.
    competence_on:'date?',account_id:'uuid?',bank_number:'text60?',interest_month_bp:'bp?',penalty_bp:'bp?',original_due_on:'date?',deleted_at:'text100?',
    // SQL 138: the recurrence that generated the conta (Contas recorrentes).
    recurrence_id:'uuid?',
    // SQL 175: Forma de pagamento (and the taxa it takes from the valor) and the Faturamento agrupado (174) of the conta.
    payment_method_id:'uuid?',payment_method_name:'text100?',payment_fee_cents:'cents?',grouped_billing_id:'uuid?',
    // SQL 210: tPag of the forma, the effective Vendedor (the conta's own or the document's) and whether the Histórico passes 240 characters.
    payment_type:'type?',seller_id:'uuid?',seller_name:'text200?',seller_source:'source?',long_history:'flag?',
    // SQL 246: "sem vendedor" chosen in the gaveta over the seller of the document.
    seller_cleared:'flag?',
    // SQL 281: Situação Devolvido (always with status cancelled); a database before 281 answers without it (null).
    returned:'flag?'},
  settlements:{...COMMON,title_id:'uuid',account_id:'uuid',kind:'text20',reverses_id:'uuid?',posted_on:'text10',principal_cents:'cents',interest_cents:'cents',penalty_cents:'cents',discount_cents:'cents',fee_cents:'cents',net_cash_cents:'cents',note:'text500?',reversed:'bool',
    // SQL 249: the whole Histórico of the baixa when it passes 500 characters (note keeps its beginning); older answers read as null.
    history:'text2000?'},
  movements:{...COMMON,account_id:'uuid',settlement_id:'uuid?',transfer_id:'uuid?',kind:'text20',delta_cents:'signed_cents',posted_on:'text10',note:'text500?'},
};
const TITLE_108_FIELDS=['competence_on','account_id','bank_number','interest_month_bp','penalty_bp','original_due_on','deleted_at','recurrence_id','payment_method_id','payment_method_name','payment_fee_cents','grouped_billing_id',
  'payment_type','seller_id','seller_name','seller_source','long_history','seller_cleared','returned'];
const DETAIL_BILLING_STATES=['reserved','ready'];
const isoDay=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value);
function projectDetail(value){
  if(!object(value))upstreamInvalid();
  const record=projectRecord('titles',value.record),account=value.account,billing=value.billing,original=value.original;
  if(account===null?record.account_id!==null:(!object(account)||account.id!==record.account_id||typeof account.name!=='string'||account.name.length>200||typeof account.active!=='boolean'))upstreamInvalid();
  if(billing!==null&&(!object(billing)||(billing.our_number!==null&&(typeof billing.our_number!=='string'||!/^[0-9A-Za-z-]{1,40}$/.test(billing.our_number)))
    ||typeof billing.document_number!=='string'||billing.document_number.length>40||!UUID.test(billing.remittance_id||'')||!Number.isSafeInteger(billing.remittance_sequence)||billing.remittance_sequence<1
    ||!DETAIL_BILLING_STATES.includes(billing.remittance_state)||billing.file_generated!==(billing.remittance_state==='ready')))upstreamInvalid();
  if(original!==null&&(!object(original)||typeof original.contact_name!=='string'||original.contact_name.length>200||!isoDay(original.due_on)
    ||typeof original.amount_cents!=='string'||!/^\d{1,15}$/.test(original.amount_cents)||typeof original.description!=='string'||original.description.length>240||typeof original.created_at!=='string'||original.created_at.length>100))upstreamInvalid();
  if(typeof value.imported!=='boolean'||typeof value.settled_before!=='boolean')upstreamInvalid();
  // SQL 210: the whole Histórico when it passes 240 characters; description keeps its beginning.
  const history=value.history===undefined?null:value.history;
  if(history!==null&&(typeof history!=='string'||history.length<241||history.length>HISTORY_LIMIT||!history.startsWith(record.description)||record.long_history!==true))upstreamInvalid();
  if(history===null&&record.long_history===true)upstreamInvalid();
  return {entity:'titles',record,history,origin:projectOrigin(value.origin,record),account:account===null?null:{id:account.id,name:account.name,active:account.active},
    billing:billing===null?null:{our_number:billing.our_number,document_number:billing.document_number,remittance_id:billing.remittance_id,remittance_sequence:billing.remittance_sequence,remittance_state:billing.remittance_state,file_generated:billing.file_generated},
    imported:value.imported,settled_before:value.settled_before,original:original===null?null:{contact_name:original.contact_name,due_on:original.due_on,amount_cents:original.amount_cents,description:original.description,created_at:original.created_at},data_mode:'erp_native'};
}
export function projectFinanceRecord(entity,value){return projectRecord(entity,value);}
const RATE=/^\d{1,3}(?:\.\d{1,4})?$/;
function projectPaymentMethods(route,value){
  if(value.entity!=='payment_methods'||value.kind!==route.args.p_kind||!Array.isArray(value.items)||value.items.length>200)upstreamInvalid();
  return {entity:'payment_methods',kind:value.kind,items:value.items.map(item=>{
    if(!object(item)||!UUID.test(item.id||'')||typeof item.description!=='string'||item.description.length>100||typeof item.payment_type!=='string'||!/^\d{2}$/.test(item.payment_type)||(item.account_id!==null&&!UUID.test(item.account_id||''))
      ||['interest_rate','fine_rate','fee_rate'].some(key=>item[key]!==null&&(typeof item[key]!=='string'||!RATE.test(item[key])))||(item.fee_fixed!==null&&(typeof item.fee_fixed!=='string'||!/^\d{1,16}\.\d{2}$/.test(item.fee_fixed)))
      ||!['aliquota','fixa','aliquota_fixa'].includes(item.fee_type)||typeof item.is_default!=='boolean')upstreamInvalid();
    // SQL 210: Prazo de recebimento (dias) and "dias úteis"; older answers read as without prazo.
    const days=item.settlement_days===undefined?null:item.settlement_days,business=item.business_days===undefined?false:item.business_days;
    if((days!==null&&(!Number.isInteger(days)||days<0||days>365))||typeof business!=='boolean')upstreamInvalid();
    return {id:item.id,description:item.description,payment_type:item.payment_type,account_id:item.account_id,interest_rate:item.interest_rate,fine_rate:item.fine_rate,fee_type:item.fee_type,fee_rate:item.fee_rate,fee_fixed:item.fee_fixed,is_default:item.is_default,settlement_days:days,business_days:business};
  }),data_mode:'erp_native'};
}
function projectRecord(entity,value){
  if(!object(value)||!Object.hasOwn(DTO,entity))upstreamInvalid();const result={};
  for(const [key,type]of Object.entries(DTO[entity])){
    const field=(entity==='movements'&&key==='transfer_id'||entity==='titles'&&TITLE_108_FIELDS.includes(key)||entity==='settlements'&&key==='history')&&value[key]===undefined?null:value[key];if(field===null&&type.endsWith('?')){result[key]=null;continue;}
    if(type.startsWith('uuid')?(typeof field!=='string'||!UUID.test(field))
      :type.startsWith('date')?(typeof field!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(field))
      :type.startsWith('bp')?(!Number.isInteger(field)||field<0||field>10000)
      :type==='type?'?(typeof field!=='string'||!/^\d{2}$/.test(field))
      :type==='source?'?!['conta','documento'].includes(field)
      :type==='flag?'?typeof field!=='boolean'
      :type.startsWith('cents')?(typeof field!=='string'||! /^\d{1,30}$/.test(field))
      :type==='signed_cents'?(typeof field!=='string'||! /^-?\d{1,30}$/.test(field))
      :type==='bool'?typeof field!=='boolean'
      :type==='int'?(!Number.isInteger(field)||field<1||field>2147483647)
      :(typeof field!=='string'||field.length>Number(type.replace(/[^0-9]/g,''))))upstreamInvalid();
    result[key]=field;
  }
  // SQL 210: a Vendedor always comes with its name and its source, and only on contas a receber.
  if(entity==='titles'&&((result.seller_id===null)!==(result.seller_name===null)||(result.seller_id===null)!==(result.seller_source===null)||(result.seller_id!==null&&result.kind!=='receivable')
    ||(result.seller_cleared===true&&(result.seller_id!==null||result.kind!=='receivable'))||(result.returned===true&&!result.cancelled)))upstreamInvalid();
  if(entity==='settlements'&&result.history!==null&&(result.kind!=='payment'||result.history.length<501||result.note===null||result.note.length>=result.history.length||!result.history.startsWith(result.note)))upstreamInvalid();
  return result;
}
export async function executeFinanceRoute(route,{userId,rpc}){
  const value=await rpc(route.rpc,{p_user_id:userId,...route.args});
  if(!object(value)||value.data_mode!=='erp_native')upstreamInvalid();
  if(route.bordero||route.kind==='bordero_page'||route.kind==='bordero_get')return projectBorderoResult(route,value);
  if(route.registry)return projectRegistryResult(route,value);
  if(route.cash)return projectCashResult(route,value);
  if(route.reconciliation)return projectReconciliationResult(route,value);
  if(route.recurrence)return projectRecurrenceResult(route,value);
  if(route.commissions)return projectCommissionResult(route,value);
  if(route.cashControl)return projectCashControlResult(route,value);
  if(route.groupedBilling)return projectGroupedBillingResult(route,value);
  if(route.report)return projectFinanceReport(route,value);
  if(route.cnabList)return projectCnabListResult(route,value);
  if(route.invoiceFinance)return projectInvoiceFinanceResult(route,value);
  if(route.kind==='payment_methods')return projectPaymentMethods(route,value);
  if(route.kind==='access'){
    if(value.read!==true||typeof value.write!=='boolean')upstreamInvalid();
    // SQL 246: the keys of Sistema > Usuários > Permissões the user has in the financeiro; older answers read as every key (null).
    const permitted=value.permitted===undefined?null:value.permitted;
    if(permitted!==null&&(!Array.isArray(permitted)||permitted.length>200||permitted.some(key=>typeof key!=='string'||!/^[a-z_]{1,40}(\.[a-z_]{1,40}){1,2}$/.test(key))||new Set(permitted).size!==permitted.length))upstreamInvalid();
    return {read:true,write:value.write,...(permitted!==null?{permitted}:{}),data_mode:'erp_native'};
  }
  const entity=route.entity||value.entity;if(!ENTITIES.includes(entity)||value.entity!==entity)upstreamInvalid();
  if(route.kind==='page')return projectTitlePage(route,value);
  if(route.kind==='detail'){const detail=projectDetail(value);if(detail.record.id!==route.args.p_id)upstreamInvalid();return detail;}
  if(route.kind==='list'){
    if(!Array.isArray(value.items)||value.items.length>route.args.p_limit||value.limit!==route.args.p_limit||typeof value.has_more!=='boolean'
      ||(value.has_more?!UUID.test(value.next_cursor||''):value.next_cursor!==null))upstreamInvalid();
    return {entity,items:value.items.map(item=>projectRecord(entity,item)),limit:value.limit,has_more:value.has_more,next_cursor:value.next_cursor,data_mode:'erp_native'};
  }
  const output={entity,data_mode:'erp_native'};
  if(route.kind==='execute'){
    if(value.action!==route.action||typeof value.replayed!=='boolean')upstreamInvalid();output.action=value.action;output.replayed=value.replayed;
    if(['title_create_group','title_create'].includes(route.action)){
      if(entity!=='titles'||!UUID.test(value.group_id||'')||!Array.isArray(value.items)||value.items.length<1||value.items.length>120)upstreamInvalid();
      return {...output,group_id:value.group_id,items:value.items.map(item=>projectRecord('titles',item))};
    }
  }
  output.record=projectRecord(entity,value.record);
  if(route.kind==='get'&&entity==='titles'&&value.origin!==undefined)output.origin=projectOrigin(value.origin,output.record);
  if(value.settlement!==undefined)output.settlement=projectRecord('settlements',value.settlement);
  if(value.account!==undefined)output.account=projectRecord('accounts',value.account);
  if(value.note!==undefined){if(value.note!==null&&(typeof value.note!=='string'||value.note.length>500))upstreamInvalid();output.note=value.note;}
  return output;
}
