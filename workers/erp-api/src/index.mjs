import { isConfiguredBackendOrigin } from '../../../packages/backend-config/src/origin.mjs';
import {backupImportRoute,backupImportMethods,parseBackupImportRoute,loadBackupImportPlan,executeBackupImport,BackupImportError} from './backup-import.mjs';
import {purchaseReceiptsMethods,parsePurchaseReceiptsRoute,executePurchaseReceiptsRoute,PurchaseReceiptsError} from './purchase-receipts.mjs';
import {PURCHASE_RECEIPTS_LIMITS} from '../../../packages/erp-domain/src/purchase-receipts-dto.mjs';
import {stockObservationsRoute,stockObservationsMethods,parseStockObservationsRoute,executeStockObservationsRoute,StockObservationsError,STOCK_OBSERVATIONS_MAX_BYTES} from './origin-stock-observations.mjs';
import {warehouseImportRoute,warehouseImportMethods,parseWarehouseImportRoute,executeWarehouseImportRoute,WarehouseImportError,WAREHOUSE_IMPORT_MAX_BYTES} from './origin-warehouse-import.mjs';
import {stockOpeningRoute,stockOpeningMethods,parseStockOpeningRoute,executeStockOpeningRoute,StockOpeningError,STOCK_OPENING_MAX_BYTES} from './stock-opening.mjs';
import {preferencesRoute,preferencesMethods,parsePreferencesRoute,executePreferencesRoute,PreferencesError,PREFERENCES_RESPONSE_BYTES} from './preferences.mjs';
import {itauLegacyReadinessRoute,itauLegacyReadinessMethods,parseItauLegacyReadinessRoute,executeItauLegacyReadinessRoute,ItauLegacyReadinessError,ITAU_LEGACY_MAX_BYTES} from './itau-legacy-readiness.mjs';
import {salesHistoryRoute,salesHistoryMethods,parseSalesHistoryRoute,executeSalesHistoryRoute,SalesHistoryError,SALES_HISTORY_MAX_BYTES} from './origin-sales-history.mjs';
import {stockReservationsMethods,parseStockReservationsRoute,executeStockReservationsRoute,StockReservationsError} from './stock-reservations.mjs';
import {parseBoletoPreviewRoute,executeBoletoPreviewRoute,boletoPreviewMethods,BoletoPreviewRouteError} from './boleto-preview.mjs';
/** Authenticated ERP boundary. No JWT decoding shortcut, browser service key, or free raw payload response. */
import {purchaseReadinessRoute,purchaseReadinessMethods,parsePurchaseReadinessRoute,executePurchaseReadinessRoute,PurchaseReadinessError,PURCHASE_READINESS_MAX_BYTES} from './origin-purchase-readiness.mjs';
import {salesReadinessRoute,salesReadinessMethods,parseSalesReadinessRoute,executeSalesReadinessRoute,SalesReadinessError,SALES_READINESS_MAX_BYTES} from './origin-sales-readiness.mjs';
import {originProposalImportRoute,originProposalImportMethods,parseOriginProposalImportRoute,executeOriginProposalImportRoute,OriginProposalImportError,ORIGIN_PROPOSAL_IMPORT_RESPONSE_BYTES} from './origin-proposal-import.mjs';
import {originProposalImportV2Route,originProposalImportV2Methods,parseOriginProposalImportV2Route,executeOriginProposalImportV2Route,OriginProposalImportV2Error,ORIGIN_PROPOSAL_IMPORT_V2_RESPONSE_BYTES} from './origin-proposal-import-v2.mjs';
import { catalogRoute, catalogMethods, catalogOperation, catalogResponse, catalogFailure, CatalogError } from './catalog.mjs';
import { withProductStockMirror, ProductStockMirrorError } from './product-stock-mirror.mjs';
import { sellerAccessGates } from './contacts.mjs';
import { parseHistoryRoute, executeHistoryRoute, HistoryError } from './history.mjs';
import { documentsRoute, documentsMethods, documentsOperation, documentsResponse, documentsFailure, DocumentsError } from './documents.mjs';
import { financeMethods, parseFinanceRoute, executeFinanceRoute, FinanceError } from './finance.mjs';
import { financeTransfersRoute, financeTransfersMethods, parseFinanceTransfersRoute, executeFinanceTransfersRoute, FinanceTransfersError, FINANCE_TRANSFERS_RESPONSE_BYTES } from './finance-transfers.mjs';
import { stockRoute, stockMethods, stockOperation, stockResponse, StockError } from './stock.mjs';
import { projectStockMirror } from './stock-mirror.mjs';
import { attachmentRoute, attachmentMethods, executeAttachmentRoute, createAttachmentStorage, AttachmentError } from './attachments.mjs';
import { catalogImportRoute, catalogImportMethods, catalogImportOperation, catalogImportResponse, CatalogImportError } from './catalog-import.mjs';
import {itauNetCreditMethods,parseItauNetCreditRoute,executeItauNetCreditRoute,ItauNetCreditError,ITAU_NET_CREDIT_RESPONSE_BYTES} from './itau-net-credit.mjs';
import {cnabReturnsMethods,parseCnabReturnsRoute,executeCnabReturnsRoute,CnabReturnsError} from './cnab-returns.mjs';
import {cnabOperationalMethods,parseCnabOperationalRoute,executeCnabOperationalRoute,CnabOperationalError} from './cnab-operational.mjs';
import {cnabOperationalV2Route,cnabOperationalV2Methods,parseCnabOperationalV2Route,executeCnabOperationalV2Route,CnabOperationalV2Error} from './cnab-operational-v2.mjs';
import { cnabMethods, parseCnabRoute, executeCnabRoute, createCnabStorage, CnabApiError } from './cnab.mjs';
import { companyRoute, companyMethods, companyOperation, companyResponse, CompanyError } from './company.mjs';
import { documentFinanceMethods, parseDocumentFinanceRoute, executeDocumentFinanceRoute, DocumentFinanceError } from './document-finance.mjs';
import { documentStockMethods, parseDocumentStockRoute, executeDocumentStockRoute, DocumentStockError } from './document-stock.mjs';
import {homeMethods,homeOperation,homeResponse,homeShortcutsOperation,homeShortcutsResponse,HomeError} from './home.mjs';
import {parseCutoverRoute,executeCutoverRoute,CutoverError} from './cutover.mjs';
import {fiscalDraftStatusRoute,fiscalDraftStatusMethods,parseFiscalDraftStatusRoute,executeFiscalDraftStatusRoute,FiscalDraftStatusError,FISCAL_DRAFT_STATUS_MAX_BYTES} from './fiscal-draft-status.mjs';
import {fiscalDraftRoute,fiscalDraftMethods,parseFiscalDraftRoute,executeFiscalDraftRoute,FiscalDraftError} from './fiscal-drafts.mjs';
import {cnabReviewMethods,parseCnabReviewRoute,executeCnabReviewRoute,CnabReviewError} from './cnab-review.mjs';
import {stockPositionsMethods,parseStockPositionsRoute,executeStockPositionsRoute,StockPositionsError} from './stock-positions.mjs';
import {dueReportMethods,parseDueReportRoute,executeDueReportRoute,DueReportError} from './due-report.mjs';
import {fiscalReviewRoute,fiscalReviewMethods,parseFiscalReviewRoute,executeFiscalReviewRoute,FiscalReviewError} from './fiscal-review.mjs';
import {serviceJournalMethods,parseServiceJournalRoute,executeServiceJournalRoute,ServiceJournalError} from './service-journal.mjs';
import {serviceEventsRoute,serviceEventsMethods,parseServiceEventsRoute,executeServiceEventsRoute,ServiceEventsError,SERVICE_EVENTS_RESPONSE_BYTES} from './service-events.mjs';
import {syncedXmlMethods,parseSyncedXmlRoute,executeSyncedXmlRoute,SyncedXmlError} from './synced-xml.mjs';
import {documentServiceConversionMethods,parseDocumentServiceConversionRoute,executeDocumentServiceConversionRoute,DocumentServiceConversionError} from './document-service-conversion.mjs';
import {integrationProgressMethods,parseIntegrationProgressRoute,executeIntegrationProgressRoute,IntegrationProgressError} from './integration-progress.mjs';
import {documentCopyMethods,parseDocumentCopyRoute,executeDocumentCopyRoute,DocumentCopyError} from './document-copy.mjs';
import {fiscalItemRoute,fiscalItemMethods,parseFiscalItemRoute,executeFiscalItemRoute,FiscalItemError} from './fiscal-item-preparation.mjs';
import {fiscalTaxRoute,fiscalTaxMethods,parseFiscalTaxRoute,executeFiscalTaxRoute,FiscalTaxError,FISCAL_TAX_RESPONSE_BYTES} from './fiscal-tax-preparation.mjs';
import {financialImportMethods,parseFinancialImportRoute,executeFinancialImportRoute,FinancialImportError} from './financial-import.mjs';
import {financialCutoverMethods,parseFinancialCutoverRoute,executeFinancialCutoverRoute,FinancialCutoverError} from './financial-cutover.mjs';
import {dfeDistributionMethods,parseDfeDistributionRoute,executeDfeDistributionRoute,DfeDistributionError} from './dfe-distribution.mjs';
import {fiscalNumberingMethods,parseFiscalNumberingRoute,executeFiscalNumberingRoute,FiscalNumberingError,FISCAL_NUMBERING_RESPONSE_BYTES} from './fiscal-numbering.mjs';
import {fiscalCompletionMethods,parseFiscalCompletionRoute,executeFiscalCompletionRoute,FiscalCompletionError,FISCAL_COMPLETION_RESPONSE_BYTES} from './fiscal-completion.mjs';
import {fiscalInvoicesRoute,fiscalInvoicesMethods,parseFiscalInvoicesRoute,executeFiscalInvoicesRoute,FiscalInvoicesError,fiscalInvoicesRefusal} from './fiscal-invoices.mjs';
import {posRoute,posMethods,parsePosRoute,executePosRoute,posRefusal,PosError} from './pos.mjs';
import {platformRoute,platformMethods,parsePlatformRoute,executePlatformRoute,runPlatformTasks,createServiceRpc,createExportStorage,lookupCep,PlatformError} from './platform.mjs';
import {securityRoute,securityMethods,parseSecurityRoute,executeSecurityRoute,SecurityError} from './security.mjs';
import {originSyncRoute,originSyncMethods,originSyncStatus,runOriginTwoWay,OriginSyncRouteError} from './origin-two-way.mjs';
import originConnector from '../../origin-sync/src/index.mjs';
import {catalogMirrorRoute,catalogMirrorMethods,parseCatalogMirrorRoute,executeCatalogMirrorRoute,CatalogMirrorError} from './catalog-mirror.mjs';
import {systemUpdateRoute,handleSystemUpdate} from './system-updates.mjs';
export const ENTITIES = Object.freeze(['contacts', 'products', 'sales_orders', 'purchase_orders', 'sales_proposals', 'receivables', 'payables', 'nfe', 'nfce']);
const ROLES = ['admin', 'consulta', 'vendas', 'financeiro', 'estoque', 'fiscal'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Leva H (310): session_id and aal of a token Auth has already validated (/auth/v1/user), read only to ask the database about
 * that session (auth.sessions decides aal2). Anything unreadable is a session the database cannot find: never aal2. */
export function tokenSession(token) {
  try {
    const part = String(token).split('.')[1];
    if (!part || part.length > 6000) return { session_id: null, aal: 'aal1' };
    const claims = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=')), c => c.charCodeAt(0))));
    return { session_id: typeof claims?.session_id === 'string' && UUID.test(claims.session_id) ? claims.session_id.toLowerCase() : null, aal: claims?.aal === 'aal2' ? 'aal2' : 'aal1' };
  } catch { return { session_id: null, aal: 'aal1' }; }
}
const SUMMARY_KEYS = ['id', 'entity', 'name', 'code', 'number', 'date', 'due_date', 'status', 'amount', 'balance', 'counterparty_id', 'counterparty_name', 'model', 'series', 'direction', 'last_seen_at'];
const MAX_RESPONSE_BYTES = 1_048_576;

class ApiError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

function config(env) {
  let url;
  try { url = new URL(env.SUPABASE_URL); } catch { throw new ApiError(503, 'ERP_NOT_CONFIGURED'); }
  if (!isConfiguredBackendOrigin(env.SUPABASE_URL, env.SUPABASE_DEPLOYMENT, { allowTrailingSlash: true, legacyHosted: true })) throw new ApiError(503, 'ERP_NOT_CONFIGURED');
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (typeof key !== 'string' || !key || key.length > 8192 || /\s/.test(key)) throw new ApiError(503, 'ERP_NOT_CONFIGURED');
  const origins = String(env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
  for (const origin of origins) {
    let candidate;
    try { candidate = new URL(origin); } catch { throw new ApiError(503, 'ERP_NOT_CONFIGURED'); }
    if (candidate.origin !== origin || candidate.username || candidate.password || !['https:', 'http:'].includes(candidate.protocol)
      || (candidate.protocol === 'http:' && !['127.0.0.1', 'localhost'].includes(candidate.hostname))) throw new ApiError(503, 'ERP_NOT_CONFIGURED');
  }
  return { baseUrl: url.origin, key, origins };
}

async function readJson(response, limit = MAX_RESPONSE_BYTES, signal, deadline) {
  const declared = Number(response.headers.get('content-length'));
  if (declared > limit || !response.body) { if(signal)void response.body?.cancel().catch(()=>{}); throw new ApiError(502, 'ERP_UPSTREAM_INVALID_RESPONSE'); }
  const reader = response.body.getReader();
  const cancelled=()=>{void reader.cancel().catch(()=>{});};signal?.addEventListener('abort',cancelled,{once:true});
  let bytes = 0;
  let text = '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    while (true) {
      if(signal&&(signal.aborted||Date.now()>=deadline))throw new ApiError(408,'ERP_REQUEST_TIMEOUT');
      const { value, done } = await reader.read();
      if(signal&&(signal.aborted||Date.now()>=deadline))throw new ApiError(408,'ERP_REQUEST_TIMEOUT');
      if (done) break;
      if(signal&&!value.byteLength)throw new ApiError(502,'ERP_UPSTREAM_INVALID_RESPONSE');
      bytes += value.byteLength;
      if (bytes > limit) throw new ApiError(502, 'ERP_UPSTREAM_INVALID_RESPONSE');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch { throw new ApiError(502, 'ERP_UPSTREAM_INVALID_RESPONSE'); }
  finally { signal?.removeEventListener('abort',cancelled);if(signal)void reader.cancel().catch(()=>{});else try { await reader.cancel(); } catch { /* Do not log upstream data. */ } reader.releaseLock(); }
}

function integerParam(params, name, fallback, min, max) {
  const text = params.get(name);
  if (text === null) return fallback;
  if (!/^\d{1,6}$/.test(text)) throw new ApiError(400, 'ERP_INVALID_QUERY');
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new ApiError(400, 'ERP_INVALID_QUERY');
  return value;
}

function dateParam(value) {
  if (value === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > '2100-12-31') throw new ApiError(400, 'ERP_INVALID_QUERY');
  const time = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) throw new ApiError(400, 'ERP_INVALID_QUERY');
  return value;
}

export function parseListQuery(params) {
  const allowed = new Set(['limit', 'offset', 'q', 'status', 'from', 'to']);
  for (const key of params.keys()) if (!allowed.has(key) || params.getAll(key).length !== 1) throw new ApiError(400, 'ERP_INVALID_QUERY');
  const query = params.get('q');
  const status = params.get('status');
  if ((query !== null && (query.length > 120 || /[\x00-\x1f\x7f]/.test(query)))
    || (status !== null && (status.length > 80 || /[\x00-\x1f\x7f]/.test(status)))) throw new ApiError(400, 'ERP_INVALID_QUERY');
  const from = dateParam(params.get('from'));
  const to = dateParam(params.get('to'));
  if (from && to && from > to) throw new ApiError(400, 'ERP_INVALID_QUERY');
  return { p_limit: integerParam(params, 'limit', 25, 1, 100), p_offset: integerParam(params, 'offset', 0, 0, 100000),
    p_query: query?.trim() || null, p_status: status || null, p_from: from, p_to: to };
}

function safeList(result, entity, query) {
  if (!result || result.entity !== entity || result.data_mode !== 'staging_readonly' || !Array.isArray(result.items)
    || result.items.length > query.p_limit || result.limit !== query.p_limit || result.offset !== query.p_offset
    || !Number.isSafeInteger(result.total) || result.total < 0 || typeof result.has_more !== 'boolean'
    || result.next_offset !== (result.has_more ? query.p_offset + query.p_limit : null)) throw new ApiError(502, 'ERP_UPSTREAM_INVALID_RESPONSE');
  const items = result.items.map(row => {
    if (!row || typeof row.id !== 'string' || !row.id || row.id.length > 200 || row.entity !== entity) throw new ApiError(502, 'ERP_UPSTREAM_INVALID_RESPONSE');
    const safe = {};
    for (const key of SUMMARY_KEYS) {
      const value = row[key] ?? null;
      if (value !== null && (typeof value !== 'string' || value.length > 200)) throw new ApiError(502, 'ERP_UPSTREAM_INVALID_RESPONSE');
      safe[key] = value;
    }
    return safe;
  });
  return { entity, items, limit: result.limit, offset: result.offset, total: result.total,
    has_more: result.has_more, next_offset: result.next_offset, data_mode: 'staging_readonly' };
}

export function createHandler({ fetchImpl = globalThis.fetch, timeoutMs = 8000, cepLookup = cep => lookupCep(cep, { fetchImpl }) } = {}) {
  async function upstream(url, options, kind, boundedDeadline) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), boundedDeadline===undefined?timeoutMs:Math.max(0,Math.min(kind==='itauLegacy'?15000:timeoutMs,boundedDeadline-Date.now())));
    const cancel = () => controller.abort();
    options.signal?.addEventListener('abort', cancel, {once:true});
    if(options.signal?.aborted)controller.abort();
    let rejectAborted;const onAbort=()=>rejectAborted?.(new ApiError(408,'ERP_REQUEST_TIMEOUT'));
    const aborted=boundedDeadline===undefined?null:new Promise((_,reject)=>{rejectAborted=reject;controller.signal.addEventListener('abort',onAbort,{once:true});});aborted?.catch(()=>{});
    const check=()=>{if(boundedDeadline!==undefined&&(controller.signal.aborted||Date.now()>=boundedDeadline))throw new ApiError(408,'ERP_REQUEST_TIMEOUT');};
    try {
      check();const fetched=fetchImpl(url, { ...options, redirect: 'manual', signal: controller.signal });
      if(aborted)void Promise.resolve(fetched).then(r=>{if(controller.signal.aborted)void r.body?.cancel().catch(()=>{});},()=>{});
      const response = await(aborted?Promise.race([fetched,aborted]):fetched);
      try{check();}catch(e){void response.body?.cancel().catch(()=>{});throw e;}
      if(boundedDeadline!==undefined&&response.redirected){void response.body?.cancel().catch(()=>{});throw new ApiError(502,'ERP_UPSTREAM_INVALID_RESPONSE');}
      if (kind === 'cnabOperationalV2' && (response.redirected || Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES)) { void response.body?.cancel().catch(()=>{}); throw new ApiError(502,'ERP_UPSTREAM_INVALID_RESPONSE'); }
      if (!response.ok) {
        if (['preferences', 'backupImport', 'purchaseReceipts', 'stockObservations', 'warehouseImport', 'stockOpening', 'itauLegacy', 'salesHistory', 'fiscalDraftStatus', 'salesReadiness', 'purchaseReadiness', 'stockReservations', 'boletoPreview', 'catalog', 'history', 'documents', 'finance', 'financeTransfers', 'originProposalImport', 'originProposalImportV2', 'stock', 'attachments', 'catalogImport', 'cnab', 'cnabOperational', 'cnabOperationalV2', 'cnabReturns', 'itauNetCredit', 'company', 'documentFinance','documentStock','home','cutover','fiscalDraft','cnabReview','stockPositions','dueReport','syncedXml','serviceJournal','serviceEvents','fiscalReview','documentServiceConversion','integrationProgress','documentCopy','fiscalItem','fiscalTax','financialCutover','financialImport','dfeDistribution','fiscalNumbering','fiscalCompletion','pos','platform'].includes(kind) && response.status >= 400 && response.status < 600) {
          let problem;
          try { problem = await readJson(response, kind==='preferences' ? PREFERENCES_RESPONSE_BYTES : kind==='purchaseReceipts' ? PURCHASE_RECEIPTS_LIMITS.responseBytes : kind==='stockObservations' ? STOCK_OBSERVATIONS_MAX_BYTES : kind==='warehouseImport' ? WAREHOUSE_IMPORT_MAX_BYTES : kind==='stockOpening' ? STOCK_OPENING_MAX_BYTES : kind==='itauLegacy' ? ITAU_LEGACY_MAX_BYTES : kind==='salesHistory' ? SALES_HISTORY_MAX_BYTES : kind==='fiscalDraftStatus' ? FISCAL_DRAFT_STATUS_MAX_BYTES : MAX_RESPONSE_BYTES,boundedDeadline===undefined?undefined:controller.signal,boundedDeadline);check(); } catch { /* Response is never exposed. */ }
          if (problem?.code === '42501' && ['erp_document_mirror_readonly', 'erp_document_mirror_effect_forbidden', 'erp_document_mirror_import_forbidden'].includes(problem.message)) throw new ApiError(409, 'MODULE_OWNED_BY_ORIGIN');
          const errors = { '42501': [403, 'ERP_FORBIDDEN'], '28000': [403, 'ERP_MFA_REQUIRED'], '22023': [400, 'ERP_INVALID_QUERY'], P0002: [404, 'ERP_NOT_FOUND'], '40001': [409, 'ERP_CONFLICT'], '23505': [409, 'ERP_CONFLICT'],
            ...(['warehouseImport','stockOpening','preferences'].includes(kind) ? { '42501':[403,'ERP_ACCESS_DENIED'],'22023':[400,'ERP_INVALID_INPUT'] } : {}),
            ...(kind === 'boletoPreview' ? { '22023': [422, 'ERP_BOLETO_PREVIEW_UNAVAILABLE'], '0A000': [422, 'ERP_BOLETO_PREVIEW_UNAVAILABLE'] } : {}),
            ...(kind === 'dfeDistribution' ? { '55000': [503, 'ERP_DFE_STORAGE_UNAVAILABLE'] } : {}),
            ...(kind === 'fiscalNumbering' ? { '55000': [503, 'ERP_FISCAL_NUMBERING_UNAVAILABLE'] } : {}),
            ...(kind === 'fiscalCompletion' ? { '55000': [503, 'ERP_FISCAL_COMPLETION_UNAVAILABLE'] } : {}),
            ...(['financeTransfers','itauNetCredit','cnabOperationalV2'].includes(kind) ? { '55000': [409, 'ERP_CONFLICT'] } : {}),
            ...(['originProposalImport','originProposalImportV2'].includes(kind) ? { '22023': [422, 'ERP_VALIDATION_FAILED'] } : {}),
            ...(kind === 'serviceEvents' ? { '54000': [409, 'ERP_SERVICE_EVENT_LIMIT'] } : {}),
            ...(kind === 'platform' ? { '42501': [403, 'ERP_ACCESS_DENIED'], '22023': [400, 'ERP_INVALID_INPUT'], '55000': [409, 'ERP_CONFLICT'] } : {}),
            ...(kind === 'attachments' ? { '54000': [409, 'ERP_ATTACHMENT_QUOTA'], '55000': [503, 'ERP_ATTACHMENT_STORAGE_UNAVAILABLE'] } : {}) };
          if (problem && Object.hasOwn(errors, problem.code)) { const [status, code] = errors[problem.code], failure = new ApiError(status, code);
            // Contatos (wave C): the SQL message stays on the error only to pick an allow-listed code (catalogFailure); it is never sent.
            if ((kind === 'catalog' || kind === 'documents' || kind === 'pos' || kind === 'platform' || kind === 'fiscalDraft') && typeof problem.message === 'string') failure.upstreamMessage = problem.message.slice(0, 120);
            throw failure; }
        }
        if(boundedDeadline!==undefined){void response.body?.cancel().catch(()=>{});check();}
        else try { await response.body?.cancel(); } catch { /* No upstream body is logged. */ }
        if (kind === 'auth' && [401, 403].includes(response.status)) throw new ApiError(401, 'ERP_UNAUTHENTICATED');
        if (kind === 'rpc' && response.status === 403) throw new ApiError(403, 'ERP_FORBIDDEN');
        if (kind === 'rpc' && response.status === 400) throw new ApiError(400, 'ERP_INVALID_QUERY');
        // Supabase Auth refuses an invite in one transaction (no account is left behind): a 4xx is a definitive refusal.
        if (kind === 'authInvite' && response.status >= 400 && response.status < 500) throw new ApiError(422, 'ERP_USERS_INVITE_REFUSED');
        throw new ApiError(response.status === 429 ? 503 : 502, 'ERP_UPSTREAM_UNAVAILABLE');
      }
      const result=await readJson(response, kind==='preferences' ? PREFERENCES_RESPONSE_BYTES : kind==='purchaseReceipts' ? PURCHASE_RECEIPTS_LIMITS.responseBytes : kind==='stockObservations' ? STOCK_OBSERVATIONS_MAX_BYTES : kind==='warehouseImport' ? WAREHOUSE_IMPORT_MAX_BYTES : kind==='stockOpening' ? STOCK_OPENING_MAX_BYTES : kind==='itauLegacy' ? ITAU_LEGACY_MAX_BYTES : kind==='salesHistory' ? SALES_HISTORY_MAX_BYTES : kind==='fiscalDraftStatus' ? FISCAL_DRAFT_STATUS_MAX_BYTES : kind==='salesReadiness' ? SALES_READINESS_MAX_BYTES : kind==='purchaseReadiness' ? PURCHASE_READINESS_MAX_BYTES : kind==='boletoPreview' ? 262144 : kind==='itauNetCredit' ? ITAU_NET_CREDIT_RESPONSE_BYTES : kind==='originProposalImportV2' ? ORIGIN_PROPOSAL_IMPORT_V2_RESPONSE_BYTES : kind==='originProposalImport' ? ORIGIN_PROPOSAL_IMPORT_RESPONSE_BYTES : kind==='financeTransfers' ? FINANCE_TRANSFERS_RESPONSE_BYTES : kind==='serviceEvents' ? SERVICE_EVENTS_RESPONSE_BYTES : kind==='fiscalCompletion' ? FISCAL_COMPLETION_RESPONSE_BYTES : kind==='fiscalNumbering' ? FISCAL_NUMBERING_RESPONSE_BYTES : kind==='fiscalTax' ? FISCAL_TAX_RESPONSE_BYTES : ['documents', 'cnab','cnabOperational', 'cnabReturns','documentServiceConversion','documentCopy','fiscalItem'].includes(kind) ? 8 * MAX_RESPONSE_BYTES : ['catalogImport','fiscalDraft','fiscalReview'].includes(kind) ? 4 * MAX_RESPONSE_BYTES : MAX_RESPONSE_BYTES,boundedDeadline===undefined?undefined:controller.signal,boundedDeadline);check();return result;
    } catch (error) {
      if(boundedDeadline!==undefined&&(controller.signal.aborted||Date.now()>=boundedDeadline))throw new ApiError(408,'ERP_REQUEST_TIMEOUT');
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, 'ERP_UPSTREAM_UNAVAILABLE');
    } finally { clearTimeout(timeout); options.signal?.removeEventListener('abort',cancel);controller.signal.removeEventListener('abort',onAbort); controller.abort(); }
  }

  // Preferências lane (229): a user with access windows (Sistema › Usuários sets app_metadata.brufap_access_gate) is checked at
  // every request; the answer is kept for the São Paulo minute. Users without the flag make no extra call.
  // Leva H (310): while the MFA policy is on every member carries the flag, and the database also answers whether this session
  // (the session_id of the token Auth has just validated) reached aal2 when the user needs it. The aal of the token only splits
  // the cache, so a session verified a moment ago is asked again; it is never trusted on its own.
  const gateCache = new Map();
  async function accessGate(user, settings, token, force = false) {
    if (!force && user?.app_metadata?.brufap_access_gate !== true) return;
    const claims = tokenSession(token);
    const key = `${user.id}:${claims.session_id ?? '-'}:${claims.aal}:${Math.floor(Date.now() / 60000)}`;
    let gate = gateCache.get(key);
    if (gate === undefined) {
      const answer = await upstream(`${settings.baseUrl}/rest/v1/rpc/erp_access_gate_v2`, { method: 'POST', headers: { apikey: settings.key, Authorization: `Bearer ${settings.key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ p_user_id: user.id, p_session_id: claims.session_id }) }, 'rpc');
      if (!answer || answer.scope !== 'access_gate' || answer.user_id !== user.id || typeof answer.open !== 'boolean' || typeof answer.mfa_required !== 'boolean' || typeof answer.mfa_ok !== 'boolean') throw new ApiError(502, 'ERP_UPSTREAM_INVALID_RESPONSE');
      gate = { open: answer.open, mfa: answer.mfa_ok }; if (gateCache.size > 1000) gateCache.clear(); gateCache.set(key, gate);
    }
    if (!gate.open) throw new ApiError(403, 'ERP_ACCESS_OUTSIDE_SCHEDULE');
    if (!gate.mfa) throw new ApiError(403, 'ERP_MFA_REQUIRED');
  }
  return async function handle(request, env, ctx) {
    const requestId = crypto.randomUUID();
    const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Vary': 'Origin', 'X-Request-Id': requestId });
    const respond = (status, body) => new Response(body === null ? null : JSON.stringify(body), { status, headers });
    try {
      const settings = config(env);
      const url = new URL(request.url);
      if (['/integracao-externa', '/admin/status', '/admin/oauth/start', '/oauth/callback'].includes(url.pathname)) {
        if (env.ORIGIN_CONNECTOR_ENABLED !== 'true' || env.ORIGIN_ENABLED !== 'true') throw new ApiError(404,'ERP_NOT_FOUND');
        if (url.pathname === '/integracao-externa') {
          if (request.method !== 'GET') throw new ApiError(405,'ERP_METHOD_NOT_ALLOWED');
          url.pathname = '/';
          return originConnector.fetch(new Request(url, request), env);
        }
        return originConnector.fetch(request, env);
      }
      if(systemUpdateRoute(url.pathname))return handleSystemUpdate({request,env,settings,fetchImpl,authenticate:async token=>{
        const user=await upstream(`${settings.baseUrl}/auth/v1/user`,{method:'GET',headers:{apikey:settings.key,Authorization:`Bearer ${token}`,Accept:'application/json'}},'auth');
        if(!user||typeof user.id!=='string'||!UUID.test(user.id))throw new ApiError(401,'ERP_UNAUTHENTICATED');
        if(user.is_anonymous===true)throw new ApiError(403,'ERP_FORBIDDEN');
        await accessGate(user,settings,token,true);
        const access=await upstream(`${settings.baseUrl}/rest/v1/rpc/erp_access_me`,{method:'POST',headers:{apikey:settings.key,Authorization:`Bearer ${settings.key}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({p_user_id:user.id})},'access');
        if(access?.user_id!==user.id||access?.role!=='admin')throw new ApiError(403,'ERP_FORBIDDEN');
        return user.id.toLowerCase();
      }});
      const backupImport = backupImportRoute(url.pathname);
      const backupAuthDeadline = backupImport ? Date.now()+15000 : undefined;
      const catalog = catalogRoute(url.pathname);
      const history = parseHistoryRoute(url);
      const documents = documentsRoute(url.pathname);
      const finance = url.pathname === '/v1/financeiro' || url.pathname.startsWith('/v1/financeiro/');
      const financeTransfers = financeTransfersRoute(url.pathname);
      const stockObservations=stockObservationsRoute(url.pathname),stockObservationsDeadline=stockObservations?Date.now()+20000:undefined;
      const warehouseImport=warehouseImportRoute(url.pathname),warehouseDeadline=warehouseImport?Date.now()+20000:undefined;
      const stockOpening=stockOpeningRoute(url.pathname),stockOpeningDeadline=stockOpening?Date.now()+30000:undefined;
      const preferences=preferencesRoute(url.pathname),preferencesDeadline=preferences?Date.now()+25000:undefined;
      const itauLegacy=itauLegacyReadinessRoute(url.pathname),itauLegacyDeadline=itauLegacy?Date.now()+15000:undefined;
      const fiscalDraftStatus = fiscalDraftStatusRoute(url.pathname);
      const salesHistory = salesHistoryRoute(url.pathname);
      const salesReadiness = salesReadinessRoute(url.pathname);
      const purchaseReadiness = purchaseReadinessRoute(url.pathname);
      const originProposalImportV2 = originProposalImportV2Route(url.pathname);
      const originProposalImport = originProposalImportRoute(url.pathname);
      const stock = stockRoute(url.pathname);
      const purchaseReceipts = url.pathname==='/v1/recebimentos-compras'||url.pathname.startsWith('/v1/recebimentos-compras/');
      const purchaseReceiptsDeadline=purchaseReceipts?Date.now()+30000:undefined;
      const stockReservations = url.pathname==='/v1/reservas-estoque'||url.pathname.startsWith('/v1/reservas-estoque/');
      const attachments = attachmentRoute(url.pathname);
      const catalogImport = catalogImportRoute(url.pathname);
      const fiscalNumbering = url.pathname === '/v1/numeracao-fiscal' || url.pathname.startsWith('/v1/numeracao-fiscal/');
      const fiscalCompletion = url.pathname === '/v1/complemento-fiscal' || url.pathname.startsWith('/v1/complemento-fiscal/');
      const dfeDistribution = url.pathname === '/v1/notas-recebidas' || url.pathname.startsWith('/v1/notas-recebidas/');
      const itauNetCredit = url.pathname === '/v1/retornos-itau109' || url.pathname.startsWith('/v1/retornos-itau109/');
      const boletoPreview = url.pathname === '/v1/boletos-itau' || url.pathname.startsWith('/v1/boletos-itau/');
      const cnabReturns = url.pathname === '/v1/retornos-operacionais' || url.pathname.startsWith('/v1/retornos-operacionais/');
      const cnabOperationalV2 = cnabOperationalV2Route(url.pathname);
      const cnabOperational = url.pathname === '/v1/cobranca-operacional' || url.pathname.startsWith('/v1/cobranca-operacional/');
      const cnab = url.pathname === '/v1/cnab' || url.pathname.startsWith('/v1/cnab/');
      const company = companyRoute(url.pathname);
      const fiscalItem=url.pathname==='/v1/preparacao-itens-fiscais'||url.pathname.startsWith('/v1/preparacao-itens-fiscais/');
      const fiscalTax=url.pathname==='/v1/preparacao-tributaria'||url.pathname.startsWith('/v1/preparacao-tributaria/');
      const financialImport=financialImportMethods(url.pathname)!==null;
      const financialCutover=financialCutoverMethods(url.pathname)!==null;
      const documentCopy = documentCopyMethods(url.pathname)!==null;
      const integrationProgress = integrationProgressMethods(url.pathname)!==null;
      const documentServiceConversion = documentServiceConversionMethods(url.pathname)!==null;
      const documentFinance = /^\/v1\/documentos\/[^/]+\/[^/]+\/financeiro(?:\/|$)/.test(url.pathname);
      const documentStock = url.pathname==='/v1/documentos-estoque'||url.pathname.startsWith('/v1/documentos-estoque/');
      const home=homeMethods(url.pathname)!==null;
      const cutover=url.pathname==='/v1/preparacao-virada'||url.pathname.startsWith('/v1/preparacao-virada/');
      const fiscalReview=fiscalReviewRoute(url.pathname);
      const fiscalDraft=url.pathname==='/v1/rascunhos-fiscais'||url.pathname.startsWith('/v1/rascunhos-fiscais/');
      const cnabReview=url.pathname==='/v1/conferencia-retornos'||url.pathname.startsWith('/v1/conferencia-retornos/');
      const stockPositions=url.pathname==='/v1/posicoes-estoque'||url.pathname.startsWith('/v1/posicoes-estoque/');
      const serviceEvents=serviceEventsRoute(url.pathname);
      const serviceJournal=!serviceEvents&&(url.pathname==='/v1/ordens-servico'||url.pathname.startsWith('/v1/ordens-servico/'));
      const dueReport=url.pathname==='/v1/relatorios/vencimentos'||url.pathname.startsWith('/v1/relatorios/vencimentos/');
      const syncedXml=url.pathname==='/v1/xmls-sincronizados'||url.pathname.startsWith('/v1/xmls-sincronizados/');
      // Notas fiscais (202610200111-114): self-contained dispatch with the same origin, preflight and session checks as below.
      const fiscalInvoices=fiscalInvoicesRoute(url.pathname);
      if(fiscalInvoices){
        const methods=fiscalInvoicesMethods(fiscalInvoices),origin=request.headers.get('Origin');
        if(origin!==null){if(!settings.origins.includes(origin))throw new ApiError(403,'ERP_ORIGIN_NOT_ALLOWED');headers.set('Access-Control-Allow-Origin',origin);}
        if(request.method==='OPTIONS'){
          const requested=request.headers.get('Access-Control-Request-Headers')||'';
          if(!origin||!methods.includes(request.headers.get('Access-Control-Request-Method'))||requested.split(',').map(item=>item.trim().toLowerCase()).filter(Boolean).some(item=>!['authorization','content-type'].includes(item)))throw new ApiError(403,'ERP_PREFLIGHT_DENIED');
          headers.set('Access-Control-Allow-Methods',methods.join(', '));headers.set('Access-Control-Allow-Headers','Authorization, Content-Type');return respond(204,null);
        }
        if(!methods.includes(request.method)){headers.set('Allow',[...methods,'OPTIONS'].join(', '));throw new ApiError(405,'ERP_METHOD_NOT_ALLOWED');}
        const token=/^Bearer ([^\s]+)$/i.exec(request.headers.get('Authorization')||'')?.[1];
        if(!token||token.length>8192)throw new ApiError(401,'ERP_UNAUTHENTICATED');
        const user=await upstream(`${settings.baseUrl}/auth/v1/user`,{method:'GET',headers:{apikey:settings.key,Authorization:`Bearer ${token}`,Accept:'application/json'}},'auth');
        if(!user||typeof user.id!=='string'||!UUID.test(user.id))throw new ApiError(401,'ERP_UNAUTHENTICATED');
        if(user.is_anonymous===true)throw new ApiError(403,'ERP_FORBIDDEN');
        await accessGate(user,settings,token);
        try{
          const parsed=await parseFiscalInvoicesRoute(request,fiscalInvoices);
          return respond(200,await executeFiscalInvoicesRoute(parsed,{userId:user.id,rpc:(name,args)=>upstream(`${settings.baseUrl}/rest/v1/rpc/${name}`,{
            method:'POST',headers:{apikey:settings.key,Authorization:`Bearer ${settings.key}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(args),
          },'fiscalDraft')}));
        }catch(error){if(error instanceof FiscalInvoicesError)throw new ApiError(error.status,error.code);
          // Notas lane (wave F): only an allow-listed refusal name goes back, as the field of the error (finance_posted, stock_posted).
          if(error instanceof ApiError&&typeof error.upstreamMessage==='string'){const reason=fiscalInvoicesRefusal(error.upstreamMessage);delete error.upstreamMessage;if(reason)error.field=reason;}throw error;}
      }
      // Sincronização de mão dupla com o Origin (009-011): GET situação, POST pede uma rodada e já começa a executá-la.
      if(originSyncRoute(url.pathname)){
        if(request.method==='POST'&&(env.ORIGIN_ENABLED!=='true'||env.ORIGIN_TWO_WAY_ENABLED!=='true'))throw new ApiError(503,'ORIGIN_DISABLED');
        if(request.method==='POST'&&env.ORIGIN_WRITE_ENABLED==='false')throw new ApiError(409,'ORIGIN_RECEIVE_ONLY');
        const methods=originSyncMethods(),origin=request.headers.get('Origin');
        if(origin!==null){if(!settings.origins.includes(origin))throw new ApiError(403,'ERP_ORIGIN_NOT_ALLOWED');headers.set('Access-Control-Allow-Origin',origin);}
        if(request.method==='OPTIONS'){
          const requested=request.headers.get('Access-Control-Request-Headers')||'';
          if(!origin||!methods.includes(request.headers.get('Access-Control-Request-Method'))||requested.split(',').map(item=>item.trim().toLowerCase()).filter(Boolean).some(item=>!['authorization','content-type'].includes(item)))throw new ApiError(403,'ERP_PREFLIGHT_DENIED');
          headers.set('Access-Control-Allow-Methods',methods.join(', '));headers.set('Access-Control-Allow-Headers','Authorization, Content-Type');return respond(204,null);
        }
        if(!methods.includes(request.method)){headers.set('Allow',[...methods,'OPTIONS'].join(', '));throw new ApiError(405,'ERP_METHOD_NOT_ALLOWED');}
        if(url.search)throw new ApiError(400,'ERP_INVALID_QUERY');
        const token=/^Bearer ([^\s]+)$/i.exec(request.headers.get('Authorization')||'')?.[1];
        if(!token||token.length>8192)throw new ApiError(401,'ERP_UNAUTHENTICATED');
        const user=await upstream(`${settings.baseUrl}/auth/v1/user`,{method:'GET',headers:{apikey:settings.key,Authorization:`Bearer ${token}`,Accept:'application/json'}},'auth');
        if(!user||typeof user.id!=='string'||!UUID.test(user.id))throw new ApiError(401,'ERP_UNAUTHENTICATED');
        if(user.is_anonymous===true)throw new ApiError(403,'ERP_FORBIDDEN');
        await accessGate(user,settings,token);
        const call=(name,args)=>upstream(`${settings.baseUrl}/rest/v1/rpc/${name}`,{method:'POST',headers:{apikey:settings.key,Authorization:`Bearer ${settings.key}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(args)},'platform');
        try{
          const result=originSyncStatus(await call(request.method==='POST'?'erp_sync_request':'erp_sync_status',{p_user_id:user.id}));
          if(request.method==='POST'&&typeof ctx?.waitUntil==='function'){
            const rpc=createServiceRpc({baseUrl:settings.baseUrl,key:settings.key,fetchImpl});
            ctx.waitUntil(runOriginTwoWay({rpc,env,budgetMs:25000}).catch(()=>null));
          }
          return respond(200,{...result,enabled:result.enabled&&env.ORIGIN_ENABLED==='true'&&env.ORIGIN_TWO_WAY_ENABLED==='true',
            connection: env.ORIGIN_CONNECTOR_ENABLED === 'true' ? {
              name: env.ORIGIN_CONNECTION_NAME || 'Integração externa',
              mode: env.ORIGIN_CONNECTION_MODE || 'paused',
              setup_url: new URL('/integracao-externa',env.PUBLIC_BASE_URL).href,
            } : null});
        }catch(error){if(error instanceof OriginSyncRouteError)throw new ApiError(error.status,error.code);throw error;}
      }
      // Leva H (310): Preferências › Segurança, self-contained dispatch with the same origin, preflight and session checks.
      if(securityRoute(url.pathname)){
        const methods=securityMethods(url.pathname),origin=request.headers.get('Origin');
        if(origin!==null){if(!settings.origins.includes(origin))throw new ApiError(403,'ERP_ORIGIN_NOT_ALLOWED');headers.set('Access-Control-Allow-Origin',origin);}
        if(request.method==='OPTIONS'){
          const requested=request.headers.get('Access-Control-Request-Headers')||'';
          if(!origin||!methods.includes(request.headers.get('Access-Control-Request-Method'))||requested.split(',').map(item=>item.trim().toLowerCase()).filter(Boolean).some(item=>!['authorization','content-type'].includes(item)))throw new ApiError(403,'ERP_PREFLIGHT_DENIED');
          headers.set('Access-Control-Allow-Methods',methods.join(', '));headers.set('Access-Control-Allow-Headers','Authorization, Content-Type');return respond(204,null);
        }
        if(!methods.includes(request.method)){headers.set('Allow',[...methods,'OPTIONS'].join(', '));throw new ApiError(405,'ERP_METHOD_NOT_ALLOWED');}
        const token=/^Bearer ([^\s]+)$/i.exec(request.headers.get('Authorization')||'')?.[1];
        if(!token||token.length>8192)throw new ApiError(401,'ERP_UNAUTHENTICATED');
        const user=await upstream(`${settings.baseUrl}/auth/v1/user`,{method:'GET',headers:{apikey:settings.key,Authorization:`Bearer ${token}`,Accept:'application/json'}},'auth');
        if(!user||typeof user.id!=='string'||!UUID.test(user.id))throw new ApiError(401,'ERP_UNAUTHENTICATED');
        if(user.is_anonymous===true)throw new ApiError(403,'ERP_FORBIDDEN');
        await accessGate(user,settings,token);
        const service={apikey:settings.key,Authorization:`Bearer ${settings.key}`,'Content-Type':'application/json',Accept:'application/json'};
        try{
          const parsed=await parseSecurityRoute(request);
          return respond(200,await executeSecurityRoute(parsed,{userId:user.id.toLowerCase(),sessionId:tokenSession(token).session_id,
            rpc:(name,args)=>upstream(`${settings.baseUrl}/rest/v1/rpc/${name}`,{method:'POST',headers:service,body:JSON.stringify(args)},'preferences'),
            authAdmin:(target,appMetadata)=>{if(!UUID.test(target))throw new ApiError(400,'ERP_INVALID_INPUT');return upstream(`${settings.baseUrl}/auth/v1/admin/users/${target}`,{method:'PUT',headers:service,body:JSON.stringify({app_metadata:appMetadata})},'authAdmin');},
            // A factor already gone (404) is the state the command wants.
            deleteFactor:async(target,factor)=>{if(!UUID.test(target)||!UUID.test(factor))throw new ApiError(400,'ERP_INVALID_INPUT');
              const response=await fetchImpl(`${settings.baseUrl}/auth/v1/admin/users/${target}/factors/${factor}`,{method:'DELETE',headers:{apikey:settings.key,Authorization:`Bearer ${settings.key}`,Accept:'application/json'},redirect:'manual'});
              void response.body?.cancel().catch(()=>{});if(!response.ok&&response.status!==404)throw new ApiError(503,'ERP_UPSTREAM_UNAVAILABLE');},
          }));
        }catch(error){if(error instanceof SecurityError)throw new ApiError(error.status,error.code);throw error;}
      }
      // Leva H, lane plataforma (330-334): /v1/plataforma, self-contained dispatch with the same origin, preflight and session checks.
      if(platformRoute(url.pathname)){
        const methods=platformMethods(url.pathname),origin=request.headers.get('Origin');
        if(origin!==null){if(!settings.origins.includes(origin))throw new ApiError(403,'ERP_ORIGIN_NOT_ALLOWED');headers.set('Access-Control-Allow-Origin',origin);}
        if(request.method==='OPTIONS'){
          const requested=request.headers.get('Access-Control-Request-Headers')||'';
          if(!origin||!methods.includes(request.headers.get('Access-Control-Request-Method'))||requested.split(',').map(item=>item.trim().toLowerCase()).filter(Boolean).some(item=>!['authorization','content-type'].includes(item)))throw new ApiError(403,'ERP_PREFLIGHT_DENIED');
          headers.set('Access-Control-Allow-Methods',methods.join(', '));headers.set('Access-Control-Allow-Headers','Authorization, Content-Type');return respond(204,null);
        }
        if(!methods.includes(request.method)){headers.set('Allow',[...methods,'OPTIONS'].join(', '));throw new ApiError(405,'ERP_METHOD_NOT_ALLOWED');}
        const token=/^Bearer ([^\s]+)$/i.exec(request.headers.get('Authorization')||'')?.[1];
        if(!token||token.length>8192)throw new ApiError(401,'ERP_UNAUTHENTICATED');
        const user=await upstream(`${settings.baseUrl}/auth/v1/user`,{method:'GET',headers:{apikey:settings.key,Authorization:`Bearer ${token}`,Accept:'application/json'}},'auth');
        if(!user||typeof user.id!=='string'||!UUID.test(user.id))throw new ApiError(401,'ERP_UNAUTHENTICATED');
        if(user.is_anonymous===true)throw new ApiError(403,'ERP_FORBIDDEN');
        await accessGate(user,settings,token);
        const service={apikey:settings.key,Authorization:`Bearer ${settings.key}`,'Content-Type':'application/json',Accept:'application/json'};
        const rpc=(name,args)=>upstream(`${settings.baseUrl}/rest/v1/rpc/${name}`,{method:'POST',headers:service,body:JSON.stringify(args)},'platform');
        const exportStorage=createExportStorage({baseUrl:settings.baseUrl,key:settings.key,fetchImpl});
        try{
          const parsed=await parsePlatformRoute(request);
          return respond(200,await executePlatformRoute(parsed,{userId:user.id.toLowerCase(),rpc,sign:exportStorage.sign,cep:cepLookup,
            // A new export starts right away in the background; the cron picks it up anyway if this run is cut short.
            kick:()=>{if(typeof ctx?.waitUntil==='function')ctx.waitUntil(runPlatformTasks({rpc:createServiceRpc({baseUrl:settings.baseUrl,key:settings.key,fetchImpl}),exportStorage,
              attachments:createAttachmentStorage({supabaseDeployment:env.SUPABASE_DEPLOYMENT,baseUrl:settings.baseUrl,key:settings.key,fetchImpl}),purposes:['company_export'],maxTasks:1}).catch(()=>{}));}}));
        }catch(error){if(error instanceof PlatformError)throw new ApiError(error.status,error.code);
          if(error instanceof ApiError&&typeof error.upstreamMessage==='string'){const m=error.upstreamMessage;delete error.upstreamMessage;
            const field=/erp_platform_export_in_progress/.test(m)?'export_in_progress':/erp_platform_export_unavailable/.test(m)?'export_unavailable':null;if(field)error.field=field;}
          throw error;}
      }
      // Leva H, lane espelho (350-352): Dados do Origin, categorias, exclusões e transportador, with the same origin, preflight and session checks.
      if(catalogMirrorRoute(url.pathname)){
        const methods=catalogMirrorMethods(url.pathname),origin=request.headers.get('Origin');
        if(origin!==null){if(!settings.origins.includes(origin))throw new ApiError(403,'ERP_ORIGIN_NOT_ALLOWED');headers.set('Access-Control-Allow-Origin',origin);}
        if(request.method==='OPTIONS'){
          const requested=request.headers.get('Access-Control-Request-Headers')||'';
          if(!origin||!methods.includes(request.headers.get('Access-Control-Request-Method'))||requested.split(',').map(item=>item.trim().toLowerCase()).filter(Boolean).some(item=>!['authorization','content-type'].includes(item)))throw new ApiError(403,'ERP_PREFLIGHT_DENIED');
          headers.set('Access-Control-Allow-Methods',methods.join(', '));headers.set('Access-Control-Allow-Headers','Authorization, Content-Type');return respond(204,null);
        }
        if(!methods.includes(request.method)){headers.set('Allow',[...methods,'OPTIONS'].join(', '));throw new ApiError(405,'ERP_METHOD_NOT_ALLOWED');}
        const token=/^Bearer ([^\s]+)$/i.exec(request.headers.get('Authorization')||'')?.[1];
        if(!token||token.length>8192)throw new ApiError(401,'ERP_UNAUTHENTICATED');
        const user=await upstream(`${settings.baseUrl}/auth/v1/user`,{method:'GET',headers:{apikey:settings.key,Authorization:`Bearer ${token}`,Accept:'application/json'}},'auth');
        if(!user||typeof user.id!=='string'||!UUID.test(user.id))throw new ApiError(401,'ERP_UNAUTHENTICATED');
        if(user.is_anonymous===true)throw new ApiError(403,'ERP_FORBIDDEN');
        await accessGate(user,settings,token);
        try{
          const parsed=await parseCatalogMirrorRoute(request);
          return respond(200,await executeCatalogMirrorRoute(parsed,{userId:user.id.toLowerCase(),rpc:(name,args)=>upstream(`${settings.baseUrl}/rest/v1/rpc/${name}`,{
            method:'POST',headers:{apikey:settings.key,Authorization:`Bearer ${settings.key}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(args),
          },'catalog')}));
        }catch(error){if(error instanceof CatalogMirrorError)throw new ApiError(error.status,error.code);if(error instanceof ApiError)delete error.upstreamMessage;throw error;}
      }
      // Frente de caixa (202610200204-206): self-contained dispatch with the same origin, preflight and session checks.
      const pos=posRoute(url.pathname);
      if(pos){
        const methods=posMethods(pos),origin=request.headers.get('Origin');
        if(origin!==null){if(!settings.origins.includes(origin))throw new ApiError(403,'ERP_ORIGIN_NOT_ALLOWED');headers.set('Access-Control-Allow-Origin',origin);}
        if(request.method==='OPTIONS'){
          const requested=request.headers.get('Access-Control-Request-Headers')||'';
          if(!origin||!methods.includes(request.headers.get('Access-Control-Request-Method'))||requested.split(',').map(item=>item.trim().toLowerCase()).filter(Boolean).some(item=>!['authorization','content-type'].includes(item)))throw new ApiError(403,'ERP_PREFLIGHT_DENIED');
          headers.set('Access-Control-Allow-Methods',methods.join(', '));headers.set('Access-Control-Allow-Headers','Authorization, Content-Type');return respond(204,null);
        }
        if(!methods.includes(request.method)){headers.set('Allow',[...methods,'OPTIONS'].join(', '));throw new ApiError(405,'ERP_METHOD_NOT_ALLOWED');}
        const token=/^Bearer ([^\s]+)$/i.exec(request.headers.get('Authorization')||'')?.[1];
        if(!token||token.length>8192)throw new ApiError(401,'ERP_UNAUTHENTICATED');
        const user=await upstream(`${settings.baseUrl}/auth/v1/user`,{method:'GET',headers:{apikey:settings.key,Authorization:`Bearer ${token}`,Accept:'application/json'}},'auth');
        if(!user||typeof user.id!=='string'||!UUID.test(user.id))throw new ApiError(401,'ERP_UNAUTHENTICATED');
        if(user.is_anonymous===true)throw new ApiError(403,'ERP_FORBIDDEN');
        // Leva H: the PDV goes through the same per-request gate (access windows and second factor) as every other route.
        await accessGate(user,settings,token);
        try{
          const parsed=await parsePosRoute(request,pos);
          return respond(200,await executePosRoute(parsed,{userId:user.id.toLowerCase(),rpc:(name,args)=>upstream(`${settings.baseUrl}/rest/v1/rpc/${name}`,{
            method:'POST',headers:{apikey:settings.key,Authorization:`Bearer ${settings.key}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(args),
          },'pos')}));
        }catch(error){if(error instanceof PosError)throw new ApiError(error.status,error.code);if(error instanceof ApiError&&typeof error.upstreamMessage==='string'){const reason=posRefusal(error.upstreamMessage);delete error.upstreamMessage;if(reason)error.field=reason;}throw error;}
      }
      const allowedMethods = preferences ? preferencesMethods(url.pathname) : backupImport ? backupImportMethods(url) : purchaseReceipts ? purchaseReceiptsMethods(url.pathname) : stockObservations ? stockObservationsMethods(url.pathname) : warehouseImport ? warehouseImportMethods(url.pathname) : stockOpening ? stockOpeningMethods(url.pathname) : itauLegacy ? itauLegacyReadinessMethods(url.pathname) : salesHistory ? salesHistoryMethods(url.pathname) : fiscalDraftStatus ? fiscalDraftStatusMethods(url.pathname) : salesReadiness ? salesReadinessMethods(url.pathname) : purchaseReadiness ? purchaseReadinessMethods(url.pathname) : stockReservations ? (stockReservationsMethods(url.pathname)||['GET']) : cnabOperationalV2 ? (cnabOperationalV2Methods(url.pathname) || ['GET']) : boletoPreview ? boletoPreviewMethods() : itauNetCredit ? itauNetCreditMethods(url.pathname) : originProposalImportV2 ? (originProposalImportV2Methods(url.pathname) || ['GET']) : originProposalImport ? (originProposalImportMethods(url.pathname) || ['GET']) : financeTransfers ? (financeTransfersMethods(url.pathname) || ['GET']) : serviceEvents ? (serviceEventsMethods(url.pathname) || ['GET']) : fiscalCompletion ? (fiscalCompletionMethods(url.pathname) || ['GET']) : fiscalNumbering ? (fiscalNumberingMethods(url.pathname) || ['GET']) : dfeDistribution ? (dfeDistributionMethods(url.pathname) || ['GET']) : cnabReturns ? cnabReturnsMethods(url.pathname) : cnabOperational ? cnabOperationalMethods(url.pathname) : fiscalTax ? fiscalTaxMethods(fiscalTaxRoute(url.pathname)) : financialImport ? financialImportMethods(url.pathname) : financialCutover ? ['GET'] : fiscalItem ? fiscalItemMethods(fiscalItemRoute(url.pathname)) : documentCopy ? documentCopyMethods(url.pathname) : integrationProgress ? integrationProgressMethods(url.pathname) : documentServiceConversion ? documentServiceConversionMethods(url.pathname) : fiscalReview ? fiscalReviewMethods() : serviceJournal ? serviceJournalMethods(url.pathname)||['GET'] : dueReport ? dueReportMethods(url.pathname)||['GET'] : syncedXml ? syncedXmlMethods(url.pathname)||['GET'] : cnabReview ? cnabReviewMethods(url.pathname) : stockPositions ? stockPositionsMethods(url.pathname)||['GET'] : fiscalDraft ? fiscalDraftMethods(fiscalDraftRoute(url.pathname)) : home ? homeMethods(url.pathname) : cutover ? ['GET'] : documentStock ? documentStockMethods(url.pathname) : documentFinance ? documentFinanceMethods(url.pathname) : company ? companyMethods(company) : cnab ? cnabMethods(url.pathname) : catalogImport ? catalogImportMethods(catalogImport) : attachments ? attachmentMethods(attachments) : finance ? financeMethods(url.pathname) : stock ? stockMethods(stock) : documents ? documentsMethods(documents) : catalogMethods(catalog);
      const origin = request.headers.get('Origin');
      if (origin !== null) {
        if (!settings.origins.includes(origin)) throw new ApiError(403, 'ERP_ORIGIN_NOT_ALLOWED');
        headers.set('Access-Control-Allow-Origin', origin);
      }
      if (request.method === 'OPTIONS') {
        const requested = request.headers.get('Access-Control-Request-Headers') || '';
        if (!origin || !allowedMethods.includes(request.headers.get('Access-Control-Request-Method'))
          || requested.split(',').map(item => item.trim().toLowerCase()).filter(Boolean).some(item => !(backupImport?['authorization','content-type','x-backup-manifest']:['authorization','content-type']).includes(item))) throw new ApiError(403, 'ERP_PREFLIGHT_DENIED');
        headers.set('Access-Control-Allow-Methods', allowedMethods.join(', '));
        headers.set('Access-Control-Allow-Headers', backupImport ? 'Authorization, Content-Type, X-Backup-Manifest' : 'Authorization, Content-Type');
        return respond(204, null);
      }
      if (!allowedMethods.includes(request.method)) { headers.set('Allow', [...allowedMethods, 'OPTIONS'].join(', ')); throw new ApiError(405, 'ERP_METHOD_NOT_ALLOWED'); }
      const match = /^\/v1\/records\/([a-z_]+)$/.exec(url.pathname);
      const isMe = url.pathname === '/v1/me';
      if (!preferences && !backupImport && !purchaseReceipts && !stockObservations && !warehouseImport && !stockOpening && !itauLegacy && !salesHistory && !fiscalDraftStatus && !salesReadiness && !purchaseReadiness && !stockReservations && !boletoPreview && !itauNetCredit && !originProposalImportV2 && !originProposalImport && !financeTransfers && !fiscalCompletion && !fiscalNumbering && !dfeDistribution && !cnabReturns && !cnabOperationalV2 && !cnabOperational && !fiscalTax && !financialImport && !financialCutover && !fiscalItem && !documentCopy && !integrationProgress && !documentServiceConversion && !serviceEvents && !serviceJournal && !dueReport && !syncedXml && !cnabReview && !stockPositions && !fiscalDraft && !home && !cutover && !documentStock && !documentFinance && !company && !cnab && !catalogImport && !catalog && !history && !documents && !finance && !stock && !attachments && !isMe && (!match || !ENTITIES.includes(match[1]))) throw new ApiError(404, 'ERP_NOT_FOUND');
      if (isMe && url.search) throw new ApiError(400, 'ERP_INVALID_QUERY');
      const operation = company ? await companyOperation(request, company, url.searchParams) : catalogImport ? await catalogImportOperation(request, catalogImport, url.searchParams) : stock ? await stockOperation(request, stock, url.searchParams) : documents ? await documentsOperation(request, documents, url.searchParams) : catalog ? await catalogOperation(request, catalog, url.searchParams) : null;
      const query = isMe || preferences || backupImport || purchaseReceipts || stockObservations || warehouseImport || stockOpening || itauLegacy || salesHistory || fiscalDraftStatus || salesReadiness || purchaseReadiness || stockReservations || boletoPreview || itauNetCredit || originProposalImportV2 || originProposalImport || financeTransfers || fiscalCompletion || fiscalNumbering || dfeDistribution || cnabReturns || cnabOperationalV2 || cnabOperational || fiscalTax || financialImport || financialCutover || fiscalItem || documentCopy || integrationProgress || documentServiceConversion || serviceEvents || serviceJournal || dueReport || syncedXml || cnabReview || stockPositions || fiscalDraft || home || cutover || documentStock || documentFinance || company || cnab || catalogImport || catalog || history || documents || finance || stock || attachments ? null : parseListQuery(url.searchParams);
      const backupPlan = backupImport ? await loadBackupImportPlan(env) : null;
      const authorization = request.headers.get('Authorization') || '';
      const token = /^Bearer ([^\s]+)$/i.exec(authorization)?.[1];
      if (!token || token.length > 8192) throw new ApiError(401, 'ERP_UNAUTHENTICATED');
      if((preferences||backupImport||purchaseReceipts||stockObservations||warehouseImport||stockOpening||itauLegacy||salesHistory||fiscalDraftStatus||salesReadiness||purchaseReadiness||stockReservations||cnabOperationalV2||boletoPreview||itauNetCredit||originProposalImportV2||originProposalImport||financeTransfers||fiscalCompletion||serviceEvents) && request.signal.aborted)throw new ApiError(400,'ERP_REQUEST_ABORTED');
      const user = await upstream(`${settings.baseUrl}/auth/v1/user`, {
        method: 'GET', headers: { apikey: settings.key, Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal:preferences||backupImport||purchaseReceipts||stockObservations||warehouseImport||stockOpening||itauLegacy||salesHistory||fiscalDraftStatus||salesReadiness||purchaseReadiness||stockReservations||cnabOperationalV2||boletoPreview||itauNetCredit||originProposalImportV2||originProposalImport||financeTransfers||fiscalCompletion||serviceEvents ? request.signal : undefined,
      }, 'auth',backupAuthDeadline??purchaseReceiptsDeadline??stockObservationsDeadline??warehouseDeadline??stockOpeningDeadline??itauLegacyDeadline??preferencesDeadline);
      if (!user || typeof user.id !== 'string' || !UUID.test(user.id)) throw new ApiError(401, 'ERP_UNAUTHENTICATED');
      if (user.is_anonymous === true) throw new ApiError(403, 'ERP_FORBIDDEN');
      await accessGate(user, settings, token);
      if (backupImport) {
        const result=await executeBackupImport(request,parseBackupImportRoute(url),backupPlan,{
          userId:user.id,
          authenticate:options=>upstream(`${settings.baseUrl}/auth/v1/user`,{
            method:'GET',headers:{apikey:settings.key,Authorization:`Bearer ${token}`,Accept:'application/json'},signal:options.signal,
          },'auth',options.deadline),
          rpc:(name,args,options)=>upstream(`${settings.baseUrl}/rest/v1/rpc/${name}`,{
            method:'POST',headers:{apikey:settings.key,Authorization:`Bearer ${settings.key}`,'Content-Type':'application/json',Accept:'application/json'},
            body:JSON.stringify(args),signal:options.signal,
          },'backupImport',options.deadline),
          storage:(method,key,body,type,options)=>{
            if(!['GET','POST'].includes(method)||!/^objects\/[a-f0-9]{64}\.(?:zip|xml|csv|bin)$/.test(key))throw new BackupImportError(400,'ERP_BACKUP_INVALID_INPUT');
            const path=`/storage/v1/object/${method==='GET'?'authenticated/':''}origin-backups/${key}`;
            return fetchImpl(`${settings.baseUrl}${path}`,{method,body,redirect:'manual',signal:options.signal,
              headers:{apikey:settings.key,Authorization:`Bearer ${settings.key}`,'Content-Type':type,Accept:'application/octet-stream','x-upsert':'false'}});
          },
        });
        if(result.type==='json')return respond(200,result.body);
        headers.set('Content-Type','text/event-stream; charset=utf-8');
        headers.set('X-Accel-Buffering','no');
        return new Response(result.body,{status:200,headers});
      }
      if(purchaseReceipts){
        const route=await parsePurchaseReceiptsRoute(request);
        return respond(200,await executePurchaseReceiptsRoute(route,{userId:user.id.toLowerCase(),signal:request.signal,
          rpc:(name,args,options)=>upstream(`${settings.baseUrl}/rest/v1/rpc/${name}`,{
            method:'POST',headers:{apikey:settings.key,Authorization:`Bearer ${settings.key}`,'Content-Type':'application/json',Accept:'application/json'},
            body:JSON.stringify(args),signal:options.signal,
          },'purchaseReceipts',Math.min(options.deadline,purchaseReceiptsDeadline))}));
      }
      if(stockObservations){
        const route=parseStockObservationsRoute(request),remaining=stockObservationsDeadline-Date.now();
        if(remaining<=0)throw new ApiError(408,'ERP_REQUEST_TIMEOUT');
        return respond(200,await executeStockObservationsRoute(route,{userId:user.id,signal:request.signal,timeoutMs:Math.min(15000,remaining),
          rpc:(name,args,options)=>upstream(`${settings.baseUrl}/rest/v1/rpc/${name}`,{
            method:'POST',headers:{apikey:settings.key,Authorization:`Bearer ${settings.key}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(args),signal:options.signal,
          },'stockObservations',Math.min(stockObservationsDeadline,options.deadline)),
        }));
      }
      if(warehouseImport){
        const route=await parseWarehouseImportRoute(request),remaining=warehouseDeadline-Date.now();
        if(remaining<=0)throw new ApiError(408,'ERP_REQUEST_TIMEOUT');
        return respond(200,await executeWarehouseImportRoute(route,{userId:user.id,signal:request.signal,timeoutMs:Math.min(15000,remaining),
          rpc:(name,args,options)=>upstream(`${settings.baseUrl}/rest/v1/rpc/${name}`,{
            method:'POST',headers:{apikey:settings.key,Authorization:`Bearer ${settings.key}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(args),signal:options.signal,
          },'warehouseImport',Math.min(warehouseDeadline,options.deadline)),
        }));
      }
      if(preferences){
        const route=await parsePreferencesRoute(request),remaining=preferencesDeadline-Date.now();
        if(remaining<=0)throw new ApiError(408,'ERP_REQUEST_TIMEOUT');
        return respond(200,await executePreferencesRoute(route,{userId:user.id.toLowerCase(),signal:request.signal,timeoutMs:Math.min(20000,remaining),
          rpc:(name,args,options)=>upstream(`${settings.baseUrl}/rest/v1/rpc/${name}`,{
            method:'POST',headers:{apikey:settings.key,Authorization:`Bearer ${settings.key}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(args),signal:options.signal,
          },'preferences',Math.min(preferencesDeadline,options.deadline)),
          // Sistema > Usuários: the Supabase Auth admin invite (service key stays in the Worker), called only by the recorded invite command.
          authInvite:(email,options)=>upstream(`${settings.baseUrl}/auth/v1/invite`,{
            method:'POST',headers:{apikey:settings.key,Authorization:`Bearer ${settings.key}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({email}),signal:options.signal,
          },'authInvite',Math.min(preferencesDeadline,options.deadline)),
          // Sistema › Usuários › controles (229): the access-window flag of the user, merged into the Auth app_metadata.
          authAdmin:(target,appMetadata,options)=>{if(!UUID.test(target))throw new ApiError(400,'ERP_INVALID_INPUT');return upstream(`${settings.baseUrl}/auth/v1/admin/users/${target}`,{
            method:'PUT',headers:{apikey:settings.key,Authorization:`Bearer ${settings.key}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({app_metadata:appMetadata}),signal:options.signal,
          },'authAdmin',Math.min(preferencesDeadline,options.deadline));},
        }));
      }
      if(stockOpening){
        const route=await parseStockOpeningRoute(request),remaining=stockOpeningDeadline-Date.now();
        if(remaining<=0)throw new ApiError(408,'ERP_REQUEST_TIMEOUT');
        return respond(200,await executeStockOpeningRoute(route,{userId:user.id.toLowerCase(),signal:request.signal,timeoutMs:Math.min(20000,remaining),
          rpc:(name,args,options)=>upstream(`${settings.baseUrl}/rest/v1/rpc/${name}`,{
            method:'POST',headers:{apikey:settings.key,Authorization:`Bearer ${settings.key}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(args),signal:options.signal,
          },'stockOpening',Math.min(stockOpeningDeadline,options.deadline)),
        }));
      }
      if (itauLegacy) {
        const route=parseItauLegacyReadinessRoute(request),remaining=itauLegacyDeadline-Date.now();
        if(remaining<=0)throw new ApiError(408,'ERP_REQUEST_TIMEOUT');
        return respond(200,await executeItauLegacyReadinessRoute(route,{userId:user.id,signal:request.signal,timeoutMs:remaining,
          rpc:(name,args,options)=>upstream(`${settings.baseUrl}/rest/v1/rpc/${name}`,{
            method:'POST',headers:{apikey:settings.key,Authorization:`Bearer ${settings.key}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(args),signal:options.signal,
          },'itauLegacy',itauLegacyDeadline),
        }));
      }
      if (salesHistory) {
        const route = parseSalesHistoryRoute(request);
        // This public composition exposes list/detail only; receipt lookup remains administrative RPC.
        if (route.action === 'command') throw new ApiError(404, 'ERP_NOT_FOUND');
        return respond(200, await executeSalesHistoryRoute(route, {userId:user.id,signal:request.signal,
          rpc:(name,args,options)=>upstream(`${settings.baseUrl}/rest/v1/rpc/${name}`, {
            method:'POST',headers:{apikey:settings.key,Authorization:`Bearer ${settings.key}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(args),signal:options.signal,
          },'salesHistory'),
        }));
      }
      if (fiscalDraftStatus) {
        const route = parseFiscalDraftStatusRoute(request);
        return respond(200, await executeFiscalDraftStatusRoute(route, {userId:user.id,signal:request.signal,
          rpc:(name,args,options)=>upstream(`${settings.baseUrl}/rest/v1/rpc/${name}`, {
            method:'POST',headers:{apikey:settings.key,Authorization:`Bearer ${settings.key}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(args),signal:options.signal,
          },'fiscalDraftStatus'),
        }));
      }
      if (salesReadiness) {
        const route = parseSalesReadinessRoute(request);
        return respond(200, await executeSalesReadinessRoute(route, {userId:user.id,signal:request.signal,
          rpc:(name,args,options)=>upstream(`${settings.baseUrl}/rest/v1/rpc/${name}`, {
            method:'POST',headers:{apikey:settings.key,Authorization:`Bearer ${settings.key}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(args),signal:options.signal,
          },'salesReadiness'),
        }));
      }
      if (purchaseReadiness) {
        const route = parsePurchaseReadinessRoute(request);
        return respond(200, await executePurchaseReadinessRoute(route, {userId:user.id,signal:request.signal,
          rpc:(name,args,options)=>upstream(`${settings.baseUrl}/rest/v1/rpc/${name}`, {
            method:'POST',headers:{apikey:settings.key,Authorization:`Bearer ${settings.key}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(args),signal:options.signal,
          },'purchaseReadiness'),
        }));
      }
      if (originProposalImportV2) {
        const route = await parseOriginProposalImportV2Route(request);
        return respond(200, await executeOriginProposalImportV2Route(route, {userId:user.id,signal:request.signal,
          rpc:(name,args,options)=>upstream(`${settings.baseUrl}/rest/v1/rpc/${name}`, {
            method:'POST',headers:{apikey:settings.key,Authorization:`Bearer ${settings.key}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(args),signal:options.signal,
          },'originProposalImportV2'),
        }));
      }
      if (originProposalImport) {
        const route = await parseOriginProposalImportRoute(request);
        return respond(200, await executeOriginProposalImportRoute(route, {userId:user.id,signal:request.signal,
          rpc:(name,args,options)=>upstream(`${settings.baseUrl}/rest/v1/rpc/${name}`, {
            method:'POST',headers:{apikey:settings.key,Authorization:`Bearer ${settings.key}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(args),signal:options.signal,
          },'originProposalImport'),
        }));
      }
      if (financeTransfers) {
        const route = await parseFinanceTransfersRoute(request);
        return respond(200, await executeFinanceTransfersRoute(route, {userId:user.id, signal:request.signal,
          rpc:(name,args,options)=>upstream(`${settings.baseUrl}/rest/v1/rpc/${name}`, {
            method:'POST',headers:{apikey:settings.key,Authorization:`Bearer ${settings.key}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(args),signal:options.signal,
          },'financeTransfers'),
        }));
      }
      if (fiscalCompletion) {
        const route=await parseFiscalCompletionRoute(request);
        const result=await executeFiscalCompletionRoute(route,{userId:user.id,signal:request.signal,rpc:(name,args,options)=>upstream(`${settings.baseUrl}/rest/v1/rpc/${name}`,{
          method:'POST',headers:{apikey:settings.key,Authorization:`Bearer ${settings.key}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(args),signal:options.signal,
        },'fiscalCompletion')});
        return respond(200,result.body);
      }
      if (fiscalNumbering) {
        const route=await parseFiscalNumberingRoute(request);
        const result=await executeFiscalNumberingRoute(route,{userId:user.id,rpc:(name,args,options)=>upstream(`${settings.baseUrl}/rest/v1/rpc/${name}`,{
          method:'POST',headers:{apikey:settings.key,Authorization:`Bearer ${settings.key}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(args),signal:options.signal,
        },'fiscalNumbering')});
        return respond(200,result.body);
      }
      if (dfeDistribution) {
        const route = await parseDfeDistributionRoute(request);
        const result = await executeDfeDistributionRoute(route, {userId:user.id,
          rpc:(name,args)=>upstream(`${settings.baseUrl}/rest/v1/rpc/${name}`, {
            method:'POST',headers:{apikey:settings.key,Authorization:`Bearer ${settings.key}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(args),
          },'dfeDistribution'),
          fetchObject:(path,options)=>{
            if(!/^\/storage\/v1\/object\/authenticated\/brufap-received-dfe\/objects\/[a-f0-9]{64}\.xml$/.test(path))throw new ApiError(502,'ERP_UPSTREAM_INVALID_RESPONSE');
            return fetchImpl(`${settings.baseUrl}${path}`,{method:'GET',redirect:'manual',signal:options.signal,headers:{apikey:settings.key,Authorization:`Bearer ${settings.key}`,Accept:'application/octet-stream'}});
          },
        });
        if(result.type==='json')return respond(200,result.body);
        for(const [name,value] of Object.entries(result.headers))headers.set(name,value);
        return new Response(result.bytes,{status:200,headers});
      }
      if(financialImport){
        const route=await parseFinancialImportRoute(request);
        return respond(200,await executeFinancialImportRoute(route,{userId:user.id,rpc:(name,args)=>upstream(`${settings.baseUrl}/rest/v1/rpc/${name}`,{
          method:'POST',headers:{apikey:settings.key,Authorization:`Bearer ${settings.key}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(args),
        },'financialImport')}));
      }
      if(financialCutover){
        const route=parseFinancialCutoverRoute(request);
        return respond(200,await executeFinancialCutoverRoute(route,{userId:user.id,rpc:(name,args)=>upstream(`${settings.baseUrl}/rest/v1/rpc/${name}`,{
          method:'POST',headers:{apikey:settings.key,Authorization:`Bearer ${settings.key}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(args),
        },'financialCutover')}));
      }
      if(fiscalTax){
        const route=await parseFiscalTaxRoute(request);
        return respond(200,await executeFiscalTaxRoute(route,{userId:user.id,rpc:(name,args)=>upstream(`${settings.baseUrl}/rest/v1/rpc/${name}`,{
          method:'POST',headers:{apikey:settings.key,Authorization:`Bearer ${settings.key}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(args),
        },'fiscalTax')}));
      }
      if(fiscalItem){
        const route=await parseFiscalItemRoute(request);
        return respond(200,await executeFiscalItemRoute(route,{userId:user.id,rpc:(name,args)=>upstream(`${settings.baseUrl}/rest/v1/rpc/${name}`,{
          method:'POST',headers:{apikey:settings.key,Authorization:`Bearer ${settings.key}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(args),
        },'fiscalItem')}));
      }
      if(documentCopy){
        const route=await parseDocumentCopyRoute(request);
        return respond(200,await executeDocumentCopyRoute(route,{userId:user.id,rpc:(name,args)=>upstream(`${settings.baseUrl}/rest/v1/rpc/${name}`,{
          method:'POST',headers:{apikey:settings.key,Authorization:`Bearer ${settings.key}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(args),
        },'documentCopy')}));
      }
      if(integrationProgress){
        const route=parseIntegrationProgressRoute(request);
        return respond(200,await executeIntegrationProgressRoute(route,{userId:user.id,rpc:(name,args)=>upstream(`${settings.baseUrl}/rest/v1/rpc/${name}`,{
          method:'POST',headers:{apikey:settings.key,Authorization:`Bearer ${settings.key}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(args),
        },'integrationProgress')}));
      }
      if(documentServiceConversion){
        const route=await parseDocumentServiceConversionRoute(request);
        return respond(200,await executeDocumentServiceConversionRoute(route,{userId:user.id,rpc:(name,args)=>upstream(`${settings.baseUrl}/rest/v1/rpc/${name}`,{
          method:'POST',headers:{apikey:settings.key,Authorization:`Bearer ${settings.key}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(args),
        },'documentServiceConversion')}));
      }
      if(serviceEvents){
        const route=await parseServiceEventsRoute(request);
        return respond(200,await executeServiceEventsRoute(route,{userId:user.id,signal:request.signal,rpc:(name,args,options)=>upstream(`${settings.baseUrl}/rest/v1/rpc/${name}`,{
          method:'POST',headers:{apikey:settings.key,Authorization:`Bearer ${settings.key}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(args),signal:options.signal,
        },'serviceEvents')}));
      }
      if(serviceJournal){
        const route=await parseServiceJournalRoute(request);
        return respond(200,await executeServiceJournalRoute(route,{userId:user.id,rpc:(name,args)=>upstream(`${settings.baseUrl}/rest/v1/rpc/${name}`,{
          method:'POST',headers:{apikey:settings.key,Authorization:`Bearer ${settings.key}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(args),
        },'serviceJournal')}));
      }
      if(dueReport){
        const route=parseDueReportRoute(request);
        return respond(200,await executeDueReportRoute(route,{userId:user.id,rpc:(name,args)=>upstream(`${settings.baseUrl}/rest/v1/rpc/${name}`,{
          method:'POST',headers:{apikey:settings.key,Authorization:`Bearer ${settings.key}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(args),
        },'dueReport')}));
      }
      if(syncedXml){
        const route=parseSyncedXmlRoute(request),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
        try{
          const result=await executeSyncedXmlRoute(route,{userId:user.id,rpc:(name,args)=>upstream(`${settings.baseUrl}/rest/v1/rpc/${name}`,{
            method:'POST',headers:{apikey:settings.key,Authorization:`Bearer ${settings.key}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(args),
          },'syncedXml'),fetchObject:path=>{
            if(!/^\/storage\/v1\/object\/authenticated\/origin-fiscal-xml\/objects\/[a-f0-9]{64}\.xml$/.test(path))throw new ApiError(502,'ERP_UPSTREAM_INVALID_RESPONSE');
            return fetchImpl(`${settings.baseUrl}${path}`,{method:'GET',redirect:'manual',signal:controller.signal,headers:{apikey:settings.key,Authorization:`Bearer ${settings.key}`,Accept:'application/octet-stream'}});
          }});
          if(result.type==='json')return respond(200,result.body);
          if(!/^origin-(55|65)-[a-f0-9]{12}\.xml$/.test(result.filename))throw new ApiError(502,'ERP_UPSTREAM_INVALID_RESPONSE');
          for(const [name,value] of Object.entries(result.headers))headers.set(name,value);
          return new Response(result.bytes,{status:200,headers});
        }finally{clearTimeout(timer);controller.abort();}
      }
      if(cnabReview){
        const route=await parseCnabReviewRoute(request);
        return respond(200,await executeCnabReviewRoute(route,{userId:user.id,rpc:(name,args)=>upstream(`${settings.baseUrl}/rest/v1/rpc/${name}`,{
          method:'POST',headers:{apikey:settings.key,Authorization:`Bearer ${settings.key}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(args),
        },'cnabReview'),getFile:createCnabStorage({supabaseDeployment:env.SUPABASE_DEPLOYMENT,baseUrl:settings.baseUrl,key:settings.key,fetchImpl}).getFile}));
      }
      if(stockReservations){
        const route=await parseStockReservationsRoute(request);
        return respond(200,await executeStockReservationsRoute(route,{userId:user.id.toLowerCase(),signal:request.signal,rpc:(name,args,{signal})=>upstream(`${settings.baseUrl}/rest/v1/rpc/${name}`,{
          method:'POST',signal,headers:{apikey:settings.key,Authorization:`Bearer ${settings.key}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(args),
        },'stockReservations')}));
      }
      if(stockPositions){
        const route=parseStockPositionsRoute(request);
        return respond(200,await executeStockPositionsRoute(route,{userId:user.id,rpc:(name,args)=>upstream(`${settings.baseUrl}/rest/v1/rpc/${name}`,{
          method:'POST',headers:{apikey:settings.key,Authorization:`Bearer ${settings.key}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(args),
        },'stockPositions')}));
      }
      if(fiscalReview){
        const route=parseFiscalReviewRoute(request);
        return respond(200,await executeFiscalReviewRoute(route,{userId:user.id,rpc:(name,args)=>upstream(`${settings.baseUrl}/rest/v1/rpc/${name}`,{
          method:'POST',headers:{apikey:settings.key,Authorization:`Bearer ${settings.key}`,'Content-Type':'application/json'},body:JSON.stringify(args),
        },'fiscalReview')}));
      }
      if(fiscalDraft){
        const route=await parseFiscalDraftRoute(request);
        return respond(200,await executeFiscalDraftRoute(route,{userId:user.id,rpc:(name,args)=>upstream(`${settings.baseUrl}/rest/v1/rpc/${name}`,{
          method:'POST',headers:{apikey:settings.key,Authorization:`Bearer ${settings.key}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(args),
        },'fiscalDraft')}));
      }
      if(home){
        const shortcuts=url.pathname==='/v1/inicio/atalhos';
        const operation=shortcuts?await homeShortcutsOperation(request,url.searchParams):homeOperation(request,url.searchParams);
        const result=await upstream(`${settings.baseUrl}/rest/v1/rpc/${operation.rpc}`,{
          method:'POST',headers:{apikey:settings.key,Authorization:`Bearer ${settings.key}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({...operation.args,p_user_id:user.id}),
        },'home');
        return respond(200,shortcuts?homeShortcutsResponse(result,operation):homeResponse(result,operation));
      }
      if(cutover){
        const route=parseCutoverRoute(request);
        return respond(200,await executeCutoverRoute(route,{userId:user.id,rpc:(name,args)=>upstream(`${settings.baseUrl}/rest/v1/rpc/${name}`,{
          method:'POST',headers:{apikey:settings.key,Authorization:`Bearer ${settings.key}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(args),
        },'cutover')}));
      }
      if (documentStock) {
        const route = await parseDocumentStockRoute(request);
        return respond(200, await executeDocumentStockRoute(route, { userId: user.id,
          rpc: (name, args) => upstream(`${settings.baseUrl}/rest/v1/rpc/${name}`, {
            method: 'POST', headers: { apikey: settings.key, Authorization: `Bearer ${settings.key}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(args),
          }, 'documentStock'),
        }));
      }
      if (documentFinance) {
        const route = await parseDocumentFinanceRoute(request);
        return respond(200, await executeDocumentFinanceRoute(route, { userId: user.id,
          rpc: (name, args) => upstream(`${settings.baseUrl}/rest/v1/rpc/${name}`, {
            method: 'POST', headers: { apikey: settings.key, Authorization: `Bearer ${settings.key}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(args),
          }, 'documentFinance'),
        }));
      }
      if (boletoPreview) {
        const route = parseBoletoPreviewRoute(request);
        const storage = createCnabStorage({supabaseDeployment:env.SUPABASE_DEPLOYMENT,baseUrl:settings.baseUrl,key:settings.key,fetchImpl});
        const result = await executeBoletoPreviewRoute(route, {userId:user.id,signal:request.signal,
          rpc:async(name,args,options)=>{
            try{return await upstream(`${settings.baseUrl}/rest/v1/rpc/${name}`,{
              method:'POST',headers:{apikey:settings.key,Authorization:`Bearer ${settings.key}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(args),signal:options.signal,
            },'boletoPreview');}catch(error){if(error instanceof ApiError)throw new BoletoPreviewRouteError(error.status,error.code);throw error;}
          },
          getFile:(key,options)=>storage.getFile({...key,signal:options.signal}),
        });
        return respond(200,result.body);
      }
      if (itauNetCredit) {
        const route = await parseItauNetCreditRoute(request);
        const result = await executeItauNetCreditRoute(route, {userId:user.id,
          rpc:(name,args,options)=>upstream(`${settings.baseUrl}/rest/v1/rpc/${name}`, {
            method:'POST',headers:{apikey:settings.key,Authorization:`Bearer ${settings.key}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(args),signal:options.signal,
          },'itauNetCredit'),...createCnabStorage({supabaseDeployment:env.SUPABASE_DEPLOYMENT,baseUrl:settings.baseUrl,key:settings.key,fetchImpl}),
        });
        return respond(200,result.body);
      }
      if (cnabReturns) {
        const route = await parseCnabReturnsRoute(request);
        const result = await executeCnabReturnsRoute(route, {userId:user.id,
          rpc:(name,args)=>upstream(`${settings.baseUrl}/rest/v1/rpc/${name}`, {
            method:'POST',headers:{apikey:settings.key,Authorization:`Bearer ${settings.key}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(args),
          },'cnabReturns'),...createCnabStorage({supabaseDeployment:env.SUPABASE_DEPLOYMENT,baseUrl:settings.baseUrl,key:settings.key,fetchImpl}),
        });
        if(result.type==='json')return respond(200,result.body);
        headers.set('Content-Type','application/octet-stream');headers.set('Content-Length',String(result.bytes.length));
        headers.set('Content-Disposition',`attachment; filename="${result.filename}"`);
        headers.set('Content-Security-Policy',"sandbox; default-src 'none'; frame-ancestors 'none'");
        return new Response(result.bytes,{status:200,headers});
      }
      if (cnabOperationalV2) {
        const route = await parseCnabOperationalV2Route(request);
        const result = await executeCnabOperationalV2Route(route, {userId:user.id,signal:request.signal,
          rpc:(name,args,options)=>upstream(`${settings.baseUrl}/rest/v1/rpc/${name}`, {
            method:'POST',headers:{apikey:settings.key,Authorization:`Bearer ${settings.key}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(args),signal:options.signal,
          },'cnabOperationalV2'),...createCnabStorage({supabaseDeployment:env.SUPABASE_DEPLOYMENT,baseUrl:settings.baseUrl,key:settings.key,fetchImpl}),
        });
        if(result.type==='json')return respond(200,result.body);
        headers.set('Content-Type','application/octet-stream');headers.set('Content-Length',String(result.bytes.length));
        headers.set('Content-Disposition',`attachment; filename="${result.filename}"`);
        headers.set('Content-Security-Policy',"sandbox; default-src 'none'; frame-ancestors 'none'");
        return new Response(result.bytes,{status:200,headers});
      }
      if (cnabOperational) {
        const route = await parseCnabOperationalRoute(request);
        const result = await executeCnabOperationalRoute(route, {userId:user.id,
          rpc:(name,args)=>upstream(`${settings.baseUrl}/rest/v1/rpc/${name}`, {
            method:'POST',headers:{apikey:settings.key,Authorization:`Bearer ${settings.key}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(args),
          },'cnabOperational'),...createCnabStorage({supabaseDeployment:env.SUPABASE_DEPLOYMENT,baseUrl:settings.baseUrl,key:settings.key,fetchImpl}),
        });
        if(result.type==='json')return respond(200,result.body);
        headers.set('Content-Type','application/octet-stream');headers.set('Content-Length',String(result.bytes.length));
        headers.set('Content-Disposition',`attachment; filename="${result.filename}"`);
        headers.set('Content-Security-Policy',"sandbox; default-src 'none'; frame-ancestors 'none'");
        return new Response(result.bytes,{status:200,headers});
      }
      if (cnab) {
        const route = await parseCnabRoute(request);
        const result = await executeCnabRoute(route, { userId: user.id,
          rpc: (name, args) => upstream(`${settings.baseUrl}/rest/v1/rpc/${name}`, {
            method: 'POST', headers: { apikey: settings.key, Authorization: `Bearer ${settings.key}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(args),
          }, 'cnab'), ...createCnabStorage({ supabaseDeployment:env.SUPABASE_DEPLOYMENT,baseUrl: settings.baseUrl, key: settings.key, fetchImpl }),
        });
        if (result.type === 'json') return respond(200, result.body);
        headers.set('Content-Type', 'application/octet-stream'); headers.set('Content-Length', String(result.bytes.length));
        headers.set('Content-Disposition', `attachment; filename="${result.filename}"`);
        headers.set('Content-Security-Policy', "sandbox; default-src 'none'; frame-ancestors 'none'");
        return new Response(result.bytes, { status: 200, headers });
      }
      if (attachments) {
        const result = await executeAttachmentRoute(request, attachments, {
          userId: user.id,
          rpc: (name, args) => upstream(`${settings.baseUrl}/rest/v1/rpc/${name}`, {
            method: 'POST', headers: { apikey: settings.key, Authorization: `Bearer ${settings.key}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(args),
          }, 'attachments'),
          storage: createAttachmentStorage({ supabaseDeployment:env.SUPABASE_DEPLOYMENT,baseUrl: settings.baseUrl, key: settings.key, fetchImpl }),
        });
        if (result.type === 'json') return respond(200, result.body);
        for (const [name, value] of Object.entries(result.headers)) headers.set(name, value);
        return new Response(result.bytes, { status: 200, headers });
      }
      if (finance) {
        const route = await parseFinanceRoute(request);
        return respond(200, await executeFinanceRoute(route, {
          userId: user.id,
          rpc: (name, args) => upstream(`${settings.baseUrl}/rest/v1/rpc/${name}`, {
            method: 'POST', headers: { apikey: settings.key, Authorization: `Bearer ${settings.key}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(args),
          }, 'finance'),
        }));
      }
      if (history) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 20000);
        try {
          const result = await executeHistoryRoute(history, {
            userId: user.id,
            rpc: (name, args) => upstream(`${settings.baseUrl}/rest/v1/rpc/${name}`, {
              method: 'POST', headers: { apikey: settings.key, Authorization: `Bearer ${settings.key}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(args),
            }, 'history'),
            fetchObject: path => {
              if (!/^\/storage\/v1\/object\/authenticated\/origin-backups\/objects\/[a-f0-9]{64}\.xml$/.test(path)) throw new ApiError(502, 'ERP_UPSTREAM_INVALID_RESPONSE');
              return fetchImpl(`${settings.baseUrl}${path}`, { method: 'GET', redirect: 'manual', signal: controller.signal,
                headers: { apikey: settings.key, Authorization: `Bearer ${settings.key}`, Accept: 'application/octet-stream' } });
            },
          });
          if (result.type === 'json') return respond(200, result.body);
          if (!/^origin-(55|65|xml)-[a-f0-9]{12}\.xml$/.test(result.filename)) throw new ApiError(502, 'ERP_UPSTREAM_INVALID_RESPONSE');
          headers.set('Content-Type', 'application/octet-stream');
          headers.set('Content-Disposition', `attachment; filename="${result.filename}"`);
          headers.set('Content-Security-Policy', "sandbox; default-src 'none'; frame-ancestors 'none'");
          return new Response(result.bytes, { status: 200, headers });
        } catch (error) {
          if (error instanceof ApiError || error instanceof HistoryError) throw error;
          throw new ApiError(503, 'ERP_UPSTREAM_UNAVAILABLE');
        } finally { clearTimeout(timeout); }
      }
      // 202610200167: an operation may read its body only now, after the session check (Importar › Pedido XML).
      if (typeof operation?.prepare === 'function') await operation.prepare();
      const rpc = operation ? operation.rpc : isMe ? 'erp_access_me' : 'erp_read_records';
      const args = operation ? { ...operation.args, p_user_id: user.id } : isMe ? { p_user_id: user.id } : { p_user_id: user.id, p_entity: match[1], ...query };
      const result = await upstream(`${settings.baseUrl}/rest/v1/rpc/${rpc}`, {
        method: 'POST', headers: { apikey: settings.key, Authorization: `Bearer ${settings.key}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(args),
      }, company ? 'company' : catalogImport ? 'catalogImport' : stock ? 'stock' : documents ? 'documents' : operation ? 'catalog' : 'rpc').catch(error => { throw catalog && operation ? catalogFailure(error, operation) : documents ? documentsFailure(error) : error; });
      if (company) return respond(200, companyResponse(result, company, operation));
      if (catalogImport) return respond(200, catalogImportResponse(result, catalogImport, operation));
      if (stock) return respond(200, stockResponse(result, stock, operation));
      if (documents) return respond(200, documentsResponse(result, documents, operation));
      // Contatos (documentos lane, wave E, 241): the seller save sets the Auth access-gate flag of the users linked before and now;
      // a flag not written is "unconfirmed" (the same command replays the receipt and writes the flags again).
      if (operation?.rpc === 'erp_catalog_seller_save') {
        const body = catalogResponse(result, catalog, operation);
        let gates; try { gates = sellerAccessGates(result); } catch { throw new ApiError(502, 'ERP_UPSTREAM_INVALID_RESPONSE'); }
        for (const gate of gates) {
          try { await upstream(`${settings.baseUrl}/auth/v1/admin/users/${gate.user_id}`, { method: 'PUT', headers: { apikey: settings.key, Authorization: `Bearer ${settings.key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ app_metadata: { brufap_access_gate: gate.gate_required } }) }, 'authAdmin'); } catch { throw new ApiError(503, 'ERP_RESULT_UNCONFIRMED'); }
        }
        return respond(200, body);
      }
      // 202610220008: product page and export carry the Origin observed balance beside the native one, read in one batch.
      if (operation?.originStock) {
        const body = catalogResponse(result, catalog, operation), warehouse = operation.type === 'export' ? body.stock_warehouse?.id ?? null : operation.args.p_warehouse_id ?? null;
        try {
          return respond(200, await withProductStockMirror(body, warehouse, args => upstream(`${settings.baseUrl}/rest/v1/rpc/erp_stock_mirror_product_summary`, {
            method: 'POST', headers: { apikey: settings.key, Authorization: `Bearer ${settings.key}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ ...args, p_user_id: user.id }),
          }, 'stock')));
        } catch (error) { if (error instanceof ProductStockMirrorError) throw new ApiError(502, 'ERP_UPSTREAM_INVALID_RESPONSE'); throw error; }
      }
      if (operation) return respond(200, catalogResponse(result, catalog, operation));
      if (isMe) {
        if (!result || result.user_id !== user.id || !ROLES.includes(result.role) || result.data_mode !== 'staging_readonly'
          || !Array.isArray(result.resources) || result.resources.some(entity => !ENTITIES.includes(entity))
          || (result.access_window !== undefined && !['open', 'closed'].includes(result.access_window))) throw new ApiError(502, 'ERP_UPSTREAM_INVALID_RESPONSE');
        // 229: outside the access windows (Sistema › Usuários or Cadastros › Vendedores) the session is refused with its own code.
        if (result.access_window === 'closed') throw new ApiError(403, 'ERP_ACCESS_OUTSIDE_SCHEDULE');
        // Leva H (310): a member the gate must see (MFA policy on) but whose Auth flag is missing (invited later, a lost write)
        // gets the flag now, and this first request is checked by the gate right away.
        if (result.gate_required !== undefined && typeof result.gate_required !== 'boolean') throw new ApiError(502, 'ERP_UPSTREAM_INVALID_RESPONSE');
        if (result.gate_required === true && user.app_metadata?.brufap_access_gate !== true) {
          try { await upstream(`${settings.baseUrl}/auth/v1/admin/users/${user.id}`, { method: 'PUT', headers: { apikey: settings.key, Authorization: `Bearer ${settings.key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ app_metadata: { brufap_access_gate: true } }) }, 'authAdmin'); } catch { /* The gate below still decides this request; the next /me writes the flag again. */ }
          await accessGate(user, settings, token, true);
        }
        return respond(200, { user_id: user.id, role: result.role, resources: result.resources, data_mode: 'staging_readonly',
          capabilities: { originIntegration: env.ORIGIN_ENABLED === 'true' && env.ORIGIN_TWO_WAY_ENABLED === 'true',
            originConnection: env.ORIGIN_ENABLED === 'true' && env.ORIGIN_CONNECTOR_ENABLED === 'true',
            originHistory: env.ORIGIN_ENABLED === 'true' || env.ORIGIN_HISTORY_ENABLED === 'true' } });
      }
      return respond(200, safeList(result, match[1], query));
    } catch (error) {
      const known = error instanceof PreferencesError || error instanceof BackupImportError || error instanceof PurchaseReceiptsError || error instanceof StockObservationsError || error instanceof WarehouseImportError || error instanceof StockOpeningError || error instanceof ItauLegacyReadinessError || error instanceof SalesHistoryError || error instanceof FiscalDraftStatusError || error instanceof SalesReadinessError || error instanceof PurchaseReadinessError || error instanceof StockReservationsError || error instanceof CnabOperationalV2Error || error instanceof BoletoPreviewRouteError || error instanceof ItauNetCreditError || error instanceof OriginProposalImportV2Error || error instanceof OriginProposalImportError || error instanceof FinanceTransfersError || error instanceof ServiceEventsError || error instanceof FiscalCompletionError || error instanceof FiscalNumberingError || error instanceof DfeDistributionError || error instanceof ApiError || error instanceof CatalogError || error instanceof HistoryError || error instanceof DocumentsError || error instanceof FinanceError || error instanceof StockError || error instanceof AttachmentError || error instanceof CatalogImportError || error instanceof CnabApiError || error instanceof CnabOperationalError || error instanceof CnabReturnsError || error instanceof CompanyError || error instanceof DocumentFinanceError || error instanceof DocumentStockError || error instanceof HomeError || error instanceof CutoverError || error instanceof FiscalDraftError || error instanceof CnabReviewError || error instanceof StockPositionsError || error instanceof DueReportError || error instanceof SyncedXmlError || error instanceof ServiceJournalError || error instanceof FiscalReviewError || error instanceof DocumentServiceConversionError || error instanceof IntegrationProgressError || error instanceof DocumentCopyError || error instanceof FiscalItemError || error instanceof FiscalTaxError || error instanceof FinancialCutoverError || error instanceof FinancialImportError;
      // Never include request URL/query, JWT, upstream body, stack or database errors.
      return respond(known ? error.status : 500, { error: { code: known ? error.code : 'ERP_INTERNAL_ERROR', request_id: requestId, ...(known && typeof error.field === 'string' ? { field: error.field } : {}) } });
    }
  };
}

/** Leva H, lane plataforma (330): the cron of the Worker (wrangler.jsonc triggers) runs the server tasks with the service key. */
export function createScheduled({ fetchImpl = globalThis.fetch, runTwoWay = runOriginTwoWay, collectOrigin = originConnector.scheduled } = {}) {
  return async function scheduled(_event, env) {
    if (env.ERP_SCHEDULED_TASKS_ENABLED !== 'true') return { state: 'disabled' };
    const settings = config(env);
    if (_event?.cron === '*/2 * * * *') {
      const rpc = createServiceRpc({ baseUrl: settings.baseUrl, key: settings.key, fetchImpl });
      if (env.ORIGIN_CONNECTOR_ENABLED === 'true' && env.SYNC_ENABLED === 'true') await collectOrigin(_event, env);
      // Each mirror has its own transaction and bounded recovery batch.
      const results = await Promise.allSettled([projectStockMirror(rpc), rpc('erp_fiscal_mirror_project', { p_limit: 100 }), rpc('erp_document_mirror_project', { p_limit: 100 })]);
      // Mão dupla (009-011): recebe do Origin, envia ao Origin e conduz a rodada do botão Sincronizar, depois dos espelhos.
      const twoWay = await Promise.allSettled([runTwoWay({ rpc, env })]);
      const failure = [...results, ...twoWay].find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
      return [...results, ...twoWay].map(result => result.value);
    }
    return runPlatformTasks({ rpc: createServiceRpc({ baseUrl: settings.baseUrl, key: settings.key, fetchImpl }), exportStorage: createExportStorage({ baseUrl: settings.baseUrl, key: settings.key, fetchImpl }),
      attachments: createAttachmentStorage({ supabaseDeployment:env.SUPABASE_DEPLOYMENT,baseUrl: settings.baseUrl, key: settings.key, fetchImpl }), schedule: true, budgetMs: 25000 });
  };
}

export default { fetch: createHandler(), scheduled: createScheduled() };
