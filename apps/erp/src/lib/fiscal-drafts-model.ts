import type { NativeRequestOptions, AccessState } from './real-access';
import { STATES } from '../../../../packages/erp-domain/src/index.mjs';
import { isCanonicalUnitPrice } from '../../../../packages/erp-domain/src/unit-price.mjs';
import type { DocumentSummary } from './real-documents-model';

export interface FiscalDraftController {
  fiscalDraft(path: string, options?: NativeRequestOptions): Promise<unknown>;
  fiscalDraftStatus?(path: string, options?: NativeRequestOptions): Promise<unknown>;
  subscribe?(listener:()=>void):()=>void;
  fiscalItem?(path: string, options?: NativeRequestOptions): Promise<unknown>;
  fiscalCompletion?(path: string, options?: NativeRequestOptions): Promise<unknown>;
  fiscalTax?(path: string, options?: NativeRequestOptions): Promise<unknown>;
  getSnapshot?(): AccessState;
  fiscalUnsigned?(path: string, options?: NativeRequestOptions): Promise<unknown>;
  fiscalNumbering?(path: string, options?: NativeRequestOptions): Promise<unknown>;
  documents(path: string, options?: NativeRequestOptions): Promise<unknown>;
}
export type FiscalModel = '55' | '65';
export type FiscalStatus = 'draft' | 'archived';
export const FISCAL_MODEL_LABELS: Record<FiscalModel, string> = { '55': 'NF-e · modelo 55', '65': 'NFC-e · modelo 65' };
export const FISCAL_STATUS_LABELS: Record<FiscalStatus, string> = { draft: 'Em preparação', archived: 'Arquivado' };
export const FISCAL_PENDING_LABELS: Record<string, string> = {
  TAX_REVIEW_REQUIRED: 'Revisão tributária ainda necessária.',
  CATALOG_SNAPSHOTS_REQUIRE_REVIEW: 'Conferir os dados de cadastro preservados no pedido.',
  RECIPIENT_FISCAL_MAPPING_REQUIRED: 'Conferir o enquadramento fiscal do destinatário.',
  ITEM_FISCAL_MAPPING_REQUIRED: 'Definir os dados fiscais de cada item.',
  PAYMENT_FISCAL_MAPPING_REQUIRED: 'Conferir os meios de pagamento para o documento fiscal.',
  FISCAL_XML_NOT_BUILT: 'XML fiscal ainda não gerado.',
  XSD_NOT_VALIDATED: 'Validação do leiaute fiscal ainda não realizada.',
  SIGNATURE_NOT_CREATED: 'Assinatura digital ainda não realizada.',
  TRANSPORT_UNAVAILABLE: 'Transmissão à SEFAZ indisponível nesta etapa.',
  HOMOLOGATION_NOT_PERFORMED: 'Homologação da emissão ainda não realizada.',
  COMPANY_IDENTITY_MISSING: 'Identidade da empresa não informada.',
  COMPANY_STATE_OUTSIDE_PROFILE: 'UF da empresa fora do perfil de São Paulo previsto.',
  COMPANY_IE_MISSING: 'Inscrição estadual da empresa não informada.',
  REGIME_UNCONFIRMED: 'Regime tributário da empresa a confirmar.',
  OPERATION_NATURE_MISSING: 'Natureza da operação não informada.',
  RECIPIENT_DOCUMENT_MISSING: 'Documento do destinatário não informado.',
  RECIPIENT_ADDRESS_INCOMPLETE: 'Endereço do destinatário incompleto.',
  ITEM_WITHOUT_CATALOG_LINK: 'Há item sem produto cadastrado vinculado.',
  ITEM_KIND_REQUIRES_REVIEW: 'Há item que exige revisão de tipo ou composição.',
  ITEM_NCM_MISSING: 'Há produto sem NCM informado.',
  PAYMENT_PLAN_MISSING: 'Pedido sem plano de parcelas informado.',
  SOURCE_DOCUMENT_CHANGED: 'O pedido mudou desde esta cópia. Confira a versão atual.',
  COMPANY_CONFIGURATION_CHANGED: 'Os dados da empresa mudaram desde esta cópia.',
  SOURCE_DOCUMENT_CANCELLED: 'O pedido de origem está cancelado.',
  DRAFT_ARCHIVED: 'Este rascunho está arquivado e não pode ser editado.',
};
export interface FiscalPreparation { operation_nature: string | null; notes: string | null; }
export interface FiscalDraftSummary {
  id: string; model: FiscalModel; environment: '2'; status: FiscalStatus; version: number;
  source_document_id: string; source_document_version: number; created_at: string; updated_at: string;
  order_number: string; contact_name: string; total: string;
}
export interface FiscalContact {
  id: string; version: number; name: string; person_type: string | null; document: string | null; ie: string | null;
  postal_code: string | null; street: string | null; number: string | null; complement: string | null;
  district: string | null; city: string | null; state: string | null;
}
export interface FiscalProduct {
  id: string; version: number; name: string; code: string | null; unit: string | null;
  kind: string | null; format: string | null; ncm: string | null; gtin: string | null;
}
export interface FiscalItem {
  id: string; position: number; product_id: string | null; description: string; code: string | null; unit: string;
  quantity: string; unit_price: string; discount_percent: string; gross: string; discount: string; total: string; product: FiscalProduct | null;
}
export interface FiscalCompany {
  identity_version: number; fiscal_version: number | null; crt: string | null; regime_confirmed: boolean;
  identity: { legal_name: string; trade_name: string | null; cnpj: string; ie: string | null; postal_code: string;
    street: string; number: string; complement: string | null; district: string; city: string; municipality_code: string; state: string; };
}
export interface FiscalSnapshot {
  catalog_basis: 'document_snapshot'; document_id: string; document_version: number; kind: 'sales_orders'; number: string; status: string; date: string;
  contact_id: string; contact: FiscalContact; items: FiscalItem[]; discount_mode: string; discount_value: string;
  totals: Record<'gross' | 'line_discount' | 'subtotal' | 'discount' | 'freight' | 'other_expenses' | 'total', string> & { ipi?: string; icms_st?: string };
  installments: {position: number; due_date: string; amount: string; method: string | null}[];
  notes: string | null; payment_terms: string | null; delivery_terms: string | null; company: FiscalCompany | null;
  /** 202610200251: Total do IPI / Total ICMS ST of the pedido (documentos 196); legacy_taxes = both, in a copy made before 251. */
  tax_ipi?: string; tax_icms_st?: string; legacy_taxes?: string;
}
export interface FiscalDraftRecord extends Omit<FiscalDraftSummary, 'order_number' | 'contact_name' | 'total'> {
  snapshot: FiscalSnapshot; snapshot_hash: string; preparation: FiscalPreparation; archived_at: string | null; archive_reason: string | null;
}
export interface FiscalCurrent {
  version: number; status: FiscalStatus; source_document_version: number; source_status: string;
  identity_version: number | null; fiscal_version: number | null; source_changed: boolean; company_changed: boolean;
}
interface FiscalBase { data_mode: 'fiscal_draft'; emission_enabled: false; operational_effects: false; }
export interface FiscalDraftEnvelope extends FiscalBase { record: FiscalDraftRecord; current: FiscalCurrent; pending: string[]; }
export interface FiscalDraftPage extends FiscalBase { items: FiscalDraftSummary[]; limit: number; has_more: boolean; next_cursor: string | null; }
export interface FiscalRevisionPage extends FiscalBase { draft_id: string; items: FiscalDraftSummary[]; limit: number; has_more: boolean; next_cursor: number | null; }
export interface FiscalFilters { model: '' | FiscalModel; status: '' | FiscalStatus; }
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const DECIMAL = /^\d{1,14}(?:\.\d{1,6})?$/;
function fail(): never { throw new Error('Não foi possível conferir os dados do rascunho fiscal. Atualize a consulta.'); }
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const version = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0 && (v as number) <= 2147483647;
const text = (v: unknown, max = 4000): v is string => typeof v === 'string' && v.length <= max;
const nullableText = (v: unknown, max = 4000) => v === null || text(v, max);
const date = (v: unknown) => text(v, 10) && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00Z`));
const moment = (v: unknown) => text(v, 100) && Number.isFinite(Date.parse(v));
const decimal = (v: unknown) => text(v, 32) && DECIMAL.test(v);
function base(v: unknown): asserts v is Record<string, unknown> {
  if (!object(v) || v.data_mode !== 'fiscal_draft' || v.emission_enabled !== false || v.operational_effects !== false) fail();
}
function metadata(v: unknown): asserts v is Record<string, unknown> {
  if (!object(v) || !id(v.id) || !['55', '65'].includes(String(v.model)) || v.environment !== '2' || !['draft', 'archived'].includes(String(v.status))
    || !version(v.version) || !id(v.source_document_id) || !version(v.source_document_version) || !moment(v.created_at) || !moment(v.updated_at)) fail();
}
function summary(v: unknown): FiscalDraftSummary {
  metadata(v);
  if (!text(v.order_number, 10) || !/^[1-9]\d{0,9}$/.test(v.order_number) || !text(v.contact_name, 200) || !v.contact_name || !decimal(v.total)) fail();
  return v as unknown as FiscalDraftSummary;
}
export function fiscalListParams(filters: FiscalFilters, after: string | null = null): URLSearchParams {
  if ((filters.model && !['55', '65'].includes(filters.model)) || (filters.status && !['draft', 'archived'].includes(filters.status)) || (after && !id(after))) throw new Error('Confira os filtros da listagem.');
  const p = new URLSearchParams({ limit: '25' });
  if (filters.model) p.set('model', filters.model); if (filters.status) p.set('status', filters.status); if (after) p.set('after', after);
  return p;
}
export function fiscalModelSearch(search: string, model: '' | FiscalModel): string {
  const params = new URLSearchParams(search);
  if (model) params.set('modelo', model); else params.delete('modelo');
  return params.toString() ? `?${params}` : '';
}
export function fiscalDraftPage(value: unknown, filters: FiscalFilters): FiscalDraftPage {
  base(value);
  if (!Array.isArray(value.items) || value.items.length > 25 || value.limit !== 25 || typeof value.has_more !== 'boolean') fail();
  const items = value.items.map(summary);
  if (new Set(items.map(r => r.id)).size !== items.length || items.some(r => (filters.model && r.model !== filters.model) || (filters.status && r.status !== filters.status))) fail();
  if (value.has_more ? items.length !== 25 || value.next_cursor !== items.at(-1)?.id : value.next_cursor !== null) fail();
  return { ...value, items } as unknown as FiscalDraftPage;
}
export function fiscalRevisionPage(value: unknown, draftId: string): FiscalRevisionPage {
  base(value);
  if (value.draft_id !== draftId || !Array.isArray(value.items) || value.items.length > 25 || value.limit !== 25 || typeof value.has_more !== 'boolean') fail();
  const items = value.items.map(summary);
  if (new Set(items.map(r => r.version)).size !== items.length || items.some(r => r.id !== draftId)) fail();
  if (value.has_more ? items.length !== 25 || value.next_cursor !== items.at(-1)?.version : value.next_cursor !== null) fail();
  return { ...value, items } as unknown as FiscalRevisionPage;
}
export function fiscalDraftEnvelope(value: unknown, draftId?: string, revision?: number): FiscalDraftEnvelope {
  base(value); metadata(value.record); const r = value.record, s = r.snapshot, c = value.current;
  if ((draftId && r.id !== draftId) || (revision && r.version !== revision) || !text(r.snapshot_hash, 64) || !/^[a-f0-9]{64}$/.test(r.snapshot_hash)
    || !object(r.preparation) || !nullableText(r.preparation.operation_nature, 60) || !nullableText(r.preparation.notes, 4000)
    || (r.status === 'draft' ? r.archived_at !== null || r.archive_reason !== null : !moment(r.archived_at) || !text(r.archive_reason, 1000))) fail();
  if (!object(s) || s.catalog_basis !== 'document_snapshot' || s.kind !== 'sales_orders' || s.document_id !== r.source_document_id || s.document_version !== r.source_document_version
    || !text(s.number, 10) || !Object.hasOwn(STATES.sales_orders, String(s.status)) || !date(s.date) || !id(s.contact_id)
    || !object(s.contact) || s.contact.id !== s.contact_id || !version(s.contact.version) || !text(s.contact.name, 200) || !s.contact.name) fail();
  for (const key of ['person_type', 'document', 'ie', 'postal_code', 'street', 'number', 'complement', 'district', 'city', 'state']) if (!nullableText(s.contact[key], 200)) fail();
  if (!Array.isArray(s.items) || !s.items.length || s.items.length > 250 || !Array.isArray(s.installments) || s.installments.length > 120 || !object(s.totals)) fail();
  const seen = new Set();
  for (const [index, row] of s.items.entries()) {
    if (!object(row) || !id(row.id) || seen.has(row.id) || row.position !== index + 1 || !text(row.description, 4000) || !text(row.unit, 16) || !nullableText(row.code, 100)) fail();
    seen.add(row.id);
    if (!isCanonicalUnitPrice(row.unit_price, 10)) fail();
    for (const key of ['quantity', 'discount_percent', 'gross', 'discount', 'total']) if (!decimal(row[key])) fail();
    if (row.product_id === null ? row.product !== null : !id(row.product_id) || !object(row.product) || row.product.id !== row.product_id || !version(row.product.version)) fail();
    if (object(row.product)) for (const key of ['name', 'code', 'unit', 'kind', 'format', 'ncm', 'gtin']) if (!nullableText(row.product[key], 200)) fail();
  }
  for (const key of ['gross', 'line_discount', 'subtotal', 'discount', 'freight', 'other_expenses', 'total']) if (!decimal(s.totals[key])) fail();
  for (const key of ['ipi', 'icms_st']) if (Object.hasOwn(s.totals, key) && !decimal(s.totals[key])) fail();
  for (const key of ['tax_ipi', 'tax_icms_st', 'legacy_taxes']) if (Object.hasOwn(s, key) && !decimal(s[key])) fail();
  for (const row of s.installments) if (!object(row) || !version(row.position) || !date(row.due_date) || !decimal(row.amount) || !nullableText(row.method, 200)) fail();
  for (const key of ['notes', 'payment_terms', 'delivery_terms']) if (!nullableText(s[key], 4000)) fail();
  if (s.company !== null) {
    if (!object(s.company) || !version(s.company.identity_version) || (s.company.fiscal_version !== null && !version(s.company.fiscal_version)) || !object(s.company.identity)
      || typeof s.company.regime_confirmed !== 'boolean' || (s.company.crt !== null && !['1', '2', '3', '4'].includes(String(s.company.crt))) || s.company.regime_confirmed !== (s.company.crt !== null)) fail();
    for (const key of ['legal_name', 'trade_name', 'cnpj', 'ie', 'postal_code', 'street', 'number', 'complement', 'district', 'city', 'municipality_code', 'state']) if (!nullableText(s.company.identity[key], 200)) fail();
  }
  const company = s.company as unknown as FiscalCompany | null;
  if (!object(c) || !version(c.version) || c.version < (r.version as number) || !['draft', 'archived'].includes(String(c.status)) || !version(c.source_document_version)
    || !Object.hasOwn(STATES.sales_orders, String(c.source_status)) || (c.identity_version !== null && !version(c.identity_version)) || (c.fiscal_version !== null && !version(c.fiscal_version))
    || c.source_changed !== (c.source_document_version !== r.source_document_version)
    || c.company_changed !== (c.identity_version !== (company?.identity_version ?? null) || c.fiscal_version !== (company?.fiscal_version ?? null))
    || (c.version === r.version && c.status !== r.status)) fail();
  if (!Array.isArray(value.pending) || new Set(value.pending).size !== value.pending.length || value.pending.some(code => typeof code !== 'string' || !Object.hasOwn(FISCAL_PENDING_LABELS, code))) fail();
  for (const [code, condition] of [['SOURCE_DOCUMENT_CHANGED', c.source_changed], ['COMPANY_CONFIGURATION_CHANGED', c.company_changed], ['SOURCE_DOCUMENT_CANCELLED', c.source_status === 'cancelled'], ['DRAFT_ARCHIVED', c.status === 'archived']]) if (value.pending.includes(code) !== condition) fail();
  return value as unknown as FiscalDraftEnvelope;
}
export function fiscalPreparation(operationNature: string, notes: string): FiscalPreparation {
  if (operationNature.length > 60 || /[\x00-\x1f\x7f]/.test(operationNature)) throw new Error('A natureza da operação deve ter até 60 caracteres, sem quebras de linha.');
  if (notes.length > 4000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(notes)) throw new Error('As observações devem ter até 4.000 caracteres válidos.');
  return { operation_nature: operationNature.trim() || null, notes: notes.trim() || null };
}
export function fiscalCreateInput(order: DocumentSummary | null, model: string, preparation: FiscalPreparation, confirmed: boolean) {
  if (!order || order.kind !== 'sales_orders' || !id(order.id) || !version(order.version) || !Object.hasOwn(STATES.sales_orders, order.status) || order.status === 'cancelled') throw new Error('Selecione um pedido de venda salvo e não cancelado.');
  if (!['55', '65'].includes(model)) throw new Error('Escolha NF-e ou NFC-e.');
  if (!confirmed) throw new Error('Confirme o pedido e o modelo antes de criar o rascunho.');
  return { source_document_id: order.id, expected_source_version: order.version, model: model as FiscalModel, preparation: fiscalPreparation(preparation.operation_nature ?? '', preparation.notes ?? '') };
}
function editable(value: FiscalDraftEnvelope) {
  if (value.record.version !== value.current.version) throw new Error('Volte à versão atual para alterar o rascunho.');
  if (value.current.status !== 'draft' || value.record.status !== 'draft') throw new Error('Rascunhos arquivados permanecem somente para consulta.');
}
export function fiscalUpdateInput(value: FiscalDraftEnvelope, preparation: FiscalPreparation) {
  editable(value); return { expected_version: value.record.version, preparation: fiscalPreparation(preparation.operation_nature ?? '', preparation.notes ?? '') };
}
export function fiscalRefreshInput(value: FiscalDraftEnvelope, confirmed: boolean) {
  editable(value);
  if (value.current.source_status === 'cancelled') throw new Error('O pedido cancelado não pode atualizar esta cópia.');
  if (!confirmed) throw new Error('Confirme a atualização da cópia do pedido e da empresa.');
  return { expected_version: value.record.version, expected_source_version: value.current.source_document_version };
}
export function fiscalArchiveInput(value: FiscalDraftEnvelope, reason: string, confirmed: boolean) {
  editable(value);
  if (reason.trim().length < 3 || reason.length > 1000 || /[\x00-\x1f\x7f]/.test(reason)) throw new Error('Informe o motivo do arquivamento, entre 3 e 1.000 caracteres.');
  if (!confirmed) throw new Error('Confirme que o arquivamento é definitivo.');
  return { expected_version: value.record.version, reason: reason.trim() };
}
/** Formatting uses digit strings only; monetary values never pass through floating point. */
export function fiscalDecimal(value: string, currency = false): string {
  if (!DECIMAL.test(value)) return 'Indisponível';
  return formatDecimal(value, currency);
}
/** Commercial unit price has its own precision; quantities and totals keep their existing limits. */
export function fiscalUnitPrice(value: string): string {
  if (!isCanonicalUnitPrice(value, 10)) return 'Indisponível';
  return formatDecimal(value, true);
}
function formatDecimal(value: string, currency: boolean): string {
  const [integer, fraction = ''] = value.split('.');
  return `${currency ? 'R$ ' : ''}${integer.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}${fraction ? `,${fraction}` : currency ? ',00' : ''}`;
}
export const fiscalDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) ? value.split('-').reverse().join('/') : 'Não informada';
export const fiscalMoment = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }) : 'Não informado';
