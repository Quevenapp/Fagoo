// "Importar › Pedido XML" (202610200167): the answer of the API becomes a new pedido in the form, reviewed and saved by the
// user (nothing is saved by the import). Decimals stay exact strings.
import { calculateDocument, type DocumentInput, type DocumentKind } from './real-documents-model.ts';
import type { QuickContactValues } from './document-editor-pickers.ts';

export interface XmlImportItem { code: string | null; gtin: string | null; description: string; unit: string; quantity: string; unit_price: string; ncm: string | null;
  product: { id: string; name: string; code: string | null; unit: string | null; by: 'gtin' | 'code' } | null }
export interface XmlImportResult { key: string; number: string; series: string; issue_date: string; xml_total: string | null; contact: { id: string; name: string } | null;
  party: { name: string; person_type: 'F' | 'J' | 'E' | null; document: string | null; ie: string | null; email: string | null; phone: string | null; postal_code: string | null; street: string | null;
    number: string | null; complement: string | null; district: string | null; city: string | null; state: string | null };
  items: XmlImportItem[]; freight: string; discount: string; other_expenses: string; freight_mode: string | null; installments: { due_date: string; amount: string }[]; notes: string | null }
export interface ImportDraft { kind: DocumentKind; data: DocumentInput; contact: { id: string; name: string } | null; quick: QuickContactValues | null; notices: string[];
  /** 202610200196 "Gerar venda" / "Gerar ordem de serviço": the proposta concluded by the save of this new document. */
  source_proposal?: { id: string; expected_version: number }; price_list_name?: string | null;
  /** 202610200197 "Sacola de vendas": the bag is emptied after this new pedido is saved. */
  sales_bag?: true }
export const XML_IMPORT_MAX_BYTES = 1024 * 1024;
export const XML_IMPORT_REFUSED = 'O XML não pôde ser lido. Use o XML autorizado de uma NF-e modelo 55 emitida em produção (até 1 MB e 250 itens).';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The worker checks every field; this guards the kind and the item count of a late or foreign answer. */
export function readXmlImport(value: unknown): XmlImportResult {
  const result = value as XmlImportResult | null;
  if (!result || typeof result.number !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(result.issue_date) || !Array.isArray(result.items) || !result.items.length || result.items.length > 250
    || (result.contact !== null && (!result.contact || !UUID.test(result.contact.id))) || !result.party) throw new Error('XML_IMPORT_INVALID');
  return result;
}
const cents = (value: string) => { const [w, f = ''] = value.split('.'); return BigInt(w!) * 100n + BigInt((f + '00').slice(0, 2)); };
const brMoney = (value: string) => `R$ ${value.replace('.', ',')}`;

/** The draft of a new pedido: matched products are linked, the others stay as free items; the customer (or supplier) of the XML. */
export function importDraft(kind: DocumentKind, result: XmlImportResult, today: string): ImportDraft {
  const items = result.items.map(item => ({ id: crypto.randomUUID(), product_id: item.product?.id ?? null, description: item.description, code: item.product ? item.product.code : item.code,
    unit: item.product?.unit || item.unit || 'UN', quantity: item.quantity, unit_price: item.unit_price, discount_percent: '0', detailed_description: null }));
  const date = /^(19|20)\d{2}-\d{2}-\d{2}$/.test(result.issue_date) && result.issue_date <= today ? result.issue_date : today;
  const notices = [`Pedido montado a partir da NF-e nº ${result.number} série ${result.series}. Confira os dados e salve: nada foi gravado ainda.`];
  const base: DocumentInput = { date, contact_id: result.contact?.id ?? '', warehouse_id: null, items, discount_mode: 'amount', discount_value: result.discount, freight: result.freight, other_expenses: result.other_expenses,
    installments: [], notes: result.notes, internal_notes: `Importado do XML da NF-e nº ${result.number} série ${result.series} (chave ${result.key}).`,
    commercial: result.freight_mode ? { introduction: null, attention_to: null, seller_reference: null, store_reference: null, business_unit_reference: null,
      transport: { freight_mode: result.freight_mode as '0', volume_count: null, gross_weight: null, delivery_days: null, carrier_reference: null, service_reference: null, tracking_code: null } } : null };
  let total: string | null = null;
  try { total = calculateDocument(base).total; } catch { notices.push('Os valores do XML não cabem no pedido; confira itens, desconto e frete antes de salvar.'); }
  if (total && result.installments.length) {
    const sum = result.installments.reduce((value, row) => value + cents(row.amount), 0n);
    if (sum === cents(total)) base.installments = result.installments.map(row => ({ due_date: row.due_date, amount: row.amount, method: null, note: null, payment_reference: null }));
    else notices.push('As duplicatas do XML não somam o total do pedido (o pedido não calcula impostos); gere as parcelas de novo antes de salvar.');
  }
  if (total && result.xml_total && result.xml_total !== total) notices.push(`O total da NF-e (${brMoney(result.xml_total)}) é diferente do total do pedido (${brMoney(total)}): o pedido não calcula IPI nem ICMS ST.`);
  const free = items.filter(item => !item.product_id).length;
  if (free) notices.push(`${free} ${free === 1 ? 'item sem produto cadastrado ficou' : 'itens sem produto cadastrado ficaram'} como item livre (procurados pelo GTIN e pelo código).`);
  const party = result.party, noun = kind === 'purchase_orders' ? 'Fornecedor' : 'Cliente';
  let quick: QuickContactValues | null = null;
  if (!result.contact) {
    notices.push(`${noun} do XML não cadastrado: ${party.name || 'sem nome'}${party.document ? ` (${party.document})` : ''}. Use “Cadastrar ${noun.toLowerCase()} do XML” ou escolha outro.`);
    quick = { name: party.name, person_type: party.person_type === 'F' || party.person_type === 'E' ? party.person_type : 'J', document: party.document ?? '', phone: party.phone ?? '', mobile: '', email: party.email ?? '',
      roles: [kind === 'purchase_orders' ? 'supplier' : 'customer'], ie: party.ie ?? '', postal_code: party.postal_code ?? '', state: party.state ?? '', city: party.city ?? '', district: party.district ?? '',
      street: party.street ?? '', number: party.number ?? '', complement: party.complement ?? '' };
  }
  return { kind, data: base, contact: result.contact, quick, notices };
}
