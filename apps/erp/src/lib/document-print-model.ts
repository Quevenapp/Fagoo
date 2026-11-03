import { STATES, calculateDocument, normalizeCommercial, type DocumentKind } from '../../../../packages/erp-domain/src/index.mjs';
import {commercialReferenceText,FREIGHT_MODES} from './document-commercial-model.ts';
import type { DocumentRecord } from './real-documents-model';
import type {CompanyRecord} from './company-model';
import {normalizeCompany} from '../../../../packages/erp-domain/src/company.mjs';
import type {DocumentPrintPreferences,OsLabel} from './document-preferences';
import {warrantyUntil} from './document-preferences.ts';
import {code128} from './barcodes.ts';
import type {StructureItem} from './document-structure-model';
import {groupTotals,itemGroup,serviceItemLabel} from './service-order-items.ts';
import {normalizeRichText,richTextEmpty,type RichText} from './rich-text-model.ts';
// 202610200287/288/294: IPI % of the pedido de compra, Garantia of the items of the OS, campos customizados of the OS, images, rodapé and
// the description of the product at the supplier.
import {itemIpi} from '../../../../packages/erp-domain/src/index.mjs';
import {printableCustomFields,type DocumentCustomField} from './document-custom-fields.ts';

const TITLES: Record<DocumentKind, string> = { sales_proposals: 'Proposta comercial / orçamento', sales_orders: 'Pedido de venda', purchase_orders: 'Pedido de compra', service_orders: 'Ordem de serviço' };
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null;
/** Decimal formatting never crosses a floating-point boundary. */
export function printDecimal(value: string, minimumFraction = 0): string {
  if (!/^(0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value) || !Number.isInteger(minimumFraction) || minimumFraction < 0 || minimumFraction > 6) throw new Error('PRINT_DECIMAL_INVALID');
  const [whole, raw = ''] = value.split('.');
  const fraction = raw.replace(/0+$/, '').padEnd(minimumFraction, '0');
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + (fraction ? `,${fraction}` : '');
}
export const printMoney = (value: string): string => {
  if (!/^(0|[1-9][0-9]*)\.[0-9]{2}$/.test(value)) throw new Error('PRINT_AMOUNT_INVALID');
  return `R$ ${printDecimal(value, 2)}`;
};
const date = (value: string | null | undefined) => value ? value.split('-').reverse().join('/') : null;

// Origin "Opções de impressão": Normal | Detalhada and the order of the items (Inserção | Alfabética | Localização | Código).
export type PrintItemOrder = 'insertion' | 'alphabetical' | 'code' | 'location';
/**
 * \`prefs\`: Configuração de Impressão of the kind's Preferências page; \`labels\`: OS "Rótulos"; \`technician\`: Origin "Imprimir para
 * técnico" (the OS print with "Ocultar colunas de valores" and "Ocultar dados do cliente" applied).
 */
export interface PrintOptions { detailed?: boolean; order?: PrintItemOrder; prefs?: DocumentPrintPreferences; labels?: Partial<Record<OsLabel, string>>; technician?: boolean;
  /** Pedido de compra, Código secundário "Código no fornecedor": product id → code at the supplier (produtos lane, useSupplierCodes). */
  supplierCodes?: Readonly<Record<string, string | null>>;
  /** 202610200199 Proposta › Assinatura (Saudação e Departamento "Definido por usuário") of the user who prints. */
  userSignature?: { greeting: string | null; department: string | null; name: string | null } | null;
  /** 202610200240: the structures of the products (useDocumentStructures) and the "Opções de impressão" that use them. */
  structures?: readonly StructureItem[] | null; explode?: boolean; hideThirdParty?: boolean;
  /** 202610200240 Serviços "Imprimir pessoas de contato": the persons of the contact of the OS (null: not read). */
  contactPersons?: readonly { name: string; email: string | null; phone: string | null; mobile: string | null }[] | null;
  /** 202610200270 "Exibir tipo de cabeçalho: Personalizado": the header of the kind (null: the standard header). */
  customHeader?: RichText | null;
  /** 202610200288 "Imprimir campos customizados na ordem de serviço?" answered Sim: the definitions of the fields. */
  customFields?: readonly DocumentCustomField[] | null;
  /** 202610200294: the first image of each product (product id → data: URL) and the description at the supplier (item id → text). */
  images?: Readonly<Record<string, string>> | null; supplierDescriptions?: Readonly<Record<string, string>> | null }
export const PRINT_ORDER_LABELS: Record<PrintItemOrder, string> = { insertion: 'Inserção', alphabetical: 'Alfabética', location: 'Localização', code: 'Código' };
const snapshotText = (snapshot: Record<string, unknown> | null | undefined, key: string, max: number) => { const value = snapshot?.[key]; return typeof value === 'string' && value.trim() && Array.from(value).length <= max ? value : null; };
/** Exact sum of decimal strings (quantities have up to 6 decimals); never a float. */
function decimalSum(values: readonly string[]): string {
  let total = 0n; for (const value of values) { const [whole, fraction = ''] = value.split('.'); total += BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, '0').slice(0, 6)); }
  const fraction = String(total % 1_000_000n).padStart(6, '0').replace(/0+$/, ''); return `${total / 1_000_000n}${fraction ? `.${fraction}` : ''}`;
}
const collator = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });
/** Explicit projection: no internal notes, private provenance, attachments or mutable catalog data; declared commercial references are printable. */
export function documentPrintModel(record: DocumentRecord,companyRecord:CompanyRecord|null=null,options:PrintOptions={}) {
  const calculated = calculateDocument(record);
  for (const key of ['gross', 'line_discount', 'subtotal', 'discount', 'freight', 'other_expenses', 'total'] as const) {
    if (calculated[key] !== record.totals[key]) throw new Error('PRINT_TOTAL_MISMATCH');
  }
  if (!TITLES[record.kind] || !Object.hasOwn(STATES[record.kind], record.status)) throw new Error('PRINT_DOCUMENT_INVALID');
  const prefs = options.prefs ?? null, technician = options.technician === true && record.kind === 'service_orders', labels = record.kind === 'service_orders' ? options.labels ?? {} : {};
  const order = options.order ?? prefs?.order ?? 'insertion', hideValues = technician && Boolean(prefs?.hideValues);
  const commercial=normalizeCommercial(record.commercial??null);
  const publicText=(value:unknown,max:number):string|null=>{if(value===undefined||value===null)return null;if(typeof value!=='string'||Array.from(value).length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))throw new Error('PRINT_COMMERCIAL_INVALID');return value;};
  const contact = record.contact_snapshot;
  const rich = (value: unknown): RichText | null => { try { return normalizeRichText(value ?? null); } catch { throw new Error('PRINT_RICH_TEXT_INVALID'); } };
  const address = [text(contact.street), text(contact.number), text(contact.complement)].filter(Boolean).join(', ');
  const city = [text(contact.city), text(contact.state)].filter(Boolean).join(' / ');
  // 302 (mixed lane): a company of Pessoa Física keeps its CPF in the identity.
  const company=companyRecord?normalizeCompany(companyRecord.data,{document:'any'}):null;
  if(companyRecord&&(!Number.isInteger(companyRecord.version)||companyRecord.version<1))throw new Error('PRINT_COMPANY_INVALID');
  const delivery=record.delivery_address??null;
  // 202610200240 Vendas "Substituir endereço do contato com o alternativo": the delivery address takes the place of the contact address.
  const alternative=Boolean(record.kind==='sales_orders'&&prefs?.alternativeAddress&&delivery&&(text(delivery.street)||text(delivery.city)));
  const structureOf=new Map((options.structures??[]).map(row=>[row.item_id,row]));
  const thirdParty=(id:string|null|undefined)=>Boolean(id&&structureOf.get(id)?.production==='third_party');
  // 202610200102 fields printed by Origin (Data saída, Pedido de compra, garantia e endereço de entrega).
  const details=([['Data saída',record.kind==='sales_orders'?date(record.ship_date):null],['Pedido de compra',record.kind==='sales_orders'?text(record.customer_po_number):null],
    ['Garantia (meses)',record.kind==='sales_proposals'?text(record.warranty_months):null],['Data término',record.kind==='service_orders'?date(record.finish_date):null],
    ['Data de Saída',record.kind==='service_orders'?date(record.ship_date):null],['Garantia (dias)',record.kind==='service_orders'?text(record.warranty_days):null],
    // Preferências › Serviços "Data base da garantia": the end of the garantia (none with "Não utilizar garantia").
    ['Garantia até',record.kind==='service_orders'&&prefs?.warrantyBase?date(warrantyUntil(record,prefs.warrantyBase)):null],
    ['Ordem de compra',record.kind==='purchase_orders'?text(record.order_reference):null]] as const)
    .filter(([,value])=>value).map(([label,value])=>({label,value:value as string}));
  return {
    details,
    deliveryAddress:delivery&&!alternative?{name:text(delivery.name),address:[text(delivery.street),text(delivery.number),text(delivery.complement)].filter(Boolean).join(', '),
      district:text(delivery.district),city:[text(delivery.city),text(delivery.state)].filter(Boolean).join(' / '),postalCode:text(delivery.postal_code),country:text(delivery.country)}:null,
    warrantyInfo:record.kind==='service_orders'?text(record.warranty_info):null,receptionNotes:record.kind==='service_orders'?text(record.reception_notes):null,
    commercial:commercial?{introduction:commercial.introduction,attentionTo:commercial.attention_to,references:([['Vendedor',commercial.seller_reference],['Loja',commercial.store_reference],['Unidade de negócio',commercial.business_unit_reference]] as const).map(([label,value])=>({label,value:commercialReferenceText(value)})).filter(row=>row.value),transport:commercial.transport?{freightMode:commercial.transport.freight_mode===null?null:FREIGHT_MODES[commercial.transport.freight_mode],volumeCount:commercial.transport.volume_count===null?null:printDecimal(commercial.transport.volume_count),grossWeight:commercial.transport.gross_weight===null?null:printDecimal(commercial.transport.gross_weight),deliveryDays:commercial.transport.delivery_days,carrier:record.carrier_name??commercialReferenceText(commercial.transport.carrier_reference),service:commercialReferenceText(commercial.transport.service_reference),trackingCode:commercial.transport.tracking_code}:null}:null,
    company:company&&companyRecord?{version:companyRecord.version,legalName:company.legal_name,tradeName:company.trade_name,cnpj:company.cnpj,ie:company.ie,
      address:[company.street,company.number,company.complement].filter(Boolean).join(', '),district:company.district,city:`${company.city} / ${company.state}`,postalCode:company.postal_code,email:company.email,phone:company.phone}:null,
    // 202610200269: a version of a proposta prints its label (123-2).
    title: prefs?.title ?? (technician ? 'Ordem de serviço para técnico' : TITLES[record.kind]), number: record.proposal_version?.label ?? record.number,
    // Vendas "Título" with Número pedido (default) and "Seção auxiliar" with the Número da ordem de compra.
    titleNumber: prefs?.titleNumber !== false, titleBars: record.kind === 'sales_orders' && prefs?.titleBarcode ? code128(record.number) : null,
    approvalFields: record.kind === 'sales_proposals' && Boolean(prefs?.approvalFields),
    contactPersons: record.kind === 'service_orders' && prefs?.contactPersons ? (options.contactPersons ?? null) : null,
    hiddenThirdParty: options.hideThirdParty ? record.items.filter(item => thirdParty(item.id)).length : 0, auxiliary: record.kind === 'sales_orders' && prefs?.auxiliaryPo && text(record.customer_po_number) ? `Nº da ordem de compra: ${text(record.customer_po_number)}` : null, version: record.version, status: STATES[record.kind][record.status],
    date: date(record.date), expectedDate: date(record.expected_date), validUntil: record.kind === 'sales_proposals' ? date(record.valid_until) : null,
    template: record.template, cancelled: record.status === 'cancelled', contactLabel: record.kind === 'purchase_orders' ? 'Fornecedor' : 'Cliente',
    contact: { name: contact.name, tradeName: text(contact.trade_name), document: text(contact.document),
      address: alternative ? [text(delivery!.street), text(delivery!.number), text(delivery!.complement)].filter(Boolean).join(', ') : address,
      district: alternative ? text(delivery!.district) : text(contact.district), city: alternative ? [text(delivery!.city), text(delivery!.state)].filter(Boolean).join(' / ') : city,
      postalCode: alternative ? text(delivery!.postal_code) : text(contact.postal_code), email: text(contact.email),
      phones: [text(contact.phone), text(contact.mobile)].filter(Boolean).join(' · ') },
    detailed: options.detailed === true, order,
    // Preferências › Configuração de Impressão (absent: the Brufap layout, every column).
    columns: { position: prefs ? prefs.itemNumber : true, quantity: prefs ? prefs.quantities : true, values: !hideValues && (prefs ? prefs.values : true), listPrice: options.detailed === true || Boolean(prefs?.listDiscount && !hideValues), ncm: Boolean(prefs?.ncm), location: Boolean(prefs?.location), brand: Boolean(prefs?.brand) },
    showTotals: !hideValues && (prefs ? prefs.totals : true), showContact: !(technician && prefs?.hideContact), showDueDates: prefs ? prefs.dueDates : true,
    // Comprovante não fiscal (Preferências › Vendas): absent preferences keep the Brufap receipt (code shown, no limit).
    receipt: prefs ? prefs.receipt : { limitDescription: false, code: true, notes: false, comments: false, discount: false, footer: null, fontSize: 12 },
    dueLabel: prefs?.dueLabel ?? 'Vencimento', signature: prefs?.signature ? prefs.signatureLabel ?? 'Assinatura' : null, technician,
    userSignature: record.kind === 'sales_proposals' && options.userSignature && (options.userSignature.greeting || options.userSignature.department)
      ? { greeting: options.userSignature.greeting, name: options.userSignature.name, department: options.userSignature.department } : null,
    contactCode: prefs?.contactCode ? text(contact.code) : null,
    // 202610200294 Vendas "Imprimir rodapé pela impressão normal": the identification of the company at the end of the page.
    footer: prefs?.footer && company ? [company.trade_name || company.legal_name, company.cnpj ? `CNPJ ${company.cnpj}` : null, [company.street, company.number].filter(Boolean).join(', '),
      `${company.city} / ${company.state}`, company.phone, company.email].filter(Boolean).join(' · ') : null,
    // 202610200288 OS: the campos customizados with a value, when the print question was answered Sim.
    customFields: record.kind === 'service_orders' && options.customFields ? printableCustomFields(options.customFields, record.custom_fields) : [],
    ipiColumns: record.kind === 'purchase_orders' && Boolean(prefs?.ipi),
    warrantyColumn: record.kind === 'service_orders' && record.items.some(item => item.warranty_days !== undefined),
    quantitySum: prefs?.quantitySum ? decimalSum(record.items.map(item => item.quantity)) : null,
    serviceLabels: { equipment: labels.equipamento ?? 'Equipamento', serialNumber: labels.numero_serie ?? 'Número de série', defect: labels.problema ?? 'Problema', receptionNotes: labels.observacoes_recebimento ?? 'Observações do recebimento',
      // 202610200268: the column labels of the Peças and Serviços grids (Preferências › Serviços › Rótulos).
      partDescription: serviceItemLabel(labels, 'peca_descricao'), serviceDescription: serviceItemLabel(labels, 'servico_descricao'), serviceCode: serviceItemLabel(labels, 'servico_codigo'),
      serviceQuantity: serviceItemLabel(labels, 'servico_quantidade'), servicePrice: serviceItemLabel(labels, 'servico_valor'), serviceQuote: serviceItemLabel(labels, 'servico_orcar'),
      serviceNotes: serviceItemLabel(labels, 'servico_observacoes') },
    // 202610200268 OS: Peças and Serviços executados printed apart (every OS, also one saved before the groups).
    serviceGroups: record.kind === 'service_orders',
    items: record.items.map((item, index) => ({ item, index })).filter(({ item }) => !(options.hideThirdParty && thirdParty(item.id))).map(({ item, index }) => {
      const line = calculated.items[index];
      if (line.gross !== item.gross || line.discount !== item.discount || line.total !== item.total) throw new Error('PRINT_LINE_MISMATCH');
      // "Imprimir c/ detalhes": preço de lista = preço do cadastro guardado no item (snapshot), quando houver.
      // 202610200196: the Preço lista saved with the item (Lista de preço of the document), else the cadastro price of the snapshot.
      const savedList = typeof item.list_price === 'string' && /^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(item.list_price) ? item.list_price : null;
      const listPrice = savedList ? `R$ ${printDecimal(savedList, 2)}` : typeof item.product_snapshot?.price === 'string' && /^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(item.product_snapshot.price) ? `R$ ${printDecimal(item.product_snapshot.price, 2)}` : null;
      const detailedCode = prefs?.detailedCode === 'gtin' ? snapshotText(item.product_snapshot, 'gtin', 14) : prefs?.detailedCode === 'gtin_tributario' ? snapshotText(item.product_snapshot, 'gtin_tax', 14) : null;
      // 202610200196: "Código no fornecedor" is the code saved in the item of the pedido de compra; items saved before it
      // use the code of the product supplier tab for the supplier of the pedido (produtos lane, useSupplierCodes).
      const secondary = prefs?.secondaryCode === 'gtin' ? snapshotText(item.product_snapshot, 'gtin', 14) : prefs?.secondaryCode === 'gtin_tributario' ? snapshotText(item.product_snapshot, 'gtin_tax', 14)
        : prefs?.secondaryCode === 'codigo_fornecedor' ? (typeof item.supplier_code === 'string' && item.supplier_code ? item.supplier_code.slice(0, 100)
          : record.kind === 'purchase_orders' && item.product_id ? options.supplierCodes?.[item.product_id] ?? null : null) : null;
      const group = record.kind === 'service_orders' ? itemGroup(item, item.product_snapshot?.kind) : null;
      // 202610200287: IPI % and Valor IPI of the item (pedido de compra, "Exibir IPI"); Garantia of the item of the OS (and its end).
      const ipiRate = record.kind === 'purchase_orders' && prefs?.ipi && typeof item.ipi_rate === 'string' ? item.ipi_rate : null;
      const warrantyEnd = record.kind === 'service_orders' && item.warranty_days && prefs?.warrantyBase ? warrantyUntil({ ...record, warranty_days: item.warranty_days }, prefs.warrantyBase) : null;
      return { position: index + 1, description: item.description, group, quote: group === 'service' && item.quote === true, done: group === 'service' && item.done === true, detailedDescription:prefs&&!prefs.detailedDescription?null:publicText(item.detailed_description,4000), code: item.code, unit: item.unit,
        ncm: prefs?.ncm ? snapshotText(item.product_snapshot, 'ncm', 10) : null, brand: prefs?.brand ? snapshotText(item.product_snapshot, 'brand', 100) : null, detailedCode, location: snapshotText(item.product_snapshot, 'location', 100), secondaryCode: secondary,
        secondaryLabel: prefs?.secondaryCode === 'codigo_fornecedor' ? 'Código no fornecedor' : 'GTIN',
        quantity: printDecimal(item.quantity), price: `R$ ${printDecimal(item.unit_price, 2)}`, listPrice, quantityRaw: item.quantity,
        discount: `${printDecimal(item.discount_percent)}%`, total: printMoney(item.total),
        // 202610200240: Code 128 of the code (Vendas "Código de barras do código") and the components of its structure ("Desmembrar").
        bars: prefs?.codeBarcode && item.code ? code128(item.code) : null,
        components: (structureOf.get(item.id ?? '')?.components ?? []).map(c => ({ description: c.description, code: c.code, unit: c.unit, quantity: printDecimal(c.total), perUnit: printDecimal(c.quantity) })),
        explode: Boolean(options.explode),
        ipiRate: ipiRate === null ? null : `${printDecimal(ipiRate)}%`, ipiValue: ipiRate === null ? null : printMoney(itemIpi(item.total, ipiRate)),
        warranty: record.kind === 'service_orders' && item.warranty_days ? `${item.warranty_days} dias${warrantyEnd ? ` (até ${date(warrantyEnd)})` : ''}` : null,
        // Vendas "Exibir imagem do produto na venda detalhada" (detailed print) and Propostas "Exibir imagem de produtos".
        image: prefs?.images && item.product_id && (record.kind === 'sales_proposals' || options.detailed === true) ? options.images?.[item.product_id] ?? null : null,
        supplierDescription: prefs?.supplierDescription && item.id ? options.supplierDescriptions?.[item.id] ?? null : null };
    }).sort((a, b) => order === 'alphabetical' ? collator.compare(a.description, b.description) || a.position - b.position
      : order === 'code' ? collator.compare(a.code ?? '', b.code ?? '') || a.position - b.position
      : order === 'location' ? (a.location === null ? 1 : 0) - (b.location === null ? 1 : 0) || collator.compare(a.location ?? '', b.location ?? '') || a.position - b.position : a.position - b.position),
    totals: [
      // 202610200268: Total peças and Total serviços of the OS (Origin Detalhes da ordem de serviço).
      ...(record.kind === 'service_orders' ? (sums => sums ? [['Total peças', sums.part], ['Total serviços', sums.service]] : [])(groupTotals(record.items.map(item => ({ ...item, group: itemGroup(item, item.product_snapshot?.kind) })), calculated)) : []),
      ['Valor dos itens', calculated.gross], ['Desconto nos itens', calculated.line_discount], ['Subtotal', calculated.subtotal],
      ['Desconto geral', calculated.discount], ['Frete', calculated.freight], ['Outras despesas', calculated.other_expenses],
      // 202610200196: the Total do IPI and Total do ICMS ST added to the document are printed before the total they are part of.
      // 202610200287: the pedido de compra prints its Total do IPI (IPI % of the items) with "Exibir IPI". Leva H (EST-041): a value
      // that is part of the total is never hidden by a display preference, and the Total ICMS ST of the pedido de compra prints too.
      ...(calculated.ipi !== undefined && calculated.icms_st !== undefined ? record.kind === 'purchase_orders'
        ? [...(prefs?.ipi || calculated.ipi !== '0.00' ? [['Total do IPI', calculated.ipi]] : []), ...(calculated.icms_st !== '0.00' ? [['Total ICMS ST', calculated.icms_st]] : [])]
        : [['Total do IPI', calculated.ipi], [record.kind === 'sales_orders' ? 'Total ICMS ST' : 'Total do ICMS ST', calculated.icms_st]] : []),
      ...(calculated.other_items !== undefined ? [['Total outros itens', calculated.other_items]] : []),
      ['Total do documento', calculated.total],
    ].map(([label, value]) => ({ label, value: printMoney(value) })),
    installments: record.installments.map((item, index) => ({ position: index + 1, dueDate: date(item.due_date), amount: printMoney(item.amount), method: item.method,note:publicText(item.note,2000),paymentReference:commercialReferenceText(item.payment_reference) })),
    // 202610200270 proposta: Outros itens ou serviços, Condições comerciais Texto and the Cabeçalho personalizado (checked texto rico).
    otherItems: record.kind === 'sales_proposals' && record.other_items ? { content: rich(record.other_items.content), total: printMoney(record.other_items.total) } : null,
    conditionsText: record.kind === 'sales_proposals' && record.commercial_conditions?.mode === 'text' ? rich(record.commercial_conditions.text) : null,
    conditionsNone: record.kind === 'sales_proposals' && record.commercial_conditions?.mode === 'none',
    customHeader: prefs?.headerType === 'personalizado' && options.customHeader && !richTextEmpty(options.customHeader) ? rich(options.customHeader) : null,
    paymentTerms: record.kind === 'sales_proposals' && record.commercial_conditions && record.commercial_conditions.mode !== 'installments' ? null : record.payment_terms, deliveryTerms: record.delivery_terms, notes: record.notes,
    service: record.kind === 'service_orders' ? { equipment: record.equipment, serialNumber: record.serial_number, technician: record.technician, defect: record.defect, solution: record.solution } : null,
  };
}
export type DocumentPrintModel = ReturnType<typeof documentPrintModel>;
