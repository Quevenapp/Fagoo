import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AccessError, decimalMoney, type AccessController } from '../lib/real-access';
import { DOCUMENT_MIRROR_READ_ONLY, documentObservedAt, documentOriginLabel, documentSelectionTotals, isDocumentMirror, isMirrorRecord, mirrorDecimal, type DocumentReadRecord } from '../lib/document-mirror-model';
import { DocumentMirrorPrint } from './DocumentMirrorView';
import DocumentOriginTotals from './DocumentOriginTotals';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { DOCUMENT_LABELS, STATES, TRANSITIONS, type DocumentAccess, type DocumentEnvelope, type DocumentKind, type DocumentRecord } from '../lib/real-documents-model';
import {
  DATE_TYPES, DOCUMENT_LIST_PAGE_SIZE, DOCUMENT_LIST_UFS, EMPTY_LIST_FILTERS, TRASH_STATUS, PROPOSAL_STATUS_OPTIONS, PURCHASE_STATUS_OPTIONS, proposalStatusOption, SEARCH_HINTS, defaultListFilters, STATE_FILTER, TEXT_FILTERS, brDay, documentListQuery, documentRowActions, listIndicators, nextOrder, orderColumn, pageCount,
  readDocumentListPage, reasonRequired, rowLabel, statusBatchPlan, statusLabel, statusTargets, validReason, LOT_FILTER, type DocumentListFilters, type DocumentListOrder, type DocumentListPage, type DocumentListRow, type RowAction, type StatusBatchItem,
} from '../lib/document-list-model';
import { selectRange } from '../lib/origin-list';
import { EXPORT_HEADER, EXPORT_NUMERIC, LIST_EXPORT_LABEL, LIST_PRINT_LABEL, LIST_READ_MAX_ROWS, ListReadError, addressLabels, addressesCsv, serviceLabels, addressesFileName, documentListCsv, exportFileName, exportRows, listCountLabel, listFileName, mergeListPages, readExportPage, tooLarge, type AddressLabel, type ExportDocument, type ListSnapshot } from '../lib/document-list-export';
import { XLSX_TYPE, downloadFile, numberCell, textCell, toXlsx } from '../lib/spreadsheet-export';
import { whatsappUrl } from '../lib/document-whatsapp';
import { downloadText, openExternal } from '../lib/document-download';
import { planBatch, type BatchItem, type BatchResult } from '../lib/origin-batch';
import { documentFinanceTitlePath } from '../lib/document-finance-link';
import type { CatalogAccess, CatalogPage, CatalogRecord } from '../lib/catalog-model';
import { AppliedChips, OriginPagination, IndicatorLetter, PeriodPicker, RowMenu, ToolButton, ViewToggle, type RowMenuItem } from './OriginList';
import DocumentStatusBadge from './DocumentStatusBadge';
import { batchSituationTargets, filterSituations, managed, permittedTargets, rowAt, rowKey, runnableTargets, transitionActions, transitionNote, type SituationModel } from '../lib/document-situations-model';
import DocumentListPrint from './DocumentListPrint';
import DocumentOccurrences, { DATE_LOCKED } from './DocumentOccurrences';
import DocumentColumnsDrawer from './DocumentColumnsDrawer';
import DocumentLabelsPrint from './DocumentLabelsPrint';
import { ProductLabels } from './ProductLabels';
import { purchaseLabelProducts, type PurchaseLabels } from '../lib/document-labels-model';
import type { PrintVariant } from './DocumentPrintPreview';
import { PRINT_ORDER_LABELS, type PrintItemOrder, type PrintOptions } from '../lib/document-print-model';
import { COLUMN_LABELS, DEFAULT_SAVED_NOTICE, LIST_VIEW_KINDS, columnText, listViewBody, readListView, type ListView } from '../lib/document-list-view-model';
import { occurrenceBody, readOccurrenceResult, saoPauloNow, type OccurrenceKind } from '../lib/document-occurrence-model';
import type { DocumentPreferences } from '../lib/document-preferences';
import { addDays } from '../lib/origin-list';
import { preferencePageHref, preferencePage } from '../../../../packages/erp-domain/src/preferences/catalog.mjs';
import { DOCUMENT_PREFERENCE_PAGES } from '../lib/document-preferences';
import { BatchDialog } from './BatchDialog';
import { Modal } from './Modal';
import NativeListLayout from './NativeListLayout';
import DocumentStock from './DocumentStock';
import DocumentFinance from './DocumentFinance';
import PurchaseReceipts from './PurchaseReceipts';
// Estoque lane (184): "Lançar estoque" of a purchase order receives every pending item in the chosen warehouse.
import PurchaseStockLaunch, { PurchaseStockReverse } from './PurchaseStockLaunch';
// Estoque lane, onda F (EST-024): Lançar/Estornar estoque and contas of the selected pedidos de compra.
import PurchaseEffectsBatch, { PURCHASE_EFFECT_LABELS, PURCHASE_EFFECT_ROLES, type PurchaseEffectAction } from './PurchaseEffectsBatch';
import DocumentPrintPreview from './DocumentPrintPreview';
import DocumentBatchPrint from './DocumentBatchPrint';
import { Icon } from './Icon';
import { CatalogPicker } from './DocumentCatalogPicker';
import { stockLaunchDay } from '../lib/document-stock-model';
import DocumentSellerPicker from './DocumentSellerPicker';
import DocumentXmlImport from './DocumentXmlImport';
import type { ImportDraft } from '../lib/document-xml-import-model';
import { autoFinanceMessage } from '../lib/document-pricing-model';
// Notas lane (202610200176): Vinculação of the pedidos de compra with the entry notes.
import { LINK_STATE_BADGES, useOrderLinkStates } from '../lib/fiscal-order-link-states';
import FiscalOrderBatch, { ORDER_BATCH_ROLES, groupedInvoiceReason } from './FiscalOrderBatch';
import PartialInvoiceDialog from './PartialInvoiceDialog';
import DocumentTrashDialog from './DocumentTrashDialog';
// 202610200288/289: Lote and Busca customizada filters; the OS print asks "Imprimir campos customizados na ordem de serviço?".
import DocumentListSearch, { canonicalSearch } from './DocumentListSearch';
import { CustomFieldsPrintQuestion } from './DocumentWaveG';
import { DOCUMENT_CUSTOM_FIELDS_PATH, hasCustomValues, readDocumentCustomFields, type DocumentCustomField } from '../lib/document-custom-fields';
import './document-list.css';

const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const known = (error: unknown) => error instanceof AccessError && [400, 403, 404, 409].includes(error.status);
const failureText = (error: unknown) => error instanceof AccessError && error.code === 'MODULE_OWNED_BY_ORIGIN' ? DOCUMENT_MIRROR_READ_ONLY : error instanceof AccessError ? error.status === 409 ? 'O documento mudou ou a situação atual não permite esta ação. Atualize a listagem e confira.'
  : error.status === 403 ? 'Seu perfil não permite esta operação.' : error.status === 400 ? 'O servidor recusou a operação. Confira a situação e o motivo.'
    : error.status === 404 ? 'Documento não encontrado. Atualize a listagem.' : 'Não foi possível concluir a operação. Tente novamente.' : 'Não foi possível concluir a operação. Tente novamente.';
const actorOf = (controller: AccessController) => controller.getSnapshot?.()?.membership?.user_id ?? null;
const roleOf = (controller: AccessController) => controller.getSnapshot?.()?.membership?.role ?? '';
// A saved version read for one user is never printed or sent to WhatsApp after the session changed to another one.
class SessionChanged extends Error {}
const readFailureText = (error: unknown) => error instanceof SessionChanged ? 'A sessão mudou durante a leitura. Repita a operação.' : failureText(error);

const TOTAL_HEADERS: Record<DocumentKind, string> = { sales_proposals: 'Valor', sales_orders: 'Total (R$)', purchase_orders: 'Total', service_orders: 'Total (R$)' };
const PANEL: Record<DocumentKind, { status: string; print: string; nfe?: string }> = {
  sales_orders: { status: 'Mudar situação dos pedidos selecionados', print: 'Imprimir selecionados', nfe: 'Gerar NF-e dos pedidos selecionados' },
  sales_proposals: { status: 'Mudar situação das propostas selecionadas', print: 'Imprimir selecionados' },
  service_orders: { status: 'Mudar situação das ordens selecionadas', print: 'Imprimir ordens selecionadas' },
  purchase_orders: { status: 'Mudar situação dos pedidos selecionados', print: 'Imprimir selecionados' },
};
const LIST_TITLES_SHEET: Record<DocumentKind, string> = { sales_orders: 'Pedidos de venda', sales_proposals: 'Propostas comerciais', service_orders: 'Ordens de serviço', purchase_orders: 'Pedidos de compra' };
const PERIOD_PREFIX: Record<DocumentKind, boolean> = { sales_proposals: true, sales_orders: true, service_orders: false, purchase_orders: false };
// 202610200163: the target is a situação key; the actions of a transition add versions (each posting is one).
const verifiedTransition = (result: unknown, kind: DocumentKind, row: DocumentListRow, target: string) => {
  const document = (result as (DocumentEnvelope & { document: { situation?: { key: string } | null } }) | null)?.document;
  if (!document || document.id !== row.id || document.kind !== kind || (document.situation?.key ?? document.status) !== target || document.version < row.version + 1) throw new AccessError(502);
  return document;
};

type ListCommand = { id: string; actor: string | null; path: string; body: Record<string, unknown>; label: string; uncertain: boolean; verify: (result: unknown) => unknown; done: (value: unknown, result?: unknown) => void; failed?: (error: unknown) => void };
type Dialog = { type: 'purchase-reverse'; row: DocumentListRow } | { type: 'reason'; row: DocumentListRow; target: string } | { type: 'situation'; row: DocumentListRow; target: string } | { type: 'occurrences'; row: DocumentListRow } | { type: 'sales-service'; row: DocumentListRow } | { type: 'effect'; row: DocumentListRow; effect: 'stock' | 'finance' } | { type: 'purchase-launch'; row: DocumentListRow }
  | { type: 'batch-status'; rows: DocumentListRow[] } | { type: 'batch-print'; rows: DocumentListRow[]; receipt?: boolean } | null;

export interface DocumentListProps {
  controller: AccessController; kind: DocumentKind; access: DocumentAccess | null; writable: boolean; today: string;
  page: DocumentListPage | null; loading: boolean; filters: DocumentListFilters; order: DocumentListOrder; listPage: number; filterError: string;
  onApply: (filters: DocumentListFilters) => boolean; onPage: (page: number) => void; onOrder: (order: DocumentListOrder) => void; onReload: () => void; onKind: (kind: DocumentKind) => void;
  onOpen: (id: string, event: { ctrlKey?: boolean; metaKey?: boolean; button?: number }) => void; onClone: (row: Pick<DocumentListRow, 'id'>, mode?: 'copy' | 'model' | 'model_copy') => void;
  onConverted: (kind: DocumentKind, id: string, notice: string) => void; onNavigate: (path: string) => void; onCreate?: () => void;
  /** 202610200104 user settings (Tornar padrão and listagem customizada); absent while not loaded or unavailable. */
  listView?: ListView | null; onListView?: (view: ListView | null) => void;
  /** Preferências of the kind (Exibir totais em listas); absent or null keeps the totals visible. */
  preferences?: DocumentPreferences | null;
  /** 202610200163 Gerenciador de transições of the kind; absent or not adopted keeps the situações padrão. */
  situations?: SituationModel | null;
  /** 202610200167 "Importar › Pedido XML": the draft opens in the form; `xmlRequest` (acao=xml) opens the upload once and is consumed. */
  onImported?: (draft: ImportDraft) => void; xmlRequest?: number; onXmlRequestHandled?: () => void;
}
const noFilters = (filters: DocumentListFilters) => JSON.stringify(filters) === JSON.stringify(EMPTY_LIST_FILTERS);
/** Sum of row totals in exact cents (strings in, string out); never a float. */
export const selectedTotal = (rows: readonly Pick<DocumentListRow, 'total'>[]) => { if (rows.some(row => row.total === null)) return null; const cents = rows.reduce((sum, row) => sum + BigInt(row.total!.replace('.', '')), 0n); return String(cents / 100n) + '.' + String(cents % 100n).padStart(2, '0'); };
// Origin "Exportar para a planilha" of the pedidos de compra: one month (01-12) of one year.
const monthRange = (year: string, month: string) => { const from = year + '-' + month + '-01', next = Number(month) === 12 ? String(Number(year) + 1) + '-01-01' : year + '-' + String(Number(month) + 1).padStart(2, '0') + '-01'; return { from, to: addDays(next, -1) }; };
// Only a situação selection (such as the default "Em aberto"): an empty page then may still hide existing orders.
const onlyStatuses = (filters: DocumentListFilters) => filters.statuses.length > 0 && noFilters({ ...filters, statuses: [] });

/** Origin list for propostas, pedidos de venda, OS and pedidos de compra: filters, ⋮ actions, selection and batch actions. */
export default function DocumentList(props: DocumentListProps) {
  const { controller, kind, access, writable, page, loading, filters, order, listPage } = props;
  const model = managed(props.situations, kind) ? props.situations : null, situationQuery = { situations: Boolean(model) };
  // Preferências › Empresa "Permite a edição da data e hora das ocorrências" (163): off, the server records the current moment.
  const dateLocked = props.situations?.kind === kind && props.situations.occurrence_date_editable === false;
  const [draft, setDraft] = useState<DocumentListFilters>(filters);
  const applied = JSON.stringify(filters);
  useEffect(() => { setDraft(filters); }, [applied]);
  const [selected, setSelected] = useState<Set<string>>(new Set()); const [anchor, setAnchor] = useState<string | null>(null); const [menu, setMenu] = useState<string | null>(null);
  useEffect(() => { setSelected(new Set()); setAnchor(null); setMenu(null); }, [page]);
  // Origin shows the welcome cards when the company has no pedido at all, also under the default situação filter.
  // An empty filtered page is confirmed by one read without filters (one row), tied to the page it explains.
  const [emptyCompany, setEmptyCompany] = useState<{ page: DocumentListPage; empty: boolean } | null>(null);
  useEffect(() => {
    if (kind !== 'sales_orders' || !page || loading || page.total_count !== 0 || !onlyStatuses(filters)) return;
    const request = new AbortController(), actor = actorOf(controller), shown = page;
    void Promise.resolve().then(() => controller.documents(`/v1/documentos/${kind}?${documentListQuery(kind, EMPTY_LIST_FILTERS, { page: 1, limit: 1, ...situationQuery })}`, { signal: request.signal })).then(value => {
      if (request.signal.aborted || actorOf(controller) !== actor) return;
      setEmptyCompany({ page: shown, empty: readDocumentListPage(value, kind, 1, 'date_desc').total_count === 0 });
    }).catch(() => { /* Without the confirmation the usual empty message stays. */ });
    return () => request.abort();
  }, [controller, kind, page, loading, applied]);
  const [dialog, setDialog] = useState<Dialog>(null); const [reason, setReason] = useState('');
  // Notas lane (202610200215+): "Gerar NF-e dos pedidos selecionados" / "Gerar: NFC-es selecionadas", one homologation note per pedido.
  const [fiscalBatch, setFiscalBatch] = useState<'55' | '65' | null>(null);
  const [purchaseBatch, setPurchaseBatch] = useState<PurchaseEffectAction | null>(null);
  // Origin "Alterando situação para …": Data, Hora and the occurrence text (also the reason) of one ⋮ change.
  const [situation, setSituation] = useState({ date: '', time: '', text: '' });
  const [batchTarget, setBatchTarget] = useState(''); const [batchReason, setBatchReason] = useState(''); const [batchStarted, setBatchStarted] = useState(false);
  const [printRecord, setPrintRecord] = useState<{ record: DocumentReadRecord; variant: PrintVariant; options: PrintOptions } | null>(null);
  const [printQuestion, setPrintQuestion] = useState<{ record: DocumentRecord; variant: PrintVariant; options: PrintOptions; fields: DocumentCustomField[] } | null>(null);
  // The definitions of the campos customizados the Busca customizada of the OS read (types of the values); null until read.
  const searchFieldsRef = useRef<DocumentCustomField[] | null>(null); const [printRecords, setPrintRecords] = useState<{ records: DocumentReadRecord[]; receipt: boolean; options: PrintOptions } | null>(null);
  // Origin "Opções de impressão" of Imprimir selecionados, and the address labels of the selected rows.
  // 202610200240: "Desmembrar produtos da estrutura" and "Ocultar itens produzidos por terceiros" read the structure of each pedido.
  const [productLabels, setProductLabels] = useState<PurchaseLabels | null>(null);
  // Leva H (391): Gerar nota fiscal parcial of one pedido de venda.
  const [partialInvoice, setPartialInvoice] = useState<{ id: string; number: string } | null>(null);
  // Leva H (392): Excluir selecionados / Restaurar selecionados and the lixeira (situação Excluídos).
  const [trashAction, setTrashAction] = useState<'delete' | 'restore' | null>(null);
  const [printOptions, setPrintOptions] = useState<{ detailed: boolean; order: PrintItemOrder; explode: boolean; hideThirdParty: boolean }>({ detailed: false, order: 'insertion', explode: false, hideThirdParty: false }); const [labels, setLabels] = useState<AddressLabel[] | null>(null), [labelReading, setLabelReading] = useState(false);
  const [busy, setBusy] = useState(false); const [uncertain, setUncertain] = useState(false); const [actionError, setActionError] = useState(''); const [actionNotice, setActionNotice] = useState('');
  const [catalogRead, setCatalogRead] = useState<string[]>([]); const [warehouses, setWarehouses] = useState<CatalogRecord[]>([]);
  const [productQuery, setProductQuery] = useState(''); const [products, setProducts] = useState<CatalogRecord[]>([]); const [productSearching, setProductSearching] = useState(false);
  // The propostas modelos offered by "Selecione o modelo" (read once per screen; the list itself keeps its own filters).
  const [models, setModels] = useState<DocumentListRow[]>([]);
  useEffect(() => {
    if (kind !== 'sales_proposals' || !writable) { setModels([]); return; }
    const request = new AbortController(), actor = actorOf(controller);
    void Promise.resolve().then(() => controller.documents(`/v1/documentos/sales_proposals?${new URLSearchParams({ limit: '100', page: '1', template: 'true' })}`, { signal: request.signal })).then(value => {
      if (request.signal.aborted || actorOf(controller) !== actor) return; setModels(readDocumentListPage(value, kind, 1, 'date_desc').items.filter(item => item.template && !isDocumentMirror(item)));
    }).catch(() => { /* Without models the select stays empty and disabled. */ });
    return () => request.abort();
  }, [controller, kind, writable]);
  const [listBusy, setListBusy] = useState<'print' | 'export' | null>(null); const [monthExport, setMonthExport] = useState<{ month: string; year: string } | null>(null); const [listPrint, setListPrint] = useState<{ snapshot: ListSnapshot; filters: string[] } | null>(null);
  const command = useRef<ListCommand | null>(null), inflight = useRef<AbortController | null>(null), detail = useRef<AbortController | null>(null), lifetime = useRef(new AbortController());
  const listRead = useRef<AbortController | null>(null), appliedKey = useRef(''); appliedKey.current = `${kind}:${applied}:${order}`;
  const batchActor = useRef<string | null>(null), printed = useRef(new Map<string, DocumentReadRecord>());
  const guard = useUnsavedChanges(uncertain, busy);
  useEffect(() => { const life = lifetime.current; return () => { life.abort(); inflight.current?.abort(); detail.current?.abort(); listRead.current?.abort(); }; }, []);
  useEffect(() => {
    // Catalog-backed filters appear only for profiles that can read those cadastros.
    const request = new AbortController();
    void Promise.resolve().then(() => controller.catalog('/v1/cadastros', { signal: request.signal })).then(async value => {
      const read = Array.isArray((value as CatalogAccess | null)?.read) ? (value as CatalogAccess).read : [];
      if (request.signal.aborted) return; setCatalogRead(read);
      if (!read.includes('warehouses')) return;
      const list = await controller.catalog('/v1/cadastros/warehouses?limit=100', { signal: request.signal }) as CatalogPage;
      if (!request.signal.aborted && Array.isArray(list?.items)) setWarehouses(list.items);
    }).catch(() => { /* The filters stay hidden; document permissions are enforced separately. */ });
    return () => request.abort();
  }, [controller]);
  useEffect(() => {
    const query = productQuery.trim();
    if (!catalogRead.includes('products') || query.length < 2) { setProducts([]); setProductSearching(false); return; }
    const request = new AbortController(); setProductSearching(true);
    const timer = setTimeout(() => {
      void controller.catalog(`/v1/cadastros/products?${new URLSearchParams({ limit: '25', q: query })}`, { signal: request.signal })
        .then(value => { if (!request.signal.aborted) { setProducts((value as CatalogPage).items ?? []); setProductSearching(false); } })
        .catch(() => { if (!request.signal.aborted) { setProducts([]); setProductSearching(false); } });
    }, 250);
    return () => { clearTimeout(timer); request.abort(); };
  }, [controller, productQuery, catalogRead]);

  const rows = page?.items ?? [];
  const linkStates = useOrderLinkStates(controller, kind, rows.filter(row => !isDocumentMirror(row)).map(row => row.id));
  const ids = rows.map(row => row.id);
  const selectedRows = rows.filter(row => selected.has(row.id));
  const selectedMirror = selectedRows.some(isDocumentMirror);
  const selectedNativeRows = selectedRows.filter((row): row is DocumentListRow & { number: string } => !isDocumentMirror(row) && typeof row.number === 'string');
  const inTrash = props.filters.statuses.length === 1 && props.filters.statuses[0] === TRASH_STATUS;
  const allSelected = rows.length > 0 && rows.every(row => selected.has(row.id));
  const locked = busy || uncertain;
  const role = roleOf(controller);
  const toggleRow = (id: string, shift: boolean) => { const result = selectRange(ids, selected, anchor, id, shift); setSelected(result.selected); setAnchor(result.anchor); };
  const togglePage = () => setSelected(allSelected ? new Set() : new Set(ids));
  const apply = (next: DocumentListFilters) => { const accepted = props.onApply(next); if (accepted) { setActionNotice(''); setActionError(''); } return accepted; };
  const [makeDefault, setMakeDefault] = useState(false); const [columnsOpen, setColumnsOpen] = useState(false);
  const [xmlOpen, setXmlOpen] = useState(false), xmlAllowed = writable && Boolean(props.onImported) && (kind === 'sales_orders' || kind === 'purchase_orders');
  useEffect(() => { if ((props.xmlRequest ?? 0) > 0 && xmlAllowed) { setXmlOpen(true); props.onXmlRequestHandled?.(); } }, [props.xmlRequest, xmlAllowed]);
  const listView = LIST_VIEW_KINDS.includes(kind) ? props.listView ?? null : null;
  // Origin "Tornar padrão" / "Listagem customizada": the user's own settings, saved with CAS and a command of their own.
  const saveView = (change: Parameters<typeof listViewBody>[1], notice: string) => {
    if (!listView || !props.onListView) return;
    start({ path: `/v1/documentos/${kind}/preferencias-listagem`, body: listViewBody(listView, change), label: 'configurações da listagem',
      verify: result => { try { return readListView(result, kind); } catch { throw new AccessError(502); } },
      done: value => { props.onListView!(value as ListView); setColumnsOpen(false); setMakeDefault(false); setActionNotice(notice); },
      failed: error => { if (error instanceof AccessError && error.status === 409) props.onListView!(null); } });
  };
  const submit = (event: FormEvent) => { event.preventDefault(); const next = { ...draft, query: draft.query.trim() }; for (const field of TEXT_FILTERS[kind]) next[field.key] = draft[field.key].trim();
    // An empty Lote or Busca customizada leaves no key (the list without filters stays the same).
    next.lots = draft.lots?.trim() || undefined; next.search = draft.search?.length ? canonicalSearch(kind, draft.search, searchFieldsRef.current) : undefined;
    if (apply(next) && makeDefault && listView) saveView({ default_statuses: next.statuses }, DEFAULT_SAVED_NOTICE); };
  const open = (id: string, event: { ctrlKey?: boolean; metaKey?: boolean; button?: number }) => guard.confirmLeave(() => props.onOpen(id, event));

  const execute = async () => {
    const op = command.current; if (!op || inflight.current) return;
    if (actorOf(controller) !== op.actor) { command.current = null; setUncertain(false); setActionError('A sessão mudou. Confira o documento na listagem antes de repetir.'); return; }
    const request = new AbortController(); inflight.current = request; setBusy(true); setActionError(''); setActionNotice('');
    try {
      const result = await controller.documents(op.path, { method: 'POST', body: { ...op.body, command_id: op.id }, signal: request.signal });
      if (request.signal.aborted) return;
      if (actorOf(controller) !== op.actor) { command.current = null; setUncertain(false); setActionError('A sessão mudou durante a operação. Confira o documento antes de repetir.'); return; }
      const value = op.verify(result); command.current = null; setUncertain(false); op.done(value, result);
    } catch (failure) {
      if (request.signal.aborted || aborted(failure)) return;
      if (!op.uncertain && known(failure)) { command.current = null; setUncertain(false); setActionError(failureText(failure)); op.failed?.(failure); }
      else { op.uncertain = true; setUncertain(true); setActionError(`Não foi possível confirmar o resultado (${op.label}). Use “Conferir resultado” para repetir a mesma operação sem duplicar.`); }
    } finally { if (inflight.current === request) inflight.current = null; if (!request.signal.aborted) setBusy(false); }
  };
  const start = (op: Omit<ListCommand, 'id' | 'actor' | 'uncertain'>) => { if (command.current || inflight.current) return; command.current = { ...op, id: crypto.randomUUID(), actor: actorOf(controller), uncertain: false }; void execute(); };
  const changeStatus = (row: DocumentListRow, target: string, why: string | null) => start({
    path: `/v1/documentos/${kind}/${row.id}/status`, body: { expected_version: row.version, status: target, reason: why }, label: `${rowLabel(kind, row)} → ${statusLabel(kind, target, model)}`,
    verify: result => verifiedTransition(result, kind, row, target),
    done: (_value, result) => { setDialog(null); setReason(''); setActionNotice([`${rowLabel(kind, row)}: situação alterada para ${statusLabel(kind, target, model)}.`, autoFinanceMessage((result as { auto_finance?: unknown } | null)?.auto_finance)].filter(Boolean).join(' ')); props.onReload(); },
  });
  const occurrenceKind: OccurrenceKind | null = kind;
  const changeSituation = (row: DocumentListRow, target: string) => {
    if (!occurrenceKind) return;
    let body: ReturnType<typeof occurrenceBody>;
    try { body = occurrenceBody(occurrenceKind, row, { occurred_on: situation.date, occurred_time: situation.time, text: situation.text, status: target, next_contact: '' }, reasonRequired(kind, rowKey(row), target, model)); }
    catch (failure) { setActionError((failure as Error).message); return; }
    start({ path: `/v1/documentos/${kind}/${row.id}/ocorrencias`, body, label: `${rowLabel(kind, row)} → ${statusLabel(kind, target, model)}`,
      verify: result => { let read; try { read = readOccurrenceResult(result, occurrenceKind, row.id, body); } catch { throw new AccessError(502); } if (read.document.version < row.version + 1) throw new AccessError(502); return read; },
      done: (_value, result) => { setDialog(null); setSituation({ date: '', time: '', text: '' }); setActionNotice([`${rowLabel(kind, row)}: situação alterada para ${statusLabel(kind, target, model)}.`, autoFinanceMessage((result as { auto_finance?: unknown } | null)?.auto_finance)].filter(Boolean).join(' ')); props.onReload(); } });
  };
  // 202610200131 "Gerar ordem serviço" from a pedido: one command, reviewed first; the new OS opens afterwards.
  const salesToService = (row: DocumentListRow) => start({
    path: `/v1/documentos/sales_orders/${row.id}/gerar-os`, body: { expected_version: row.version }, label: `${rowLabel(kind, row)} → ordem de serviço`,
    verify: result => { const value = result as { sale?: DocumentRecord; service_order?: DocumentRecord } | null; const os = value?.service_order;
      if (!os || os.kind !== 'service_orders' || value?.sale?.id !== row.id || !Number.isInteger(os.version)) throw new AccessError(502); return os; },
    done: value => { const os = value as DocumentRecord; setDialog(null); props.onConverted('service_orders', os.id, `Ordem de serviço ${os.number} gerada a partir do pedido ${row.number}.`); },
    // The nota of origin is shown only to admin and fiscal, so the server may be the one that finds it.
    failed: failure => { if (failure instanceof AccessError && failure.status === 400) setActionError('A ordem de serviço não foi gerada: o pedido tem nota fiscal vinculada ou está cancelado.');
      else if (failure instanceof AccessError && failure.status === 409) setActionError('A ordem de serviço não foi gerada: o pedido já gerou uma ordem de serviço ou mudou. Atualize a listagem e confira.'); },
  });
  const readDocument = async (row: DocumentListRow, signal: AbortSignal) => {
    const actor = actorOf(controller);
    const response = await controller.documents(`/v1/documentos/${kind}/${row.id}`, { signal }) as { document: DocumentReadRecord };
    if (actorOf(controller) !== actor) throw new SessionChanged();
    const document = response?.document;
    if (!document || document.id !== row.id || document.kind !== kind || !Number.isInteger(document.version)) throw new AccessError(502);
    return document;
  };
  // Preferências › Configuração de Impressão (and the OS "Rótulos") of this kind go with every print of the list.
  const printPrefs = (options: PrintOptions): PrintOptions => props.preferences ? { ...options, prefs: props.preferences.print, labels: props.preferences.labels } : options;
  // 202610200240 Pedidos de compra "Imprimir etiquetas" (⋮ and selection): the products of the saved pedidos, each product once (the quantity of
  // labels is chosen in the labels dialog), at most 60 pedidos.
  const printProductLabels = async (rows: readonly DocumentListRow[]) => {
    if (kind !== 'purchase_orders' || !rows.length || labelReading) return;
    if (rows.length > 60) { setActionError('Selecione até 60 pedidos de compra para imprimir as etiquetas.'); return; }
    detail.current?.abort(); const request = new AbortController(); detail.current = request; setActionError(''); setActionNotice(''); setLabelReading(true);
    try {
      const records: DocumentRecord[] = [];
      for (const row of rows) { const record = await readDocument(row, request.signal); if (isMirrorRecord(record)) throw new Error(DOCUMENT_MIRROR_READ_ONLY); records.push(record); if (request.signal.aborted || detail.current !== request) return; }
      const labels = purchaseLabelProducts(records);
      if (!labels.products.length) { setActionError('Os pedidos selecionados não têm produtos do cadastro para imprimir etiquetas.'); return; }
      setProductLabels(labels);
    } catch (failure) { if (!request.signal.aborted && !aborted(failure)) setActionError(readFailureText(failure)); }
    finally { if (detail.current === request) detail.current = null; setLabelReading(false); }
  };
  // OS "Imprimir etiqueta" / "Etiquetas selecionadas": the saved OS are read again (equipamento and número de série), at most 60.
  const printServiceLabels = async (rows: readonly DocumentListRow[]) => {
    if (kind !== 'service_orders' || !rows.length || labelReading) return;
    if (rows.length > 60) { setActionError('Selecione até 60 ordens de serviço para imprimir as etiquetas.'); return; }
    detail.current?.abort(); const request = new AbortController(); detail.current = request; setActionError(''); setActionNotice(''); setLabelReading(true);
    try {
      const records: DocumentRecord[] = [];
      for (const row of rows) { const record = await readDocument(row, request.signal); if (isMirrorRecord(record)) throw new Error(DOCUMENT_MIRROR_READ_ONLY); records.push(record); if (request.signal.aborted || detail.current !== request) return; }
      setLabels(serviceLabels(records));
    } catch (failure) { if (!request.signal.aborted && !aborted(failure)) setActionError(readFailureText(failure)); }
    finally { if (detail.current === request) detail.current = null; setLabelReading(false); }
  };
  const printOne = async (row: DocumentListRow, variant: PrintVariant = 'normal', options: PrintOptions = {}) => {
    detail.current?.abort(); const request = new AbortController(); detail.current = request; setActionError(''); setActionNotice('');
    try { const document = await readDocument(row, request.signal); if (request.signal.aborted || detail.current !== request) return;
      // 202610200288: an OS with campos customizados asks first; when they cannot be read, it prints without them.
      if (!isMirrorRecord(document) && kind === 'service_orders' && variant === 'normal' && hasCustomValues(document.custom_fields)) {
        let fields: DocumentCustomField[] | null = null;
        try { fields = readDocumentCustomFields(await controller.documents(DOCUMENT_CUSTOM_FIELDS_PATH, { signal: request.signal })).items; } catch { if (request.signal.aborted) return; }
        if (request.signal.aborted || detail.current !== request) return;
        if (fields) { setPrintQuestion({ record: document, variant, options: printPrefs(options), fields }); return; }
      }
      setPrintRecord({ record: document, variant, options: printPrefs(options) }); }
    catch (failure) { if (!request.signal.aborted && !aborted(failure)) setActionError(readFailureText(failure)); }
    finally { if (detail.current === request) detail.current = null; }
  };
  // "Enviar por WhatsApp": the saved version is read again; the user reviews and sends the message in WhatsApp.
  const sendWhatsapp = async (row: DocumentListRow) => {
    detail.current?.abort(); const request = new AbortController(); detail.current = request; setActionError(''); setActionNotice('');
    try {
      const document = await readDocument(row, request.signal); if (request.signal.aborted || detail.current !== request) return;
      if (isMirrorRecord(document)) { setActionError(DOCUMENT_MIRROR_READ_ONLY); return; }
      const url = whatsappUrl(document, kind === 'service_orders' ? props.preferences?.print.whatsappTemplate ?? null : null);
      if (!url) { setActionError(`O ${kind === 'purchase_orders' ? 'fornecedor' : 'cliente'} deste documento não tem celular ou telefone válido no cadastro.`); return; }
      openExternal(url); setActionNotice(`WhatsApp aberto com o resumo de ${rowLabel(kind, row)}. Confira a mensagem antes de enviar.`);
    } catch (failure) { if (!request.signal.aborted && !aborted(failure)) setActionError(readFailureText(failure)); }
    finally { if (detail.current === request) detail.current = null; }
  };
  // Imprimir listagem / Exportar: every page of the applied filter, read in order and checked against the same total.
  const readAll = async (purpose: 'print' | 'export', override: DocumentListFilters | null = null) => {
    if (listRead.current || !page || loading) return;
    if (!override && page.total_count > LIST_READ_MAX_ROWS) { setActionError(tooLarge(page.total_count).message); return; }
    const source = override ?? filters;
    const actor = actorOf(controller), key = appliedKey.current, request = new AbortController(); listRead.current = request;
    const summary = [...chips.map(chip => chip.label), periodText];
    setListBusy(purpose); setActionError(''); setActionNotice('');
    try {
      const pages: DocumentListPage[] = [];
      for (let number = 1, last = 1; number <= last; number++) {
        const value = await controller.documents(`/v1/documentos/${kind}?${documentListQuery(kind, source, { page: number, order, ...situationQuery })}`, { signal: request.signal });
        if (request.signal.aborted) return;
        if (actorOf(controller) !== actor) throw new ListReadError('A sessão mudou durante a leitura. Repita a operação.');
        const result = readDocumentListPage(value, kind, number, order); pages.push(result);
        if (number === 1) { if (result.total_count > LIST_READ_MAX_ROWS) throw tooLarge(result.total_count); last = pageCount(result.total_count); }
      }
      if (appliedKey.current !== key) throw new ListReadError('Os filtros mudaram durante a leitura. Repita a operação.');
      // Imprimir listagem and the planilha follow "Exibir totais em listas" like the Informações panel.
      const merged = mergeListPages(kind, pages), snapshot = totalsVisible ? merged : { ...merged, total_amount: null, origin_totals: undefined };
      if (purpose === 'print') setListPrint({ snapshot, filters: summary });
      else { downloadText(override ? listFileName(kind, override.from.slice(0, 7)) : listFileName(kind, props.today), documentListCsv(snapshot)); setMonthExport(null); setActionNotice(`Planilha gerada com ${snapshot.total_count.toLocaleString('pt-BR')} ${snapshot.total_count === 1 ? 'registro' : 'registros'} do filtro aplicado.`); }
    } catch (failure) { if (!request.signal.aborted && !aborted(failure)) setActionError(failure instanceof ListReadError ? failure.message : failureText(failure)); }
    finally { if (listRead.current === request) listRead.current = null; if (!request.signal.aborted) setListBusy(null); }
  };
  // 202610200166 "Exportar para a planilha" (pedidos de compra): XLSX with the items, read page by page; a database before 166
  // (no export route) keeps the CSV of the list.
  const exportMonth = async (range: { from: string; to: string }) => {
    if (listRead.current) return;
    if (filters.origin !== 'brufap') { await readAll('export'); return; }
    const actor = actorOf(controller), request = new AbortController(); listRead.current = request; setListBusy('export'); setActionError(''); setActionNotice('');
    let fallback = false;
    try {
      const documents: ExportDocument[] = [];
      for (let number = 1, more = true; more; number++) {
        if (number > 200) throw tooLarge(LIST_READ_MAX_ROWS + 1);
        let value: unknown;
        try { value = await controller.documents(`/v1/documentos/${kind}/exportacao?${new URLSearchParams({ from: range.from, to: range.to, page: String(number) })}`, { signal: request.signal }); }
        catch (failure) { if (number === 1 && failure instanceof AccessError && [404, 502].includes(failure.status)) { fallback = true; break; } throw failure; }
        if (request.signal.aborted) return;
        if (actorOf(controller) !== actor) throw new ListReadError('A sessão mudou durante a leitura. Repita a operação.');
        const page = readExportPage(value, kind, range.from, range.to, number); documents.push(...page.items); more = page.has_more;
      }
      if (!fallback) {
        const rows = [EXPORT_HEADER.map(label => textCell(label)), ...exportRows(kind, documents).map(row => row.map((cell, index) => EXPORT_NUMERIC.has(index) ? numberCell(cell) : textCell(cell)))];
        downloadFile(exportFileName(kind, range.from.slice(0, 7)), toXlsx(LIST_TITLES_SHEET[kind], rows) as unknown as BlobPart, XLSX_TYPE);
        setMonthExport(null); setActionNotice(`Planilha gerada com ${documents.length.toLocaleString('pt-BR')} ${documents.length === 1 ? 'pedido' : 'pedidos'} e ${(rows.length - 1).toLocaleString('pt-BR')} ${rows.length - 1 === 1 ? 'linha' : 'linhas'}.`);
      }
    } catch (failure) { if (!request.signal.aborted && !aborted(failure)) setActionError(failure instanceof ListReadError ? failure.message : failureText(failure)); }
    finally {
      if (listRead.current === request) listRead.current = null; if (!request.signal.aborted) setListBusy(null);
      if (fallback && !request.signal.aborted) void Promise.resolve().then(() => readAll('export', { ...EMPTY_LIST_FILTERS, origin: 'brufap', from: range.from, to: range.to }));
    }
  };
  const runAction = (row: DocumentListRow, action: RowAction) => {
    if (isDocumentMirror(row) && !['edit', 'print', 'print_detailed'].includes(action.action)) { setActionError(DOCUMENT_MIRROR_READ_ONLY); return; }
    setMenu(null);
    if (!action.enabled) return;
    if (action.action === 'edit') { open(row.id, {}); return; }
    if (action.action === 'print') { void printOne(row); return; }
    if (action.action === 'print_receipt') { void printOne(row, 'receipt'); return; }
    if (action.action === 'print_detailed') { void printOne(row, 'normal', { detailed: true }); return; }
    if (action.action === 'print_carne') { void printOne(row, 'carne'); return; }
    if (action.action === 'print_production') { void printOne(row, 'production'); return; }
    if (action.action === 'print_technician') { void printOne(row, 'normal', { technician: true }); return; }
    if (action.action === 'print_label') { void printServiceLabels([row]); return; }
    if (action.action === 'print_product_labels') { void printProductLabels([row]); return; }
    // Origin "Gerar nota fiscal" opens the note form in a new tab, filled from the pedido (notas lane, 202610200176); the pedido de compra
    // opens the entry note. The note is saved only by its Salvar (homologação).
    if (action.action === 'fiscal_partial') { setPartialInvoice({ id: row.id, number: String(row.number) }); return; }
    if (action.action === 'fiscal55' || action.action === 'fiscal65') { window.open(kind === 'purchase_orders' ? `/notas-entrada?${new URLSearchParams({ origem: 'brufap', nota: 'nova', pedido: row.id })}`
      : `/historico-fiscal?${new URLSearchParams({ modelo: action.action === 'fiscal55' ? '55' : '65', origem: 'brufap', nota: 'nova', pedido: row.id })}`, '_blank', 'noopener'); return; }
    if (action.action === 'whatsapp') { void sendWhatsapp(row); return; }
    if (locked) return;
    if (action.action === 'clone') { guard.confirmLeave(() => props.onClone(row)); return; }
    if (action.action === 'create_model' || action.action === 'clone_model') { guard.confirmLeave(() => props.onClone(row, action.action === 'create_model' ? 'model' : 'model_copy')); return; }
    if (action.action === 'clear_warnings') { setActionNotice(''); props.onReload(); return; }
    if (action.action === 'sales_to_service') { setActionError(''); setDialog({ type: 'sales-service', row }); return; }
    // 202610200196 Origin "Gerar venda" / "Gerar ordem de serviço": the new document opens prefilled (vendas.php#idOrigem/<id>), unsaved.
    if (action.action === 'convert_sale' || action.action === 'convert_service') { setActionError(''); props.onNavigate(`/documentos-empresa?${new URLSearchParams({ tipo: action.action === 'convert_service' ? 'service_orders' : 'sales_orders', acao: 'proposta', origem: row.id })}`); return; }
    if (action.action === 'stock' && kind === 'purchase_orders' && !row.stock_active && !row.receipt_active) { setActionError(''); setDialog({ type: 'purchase-launch', row }); return; }
    // Estoque lane (225): "Estornar estoque" of a purchase order with receipts reverses every active receipt after one confirmation.
    if (action.action === 'stock' && kind === 'purchase_orders' && !row.stock_active && row.receipt_active) { setActionError(''); setDialog({ type: 'purchase-reverse', row }); return; }
    if (action.action === 'stock' || action.action === 'finance') { setActionError(''); setDialog({ type: 'effect', row, effect: action.action }); return; }
    if (action.action === 'status' && action.target) {
      if (occurrenceKind) { const now = saoPauloNow(); setSituation({ date: now.date, time: now.time, text: '' }); setActionError(''); setDialog({ type: 'situation', row, target: action.target }); return; }
      if (reasonRequired(kind, rowKey(row), action.target, model)) { setReason(''); setActionError(''); setDialog({ type: 'reason', row, target: action.target }); }
      else changeStatus(row, action.target, null);
    }
  };
  const menuItems = (row: DocumentListRow): RowMenuItem[] => documentRowActions(kind, row, { role, writable, serviceWritable: Boolean(access?.write.includes('service_orders')), situations: model, permissions: access?.permissions ?? null }).map(action => {
    const mutation = !['edit', 'clear_warnings', 'print', 'print_receipt', 'print_detailed', 'print_carne', 'print_production', 'print_technician', 'print_label', 'print_product_labels', 'fiscal55', 'fiscal65', 'fiscal_partial', 'whatsapp', 'unavailable'].includes(action.action);
    const blocked = mutation && locked;
    return { label: action.label, ...(action.letter ? { letter: action.letter } : {}), ...(action.icon ? { icon: action.icon } : {}), separatorBefore: action.separatorBefore,
      disabled: !action.enabled || blocked, title: blocked ? 'Aguarde a conclusão da operação em andamento.' : action.title, onClick: () => runAction(row, action) };
  });

  const openBatch = (type: 'batch-status' | 'batch-print', receipt = false) => {
    if (!selectedRows.length || locked || type === 'batch-status' && selectedMirror || receipt && selectedMirror) return;
    batchActor.current = actorOf(controller); printed.current = new Map(); setBatchTarget(''); setBatchReason(''); setBatchStarted(false); setActionError(''); setActionNotice('');
    // Origin "Padrão da ordem de impressão dos itens" (Preferências › Vendas) is the first choice of the dialog.
    if (type === 'batch-print') setPrintOptions({ detailed: false, order: props.preferences?.print.order ?? 'insertion', explode: false, hideThirdParty: false });
    setDialog(type === 'batch-print' ? { type, rows: selectedRows.slice(), receipt } : { type, rows: selectedRows.slice() });
  };
  const exportAddresses = () => { if (!selectedRows.length) return; downloadText(addressesFileName(props.today), addressesCsv(kind, selectedRows)); setActionNotice(`Endereços de ${selectedRows.length} ${selectedRows.length === 1 ? 'pedido exportados' : 'pedidos exportados'}.`); };
  const sessionGuard = () => { if (lifetime.current.signal.aborted || actorOf(controller) !== batchActor.current) throw new Error('A sessão mudou. Este registro não foi processado.'); };
  const runStatusItem = async ({ row }: StatusBatchItem) => {
    setBatchStarted(true); sessionGuard(); if (isDocumentMirror(row)) throw new Error(DOCUMENT_MIRROR_READ_ONLY);
    const description = batchReason.trim(), now = saoPauloNow();
    // With a "Descrição da ocorrência" the change goes through the occurrence (same transition, the text is the reason).
    const occurrence = occurrenceKind && description ? { expected_version: row.version, occurred_on: now.date, occurred_time: now.time, text: description, status: batchTarget } : null;
    const body = occurrence ? { ...occurrence, command_id: crypto.randomUUID() } : { command_id: crypto.randomUUID(), expected_version: row.version, status: batchTarget, reason: description || null };
    const send = () => controller.documents(`/v1/documentos/${kind}/${row.id}/${occurrence ? 'ocorrencias' : 'status'}`, { method: 'POST', body, signal: lifetime.current.signal });
    const check = (value: unknown) => { if (!occurrence) { verifiedTransition(value, kind, row, batchTarget); return; } let read; try { read = readOccurrenceResult(value, occurrenceKind!, row.id, occurrence); } catch { throw new AccessError(502); } if (read.document.version < row.version + 1) throw new AccessError(502); };
    try { check(await send()); return { message: `Situação alterada para ${statusLabel(kind, batchTarget, model)}.` }; }
    catch (first) {
      if (known(first)) throw new Error(failureText(first));
      // Unknown outcome: repeat the same command once, so the server replays it instead of applying it twice.
      // From here on any failure stays "a conferir": the first attempt may already be registered.
      const unconfirmed = { uncertain: true, message: `Resultado não confirmado. Confira ${rowLabel(kind, row)} antes de repetir.` };
      if (lifetime.current.signal.aborted || actorOf(controller) !== batchActor.current) return unconfirmed;
      try { check(await send()); return { message: `Situação alterada para ${statusLabel(kind, batchTarget, model)} (confirmada ao repetir o mesmo comando).` }; }
      catch { return unconfirmed; }
    }
  };
  const runPrintItem = async (item: BatchItem & { row: DocumentListRow }) => {
    sessionGuard();
    try { const document = await readDocument(item.row, lifetime.current.signal); printed.current.set(item.id, document); return { message: `Versão ${document.version} pronta para impressão.` }; }
    catch (failure) { throw new Error(failure instanceof AccessError || failure instanceof SessionChanged ? readFailureText(failure) : 'Não foi possível ler o documento.'); }
  };
  const closeBatch = (results: BatchResult[] | null) => {
    const current = dialog; setDialog(null); setBatchStarted(false);
    if (!results || !current) return;
    if (current.type === 'batch-print') { const documents = current.rows.map(row => printed.current.get(row.id)).filter((value): value is DocumentReadRecord => Boolean(value)); printed.current = new Map(); if (documents.length) setPrintRecords({ records: documents, receipt: Boolean(current.receipt), options: printPrefs(current.receipt ? {} : { ...printOptions }) }); return; }
    if (results.some(result => result.outcome === 'ok' || result.outcome === 'uncertain')) { setSelected(new Set()); props.onReload(); }
  };

  const total = page?.total_count ?? 0;
  const chips = [
    ...(filters.origin && filters.origin !== 'all' ? [{ label: `Origem: ${filters.origin === 'origin' ? 'Origin' : 'FAGOO'}`, onRemove: () => apply({ ...filters, origin: undefined }) }] : []),
    ...(filters.statuses.length ? [{ label: `Situação: ${filters.statuses.map(status => statusLabel(kind, status, model)).join(', ')}`, onRemove: () => apply({ ...filters, statuses: [] }) }] : []),
    ...(filters.query ? [{ label: `Pesquisa: ${filters.query}`, onRemove: () => apply({ ...filters, query: '' }) }] : []),
    ...(filters.warehouse ? [{ label: `Depósito: ${filters.warehouse.name}`, onRemove: () => apply({ ...filters, warehouse: null }) }] : []),
    ...(filters.product ? [{ label: `${kind === 'service_orders' ? 'Peça' : 'Produto'}: ${filters.product.name}`, onRemove: () => apply({ ...filters, product: null }) }] : []),
    ...(filters.service ? [{ label: `Serviço: ${filters.service.name}`, onRemove: () => apply({ ...filters, service: null }) }] : []),
    ...(filters.component ? [{ label: `Componente: ${filters.component.name}`, onRemove: () => apply({ ...filters, component: null }) }] : []),
    ...TEXT_FILTERS[kind].filter(field => filters[field.key]).map(field => ({ label: `${field.label}: ${filters[field.key]}`, onRemove: () => apply({ ...filters, [field.key]: '' }) })),
    ...(filters.template !== null ? [{ label: filters.template ? 'Situação: Modelos' : 'Situação: sem modelos', onRemove: () => apply({ ...filters, template: null }) }] : []),
    ...(filters.state ? [{ label: `UF: ${filters.state}`, onRemove: () => apply({ ...filters, state: '' }) }] : []),
    ...(filters.seller ? [{ label: `Vendedor: ${filters.seller.name}`, onRemove: () => apply({ ...filters, seller: null }) }] : []),
    ...(filters.lots ? [{ label: `Lote: ${filters.lots}`, onRemove: () => apply({ ...filters, lots: undefined }) }] : []),
    ...(filters.search?.length ? [{ label: `Busca customizada: ${filters.search.length} ${filters.search.length === 1 ? 'filtro' : 'filtros'}`, onRemove: () => apply({ ...filters, search: undefined }) }] : []),
    ...(kind === 'purchase_orders' && selectedRows.length ? [{ label: `Selecionados: ${selectedRows.length} ${selectedRows.length === 1 ? 'cadastro' : 'cadastros'}`, onRemove: () => setSelected(new Set()) }] : []),
  ];
  // The server omits the sum for a user without the totals (Preferências "Exibir totais em listas"); the page read agrees with it.
  const totalsVisible = (props.preferences?.totalsVisible ?? true) && (page?.total_amount !== null || Boolean(page?.origin_totals));
  const dateLabel = DATE_TYPES[kind].find(type => type.value === filters.dateType)?.label ?? DATE_TYPES[kind][0]!.label;
  const periodText = filters.from || filters.to ? `${dateLabel}: ${brDay(filters.from || null) || '…'} até ${brDay(filters.to || null) || '…'}` : `${dateLabel}: todo o período`;
  const clearSearch = () => { setDraft(previous => ({ ...previous, query: '' })); if (filters.query) apply({ ...filters, query: '' }); };
  const listToolTitle = (label: string) => loading || !page ? 'Aguarde o carregamento da listagem.' : listBusy ? 'Aguarde a leitura da listagem.' : !page.total_count ? 'Nenhum registro no filtro aplicado.' : label;
  const listToolDisabled = loading || !page || Boolean(listBusy) || !page.total_count;
  const seller = role === 'vendas';
  const textFilter = (field: (typeof TEXT_FILTERS)[DocumentKind][number]) => <div className="form-field" key={field.key}><label htmlFor={`documents-filter-${field.key}`}>{field.label}</label><input id={`documents-filter-${field.key}`} maxLength={field.max} inputMode={field.key === 'postalCode' ? 'numeric' : undefined} value={draft[field.key]} onChange={event => { const value = event.target.value; setDraft(previous => ({ ...previous, [field.key]: value })); }} /></div>;
  const sortHeader = (column: 'date' | 'number', label: string) => <th key={column} aria-sort={orderColumn(order) === column ? order.endsWith('desc') ? 'descending' : 'ascending' : undefined}>
    <button type="button" className="documents-sort" title={`Ordenar por ${label.toLowerCase()}`} disabled={loading} onClick={() => props.onOrder(nextOrder(column, order))}>{label}{orderColumn(order) === column && <Icon name={order.endsWith('desc') ? 'arrow-down' : 'arrow-up'} size={9} />}</button></th>;
  const contactHeader = kind === 'purchase_orders' ? 'Fornecedor' : 'Cliente';
  const custom = kind === 'sales_orders' && Boolean(listView?.custom_view), customColumns = custom ? listView!.columns : [];
  // The description may have line breaks; as a reason (single line) they become spaces, as in the server.
  const statusPlan = dialog?.type === 'batch-status' ? statusBatchPlan(kind, dialog.rows, batchTarget, occurrenceKind ? batchReason.replace(/[\r\n\t]+/g, ' ') : batchReason, model, role) : null;
  const printPlan = dialog?.type === 'batch-print' ? planBatch(dialog.rows.map(row => ({ id: row.id, label: rowLabel(kind, row), row })), () => null) : null;
  const batchReasonNeeded = dialog?.type === 'batch-status' && Boolean(batchTarget) && dialog.rows.some(row => rowKey(row) !== batchTarget && reasonRequired(kind, rowKey(row), batchTarget, model));
  const dialogNote = (row: DocumentListRow, target: string) => transitionNote(model ? transitionActions(model, kind, rowKey(row), target) : []);
  const batchTitle = (label: string) => !selectedRows.length ? 'Selecione os documentos na listagem.' : locked ? 'Aguarde a conclusão da operação em andamento.' : label;

  return <form onSubmit={submit} aria-label="Filtros dos documentos">
    <NativeListLayout filters={<>
      <div className="form-field"><label htmlFor="documents-origin">Origem</label><select id="documents-origin" value={draft.origin ?? 'all'} onChange={event => setDraft(previous => ({ ...previous, origin: event.target.value === 'all' ? undefined : event.target.value as 'origin' | 'brufap' }))}><option value="all">Todas as origens</option><option value="origin">Origin · somente consulta</option><option value="brufap">FAGOO</option></select></div>
      {kind === 'sales_proposals' ? <div className="form-field"><label htmlFor="documents-proposal-status">Situação</label><select id="documents-proposal-status" value={proposalStatusOption(draft) ?? 'mixed'} onChange={event => { const option = PROPOSAL_STATUS_OPTIONS.find(item => item.value === event.target.value); if (option) setDraft(previous => ({ ...previous, statuses: [...option.statuses], template: option.template })); }}>{PROPOSAL_STATUS_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}{proposalStatusOption(draft) === null && <option value="mixed" disabled>Várias situações</option>}</select>
        {listView && <label htmlFor="documents-status-default" className="documents-status-default"><input id="documents-status-default" type="checkbox" checked={makeDefault} disabled={locked} onChange={event => setMakeDefault(event.target.checked)} />Tornar padrão</label>}</div>
      : kind === 'purchase_orders' ? <div className="form-field"><label htmlFor="documents-status-single">Situação</label><select id="documents-status-single" value={draft.statuses.length === 1 ? draft.statuses[0] : draft.statuses.length ? 'mixed' : ''} onChange={event => { const value = event.target.value; setDraft(previous => ({ ...previous, statuses: value ? [value] : [] })); }}><option value="">Todas</option>{(model ? filterSituations(model, draft.statuses).map(item => item.key) : [...PURCHASE_STATUS_OPTIONS]).map(value => <option key={value} value={value}>{statusLabel(kind, value, model)}</option>)}{!model && draft.statuses.length === 1 && !(PURCHASE_STATUS_OPTIONS as readonly string[]).includes(draft.statuses[0]!) && <option value={draft.statuses[0]}>{statusLabel(kind, draft.statuses[0]!)}</option>}{draft.statuses.length > 1 && <option value="mixed" disabled>Várias situações</option>}</select></div> :
      <fieldset className="documents-status-filter"><legend>Situação</legend>{(model ? filterSituations(model, draft.statuses).map(item => [item.key, item.name] as const) : Object.entries(STATES[kind])).map(([value, label]) => <label key={value} htmlFor={`documents-status-${value}`}><input id={`documents-status-${value}`} type="checkbox" checked={draft.statuses.includes(value)} onChange={event => { const checked = event.target.checked; setDraft(previous => ({ ...previous, statuses: checked ? [...previous.statuses.filter(item => item !== value), value] : previous.statuses.filter(item => item !== value) })); }} />{label}</label>)}
        {listView && <label htmlFor="documents-status-default" className="documents-status-default"><input id="documents-status-default" type="checkbox" checked={makeDefault} disabled={locked} onChange={event => setMakeDefault(event.target.checked)} />Tornar padrão</label>}</fieldset>}
      {(warehouses.length > 0 || draft.warehouse) && <div className="form-field"><label htmlFor="documents-warehouse">Depósito</label><select id="documents-warehouse" value={draft.warehouse?.id ?? ''} onChange={event => { const found = warehouses.find(item => item.id === event.target.value); setDraft(previous => ({ ...previous, warehouse: found ? { id: found.id, name: found.name } : event.target.value && previous.warehouse?.id === event.target.value ? previous.warehouse : null })); }}><option value="">Todos os depósitos</option>{draft.warehouse && !warehouses.some(item => item.id === draft.warehouse!.id) && <option value={draft.warehouse.id}>{draft.warehouse.name}</option>}{warehouses.map(item => <option key={item.id} value={item.id}>{item.name}{item.active ? '' : ' (inativo)'}</option>)}</select></div>}
      {/* Origin pedidos de compra: one autocomplete for the product (the other lists keep search + choice). */}
      {kind === 'purchase_orders' && (catalogRead.includes('products') || draft.product) && <div className="documents-product-filter"><CatalogPicker controller={controller} entity="products" label="Produto" selected={draft.product} onSelect={found => setDraft(previous => ({ ...previous, product: found ? { id: found.id, name: found.name } : null }))} /></div>}
      {/* 202610200268: Origin "Peça" and "Serviço" of the ordens de serviço (autocomplete of the produtos P and of the serviços S). */}
      {kind === 'service_orders' && (catalogRead.includes('products') || draft.product || draft.service) && <>
        <div className="documents-product-filter"><CatalogPicker controller={controller} entity="products" label="Peça" productKind="P" placeholder="Digite parte do nome ou código da peça" selected={draft.product} onSelect={found => setDraft(previous => ({ ...previous, product: found ? { id: found.id, name: found.name } : null }))} /></div>
        <div className="documents-product-filter"><CatalogPicker controller={controller} entity="products" label="Serviço" productKind="S" placeholder="Digite parte do nome ou código do serviço" selected={draft.service ?? null} onSelect={found => setDraft(previous => ({ ...previous, service: found ? { id: found.id, name: found.name } : null }))} /></div></>}
      {kind !== 'purchase_orders' && kind !== 'service_orders' && (catalogRead.includes('products') || draft.product) && <div className="form-field documents-product-filter"><label htmlFor="documents-product-search">Produto</label>
        {draft.product ? <span className="documents-picked"><span>{draft.product.name}</span><button type="button" className="text-button" onClick={() => setDraft(previous => ({ ...previous, product: null }))}>Trocar</button></span>
          : <><input id="documents-product-search" type="search" maxLength={120} placeholder="Pesquise por código ou descrição" value={productQuery} onChange={event => setProductQuery(event.target.value)} />
            <select id="documents-product" aria-label="Selecionar produto" value="" disabled={!products.length} onChange={event => { const found = products.find(item => item.id === event.target.value); if (found) { setDraft(previous => ({ ...previous, product: { id: found.id, name: found.name } })); setProductQuery(''); } }}><option value="">{productSearching ? 'Pesquisando…' : products.length ? 'Selecione o produto' : 'Digite ao menos 2 letras'}</option>{products.map(item => <option key={item.id} value={item.id}>{item.name}{item.code ? ` · ${item.code}` : ''}</option>)}</select></>}</div>}
      {/* 202610200238: Origin "Componente" of the pedidos de venda (a product of the pedido has it in its structure). */}
      {kind === 'sales_orders' && (catalogRead.includes('products') || draft.component) && <div className="documents-product-filter"><CatalogPicker controller={controller} entity="products" label="Componente" selected={draft.component ?? null} onSelect={found => setDraft(previous => ({ ...previous, component: found ? { id: found.id, name: found.name } : null }))} /></div>}
      {/* 202610200164: Origin "Vendedor" (autocomplete of Cadastros › Vendedores). */}
      {kind !== 'purchase_orders' && (catalogRead.includes('contacts') || draft.seller) && <DocumentSellerPicker controller={controller} id="documents-seller" label="Vendedor" selected={draft.seller} onSelect={found => setDraft(previous => ({ ...previous, seller: found ? { id: found.id, name: found.name } : null }))} />}
      {TEXT_FILTERS[kind].filter(field => !field.afterState).map(field => textFilter(field))}
      {STATE_FILTER[kind] && <div className="form-field"><label htmlFor="documents-state">UF</label><select id="documents-state" value={draft.state} onChange={event => { const value = event.target.value; setDraft(previous => ({ ...previous, state: value })); }}><option value="">UF</option>{DOCUMENT_LIST_UFS.map(uf => <option key={uf} value={uf}>{uf}</option>)}</select></div>}
      {TEXT_FILTERS[kind].filter(field => field.afterState).map(field => textFilter(field))}
      {LOT_FILTER[kind] && <div className="form-field"><label htmlFor="documents-filter-lots">Lote</label><input id="documents-filter-lots" maxLength={4000} placeholder="até 50 lotes separados por ;" value={draft.lots ?? ''} onChange={event => { const value = event.target.value; setDraft(previous => ({ ...previous, lots: value })); }} /></div>}
      <DocumentListSearch controller={controller} kind={kind} rows={draft.search ?? []} disabled={loading} onFields={fields => { searchFieldsRef.current = fields; }} onChange={rows => setDraft(previous => ({ ...previous, search: rows }))} />
      <button type="submit" className="primary-button" disabled={loading || !access?.read.includes(kind)}>Filtrar</button>
      {kind === 'purchase_orders' && <button type="button" className="secondary-button" disabled={loading || !access?.read.includes(kind)} onClick={() => { const next = { ...(access?.mirror_available && draft.origin !== 'brufap' ? EMPTY_LIST_FILTERS : defaultListFilters(kind, props.today)), origin: draft.origin }; setDraft(next); setProductQuery(''); apply(next); }}>Limpar filtros</button>}
    </>} actions={<>
      {selectedMirror && <p className="real-notice" role="note">A seleção contém documentos do Origin. {DOCUMENT_MIRROR_READ_ONLY}</p>}
      <div className="documents-panel-actions">
        <button type="button" className="origin-action" disabled={selectedMirror || !writable || !selectedRows.length || locked} title={selectedMirror ? DOCUMENT_MIRROR_READ_ONLY : writable ? batchTitle('Altera a situação de cada documento selecionado, um por vez') : 'Seu perfil permite apenas consultar.'} onClick={() => openBatch('batch-status')}><Icon name="circle-half-stroke" size={15} /><span>{PANEL[kind].status}</span></button>
        <button type="button" className="origin-action" disabled={!selectedRows.length || locked} title={batchTitle('Imprime a versão salva de cada documento selecionado')} onClick={() => openBatch('batch-print')}><Icon name={kind === 'service_orders' ? 'file-lines' : 'square-check'} size={15} /><span>{PANEL[kind].print}</span></button>
        {PANEL[kind].nfe && !seller && <button type="button" className="origin-action" disabled={selectedMirror || !ORDER_BATCH_ROLES.includes(role) || !selectedRows.length || locked} title={selectedMirror ? DOCUMENT_MIRROR_READ_ONLY : !ORDER_BATCH_ROLES.includes(role) ? 'As notas fiscais são geradas pelo administrador e pelo fiscal.' : batchTitle('Gera uma nota de homologação de cada pedido selecionado, como Gerar nota fiscal do menu ⋮')} onClick={() => setFiscalBatch('55')}><Icon name="file-invoice-dollar" size={15} /><span>{PANEL[kind].nfe}</span></button>}
        {kind === 'purchase_orders' && (Object.keys(PURCHASE_EFFECT_LABELS) as PurchaseEffectAction[]).map(action => <button key={action} type="button" className="origin-action" disabled={selectedMirror || !PURCHASE_EFFECT_ROLES[action].includes(role) || !selectedRows.length || locked}
          title={selectedMirror ? DOCUMENT_MIRROR_READ_ONLY : !PURCHASE_EFFECT_ROLES[action].includes(role) ? (action.startsWith('stock') ? 'O estoque é lançado pelo administrador e pelo estoque.' : 'As contas são lançadas pelo administrador e pelo financeiro.') : batchTitle(`${PURCHASE_EFFECT_LABELS[action]} de cada pedido selecionado, um por vez`)}
          onClick={() => { setActionError(''); setPurchaseBatch(action); }}><Icon name={action.startsWith('stock') ? 'boxes-stacked' : 'file-invoice-dollar'} size={15} /><span>{PURCHASE_EFFECT_LABELS[action]}</span></button>)}
        {kind === 'purchase_orders' && <button type="button" className="origin-action" disabled={loading || !page || Boolean(listBusy) || selectedRows.length > 0} title={selectedRows.length ? 'Disponível sem seleção.' : filters.origin === 'brufap' ? 'Exporta os pedidos FAGOO de um mês, com os itens, para XLSX.' : 'Exporta a lista filtrada em CSV com origem, sincronização e valores observados.'} onClick={() => { if (filters.origin !== 'brufap') { void readAll('export'); return; } const [year, month] = props.today.split('-'); setActionError(''); setMonthExport({ month: month!, year: year! }); }}><Icon name="file-excel" size={15} /><span>{filters.origin === 'brufap' ? 'Exportar para a planilha' : 'Exportar lista (CSV)'}</span></button>}
        {kind === 'sales_proposals' && writable && <div className="form-field documents-template-start"><label htmlFor="documents-template-start">Selecione o modelo</label><select id="documents-template-start" value="" disabled={locked || !models.length} onChange={event => { const model = event.target.value; if (model) guard.confirmLeave(() => props.onClone({ id: model })); }}><option value="">{models.length ? 'Selecione o modelo' : 'Nenhum modelo cadastrado'}</option>{models.map(model => <option key={model.id} value={model.id}>{model.template_name || 'Modelo ' + model.number}</option>)}</select></div>}
        {kind === 'sales_proposals' && <button type="button" className="origin-action" disabled={listToolDisabled} title={listToolTitle('Exporta todas as propostas do filtro aplicado para uma planilha (CSV)')} onClick={() => void readAll('export')}><Icon name="file-excel" size={15} /><span>{LIST_EXPORT_LABEL.sales_proposals}</span></button>}
      </div>
      {kind === 'sales_orders' && <div className="documents-more"><h3>Mais ações</h3>
        <h4>Gerar</h4><button type="button" className="origin-action" disabled={selectedMirror || !selectedRows.length || locked} title={selectedMirror ? DOCUMENT_MIRROR_READ_ONLY : batchTitle('Comprovante não fiscal da versão salva de cada pedido selecionado')} onClick={() => openBatch('batch-print', true)}><Icon name="receipt" size={15} /><span>Comprovantes selecionados</span></button>
        <button type="button" className="origin-action" disabled={selectedMirror || !ORDER_BATCH_ROLES.includes(role) || !selectedRows.length || locked} title={selectedMirror ? DOCUMENT_MIRROR_READ_ONLY : !ORDER_BATCH_ROLES.includes(role) ? 'As notas fiscais são geradas pelo administrador e pelo fiscal.' : batchTitle('Gera uma NFC-e de homologação de cada pedido selecionado')} onClick={() => setFiscalBatch('65')}><Icon name="receipt" size={15} /><span>NFC-es selecionadas</span></button>
        <h4>Exportar</h4><button type="button" className="origin-action" disabled={listToolDisabled} title={listToolTitle('Exporta todos os pedidos do filtro aplicado para uma planilha (CSV)')} onClick={() => void readAll('export')}><Icon name="file-excel" size={15} /><span>{LIST_EXPORT_LABEL.sales_orders}</span></button>
        <button type="button" className="origin-action" disabled={!selectedRows.length} title={selectedRows.length ? 'Exporta nome e endereço (de entrega ou do contato) dos pedidos selecionados (CSV)' : 'Selecione os pedidos na listagem.'} onClick={exportAddresses}><Icon name="file-export" size={15} /><span>Endereços selecionados</span></button>
        <h4>Imprimir</h4><button type="button" className="origin-action" disabled={selectedMirror || !selectedRows.length} title={selectedMirror ? DOCUMENT_MIRROR_READ_ONLY : selectedRows.length ? 'Etiquetas de endereçamento A4 dos pedidos selecionados' : 'Selecione os pedidos na listagem.'} onClick={() => setLabels(addressLabels(kind, selectedRows))}><Icon name="tag" size={15} /><span>Etiquetas selecionadas</span></button>
        <h4>Importar</h4><button type="button" className="origin-action" disabled={!xmlAllowed || locked} title={xmlAllowed ? 'Monta um pedido a partir do XML de uma NF-e autorizada, para conferir e salvar' : 'Seu perfil permite apenas consultar.'} onClick={() => setXmlOpen(true)}><Icon name="file-import" size={15} /><span>Pedido XML</span></button>
        {/* Financeiro > Faturamento agrupado (SQL 174): the pedidos selecionados, grouped by cliente. */}
        <h4>Outras</h4><button type="button" className="origin-action" disabled={selectedMirror || !['admin', 'financeiro'].includes(role ?? '') || !selectedRows.length || selectedRows.length > 200 || !props.onNavigate} title={selectedMirror ? DOCUMENT_MIRROR_READ_ONLY : !['admin', 'financeiro'].includes(role ?? '') ? 'O faturamento agrupado é feito pelo Financeiro.' : selectedRows.length > 200 ? 'Selecione até 200 pedidos.' : selectedRows.length ? 'Agrupa os pedidos selecionados por cliente no Faturamento agrupado' : 'Selecione os pedidos na listagem.'}
          onClick={() => guard.confirmLeave(() => props.onNavigate('/financeiro-empresa?' + new URLSearchParams({ area: 'faturamento-agrupado', pedidos: selectedRows.map(row => row.id).join(',') })))}><Icon name="file-invoice-dollar" size={15} /><span>Faturar pedidos selecionados</span></button></div>}
      {kind === 'service_orders' && <div className="documents-more"><h3>Mais ações</h3>
        <h4>Imprimir</h4><button type="button" className="origin-action" disabled={selectedMirror || !selectedRows.length || labelReading} title={selectedMirror ? DOCUMENT_MIRROR_READ_ONLY : selectedRows.length ? 'Etiquetas de identificação das ordens de serviço selecionadas' : 'Selecione as ordens de serviço na listagem.'} onClick={() => void printServiceLabels(selectedRows)}><Icon name="tag" size={15} /><span>{labelReading ? 'Lendo as ordens…' : 'Etiquetas selecionadas'}</span></button>
        {/* Notas lane: Origin "Gerar nota fiscal agrupando", one NF-e with the parts of several OS of the same cliente (homologação). */}
        {(() => { const reason = selectedMirror ? DOCUMENT_MIRROR_READ_ONLY : groupedInvoiceReason(role, selectedNativeRows);
          return <><h4>Gerar</h4><button type="button" className="origin-action" disabled={Boolean(reason) || locked} title={reason ?? 'Abre em nova aba uma nota com as peças das ordens de serviço selecionadas, para conferir e salvar'}
            onClick={() => window.open(`/historico-fiscal?${new URLSearchParams({ modelo: '55', origem: 'brufap', nota: 'nova', pedido: selectedRows.map(r => r.id).join(',') })}`, '_blank', 'noopener')}><Icon name="file-invoice-dollar" size={15} /><span>Gerar nota fiscal agrupando</span></button></>; })()}</div>}
      {kind === 'purchase_orders' && <div className="documents-more"><h3>Mais ações</h3>
        <h4>Imprimir</h4><button type="button" className="origin-action" disabled={selectedMirror || !selectedRows.length || labelReading} title={selectedMirror ? DOCUMENT_MIRROR_READ_ONLY : selectedRows.length ? 'Etiquetas dos produtos dos pedidos de compra selecionados' : 'Selecione os pedidos na listagem.'} onClick={() => void printProductLabels(selectedRows)}><Icon name="note-sticky" size={15} /><span>{labelReading ? 'Lendo os pedidos…' : 'Imprimir etiquetas'}</span></button></div>}
      {kind === 'purchase_orders' && selectedRows.length > 0 ? <div className="native-list-summary"><h3>Informações</h3>{selectedMirror ? <DocumentOriginTotals totals={documentSelectionTotals(selectedRows)} /> : <dl className="native-list-stat"><dt>Valor</dt><dd>{decimalMoney(selectedTotal(selectedRows))}</dd></dl>}<dl className="native-list-stat"><dt>Selecionados</dt><dd>{selectedRows.length.toLocaleString('pt-BR')}</dd></dl><p className="real-help">Informações baseadas nos registros selecionados.</p></div>
        : <div className="native-list-summary"><h3>Informações</h3><dl className="native-list-stat"><dt>{listCountLabel(kind)}</dt><dd>{page ? page.total_count.toLocaleString('pt-BR') : '—'}</dd></dl>{totalsVisible && (page?.origin_totals ? <DocumentOriginTotals totals={page.origin_totals} /> : <dl className="native-list-stat"><dt>Valor total</dt><dd>{decimalMoney(page?.total_amount ?? null)}</dd></dl>)}<p className="real-help">Informações baseadas nos filtros aplicados.</p></div>}
      <p className="real-help">{model ? 'Salvar não lança estoque, contas ou nota fiscal. Mudar a situação só lança ou estorna estoque e contas quando a transição tiver essas ações no Gerenciador de transições.' : 'Salvar ou mudar a situação não lança estoque, financeiro ou nota fiscal automaticamente.'}</p>
      {(() => { // Origin "Ferramentas de apoio": the Preferências page of this kind (when the profile reads it) and its reports.
        const prefs = preferencePage(DOCUMENT_PREFERENCE_PAGES[kind]), canPrefs = Boolean(prefs && role && (prefs.readRoles as readonly string[]).includes(role)), reportsAt = (kind === 'sales_orders' || kind === 'service_orders') && props.onNavigate;
        const noun = { sales_orders: 'pedidos de venda', sales_proposals: 'propostas comerciais', service_orders: 'ordens de serviço', purchase_orders: 'pedidos de compra' }[kind];
        return (canPrefs || reportsAt) && <div className="documents-more document-reports-links"><h3>Ferramentas de apoio</h3>
          {reportsAt && <button type="button" className="text-button" onClick={() => guard.confirmLeave(() => props.onNavigate('/documentos-empresa?' + new URLSearchParams({ tipo: kind, acao: 'relatorios' })))}>{kind === 'sales_orders' ? 'Ver relatórios de vendas' : 'Relatórios de serviço'}</button>}
          {canPrefs && <button type="button" className="text-button" onClick={() => guard.confirmLeave(() => props.onNavigate(preferencePageHref(prefs!)))}>{'Acesse os parâmetros de ' + noun}</button>}</div>;
      })()}
    </>}>
      <p className="real-help">Origem Origin: consulta dos valores e situações observados. Origem FAGOO: documentos nativos.</p>
      <div className="native-list-type"><label htmlFor="documents-kind">Documento</label><select id="documents-kind" value={kind} disabled={!access?.read.length} onChange={event => { const value = event.target.value as DocumentKind; guard.confirmLeave(() => props.onKind(value)); }}>{access?.read.map(value => <option value={value} key={value}>{DOCUMENT_LABELS[value]}</option>)}</select></div>
      <div className="native-list-toolbar documents-toolbar"><div className="form-field"><label htmlFor="documents-search">Pesquisar documentos</label><input id="documents-search" type="search" maxLength={120} value={draft.query} placeholder={SEARCH_HINTS[kind]} onChange={event => { const value = event.target.value; setDraft(previous => ({ ...previous, query: value })); }} />{draft.query && <button type="button" className="documents-search-clear" title="Limpar o campo" aria-label="Limpar o campo" disabled={loading} onClick={clearSearch}><Icon name="xmark" size={11} /></button>}</div><button type="submit" className="secondary-button" aria-label="Pesquisar documentos" title="Pesquisar" disabled={loading || !access?.read.includes(kind)}><Icon name="search" size={16} /></button>
        <PeriodPicker key={`${kind}:${filters.dateType}`} from={filters.from} to={filters.to} today={props.today} dateType={dateLabel} dateTypes={DATE_TYPES[kind].map(type => type.label)} prefixLabel={PERIOD_PREFIX[kind] || filters.dateType !== 'date'} iconOnly={kind === 'service_orders'} onApply={range => apply({ ...filters, from: range.from, to: range.to, dateType: DATE_TYPES[kind].find(type => type.label === range.dateType)?.value ?? 'date' })} />
        {LIST_PRINT_LABEL[kind] && <span className="origin-toolbar-tools"><ToolButton icon="print" title={listBusy === 'print' ? 'Lendo a listagem…' : LIST_PRINT_LABEL[kind]!} disabled={listToolDisabled} onClick={() => void readAll('print')} /></span>}
        <span className="origin-toolbar-tools"><ToolButton icon={inTrash ? 'rotate-left' : 'trash-can'} title={selectedMirror ? DOCUMENT_MIRROR_READ_ONLY : inTrash ? 'Restaurar selecionados' : 'Excluir selecionados (vão para a lixeira)'} disabled={selectedMirror || !selectedRows.length || busy} onClick={() => setTrashAction(inTrash ? 'restore' : 'delete')} />
          <ToolButton icon={inTrash ? "list" : "trash-alt"} title={inTrash ? 'Sair da lixeira' : 'Excluídos (lixeira)'} disabled={busy} onClick={() => { setSelected(new Set()); apply(inTrash ? EMPTY_LIST_FILTERS : { ...EMPTY_LIST_FILTERS, statuses: [TRASH_STATUS] }); }} /></span></div>
      <AppliedChips chips={chips} onClear={() => apply({ ...EMPTY_LIST_FILTERS, from: filters.from, to: filters.to, dateType: filters.dateType })} />
      {listBusy && <p className="real-help" role="status">{listBusy === 'print' ? 'Lendo todas as páginas da listagem para impressão…' : 'Lendo todas as páginas da listagem para a planilha…'}</p>}
      {props.filterError && <p className="real-alert" role="alert">{props.filterError}</p>}
      {actionNotice && <p className="real-success" role="status">{actionNotice}</p>}
      {actionError && <p className="real-alert" role="alert">{actionError}{uncertain && <button type="button" className="text-button" disabled={busy} onClick={() => void execute()}>{busy ? 'Conferindo…' : 'Conferir resultado'}</button>}</p>}
      <div className="documents-list-controls"><input type="checkbox" id="documents-select-all" aria-label="Selecionar todos" title="Selecionar todos" checked={allSelected} disabled={!rows.length} onChange={togglePage} /><button type="button" className="origin-refresh" title="Recarregar" aria-label="Recarregar" disabled={loading || !access?.read.includes(kind)} onClick={props.onReload}><Icon name="rotate-right" size={12} /></button>
        {kind === 'sales_orders' && listView && <span className="origin-views documents-views"><ViewToggle active={listView.custom_view ? 'customizada' : 'padrao'} onChange={mode => { if (locked) return; if (mode === 'customizada') { setActionError(''); setColumnsOpen(true); } else if (listView.custom_view) saveView({ custom_view: false }, 'Listagem padrão aplicada.'); }} /></span>}
        <div className="real-result-status" role="status">{loading ? 'Carregando documentos…' : page ? `${total.toLocaleString('pt-BR')} ${total === 1 ? 'documento encontrado' : 'documentos encontrados'}${selectedRows.length ? ` · ${selectedRows.length} ${selectedRows.length === 1 ? 'selecionado' : 'selecionados'}` : ''}` : access && !access.read.length ? 'Nenhum tipo de documento liberado para seu perfil.' : ''}</div></div>
      {/* EST-029 Origin pedidos de compra: one scroll with a fixed header; reaching the end reads the next page (no pagination). */}
      {page && rows.length > 0 && <div className={kind === 'purchase_orders' ? 'table-scroll documents-single-scroll' : 'table-scroll'} tabIndex={0} aria-label="Documentos da empresa"
        onScroll={kind === 'purchase_orders' ? event => { const box = event.currentTarget; if (!loading && rows.length < total && box.scrollTop + box.clientHeight >= box.scrollHeight - 120) props.onPage(listPage + 1); } : undefined}><table className="data-table real-table documents-table origin-table"><thead><tr><th className="checkbox-cell"><span className="sr-only">Seleção</span></th>{sortHeader('number', 'Número')}{custom ? customColumns.map(column => column === 'date' ? sortHeader('date', 'Data') : <th key={column} className={column === 'total' ? 'numeric' : undefined}>{COLUMN_LABELS[column]}</th>) : <>{sortHeader('date', 'Data')}
        {kind === 'sales_proposals' && <th>Próx. Contato</th>}{kind === 'service_orders' && <th>Data prevista</th>}<th>{contactHeader}</th>{kind === 'purchase_orders' && <th className="documents-note">Observação interna</th>}<th className="numeric">{TOTAL_HEADERS[kind]}</th></>}<th>Situação</th>{kind === 'purchase_orders' && <th>Vinculação</th>}<th><span className="sr-only">Indicadores</span></th><th className="row-actions"><span className="sr-only">Ações</span></th></tr></thead>
        <tbody>{rows.map(row => <tr key={row.id} className={`documents-row${selected.has(row.id) ? ' selected' : ''}`} onClick={event => open(row.id, event)} onAuxClick={event => { if (event.button === 1) open(row.id, event); }}>
          <td className="checkbox-cell" onClick={event => event.stopPropagation?.()}><input type="checkbox" aria-label={`Selecionar ${rowLabel(kind, row)}`} checked={selected.has(row.id)} onClick={event => toggleRow(row.id, Boolean(event.shiftKey))} onChange={() => undefined} /></td>
          <td><button type="button" className="text-button" onClick={event => { event.stopPropagation?.(); open(row.id, event); }}>{row.version_label ?? row.number ?? 'Não informado'}</button><small className="documents-origin">{documentOriginLabel(row)}{isDocumentMirror(row) ? ' · Somente consulta' : ''}</small>{isDocumentMirror(row) && <small className="documents-origin" title={DOCUMENT_MIRROR_READ_ONLY}>ID {row.mirror?.source_id} · Observado em {documentObservedAt(row.mirror?.observed_at)}</small>}</td>
          {custom ? customColumns.map(column => <td key={column} className={column === 'total' ? 'numeric' : column === 'address' ? 'documents-note' : undefined} title={column === 'address' ? row.address ?? undefined : undefined}>{column === 'total' ? isDocumentMirror(row) ? mirrorDecimal(row.total, true) : decimalMoney(row.total) : <>{columnText(column, row)}{column === 'date' && row.expected_date && <small className="documents-expected"> (prevista até: {brDay(row.expected_date)})</small>}</>}</td>) : <>
          <td>{brDay(row.date) || 'Não informada'}{kind === 'sales_orders' && row.expected_date && <small className="documents-expected"> (prevista até: {brDay(row.expected_date)})</small>}</td>
          {kind === 'sales_proposals' && <td>{brDay(row.next_contact)}</td>}{kind === 'service_orders' && <td>{brDay(row.expected_date)}</td>}
          <td>{row.contact_name ?? 'Não informado'}</td>{kind === 'purchase_orders' && <td className="documents-note" title={row.internal_notes ?? undefined}>{row.internal_notes ?? ''}</td>}
          <td className="numeric">{isDocumentMirror(row) ? mirrorDecimal(row.total, true) : decimalMoney(row.total)}</td></>}
          <td><button type="button" className="documents-occurrence-clock" disabled={isDocumentMirror(row)} title={isDocumentMirror(row) ? DOCUMENT_MIRROR_READ_ONLY : "Visualizar ocorrências"} aria-label={`Visualizar ocorrências de ${rowLabel(kind, row)}`} onClick={event => { event.stopPropagation?.(); setActionError(''); setDialog({ type: 'occurrences', row }); }}><Icon name="clock" size={12} /></button><>{isDocumentMirror(row) ? <span className="status-badge">{row.mirror?.source_status_label ?? row.mirror?.source_status ?? 'Não informada'}</span> : <DocumentStatusBadge kind={kind} status={row.status} situation={row.situation ?? null} />}</>{row.template && <span className="origin-tag documents-template">Modelo</span>}</td>
          {kind === 'purchase_orders' && <td>{linkStates[row.id] && <span className={`status-badge ${LINK_STATE_BADGES[linkStates[row.id]!].tone}`} title={LINK_STATE_BADGES[linkStates[row.id]!].title}>{LINK_STATE_BADGES[linkStates[row.id]!].label}</span>}</td>}
          <td><span className="origin-indicators">{listIndicators(row).filter(item => kind !== 'purchase_orders' || item.key !== 'OBS').map(item => item.badge ? <span key={item.key} className={`origin-tag ${item.className ?? ''}`} title={item.title}>{item.badge}</span> : item.letter ? <IndicatorLetter key={item.key} text={item.letter.text} color={item.letter.color} title={item.title} /> : <span key={item.key} className={item.className} title={item.title} role="img" aria-label={item.key === 'OBS' ? `Observação interna: ${item.title}` : item.title}><Icon name={item.icon!} size={13} /></span>)}</span></td>
          <td className="row-actions" onClick={event => event.stopPropagation?.()}><RowMenu label={rowLabel(kind, row)} items={menuItems(row)} open={menu === row.id} onToggle={() => setMenu(value => value === row.id ? null : row.id)} /></td>
        </tr>)}</tbody></table></div>}
      {page && !rows.length && (kind === 'sales_orders' && !page.total_count && (noFilters(filters) || (onlyStatuses(filters) && emptyCompany?.page === page && emptyCompany.empty)) ? <div className="empty-state documents-welcome"><h2>Registre suas vendas facilmente no FAGOO.</h2>
        <div className="documents-welcome-cards"><section><h3>Registrar vendas manualmente</h3><p>Inclua pedidos de venda com cliente, itens, pagamento e transporte.</p><button type="button" className="primary-button" disabled={!writable || !props.onCreate} title={writable ? 'Incluir novo pedido' : 'Seu perfil permite apenas consultar.'} onClick={() => props.onCreate?.()}>Nova venda</button></section>
          <section><h3>Registrar vendas físicas</h3><p>Venda de balcão com recebimento no caixa.</p><button type="button" className="secondary-button" disabled={!writable} title={writable ? 'Abre a Frente de caixa (venda de balcão).' : 'Seu perfil permite apenas consultar.'} onClick={() => props.onNavigate('/frente-caixa-empresa')}>Nova venda física</button></section></div></div>
        : kind === 'purchase_orders' ? <div className="empty-state documents-empty-search"><Icon name="circle-xmark" size={28} /><h2>Nenhum resultado encontrado.</h2><p>Verifique se as palavras estão corretas ou busque por outros termos.</p></div>
        : <div className="empty-state"><h2>Nenhum documento encontrado</h2><p>{writable ? 'Inclua um documento ou ajuste os filtros.' : 'Aguarde o registro pela equipe autorizada ou ajuste os filtros.'}</p></div>)}
      {page && total > 0 && kind !== 'purchase_orders' && <OriginPagination page={listPage} pages={pageCount(total)} size={DOCUMENT_LIST_PAGE_SIZE} total={total} onPage={value => { if (!loading && value !== listPage) props.onPage(value); }} />}
      {page && total > 0 && kind === 'purchase_orders' && <p className="real-help documents-scroll-status" role="status">{loading ? 'Carregando mais registros…' : `${rows.length.toLocaleString('pt-BR')} de ${total.toLocaleString('pt-BR')} registro(s)${rows.length < total ? ' · role a listagem para ver os próximos' : ''}`}</p>}
    </NativeListLayout>
    {dialog?.type === 'reason' && <Modal title={`Alterar situação · ${rowLabel(kind, dialog.row)}`} onClose={() => { if (!busy) setDialog(null); }} actions={<><button type="button" className="secondary-button" disabled={busy} onClick={() => setDialog(null)}>Cancelar</button>{uncertain ? <button type="button" className="primary-button" disabled={busy} onClick={() => void execute()}>{busy ? 'Conferindo…' : 'Conferir resultado'}</button> : <button type="button" className="primary-button" disabled={locked || !validReason(reason)} onClick={() => changeStatus(dialog.row, dialog.target, reason.trim())}>{busy ? 'Alterando…' : 'Alterar situação'}</button>}</>}>
      <p>{statusLabel(kind, rowKey(dialog.row), model)} → <strong>{statusLabel(kind, dialog.target, model)}</strong> · versão {dialog.row.version}</p>
      <div className="form-field"><label htmlFor="documents-status-reason">Motivo (obrigatório ao cancelar ou reabrir)</label><input id="documents-status-reason" maxLength={1000} value={reason} disabled={locked} onChange={event => setReason(event.target.value)} /></div>
      <p className="real-help">{model ? dialogNote(dialog.row, dialog.target) : 'A mudança de situação é registrada com o motivo. Estoque, contas e nota fiscal não são lançados por esta ação.'}</p>
      {actionError && <p className="real-alert" role="alert">{actionError}</p>}
    </Modal>}
    {dialog?.type === 'situation' && <Modal title={`Alterando situação para ${statusLabel(kind, dialog.target, model)}`} onClose={() => { if (!busy) setDialog(null); }} actions={<><button type="button" className="secondary-button" disabled={busy} onClick={() => setDialog(null)}>Cancelar</button>{uncertain ? <button type="button" className="primary-button" disabled={busy} onClick={() => void execute()}>{busy ? 'Conferindo…' : 'Conferir resultado'}</button> : <button type="button" className="primary-button" disabled={locked} onClick={() => changeSituation(dialog.row, dialog.target)}>{busy ? 'Alterando…' : 'Alterar situação'}</button>}</>}>
      <p>{rowLabel(kind, dialog.row)} · {statusLabel(kind, rowKey(dialog.row), model)} → <strong>{statusLabel(kind, dialog.target, model)}</strong></p>
      <div className="document-grid"><div className="form-field"><label htmlFor="documents-situation-date">Data</label><input id="documents-situation-date" type="date" value={situation.date} disabled={locked} readOnly={dateLocked} title={dateLocked ? DATE_LOCKED : undefined} onChange={event => { if (dateLocked) return; const value = event.target.value; setSituation(previous => ({ ...previous, date: value })); }} /></div>
        <div className="form-field"><label htmlFor="documents-situation-time">Hora</label><input id="documents-situation-time" type="time" value={situation.time} disabled={locked} readOnly={dateLocked} title={dateLocked ? DATE_LOCKED : undefined} onChange={event => { if (dateLocked) return; const value = event.target.value; setSituation(previous => ({ ...previous, time: value })); }} /></div></div>
      <div className="form-field"><label htmlFor="documents-situation-text">{reasonRequired(kind, rowKey(dialog.row), dialog.target, model) ? 'Descrição da ocorrência (obrigatória: é o motivo desta mudança)' : 'Descrição da ocorrência'}</label><textarea id="documents-situation-text" rows={2} maxLength={1000} value={situation.text} disabled={locked} onChange={event => { const value = event.target.value; setSituation(previous => ({ ...previous, text: value })); }} /></div>
      <p className="real-help">{dialogNote(dialog.row, dialog.target)}</p>
      {actionError && <p className="real-alert" role="alert">{actionError}</p>}
    </Modal>}
    {dialog?.type === 'occurrences' && occurrenceKind && <DocumentOccurrences key={dialog.row.id} controller={controller} kind={occurrenceKind} documentId={dialog.row.id} writable={writable && !isDocumentMirror(dialog.row)} label={rowLabel(kind, dialog.row)}
      targets={key => writable && !isDocumentMirror(dialog.row) ? permittedTargets(kind, key, runnableTargets(model, kind, key, statusTargets(kind, rowAt(model, kind, dialog.row, key), model), role), access?.permissions) : []} reasonNeeded={(from, to) => reasonRequired(kind, from, to, model)} onClose={changed => { setDialog(null); if (changed) props.onReload(); }}
      situationLabel={key => statusLabel(kind, key, model)} transitionNote={(from, to) => model ? transitionNote(transitionActions(model, kind, from, to)) : null} />}
    {dialog?.type === 'sales-service' && <Modal title="Conferir criação da ordem de serviço" onClose={() => { if (!busy) setDialog(null); }} actions={<><button type="button" className="secondary-button" disabled={busy} onClick={() => setDialog(null)}>Voltar à listagem</button>{uncertain ? <button type="button" className="primary-button" disabled={busy} onClick={() => void execute()}>{busy ? 'Conferindo…' : 'Conferir resultado'}</button> : <button type="button" className="primary-button" disabled={locked} onClick={() => salesToService(dialog.row)}>Confirmar criação da OS</button>}</>}>
      <p>{rowLabel(kind, dialog.row)} · versão {dialog.row.version} · Total {decimalMoney(dialog.row.total)}</p>
      <p>A ordem de serviço será criada em Em aberto com o cliente, os itens, os valores e as condições deste pedido. O pedido continua na situação atual e registra a ocorrência.</p>
      <p className="real-help">Cada pedido gera uma única ordem de serviço, e só enquanto não tem nota fiscal. Esta ação não lança estoque, contas ou nota fiscal.</p>
      {actionError && <p className="real-alert" role="alert">{actionError}</p>}
    </Modal>}
    {dialog?.type === 'purchase-reverse' && <PurchaseStockReverse key={dialog.row.id} controller={controller} documentId={dialog.row.id} number={String(dialog.row.number)} version={dialog.row.version} onClose={changed => { setDialog(null); if (changed) props.onReload(); }} />}
    {dialog?.type === 'purchase-launch' && <PurchaseStockLaunch key={dialog.row.id} controller={controller} documentId={dialog.row.id} number={String(dialog.row.number)} onClose={changed => { setDialog(null); if (changed) props.onReload(); }} />}
    {dialog?.type === 'effect' && <DocumentEffectDialog key={`${dialog.row.id}:${dialog.effect}`} controller={controller} kind={kind} row={dialog.row} effect={dialog.effect} launchMode={access?.settings?.stock_launch_date ?? null} onClose={changed => { setDialog(null); if (changed) props.onReload(); }} onNavigate={props.onNavigate} />}
    {dialog?.type === 'batch-status' && statusPlan && <BatchDialog title={kind === 'sales_orders' ? 'Alteração de situação das vendas' : PANEL[kind].status} confirmLabel={kind === 'sales_orders' ? 'Ok' : 'Mudar situação'} plan={statusPlan} canConfirm={Boolean(batchTarget) && !batchStarted} run={runStatusItem} onClose={closeBatch}
      progressLabel={kind === 'sales_orders' ? (current, count) => `Alterando situações de vendas, ${current} de ${count}` : undefined}
      description={<div className="documents-batch-form"><div className="form-field"><label htmlFor="documents-batch-status">Nova situação</label><select id="documents-batch-status" value={batchTarget} disabled={batchStarted} onChange={event => setBatchTarget(event.target.value)}><option value="">Selecione a situação</option>{batchSituationTargets(model, kind).map(status => <option key={status} value={status}>{statusLabel(kind, status, model)}</option>)}</select></div>
        {occurrenceKind ? <div className="form-field"><label htmlFor="documents-batch-reason">{batchReasonNeeded ? 'Descrição da ocorrência (obrigatória ao cancelar ou reabrir)' : 'Descrição da ocorrência'}</label><textarea id="documents-batch-reason" rows={2} maxLength={1000} value={batchReason} disabled={batchStarted} onChange={event => setBatchReason(event.target.value)} /></div>
          : batchReasonNeeded && <div className="form-field"><label htmlFor="documents-batch-reason">Motivo (obrigatório ao cancelar ou reabrir)</label><input id="documents-batch-reason" maxLength={1000} value={batchReason} disabled={batchStarted} onChange={event => setBatchReason(event.target.value)} /></div>}
        <p className="real-help">Cada documento é alterado com a própria versão e um comando próprio. {model ? 'Se a transição de um documento tiver ações no Gerenciador de transições (lançar ou estornar estoque e contas), elas rodam na mesma mudança.' : 'Estoque, contas e nota fiscal não são lançados por esta ação.'}</p></div>} />}
    {purchaseBatch && kind === 'purchase_orders' && <PurchaseEffectsBatch key={purchaseBatch} controller={controller} action={purchaseBatch} rows={selectedRows} onClose={changed => { setPurchaseBatch(null); if (changed) { setSelected(new Set()); props.onReload(); } }} />}
    {trashAction && <DocumentTrashDialog controller={controller} kind={kind} action={trashAction} rows={selectedRows.map(r => ({ id: r.id, number: String(r.number) }))} onClose={changed => { setTrashAction(null); if (changed) { setSelected(new Set()); props.onReload(); } }} />}
    {partialInvoice && <PartialInvoiceDialog controller={controller} documentId={partialInvoice.id} number={partialInvoice.number} today={props.today} onClose={changed => { setPartialInvoice(null); if (changed) props.onReload(); }} />}
    {fiscalBatch && <FiscalOrderBatch controller={controller} model={fiscalBatch} rows={selectedNativeRows} today={props.today} onClose={changed => { setFiscalBatch(null); if (changed) { setSelected(new Set()); props.onReload(); } }} />}
    {dialog?.type === 'batch-print' && printPlan && <BatchDialog title={dialog.receipt ? 'Comprovantes selecionados' : PANEL[kind].print} confirmLabel="Preparar impressão" plan={printPlan} run={runPrintItem} onClose={closeBatch} description={<>
      {kind === 'purchase_orders' && <fieldset className="documents-print-options"><legend>Opções de impressão</legend>
        <div className="form-field"><label htmlFor="documents-print-order">Ordem dos itens</label><select id="documents-print-order" value={printOptions.order} onChange={event => { const order = event.target.value as PrintItemOrder; setPrintOptions(previous => ({ ...previous, order })); }}>{(Object.keys(PRINT_ORDER_LABELS) as PrintItemOrder[]).map(order => <option key={order} value={order}>{PRINT_ORDER_LABELS[order]}</option>)}</select></div></fieldset>}
      {kind === 'sales_orders' && !dialog.receipt && <fieldset className="documents-print-options"><legend>Opções de impressão</legend>
        <div className="form-field"><label htmlFor="documents-print-type">Tipo de impressão</label><select id="documents-print-type" value={printOptions.detailed ? 'detailed' : 'normal'} onChange={event => { const detailed = event.target.value === 'detailed'; setPrintOptions(previous => ({ ...previous, detailed })); }}><option value="normal">Normal</option><option value="detailed">Detalhada</option></select></div>
        <div className="form-field"><label htmlFor="documents-print-order">Ordem dos itens</label><select id="documents-print-order" value={printOptions.order} onChange={event => { const order = event.target.value as PrintItemOrder; setPrintOptions(previous => ({ ...previous, order })); }}>{(Object.keys(PRINT_ORDER_LABELS) as PrintItemOrder[]).map(order => <option key={order} value={order}>{PRINT_ORDER_LABELS[order]}</option>)}</select></div>
        <label className="document-check" htmlFor="documents-print-explode" title="Lista os componentes da estrutura (Estoque › composições) sob cada produto com composição."><input id="documents-print-explode" type="checkbox" checked={printOptions.explode} onChange={event => { const explode = event.target.checked; setPrintOptions(previous => ({ ...previous, explode })); }} />Desmembrar produtos da estrutura</label>
        <label className="document-check" htmlFor="documents-print-third" title="Não imprime os itens cujo produto tem Produção: Terceiros no cadastro (os totais do pedido continuam os mesmos)."><input id="documents-print-third" type="checkbox" checked={printOptions.hideThirdParty} onChange={event => { const hideThirdParty = event.target.checked; setPrintOptions(previous => ({ ...previous, hideThirdParty })); }} />Ocultar itens produzidos por terceiros</label></fieldset>}
      <p className="real-help">Lê a versão salva de cada documento selecionado. A prévia abre ao fechar este resumo.</p></>} />}
    {printRecord && (isMirrorRecord(printRecord.record) ? <DocumentMirrorPrint records={[printRecord.record]} onClose={() => setPrintRecord(null)} /> : <DocumentPrintPreview record={printRecord.record} variant={printRecord.variant} options={printRecord.options} controller={controller} onClose={() => setPrintRecord(null)} />)}
    {printQuestion && <CustomFieldsPrintQuestion onCancel={() => setPrintQuestion(null)} onPrint={include => { const asked = printQuestion; setPrintQuestion(null);
      setPrintRecord({ record: asked.record, variant: asked.variant, options: include ? { ...asked.options, customFields: asked.fields } : asked.options }); }} />}
    {printRecords && <DocumentBatchPrint records={printRecords.records} receipt={printRecords.receipt} options={printRecords.options} controller={controller} onClose={() => setPrintRecords(null)} />}
    {productLabels && <ProductLabels products={productLabels.products} initialQuantities={productLabels.quantities} onClose={() => setProductLabels(null)} />}
    {labels && <DocumentLabelsPrint labels={labels} onClose={() => setLabels(null)} {...(kind === 'service_orders' ? { heading: { noun: ['ordem de serviço', 'ordens de serviço'] as [string, string], note: 'Identificação do equipamento recebido: cliente, equipamento, número de série e entrada.' } } : {})} />}
    {xmlOpen && xmlAllowed && (kind === 'sales_orders' || kind === 'purchase_orders') && <DocumentXmlImport controller={controller} kind={kind} today={props.today} onClose={() => setXmlOpen(false)} onImported={draft => { setXmlOpen(false); guard.confirmLeave(() => props.onImported?.(draft)); }} />}
    {columnsOpen && listView && <DocumentColumnsDrawer available={listView.available_columns} selected={listView.columns} limit={listView.column_limit} busy={busy} uncertain={uncertain} error={actionError} onRetry={() => void execute()} onCancel={() => setColumnsOpen(false)} onApply={columns => saveView({ custom_view: true, columns }, 'Listagem customizada aplicada.')} />}
    {listPrint && <DocumentListPrint snapshot={listPrint.snapshot} filters={listPrint.filters} onClose={() => setListPrint(null)} />}
    {monthExport && <Modal title="Exportar para a planilha" onClose={() => { if (!listBusy) setMonthExport(null); }} actions={<><button type="button" className="secondary-button" disabled={Boolean(listBusy)} onClick={() => setMonthExport(null)}>Cancelar</button><button type="button" className="primary-button" disabled={Boolean(listBusy) || !/^(0[1-9]|1[0-2])$/.test(monthExport.month) || !/^(19|20)\d{2}$/.test(monthExport.year)} onClick={() => { const range = monthRange(monthExport.year, monthExport.month); void exportMonth(range); }}>{listBusy === 'export' ? 'Gerando…' : 'Download'}</button></>}>
      <div className="document-grid"><div className="form-field"><label htmlFor="documents-export-month">Mês</label><select id="documents-export-month" value={monthExport.month} onChange={event => { const month = event.target.value; setMonthExport(previous => previous && { ...previous, month }); }}>{Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, '0')).map(month => <option key={month} value={month}>{month}</option>)}</select></div>
        <div className="form-field"><label htmlFor="documents-export-year">Ano</label><input id="documents-export-year" inputMode="numeric" maxLength={4} value={monthExport.year} onChange={event => { const year = event.target.value.trim(); setMonthExport(previous => previous && { ...previous, year }); }} /></div></div>
      <p className="real-help">Pedidos de compra de origem FAGOO com data no mês escolhido, em qualquer situação: planilha XLSX com uma linha por item (os dados do pedido se repetem).</p>
      {actionError && <p className="real-alert" role="alert">{actionError}</p>}
    </Modal>}
  </form>;
}

/** Lançar/estornar estoque or contas from the ⋮ menu: the same reviewed components as the editor, in a dialog. */
export function DocumentEffectDialog({ controller, kind, row, effect, onClose, onNavigate, launchMode = null }: { controller: AccessController; kind: DocumentKind; row: DocumentListRow; effect: 'stock' | 'finance'; onClose: (changed: boolean) => void; onNavigate: (path: string) => void; launchMode?: 'data_atual' | 'data_documento' | null }) {
  const [record, setRecord] = useState<DocumentRecord | null>(null); const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [reload, setReload] = useState(0);
  const [mode, setMode] = useState<string | null>(null); const [, setTick] = useState(0);
  const parts = useRef<Record<string, { busy: boolean; draft: boolean }>>({}), latest = useRef(row.version), changed = useRef(false), refreshing = useRef<AbortController | null>(null);
  const report = (name: string, key: 'busy' | 'draft', value: boolean) => { const part = parts.current[name] ??= { busy: false, draft: false }; if (part[key] === value) return; part[key] = value; setTick(value => value + 1); };
  const busy = Object.values(parts.current).some(part => part.busy), draft = Object.values(parts.current).some(part => part.draft);
  const part = (name: string) => parts.current[name] ?? { busy: false, draft: false };
  const guard = useUnsavedChanges(draft, busy);
  const read = async (minimum: number, signal: AbortSignal) => {
    const response = await controller.documents(`/v1/documentos/${kind}/${row.id}`, { signal }) as DocumentEnvelope;
    const document = response?.document;
    if (!document || document.id !== row.id || document.kind !== kind || !Number.isInteger(document.version) || document.version < Math.max(minimum, latest.current)) throw new AccessError(502);
    return document;
  };
  useEffect(() => {
    const request = new AbortController(); setLoading(true); setError('');
    void read(row.version, request.signal).then(document => { if (!request.signal.aborted) { latest.current = document.version; setRecord(document); setLoading(false); } })
      .catch(failure => { if (!request.signal.aborted && !aborted(failure)) { setError(failureText(failure)); setLoading(false); } });
    return () => request.abort();
  }, [controller, kind, row.id, reload]);
  useEffect(() => () => refreshing.current?.abort(), []);
  // Children call this after their own confirmed command; the dialog only rereads the saved version.
  const refresh = async (version: number) => {
    if (refreshing.current) throw new AccessError(409);
    const request = new AbortController(); refreshing.current = request; changed.current = true;
    try { const document = await read(version, request.signal); if (request.signal.aborted) throw new DOMException('Request cancelled', 'AbortError'); latest.current = document.version; setRecord(document); }
    finally { if (refreshing.current === request) refreshing.current = null; }
  };
  const acceptFinance = (saved: DocumentRecord) => {
    if (refreshing.current || saved.id !== row.id || saved.kind !== kind || !Number.isInteger(saved.version) || saved.version < latest.current) throw new AccessError(502);
    changed.current = true; latest.current = saved.version; setRecord(saved);
  };
  const close = () => { if (busy || refreshing.current) return; guard.confirmLeave(() => onClose(changed.current)); };
  const openTitle = (titleId: string) => { if (busy || refreshing.current) return; let path: string; try { path = documentFinanceTitlePath(kind, titleId); } catch { return; } guard.confirmLeave(() => { onClose(changed.current); onNavigate(path); }); };
  const canAct = () => !refreshing.current;
  const role = roleOf(controller);
  const title = `${effect === 'stock' ? 'Estoque' : 'Contas'} · ${rowLabel(kind, row)}`;
  return <Modal title={title} onClose={close} actions={<button type="button" className="secondary-button" disabled={busy} onClick={close}>Fechar</button>}>
    <div className="documents-effect-dialog">
      {loading && <p role="status">Carregando documento…</p>}
      {error && <p className="real-alert" role="alert">{error}<button type="button" className="text-button" onClick={() => setReload(value => value + 1)}>Tentar novamente</button></p>}
      {record && effect === 'finance' && <DocumentFinance key={`${record.id}:${record.version}`} controller={controller} record={record} writable={role === 'admin' || role === 'financeiro'} blocked={loading} canAct={canAct} onChanged={acceptFinance} onActive={() => undefined} onBusy={value => report('finance', 'busy', value)} onDraft={value => report('finance', 'draft', value)} onOpenTitle={openTitle} />}
      {record && effect === 'stock' && kind === 'purchase_orders' && <PurchaseReceipts key={`${record.id}:${record.version}`} controller={controller} record={record} blocked={loading || part('stock').busy || part('stock').draft} canAct={canAct} onChanged={refresh} onMode={value => setMode(value)} onBusy={value => report('receipt', 'busy', value)} onDraft={value => report('receipt', 'draft', value)} />}
      {record && effect === 'stock' && (kind !== 'purchase_orders' || mode === 'legacy_full') && <DocumentStock key={`${record.id}:${record.version}`} controller={controller} record={record} launchDay={launchMode ? stockLaunchDay(launchMode, record, saoPauloNow().date) : undefined} blocked={loading || part('receipt').busy || part('receipt').draft || (kind === 'sales_orders' && row.reservation_active === true && !row.stock_active)} canAct={canAct} onChanged={async version => refresh(version)} onActive={() => undefined} onBusy={value => report('stock', 'busy', value)} onDraft={value => report('stock', 'draft', value)} />}
    </div>
  </Modal>;
}
