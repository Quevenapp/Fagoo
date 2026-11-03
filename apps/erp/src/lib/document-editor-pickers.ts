import { catalogData, CatalogValidationError, type CatalogRecord } from './catalog-model.ts';
import { compactDocumentDecimal } from './document-decimals.ts';
import { quantityText } from './stock-model.ts';
import { decimal, format } from '../../../../packages/erp-domain/src/index.mjs';
import type { DocumentKind } from './real-documents-model';
import type { PositionPage } from './stock-positions-model';

/**
 * Editor de documentos no padrão Origin: “Contato rápido”, inclusão por código/GTIN com Enter
 * e estoque visível ao escolher o produto. Nada aqui grava dados: as escritas continuam nos
 * endpoints existentes (POST /v1/cadastros/contatos, desde a onda C de contatos, e o salvamento normal do documento).
 */

// Origin wording (docs/references/origin-interface.md, modal “Contato rápido” e grade de itens).
export const QUICK_CONTACT_TITLE = 'Contato rápido';
export const QUICK_CONTACT_ERROR = 'Erro ao salvar! Verifique o(s) campo(s) em destaque, antes de salvar.';
export const PRODUCT_SEARCH_PLACEHOLDER = 'Pesquise por código, descrição ou GTIN';
export const QUICK_CONTACT_PERSON_TYPES = [{ value: 'J', label: 'Pessoa Jurídica' }, { value: 'F', label: 'Pessoa Física' }, { value: 'E', label: 'Estrangeiro' }] as const;
export const QUICK_CONTACT_ROLES = [{ value: 'customer', label: 'Cliente' }, { value: 'supplier', label: 'Fornecedor' }, { value: 'carrier', label: 'Transportador' }] as const;
/** Same roles as erp_catalog.allowed(…,'contacts',true); the server and the database still decide. */
export const CONTACT_WRITER_ROLES: readonly string[] = ['admin', 'vendas', 'financeiro'];

export type QuickContactRole = 'customer' | 'supplier' | 'carrier';
export type QuickContactPersonType = 'F' | 'J' | 'E';
export interface QuickContactValues { name: string; person_type: QuickContactPersonType; document: string; phone: string; mobile: string; email: string; roles: QuickContactRole[]; code?: string; trade_name?: string; ie?: string; postal_code?: string; state?: string; city?: string; district?: string; street?: string; number?: string; complement?: string;
  /** Full Origin “Contato rápido” (contatos onda C, contact-quick-model.ts). */
  situation?: 'A' | 'I' | 'S'; taxpayer?: string; country?: string; birth_date?: string; rg?: string; nfe_email?: string; contact_info?: string; notes?: string }
/** Optional Origin “Contato rápido” fields, sent to the same catalog validation as Clientes e fornecedores. */
export const QUICK_CONTACT_EXTRA = ['code', 'trade_name', 'ie', 'postal_code', 'state', 'city', 'district', 'street', 'number', 'complement'] as const;

export const quickContactRole = (kind: DocumentKind): QuickContactRole => kind === 'purchase_orders' ? 'supplier' : 'customer';
export function quickContactAllowed(access: { write: readonly string[] } | null | undefined, role: string | null | undefined): boolean {
  return Boolean(access && Array.isArray(access.write) && access.write.includes('contacts') && role && CONTACT_WRITER_ROLES.includes(role));
}
export const quickContactDocumentLabel = (type: QuickContactPersonType) => type === 'J' ? 'CNPJ' : type === 'F' ? 'CPF' : 'CNPJ/CPF';

/** A search that looks like a CPF/CNPJ fills the document; anything else becomes the name. */
export function quickContactInitial(kind: DocumentKind, query: string): QuickContactValues {
  const text = query.trim(), digits = text.replace(/[.\-/\s]/g, '');
  const document = /^[\d.\-/\s]+$/.test(text) && /^(?:\d{11}|\d{14})$/.test(digits);
  return { name: document ? '' : text.slice(0, 200), person_type: document && digits.length === 11 ? 'F' : 'J', document: document ? text : '', phone: '', mobile: '', email: '', roles: [quickContactRole(kind)] };
}

const checkDigit = (values: number[], weights: number[]) => { const sum = values.reduce((total, value, index) => total + value * weights[index], 0) % 11; return sum < 2 ? 0 : 11 - sum; };
export function validCpf(value: string): boolean {
  const digits = value.replace(/[.\-\s]/g, '');
  if (!/^\d{11}$/.test(digits) || /^(\d)\1{10}$/.test(digits)) return false;
  const numbers = [...digits].map(Number);
  const first = checkDigit(numbers.slice(0, 9), [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  return first === numbers[9] && checkDigit(numbers.slice(0, 10), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]) === numbers[10];
}
/** Numeric and alphanumeric CNPJ (letters A-Z valued by ASCII code minus 48, check digits numeric). */
export function validCnpj(value: string): boolean {
  const text = value.toUpperCase().replace(/[.\-/\s]/g, '');
  if (!/^[0-9A-Z]{12}\d{2}$/.test(text) || /^(.)\1{13}$/.test(text)) return false;
  const numbers = [...text].map(character => character.charCodeAt(0) - 48);
  const first = checkDigit(numbers.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return first === numbers[12] && checkDigit(numbers.slice(0, 13), [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) === numbers[13];
}

/** Builds the existing catalog payload; the document's own contact type is always included. */
export function quickContactPayload(kind: DocumentKind, values: QuickContactValues) {
  const role = quickContactRole(kind), allowed = QUICK_CONTACT_ROLES.map(option => option.value as string);
  if (!QUICK_CONTACT_PERSON_TYPES.some(option => option.value === values.person_type)) throw new CatalogValidationError('person_type', 'Confira o tipo da pessoa.');
  if (!Array.isArray(values.roles) || !values.roles.includes(role) || values.roles.some(value => !allowed.includes(value)) || new Set(values.roles).size !== values.roles.length) {
    throw new CatalogValidationError('roles', `O contato precisa ser ${role === 'supplier' ? 'fornecedor' : 'cliente'} para ser usado neste documento.`);
  }
  let document = values.document.trim();
  if (document && values.person_type === 'F' && !validCpf(document)) throw new CatalogValidationError('document', 'Informe um CPF válido ou deixe o campo vazio.');
  if (document && values.person_type === 'J') {
    if (!validCnpj(document)) throw new CatalogValidationError('document', 'Informe um CNPJ válido ou deixe o campo vazio.');
    document = document.toUpperCase();
  }
  const email = values.email.trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new CatalogValidationError('email', 'Informe um e-mail válido ou deixe o campo vazio.');
  const ordered = allowed.filter(value => values.roles.includes(value as QuickContactRole));
  const extra = Object.fromEntries(QUICK_CONTACT_EXTRA.map(key => [key, values[key] ?? '']));
  const state = (values.state ?? '').trim().toUpperCase();
  if (state && !/^(AC|AL|AM|AP|BA|CE|DF|ES|EX|GO|MA|MG|MS|MT|PA|PB|PE|PI|PR|RJ|RN|RO|RR|RS|SC|SE|SP|TO)$/.test(state)) throw new CatalogValidationError('state', 'Escolha uma UF válida.');
  const postal = (values.postal_code ?? '').trim();
  if (postal && !/^\d{5}-?\d{3}$/.test(postal)) throw new CatalogValidationError('postal_code', 'Informe o CEP com oito dígitos.');
  return { data: catalogData('contacts', { ...extra, name: values.name, person_type: values.person_type, document, phone: values.phone, mobile: values.mobile, email }, ordered) };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Created or re-read contact must be the exact record the command produced (the caller checks `active`). */
export function quickContactRecord(value: unknown, expectedId: string | null = null): CatalogRecord {
  const record = object(value) ? value.record : null;
  if (!object(value) || !object(record) || value.entity !== 'contacts' || record.entity !== 'contacts' || typeof record.id !== 'string' || !UUID.test(record.id)
    || (expectedId !== null && record.id.toLowerCase() !== expectedId.toLowerCase()) || typeof record.active !== 'boolean' || typeof record.name !== 'string' || !record.name.trim()
    || !Number.isInteger(record.version) || (record.version as number) < 1 || !Array.isArray(record.roles)) throw new Error('QUICK_CONTACT_RESPONSE_INVALID');
  return record as unknown as CatalogRecord;
}

// Quantities follow the document contract: up to nine integer digits and six decimals, never a float.
const QUANTITY_LIMIT = 10n ** 15n;
export function incrementQuantity(value: string): string | null {
  let units: bigint;
  try { units = decimal(value, 6, 9); } catch { return null; }
  const next = units + 1_000_000n;
  return next >= QUANTITY_LIMIT ? null : compactDocumentDecimal(format(next, 6));
}

export type ProductCodeOutcome = { kind: 'add'; row: CatalogRecord } | { kind: 'inactive'; row: CatalogRecord } | { kind: 'ambiguous'; count: number } | { kind: 'missing' } | { kind: 'too_many' } | { kind: 'invalid' };
export const PRODUCT_CODE_PAGE_SIZE = 100;
export const PRODUCT_CODE_PAGES = 5;
/** Exact SKU (case-insensitive, as the server search) or exact GTIN; “SEM GTIN” never matches. */
export function productCodeMatches(rows: readonly CatalogRecord[], code: string): CatalogRecord[] {
  const wanted = code.trim(), lower = wanted.toLowerCase();
  if (!wanted) return [];
  return rows.filter(row => (typeof row.code === 'string' && row.code.trim().toLowerCase() === lower)
    || (typeof row.gtin === 'string' && row.gtin.trim() !== 'SEM GTIN' && row.gtin.trim() === wanted));
}
export function productCodeOutcome(matches: readonly CatalogRecord[], complete: boolean): ProductCodeOutcome {
  const active = matches.filter(row => row.active === true);
  if (active.length > 1) return { kind: 'ambiguous', count: active.length };
  if (!complete) return { kind: 'too_many' };
  if (active.length === 1) return { kind: 'add', row: active[0] };
  return matches.length ? { kind: 'inactive', row: matches[0] } : { kind: 'missing' };
}
function productCodePage(value: unknown): { items: CatalogRecord[]; has_more: boolean; next_cursor: string | null } {
  if (!object(value) || value.entity !== 'products' || !Array.isArray(value.items) || value.items.length > PRODUCT_CODE_PAGE_SIZE || typeof value.has_more !== 'boolean'
    || (value.has_more ? typeof value.next_cursor !== 'string' || !UUID.test(value.next_cursor) : value.next_cursor !== null)
    || value.items.some(row => !object(row) || typeof row.id !== 'string' || !UUID.test(row.id) || typeof row.name !== 'string' || typeof row.active !== 'boolean'
      || (row.code !== null && typeof row.code !== 'string') || (row.gtin !== null && row.gtin !== undefined && typeof row.gtin !== 'string'))) throw new Error('PRODUCT_CODE_RESPONSE_INVALID');
  return { items: value.items as CatalogRecord[], has_more: value.has_more, next_cursor: value.next_cursor as string | null };
}
/**
 * Reads the existing product search (which already matches code and GTIN) until the result is
 * complete. Inactive products are searched too, only to explain why they cannot be added.
 */
export async function findProductByCode(request: (path: string, options: { signal: AbortSignal }) => Promise<unknown>, code: string, signal: AbortSignal): Promise<ProductCodeOutcome> {
  const wanted = code.trim();
  if (!wanted || wanted.length > 120 || /[\x00-\x1f\x7f]/.test(wanted)) return { kind: 'invalid' };
  const matches: CatalogRecord[] = [];
  let after: string | null = null;
  for (let page = 0; page < PRODUCT_CODE_PAGES; page++) {
    const params = new URLSearchParams({ limit: String(PRODUCT_CODE_PAGE_SIZE), q: wanted });
    if (after) params.set('after', after);
    const value = productCodePage(await request(`/v1/cadastros/products?${params}`, { signal }));
    matches.push(...productCodeMatches(value.items, wanted));
    if (!value.has_more) return productCodeOutcome(matches, true);
    if (productCodeOutcome(matches, false).kind === 'ambiguous') return productCodeOutcome(matches, false);
    after = value.next_cursor;
  }
  return productCodeOutcome(matches, false);
}
export function productCodeMessage(code: string, outcome: Exclude<ProductCodeOutcome, { kind: 'add' }>): string {
  const shown = code.trim().slice(0, 60);
  switch (outcome.kind) {
    case 'inactive': return `O produto ${outcome.row.name} (${shown}) está inativo e não pode ser incluído.`;
    case 'ambiguous': return `Mais de um produto ativo usa o código ou GTIN ${shown}. Pesquise pela descrição e escolha o produto na lista.`;
    case 'too_many': return `Muitos produtos contêm ${shown}. Pesquise pela descrição e escolha o produto na lista.`;
    case 'invalid': return 'Informe um código ou GTIN com até 120 caracteres.';
    default: return `Nenhum produto encontrado com o código ou GTIN ${shown}. Pesquise pela descrição e escolha o produto na lista.`;
  }
}

/** Physical stock per product for the picker options. Absence of entries is never shown as zero. */
export function productStockLabels(page: PositionPage): Map<string, string> {
  const scoped = page.warehouse !== null, labels = new Map<string, string>(), prefix = scoped ? 'Estoque' : 'Estoque total';
  for (const row of page.items) {
    const state = scoped ? row.selected_position?.state : row.global.state, quantity = scoped ? row.selected_position?.quantity : row.global.quantity;
    labels.set(row.product.id, state === 'recorded' && quantity ? `${prefix}: ${quantityText(quantity)}${row.product.unit ? ` ${row.product.unit}` : ''}`
      : state === 'no_movements' ? `${prefix}: sem lançamentos` : `${prefix}: em conferência`);
  }
  return labels;
}
