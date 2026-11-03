// Vendas > Frente de caixa (PDV) no padrão do Origin: modelo da tela (carrinho, descontos, parcelas, troco, comprovante) e leitura
// das respostas de /v1/frente-caixa (migrações 202610200204-206). Valores sempre em texto decimal ou centavos inteiros, nunca em
// número binário; os totais saem do mesmo cálculo do pedido de venda (packages/erp-domain), que o banco confere de novo.
import { calculateDocument, decimal, format } from '../../../../packages/erp-domain/src/index.mjs';
import { normalizeUnitPrice } from '../../../../packages/erp-domain/src/unit-price.mjs';
import { conditionDays } from './document-payment-condition.ts';
import { addDays } from './origin-list.ts';

export const PDV_API = '/v1/frente-caixa';
export type PdvRole = 'admin' | 'consulta' | 'vendas' | 'financeiro' | 'estoque' | 'fiscal';
export interface PdvPermissions { operate: boolean; items: boolean; payments: boolean; finish: boolean; edit_price: boolean; remove_items: boolean; change_method: boolean }
export interface PdvEffects { stock: boolean; finance: boolean; cash: boolean; fiscal: boolean; settings: boolean; contacts: boolean }
export type PdvOperation = 'nenhum' | 'gerar_nfce' | 'comprovante' | 'pre_venda' | 'nfe_simplificada';
export interface PdvSettings {
  tables: boolean; cash_control: boolean; cash_check_methods: boolean; unique_cash: boolean; default_operation: PdvOperation; default_method: 'nenhum' | 'pix_qrcode_impresso';
  receipt_order: 'alfabetica' | 'insercao'; percent_discount: boolean; closing_statuses: ('atendido' | 'verificado')[]; negative_stock: boolean; block_zero: boolean; item_discount: boolean;
  group_items: boolean; shortcuts: Record<string, string>; sales_negative_stock: boolean; free_items: boolean; seller_required: boolean;
}
export interface PdvReceiptSettings { limit_description: boolean; code: boolean; notes: boolean; comments: boolean; discount: boolean; footer: string | null; font_size: number }
export interface PdvMethod { id: string; description: string; payment_type: string; destination: 'contas' | 'ficha' | 'caixa'; account_id: string | null; condition: string | null; is_default: boolean }
export interface PdvSession { id: string; account_id: string; account_name: string; operator_id: string; operator_name: string; opened_at: string; opened_on: string; change_cents: string; version: number; own: boolean }
export interface Named { id: string; name: string }
export interface PdvPix { key_type: 'cpf' | 'cnpj' | 'email' | 'phone' | 'random'; key: string; merchant_name: string; merchant_city: string }
export interface PdvContext {
  today: string; role: PdvRole; permissions: PdvPermissions; effects: PdvEffects; settings: PdvSettings; receipt: PdvReceiptSettings; stores: Named[]; accounts: (Named & { kind: string })[];
  cash_sessions: PdvSession[]; methods: PdvMethod[]; warehouses: Named[]; default_warehouse: Named | null; seller: Named | null; consumer: (Named & { active: boolean }) | null;
  pix: PdvPix | null; certificate: 'missing' | 'unknown' | 'expired' | 'valid'; settings_version: number;
}
// 202610200267: stock_reason / finance_reason / settle_reason: why a Lançar estoque, Lançar contas or baixa à vista was refused while
// finishing (the effect stays pending in the pedido; the short reason comes from the API list).
export interface PdvEffectsState { stock: 'posted' | 'pending' | 'none' | 'reversed'; finance: 'posted' | 'pending' | 'none' | 'reversed'; settled_cents: string; open_cents: string;
  stock_reason?: string; finance_reason?: string; settle_reason?: string }
export interface PdvSaleSummary {
  id: string; document_id: string; number: string; document_version: number; status: string; state: 'open' | 'finished' | 'cancelled'; kind: 'balcao' | 'mesa'; table_number: number | null; date: string;
  created_at: string; finished_at: string | null; cancelled_at: string | null; operator_id: string; operator_name: string; account_id: string | null; account_name: string | null; cash_session_id: string | null;
  contact_id: string; contact_name: string; customer_identified: boolean; total_cents: string; cash_received_cents: string | null; change_cents: string; effects: PdvEffectsState | Record<string, never>;
  invoice: { id: string; model: '55' | '65'; number: string | null; series: string; status: number } | null; version: number;
}
export interface PdvSaleItem { id: string; position: number; product_id: string | null; description: string; code: string | null; unit: string; quantity: string; unit_price: string; discount_percent: string; gross: string; discount: string; total: string; comment: string | null }
export interface PdvSalePayment { position: number; payment_method_id: string; method_name: string; payment_type: string; days: number; due_on: string; amount_cents: string; note: string | null; title_id: string | null; settlement_id: string | null }
/** A devolução: value_cents is the value of the items returned; refund_cents what left the caixa in cash (never more than the sale received). */
export interface PdvReturn { id: string; created_at: string; value_cents: string; refund_cents: string; reason: string; actor_name: string; stock: boolean; refund_account_id: string | null; items: { item_id: string; quantity: string; value_cents: string }[] }
/** 202610200292: returned_titles = contas a receber em aberto marked Devolvido by the full return (absent before 292). */
export interface PdvReturnResult { value_cents: string; refund_cents: string; stock: boolean; refund: boolean; returned_titles?: number }
export interface PdvSale extends PdvSaleSummary {
  price_list_id: string | null; destination_account_id: string | null; to_ledger: boolean; cancel_reason: string | null; warehouse_id: string | null; warehouse_name: string | null; seller_id: string | null; seller_name: string | null;
  category_id: string | null; expected_date: string | null; notes: string | null; internal_notes: string | null; discount_mode: 'amount' | 'percent'; discount_value: string; freight: string; other_expenses: string;
  totals: { gross: string; line_discount: string; subtotal: string; discount: string; freight: string; other_expenses: string; total: string }; contact_document: string;
  items: PdvSaleItem[]; payments: PdvSalePayment[]; returns?: PdvReturn[]; returned?: Record<string, string>;
}
export interface PdvFavorite { product_id: string; name: string; code: string | null; unit: string | null; price: string | null; gtin: string | null; active: boolean; kind: string | null; stock: string | null }
export interface PdvSummary { session_id: string; statuses: string[]; sales_count: number; total_cents: string; returns_cents: string; methods: { payment_method_id: string; name: string; payment_type: string; registered_cents: string; sales: number }[];
  groups: { group_id: string | null; name: string; quantity: string; value: string; percent: string }[] }

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function fail(): never { throw new Error('PDV_RESPONSE_INVALID'); }
/** The Worker checks every field (502 otherwise); the screen keeps a shape check so an unexpected answer never renders. */
export function pdvContext(value: unknown): PdvContext {
  if (!object(value) || value.entity !== 'pos_context' || value.data_mode !== 'erp_native' || !object(value.settings) || !object(value.permissions) || !Array.isArray(value.stores) || !Array.isArray(value.methods)
    || !Array.isArray(value.cash_sessions) || typeof value.today !== 'string') fail();
  return value as unknown as PdvContext;
}
export function pdvSale(value: unknown): PdvSale {
  const record = object(value) ? value.record : null;
  if (!object(value) || value.entity !== 'pos_sale' || !object(record) || typeof record.id !== 'string' || !Array.isArray(record.items) || !Array.isArray(record.payments)) fail();
  return record as unknown as PdvSale;
}
export function pdvReturnResult(value: unknown): PdvReturnResult {
  const result = object(value) ? value.return : null;
  if (!object(result) || typeof result.value_cents !== 'string' || typeof result.refund_cents !== 'string' || typeof result.stock !== 'boolean' || typeof result.refund !== 'boolean') fail();
  const titled = result.returned_titles !== undefined;
  if (titled && (typeof result.returned_titles !== 'number' || !Number.isInteger(result.returned_titles) || result.returned_titles < 0)) fail();
  return { value_cents: result.value_cents, refund_cents: result.refund_cents, stock: result.stock, refund: result.refund, ...(titled ? { returned_titles: result.returned_titles as number } : {}) };
}
/** The message of a registered devolução (Frente de caixa). */
export function pdvReturnMessage(result: PdvReturnResult, money: (cents: string) => string): string {
  const titles = result.returned_titles ?? 0;
  return `Devolução registrada.${result.stock ? ' Os produtos voltaram ao estoque.' : ''} ${result.refund ? `Valor devolvido em dinheiro: ${money(result.refund_cents)}.` : `Nenhum valor saiu do caixa (itens de ${money(result.value_cents)}).`}`
    + (titles ? ` ${titles === 1 ? 'A conta a receber em aberto da venda ficou' : `${titles} contas a receber em aberto da venda ficaram`} na situação Devolvido.` : '');
}
export function pdvSalesPage(value: unknown): { items: PdvSaleSummary[]; total: number } {
  if (!object(value) || value.entity !== 'pos_sales' || !Array.isArray(value.items) || typeof value.total !== 'number') fail();
  return { items: value.items as PdvSaleSummary[], total: value.total as number };
}
export function pdvFavorites(value: unknown): PdvFavorite[] { if (!object(value) || value.entity !== 'pos_favorites' || !Array.isArray(value.items)) fail(); return value.items as PdvFavorite[]; }
export function pdvSummary(value: unknown): PdvSummary { if (!object(value) || value.entity !== 'pos_cash_summary' || !Array.isArray(value.methods) || !Array.isArray(value.groups)) fail(); return value as unknown as PdvSummary; }

// ---------------------------------------------------------------- Valores
const MAX_CENTS = 99_999_999_999_999n;
/** "12,34" (or "12.34") in reais to integer cents. */
export function moneyCents(text: string): string {
  const value = text.trim().replace(/\s/g, '');
  if (!/^\d{1,12}(?:[,.]\d{1,2})?$/.test(value)) throw new Error('Informe o valor em reais, com até duas casas decimais, sem separador de milhar.');
  const [whole, fraction = ''] = value.split(/[,.]/); const cents = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents > MAX_CENTS) throw new Error('O valor excede o limite permitido.');
  return cents.toString();
}
export function centsText(cents: string | bigint): string { const value = BigInt(cents), abs = value < 0n ? -value : value; return `${value < 0n ? '-' : ''}${abs / 100n},${String(abs % 100n).padStart(2, '0')}`; }
export function money(cents: string | bigint): string { const [whole, fraction] = centsText(cents).split(','); return `R$ ${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${fraction}`; }
/** Decimal text "1.234,5" style is refused; "1,5" and "1.5" become "1.5". */
export function decimalInput(text: string, scale: number, digits: number, message: string): string {
  const value = text.trim().replace(',', '.');
  if (!new RegExp(`^(0|[1-9][0-9]{0,${digits - 1}})(\\.[0-9]{1,${scale}})?$`).test(value)) throw new Error(message);
  return value;
}
export const quantityInput = (text: string) => { const value = decimalInput(text, 6, 9, 'Informe a quantidade com até seis casas decimais.'); if (decimal(value, 6, 9) === 0n) throw new Error('A quantidade deve ser maior que zero.'); return value; };
export const priceInput = (text: string) => { const value = text.trim().replace(',', '.'); try { normalizeUnitPrice(value, 10); } catch { throw new Error('Confira o valor unitário: até dez dígitos inteiros e dez casas decimais.'); } return value; };
export const decimalText = (value: string) => value.replace('.', ',');
export const amountCents = (value: string) => { const [whole, fraction = ''] = value.split('.'); return (BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2))).toString(); };
const amountText = (cents: bigint) => `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
export const quantityText = (value: string) => { const [whole, fraction = ''] = value.split('.'); const trimmed = fraction.replace(/0+$/, ''); return trimmed ? `${whole},${trimmed}` : whole!; };

// ---------------------------------------------------------------- Carrinho
export interface CartItem { id: string; product_id: string | null; description: string; code: string | null; unit: string; quantity: string; unit_price: string; discount_percent: string; comment: string | null;
  list_price: string | null; kind: string | null; gtin?: string | null }
export interface ProductChoice { id: string; name: string; code: string | null; unit: string | null; price: string | null; kind?: string | null }
/** Origin "Agrupar itens idênticos": same produto, desconto, valor unitário e comentário somam as quantidades. */
export function addToCart(cart: readonly CartItem[], line: CartItem, group: boolean): CartItem[] {
  if (group) {
    const index = cart.findIndex(item => item.product_id !== null && item.product_id === line.product_id && item.unit_price === line.unit_price && item.discount_percent === line.discount_percent
      && (item.comment ?? '') === (line.comment ?? ''));
    if (index >= 0) return cart.map((item, i) => i === index ? { ...item, quantity: format(decimal(item.quantity, 6, 9) + decimal(line.quantity, 6, 9), 6).replace(/\.?0+$/, '') } : item);
  }
  return [...cart, line];
}
/** Item discount typed in R$ (Origin) or % becomes the item's discount percent (four decimals), chosen so the discount in cents is exact. */
export function itemDiscountPercent(quantity: string, unitPrice: string, mode: 'amount' | 'percent', value: string): string {
  const text = value.trim();
  if (!text || /^0+(?:[,.]0+)?$/.test(text)) return '0';
  if (mode === 'percent') { const percent = decimalInput(text, 4, 3, 'Informe o desconto em % com até quatro casas.'); if (decimal(percent, 4, 3) > 1_000_000n) throw new Error('O desconto não pode passar de 100%.'); return percent; }
  const target = BigInt(moneyCents(text)), gross = BigInt(lineTotals({ quantity, unit_price: unitPrice, discount_percent: '0' }).gross.replace('.', ''));
  if (target > gross) throw new Error('O desconto não pode ser maior que o subtotal do item.');
  if (target === gross) return '100';
  const rounded = (rate: bigint) => (gross * rate + 500_000n) / 1_000_000n, guess = (target * 1_000_000n + gross / 2n) / gross;
  for (let delta = 0n; delta <= 3n; delta++) for (const rate of [guess - delta, guess + delta]) if (rate >= 0n && rate <= 1_000_000n && rounded(rate) === target) return format(rate, 4).replace(/\.?0+$/, '');
  throw new Error('Este desconto em reais não tem um percentual exato para o item; informe o desconto em % ou use o desconto da venda.');
}
export function lineTotals(item: { quantity: string; unit_price: string; discount_percent: string }) {
  const totals = calculateDocument({ items: [{ description: 'Item', unit: 'UN', quantity: item.quantity, unit_price: item.unit_price, discount_percent: item.discount_percent }], discount_mode: 'amount', discount_value: '0', freight: '0', other_expenses: '0' });
  return totals.items[0]!;
}
export interface SaleAdjustments { discount_mode: 'amount' | 'percent'; discount_value: string; freight: string; other_expenses: string }
export function cartTotals(cart: readonly CartItem[], adjustments: SaleAdjustments) {
  return calculateDocument({ items: cart.map(item => ({ description: item.description, unit: item.unit, quantity: item.quantity, unit_price: item.unit_price, discount_percent: item.discount_percent })), ...adjustments });
}
export const totalCents = (totals: { total: string }) => amountCents(totals.total);
/** Body of the pedido for /v1/frente-caixa/actions/sale_* (the server adds the cliente, the parcelas and the transport). */
export function saleDocument(cart: readonly CartItem[], adjustments: SaleAdjustments, extra: { date: string; warehouse_id: string | null; expected_date: string | null; notes: string; internal_notes: string; seller_id: string | null; category_id: string | null }) {
  return { date: extra.date, warehouse_id: extra.warehouse_id, expected_date: extra.expected_date || null,
    items: cart.map(item => ({ id: item.id, product_id: item.product_id, description: item.description, code: item.code, unit: item.unit, quantity: item.quantity, unit_price: item.unit_price,
      discount_percent: item.discount_percent, detailed_description: item.comment?.trim() ? item.comment.trim() : null })),
    discount_mode: adjustments.discount_mode, discount_value: adjustments.discount_value, freight: adjustments.freight, other_expenses: adjustments.other_expenses,
    notes: extra.notes.trim() || null, internal_notes: extra.internal_notes.trim() || null, seller_id: extra.seller_id, category_id: extra.category_id };
}

// ---------------------------------------------------------------- Pagamento
/** `amount_text` keeps what the operator is typing in Valor until it is a valid amount (`amount_cents` is what is sent). */
export interface PaymentRow { key: string; payment_method_id: string; days: number; amount_cents: string; note: string; amount_text?: string }
/** "Condição" + "Gerar parcelas": 0 (à vista), 30, 30 60 90, 3x or 15 +2x; exact cents with the remainder in the first parcels. */
export function generatePayments(total: string, condition: string, methodId: string): PaymentRow[] {
  const cents = BigInt(total), text = condition.trim();
  if (!methodId) throw new Error('Escolha a forma de pagamento.');
  if (cents <= 0n) throw new Error('Inclua os produtos antes de gerar as parcelas.');
  const days = !text || text === '0' ? [0] : conditionDays(text), count = BigInt(days.length);
  if (cents < count) throw new Error('Cada parcela precisa ter pelo menos R$ 0,01.');
  return days.map((day, index) => ({ key: globalThis.crypto.randomUUID(), payment_method_id: methodId, days: day, amount_cents: (cents / count + (BigInt(index) < cents % count ? 1n : 0n)).toString(), note: '' }));
}
export const paymentsTotal = (rows: readonly PaymentRow[]) => rows.reduce((sum, row) => sum + BigInt(row.amount_cents || '0'), 0n);
/** Troco em dinheiro: calculado das parcelas à vista em Dinheiro (01) ou Cheque (02). */
export function cashChange(rows: readonly PaymentRow[], methods: readonly PdvMethod[], received: string | null) {
  const cash = rows.reduce((sum, row) => sum + (row.days === 0 && ['01', '02'].includes(methods.find(method => method.id === row.payment_method_id)?.payment_type ?? '') ? BigInt(row.amount_cents) : 0n), 0n);
  const value = received === null ? null : BigInt(received);
  return { cash, received: value, change: value === null ? 0n : value - cash };
}
export const dueDate = (today: string, days: number) => addDays(today, days);
export const PIX_TYPES = ['17', '20'];
export const pixCents = (rows: readonly PaymentRow[], methods: readonly PdvMethod[]) => rows.reduce((sum, row) => sum + (row.days === 0 && PIX_TYPES.includes(methods.find(method => method.id === row.payment_method_id)?.payment_type ?? '') ? BigInt(row.amount_cents) : 0n), 0n);

// ---------------------------------------------------------------- Comprovante
/** Ordem de impressão do comprovante não fiscal: Alfabética ou Inserção. */
export function receiptItems(sale: Pick<PdvSale, 'items'>, order: 'alfabetica' | 'insercao') {
  const items = [...sale.items];
  return order === 'alfabetica' ? items.sort((a, b) => a.description.localeCompare(b.description, 'pt-BR', { sensitivity: 'base' }) || a.position - b.position) : items.sort((a, b) => a.position - b.position);
}
export const dateTimeSP = (value: string | null) => value ? new Date(value).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '—';
export const dateBR = (value: string | null) => value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value.split('-').reverse().join('/') : '—';
export const SALE_STATES: Record<PdvSaleSummary['state'], string> = { open: 'Em aberto', finished: 'Finalizada', cancelled: 'Cancelada' };
export const EFFECT_LABELS: Record<string, string> = { posted: 'Lançado', pending: 'Pendente', none: 'Sem efeito', reversed: 'Estornado' };

// ---------------------------------------------------------------- Mensagens
const REASONS: Record<string, string> = {
  consumer_required: 'Informe o cliente ou defina o cliente padrão (Consumidor final) nas configurações da frente de caixa.',
  cash_session_required: 'Para habilitar as funcionalidades do frente de caixa, o caixa deve ser aberto.',
  cash_session_unavailable: 'O caixa foi fechado ou não está disponível para o seu usuário. Abra ou escolha outro caixa.',
  stock_insufficient: 'Estoque insuficiente no depósito para um dos produtos (Preferências › Frente de caixa não permite estoque negativo).',
  stock_zero: 'Um dos produtos está com estoque zero e "Bloquear vendas com quantidade zero" está ligado.',
  stock_policy: 'O lançamento de estoque deixaria o saldo negativo: a política de estoque negativo de Preferências › Suprimentos e Vendas não permite.',
  payments_mismatch: 'A soma das parcelas precisa ser igual ao total da venda.', payments_required: 'Registre o pagamento da venda antes de finalizar.',
  cash_received_invalid: 'O valor recebido em dinheiro precisa cobrir as parcelas à vista em dinheiro ou cheque.',
  edit_price_denied: 'Seu vendedor não pode editar o preço unitário (módulo Frente de Caixa do cadastro de vendedores).',
  remove_items_denied: 'Seu vendedor não pode excluir itens da venda (módulo Frente de Caixa).', change_method_denied: 'Seu vendedor não pode alterar a forma de pagamento das parcelas.',
  items_denied: 'Seu vendedor não pode registrar itens na frente de caixa.', payments_denied: 'Seu vendedor não pode registrar o pagamento: envie a pré-venda para o caixa.',
  finish_denied: 'Seu vendedor não pode fazer o fechamento da venda: envie a pré-venda para o caixa.', access_denied: 'Seu perfil não pode fazer esta operação na frente de caixa.',
  tables_disabled: 'O controle de mesas está desligado em Preferências › Vendas › Frente de caixa.', table_busy: 'Já existe uma comanda aberta nesta mesa.',
  invoice_linked: 'A venda tem nota fiscal vinculada: cancele ou exclua a nota nas notas fiscais antes.', sale_state: 'A venda mudou de situação. Atualize a lista de pedidos.',
  document_state: 'O pedido desta venda mudou fora da frente de caixa (Pedidos de venda). Abra a venda de novo na coluna Pedidos para continuar com o pedido atual.', version_conflict: 'A venda foi alterada em outra tela. Atualize e tente de novo.',
  return_exceeds: 'A quantidade devolvida passa da quantidade vendida.',
  return_exceeds_paid: 'O valor da devolução passa do que a venda recebeu: parcelas em aberto (a prazo, cartão a receber ou Ficha Financeira) não são devolvidas em dinheiro. Devolva todos os itens da venda para as contas em aberto ficarem como Devolvido, ou receba ou estorne essas contas antes.',
  return_partial_title: 'Uma parcela desta venda foi recebida em parte: estorne essa baixa nas contas a receber antes de devolver todos os itens.',
  return_titles_locked: 'Uma conta em aberto desta venda está em boleto, faturamento agrupado ou já devolvida: resolva a conta nas contas a receber antes de devolver todos os itens.',
  return_effects_pending: 'O estoque ou as contas desta venda ainda estão pendentes no pedido: lance-os antes de gerar a devolução.',
  returns_limit: 'Esta venda já tem 20 devoluções, o limite por venda.', sale_has_returns: 'A venda tem devolução registrada e não pode mais ser cancelada.',
  price_list_unavailable: 'A lista de preço escolhida não existe mais. Escolha outra lista.', reverse_stock_denied: 'Seu perfil não pode estornar o estoque desta venda.',
  reverse_finance_denied: 'Seu perfil não pode estornar as contas desta venda.', return_stock_denied: 'Seu perfil não pode lançar a devolução no estoque.',
  return_finance_denied: 'Seu perfil não pode devolver o dinheiro pelo caixa.', pix_key_invalid: 'Confira a chave Pix para o tipo escolhido.',
  favorites_limit: 'A lista de favoritos já tem 200 produtos.', store_invalid: 'Escolha a loja (conta Caixa) do caixa aberto.', date_invalid: 'A data da venda é a de hoje: atualize a tela.',
  contact_unavailable: 'O cliente não está disponível (inativo ou excluído).', payment_method_unavailable: 'A forma de pagamento não está disponível para recebimentos.',
  reason_required: 'Informe o motivo com pelo menos três caracteres.', ledger_requires_contact: 'O destino Ficha Financeira precisa do cliente identificado.', seller_discount_limit: 'O desconto passa do limite de desconto do vendedor.',
  seller_required: 'O vendedor é obrigatório nos pedidos de venda (Preferências › Vendas).', product_required: 'A venda de produtos não cadastrados não está liberada.',
  transition_unavailable: 'A situação Atendido não está liberada no Gerenciador de transições para este pedido.', price_decimals: 'O preço tem mais casas decimais que as Preferências permitem.',
  quantity_decimals: 'A quantidade tem mais casas decimais que as Preferências permitem (Empresa › Geral).',
  warehouse_unavailable: 'Escolha um depósito ativo para lançar o estoque.', stock_product_unavailable: 'Um dos produtos não pode movimentar estoque (inativo, sem unidade ou com composição).',
  finance_reverse_blocked: 'As contas desta venda já têm baixas ou boletos de outras operações e não podem ser estornadas aqui.',
  account_opening_date: 'A conta financeira tem saldo inicial depois de hoje.', account_invalid: 'A conta financeira escolhida não está ativa.',
  category_unavailable: 'A categoria da venda não pode ser usada nas contas.', installment_invalid: 'Uma parcela vence antes da data da venda.',
  permission_denied: 'Seu usuário não tem a permissão deste lançamento (Sistema › Usuários › Permissões).',
};
const EFFECT_REFUSED = 'O lançamento foi recusado; confira o pedido.';
/** Why an effect stayed pending (the short reason of the API), with a generic text for any other refusal. */
export const effectReasonText = (reason: string | undefined) => reason ? (Object.hasOwn(REASONS, reason) ? REASONS[reason]! : EFFECT_REFUSED) : '';
/**
 * Message after finishing: pending effects say what to do in the pedido; a refused effect (202610200267) says why, and a refused baixa
 * à vista leaves the parcela open in Contas a receber.
 */
export function finishNotice(effects: PdvEffectsState | Record<string, never>): string {
  if (!('stock' in effects)) return '';
  const refused = [effects.stock_reason ? `O estoque ficou pendente no pedido (use Lançar estoque): ${effectReasonText(effects.stock_reason)}` : '',
    effects.finance_reason ? `As contas ficaram pendentes no pedido (use Lançar contas): ${effectReasonText(effects.finance_reason)}` : '',
    effects.settle_reason ? `A baixa à vista não foi feita e a parcela ficou em aberto em Contas a receber: ${effectReasonText(effects.settle_reason)}` : ''].filter(Boolean);
  if (refused.length) return ` ${refused.join(' ')}`;
  return effects.stock === 'pending' || effects.finance === 'pending' ? ' O estoque e as contas ficaram pendentes no pedido: o seu perfil não os lança.' : '';
}
export function pdvFailure(error: unknown): string {
  // AccessError of the access controller (status, code and the allow-listed reason in field).
  const failure = error as { status?: unknown; field?: unknown } | null;
  if (failure && typeof failure === 'object' && typeof failure.status === 'number') {
    if (typeof failure.field === 'string' && Object.hasOwn(REASONS, failure.field)) return REASONS[failure.field]!;
    const status = failure.status;
    if (status === 409) return 'A venda ou o caixa mudou enquanto você trabalhava. Atualize e confira.';
    if (status === 403) return 'Seu acesso a esta operação foi alterado.';
    if (status === 404) return 'Registro não encontrado. Atualize a frente de caixa.';
    if (status === 400) return 'A operação não foi aceita. Confira os campos da venda.';
    return 'Não foi possível concluir a operação. Tente novamente.';
  }
  return error instanceof Error ? error.message : 'Não foi possível concluir a operação.';
}
export const pdvAmount = amountText;
/** Money of one unit at the given unit price (rounded to cents as the pedido does). */
export function unitMoney(price: string | null): string { try { return money(amountCents(lineTotals({ quantity: '1', unit_price: priceInput(price ?? '0'), discount_percent: '0' }).total)); } catch { return money('0'); } }
/** Takes one unit off the last line with the code or GTIN read ("Remover produto a partir do GTIN"); null when no line has it. */
export function removeOneByCode(cart: readonly CartItem[], code: string): { cart: CartItem[]; item: CartItem } | null {
  const wanted = code.trim().toLowerCase(); if (!wanted) return null;
  let index = -1; for (let i = cart.length - 1; i >= 0; i--) { const item = cart[i]!; if (item.code?.trim().toLowerCase() === wanted || (item.gtin && item.gtin.trim() === code.trim())) { index = i; break; } }
  if (index < 0) return null;
  const item = cart[index]!, units = decimal(item.quantity, 6, 9);
  return { item, cart: units > 1_000_000n ? cart.map((row, i) => i === index ? { ...row, quantity: format(units - 1_000_000n, 6).replace(/\.?0+$/, '') } : row) : cart.filter((_, i) => i !== index) };
}
