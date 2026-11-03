// Notas fiscais de saída, NFC-e e notas de entrada no padrão Origin (docs/integrations/fiscal-invoices-origin.md):
// configuração por tela, parâmetros validados, rótulos de situação, regras do menu ⋮ e plano dos lotes.
import { INVOICE_STATUS } from '../../../../packages/erp-domain/src/fiscal-invoice-dto.mjs';
import type { ListPage, ListRow } from '../../../../packages/erp-domain/src/fiscal-invoice-contract.mjs';
import { planBatch, type BatchItem, type BatchPlan } from './origin-batch.ts';

export type { ListPage, ListRow };
export type FiscalScreen = 'nfe' | 'nfce' | 'entrada';
export type FiscalOrigin = 'origin' | 'brufap';
export type FiscalOrder = 'date_desc' | 'date_asc' | 'number_desc' | 'number_asc';
export const FISCAL_PAGE_SIZE = 100;
export const FISCAL_BASE = '/v1/notas-fiscais';
export interface ScreenConfig {
  screen: FiscalScreen; model: '55' | '65'; direction: '0' | '1'; title: string; addLabel: string; searchPlaceholder: string; countLabel: string; dateColumn: string;
  statusOptions: readonly { value: string; label: string }[]; dateTypes: readonly { value: 'issue' | 'entry'; label: string }[]; deleteLabel: string; deleteWarning: string;
  customFilters: readonly CustomFilter[]; plainStatus: boolean;
  /** Filtro Vendedor (202610200215): the Vendedor of the note, or the Origin vendedor of the seller's contact. */
  sellerFilter?: boolean;
  /** Espelho lane (wave H, 202610210358, NFE-024/172): Categoria of the contas lançadas by a note of the Brufap. */
  categoryFilter?: boolean;
}
/** NFE-024/172: Loja and Filial of the Origin search are not applicable, with the reason shown in "Adicionar filtros". */
export const NOT_APPLICABLE_FILTERS = 'Loja e Filial não se aplicam: o FAGOO atende uma empresa com uma loja (multiloja e multiempresa estão fora do escopo).';
export const CATEGORY_ORIGIN_HELP = 'A Categoria vale para as notas do FAGOO: as notas do Origin não têm contas vinculadas no FAGOO durante a convivência.';
export type CustomFilter = 'nature' | 'carrier' | 'trade_name' | 'person_type' | 'document' | 'email' | 'phone' | 'series' | 'contact_code' | 'order_number';
export const CUSTOM_FILTER_LABELS: Record<CustomFilter, string> = { nature: 'Natureza', carrier: 'Transportador', trade_name: 'Fantasia', person_type: 'Tipo da Pessoa', document: 'CNPJ / CPF',
  email: 'E-mail', phone: 'Fone/Fax', series: 'Série', contact_code: 'Código do contato', order_number: 'Nº pedido de venda' };
const NFE_STATUS = [{ value: '', label: 'Todas' }, { value: 'pending', label: 'Pendentes' }, { value: 'issued', label: 'Emitidas' }, { value: 'authorized', label: 'Autorizadas - Sem DANFE' },
  { value: 'cancelled', label: 'Canceladas' }, { value: 'denied', label: 'Denegadas' }] as const;
const NFE_DELETE = 'A nota fiscal será excluída do sistema. Antes de realizar a exclusão, você deve armazenar o arquivo XML da nota, que é obrigatório por lei.';
export const SCREENS: Record<FiscalScreen, ScreenConfig> = {
  nfe: { screen: 'nfe', model: '55', direction: '1', title: 'Notas Fiscais de Saída', addLabel: 'Incluir nota fiscal', searchPlaceholder: 'Pesquisar por nome, CPF/CNPJ ou n° da nota',
    countLabel: 'Quantidade de notas', dateColumn: 'Data emissão', statusOptions: NFE_STATUS, dateTypes: [], deleteLabel: 'Excluir notas selecionadas', deleteWarning: NFE_DELETE,
    customFilters: ['nature', 'carrier', 'trade_name', 'person_type', 'document', 'email', 'phone', 'series', 'contact_code', 'order_number'], plainStatus: false, sellerFilter: true, categoryFilter: true },
  nfce: { screen: 'nfce', model: '65', direction: '1', title: 'Nota fiscal de consumidor eletrônica (NFC-e)', addLabel: 'Incluir NFC-e', searchPlaceholder: 'Pesquisar por nome ou n° da nota',
    countLabel: 'Quantidade de notas fiscais', dateColumn: 'Data', statusOptions: [{ value: '', label: 'Todos' }, { value: 'pending', label: 'Pendentes' }, { value: 'issued', label: 'Emitidas' },
      { value: 'cancelled', label: 'Canceladas' }, { value: 'contingency', label: 'Em contingência' }], dateTypes: [], deleteLabel: 'Excluir NFCes selecionadas',
    deleteWarning: 'Antes de excluir as NFCes é recomendado que você faça uma cópia do XML, que é obrigatório por lei.',
    customFilters: ['nature', 'trade_name', 'document', 'email', 'phone', 'series', 'order_number'], plainStatus: true, categoryFilter: true },
  entrada: { screen: 'entrada', model: '55', direction: '0', title: 'Notas Fiscais de Entrada', addLabel: 'Incluir nota fiscal', searchPlaceholder: 'Pesquisar por nome, CPF/CNPJ ou n° da nota',
    countLabel: 'Quantidade de notas', dateColumn: 'Data entrada', statusOptions: [...NFE_STATUS, { value: 'registered', label: 'Registradas' }],
    dateTypes: [{ value: 'entry', label: 'Data de entrada' }, { value: 'issue', label: 'Data de emissão' }], deleteLabel: 'Excluir notas selecionadas', deleteWarning: NFE_DELETE,
    customFilters: ['nature', 'carrier', 'trade_name', 'person_type', 'document', 'email', 'phone', 'series', 'contact_code', 'order_number'], plainStatus: false },
};
export const ORIGIN_LABELS: Record<FiscalOrigin, string> = { origin: 'Notas do Origin', brufap: 'Registros do FAGOO' };
export const UFS = ['AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO', 'EX'] as const;
export type Reference = { id: string; name: string; code?: string | null };
export interface FiscalFilters {
  query: string; status: string; from: string; to: string; dateType: 'issue' | 'entry'; product: Reference | null; state: string;
  custom: Partial<Record<CustomFilter, string>>; seller: Reference | null;
  /** Produtos lane (202610200236): Tags of the Marcadores (id 'none' = Sem Tag). */
  tag?: Reference | null;
  /** Espelho lane (202610210358): Categoria financeira of the contas lançadas by the note (notes of the Brufap only). */
  category?: Reference | null;
}
export const emptyFilters = (config: ScreenConfig): FiscalFilters => ({ query: '', status: '', from: '', to: '', dateType: config.dateTypes[0]?.value ?? 'issue', product: null, state: '', custom: {}, seller: null, tag: null, category: null });
const CONTROL = /[\x00-\x1f\x7f]/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const validDate = (value: string) => /^(19|20)\d{2}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const PARAM: Record<CustomFilter, string> = { nature: 'nature', carrier: 'carrier', trade_name: 'trade_name', person_type: 'person_type', document: 'document', email: 'email', phone: 'phone', series: 'series', contact_code: 'contact_code', order_number: 'order_number' };
const MAX: Record<CustomFilter, number> = { nature: 120, carrier: 120, trade_name: 120, person_type: 1, document: 30, email: 120, phone: 40, series: 3, contact_code: 100, order_number: 20 };

/** Query for GET /v1/notas-fiscais; throws a user-facing message for invalid filters. */
export function fiscalListQuery(config: ScreenConfig, origin: FiscalOrigin, filters: FiscalFilters, { page = 1, order = 'date_desc' as FiscalOrder } = {}): URLSearchParams {
  if (filters.query.length > 120 || CONTROL.test(filters.query)) throw new Error('A pesquisa deve ter até 120 caracteres, sem quebras de linha.');
  for (const value of [filters.from, filters.to]) if (value && !validDate(value)) throw new Error('Informe datas válidas entre 1900 e 2099.');
  if (filters.from && filters.to && filters.from > filters.to) throw new Error('A data inicial deve ser anterior ou igual à data final.');
  if (filters.status && !config.statusOptions.some(option => option.value === filters.status)) throw new Error('Escolha uma situação válida.');
  if (filters.state && !(UFS as readonly string[]).includes(filters.state)) throw new Error('Escolha uma UF válida.');
  if (filters.product && !UUID.test(filters.product.id)) throw new Error('Selecione novamente o produto.');
  if (config.sellerFilter && filters.seller && !UUID.test(filters.seller.id)) throw new Error('Selecione novamente o vendedor.');
  if (filters.tag && filters.tag.id !== 'none' && !UUID.test(filters.tag.id)) throw new Error('Selecione novamente a tag.');
  if (config.categoryFilter && filters.category && !UUID.test(filters.category.id)) throw new Error('Selecione novamente a categoria.');
  const params = new URLSearchParams({ model: config.model });
  if (config.direction !== '1') params.set('direction', config.direction);
  if (origin !== 'origin') params.set('origin', origin);
  params.set('page', String(page));
  if (order !== 'date_desc') params.set('order', order);
  if (filters.query.trim()) params.set('q', filters.query.trim());
  if (config.dateTypes.length && (filters.from || filters.to) && filters.dateType !== 'issue') params.set('date_type', filters.dateType);
  if (filters.from) params.set('date_from', filters.from);
  if (filters.to) params.set('date_to', filters.to);
  if (filters.status) params.set('status', filters.status);
  if (filters.product) params.set('product_id', filters.product.id.toLowerCase());
  if (filters.state) params.set('state', filters.state);
  if (config.sellerFilter && filters.seller) params.set('seller_id', filters.seller.id.toLowerCase());
  if (filters.tag) params.set('tag', filters.tag.id.toLowerCase());
  // The Origin notes have no contas linked in the Brufap: the Categoria is sent only with the notes of the Brufap.
  if (config.categoryFilter && filters.category && origin === 'brufap') params.set('category_id', filters.category.id.toLowerCase());
  for (const key of config.customFilters) {
    const value = filters.custom[key]?.trim();
    if (!value) continue;
    if (value.length > MAX[key] || CONTROL.test(value) || (key === 'person_type' && !['J', 'F', 'E'].includes(value)) || (key === 'series' && !/^(0|[1-9][0-9]{0,2})$/.test(value)))
      throw new Error(`Confira o filtro ${CUSTOM_FILTER_LABELS[key]}.`);
    params.set(PARAM[key], value);
  }
  return params;
}
export function filterChips(config: ScreenConfig, filters: FiscalFilters): { key: string; label: string }[] {
  const chips: { key: string; label: string }[] = [];
  if (filters.query.trim()) chips.push({ key: 'query', label: `Pesquisa: ${filters.query.trim()}` });
  if (filters.status) chips.push({ key: 'status', label: `Situação: ${config.statusOptions.find(o => o.value === filters.status)?.label ?? filters.status}` });
  if (filters.product) chips.push({ key: 'product', label: `Produto: ${filters.product.name}` });
  if (filters.state) chips.push({ key: 'state', label: `UF: ${filters.state}` });
  if (config.sellerFilter && filters.seller) chips.push({ key: 'seller', label: `Vendedor: ${filters.seller.name}` });
  if (filters.tag) chips.push({ key: 'tag', label: `Tags: ${filters.tag.name}` });
  if (config.categoryFilter && filters.category) chips.push({ key: 'category', label: `Categoria: ${filters.category.name}` });
  for (const key of config.customFilters) if (filters.custom[key]?.trim()) chips.push({ key: `custom:${key}`, label: `${CUSTOM_FILTER_LABELS[key]}: ${key === 'person_type' ? PERSON_LABELS[filters.custom[key] as 'J'] ?? filters.custom[key] : filters.custom[key]!.trim()}` });
  return chips;
}
export const PERSON_LABELS: Record<'J' | 'F' | 'E', string> = { J: 'Jurídica', F: 'Física', E: 'Estrangeiro' };
export const pageCount = (total: number) => Math.max(1, Math.ceil(total / FISCAL_PAGE_SIZE));
/** Origin shows the note number with six digits. */
export const invoiceNumber = (row: Pick<ListRow, 'number'>) => row.number === null ? '—' : String(row.number).padStart(6, '0');
export const brDay = (value: string | null) => value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value.split('-').reverse().join('/') : '—';
/** Situação label as Origin shows it; NFC-e calls an authorized note "Emitida". Unknown Origin codes keep the raw code. */
export function statusLabel(row: Pick<ListRow, 'status' | 'status_raw'>, model: '55' | '65'): string {
  if (row.status === null) return row.status_raw ? `Situação ${row.status_raw} do Origin` : 'Sem situação';
  if (model === '65' && (row.status === 6 || row.status === 7)) return 'Emitida';
  return INVOICE_STATUS[row.status] ?? `Situação ${row.status}`;
}
/**
 * Espelho lane (wave H, NFE-069): the fiscal state apart from the DANFE print. "Emitida DANFE" (7) is an authorized note whose DANFE was
 * printed; the Origin code of origin stays in status_raw.
 */
export function fiscalStateText(row: Pick<ListRow, 'fiscal_status' | 'danfe_emitted' | 'status_raw' | 'origin'>): string {
  const state = row.fiscal_status === 6 ? 'Autorizada' : row.fiscal_status === null ? 'Situação não mapeada' : INVOICE_STATUS[row.fiscal_status] ?? `Situação ${row.fiscal_status}`;
  return `Situação fiscal: ${state}${row.fiscal_status === 6 ? ` · DANFE ${row.danfe_emitted ? 'emitida' : 'não emitida'}` : ''}${row.origin === 'origin' && row.status_raw ? ` · código ${row.status_raw} do Origin` : ''}`;
}
const SOURCE_ORIGIN: Record<ListRow['source_origin'], string> = { origin: 'Nota do Origin', brufap_native: 'Nota do FAGOO', third_party: 'Nota de terceiros registrada no FAGOO', xml_import: 'XML importado' };
/** NFE-063/185: origin and environment of the source, apart from the model (NF-e or NFC-e) and the emission environment. */
export function sourceLabel(row: Pick<ListRow, 'source_origin' | 'source_environment'>): string {
  const environment = row.source_environment === '1' ? 'produção' : row.source_environment === '2' ? 'homologação' : 'ambiente não informado';
  return `${SOURCE_ORIGIN[row.source_origin]} · ${environment}`;
}
export const isNative = (row: Pick<ListRow, 'origin'>) => row.origin === 'brufap';
export const EDITABLE = [1, 5, 8, 12];
export type RowActionId = 'edit' | 'view' | 'send' | 'receipt' | 'cancel' | 'other' | 'correction' | 'complementary' | 'pdf' | 'boleto' | 'finance' | 'stock' | 'return'
  | 'clone' | 'clone_invert' | 'danfe' | 'danfe_simple' | 'labels' | 'mirror' | 'transport_label' | 'xml' | 'copy_key' | 'delete' | 'nfe_from_nfce' | 'pricing' | 'checkin' | 'stock_reverse' | 'support_xml';
export interface RowAction { id: RowActionId; label: string; enabled: boolean; reason?: string; separatorBefore?: boolean; icon?: string }
export const ORIGIN_FISCAL_READONLY_REASON = 'Nota do Origin em consulta: durante a convivência, emissão, cópia, devolução, correção e lançamentos continuam no Origin.';
export const ORIGIN_DANFE_REASON = 'Durante a convivência, a reimpressão do DANFE das notas do Origin é feita no Origin. O XML coletado continua disponível para consulta e download.';
const COEXISTENCE = ORIGIN_FISCAL_READONLY_REASON;
const EFFECTS_OFF = 'Lançamentos de estoque pela nota ficam desligados enquanto as notas do FAGOO forem de homologação.';
// Financeiro lane (SQL 247): contas lançadas pela nota of the Brufap.
const FINANCE_UNREAD = 'Conferindo as contas da nota…';
const FINANCE_ROLE = 'Somente administrador e financeiro lançam contas pela nota.';
const FINANCE_GROUPED = 'A nota está num Faturamento agrupado: as contas são do faturamento.';
/** Contas of a note of the Brufap (letra C): null while not read; writable for the profiles that lançam contas. */
export type InvoiceFinanceState = { writable: boolean; posted: boolean; grouped: boolean } | null;
const SEND_OFF = 'O envio à SEFAZ desta nota ainda não está ligado no FAGOO; use Preferências › Emissor de NF-e para os testes de homologação.';
// During coexistence, the DANFE is available only for the authorized XML of a Brufap record.
const DANFE_NATIVE_OFF = 'A nota do FAGOO ainda não tem XML autorizado (o envio à SEFAZ não está ligado). Use Imprimir espelho NF.';
/** The note has a checked XML to print the DANFE from. */
export const danfeReady = (row: Pick<ListRow, 'origin' | 'issue_type' | 'xml_id'>) => Boolean(row.xml_id) || isImported(row);
/**
 * ⋮ menu in Origin order with Brufap availability. Origin hides "Enviar nota fiscal" and "Cancelar NF-e" in situations 3, 4, 9, 10 and 11 and
 * blocks Lançar contas/estoque in Cancelada and Denegada. Everything Brufap cannot do is listed disabled with the reason.
 */
/** Estoque lane (259): the letter E of a Brufap note (S by the note, R by the reference) and whether the user posts stock. */
export interface RowStock { flag: 'S' | 'R' | null; reference: string | null; manage: boolean }
export function rowActions(config: ScreenConfig, row: ListRow, { writable, checkin, labels, finance = null, stock }: { writable: boolean; checkin?: boolean; labels?: boolean; finance?: InvoiceFinanceState; stock?: RowStock | null }): RowAction[] {
  const native = isNative(row), status = row.status ?? 0, authorized = status === 6 || status === 7, waiting = [3, 4, 9, 10, 11].includes(status);
  const off = (reason: string) => ({ enabled: false, reason });
  const actions: RowAction[] = [];
  // Imported XML notes (S/X) open read-only: the stored XML is their source.
  actions.push(native ? { id: 'edit', label: writable && EDITABLE.includes(status) && !isImported(row) ? 'Editar' : 'Visualizar', enabled: true, icon: 'pen-to-square' } : { id: 'view', label: 'Visualizar', enabled: true, icon: 'eye' });
  const nfce = config.model === '65';
  if (!waiting && (status === 1 || status === 5 || (nfce && status === 2))) actions.push({ id: 'send', label: nfce ? 'Autorizar NFC-e' : 'Enviar nota fiscal', icon: 'paper-plane', ...(native ? off(SEND_OFF) : off(COEXISTENCE)) });
  if ([4, 9, 11].includes(status)) actions.push({ id: 'receipt', label: status === 11 ? 'Consultar situação' : 'Consultar recibo', ...(native ? off(SEND_OFF) : off(COEXISTENCE)) });
  if (authorized && !waiting) actions.push({ id: 'cancel', label: nfce ? 'Cancelar NFC-e' : 'Cancelar NF-e', separatorBefore: true, ...(native ? { enabled: writable, reason: writable ? undefined : 'Seu perfil não registra eventos fiscais.' } : off(COEXISTENCE)) });
  if (!nfce) actions.push({ id: 'other', label: 'Outras opções de NF-e', enabled: true });
  if (!nfce && authorized) actions.push({ id: 'correction', label: 'Carta de correção', ...(native ? { enabled: writable, reason: writable ? undefined : 'Seu perfil não registra eventos fiscais.' } : off(COEXISTENCE)) });
  if (!nfce) actions.push({ id: 'complementary', label: 'NFe complementar', ...(!native ? off(COEXISTENCE) : row.access_key && authorized && writable ? { enabled: true } : off('A NF-e complementar precisa de uma nota autorizada com chave de acesso.')) });
  const danfe = !native ? off(ORIGIN_DANFE_REASON) : danfeReady(row) ? { enabled: true } : off(DANFE_NATIVE_OFF);
  // The PDF file is the DANFE retrato A4; the Origin NFC-e menu has no "Gerar PDF DANFE" (its DANFE is printed).
  if (authorized && !nfce) actions.push({ id: 'pdf', label: 'Gerar PDF DANFE', ...danfe });
  const blocked = status === 3 || status === 10, posted = Boolean(finance?.posted);
  // Emitir boletos: the contas a receber lançadas by the note go to Incluir Remessa of the cobrança Itaú (bank operations stay off).
  if (!nfce) actions.push({ id: 'boleto', label: 'Emitir boletos', ...(!native ? off(COEXISTENCE) : config.direction === '0' ? off('Boletos são das contas a receber das notas de saída.') : !finance ? off(FINANCE_UNREAD)
    : !finance.writable ? off(FINANCE_ROLE) : !posted ? off('Os boletos saem das contas lançadas pela nota: use Lançar contas antes.') : { enabled: true }) });
  actions.push({ id: 'finance', label: posted ? 'Estornar contas' : 'Lançar contas', ...(!native ? off(COEXISTENCE) : !finance ? off(blocked ? 'Nota cancelada ou denegada não lança contas.' : FINANCE_UNREAD) : !finance.writable ? off(FINANCE_ROLE)
    : finance.grouped ? off(FINANCE_GROUPED) : blocked && !posted ? off('Nota cancelada ou denegada não lança contas.') : { enabled: true }) });
  // Estoque lane (259): Lançar estoque / Estornar estoque of a Brufap note; Origin hides the reversal when the order posted the stock (R).
  if (native && stock?.flag === 'S') actions.push({ id: 'stock_reverse', label: 'Estornar estoque', ...(stock.manage ? { enabled: true } : off('Somente administrador e estoque estornam o estoque da nota.')) });
  else {
    const stockOff = blocked ? 'Nota cancelada ou denegada não lança estoque.' : !native ? COEXISTENCE : !stock ? 'Não foi possível consultar o estoque da nota. Recarregue a listagem.'
      : stock.flag === 'R' ? `Estoque lançado pela referência${stock.reference ? ` (pedido ${stock.reference})` : ''}: o estorno é feito pelo pedido.` : !stock.manage ? 'Somente administrador e estoque lançam o estoque da nota.' : null;
    actions.push({ id: 'stock', label: 'Lançar estoque', ...(stockOff ? off(stockOff) : { enabled: true }) });
  }
  // Gerar devolução opens a note of finalidade 4 in the other direction referencing this key (a homologation test draft).
  if (authorized || status === 8) actions.push({ id: 'return', label: 'Gerar devolução', ...(!native ? off(COEXISTENCE) : !writable ? off('Seu perfil não inclui notas fiscais.') : !row.access_key ? off('A devolução precisa da chave de acesso da nota.') : { enabled: true }) });
  // Estoque lane (147/184): Check-in de Recebimentos of a native entry note, the physical conferência item by item (Origin order, after Gerar devolução).
  if (config.direction === '0') actions.push({ id: 'checkin', label: 'Check-in de Recebimentos', icon: 'file-signature', ...(!native ? off('Nota do Origin: durante a convivência, o check-in das notas do Origin continua no Origin.') : blocked ? off('Nota cancelada ou denegada não tem check-in.') : checkin === false ? off('Seu perfil não inclui o Check-in de Recebimentos (administrador, estoque e fiscal).') : { enabled: true }) });
  // Formação de preços of an entry note: unit cost and the price suggested by the markup of the preferences.
  if (config.direction === '0') actions.push({ id: 'pricing', label: 'Formação de preços', ...(native ? writable ? { enabled: true } : off('Somente administrador e fiscal.') : off('Nota do Origin: a formação de preços continua no Origin durante a convivência.')) });
  if (nfce) actions.push({ id: 'nfe_from_nfce', label: 'Gerar NF-e', separatorBefore: true, ...(!native ? off(COEXISTENCE) : writable ? { enabled: true } : off('Seu perfil não inclui notas fiscais.')) });
  actions.push({ id: 'clone', label: 'Clonar nota', separatorBefore: !nfce, ...(!native ? off(COEXISTENCE) : writable ? { enabled: true } : off('Seu perfil não inclui notas fiscais.')) });
  if (!nfce) actions.push({ id: 'clone_invert', label: config.direction === '1' ? 'Clonar para entrada' : 'Clonar para saída', ...(!native ? off(COEXISTENCE) : writable ? { enabled: true } : off('Seu perfil não inclui notas fiscais.')) });
  actions.push({ id: 'danfe', label: 'Imprimir DANFE', separatorBefore: true, ...danfe });
  if (!nfce) {
    actions.push({ id: 'danfe_simple', label: 'Imprimir DANFE Simplificado', ...danfe });
    // Preferências lane (230): the product labels of a Brufap note open in Etiquetas customizadas (administrador, like the models).
    actions.push({ id: 'labels', label: 'Imprimir etiquetas', ...(!native ? off('Nota do Origin: as etiquetas das notas do Origin continuam no Origin durante a convivência.') : labels ? { enabled: true } : off('Somente administradores imprimem as Etiquetas customizadas.')) });
    actions.push({ id: 'mirror', label: 'Imprimir espelho NF', ...(native ? { enabled: true } : off('O espelho é gerado com os dados salvos de uma nota do FAGOO.')) });
    if (config.direction === '1') actions.push({ id: 'transport_label', label: 'Imprimir etiqueta de transporte', ...off('A etiqueta de transporte das transportadoras é logística, fora do escopo do FAGOO. As etiquetas de endereço ficam em Mais ações › Imprimir › Etiquetas selecionadas.') });
  }
  // An imported NFC-e (S, wave F) keeps its authorized XML in Brufap, like the imported NF-e (Baixar XML).
  if (nfce) actions.push({ id: 'xml', label: 'Exportar XML', ...(row.xml_id || isImported(row) ? { enabled: true } : off(native ? 'Nota do FAGOO sem XML autorizado.' : 'O XML desta nota ainda não foi coletado do Origin.')) });
  // Notas lane (wave F, 202610200273): "Gerar XML (suporte)" shows the native XML of a Brufap NFC-e, built from the saved note (not signed).
  if (nfce) { const block = nativeXmlBlock(row, writable); actions.push({ id: 'support_xml', label: 'Gerar XML (suporte)', ...(block ? off(block) : { enabled: true }) }); }
  return actions;
}
// Badge tones observed in Origin (capture of 19/10/2026), mapped to the shared tone classes.
const TONES: Record<number, [string, boolean]> = { 1: ['warning', false], 2: ['warning', false], 3: ['warning', true], 4: ['neutral', true], 5: ['danger', false], 6: ['success', true],
  7: ['progress', false], 8: ['info', false], 9: ['neutral', false], 10: ['overdue', false], 11: ['neutral', false], 12: ['danger', true], 14: ['warning', false], 15: ['warning', false], 16: ['warning', false] };
export function statusClass(row: Pick<ListRow, 'status'>, model: '55' | '65') {
  if (row.status === null) return 'status-badge status-neutral';
  const [tone, bold] = model === '65' && (row.status === 6 || row.status === 7) ? ['success', false] as const : TONES[row.status] ?? ['neutral', false];
  return `status-badge status-${tone}${bold ? ' is-bold' : ''}`;
}
// ---- "Listagem customizada" (per-user list preferences, migration 116) ----
/** Optional columns of each list; Número is always first and Situação always sits right before Valor (Origin keeps both fixed). */
export type FiscalColumn = 'date' | 'issue_date' | 'entry_date' | 'exit_date' | 'series' | 'order_numbers' | 'nature' | 'name' | 'document' | 'state' | 'link' | 'total';
export const LIST_IDS: Record<FiscalScreen, string> = { nfe: 'fiscal.nfe', nfce: 'fiscal.nfce', entrada: 'fiscal.entrada' };
export function fiscalColumns(config: ScreenConfig): { id: FiscalColumn; label: string }[] {
  const common = [{ id: 'series', label: 'Série' }, { id: 'order_numbers', label: config.direction === '0' ? 'Número da compra' : 'Número da venda' }, { id: 'nature', label: 'Natureza de operação' },
    { id: 'name', label: 'Nome' }, { id: 'document', label: 'CPF/CNPJ' }, { id: 'state', label: 'UF' }] as { id: FiscalColumn; label: string }[];
  if (config.screen === 'entrada') return [{ id: 'date', label: 'Data (do período)' }, { id: 'issue_date', label: 'Data de emissão' }, { id: 'entry_date', label: 'Data de entrada' }, ...common,
    { id: 'link', label: 'Vinculação' }, { id: 'total', label: 'Valor (R$)' }];
  return [{ id: 'date', label: config.dateColumn }, ...(config.model === '55' ? [{ id: 'exit_date' as const, label: 'Data de saída' }] : []), ...common, { id: 'total', label: config.model === '65' ? 'Valor' : 'Valor (R$)' }];
}
export const defaultColumns = (config: ScreenConfig): FiscalColumn[] => config.screen === 'entrada' ? ['date', 'name', 'link', 'total'] : ['date', 'name', 'total'];
/** Rendering order: the chosen columns with Situação inserted before Valor (or at the end without Valor). */
export function columnLayout(columns: readonly string[]): (FiscalColumn | 'status')[] {
  const list = columns.filter(c => c !== 'status') as FiscalColumn[], at = list.indexOf('total');
  return at < 0 ? [...list, 'status'] : [...list.slice(0, at), 'status', ...list.slice(at)];
}
export const formatDocument = (value: string | null) => !value ? '—' : value.length === 14 ? value.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : value.length === 11 ? value.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4') : value;
/** "Vinculação" of an entry note: purchase orders linked through the note (Vincular à pedido de compra). */
export const linkLabel = (row: Pick<ListRow, 'orders'>) => row.orders.length ? `Vinculado: pedido ${row.orders.map(o => o.number).join(', ')}` : 'Não vinculado';
/** "Tornar padrão": the applied filters as list-preference filters (strings only, Origin names kept short). */
export function filtersToPreference(config: ScreenConfig, filters: FiscalFilters): Record<string, string> {
  const out: Record<string, string> = {};
  if (filters.query.trim()) out.q = filters.query.trim();
  if (filters.status) out.status = filters.status;
  if (filters.from) out.from = filters.from;
  if (filters.to) out.to = filters.to;
  if (config.dateTypes.length && filters.dateType !== (config.dateTypes[0]?.value ?? 'issue')) out.date_type = filters.dateType;
  if (filters.state) out.state = filters.state;
  if (filters.product) { out.product_id = filters.product.id; out.product_name = filters.product.name.slice(0, 200); }
  if (config.sellerFilter && filters.seller) { out.seller_id = filters.seller.id; out.seller_name = filters.seller.name.slice(0, 200); }
  if (filters.tag) { out.tag_id = filters.tag.id; out.tag_name = filters.tag.name.slice(0, 200); }
  if (config.categoryFilter && filters.category) { out.category_id = filters.category.id; out.category_name = filters.category.name.slice(0, 200); }
  for (const key of config.customFilters) { const value = filters.custom[key]?.trim(); if (value) out[`f_${key}`] = value; }
  return out;
}
/** Saved default filters back to the screen; anything invalid for this screen is ignored (never sent to the server). */
export function filtersFromPreference(config: ScreenConfig, saved: Record<string, unknown> | null): FiscalFilters | null {
  if (!saved) return null;
  const text = (key: string) => typeof saved[key] === 'string' ? saved[key] as string : '';
  const next = emptyFilters(config);
  next.query = text('q'); next.status = text('status'); next.from = text('from'); next.to = text('to'); next.state = text('state');
  const type = text('date_type'); if (config.dateTypes.some(t => t.value === type)) next.dateType = type as FiscalFilters['dateType'];
  if (UUID.test(text('product_id'))) next.product = { id: text('product_id').toLowerCase(), name: text('product_name') || 'Produto' };
  if (config.sellerFilter && UUID.test(text('seller_id'))) next.seller = { id: text('seller_id').toLowerCase(), name: text('seller_name') || 'Vendedor' };
  if (text('tag_id') === 'none' || UUID.test(text('tag_id'))) next.tag = { id: text('tag_id').toLowerCase(), name: text('tag_id') === 'none' ? 'Sem Tag' : text('tag_name') || 'Tag' };
  if (config.categoryFilter && UUID.test(text('category_id'))) next.category = { id: text('category_id').toLowerCase(), name: text('category_name') || 'Categoria' };
  for (const key of config.customFilters) if (text(`f_${key}`)) next.custom[key] = text(`f_${key}`);
  try { fiscalListQuery(config, 'origin', next); return next; } catch { return null; }
}
// ---- "Importar XML NF-e": reasons the Worker or the database give for not importing ----
// Wave F (202610200274): the signature of the XML and the NFC-e of another company with the company as consumer.
export const IMPORT_REFUSALS = ['xml_invalid', 'xml_too_large', 'xml_unsupported', 'xml_not_authorized', 'xml_homologation', 'xml_total_mismatch', 'company_missing', 'other_company', 'duplicate',
  'xml_signature_missing', 'xml_signature_invalid', 'nfce_recipient'] as const;
const brAmount = (value: string | null | undefined) => value && /^\d+\.\d{2}$/.test(value) ? value.replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.') : '—';
export function importRefusalText(value: { refused: string; field?: string; computed_total?: string; xml_total?: string | null }): string {
  switch (value.refused) {
    case 'xml_invalid': return 'O arquivo não é um XML de NF-e válido. Nada foi importado.';
    case 'xml_too_large': return 'O XML pode ter até 1 MB. Nada foi importado.';
    case 'xml_unsupported': return `O FAGOO importa NF-e (modelo 55) e NFC-e (modelo 65) 4.00 de mercadorias, nos formatos do cadastro da nota${value.field ? ` (campo ${value.field})` : ''}. Nada foi importado.`;
    case 'xml_signature_missing': return 'O XML não tem a assinatura digital do emitente. Nada foi importado.';
    case 'xml_signature_invalid': return `A assinatura digital do XML não confere${value.field ? ` (${value.field})` : ''}: o arquivo foi alterado depois de assinado, o protocolo é de outro XML ou o certificado não é do emitente. Nada foi importado.`;
    case 'nfce_recipient': return 'A NFC-e é importada só quando a empresa é a emitente: a NFC-e em que a empresa é consumidora não é uma nota de compra. Nada foi importado.';
    case 'xml_not_authorized': return 'O XML não traz a autorização de uso da SEFAZ (protocolo 100 ou 150). Nada foi importado.';
    case 'xml_homologation': return 'XML de homologação, sem valor fiscal, não é importado.';
    case 'xml_total_mismatch': return `O total calculado pelo FAGOO (R$ ${brAmount(value.computed_total)}) é diferente do total do XML (R$ ${brAmount(value.xml_total)}). Nada foi importado.`;
    case 'company_missing': return 'Informe o CNPJ da empresa em Dados da empresa antes de importar notas.';
    case 'other_company': return 'A empresa não é a emitente nem a destinatária deste XML. Nada foi importado.';
    case 'duplicate': return 'Esta nota já foi importada (mesma chave de acesso).';
    default: return 'O XML não foi importado.';
  }
}
/** Número, série and issuer document read from an NF-e access key (cUF AAMM CNPJ mod serie nNF tpEmis cNF cDV). */
export function keyParts(key: string | null): { number: string; series: string; issuer: string; model: string } | null {
  if (!key || !/^\d{44}$/.test(key)) return null;
  return { model: key.slice(20, 22), series: String(Number(key.slice(22, 25))), number: key.slice(25, 34).replace(/^0+(?=\d{6})/, ''), issuer: formatDocument(key.slice(6, 20)) };
}
export const isImported = (row: Pick<ListRow, 'origin' | 'issue_type'>) => row.origin === 'brufap' && (row.issue_type === 'S' || row.issue_type === 'X');
/** Notas lane (wave F): why the native XML of a row ("Validar", "Gerar XML (suporte)") cannot be built; null when it can. */
export function nativeXmlBlock(row: Pick<ListRow, 'origin' | 'issue_type'>, writable: boolean): string | null {
  if (!isNative(row)) return 'Nota do Origin: a validação e o XML das notas do Origin continuam no Origin durante a convivência.';
  if (isImported(row) || row.issue_type === 'T') return 'Nota registrada (emitida por terceiros ou importada do XML): o XML dela não é gerado pelo FAGOO.';
  if (!writable) return 'Somente administrador e fiscal geram o XML das notas do FAGOO.';
  return null;
}
// ---- "Vincular à pedido de compra": summary of the items already in the note and the ones of the order ----
export interface LinkLine { key: string; description: string; note: string; order: string; state: 'Vinculado' | 'Quantidade diferente' | 'Só na nota' | 'Só no pedido' }
const qty4 = (value: unknown) => { const text = String(value ?? '').trim(); if (!/^\d{1,11}(\.\d{1,10})?$/.test(text)) return 0n; const [w, f = ''] = text.split('.'); return BigInt(w) * 10000n + BigInt((f + '0000').slice(0, 4)); };
const qtyText = (value: bigint) => { const whole = value / 10000n, fraction = String(value % 10000n).padStart(4, '0').replace(/0+$/, ''); return fraction ? `${whole},${fraction}` : String(whole); };
/** Items grouped by product (or description without product): note quantity, order quantity and the Origin-like state. */
export function orderLinkSummary(noteItems: readonly { product_id?: unknown; description?: unknown; quantity?: unknown }[], orderItems: readonly { product_id?: unknown; description?: unknown; quantity?: unknown }[]): LinkLine[] {
  const lines = new Map<string, { description: string; note: bigint; order: bigint; inNote: boolean; inOrder: boolean }>();
  const add = (item: { product_id?: unknown; description?: unknown; quantity?: unknown }, side: 'note' | 'order') => {
    const key = typeof item.product_id === 'string' && item.product_id ? `p:${item.product_id}` : `d:${String(item.description ?? '').trim().toLowerCase()}`;
    const line = lines.get(key) ?? { description: String(item.description ?? '—'), note: 0n, order: 0n, inNote: false, inOrder: false };
    line[side] += qty4(item.quantity); if (side === 'note') line.inNote = true; else line.inOrder = true; lines.set(key, line);
  };
  noteItems.forEach(item => add(item, 'note')); orderItems.forEach(item => add(item, 'order'));
  return [...lines.entries()].map(([key, l]) => ({ key, description: l.description, note: l.inNote ? qtyText(l.note) : '—', order: l.inOrder ? qtyText(l.order) : '—',
    state: !l.inOrder ? 'Só na nota' : !l.inNote ? 'Só no pedido' : l.note === l.order ? 'Vinculado' : 'Quantidade diferente' }));
}
export type DeleteItem = BatchItem & { row: ListRow };
// Notas lane (wave F): why a note of the Brufap with lançamentos is not deleted. The contas (247) and the stock (259) posted by the note
// stay tied to it, so the database refuses the exclusion until the estorno; the screen says which one, before and after asking.
export const DELETE_FINANCE_POSTED = 'A nota tem contas lançadas por ela (letra C): use ⋮ Estornar contas antes de excluir.';
export const DELETE_FINANCE_GROUPED = 'A nota está num Faturamento agrupado: as contas são do faturamento e a nota só é excluída depois que o faturamento for desfeito.';
export const DELETE_STOCK_POSTED = 'A nota tem estoque lançado por ela (letra E): use ⋮ Estornar estoque antes de excluir.';
/** The lançamentos known for a row of the page (finance flags and the letter E); null when the page has not read them. */
export interface DeleteEffects { finance: InvoiceFinanceState; stock: RowStock | null }
export function deleteBlockedReason(effects: DeleteEffects | null): string | null {
  if (!effects) return null;
  const reasons = [effects.finance?.grouped ? DELETE_FINANCE_GROUPED : effects.finance?.posted ? DELETE_FINANCE_POSTED : null, effects.stock?.flag === 'S' ? DELETE_STOCK_POSTED : null].filter(Boolean);
  return reasons.length ? reasons.join(' ') : null;
}
/** The specific refusal of the API for a deletion (field finance_posted / stock_posted); null for any other answer. */
export function deleteRefusalText(field: string | undefined, effects: DeleteEffects | null): string | null {
  if (field === 'finance_posted') return effects?.finance?.grouped ? DELETE_FINANCE_GROUPED : DELETE_FINANCE_POSTED;
  if (field === 'stock_posted') return DELETE_STOCK_POSTED;
  return null;
}
/** Only Brufap notes are deleted; Origin notes are listed as not deleted, like Origin's "As seguintes notas não foram excluídas". */
export function deletePlan(rows: readonly ListRow[], effects: (row: ListRow) => DeleteEffects | null = () => null): BatchPlan<DeleteItem> {
  return planBatch(rows.map(row => ({ id: `${row.origin}:${row.id}`, label: `Nota ${invoiceNumber(row)} · ${row.name ?? 'Sem nome'}`, row })),
    item => item.row.origin === 'origin' ? 'Nota do Origin: a exclusão continua no Origin.' : deleteBlockedReason(effects(item.row)));
}
/** Moment in São Paulo, as Origin prints it: dd/mm/aaaa às hh:mm. */
export function brMoment(value: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return '—';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(value)).map(p => [p.type, p.value]));
  return `${parts.day}/${parts.month}/${parts.year} às ${parts.hour}:${parts.minute}`;
}
export interface NatureReview { confirmed: boolean; version: number; confirmed_at: string | null }
export const natureReviewText = (review: NatureReview) => review.confirmed ? `Revisão confirmada em ${brMoment(review.confirmed_at)}.` : 'A revisão das naturezas de operação ainda não foi confirmada.';
export const orderIndicator = (row: ListRow) => orderIndicators(row)[0] ?? null;
// ---- "Etiquetas selecionadas" (Mais ações › Imprimir): A4 address labels of the selected notes ----
type Address = { street?: unknown; number?: unknown; complement?: unknown; district?: unknown; city?: unknown; state?: unknown; postal_code?: unknown };
const part = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : '';
/** One line address as the labels print it (street, number, complement, district, city - UF, CEP). */
export function addressLine(a: Address | null | undefined): string | null {
  if (!a) return null;
  const postal = part(a.postal_code).replace(/\D/g, ''), city = [part(a.city), part(a.state)].filter(Boolean).join(' - ');
  const parts = [[part(a.street), part(a.number)].filter(Boolean).join(', '), part(a.complement), part(a.district), city, postal.length === 8 ? `CEP ${postal.slice(0, 5)}-${postal.slice(5)}` : ''].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}
/** Label of a note: the delivery address first ("Endereço de entrega diferente da cobrança"), otherwise the recipient's. */
export function noteLabel(row: Pick<ListRow, 'number'>, recipient: { name?: unknown } & Address, delivery: ({ name?: unknown } & Address) | null) {
  const useDelivery = Boolean(delivery && (part(delivery.street) || part(delivery.city)));
  return { name: part(useDelivery ? delivery!.name : '') || part(recipient.name) || 'Sem nome', address: addressLine(useDelivery ? delivery : recipient), reference: `NF ${invoiceNumber(row)}` };
}
/** Letra C verde "Conta lançada pela NF" (SQL 247), beside the letters of the origin documents. */
export const financeIndicator = (posted: boolean | undefined) => posted ? [{ text: 'C', color: 'green', title: 'Conta lançada pela NF' }] : [];
/** Origin letters of the origin documents: V (pedidos) and, on exit notes, O (ordens de serviço, 202610200176). */
export function orderIndicators(row: ListRow) {
  const sales = row.orders.filter(o => o.kind !== 'service_orders'), services = row.orders.filter(o => o.kind === 'service_orders');
  return [...(sales.length ? [{ text: 'V', color: 'orange', title: sales.map(o => `Número pedido: ${o.number} - Data: ${brDay(o.date)} - Cliente: ${o.contact_name ?? '—'}`).join(', ') }] : []),
    ...(services.length ? [{ text: 'O', color: 'green', title: services.map(o => `Número ordem de serviço: ${o.number} - Data: ${brDay(o.date)} - Cliente: ${o.contact_name ?? '—'}`).join(', ') }] : [])];
}
