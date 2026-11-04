import './document-layout.css';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AccessError, decimalMoney, type AccessController } from '../lib/real-access';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { invoicePreferences, invoiceRecord, invoiceTotals, natureRecord, natureSummary, normalizeInvoiceInput, normalizeTaxSettings, type OriginDetail, type InvoiceInput, type InvoiceRecord, type NatureRecord, type NatureSummary, type TaxSettingsValues } from '../../../../packages/erp-domain/src/fiscal-invoice-contract.mjs';
import { centsOf, ISSUE_TYPES } from '../../../../packages/erp-domain/src/fiscal-invoice-dto.mjs';
import { calculateInvoiceTaxes } from '../../../../packages/fiscal-core/src/tax-engine.mjs';
import { ORDER_REASONS, contactSourceRecord, keyLookupRecord, orderSourceRecord, paymentMethodsRecord, type KeyLookupItem, type OrderSource } from '../../../../packages/erp-domain/src/fiscal-invoice-order.mjs';
import {
  CRT_OPTIONS, FREIGHT_OPTIONS, IE_OPTIONS, IMPORT_FORM_OPTIONS, PAYMENT_OPTIONS, PERSON_OPTIONS, PRESENCE_OPTIONS, PURPOSE_OPTIONS, REFERENCE_OPTIONS, REGISTERED, ROUTE_OPTIONS,
  SPECIES_OPTIONS, TRANSPORT_OPTIONS, UF_EX_OPTIONS, UF_OPTIONS, checkDraft, cloneDraft, complementaryDraft, defaultNatureCode, draftToInput, installmentsFromCondition, installmentsMismatch, issueOptions, newDraft, returnDraft,
  applyDiscountMode, carrierValues, compositionNotices, withReturnQuantities, formaOptions, formaValue, groupedOrderDraft, withForma, type PaymentMethodOption, isServiceItem, optionalTabs, orderDraft, withNatureSummary, orderLocks, orderOrigin, preferencesOf, withItemDiscounts, recordToDraft, xmlDraft, validationMessage, withPreferenceVolumes, type FormContext, type InstallmentDraft, type InvoiceDraft, type ItemDraft, type Values,
} from '../lib/fiscal-invoice-form-model';
import { EDITABLE, FISCAL_BASE, statusClass, statusLabel, type ScreenConfig } from '../lib/fiscal-invoice-list-model';
import { CONTACT_WRITER_ROLES, quickContactInitial } from '../lib/document-editor-pickers';
import type { CatalogPage, CatalogRecord } from '../lib/catalog-model';
import FiscalInvoiceItemDialog from './FiscalInvoiceItemDialog';
import FiscalReconcilePanel from './FiscalReconcilePanel';
import FiscalInstallmentDialog from './FiscalInstallmentDialog';
import DocumentQuickContact from './DocumentQuickContact';
import FinanceContactOpenTitles from './FinanceContactOpenTitles';
import FiscalInvoiceItemProduct, { PRODUCT_WRITER_ROLES } from './FiscalInvoiceItemProduct';
import FiscalInvoiceItemHistory from './FiscalInvoiceItemHistory';
// Estoque lane, onda F (278): Informações de lote of the item (the lots of the stock posted by the note).
import { SourceLotsPanel } from './StockMovementLots';
import { Icon } from './Icon';
import CepLookupButton from './CepLookupButton';
import { fillAddress, type PlatformPort } from '../lib/platform-model';

export type FormOpening = { kind: 'new' } | { kind: 'clone' | 'clone_invert' | 'nfe_from_nfce' | 'complementary' | 'return'; record?: InvoiceRecord; origin?: OriginDetail;
    /** "Devolução de produto" (202610200220): the quantity to return of each item, aligned with the items of the note. */
    quantities?: readonly string[] }
  // Wave F: "Editar NF-e" of Notas recebidas, the entry note read from the received XML (checked by the Worker).
  | { kind: 'xml'; input: InvoiceInput; record?: undefined; origin?: undefined }
  // "Gerar nota fiscal" / "Gerar NFC-e" of a pedido (migration 202610200176).
  | { kind: 'order'; documentId: string; record?: undefined; origin?: undefined;
    /** "Gerar nota fiscal agrupando" (202610200215+): the documents grouped in one note, the first one included. */
    documentIds?: readonly string[] };
const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const known = (error: unknown) => error instanceof AccessError && [400, 403, 404, 409].includes(error.status);
const actorOf = (controller: AccessController) => controller.getSnapshot?.()?.membership?.user_id ?? null;
// 278: who reads the lots of the stock posted by a note (erp_stock.invoice_access).
const LOT_ROLES = ['admin', 'estoque', 'fiscal'];
const roleOf = (controller: AccessController) => controller.getSnapshot?.()?.membership?.role ?? '';
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// "Destino da Operação" (idDest) when Preferências › Configurações de NF-e asks to fill it by hand (202610200215).
const DESTINATION_OPTIONS = [['1', '1 - Operação interna'], ['2', '2 - Operação interestadual'], ['3', '3 - Operação com exterior']] as const;
const TABS = [['cabecalho', 'Cabeçalho'], ['referenciado', 'Documento referenciado'], ['destinatario', 'Destinatário'], ['itens', 'Itens da nota fiscal'], ['calculo', 'Cálculo de imposto'],
  ['retencoes', 'Retenções'], ['transporte', 'Transportador/Volumes'], ['pagamento', 'Pagamento'], ['autorizados', 'Pessoas autorizadas a acessar o XML da nota'], ['intermediador', 'Intermediador'],
  ['informacoes', 'Informações adicionais']] as const;
export type Tab = typeof TABS[number][0];
const digits = (value: unknown) => String(value ?? '').replace(/\D/g, '');
/** Copies the contact cadastro to the note, like Origin when a contact is chosen. */
export function contactToRecipient(contact: CatalogRecord): Values {
  const get = (key: string, max = 60) => typeof contact[key] === 'string' && (contact[key] as string).trim() ? (contact[key] as string).trim().slice(0, max) : undefined;
  const document = digits(contact.document), type = (['J', 'F', 'E'] as const).find(t => t === contact.person_type) ?? (document.length === 14 ? 'J' : document.length === 11 ? 'F' : undefined);
  const postal = digits(contact.postal_code), phone = digits(contact.phone || contact.mobile), ie = digits(contact.ie);
  const out: Values = { contact_id: contact.id, name: contact.name.slice(0, 60) };
  if (type) out.person_type = type;
  if (type !== 'E' && (document.length === 11 || document.length === 14)) out.document = document;
  if (ie.length >= 2 && ie.length <= 14) out.ie = ie; else if (String(contact.ie ?? '').toUpperCase() === 'ISENTO') out.ie = 'ISENTO';
  for (const [key, max] of [['email', 60], ['street', 60], ['number', 60], ['complement', 60], ['district', 60], ['city', 60]] as const) { const v = get(key, max); if (v) out[key] = v; }
  if (postal.length === 8) out.postal_code = postal;
  if (phone.length >= 6 && phone.length <= 14) out.phone = phone;
  const state = get('state', 2)?.toUpperCase(); if (state && /^[A-Z]{2}$/.test(state)) out.state = state;
  return out;
}
function originToDraft(detail: OriginDetail, config: Pick<ScreenConfig, 'model' | 'direction'>, context: FormContext | null, today: string, invert: boolean, toNfe = false): InvoiceDraft {
  const direction = invert ? (detail.direction === '0' ? '1' : '0') : (detail.direction ?? config.direction) as '0' | '1';
  const draft = newDraft({ model: invert || toNfe ? '55' : config.model, direction }, context, today);
  if (toNfe && detail.access_key) draft.references = [{ type: 'nfe', key: detail.access_key }];
  const c = detail.contact, recipient: Values = {};
  if (c.name) recipient.name = c.name.slice(0, 60);
  const doc = digits(c.document); if (doc.length === 14 || doc.length === 11) { recipient.document = doc; recipient.person_type = doc.length === 14 ? 'J' : 'F'; }
  for (const [key, value] of [['email', c.email], ['street', c.street], ['number', c.number], ['complement', c.complement], ['district', c.district], ['city', c.city]] as const) if (value) recipient[key] = value.slice(0, 60);
  if (c.state && /^[A-Z]{2}$/.test(c.state)) recipient.state = c.state;
  if (digits(c.postal_code).length === 8) recipient.postal_code = digits(c.postal_code);
  draft.recipient = recipient;
  draft.items = detail.items.filter(i => i.description && i.quantity && i.unit_price).map(i => ({ description: i.description!.slice(0, 120), ...(i.code ? { code: i.code } : {}), ...(i.unit ? { unit: i.unit.slice(0, 6) } : {}),
    quantity: i.quantity!, unit_price: i.unit_price!, ...(i.ncm && /^\d{8}$/.test(i.ncm) ? { ncm: i.ncm } : {}), ...(!invert && i.cfop && /^[1-7]\d{3}$/.test(i.cfop) ? { cfop: i.cfop } : {}) }));
  return draft;
}
// Imported XML notes (S/X) stay as the XML says; only "Conciliar produtos" changes them.
const imported = (record: InvoiceRecord | null) => Boolean(record && ['S', 'X'].includes(record.issue_type));
const editableStatus = (record: InvoiceRecord | null) => !record || (record.deleted_at === null && EDITABLE.includes(record.status) && !imported(record));
/** Product weights (kg, up to six decimals in the cadastro) rounded half up to the three decimals of the note. */
const weight3 = (value: unknown) => {
  const text = typeof value === 'string' ? value.trim() : ''; if (!/^\d{1,12}(\.\d{1,10})?$/.test(text)) return undefined;
  const [whole, fraction = ''] = text.split('.'), scaled = BigInt(whole) * 10000n + BigInt((fraction + '0000').slice(0, 4)), rounded = (scaled + 5n) / 10n;
  return rounded > 0n ? `${rounded / 1000n}.${String(rounded % 1000n).padStart(3, '0')}` : undefined;
};
type Command = { id: string; actor: string | null; body: Record<string, unknown>; path: string; method: 'POST' | 'PATCH'; uncertain: boolean; expectedVersion: number | null };

/** Formulário "Nota fiscal" (Incluir / editar / clonar) no padrão Origin, com um único Salvar. */
export default function FiscalInvoiceForm({ controller, config, id, opening, today, initialTab = 'cabecalho', onBack, onSaved }: {
  controller: AccessController; config: ScreenConfig; id: string | null; opening: FormOpening | null; today: string; initialTab?: Tab; onBack: () => void; onSaved: (record: InvoiceRecord) => void;
}) {
  const [context, setContext] = useState<FormContext | null>(null), [record, setRecord] = useState<InvoiceRecord | null>(null);
  const [draft, setDraft] = useState<InvoiceDraft | null>(null), [baseline, setBaseline] = useState('');
  const [natures, setNatures] = useState<NatureSummary[]>([]), [details, setDetails] = useState<Record<string, NatureRecord>>({}), [settings, setSettings] = useState<Partial<TaxSettingsValues>>({});
  const [difalByState, setDifalByState] = useState<Record<string, string>>({}), [locks, setLocks] = useState({ items: false, installments: false });
  // Section shortcuts keep the full document mounted and preserve field focus/state.
  const [tab, selectSection] = useState<Tab>(initialTab), [itemIndex, setItemIndex] = useState<number | null>(null), [showMore, setShowMore] = useState(false);
  const sectionRoot = useRef<HTMLElement>(null);
  const scrollSection = (value: Tab) => {
    const section = sectionRoot.current?.querySelector<HTMLElement>(`#fiscal-section-${value}`);
    section?.scrollIntoView({ block: 'start' });
    section?.focus({ preventScroll: true });
  };
  const setTab = (value: Tab) => { selectSection(value); scrollSection(value); };
  const loaded = Boolean(draft && context);
  useEffect(() => { if (loaded && initialTab !== 'cabecalho') scrollSection(initialTab); }, [loaded, initialTab]);

  const [installmentIndex, setInstallmentIndex] = useState<number | null>(null), [refusal, setRefusal] = useState<OrderSource | null>(null), [origin, setOrigin] = useState<OrderSource | null>(null);
  const [group, setGroup] = useState<OrderSource[] | null>(null);
  const [loadError, setLoadError] = useState(''), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [natureQuery, setNatureQuery] = useState(''), [contactQuery, setContactQuery] = useState(''), [contacts, setContacts] = useState<CatalogRecord[]>([]), [contactTarget, setContactTarget] = useState<'recipient' | 'carrier' | 'authorized'>('recipient');
  const [contactsUntyped, setContactsUntyped] = useState(false);
  const [productSearch, setProductSearch] = useState<{ index: number; query: string; results: CatalogRecord[] } | null>(null), [quickContact, setQuickContact] = useState(false);
  const [refDraft, setRefDraft] = useState<Values>({ type: 'nfe' }), [refError, setRefError] = useState('');
  // Group of each item product for the "Grupo de Produtos" rules of the natures (202610200216); null = product without group.
  const [productGroups, setProductGroups] = useState<Record<string, string | null>>({});
  // Ícones do item (202610200218): criar/atualizar produto a partir da nota e histórico do produto para o contato.
  const [itemProduct, setItemProduct] = useState<number | null>(null), [itemHistory, setItemHistory] = useState<number | null>(null), [itemLots, setItemLots] = useState<number | null>(null);
  // 202610200219: Formas de pagamento of the cadastro for "Forma" and the note of each referenced access key (conference only).
  const [methods, setMethods] = useState<PaymentMethodOption[]>([]), [lookups, setLookups] = useState<Record<string, KeyLookupItem[] | 'error'>>({});
  // Vendedor (cadastro de vendedores) of the note (202610200215).
  const [sellerQuery, setSellerQuery] = useState(''), [sellers, setSellers] = useState<{ id: string; name: string; code: string | null }[]>([]);
  // One read per target: picking the transportadora right after the destinatário must not cancel the destinatário read.
  const contactRead = useRef<Record<'recipient' | 'carrier', AbortController | null>>({ recipient: null, carrier: null });
  const command = useRef<Command | null>(null), inflight = useRef<AbortController | null>(null), life = useRef(new AbortController()), actor = useRef(actorOf(controller));
  const role = roleOf(controller), canWrite = ['admin', 'fiscal'].includes(role) && actorOf(controller) === actor.current;
  const editable = canWrite && editableStatus(record);
  const dirty = draft !== null && JSON.stringify(draft) !== baseline;
  const guard = useUnsavedChanges(dirty || uncertain, busy);
  useEffect(() => { const current = life.current, reads = contactRead.current; return () => { current.abort(); inflight.current?.abort(); reads.recipient?.abort(); reads.carrier?.abort(); }; }, []);
  // Context, natures and tax settings, then the record or the opening draft.
  useEffect(() => {
    const request = new AbortController(), signal = request.signal;
    void (async () => {
      try {
        // "Gerar NF-e" and "Gerar devolução" from an NFC-e open an NF-e (model 55) with the NF-e series, defaults and preferences.
        const raw = await controller.fiscalInvoices(`${FISCAL_BASE}/contexto?model=${opening?.kind === 'nfe_from_nfce' || opening?.kind === 'return' ? '55' : config.model}`, { signal }) as FormContext & { production_enabled: boolean };
        if (signal.aborted) return;
        if (!raw || raw.production_enabled !== false || !Array.isArray(raw.series) || typeof raw.defaults !== 'object') throw new AccessError(502);
        // Preferências › Notas Fiscais that this form follows (padrões, grupos visíveis, pessoas autorizadas).
        const ctx: FormContext & { production_enabled: boolean } = { ...raw, preferences: invoicePreferences(raw.preferences), item_discount: raw.item_discount === true };
        setContext(ctx);
        const [natureList, taxes] = await Promise.all([
          controller.fiscalInvoices(`${FISCAL_BASE}/naturezas?active=true&limit=100`, { signal }) as Promise<{ items: unknown[] }>,
          controller.fiscalInvoices(`${FISCAL_BASE}/impostos`, { signal }) as Promise<{ settings: unknown; difal_by_state: unknown }>,
        ]);
        if (signal.aborted) return;
        const taxSettings = normalizeTaxSettings(taxes?.settings, taxes?.difal_by_state);
        setNatures((natureList?.items ?? []).map(natureSummary)); setSettings(taxSettings.settings); setDifalByState(taxSettings.difal_by_state);
        let next: InvoiceDraft;
        if (!id && opening?.kind === 'order' && (opening.documentIds?.length ?? 0) > 1) {
          // "Gerar nota fiscal agrupando": every document is read and must be eligible; the note groups their parts.
          const sources: OrderSource[] = [];
          for (const documentId of opening.documentIds!) {
            const source = orderSourceRecord(await controller.fiscalInvoices(`${FISCAL_BASE}/pedido/${documentId}?model=${config.model}`, { signal }));
            if (signal.aborted) return;
            if (source.document.id !== documentId || source.model !== config.model) throw new AccessError(502);
            if (!source.eligible || source.direction !== config.direction) { setRefusal(source); return; }
            sources.push(source);
          }
          const grouped = groupedOrderDraft(sources, config, ctx, today);
          if (grouped.problem) { setLoadError(grouped.problem); return; }
          next = withNatureSummary(grouped.draft, (natureList?.items ?? []).map(natureSummary).find(n => n.id === grouped.draft.nature_id) ?? null);
          setOrigin(sources[0]!); setGroup(sources);
        } else if (!id && opening?.kind === 'order') {
          // Origin "Gerar nota fiscal": the pedido fills a new note; a refused pedido shows "Erro ao gerar a Nota fiscal" with the reasons.
          const source = orderSourceRecord(await controller.fiscalInvoices(`${FISCAL_BASE}/pedido/${opening.documentId}?model=${config.model}`, { signal }));
          if (signal.aborted) return;
          if (source.document.id !== opening.documentId || source.model !== config.model) throw new AccessError(502);
          if (!source.eligible || source.direction !== config.direction) { setRefusal(source); return; }
          next = orderDraft(source, config, ctx, today);
          // Like picking the natureza by hand: its presence, consumidor final and série follow it.
          next = withNatureSummary(next, (natureList?.items ?? []).map(natureSummary).find(n => n.id === next.nature_id) ?? null);
          setOrigin(source); setLocks(orderLocks(source, ctx.preferences));
        } else if (id) {
          const value = await controller.fiscalInvoices(`${FISCAL_BASE}/${id}`, { signal }) as { invoice: unknown; locks?: { items: unknown; installments: unknown } };
          if (signal.aborted) return;
          const loaded = invoiceRecord(value?.invoice); if (loaded.id !== id) throw new AccessError(502);
          setLocks({ items: value?.locks?.items === true, installments: value?.locks?.installments === true });
          setRecord(loaded); next = recordToDraft(loaded);
        } else if (opening?.kind === 'xml') next = xmlDraft(opening.input, ctx);
        else if (opening && opening.kind !== 'new' && opening.record) next = opening.kind === 'complementary' ? complementaryDraft(opening.record)
          : opening.kind === 'return' ? returnDraft(cloneDraft(opening.record, { invert: true, context: ctx }), opening.record.access_key, ctx)
          : cloneDraft(opening.record, { invert: opening.kind === 'clone_invert', toNfe: opening.kind === 'nfe_from_nfce', context: ctx });
        else if (opening && opening.kind !== 'new' && opening.origin) {
          next = originToDraft(opening.origin, config, ctx, today, opening.kind === 'clone_invert', opening.kind === 'nfe_from_nfce');
          // "NFe complementar" of a Origin note: finalidade 2 referencing the authorized key, like complementaryDraft for Brufap notes.
          if (opening.kind === 'complementary') next = { ...next, purpose: '2', references: opening.origin.access_key ? [{ type: 'nfe', key: opening.origin.access_key }] : [] };
          if (opening.kind === 'return') next = returnDraft(originToDraft(opening.origin, config, ctx, today, true), opening.origin.access_key, ctx);
        }
        else next = newDraft(config, ctx, today);
        // "Devolução de produto": the quantities chosen in the modal (items with zero are left out).
        if (opening && opening.kind === 'return' && opening.quantities) next = withReturnQuantities(next, opening.quantities);
        // "Informar desconto individualmente nos itens": the opened note follows the preference without changing its totals.
        if (!(opening?.kind === 'order')) next = applyDiscountMode(next, ctx.item_discount === true);
        setDraft(next); setBaseline(id ? JSON.stringify(next) : JSON.stringify(newDraft(config, ctx, today)));
      } catch (problem) { if (!signal.aborted && !aborted(problem)) setLoadError(problem instanceof AccessError && problem.status === 404 ? opening?.kind === 'order' ? 'Pedido não encontrado.' : 'Nota não encontrada.' : 'Não foi possível carregar ou conferir a nota. Volte à listagem e tente novamente.'); }
    })();
    return () => request.abort();
  }, [controller, config.model, id]);
  // Nature details feed "Cálculo automático"; each is read once and validated.
  const natureIds = useMemo(() => draft ? [...new Set([draft.nature_id, ...draft.items.map(i => typeof i.nature_id === 'string' ? i.nature_id : '')].filter(Boolean))] : [], [draft]);
  useEffect(() => {
    const missing = natureIds.filter(n => !details[n]); if (!missing.length) return;
    const request = new AbortController();
    void Promise.all(missing.map(n => controller.fiscalInvoices(`${FISCAL_BASE}/naturezas/${n}`, { signal: request.signal }) as Promise<{ nature: unknown }>)).then(values => {
      if (request.signal.aborted) return;
      const loaded = values.map(v => natureRecord(v?.nature));
      setDetails(previous => ({ ...previous, ...Object.fromEntries(loaded.map(n => [n.id, n])) }));
    }).catch(() => { /* The calculation waits; saving still validates on the server. */ });
    return () => request.abort();
  }, [controller, natureIds.join(',')]);
  useEffect(() => {
    if (!draft) return;
    const request = new AbortController();
    void controller.fiscalInvoices(`${FISCAL_BASE}/formas-pagamento?direction=${draft.direction}`, { signal: request.signal }).then(value => { if (!request.signal.aborted) setMethods(paymentMethodsRecord(value, draft.direction).items); })
      .catch(() => { /* Without the cadastro the Forma keeps the tPag table. */ });
    return () => request.abort();
  }, [controller, draft?.direction]);
  const pendingKeys = draft ? draft.references.map(r => typeof r.key === 'string' ? r.key : '').filter(k => /^\d{44}$/.test(k) && !Object.hasOwn(lookups, k)).slice(0, 20) : [];
  useEffect(() => {
    if (!pendingKeys.length) return;
    const request = new AbortController();
    void Promise.all(pendingKeys.map(key => controller.fiscalInvoices(`${FISCAL_BASE}/chave/${key}`, { signal: request.signal }).then(value => [key, keyLookupRecord(value, key).items] as const).catch(() => [key, 'error'] as const)))
      .then(found => { if (!request.signal.aborted) setLookups(previous => ({ ...previous, ...Object.fromEntries(found) })); });
    return () => request.abort();
  }, [controller, pendingKeys.join(',')]);
  // "Grupo de Produtos": read the groups of the item products only when a loaded natureza has such a rule (100 per read).
  const groupRules = Object.values(details).some(n => n.rules.some(r => r.product_scope === 'groups'));
  const missingGroups = groupRules && draft ? [...new Set(draft.items.map(i => typeof i.product_id === 'string' ? i.product_id : '').filter(p => UUID_TEXT.test(p) && !Object.hasOwn(productGroups, p)))].slice(0, 100) : [];
  useEffect(() => {
    if (!missingGroups.length) return;
    const request = new AbortController();
    void controller.fiscalInvoices(`${FISCAL_BASE}/grupos-produtos?${new URLSearchParams({ ids: missingGroups.join(',') })}`, { signal: request.signal }).then(value => {
      if (request.signal.aborted) return;
      const items = (value as { items?: unknown }).items, found: Record<string, string | null> = Object.fromEntries(missingGroups.map(p => [p, null]));
      if (!Array.isArray(items)) throw new AccessError(502);
      for (const item of items) { if (!item || typeof item.id !== 'string' || !missingGroups.includes(item.id) || !(item.group_id === null || (typeof item.group_id === 'string' && UUID_TEXT.test(item.group_id)))) throw new AccessError(502); found[item.id] = item.group_id; }
      setProductGroups(previous => ({ ...previous, ...found }));
    }).catch(() => { /* The rules of products, NCM and any product still apply; saving validates on the server. */ });
    return () => request.abort();
  }, [controller, missingGroups.join(',')]);
  // Contact search (destinatário, transportadora or pessoa autorizada) through the contacts picker (seller scope, contatos onda C).
  // Wave E: the transportadora searches the contacts of the Tipo de contato Transportador first, like the Origin autocomplete. Contacts
  // mirrored from the Origin arrive without Tipo de contato, so when no Transportador matches, every contact is searched (and said so).
  useEffect(() => {
    const q = contactQuery.trim(); if (q.length < 2) { setContacts([]); setContactsUntyped(false); return; }
    const request = new AbortController();
    const search = (role: string | null) => controller.catalog(`/v1/cadastros/contatos/opcoes?${new URLSearchParams({ limit: '25', q, ...(role ? { papel: role } : {}) })}`, { signal: request.signal })
      .then(v => (v as CatalogPage).items ?? []);
    const timer = setTimeout(() => { void (async () => {
      try {
        let items = await search(contactTarget === 'carrier' ? 'transportador' : null), untyped = false;
        if (contactTarget === 'carrier' && !items.length && !request.signal.aborted) { items = await search(null); untyped = items.length > 0; }
        if (!request.signal.aborted) { setContacts(items); setContactsUntyped(untyped); }
      } catch { if (!request.signal.aborted) { setContacts([]); setContactsUntyped(false); } }
    })(); }, 250);
    return () => { clearTimeout(timer); request.abort(); };
  }, [controller, contactQuery, contactTarget]);
  useEffect(() => {
    const q = sellerQuery.trim(); if (q.length < 2) { setSellers([]); return; }
    const request = new AbortController();
    const timer = setTimeout(() => { void controller.catalog(`/v1/cadastros/vendedores/opcoes?${new URLSearchParams({ q })}`, { signal: request.signal }).then(v => {
      if (request.signal.aborted) return;
      const items = (v as { items?: unknown }).items;
      setSellers(Array.isArray(items) ? items.filter((s): s is { id: string; name: string; code: string | null } => typeof s?.id === 'string' && UUID_TEXT.test(s.id) && typeof s.name === 'string').slice(0, 25) : []);
    }).catch(() => { if (!request.signal.aborted) setSellers([]); }); }, 250);
    return () => { clearTimeout(timer); request.abort(); };
  }, [controller, sellerQuery]);
  useEffect(() => {
    const search = productSearch; if (!search || search.query.trim().length < 2) return;
    const request = new AbortController();
    const timer = setTimeout(() => { void controller.catalog(`/v1/cadastros/products?${new URLSearchParams({ limit: '25', q: search.query.trim() })}`, { signal: request.signal }).then(v => { if (!request.signal.aborted) setProductSearch(s => s && s.index === search.index && s.query === search.query ? { ...s, results: (v as CatalogPage).items ?? [] } : s); }).catch(() => undefined); }, 250);
    return () => { clearTimeout(timer); request.abort(); };
  }, [controller, productSearch?.index, productSearch?.query]);

  const prefs = preferencesOf(context);
  // The volumes the preferences calculate ("Somar peso", "Calcular volume") are part of what is saved.
  const itemDiscount = context?.item_discount === true, manualDestination = context?.operation_destination_manual === true && draft?.model === '55';
  // Without "Preencher manualmente Destino da Operação" the destination follows the UFs (nothing is stored).
  const effective = useMemo(() => draft ? withItemDiscounts(withPreferenceVolumes(manualDestination ? draft : { ...draft, operation_destination: '' }, prefs), itemDiscount) : null, [draft, prefs, itemDiscount, manualDestination]);
  const computed = useMemo(() => {
    if (!effective) return null;
    try {
      const input = normalizeInvoiceInput(draftToInput(effective));
      const options = { companyState: context?.company.state ?? null, simplesCreditMessage: prefs.simples_credit_message, trackingInInfo: prefs.tracking_in_info, purchaseOrderInInfo: prefs.purchase_order_in_info,
        sellerName: effective.seller_name || null };
      const groups = Object.fromEntries(Object.entries(productGroups).filter(([, g]) => g !== null)) as Record<string, string>;
      const result = effective.auto_tax ? calculateInvoiceTaxes(input, { natures: details, settings, difalByState, orders: record?.orders ?? (group ? group.flatMap(orderOrigin) : origin ? orderOrigin(origin) : []), options, productGroups: groups }).invoice : input;
      return { input: result, totals: invoiceTotals(result) };
    } catch { return null; }
  }, [effective, details, settings, difalByState, record, context, prefs, origin, productGroups, group]);
  if (refusal) return <section className="real-state-panel" role="alert"><h1>Erro ao gerar a Nota fiscal</h1>
    <p>{refusal.document.kind === 'service_orders' ? 'Ordem de serviço' : refusal.document.kind === 'purchase_orders' ? 'Pedido de compra' : 'Pedido de venda'} nº {refusal.document.number}. Motivo:</p>
    <ul>{refusal.direction !== config.direction && <li>{refusal.direction === '0' ? 'O pedido de compra gera a nota em Notas fiscais de entrada.' : 'O pedido de venda e a ordem de serviço geram a nota em Notas fiscais de saída.'}</li>}
      {refusal.reasons.map(r => <li key={r.code}>{ORDER_REASONS[r.code]}{r.items.length ? ` Itens: ${r.items.join(', ')}.` : ''}</li>)}</ul>
    <button type="button" className="secondary-button" onClick={onBack}>Voltar à listagem</button></section>;
  if (loadError) return <section className="real-state-panel"><h1>Nota fiscal</h1><p role="alert">{loadError}</p><button type="button" className="secondary-button" onClick={onBack}>Voltar à listagem</button></section>;
  if (!draft || !context) return <section className="real-state-panel" role="status"><h1>Nota fiscal</h1><p>Carregando…</p></section>;

  // Functional updates: two edits in the same tick never overwrite each other.
  const update = (patch: Partial<InvoiceDraft> | ((d: InvoiceDraft) => Partial<InvoiceDraft>)) => { if (!editable || busy || uncertain) return; setDraft(d => d ? { ...d, ...(typeof patch === 'function' ? patch(d) : patch) } : d); setNotice(''); };
  const setNested = <K extends 'recipient' | 'export' | 'intermediary'>(key: K, field: string, value: string | boolean) => update(d => ({ [key]: { ...d[key], [field]: value } }) as Partial<InvoiceDraft>);
  const registered = REGISTERED.includes(draft.issue_type);
  const seriesInfo = context.series.find(s => String(s.series) === draft.series);
  const crtNatures = natures.filter(n => n.direction === draft.direction && n.crt === draft.crt);
  const shownNatures = crtNatures.filter(n => !natureQuery.trim() || n.description.toLowerCase().includes(natureQuery.trim().toLowerCase()));
  const headerNature = details[draft.nature_id];
  const cfop = computed?.input.cfop ?? draft.cfop;
  const pickNature = (n: NatureSummary) => update({ nature_id: n.id, nature_description: n.description, presence: draft.model === '65' ? (n.presence === '4' ? '4' : '1') : n.presence, final_consumer: draft.model === '65' ? true : n.final_consumer, ...(n.series !== null && !registered ? { series: String(n.series) } : {}) });
  const save = async () => {
    if (busy || command.current) return;
    if (!editable) { setError('Seu perfil ou a situação da nota não permite salvar.'); return; }
    let input: InvoiceInput;
    const base = effective ?? draft;
    if (draft.auto_tax) { if (!computed) { const checked = checkDraft(base); setError('error' in checked ? checked.error : 'Confira os campos da nota.'); return; } input = computed.input; }
    else { const checked = checkDraft(base); if ('error' in checked) { setError(checked.error); return; } input = checked.input; }
    // Parcels locked by the contas already posted by the pedido cannot change, so their sum never blocks the save (the database agrees).
    const mismatch = locks.installments ? null : installmentsMismatch(draft, centsOf(invoiceTotals(input).totals.total), prefs);
    if (mismatch) { setError(mismatch); setTab('pagamento'); return; }
    const body = record ? { expected_version: record.version, invoice: input, orders: draft.orders } : { invoice: input, orders: draft.orders };
    command.current = { id: crypto.randomUUID(), actor: actor.current, body, path: record ? `${FISCAL_BASE}/${record.id}` : FISCAL_BASE, method: record ? 'PATCH' : 'POST', uncertain: false, expectedVersion: record?.version ?? null };
    await send();
  };
  const send = async () => {
    const op = command.current; if (!op || inflight.current) return;
    if (actorOf(controller) !== op.actor || !['admin', 'fiscal'].includes(roleOf(controller))) { command.current = null; setUncertain(false); setError('A sessão ou o perfil mudou. Confira a nota na listagem antes de repetir.'); return; }
    const request = new AbortController(); inflight.current = request; setBusy(true); setError(''); setNotice('');
    try {
      const value = await controller.fiscalInvoices(op.path, { method: op.method, body: { ...op.body, command_id: op.id }, signal: AbortSignal.any([request.signal, life.current.signal]) }) as { invoice: unknown };
      if (request.signal.aborted || life.current.signal.aborted) return;
      const saved = invoiceRecord(value?.invoice);
      if (op.expectedVersion === null ? saved.version !== 1 : saved.id !== record?.id || saved.version !== op.expectedVersion + 1) throw new AccessError(502);
      command.current = null; setUncertain(false);
      const next = recordToDraft(saved); setRecord(saved); setDraft(next); setBaseline(JSON.stringify(next)); setNotice('Nota salva. Nenhuma emissão, estoque ou conta foi lançado.');
      // Until the next render the guard still sees this save as busy and dirty: the navigation to the saved note is already confirmed.
      if (op.expectedVersion === null) guard.store.runConfirmed(() => onSaved(saved));
    } catch (problem) {
      if (request.signal.aborted || aborted(problem)) return;
      if (!op.uncertain && known(problem)) { command.current = null; setError(problem instanceof AccessError && problem.status === 409 ? op.method === 'POST' && Array.isArray(op.body.orders) && op.body.orders.length
        // 202610200215: one note per pedido, also when two tabs of "Gerar nota fiscal" save the same pedido.
        ? 'A nota não foi salva: o pedido de origem já tem nota fiscal (salva em outra aba ou por outro usuário). Confira na listagem.'
        : 'A nota mudou em outra tela ou não pode mais ser editada. Volte à listagem e abra de novo.' : problem instanceof AccessError && problem.status === 400 ? 'O servidor recusou os dados. Confira os campos destacados nas abas.' : 'Seu perfil não permite salvar esta nota.'); }
      else { op.uncertain = true; setUncertain(true); setError('Não foi possível confirmar se a nota foi salva. Use "Conferir resultado" para repetir o mesmo comando sem duplicar.'); }
    } finally { if (inflight.current === request) inflight.current = null; if (!request.signal.aborted) setBusy(false); }
  };
  const cancel = () => guard.confirmLeave(onBack);
  const locked = !editable || busy || uncertain;
  // 'Bloquear edição da nota quando o estoque/a conta foi lançado(a) pela venda' (the server refuses the same changes).
  const itemsLocked = locked || locks.items, paymentLocked = locked || locks.installments;
  const field = (id: string, label: string, control: ReactNode, wide = false) => <div className={`form-field${wide ? ' fiscal-wide' : ''}`}><label htmlFor={id}>{label}</label>{control}</div>;
  const select = (id: string, value: string, options: readonly (readonly [string, string])[], onChange: (value: string) => void, extra?: { empty?: string; disabled?: boolean }) =>
    <select id={id} value={value} disabled={locked || extra?.disabled} onChange={event => onChange(event.target.value)}>{extra?.empty !== undefined && <option value="">{extra.empty}</option>}{options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>;
  const text = (id: string, value: string, onChange: (value: string) => void, extra?: { max?: number; placeholder?: string; disabled?: boolean; inputMode?: 'numeric' | 'decimal' }) =>
    <input id={id} value={value} maxLength={extra?.max ?? 60} placeholder={extra?.placeholder} inputMode={extra?.inputMode} disabled={locked || extra?.disabled} onChange={event => onChange(event.target.value)} />;
  const totals = computed?.totals.totals ?? null;
  const itemTotal = (index: number) => computed?.totals.lines[index] ?? null;

  const headerTab = <div className="document-grid">
    {field('fiscal-issue-type', draft.direction === '0' ? 'Tipo de Entrada*' : 'Tipo de saída*', <select id="fiscal-issue-type" value={draft.issue_type} disabled={locked || draft.model === '65'} onChange={event => update({ issue_type: event.target.value })}>
      {issueOptions(draft.direction, draft.model).map(([v, l]) => <option key={v} value={v} disabled={v === 'S' || v === 'X'} title={v === 'S' || v === 'X' ? 'Notas de XML são registradas por "Importar XML NF-e" (Mais ações da lista).' : undefined}>{l}</option>)}</select>)}
    {field('fiscal-series', 'Série*', text('fiscal-series', draft.series, value => update({ series: value.replace(/\D/g, '') }), { max: 3, inputMode: 'numeric' }))}
    {field('fiscal-number', 'Número*', registered ? text('fiscal-number', draft.number, value => update({ number: value.replace(/\D/g, '') }), { max: 9, inputMode: 'numeric' })
      : <><input id="fiscal-number" disabled value={record?.number ? String(record.number) : ''} placeholder={seriesInfo ? String(seriesInfo.next_number) : 'Definido no envio'} /><small className="real-help" title="O número pode ser alterado ao gravar caso outro usuário já tenha inserido uma nota com o mesmo número">O número é reservado na série de homologação quando a nota for enviada.</small></>)}
    {registered && field('fiscal-access-key', 'Chave de acesso', text('fiscal-access-key', draft.access_key, value => update({ access_key: value.replace(/\D/g, '') }), { max: 44, inputMode: 'numeric' }), true)}
    <div className="form-field fiscal-wide"><label htmlFor="fiscal-nature-search">Natureza de operação*</label>
      {draft.nature_id ? <span className="documents-picked"><span>{draft.nature_description}</span>{!locked && <button type="button" className="text-button" onClick={() => update({ nature_id: '', nature_description: '' })}>Trocar</button>}</span>
        : crtNatures.length ? <><input id="fiscal-nature-search" type="search" placeholder="Pesquise aqui..." value={natureQuery} disabled={locked} onChange={event => setNatureQuery(event.target.value)} />
          <ul className="fiscal-picker" role="listbox" aria-label="Naturezas de operação">{shownNatures.slice(0, 20).map(n => <li key={n.id}><button type="button" disabled={locked} onClick={() => pickNature(n)}>{n.description}{n.defaults.length ? ' · padrão' : ''}</button></li>)}</ul></>
          : <p className="real-help">Não encontramos nenhuma natureza cadastrada <a href="/naturezas-operacao">Adicionar Naturezas de Operação</a></p>}</div>
    {field('fiscal-cfop', 'CFOP', <input id="fiscal-cfop" readOnly value={cfop ?? ''} />)}
    {field('fiscal-issue-date', 'Data de emissão*', <input id="fiscal-issue-date" type="date" value={draft.issue_date} disabled={locked} onChange={event => update({ issue_date: event.target.value })} />)}
    {field('fiscal-issue-time', 'Hora de emissão', <input id="fiscal-issue-time" disabled value="" title="A hora da emissão é atualizada automaticamente quando a nota é emitida" placeholder="--:--" />)}
    {field('fiscal-exit-date', draft.direction === '0' ? 'Data entrada' : 'Data saída', <input id="fiscal-exit-date" type="date" value={draft.exit_date} disabled={locked} onChange={event => update({ exit_date: event.target.value })} />)}
    {field('fiscal-exit-time', draft.direction === '0' ? 'Hora entrada' : 'Hora saída', <input id="fiscal-exit-time" type="time" value={draft.exit_time} disabled={locked} onChange={event => update({ exit_time: event.target.value })} />)}
    {field('fiscal-crt', 'Código do regime tributário*', select('fiscal-crt', draft.crt, CRT_OPTIONS, value => update({ crt: value, nature_id: '', nature_description: '' })))}
    {field('fiscal-purpose', 'Finalidade*', select('fiscal-purpose', draft.purpose, PURPOSE_OPTIONS, value => update({ purpose: value, credit_debit_type: '' }), { disabled: draft.model === '65' }))}
    {['5', '6'].includes(draft.purpose) && field('fiscal-credit-type', 'Tipo de nota', text('fiscal-credit-type', draft.credit_debit_type, value => update({ credit_debit_type: value.replace(/\D/g, '') }), { max: 2, placeholder: '0 - Não se aplica', inputMode: 'numeric' }))}
    {field('fiscal-presence', 'Indicador de presença*', select('fiscal-presence', draft.presence, draft.model === '65' ? PRESENCE_OPTIONS.filter(([v]) => v === '1' || v === '4') : PRESENCE_OPTIONS, value => update({ presence: value })))}
    {manualDestination && field('fiscal-destination-op', 'Destino da Operação', select('fiscal-destination-op', draft.operation_destination, DESTINATION_OPTIONS, value => update({ operation_destination: value }), { empty: 'Pela UF do destinatário' }))}
  </div>;
  const addReference = () => {
    const ref: Values = Object.fromEntries(Object.entries(refDraft).filter(([, v]) => v !== '')) as Values;
    if (['nfe', 'cte'].includes(String(ref.type))) {
      const key = digits(ref.key);
      if (!key) { setRefError('Informe uma chave de acesso'); return; }
      if (key.length !== 44) { setRefError('A chave deve ter 44 dígitos'); return; }
      if (draft.references.some(r => r.key === key)) { setRefError('Esta chave já foi adicionada'); return; }
      ref.key = key; delete ref.year_month; delete ref.number; delete ref.series;
    }
    setRefError(''); update({ references: [...draft.references, ref] }); setRefDraft({ type: refDraft.type });
  };
  // The note of a referenced key, as the Brufap notes and the Origin XML archive know it (nothing is stored with the reference).
  const referenceFound = (key: string) => {
    const found = lookups[key];
    if (found === undefined) return null;
    if (found === 'error') return <small className="real-help"> · não foi possível conferir a chave.</small>;
    if (!found.length) return <small className="real-help"> · chave não encontrada nas notas do FAGOO nem no acervo de XML do Origin.</small>;
    return <small className="real-help">{found.map(n => ` · ${n.model === '65' ? 'NFC-e' : 'NF-e'} ${n.number === null ? 'sem número' : `nº ${String(n.number).padStart(6, '0')}`}${n.issue_date ? ` de ${n.issue_date.split('-').reverse().join('/')}` : ''}${n.name ? ` · ${n.name}` : ''}${n.total ? ` · ${decimalMoney(n.total)}` : ''} (${n.origin === 'origin' ? 'nota do Origin' : 'nota do FAGOO'})`).join('')}</small>;
  };
  const referenceTab = <>
    <div className="document-grid">
      {field('fiscal-ref-type', 'Tipo', select('fiscal-ref-type', String(refDraft.type ?? 'nfe'), REFERENCE_OPTIONS, value => setRefDraft({ type: value })))}
      {['nfe', 'cte'].includes(String(refDraft.type)) ? field('fiscal-ref-key', 'Chave de acesso', <input id="fiscal-ref-key" maxLength={44} inputMode="numeric" disabled={locked} value={String(refDraft.key ?? '')} title="Use este campo para incluir notas ou documentos fiscais relacionados à operação, como devoluções, complementos ou ajustes." onChange={event => setRefDraft(r => ({ ...r, key: event.target.value }))} />, true)
        : <>{refDraft.type !== 'ecf' && field('fiscal-ref-year-month', 'Ano e mês de emissão', <input id="fiscal-ref-year-month" maxLength={4} placeholder="AAMM" disabled={locked} value={String(refDraft.year_month ?? '')} onChange={event => setRefDraft(r => ({ ...r, year_month: event.target.value.replace(/\D/g, '') }))} />)}
          {field('fiscal-ref-number', 'Número', <input id="fiscal-ref-number" maxLength={9} disabled={locked} value={String(refDraft.number ?? '')} onChange={event => setRefDraft(r => ({ ...r, number: event.target.value.replace(/\D/g, '') }))} />)}
          {refDraft.type !== 'ecf' && field('fiscal-ref-series', 'Série', <input id="fiscal-ref-series" maxLength={3} disabled={locked} value={String(refDraft.series ?? '')} title="Caso não tenha a série, preencha este campo com 0 (zero)" onChange={event => setRefDraft(r => ({ ...r, series: event.target.value.replace(/\D/g, '') }))} />)}</>}
    </div>
    <button type="button" className="secondary-button" disabled={locked} onClick={addReference}>Incluir mais</button>{refError && <p className="real-alert" role="alert">{refError}</p>}
    {draft.references.length ? <table className="data-table document-responsive-table"><thead><tr><th>Chave de acesso / Série / Número</th><th><span className="sr-only">Ações</span></th></tr></thead><tbody>{draft.references.map((r, index) => <tr key={index}><td data-label="Documento referenciado" className="document-cell-wide">{REFERENCE_OPTIONS.find(([v]) => v === r.type)?.[1]} · {r.key ? String(r.key) : `${r.series ?? ''} / ${r.number ?? ''}`}{typeof r.key === 'string' && referenceFound(r.key)}</td>
      <td data-label="Ações"><button type="button" className="icon-button" aria-label="Remover documento referenciado" title="Remover documento referenciado" disabled={locked} onClick={() => update({ references: draft.references.filter((_, i) => i !== index) })}><Icon name="trash-can" size={12} /></button></td></tr>)}</tbody></table> : <p className="real-help">Nenhum item registrado</p>}
  </>;
  const pickContact = (contact: CatalogRecord, target: typeof contactTarget = contactTarget) => {
    setContactQuery(''); setContacts([]);
    if (target === 'recipient') {
      const recipient = contactToRecipient(contact);
      const code = defaultNatureCode(draft.direction, draft.model, String(recipient.person_type ?? '')).find(c => context.defaults[c]);
      const nature = !draft.nature_id && code ? context.defaults[code] : null;
      update({ recipient, ...(nature ? { nature_id: nature.id, nature_description: nature.description } : {}) });
      readContact(contact.id, 'recipient');
    } else if (target === 'carrier') {
      const document = digits(contact.document), valid = document.length === 14 || document.length === 11;
      // "Incluir transportadora como pessoa autorizada" (Preferências): the carrier joins the authorized people of the note.
      const authorize = prefs.autxml_carrier && valid && draft.authorized_xml.length < 10 && !draft.authorized_xml.some(a => a.document === document);
      update({ transport: { ...draft.transport, carrier: { contact_id: contact.id, name: contact.name.slice(0, 60), ...(valid ? { document } : {}), ...(typeof contact.state === 'string' && /^[A-Z]{2}$/.test(contact.state) ? { state: contact.state } : {}), ...(typeof contact.city === 'string' && contact.city ? { city: contact.city.slice(0, 60) } : {}) } },
        ...(authorize ? { authorized_xml: [...draft.authorized_xml, { contact_id: contact.id, name: contact.name.slice(0, 60), document }] } : {}) });
      readContact(contact.id, 'carrier');
    }
    else { const document = digits(contact.document); if (document.length !== 11 && document.length !== 14) { setError('O contato precisa de CPF ou CNPJ para acessar o XML.'); return; } if (draft.authorized_xml.length >= 10 || draft.authorized_xml.some(a => a.document === document)) return; update({ authorized_xml: [...draft.authorized_xml, { contact_id: contact.id, name: contact.name.slice(0, 60), document }] }); }
  };
  // 202610200215: the cadastro of the picked contact completes the note (Contribuinte, e-mail da NF-e, natureza padrão and vendedor of the
  // contact; IE and endereço of the transportadora). A late answer, another contact picked meanwhile or a changed session is ignored.
  const readContact = (contactId: string, target: 'recipient' | 'carrier') => {
    const reads = contactRead.current; reads[target]?.abort(); const request = new AbortController(); reads[target] = request; const who = actor.current;
    void controller.fiscalInvoices(`${FISCAL_BASE}/contato/${contactId}?direction=${draft.direction}`, { signal: request.signal }).then(value => {
      if (request.signal.aborted || actorOf(controller) !== who) return;
      const source = contactSourceRecord(value, contactId), c = source.contact;
      setDraft(d => {
        if (!d) return d;
        if (target === 'carrier') {
          if (d.transport.carrier.contact_id !== contactId) return d;
          return { ...d, transport: { ...d.transport, carrier: { ...d.transport.carrier, ...carrierValues(c) } } };
        }
        if (d.recipient.contact_id !== contactId) return d;
        const email = c.nfe_email && /^[^\s@]+@[^\s@]+$/.test(c.nfe_email.trim()) && c.nfe_email.trim().length <= 60 ? c.nfe_email.trim() : null;
        const nature = source.nature && source.nature.crt === d.crt ? source.nature : null;
        // Like picking the natureza by hand (pickNature): its presença, consumidor final and série follow it.
        const summary = nature ? natures.find(n => n.id === nature.id) ?? null : null;
        const follow = summary ? { presence: d.model === '65' ? (summary.presence === '4' ? '4' : '1') : summary.presence, final_consumer: d.model === '65' ? true : summary.final_consumer,
          ...(summary.series !== null && !REGISTERED.includes(d.issue_type) ? { series: String(summary.series) } : {}) } : {};
        return { ...d, recipient: { ...d.recipient, ...(c.taxpayer ? { ie_indicator: c.taxpayer } : {}), ...(email ? { email } : {}) },
          ...(nature ? { nature_id: nature.id, nature_description: nature.description, ...follow } : {}),
          ...(source.seller && !d.seller_id ? { seller_id: source.seller.id, seller_name: source.seller.name } : {}) };
      });
    }).catch(() => { /* The note keeps what the contact list gave; nothing else is filled. */ }).finally(() => { if (reads[target] === request) reads[target] = null; });
  };
  const contactSearch = (target: typeof contactTarget, id: string, placeholder: string) => <span className="fiscal-contact-search">
    <input id={id} type="search" placeholder={placeholder} disabled={locked} value={contactTarget === target ? contactQuery : ''} onChange={event => { setContactTarget(target); setContactQuery(event.target.value); }} />
    {contactTarget === target && contacts.length > 0 && target === 'carrier' && contactsUntyped && <span className="real-help" role="status">Nenhum contato com o Tipo de contato Transportador: a busca mostra todos os contatos (os contatos do Origin chegam sem tipo).</span>}
    {contactTarget === target && contacts.length > 0 && <ul className="fiscal-picker" role="listbox" aria-label="Contatos">{contacts.map(c => <li key={c.id}><button type="button" onClick={() => pickContact(c)}>{c.name}{typeof c.document === 'string' && c.document ? ` · ${c.document}` : ''}</button></li>)}</ul>}</span>;
  const r = draft.recipient;
  const recipientTab = <>
    <div className="document-grid">
      <div className="form-field fiscal-wide"><label htmlFor="fiscal-recipient-name">Nome do contato{draft.model === '55' ? '*' : ''}</label>
        {text('fiscal-recipient-name', String(r.name ?? ''), value => setNested('recipient', 'name', value))}
        <span className="fiscal-inline-actions">{contactSearch('recipient', 'fiscal-recipient-search', 'Pesquisar')}
          <button type="button" className="icon-button" title={CONTACT_WRITER_ROLES.includes(role) ? 'Adicionar novo' : 'Seu perfil não cadastra contatos.'} aria-label="Adicionar novo" disabled={locked || !CONTACT_WRITER_ROLES.includes(role)} onClick={() => setQuickContact(true)}><Icon name="plus" size={12} /></button></span></div>
      {field('fiscal-recipient-type', 'Tipo da pessoa*', select('fiscal-recipient-type', String(r.person_type ?? ''), PERSON_OPTIONS, value => setNested('recipient', 'person_type', value), { empty: 'Selecione' }))}
      {r.person_type === 'E' ? field('fiscal-recipient-foreign', 'Identificação do estrangeiro', text('fiscal-recipient-foreign', String(r.foreign_id ?? ''), value => setNested('recipient', 'foreign_id', value), { max: 20 }))
        : field('fiscal-recipient-document', 'CNPJ / CPF', text('fiscal-recipient-document', String(r.document ?? ''), value => setNested('recipient', 'document', value.replace(/\D/g, '')), { max: 14, inputMode: 'numeric' }))}
      {field('fiscal-recipient-ie', 'Inscrição Estadual', text('fiscal-recipient-ie', String(r.ie ?? ''), value => setNested('recipient', 'ie', value.toUpperCase().replace(/[^0-9A-Z]/g, '')), { max: 14 }))}
      {field('fiscal-recipient-ie-indicator', 'Contribuinte', select('fiscal-recipient-ie-indicator', String(r.ie_indicator ?? ''), IE_OPTIONS, value => setNested('recipient', 'ie_indicator', value), { empty: 'Selecione' }))}
      <div className="form-field"><label htmlFor="fiscal-recipient-seller">Vendedor</label>
        {draft.seller_id ? <span className="documents-picked"><span>{draft.seller_name || 'Vendedor'}</span>{!locked && <button type="button" className="text-button" onClick={() => update({ seller_id: '', seller_name: '' })}>Trocar</button>}</span>
          : <span className="fiscal-contact-search"><input id="fiscal-recipient-seller" type="search" placeholder="Pesquisar vendedor" disabled={locked} value={sellerQuery} onChange={event => setSellerQuery(event.target.value)} />
            {sellers.length > 0 && <ul className="fiscal-picker" role="listbox" aria-label="Vendedores">{sellers.map(s => <li key={s.id}><button type="button" onClick={() => { update({ seller_id: s.id, seller_name: s.name.slice(0, 200) }); setSellerQuery(''); setSellers([]); }}>{s.name}{s.code ? ` · ${s.code}` : ''}</button></li>)}</ul>}</span>}</div>
      <div className="form-field"><label htmlFor="fiscal-final-consumer"><input id="fiscal-final-consumer" type="checkbox" checked={draft.final_consumer} disabled={locked || draft.model === '65'} onChange={event => update({ final_consumer: event.target.checked })} /> Consumidor final</label></div>
      {([['postal_code', 'CEP', 8], ['state', 'UF', 2], ['city', 'Município', 60], ['district', 'Bairro', 60], ['street', 'Endereço', 60], ['number', 'Número', 60], ['complement', 'Complemento', 60], ['phone', 'Fone/FAX', 14], ['email', 'E-mail', 60]] as const).map(([key, label, max]) =>
        key === 'state' ? <div key={key}>{field('fiscal-recipient-state', 'UF', select('fiscal-recipient-state', String(r.state ?? ''), UF_EX_OPTIONS, value => setNested('recipient', 'state', value), { empty: 'UF ...' }))}</div>
          : <div key={key}>{field(`fiscal-recipient-${key}`, label, text(`fiscal-recipient-${key}`, String(r[key] ?? ''), value => setNested('recipient', key, key === 'postal_code' || key === 'phone' ? value.replace(/\D/g, '') : value), { max }))}</div>)}
    </div>
    {/* Preferências › Vendas / Suprimentos "Permite a visualização das contas a receber / a pagar em aberto nos pedidos/notas fiscais". */}
    {typeof r.contact_id === 'string' && UUID_TEXT.test(r.contact_id) && (draft.direction === '1' ? context.open_titles?.receivable : context.open_titles?.payable)
      && <FinanceContactOpenTitles key={`${r.contact_id}:${actor.current ?? ''}`} controller={controller} contactId={r.contact_id} kind={draft.direction === '1' ? 'receivable' : 'payable'} />}
    {draft.issue_type === 'E' && <fieldset className="fiscal-group"><legend>Dados de Exportação</legend><div className="document-grid">
      {field('fiscal-export-place', 'Local de Embarque', text('fiscal-export-place', String(draft.export.exit_place ?? ''), value => setNested('export', 'exit_place', value)))}
      {field('fiscal-export-state', 'UF Embarque', select('fiscal-export-state', String(draft.export.exit_state ?? ''), UF_OPTIONS, value => setNested('export', 'exit_state', value), { empty: 'UF ...' }))}</div></fieldset>}
    {draft.issue_type === 'I' && <fieldset className="fiscal-group"><legend>Declaração de Importação</legend><div className="document-grid">
      {([['number', 'Número da DI', 15], ['exporter_code', 'Código do Exportador', 60], ['customs_expenses', 'Despesas Aduaneiras', 20], ['clearance_place', 'Local Desembaraço', 60], ['afrmm_value', 'Valor da AFRMM', 20], ['acquirer_cnpj', 'CNPJ do adquirente', 14]] as const).map(([key, label, max]) =>
        <div key={key}>{field(`fiscal-di-${key}`, label, text(`fiscal-di-${key}`, String(draft.import_declaration[key] ?? ''), value => update({ import_declaration: { ...draft.import_declaration, [key]: value } }), { max }))}</div>)}
      {([['registration_date', 'Data de Registro da DI'], ['clearance_date', 'Data Desembaraço']] as const).map(([key, label]) => <div key={key}>{field(`fiscal-di-${key}`, label, <input id={`fiscal-di-${key}`} type="date" disabled={locked} value={String(draft.import_declaration[key] ?? '')} onChange={event => update({ import_declaration: { ...draft.import_declaration, [key]: event.target.value } })} />)}</div>)}
      {([['clearance_state', 'UF Desembaraço', UF_OPTIONS], ['acquirer_state', 'UF do adquirente', UF_OPTIONS], ['transport_route', 'Via de transporte', ROUTE_OPTIONS], ['intermediation', 'Forma de importação', IMPORT_FORM_OPTIONS]] as const).map(([key, label, options]) =>
        <div key={key}>{field(`fiscal-di-${key}`, label, select(`fiscal-di-${key}`, String(draft.import_declaration[key] ?? ''), options, value => update({ import_declaration: { ...draft.import_declaration, [key]: value } }), { empty: 'Selecione' }))}</div>)}
      <div className="form-field"><label htmlFor="fiscal-di-unit-ii"><input id="fiscal-di-unit-ii" type="checkbox" disabled={locked} checked={Boolean(draft.import_declaration.unit_value_with_ii)} onChange={event => update({ import_declaration: { ...draft.import_declaration, unit_value_with_ii: event.target.checked } })} /> Valor unitário do item com Imposto de Importação</label></div></div>
      <h3>Adições</h3>{(draft.import_declaration.additions ?? []).map((a, index) => <div className="document-grid" key={index}>{([['number', 'Número adição'], ['sequence', 'Número sequencial adição'], ['manufacturer', 'Código fabricante'], ['discount', 'Valor desconto DI (opcional)'], ['drawback', 'Número drawback (opcional)']] as const).map(([key, label]) =>
        <div key={key}>{field(`fiscal-addition-${index}-${key}`, label, text(`fiscal-addition-${index}-${key}`, String(a[key] ?? ''), value => update({ import_declaration: { ...draft.import_declaration, additions: (draft.import_declaration.additions ?? []).map((x, i) => i === index ? { ...x, [key]: value } : x) } })))}</div>)}
        <button type="button" className="icon-button" aria-label="Remover adição" disabled={locked} onClick={() => update({ import_declaration: { ...draft.import_declaration, additions: (draft.import_declaration.additions ?? []).filter((_, i) => i !== index) } })}><Icon name="trash-can" size={12} /></button></div>)}
      <button type="button" className="secondary-button" disabled={locked} onClick={() => update({ import_declaration: { ...draft.import_declaration, additions: [...(draft.import_declaration.additions ?? []), {}] } })}>Incluir adição</button></fieldset>}
  </>;
  const setItem = (index: number, patch: ItemDraft) => update(d => ({ items: d.items.map((item, i) => i === index ? { ...item, ...patch } : item) }));
  const pickProduct = (index: number, product: CatalogRecord) => {
    const ncm = typeof product.ncm === 'string' && /^\d{8}$/.test(product.ncm) ? product.ncm : undefined, gtin = typeof product.gtin === 'string' && /^(\d{8}|\d{12,14})$/.test(product.gtin) ? product.gtin : undefined;
    const gross = weight3(product.gross_weight), net = weight3(product.net_weight), volumes = typeof product.volumes === 'string' || typeof product.volumes === 'number' ? String(product.volumes) : '';
    setItem(index, { product_id: product.id, description: product.name.slice(0, 120), ...(product.code ? { code: String(product.code).slice(0, 60) } : {}), ...(typeof product.unit === 'string' && product.unit ? { unit: product.unit.slice(0, 6) } : {}),
      ...(typeof product.price === 'string' && /^\d+(\.\d+)?$/.test(product.price) && !draft.items[index]?.unit_price ? { unit_price: product.price } : {}), ...(ncm ? { ncm } : {}), ...(gtin ? { gtin } : {}),
      // Product weights and volumes feed "Somar peso dos produtos" and "Calcular volume dos produtos".
      ...(gross ? { gross_weight: gross } : {}), ...(net ? { net_weight: net } : {}), ...(/^[1-9]\d{0,5}$/.test(volumes) ? { volumes } : {}) });
    setProductSearch(null);
  };
  // Origin: atualizar ou criar produto a partir da nota, informações de lote, depósitos e histórico do produto para o contato.
  const productWriter = PRODUCT_WRITER_ROLES.includes(role);
  const itemIcons = (item: ItemDraft, index: number) => {
    const productId = typeof item.product_id === 'string' && UUID_TEXT.test(item.product_id) ? item.product_id : null;
    const contactId = typeof draft.recipient.contact_id === 'string' && UUID_TEXT.test(draft.recipient.contact_id) ? draft.recipient.contact_id : null;
    const productTitle = !productWriter ? 'Seu perfil não cadastra produtos (administrador e estoque).' : productId ? 'Atualizar produto a partir da nota' : !String(item.description ?? '').trim() ? 'Informe a descrição do item.' : 'Criar produto a partir da nota';
    const historyTitle = !productId ? 'Escolha um produto do cadastro no item.' : !contactId ? 'Escolha o contato da nota no cadastro.' : draft.direction === '1' ? 'Histórico do produto para o cliente' : 'Histórico do produto para o fornecedor';
    return <>
      <button type="button" className="icon-button" title={productTitle} aria-label={`${productId ? 'Atualizar' : 'Criar'} produto a partir do item ${index + 1}`} disabled={!productWriter || busy || uncertain || (!productId && (itemsLocked || !String(item.description ?? '').trim()))} onClick={() => setItemProduct(index)}><Icon name={productId ? 'arrows-rotate' : 'box'} size={12} /></button>
      <button type="button" className="icon-button" title={!productId ? 'Escolha um produto do cadastro no item.' : !record ? 'Salve a nota antes de consultar os lotes.' : !LOT_ROLES.includes(role) ? 'Seu perfil não consulta os lotes do estoque da nota (administrador, estoque e fiscal).' : 'Informações de lote'} aria-label={`Informações de lote do item ${index + 1}`} disabled={!productId || !record || !LOT_ROLES.includes(role)} onClick={() => setItemLots(index)}><Icon name="tag" size={12} /></button>
      {productId ? <a className="icon-button" href={`/estoque-empresa?produto=${productId}`} target="_blank" rel="noreferrer" title="Depósitos (saldo do produto em cada depósito)" aria-label={`Depósitos do produto do item ${index + 1}`}><Icon name="warehouse" size={12} /></a>
        : <button type="button" className="icon-button" title="Escolha um produto do cadastro no item." aria-label={`Depósitos do produto do item ${index + 1}`} disabled><Icon name="warehouse" size={12} /></button>}
      <button type="button" className="icon-button" title={historyTitle} aria-label={`Histórico do produto do item ${index + 1}`} disabled={!productId || !contactId} onClick={() => setItemHistory(index)}><Icon name="clock-rotate-left" size={12} /></button></>;
  };
  const itemsTab = <>
    {imported(record) && canWrite && record!.deleted_at === null && <FiscalReconcilePanel controller={controller} record={record!} onSaved={saved => { const next = recordToDraft(saved); setRecord(saved); setDraft(next); setBaseline(JSON.stringify(next)); }} />}
    {draft.items.length ? <div className="table-scroll" tabIndex={0}><table className="data-table fiscal-items document-responsive-table"><thead><tr><th>#</th><th>Produto ou serviço</th><th>Código</th><th>UN</th><th className="numeric">Qtde</th><th className="numeric">Preço un</th><th className="numeric">Preço total</th><th>NCM</th><th><span className="sr-only">Ações</span></th></tr></thead>
      <tbody>{draft.items.map((item, index) => <tr key={index}><td data-label="Item">{index + 1}</td>
        <td data-label="Produto ou serviço" className="document-cell-wide"><input aria-label={`Produto ou serviço do item ${index + 1}`} placeholder="Digite parte do nome ou código do item" maxLength={120} disabled={itemsLocked} value={String(item.description ?? '')} onChange={event => { setItem(index, { description: event.target.value, product_id: undefined }); setProductSearch({ index, query: event.target.value, results: [] }); }} />
          {productSearch?.index === index && productSearch.results.length > 0 && <ul className="fiscal-picker" role="listbox" aria-label="Produtos">{productSearch.results.map(p => <li key={p.id}><button type="button" onClick={() => pickProduct(index, p)}>{p.name}{p.code ? ` · ${p.code}` : ''}</button></li>)}</ul>}</td>
        <td data-label="Código"><input aria-label={`Código do item ${index + 1}`} maxLength={60} disabled={itemsLocked} value={String(item.code ?? '')} onChange={event => setItem(index, { code: event.target.value })} /></td>
        <td data-label="Unidade"><input aria-label={`Unidade do item ${index + 1}`} maxLength={6} disabled={itemsLocked} value={String(item.unit ?? '')} onChange={event => setItem(index, { unit: event.target.value })} /></td>
        <td data-label="Quantidade"><input aria-label={`Quantidade do item ${index + 1}`} inputMode="decimal" disabled={itemsLocked} value={String(item.quantity ?? '')} onChange={event => setItem(index, { quantity: event.target.value })} /></td>
        <td data-label="Preço unitário"><input aria-label={`Preço unitário do item ${index + 1}`} inputMode="decimal" disabled={itemsLocked} value={String(item.unit_price ?? '')} onChange={event => setItem(index, { unit_price: event.target.value })} /></td>
        <td className="numeric" data-label="Preço total">{itemTotal(index) ? decimalMoney(itemTotal(index)) : '—'}</td>
        <td data-label="NCM"><input aria-label={`NCM do item ${index + 1}`} maxLength={8} inputMode="numeric" disabled={itemsLocked} value={String(item.ncm ?? '')} onChange={event => setItem(index, { ncm: event.target.value.replace(/\D/g, '') })} /></td>
        <td className="fiscal-item-icons document-cell-wide" data-label="Ações">{itemIcons(item, index)}<button type="button" className="icon-button" title="Editar" aria-label={`Editar item ${index + 1}`} onClick={() => setItemIndex(index)}><Icon name="pen-to-square" size={12} /></button>
          <button type="button" className="icon-button" title="Remover item do pedido" aria-label={`Remover item ${index + 1}`} disabled={itemsLocked} onClick={() => update({ items: draft.items.filter((_, i) => i !== index) })}><Icon name="trash-can" size={12} /></button></td></tr>)}</tbody></table></div>
      : <p className="real-help">Nenhum item registrado</p>}
    <button type="button" className="text-button" disabled={itemsLocked} onClick={() => update({ items: [...draft.items, { description: '', quantity: '1', unit_price: '', unit: 'UN' }] })}><Icon name="plus" size={10} /> Adicionar outro item</button>
  </>;
  const money = (key: 'freight' | 'insurance' | 'other_expenses' | 'discount', label: string) => key === 'discount' && itemDiscount
    // The note discount is the sum of the item discounts (Preferências › Configurações de NF-e › Informar desconto individualmente nos itens).
    ? field('fiscal-discount', label, <input id="fiscal-discount" readOnly value={effective?.discount ?? ''} placeholder="0,00" title="Soma dos descontos dos itens. O desconto é informado em cada item (Preferências › Configurações de NF-e)." />)
    : field(`fiscal-${key}`, label, text(`fiscal-${key}`, draft[key], value => update({ [key]: value } as Partial<InvoiceDraft>), { max: 20, inputMode: 'decimal', placeholder: '0,00' }));
  const total = (label: string, key: string, tip?: string) => <div className="native-list-stat" key={key} title={tip}><dt>{label}</dt><dd>{totals ? decimalMoney(totals[key]) : '—'}</dd></div>;
  const toggleAuto = () => { if (locked) return; if (draft.auto_tax && computed) { const next = recordLike(computed.input); update({ auto_tax: false, items: next.items, cfop: next.cfop, nature_additional_info: next.nature_additional_info, nature_fiscal_info: next.nature_fiscal_info }); } else update({ auto_tax: !draft.auto_tax }); };
  const taxTab = <>
    <div className="fiscal-auto"><button type="button" className={draft.auto_tax ? 'fiscal-toggle is-on' : 'fiscal-toggle'} aria-pressed={draft.auto_tax} disabled={locked} onClick={toggleAuto}>{draft.auto_tax ? 'Cálculo automático ligado' : 'Cálculo automático desligado'}</button>
      <small className="real-help">{draft.auto_tax ? headerNature ? 'Os impostos dos itens seguem as regras da natureza de operação e as configurações globais. Confira antes de salvar.' : 'Escolha a natureza de operação para calcular os impostos.' : 'Os valores dos impostos dos itens são digitados no modal de cada item.'}</small></div>
    <div className="document-grid">{total('Total dos Produtos (R$)', 'products')}{money('freight', 'Valor do Frete (R$)')}{money('insurance', 'Valor do Seguro (R$)')}{money('other_expenses', 'Outras Despesas (R$)')}{money('discount', 'Desconto (R$)')}{total('Total da Nota (R$)', 'total')}</div>
    <button type="button" className="text-button" aria-expanded={showMore} onClick={() => setShowMore(v => !v)}>{showMore ? 'Mostrar menos' : 'Mostrar mais'}</button>
    {showMore && <dl className="fiscal-totals">{total('Base ICMS', 'icms_base')}{total('Valor ICMS', 'icms')}{total('Base ICMS ST', 'st_base')}{total('Valor ICMS ST', 'st')}{total('Total dos Serviços', 'services')}{total('Valor ISSQN', 'issqn')}
      {total('Valor IPI', 'ipi')}{total('Valor Funrural (R$)', 'funrural')}{total('Total Faturado (R$)', 'invoiced')}{total('Total A. Tributos (R$)', 'approx_taxes', 'Valor total aproximado dos tributos federais, estaduais e municipais')}</dl>}
  </>;
  const retentionShown = prefs.retention_group || ['ret_base', 'ret_ir', 'ret_csll', 'ret_pis', 'ret_cofins'].some(key => totals && totals[key] !== '0.00');
  const retentionTab = <dl className="fiscal-totals">{total('Base p/ retenções', 'ret_base')}{total('Valor IR', 'ret_ir')}{total('Valor CSLL', 'ret_csll')}{total('Valor PIS retido', 'ret_pis')}{total('Valor COFINS retido', 'ret_cofins')}<div className="native-list-stat"><dt>Valor ISS retido</dt><dd>{decimalMoney('0.00')}</dd></div>
    <p className="real-help">Os valores vêm da aba Retenções de cada item.</p></dl>;
  const t = draft.transport, setTransport = (patch: Partial<InvoiceDraft['transport']>) => update(d => ({ transport: { ...d.transport, ...patch } }));
  const transportTab = <>
    <div className="document-grid">
      {field('fiscal-transport-mode', 'Transporte', <select id="fiscal-transport-mode" value={t.mode} disabled={locked} onChange={event => setTransport(event.target.value === 'none' ? { mode: 'none', freight_by: '9', carrier: {}, vehicle: {} } : { mode: 'manual', freight_by: t.freight_by === '9' ? '0' : t.freight_by })}>
        {TRANSPORT_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}<option value="logistics" disabled title="Integrações logísticas estão fora do escopo do FAGOO.">Transporte com logística cadastrada</option></select>)}
      {field('fiscal-freight-by', 'Frete por conta', select('fiscal-freight-by', t.freight_by, FREIGHT_OPTIONS, value => setTransport({ freight_by: value })))}
      {field('fiscal-tracking', 'Código de rastreio', text('fiscal-tracking', t.tracking_code, value => setTransport({ tracking_code: value })))}
    </div>
    {t.mode === 'manual' && <fieldset className="fiscal-group"><legend>Dados da transportadora</legend><div className="document-grid">
      <div className="form-field fiscal-wide"><label htmlFor="fiscal-carrier-name">Nome</label>{text('fiscal-carrier-name', String(t.carrier.name ?? ''), value => setTransport({ carrier: { ...t.carrier, name: value, contact_id: '' } }))}{contactSearch('carrier', 'fiscal-carrier-search', 'Pesquisar transportadora')}</div>
      {field('fiscal-vehicle-plate', 'Placa do veículo', text('fiscal-vehicle-plate', String(t.vehicle.plate ?? ''), value => setTransport({ vehicle: { ...t.vehicle, plate: value.toUpperCase().replace(/[^A-Z0-9]/g, '') } }), { max: 7 }))}
      {field('fiscal-vehicle-state', 'UF do veículo', select('fiscal-vehicle-state', String(t.vehicle.state ?? ''), UF_OPTIONS, value => setTransport({ vehicle: { ...t.vehicle, state: value } }), { empty: 'UF ...' }))}
      <div className="form-field"><label htmlFor="fiscal-vehicle-rntc" title="Registro Nacional de Transportador de Carga (ANTT)">RNTC</label>{text('fiscal-vehicle-rntc', String(t.vehicle.rntc ?? ''), value => setTransport({ vehicle: { ...t.vehicle, rntc: value } }), { max: 20 })}</div>
      {field('fiscal-carrier-document', 'CNPJ/CPF', text('fiscal-carrier-document', String(t.carrier.document ?? ''), value => setTransport({ carrier: { ...t.carrier, document: value.replace(/\D/g, '') } }), { max: 14, inputMode: 'numeric' }))}
      {field('fiscal-carrier-ie', 'Inscrição Estadual', text('fiscal-carrier-ie', String(t.carrier.ie ?? ''), value => setTransport({ carrier: { ...t.carrier, ie: value.toUpperCase().replace(/[^0-9A-Z]/g, '') } }), { max: 14 }))}
      {field('fiscal-carrier-state', 'UF', select('fiscal-carrier-state', String(t.carrier.state ?? ''), UF_OPTIONS, value => setTransport({ carrier: { ...t.carrier, state: value } }), { empty: 'UF ...' }))}
      {field('fiscal-carrier-city', 'Município', text('fiscal-carrier-city', String(t.carrier.city ?? ''), value => setTransport({ carrier: { ...t.carrier, city: value } })))}
      {field('fiscal-carrier-address', 'Endereço da transportadora', text('fiscal-carrier-address', String(t.carrier.address ?? ''), value => setTransport({ carrier: { ...t.carrier, address: value } })), true)}
    </div></fieldset>}
    <fieldset className="fiscal-group"><legend>Dados do volume</legend><div className="document-grid">
      {field('fiscal-volume-quantity', 'Quantidade', text('fiscal-volume-quantity', String((prefs.compute_volume ? effective?.transport.volumes.quantity : t.volumes.quantity) ?? ''), value => setTransport({ volumes: { ...t.volumes, quantity: value.replace(/\D/g, '') } }), { max: 15, inputMode: 'numeric', disabled: prefs.compute_volume }))}
      {field('fiscal-volume-gross', 'Peso Bruto', text('fiscal-volume-gross', String((prefs.sum_weight ? effective?.transport.volumes.gross_weight : t.volumes.gross_weight) ?? ''), value => setTransport({ volumes: { ...t.volumes, gross_weight: value } }), { max: 20, inputMode: 'decimal', placeholder: 'Kg', disabled: prefs.sum_weight }))}
      {field('fiscal-volume-net', 'Peso Líquido', text('fiscal-volume-net', String((prefs.sum_weight ? effective?.transport.volumes.net_weight : t.volumes.net_weight) ?? ''), value => setTransport({ volumes: { ...t.volumes, net_weight: value } }), { max: 20, inputMode: 'decimal', placeholder: 'Kg', disabled: prefs.sum_weight }))}
      {(prefs.sum_weight || prefs.compute_volume) && <p className="real-help fiscal-wide">{[prefs.sum_weight && 'Os pesos somam o peso de cada produto vezes a quantidade', prefs.compute_volume && 'a quantidade de volumes soma os volumes de cada produto'].filter(Boolean).join('; ')} (Preferências › Configurações de NF-e).</p>}
      {field('fiscal-volume-numbering', 'Numeração do volume', text('fiscal-volume-numbering', String(t.volumes.numbering ?? ''), value => setTransport({ volumes: { ...t.volumes, numbering: value } })))}
      {field('fiscal-volume-brand', 'Marca', text('fiscal-volume-brand', String(t.volumes.brand ?? ''), value => setTransport({ volumes: { ...t.volumes, brand: value } })))}
      {field('fiscal-volume-species', 'Espécie', select('fiscal-volume-species', String(t.volumes.species ?? ''), SPECIES_OPTIONS, value => setTransport({ volumes: { ...t.volumes, species: value } }), { empty: 'Selecione uma opção' }))}
    </div></fieldset>
    <div className="form-field"><label htmlFor="fiscal-delivery"><input id="fiscal-delivery" type="checkbox" disabled={locked} checked={t.delivery !== null} onChange={event => setTransport({ delivery: event.target.checked ? {} : null })} /> Endereço de entrega diferente da cobrança</label></div>
    {t.delivery && <div className="document-grid">{([['name', 'Nome'], ['postal_code', 'CEP'], ['city', 'Município'], ['street', 'Endereço'], ['number', 'Número'], ['district', 'Bairro'], ['complement', 'Complemento'], ['country', 'País']] as const).map(([key, label]) =>
      <div key={key}>{field(`fiscal-delivery-${key}`, label, text(`fiscal-delivery-${key}`, String(t.delivery![key] ?? ''), value => setTransport({ delivery: { ...t.delivery!, [key]: key === 'postal_code' ? value.replace(/\D/g, '') : value } }), { max: key === 'postal_code' ? 8 : 60 }))}</div>)}
      {field('fiscal-delivery-state', 'UF', select('fiscal-delivery-state', String(t.delivery.state ?? ''), UF_EX_OPTIONS, value => setTransport({ delivery: { ...t.delivery!, state: value } }), { empty: 'UF ...' }))}
      {/* Leva H (NFE-103): "Buscar CEP" fills only the empty fields; manual entry stays. */}
      {!locked && <div className="form-field"><span aria-hidden="true">&nbsp;</span><CepLookupButton id="fiscal-delivery-cep-lookup" controller={controller as unknown as Partial<PlatformPort>} cep={String(t.delivery.postal_code ?? '')} onFound={address => setTransport({ delivery: fillAddress(t.delivery!, address) })} /></div>}</div>}
  </>;
  const p = draft.payment;
  const generate = () => {
    const cents = totals ? centsOf(totals.total) : 0n;
    // "Cobrar IPI / ICMS ST na primeira parcela": those amounts go whole into the first installment.
    const first = totals ? (prefs.ipi_first_installment ? centsOf(totals.ipi) : 0n) + (prefs.st_first_installment ? centsOf(totals.st) : 0n) : 0n;
    const plan = installmentsFromCondition(p.condition, cents, draft.issue_date, first);
    if (!plan) { setError('Condição de pagamento inválida. Exemplo 30, 60, 3x ou 15 +2x.'); return; }
    setError(''); update({ payment: { ...p, installments: plan.map(i => ({ ...i, card: null })) } });
  };
  const setInstallment = (index: number, patch: Record<string, string>) => update(d => ({ payment: { ...d.payment, installments: d.payment.installments.map((i, n) => n === index ? { ...i, ...patch } : i) } }));
  const paymentTab = <>
    <div className="document-grid"><div className="form-field"><label htmlFor="fiscal-condition" title="Forma de pagamento cadastrada ou número de parcelas ou prazos. Exemplo 30, 60, 3x ou 15 +2x.">Condição de pagamento</label>{text('fiscal-condition', p.condition, value => update({ payment: { ...p, condition: value } }))}</div>
      <button type="button" className="secondary-button" disabled={paymentLocked || !p.condition.trim()} onClick={generate}>Gerar parcelas</button>
      {field('fiscal-category', 'Categoria', <select id="fiscal-category" disabled title="Usada ao lançar contas pela nota, que fica desligado por enquanto."><option>Sem categoria</option></select>)}
      {field('fiscal-destination', 'Destino', <select id="fiscal-destination" disabled title="Usado ao lançar contas pela nota, que fica desligado por enquanto."><option>{draft.direction === '1' ? 'Contas a Receber' : 'Contas a Pagar'}</option></select>)}</div>
    {p.indicator && <p className="real-help">Forma de pagamento do pedido: {p.indicator === '0' ? 'Pagamento à vista' : 'Pagamento a prazo'} (indicador da forma de pagamento da NF-e). <button type="button" className="text-button" disabled={paymentLocked} onClick={() => update(d => { const { indicator: _gone, ...rest } = d.payment; return { payment: rest }; })}>Usar o padrão pelas parcelas</button></p>}
    {p.installments.length ? <table className="data-table document-responsive-table"><thead><tr><th>Dias</th><th>Data</th><th className="numeric">Valor</th><th>Forma</th><th>Observação</th><th><span className="sr-only">Ações</span></th></tr></thead><tbody>{p.installments.map((i, index) => <tr key={index}>
      <td data-label="Dias"><input aria-label={`Dias da parcela ${index + 1}`} maxLength={4} disabled={paymentLocked} value={String(i.days ?? '')} onChange={event => setInstallment(index, { days: event.target.value.replace(/\D/g, '') })} /></td>
      <td data-label="Data"><input aria-label={`Data da parcela ${index + 1}`} type="date" disabled={paymentLocked} value={String(i.date ?? '')} onChange={event => setInstallment(index, { date: event.target.value })} /></td>
      <td data-label="Valor"><input aria-label={`Valor da parcela ${index + 1}`} inputMode="decimal" disabled={paymentLocked} value={String(i.amount ?? '')} onChange={event => setInstallment(index, { amount: event.target.value })} /></td>
      <td data-label="Forma"><select aria-label={`Forma da parcela ${index + 1}`} disabled={paymentLocked} value={formaValue(i)} onChange={event => { const value = event.target.value; update(d => ({ payment: { ...d.payment, installments: d.payment.installments.map((x, n) => n === index ? withForma(x, value, methods) : x) } })); }}><option value="">Selecione</option>{formaOptions(methods, i).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></td>
      <td data-label="Observação"><input aria-label={`Observação da parcela ${index + 1}`} maxLength={255} disabled={paymentLocked} value={String(i.note ?? '')} onChange={event => setInstallment(index, { note: event.target.value })} /></td>
      <td className="fiscal-item-icons document-cell-wide" data-label="Ações"><button type="button" className="icon-button" title="Detalhes da parcela" aria-label={`Detalhes da parcela ${index + 1}`} onClick={() => setInstallmentIndex(index)}><Icon name="circle-info" size={12} /></button>
        <button type="button" className="icon-button" aria-label={`Remover parcela ${index + 1}`} disabled={paymentLocked} onClick={() => update({ payment: { ...p, installments: p.installments.filter((_, n) => n !== index) } })}><Icon name="trash-can" size={12} /></button></td></tr>)}</tbody></table> : <p className="real-help">Nenhuma parcela registrada</p>}
    {locks.installments && p.installments.length > 0 && <p className="real-help">As parcelas seguem as contas já lançadas pelo pedido de venda e não mudam com o total da nota.</p>}
    <button type="button" className="text-button" disabled={paymentLocked} onClick={() => update({ payment: { ...p, installments: [...p.installments, { date: draft.issue_date, amount: '', card: null }] } })}><Icon name="plus" size={10} /> Adicionar parcela</button>
  </>;
  const authorizedTab = <>
    <p className="real-help">Contatos que estão autorizados a fazer o download do XML da nota no Portal Nacional da NF-e.</p>
    {draft.authorized_xml.length ? <table className="data-table document-responsive-table"><thead><tr><th>Contato</th><th>CPF/CNPJ</th><th><span className="sr-only">Ações</span></th></tr></thead><tbody>{draft.authorized_xml.map((a, index) => <tr key={String(a.document)}><td data-label="Contato">{String(a.name ?? '—')}</td><td data-label="CPF/CNPJ">{String(a.document)}</td>
      <td data-label="Ações"><button type="button" className="icon-button" aria-label="Remover pessoa" title="Remover pessoa" disabled={locked} onClick={() => update({ authorized_xml: draft.authorized_xml.filter((_, i) => i !== index) })}><Icon name="trash-can" size={12} /></button></td></tr>)}</tbody></table> : <p className="real-help">Nenhum contato autorizado</p>}
    <div className="form-field"><label htmlFor="fiscal-authorized-search">Adicionar outro contato</label>{contactSearch('authorized', 'fiscal-authorized-search', 'Pesquisar contato')}</div>
  </>;
  const im = draft.intermediary;
  const intermediaryTab = <div className="document-grid">
    {field('fiscal-intermediary', 'Intermediador', <select id="fiscal-intermediary" disabled={locked} value={im.present ? 'true' : 'false'} title="Indica se a operação foi realizada com intermediador, como Hub ou Marketplace por exemplo." onChange={event => update({ intermediary: event.target.value === 'true' ? { ...im, present: true } : { present: false } })}><option value="false">Não</option><option value="true">Sim</option></select>)}
    {im.present && <>{field('fiscal-intermediary-cnpj', 'CNPJ', text('fiscal-intermediary-cnpj', String(im.cnpj ?? ''), value => setNested('intermediary', 'cnpj', value.replace(/\D/g, '')), { max: 14, inputMode: 'numeric' }))}
      <div className="form-field"><label htmlFor="fiscal-intermediary-id" title="Sua identificação no intermediador: nome da empresa, e-mail ou usuário.">Identificação no intermediador</label>{text('fiscal-intermediary-id', String(im.identification ?? ''), value => setNested('intermediary', 'identification', value))}</div></>}
  </div>;
  const infoTab = <div className="document-grid">
    <div className="form-field fiscal-wide"><label htmlFor="fiscal-additional">Informações complementares</label><textarea id="fiscal-additional" rows={5} maxLength={5000} disabled={locked} value={draft.additional_info} onChange={event => update({ additional_info: event.target.value })} /></div>
    <div className="form-field fiscal-wide"><label htmlFor="fiscal-nature-info">Informações complementares (natureza)</label><textarea id="fiscal-nature-info" rows={3} readOnly value={(draft.auto_tax ? computed?.input.nature_additional_info : draft.nature_additional_info) ?? ''} /></div>
    <div className="form-field fiscal-wide"><label htmlFor="fiscal-nature-fiscal">Informações adicionais de interesse do fisco (natureza)</label><textarea id="fiscal-nature-fiscal" rows={3} readOnly value={(draft.auto_tax ? computed?.input.nature_fiscal_info : draft.nature_fiscal_info) ?? ''} /></div>
  </div>;
  const content: Record<Tab, ReactNode> = { cabecalho: headerTab, referenciado: referenceTab, destinatario: recipientTab, itens: itemsTab, calculo: taxTab, retencoes: retentionTab, transporte: transportTab,
    pagamento: paymentTab, autorizados: authorizedTab, intermediador: intermediaryTab, informacoes: infoTab };
  const titleNumber = record?.number ? String(record.number).padStart(6, '0') : record ? 'sem número' : 'nova';
  const kind = draft.model === '65' ? 'NFC-e' : 'Nota fiscal';
  const labels = { ...Object.fromEntries(TABS), destinatario: draft.direction === '0' ? 'Remetente' : 'Destinatário' } as Record<Tab, string>;
  return <section className="fiscal-invoice-form" ref={sectionRoot}>
    <header className="real-heading"><div><h1>{kind} - {titleNumber}</h1>
      <p>{record ? <><span className={statusClass(record, draft.model)}>{statusLabel({ status: record.status, status_raw: null }, draft.model)}</span> · versão {record.version} · </> : null}{REGISTERED.includes(draft.issue_type) ? 'Nota de terceiros registrada no FAGOO, sem transmissão.' : 'Homologação · sem valor fiscal. Salvar não envia a nota.'}</p></div>
      <div className="real-editor-actions"><button type="button" className="secondary-button" disabled={busy} onClick={cancel}>Cancelar</button>
        {uncertain ? <button type="button" className="primary-button" disabled={busy} onClick={() => void send()}>{busy ? 'Conferindo…' : 'Conferir resultado'}</button>
          : <button type="button" className="primary-button" disabled={!editable || busy} onClick={() => void save()}>{busy ? 'Salvando…' : 'Salvar'}</button>}</div></header>
    {!canWrite && <p className="real-notice">Seu perfil atual não permite alterar notas fiscais. A nota está em leitura.</p>}
    {canWrite && record && !editableStatus(record) && <p className="real-notice">{record.deleted_at ? 'Nota excluída: o histórico fica preservado e ela não pode mais ser alterada.' : imported(record)
      ? <>Nota importada do XML (chave {record.access_key ?? '—'}, protocolo {record.protocol ?? '—'}): fica como no XML. <button type="button" className="text-button" onClick={() => setTab('itens')}>Conciliar produtos</button> na seção Itens da nota fiscal.</>
      : `Nota ${statusLabel({ status: record.status, status_raw: null }, draft.model).toLowerCase()}: só notas pendentes, rejeitadas, registradas ou bloqueadas são alteradas.`}</p>}
    {origin && !record && compositionNotices(origin).length > 0 && <p className="real-notice">Desmembrar produtos em uma estrutura na nota fiscal (Preferências › Vendas): {compositionNotices(origin).join(' ')} O item ficou com a composição.</p>}
    {group && !record && <p className="real-notice">Nota agrupada de {group.length} {group[0]!.document.kind === 'service_orders' ? 'ordens de serviço' : 'pedidos'} (nº {group.map(s => s.document.number).join(', ')}) do mesmo cliente: as parcelas não são copiadas; use Gerar parcelas na seção Pagamento.{group.some(s => s.items.some(i => isServiceItem(s, i))) ? ' Os serviços ficam fora (são da NFS-e).' : ''}</p>}
    {origin && !group && !record && origin.items.some(i => isServiceItem(origin, i)) && <p className="real-notice">A nota leva só os produtos da ordem de serviço nº {origin.document.number}: {origin.items.filter(i => isServiceItem(origin, i)).length} serviço(s), o desconto geral, o frete, as outras despesas e as parcelas da OS ficaram de fora (serviços são da NFS-e).</p>}
    {(locks.items || locks.installments) && <p className="real-notice">{locks.items && locks.installments ? 'Estoque e contas já foram lançados pelo pedido de venda: itens, quantidades e parcelas ficam bloqueados.' : locks.items ? 'Estoque já lançado pelo pedido de venda: itens e quantidades ficam bloqueados.' : 'Contas já lançadas pelo pedido de venda: as parcelas ficam bloqueadas.'} (Preferências › Configurações de NF-e)</p>}
    {error && <p className="real-alert" role="alert">{error}</p>}
    {notice && <p className="real-success" role="status">{notice}</p>}
    <p className="real-help">(*) Campos obrigatórios · {ISSUE_TYPES[draft.direction][draft.issue_type] ?? ''}</p>
    <nav className="fiscal-form-tabs" aria-label="Seções da nota">{TABS.filter(([value]) => value !== 'retencoes' || retentionShown).map(([value]) => <button type="button" key={value} aria-controls={`fiscal-section-${value}`} aria-current={tab === value ? 'location' : undefined} onClick={() => setTab(value)}>{labels[value]}</button>)}</nav>
    {TABS.filter(([value]) => value !== 'retencoes' || retentionShown).map(([value]) => <section key={value} id={`fiscal-section-${value}`} className="fiscal-document-section" aria-labelledby={`fiscal-heading-${value}`} tabIndex={-1}>
      <h2 id={`fiscal-heading-${value}`}>{labels[value]}</h2><div className="fiscal-tab">{content[value]}</div>
    </section>)}
    {itemIndex !== null && draft.items[itemIndex] && <FiscalInvoiceItemDialog key={itemIndex} item={draft.items[itemIndex]!} computed={draft.auto_tax ? computed?.input.items[itemIndex] ?? null : null} position={itemIndex + 1}
      crt={draft.crt} direction={draft.direction} natures={crtNatures} readOnly={itemsLocked} auto={draft.auto_tax} show={optionalTabs(prefs, draft.items[itemIndex])} itemDiscount={itemDiscount} totals={computed ? { total: computed.totals.lines[itemIndex] ?? null, freight: computed.totals.allocation.freight[itemIndex] ?? null, discount: computed.totals.allocation.discount[itemIndex] ?? null } : null}
      onCancel={() => setItemIndex(null)} onSave={item => { update({ items: draft.items.map((x, i) => i === itemIndex ? item : x) }); setItemIndex(null); }} />}
    {installmentIndex !== null && p.installments[installmentIndex] && <FiscalInstallmentDialog key={installmentIndex} installment={p.installments[installmentIndex]!} position={installmentIndex + 1} direction={draft.direction} methods={methods}
      readOnly={paymentLocked} onCancel={() => setInstallmentIndex(null)} onSave={(next: InstallmentDraft) => { update(d => ({ payment: { ...d.payment, installments: d.payment.installments.map((x, i) => i === installmentIndex ? next : x) } })); setInstallmentIndex(null); }} />}
    {itemProduct !== null && draft.items[itemProduct] && <FiscalInvoiceItemProduct key={`product:${itemProduct}`} controller={controller} item={draft.items[itemProduct]!} position={itemProduct + 1}
      supplier={typeof r.contact_id === 'string' && UUID_TEXT.test(r.contact_id) ? { id: r.contact_id, direction: draft.direction } : null} onClose={() => setItemProduct(null)}
      onCreated={product => {
        const position = itemProduct; setItemProduct(null);
        // The item takes the new product in an editable note; an imported note (XML) links it in "Conciliar produtos".
        if (editable && !itemsLocked) { setDraft(d => d ? { ...d, items: d.items.map((x, i) => i === position ? { ...x, product_id: product.id } : x) } : d); setNotice(`Produto "${product.name}" cadastrado e ligado ao item ${position + 1}. Salve a nota.`); }
        else setNotice(`Produto "${product.name}" cadastrado. ${imported(record) ? 'Ligue-o ao item em Conciliar produtos.' : 'A nota está em leitura: o item continua como estava.'}`);
      }} />}
    {itemHistory !== null && draft.items[itemHistory] && typeof draft.items[itemHistory]!.product_id === 'string' && typeof r.contact_id === 'string' && <FiscalInvoiceItemHistory key={`history:${itemHistory}`} controller={controller}
      contactId={r.contact_id} contactName={String(r.name ?? '')} productId={draft.items[itemHistory]!.product_id as string} productName={String(draft.items[itemHistory]!.description ?? '')} direction={draft.direction} onClose={() => setItemHistory(null)} />}
    {itemLots !== null && record && typeof draft.items[itemLots]?.product_id === 'string' && <SourceLotsPanel key={`lots:${itemLots}`} controller={controller} source="invoice" sourceId={record.id}
      productId={draft.items[itemLots]!.product_id as string} description={String(draft.items[itemLots]!.description ?? '')} onClose={() => setItemLots(null)} />}
    {quickContact && <DocumentQuickContact controller={controller} kind={draft.direction === '1' ? 'sales_orders' : 'purchase_orders'} initial={quickContactInitial(draft.direction === '1' ? 'sales_orders' : 'purchase_orders', String(r.name ?? ''))}
      onCreated={contact => { setQuickContact(false); setContactTarget('recipient'); pickContact(contact, 'recipient'); }} onClose={() => setQuickContact(false)} />}
  </section>;
}
/** The engine output keeps the API shape; the draft keeps strings. */
function recordLike(input: InvoiceInput): Pick<InvoiceDraft, 'items' | 'cfop' | 'nature_additional_info' | 'nature_fiscal_info'> {
  return { items: input.items.map(item => structuredClone(item) as ItemDraft), cfop: input.cfop ?? '', nature_additional_info: input.nature_additional_info ?? '', nature_fiscal_info: input.nature_fiscal_info ?? '' };
}
