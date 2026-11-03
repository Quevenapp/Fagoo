/**
 * Field contract of Brufap's own invoices (notas fiscais), operation natures and global tax settings.
 * The same descriptors are hard-coded in supabase/migrations/202610200111/112; a PGlite test compares both.
 * Descriptor syntax (every value may be null, which means "not informed"):
 *  e:a|b      one of the codes        d:S:I  decimal string, up to S decimals and I integer digits (stored with S decimals)
 *  t:N / m:N  single/multi-line text  x:RE   string matching the regular expression
 *  u          UUID (lower-case)       a      ISO date AAAA-MM-DD     b  boolean
 * Money, rates and quantities are strings; no binary floating point is used anywhere in this module.
 */
export const UFS = Object.freeze(['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO']);
const UF = `e:${UFS.join('|')}`, UF_EX = `e:${UFS.join('|')}|EX`;
const RATE = 'd:4:3', MONEY = 'd:2:13', QTY = 'd:4:11', PRICE = 'd:10:11', UNIT = 'd:4:11', WEIGHT = 'd:3:12';
const TAXATION = 'e:T|I|O';
const CODE = 'x:^[A-Z0-9]{8}([A-Z0-9]{2})?$';
const CNPJ = 'x:^[0-9]{14}$', CPF_CNPJ = 'x:^([0-9]{11}|[0-9]{14})$';
const INFO = 'm:2000';
export const CST_ICMS = Object.freeze(['00','02','10','15','20','30','40','41','50','51','53','60','61','70','90']);
export const CSOSN = Object.freeze(['101','102','103','201','202','203','300','400','500','900']);
export const MONOPHASE = Object.freeze(['02','15','53','61']);
export const CST_IPI = Object.freeze(['00','01','02','03','04','05','49','50','51','52','53','54','55','99']);
export const CST_PIS = Object.freeze(['01','02','03','04','05','06','07','08','09','49','50','51','52','53','54','55','56','60','61','62','63','64','65','66','67','70','71','72','73','74','75','98','99']);
export const PAYMENT_METHODS = Object.freeze(['01','02','03','04','05','10','11','12','13','15','16','17','18','19','20','90','99']);
export const DEFAULT_CODES = Object.freeze({ S: '1', E: '0', VF: '1', VJ: '1', CF: '0', CJ: '0', C: '1', DE: '0', DS: '1' });

const ST = { st_bc_mode: 'e:0|1|2|3|4|5|6', st_pauta_value: UNIT, st_rate: RATE, st_base_rate: RATE, st_mva: RATE };
const DIFAL = { difal_type: 'e:N|I', difal_base_rate: RATE, difal_internal_rate: RATE, difal_fcp_rate: RATE };
export const RULE_SPECS = Object.freeze({
  icms_sn: Object.freeze({ situation: `e:${[...CSOSN, ...MONOPHASE].join('|')}`, cfop: 'x:^[1-7][0-9]{3}$', bc_mode: 'e:0|1|2|3', rate: RATE, base_rate: RATE,
    deferral_rate: RATE, reduction_reason: 'e:1|9', taxation: TAXATION, credit_rate: RATE, fcp_rate: RATE, benefit_code: CODE, presumed_credit_code: CODE,
    rbc_benefit_code: CODE, pauta_value: UNIT, ...ST, retained_base_rate: RATE, retained_rate: RATE, ...DIFAL }),
  icms_normal: Object.freeze({ situation: `e:${CST_ICMS.join('|')}`, cfop: 'x:^[1-7][0-9]{3}$', rate: RATE, base_rate: RATE, deferral_rate: RATE, presumed_rate: RATE,
    taxation: TAXATION, fcp_rate: RATE, bc_mode: 'e:0|1|2|3', pauta_value: UNIT, benefit_code: CODE, presumed_credit_code: CODE, rbc_benefit_code: CODE,
    deson_reason: 'e:1|3|4|5|6|7|8|9|10|11|90', deson_deduct: 'b', ...ST, st_pis_rate: RATE, st_cofins_rate: RATE, retained_rate: RATE, ...DIFAL }),
  ipi: Object.freeze({ situation: `e:${CST_IPI.join('|')}`, rate: RATE, base_rate: RATE, framing_code: 'x:^[0-9]{3}$', taxation: TAXATION }),
  pis: Object.freeze({ situation: `e:${CST_PIS.join('|')}`, rate: RATE, base_rate: RATE, taxation: TAXATION }),
  cofins: Object.freeze({ situation: `e:${CST_PIS.join('|')}`, rate: RATE, base_rate: RATE, taxation: TAXATION }),
  ii: Object.freeze({ situation: 'e:T|N', rate: RATE, base_rate: RATE, taxation: TAXATION }),
});
export const NATURE_OTHERS = Object.freeze({ presumed_pis_cofins: 'b', add_icms: 'b', add_other_expenses: 'b', funrural_rate: RATE, rural_producer_purchase: 'b',
  deduct_funrural: 'b', approx_tax_type: 'e:table|fixed|product', approx_tax_rate: RATE, discount_type: 'e:C|I', simples_credit_rate: RATE });
export const NATURE_RETENTIONS = Object.freeze({ csrf: 'b', csrf_rate: RATE, ir: 'b', ir_rate: RATE });
export const DIFAL_MODES = Object.freeze(['inside', 'goods', 'none', 'validated']);
export const TAX_SETTINGS_SPEC = Object.freeze({ exclude_icms_pis_cofins: 'b', exclude_icms_st_pis_cofins: 'b', st_contributor_differentiated: 'b',
  st_retained_from_sale: 'b', difal_default: `e:${DIFAL_MODES.join('|')}`, ipi_in_icms_import: 'b' });
// Origin allows the two "exclusão do ICMS" bases only in these states.
export const DIFAL_STATE_MODES = Object.freeze({ default: UFS, inside: UFS, goods: UFS, none: UFS, validated: UFS, double_base: ['MT','PA','PB'], single_base: ['PB'] });

export const RECIPIENT_SPEC = Object.freeze({ contact_id: 'u', name: 't:60', person_type: 'e:J|F|E', document: CPF_CNPJ, foreign_id: 'x:^[A-Za-z0-9.:/-]{0,20}$',
  ie: 'x:^([0-9]{2,14}|ISENTO)$', ie_indicator: 'e:1|2|9', email: 't:60', phone: 'x:^[0-9]{6,14}$', postal_code: 'x:^[0-9]{8}$', street: 't:60', number: 't:60',
  complement: 't:60', district: 't:60', city: 't:60', municipality_code: 'x:^[0-9]{7}$', state: UF_EX, country: 't:60' });
export const EXPORT_SPEC = Object.freeze({ exit_state: UF, exit_place: 't:60', dispatch_place: 't:60' });
export const IMPORT_SPEC = Object.freeze({ number: 't:15', registration_date: 'a', exporter_code: 't:60', customs_expenses: MONEY, clearance_place: 't:60',
  clearance_state: UF, clearance_date: 'a', afrmm_value: MONEY, acquirer_cnpj: CNPJ, acquirer_state: UF, transport_route: 'e:1|2|3|4|5|6|7|8|9|10|11|12|13',
  intermediation: 'e:1|2|3', unit_value_with_ii: 'b' });
export const ADDITION_SPEC = Object.freeze({ number: 'x:^[0-9]{1,3}$', sequence: 'x:^[0-9]{1,5}$', manufacturer: 't:60', discount: MONEY, drawback: 'x:^[0-9]{1,20}$' });
export const REFERENCE_TYPES = Object.freeze(['nfe', 'ecf', 'nf01', 'nf02', 'nfp01', 'nfp04', 'cte']);
export const REFERENCE_SPEC = Object.freeze({ type: `e:${REFERENCE_TYPES.join('|')}`, key: 'x:^[0-9]{44}$', year_month: 'x:^[0-9]{2}(0[1-9]|1[0-2])$', number: 'x:^[0-9]{1,9}$', series: 'x:^[0-9]{1,3}$' });
export const TRANSPORT_SPEC = Object.freeze({ mode: 'e:none|manual', freight_by: 'e:0|1|2|3|4|9', tracking_code: 't:60' });
export const CARRIER_SPEC = Object.freeze({ contact_id: 'u', name: 't:60', document: CPF_CNPJ, ie: 'x:^([0-9]{2,14}|ISENTO)$', state: UF, city: 't:60', address: 't:60' });
export const VEHICLE_SPEC = Object.freeze({ plate: 'x:^[A-Z0-9]{7}$', state: UF, rntc: 't:20' });
export const SPECIES = Object.freeze(['outros', 'volumes', 'unidades', 'caixas', 'pacotes', 'envelopes', 'pallets', 'sacos']);
export const VOLUMES_SPEC = Object.freeze({ quantity: 'x:^[0-9]{1,15}$', gross_weight: WEIGHT, net_weight: WEIGHT, numbering: 't:60', brand: 't:60', species: `e:${SPECIES.join('|')}` });
export const DELIVERY_SPEC = Object.freeze({ name: 't:60', postal_code: 'x:^[0-9]{8}$', state: UF_EX, city: 't:60', street: 't:60', number: 't:60', district: 't:60', complement: 't:60', country: 't:60' });
// payment_method_id (202610200219): the forma de pagamento of the cadastro chosen in "Forma" (tPag in method).
export const INSTALLMENT_SPEC = Object.freeze({ days: 'x:^[0-9]{1,4}$', date: 'a', amount: MONEY, method: `e:${PAYMENT_METHODS.join('|')}`, note: 't:255', payment_method_id: 'u' });
export const CARD_SPEC = Object.freeze({ integration: 'e:1|2', cnpj: CNPJ, brand: 'x:^[0-9]{2}$', authorization: 't:128', received: MONEY, fee: MONEY, commission_fee: MONEY });
export const AUTHORIZED_SPEC = Object.freeze({ contact_id: 'u', name: 't:60', document: CPF_CNPJ });
export const INTERMEDIARY_SPEC = Object.freeze({ present: 'b', cnpj: CNPJ, identification: 't:60' });

// 202610200176: discount is the item's own vDesc ("Informar desconto individualmente nos itens").
export const ITEM_SPEC = Object.freeze({ product_id: 'u', description: 't:120', code: 't:60', kind: 'e:P|S', unit: 't:6', quantity: QTY, unit_price: PRICE, discount: MONEY,
  discount_type: 'e:C|I', nature_id: 'u', cfop: 'x:^[1-7][0-9]{3}$', ncm: 'x:^([0-9]{8}|00)$', cest: 'x:^[0-9]{7}$', gtin: 'x:^(SEM GTIN|[0-9]{8}|[0-9]{12,14})$',
  gtin_tax: 'x:^(SEM GTIN|[0-9]{8}|[0-9]{12,14})$', barcode: 't:30', barcode_tax: 't:30', gross_weight: WEIGHT, net_weight: WEIGHT, volumes: 'x:^[0-9]{1,6}$',
  invoiced: 'b', info: 'm:500', complementary_info: INFO, fiscal_info: INFO });
export const ITEM_GROUPS = Object.freeze({
  icms: Object.freeze({ origin: 'e:0|1|2|3|4|5|6|7|8', situation: `e:${[...CST_ICMS, ...CSOSN].join('|')}`, taxation: TAXATION, bc_mode: 'e:0|1|2|3', pauta_value: UNIT,
    base_rate: RATE, base: MONEY, deferral_rate: RATE, presumed_rate: RATE, presumed_value: MONEY, rate: RATE, value: MONEY, fcp_rate: RATE, fcp_value: MONEY,
    fcp_deferral_rate: RATE, fcp_deferral_value: MONEY, fcp_effective_value: MONEY, credit_rate: RATE, credit_value: MONEY, deson_value: MONEY,
    deson_reason: 'e:1|3|4|5|6|7|8|9|10|11|90', deson_deduct: 'b', reduction_reason: 'e:1|9', benefit_code: CODE, presumed_credit_code: CODE, rbc_benefit_code: CODE,
    mono_qty: QTY, mono_rate: RATE, mono_value: MONEY, mono_deferred_value: MONEY, mono_icms_value: MONEY,
    st_bc_mode: 'e:0|1|2|3|4|5|6', st_pauta_value: UNIT, st_mva: RATE, st_base_rate: RATE, st_base: MONEY, st_rate: RATE, st_value: MONEY, st_fcp_value: MONEY,
    st_deson_value: MONEY, st_deson_reason: 'e:3|9|90', pis_st_base: MONEY, pis_st_rate: RATE, pis_st_value: MONEY, cofins_st_base: MONEY, cofins_st_rate: RATE, cofins_st_value: MONEY,
    ret_unit_base: UNIT, ret_unit_icms: UNIT, ret_unit_substitute: UNIT, ret_substitute_value: MONEY, ret_base_rate: RATE, ret_base: MONEY, ret_rate: RATE, ret_value: MONEY,
    difal_type: 'e:N|I', difal_base_rate: RATE, difal_base: MONEY, difal_fcp_rate: RATE, difal_fcp_value: MONEY, difal_internal_rate: RATE,
    difal_interstate_rate: 'e:4.0000|7.0000|12.0000', difal_share_rate: RATE, difal_dest_value: MONEY, difal_origin_value: MONEY, complementary_info: INFO, fiscal_info: INFO }),
  ipi: Object.freeze({ taxation: TAXATION, situation: `e:${CST_IPI.join('|')}`, base_rate: RATE, base: MONEY, rate: RATE, value: MONEY, unit_value: UNIT, class_code: 't:5',
    seal_code: 't:60', framing_code: 'x:^[0-9]{3}$', tipi_exception: 'x:^[0-9]{1,3}$', final_consumer: 'b', devol_rate: RATE, devol_value: MONEY, complementary_info: INFO, fiscal_info: INFO }),
  pis: Object.freeze({ situation: `e:${CST_PIS.join('|')}`, taxation: TAXATION, base_rate: RATE, base: MONEY, rate: RATE, value: MONEY, unit_value: UNIT, complementary_info: INFO, fiscal_info: INFO }),
  cofins: Object.freeze({ situation: `e:${CST_PIS.join('|')}`, taxation: TAXATION, base_rate: RATE, base: MONEY, rate: RATE, value: MONEY, unit_value: UNIT, complementary_info: INFO, fiscal_info: INFO }),
  ii: Object.freeze({ situation: 'e:T|N', base: MONEY, rate: RATE, value: MONEY, taxation: TAXATION, customs_expense: MONEY, add_icms: 'b', add_other: 'b', addition: 'x:^[0-9]{1,3}$' }),
  export: Object.freeze({ drawback: 'x:^[0-9]{1,20}$', registry: 'x:^[0-9]{1,12}$', key: 'x:^[0-9]{44}$' }),
  fuel: Object.freeze({ anp_code: 'x:^[0-9]{9}$', anp_description: 't:95', codif: 'x:^[0-9]{1,21}$', consumption_state: UF, ambient_qty: QTY, glp_rate: RATE, glgnn_rate: RATE,
    glgni_rate: RATE, start_value: MONEY, cide_base: QTY, cide_rate: UNIT, cide_value: MONEY, biodiesel_rate: RATE }),
  medicine: Object.freeze({ anvisa_code: 'x:^([0-9A-Za-z]{13}|ISENTO)$', max_price: MONEY, exemption_reason: 't:255' }),
  others: Object.freeze({ presumed_pis_cofins: 'b', funrural_rate: RATE, sped_type: 'e:00|01|02|03|04|05|06|07|08|09|10|99', commission_base: MONEY, commission_rate: RATE,
    commission_value: MONEY, fci: 'x:^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$', purchase_order: 't:15', purchase_order_item: 'x:^[0-9]{1,6}$',
    ibpt_rate: RATE, approx_taxes: MONEY, tax_unit: 't:6', tax_quantity: QTY }),
  stock: Object.freeze({ supplier_code: 't:60', scale: 'e:S|N', manufacturer_cnpj: CNPJ }),
  retentions: Object.freeze({ csrf: 'b', pis_value: MONEY, cofins_value: MONEY, csll_rate: RATE, csll_value: MONEY, ir: 'b', ir_csll_base: MONEY, ir_rate: RATE, ir_value: MONEY }),
  // Armamento (grupo arma, one weapon per item) and Veículo (grupo veicProd), shown when Preferências › Configurações de NF-e enable them (migration 202610200141).
  weapon: Object.freeze({ type: 'e:0|1', description: 't:256', serial: 't:15', barrel: 't:15' }),
  vehicle: Object.freeze({ operation: 'e:0|1|2|3', chassis: 'x:^[A-Z0-9]{17}$', color_code: 't:4', color: 't:40', power: 't:4', displacement: 't:4', net_weight: 't:9', gross_weight: 't:9',
    serial: 't:9', fuel_type: 'x:^[0-9]{2}$', engine_number: 't:21', cmt: 't:9', wheelbase: 't:4', model_year: 'x:^[0-9]{4}$', manufacture_year: 'x:^[0-9]{4}$', paint_type: 't:1',
    vehicle_type: 'x:^[0-9]{1,2}$', species: 'e:1|2|3|4|5|6', vin_condition: 'e:R|N', vehicle_condition: 'e:1|2|3', brand_model_code: 'x:^[0-9]{1,6}$', denatran_color: 'x:^[0-9]{2}$',
    capacity: 'x:^[0-9]{1,3}$', restriction: 'e:0|1|2|3|4|9' }),
});

// Origin web codes (capture of 19/10/2026). 2 = Em contingência is Brufap's choice: the capture lists the badge but omits its code.
export const INVOICE_STATUS = Object.freeze({ 1: 'Pendente', 2: 'Em contingência', 3: 'Cancelada', 4: 'Aguardando recibo', 5: 'Rejeitada', 6: 'Autorizada',
  7: 'Emitida DANFE', 8: 'Registrada', 9: 'Aguardando protocolo', 10: 'Denegada', 11: 'Consulta situação', 12: 'Bloqueada',
  14: 'Enviando Carta de correção', 15: 'Enviando Cancelamento', 16: 'Enviando Autorização' });
export const EDITABLE_STATUS = Object.freeze([1, 5, 8, 12]);
export const ISSUE_TYPES = Object.freeze({ '1': { N: 'Emissão Própria', D: 'NF-e com DANFE Simplificado Tipo 2', E: 'Exportação', T: 'Emitida por Terceiros', S: 'Importação de XML de saída', C: 'NFCe' },
  '0': { N: 'Emissão Própria', I: 'Importação', T: 'Emitida por Terceiros', X: 'Importação de XML de entrada' } });
// Notes Brufap transmits itself are always homologation (environment 2); registered third-party notes have no environment.
export const REGISTERED_TYPES = Object.freeze(['T', 'S', 'X']);
export const XML_IMPORT_TYPES = Object.freeze(['S', 'X']);

export class FiscalSpecError extends Error { constructor(code = 'FISCAL_VALUE_INVALID', field = null) { super(code); this.code = code; this.field = field; } }
const fail = (code, field) => { throw new FiscalSpecError(code, field); };
const CONTROL = /[\u0000-\u001f\u007f]/;
/** Mirrors erp_fiscal_invoices.check_value: returns the canonical value or null; throws FiscalSpecError. */
export function checkValue(value, descriptor, field = null) {
  if (value === null || value === undefined) return null;
  const kind = descriptor.split(':', 1)[0], arg = descriptor.slice(kind.length + 1);
  if (kind === 'b') { if (typeof value !== 'boolean') fail('FISCAL_VALUE_INVALID', field); return value; }
  if (typeof value !== 'string') fail('FISCAL_VALUE_INVALID', field);
  if (kind === 't' || kind === 'm') {
    const text = value.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, ''); if (!text) return null;
    if ([...text].length > Number(arg) || CONTROL.test(kind === 'm' ? text.replace(/[\n\r\t]/g, '') : text)) fail('FISCAL_VALUE_INVALID', field);
    return text;
  }
  if (kind === 'e') { if (!arg.split('|').includes(value)) fail('FISCAL_VALUE_INVALID', field); return value; }
  if (kind === 'x') { if (!new RegExp(arg).test(value)) fail('FISCAL_VALUE_INVALID', field); return value; }
  if (kind === 'u') { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) fail('FISCAL_VALUE_INVALID', field); return value.toLowerCase(); }
  if (kind === 'a') {
    if (!/^(19|20)\d{2}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) fail('FISCAL_VALUE_INVALID', field);
    return value;
  }
  if (kind === 'd') {
    const [scale, digits] = arg.split(':').map(Number);
    if (!new RegExp(`^(0|[1-9][0-9]{0,${digits - 1}})(\\.[0-9]{1,${scale}})?$`).test(value)) fail('FISCAL_VALUE_INVALID', field);
    const [whole, fraction = ''] = value.split('.');
    return `${whole}.${fraction.padEnd(scale, '0')}`;
  }
  return fail('FISCAL_SPEC_INVALID', field);
}
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Mirrors erp_fiscal_invoices.spec_object: unknown keys are refused, nulls/empty texts are dropped. */
export function specObject(value, spec, field = null) {
  if (value === null || value === undefined) return {};
  if (!plain(value)) fail('FISCAL_VALUE_INVALID', field);
  const result = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!Object.hasOwn(spec, key)) fail('FISCAL_UNKNOWN_FIELD', field ? `${field}.${key}` : key);
    const normalized = checkValue(raw, spec[key], field ? `${field}.${key}` : key);
    if (normalized !== null) result[key] = normalized;
  }
  return result;
}
export const ruleSpecFor = (tax, crt) => tax === 'icms' ? RULE_SPECS[crt === '3' ? 'icms_normal' : 'icms_sn'] : RULE_SPECS[tax];
/** Exact cents from a canonical 2-decimal string. */
export const centsOf = value => { const [whole, fraction = ''] = String(value).split('.'); return BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2)); };
export const moneyOf = cents => { const negative = cents < 0n, absolute = negative ? -cents : cents; return `${negative ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`; };
