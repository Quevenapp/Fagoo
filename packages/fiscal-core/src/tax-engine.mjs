/**
 * "Cálculo automático" of the External invoice form: picks the operation-nature rule for each tax and computes the
 * item tax groups with exact decimal arithmetic (BigInt, half-up rounding to cents). Covered:
 * - ICMS própria (CST and CSOSN) with base reduction, deferral, Simples credit and FCP; base by Modalidade BC
 *   (valor da operação, pauta and preço tabelado use quantity × the pauta value); ICMS desonerado (valor da operação
 *   × alíquota menos o ICMS destacado) for the CSTs that carry it;
 * - ICMS ST by MVA, by pauta/lista/preço tabelado (quantity × pauta) or by the operation value, PIS ST and COFINS ST,
 *   and the retained ST base "de acordo com os dados da venda" when that global setting is on;
 * - DIFAL partilha for non-contributor final consumers in another state: "Somente valor da mercadoria" (base única),
 *   "Com ICMS por dentro" (base dupla: (valor − ICMS de origem) ÷ (1 − alíquota interna)), "Calcular apenas campos
 *   validados" and "Não calcular"; the two state-specific bases (MT, PA, PB) stay as typed;
 * - IPI by rate or by fixed value per unit, PIS/COFINS by rate (with "excluir ICMS/ICMS ST da base") or per quantity
 *   (CST 03), II by rate, monophase ICMS ad rem from the typed quantity and rate, the unconditional discount reducing
 *   the IPI and ST bases, the import ICMS base (II, customs expenses, IPI when "Somar IPI…" is on, optional gross-up);
 * - informações complementares: nature and rule texts, per-tax item texts, Simples credit message, tracking code and
 *   customer purchase order, each one only when its preference asks for it.
 * Not calculated (values stay as typed): ISSQN, IBS/CBS/IS, Funrural, the IBPT table and the differentiated ST for
 * contributor consumers. It never validates a rule against the legislation; the result is a proposal the user reviews.
 */
import { lineTotalCents, allocateCents, discountShares } from '../../erp-domain/src/fiscal-invoice-contract.mjs';

const scaled = (value, scale) => { if (value === null || value === undefined || value === '') return 0n; const [whole, fraction = ''] = String(value).split('.'); return BigInt(whole) * 10n ** BigInt(scale) + BigInt((fraction + '0'.repeat(scale)).slice(0, scale)); };
const centsOf = value => scaled(value, 2);
const money = cents => `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
const rateOf = value => scaled(value, 4); // 4 decimals, percent
const rateText = value => { const v = rateOf(value); return `${v / 10000n}.${String(v % 10000n).padStart(4, '0')}`; };
/** cents × percent (4 decimals) / 100, rounded half up. */
const applyRate = (cents, rate) => (cents * rateOf(rate) + 500000n) / 1000000n;
/** round(quantity (4 decimals) × unit value (4 decimals), 2) half up. */
const perUnit = (quantity, unit) => (scaled(quantity, 4) * scaled(unit, 4) + 500000n) / 1000000n;
const positive = value => value > 0n ? value : 0n;
const has = value => value !== null && value !== undefined && value !== '';
const OWN_ICMS = { '00': true, '10': true, '20': true, '51': true, '70': true, '90': true, '900': true };
const ST_SITUATIONS = ['10', '30', '70', '90', '201', '202', '203', '900'];
const REDUCED = ['20', '70'];
const CREDIT = ['101', '201', '900'];
const DESONERATED = ['20', '30', '40', '41', '50', '70', '90'];
const RETAINED = ['60', '500'];
const MONOPHASE = ['02', '15', '53', '61'];
const PIS_RATED = ['01', '02', '49', '98', '99'];
const IPI_TAXED = ['00', '49', '50', '99'];
const INTERSTATE = { '4.0000': true, '7.0000': true, '12.0000': true };

/**
 * Rule with the highest specificity: listed product, product group (202610200216, a proposal for the accountant to review), longest
 * NCM prefix, any product; a listed destination beats "Qualquer estado".
 */
export function matchRule(rules, tax, { state, productId, ncm, groupId = null }) {
  let best = null, bestScore = -1;
  for (const rule of rules ?? []) {
    if (rule.tax !== tax) continue;
    if (rule.destinations.length && !rule.destinations.includes(state)) continue;
    let score;
    if (rule.product_scope === 'products') { if (!productId || !rule.product_ids.includes(productId)) continue; score = 300; }
    else if (rule.product_scope === 'groups') { if (!groupId || !(rule.group_ids ?? []).includes(groupId)) continue; score = 250; }
    else if (rule.product_scope === 'ncm') { const prefix = rule.ncms.filter(n => ncm && ncm.startsWith(n)).sort((a, b) => b.length - a.length)[0]; if (!prefix) continue; score = 200 + prefix.length; }
    else score = 100;
    if (rule.destinations.length) score += 50;
    if (score > bestScore || (score === bestScore && rule.position < best.position)) { best = rule; bestScore = score; }
  }
  return best;
}
const destinationOf = recipient => !recipient || recipient.person_type === 'E' || recipient.state === 'EX' ? 'EX' : recipient.state ?? null;
const clean = group => Object.fromEntries(Object.entries(group).filter(([, v]) => v !== null && v !== undefined && v !== ''));
/** Operation value of the base by Modalidade BC: pauta (1) and preço tabelado (2) use quantity × pauta; 0 and 3 use the operation value. */
const ownBase = (mode, gross, quantity, pauta) => (mode === '1' || mode === '2') && has(pauta) ? perUnit(quantity, pauta) : gross;
/** ST base before the base rate: pauta (5) and the price lists (0-3) use quantity × pauta, 6 the operation value, otherwise MVA (4). */
function stBaseOf(mode, stGross, quantity, rule, item) {
  const pauta = has(rule.st_pauta_value) ? rule.st_pauta_value : item.icms?.st_pauta_value;
  if (['0', '1', '2', '3', '5'].includes(mode) && has(pauta)) return { base: perUnit(quantity, pauta), mva: null };
  if (mode === '6') return { base: stGross, mva: null };
  return { base: has(rule.st_mva) ? stGross + applyRate(stGross, rule.st_mva) : stGross, mva: has(rule.st_mva) ? rule.st_mva : null };
}
/** Gross-up "por dentro": cents ÷ (1 − rate%), half up. */
const inside = (cents, rate) => { const r = rateOf(rate); return r >= 1000000n ? null : (cents * 1000000n + (1000000n - r) / 2n) / (1000000n - r); };

/**
 * @param invoice normalized invoice input (fiscal-invoice-contract normalizeInvoiceInput shape)
 * @param context { natures: Record<id, nature record>, settings: tax settings, difalByState: Configurações globais DIFAL por UF,
 *   orders: origin orders for NUMERO_PEDIDO, options: { companyState, simplesCreditMessage, trackingInInfo, purchaseOrderInInfo, sellerName },
 *   productGroups: Record<product id, group id> for the "Grupo de Produtos" rules }
 */
export function calculateInvoiceTaxes(invoice, { natures = {}, settings = {}, difalByState = {}, orders = [], options = {}, productGroups = {} } = {}) {
  const header = natures[invoice.nature_id] ?? null;
  const state = destinationOf(invoice.recipient);
  const lines = invoice.items.map(item => lineTotalCents(item.quantity, item.unit_price));
  const weights = invoice.items.map((item, i) => item.invoiced === false ? 0n : lines[i]);
  // The item's own discount ("Informar desconto individualmente nos itens") or the note discount spread like the database does.
  const allocation = { ...Object.fromEntries(['freight', 'insurance', 'other_expenses'].map(k => [k, allocateCents(centsOf(invoice[k]), weights)])), discount: discountShares(invoice, weights) };
  const importNote = invoice.issue_type === 'I';
  // DIFAL partilha applies to a non-contributor final consumer in another state (EC 87/2015). "Destino da Operação" typed as
  // 1 - Operação interna (202610200215, for example a presencial sale to a consumer of another state) has no partilha.
  const difalTarget = invoice.direction === '1' && invoice.final_consumer && invoice.recipient?.ie_indicator === '9' && state && state !== 'EX' && options.companyState && state !== options.companyState
    && invoice.operation_destination !== '1';
  const difalMode = difalTarget ? (difalByState[state] ?? settings.difal_default ?? 'inside') : 'none';
  const applied = [];
  const items = invoice.items.map((item, index) => {
    const nature = (item.nature_id && natures[item.nature_id]) || header;
    const rules = nature?.rules ?? [];
    const find = tax => matchRule(rules, tax, { state, productId: item.product_id ?? null, ncm: item.ncm ?? null, groupId: item.product_id ? productGroups[item.product_id] ?? null : null });
    const icmsRule = find('icms'), ipiRule = find('ipi'), pisRule = find('pis'), cofinsRule = find('cofins'), iiRule = find('ii');
    for (const rule of [icmsRule, ipiRule, pisRule, cofinsRule, iiRule]) if (rule) applied.push(rule);
    const total = lines[index], freight = allocation.freight[index], insurance = allocation.insurance[index], other = allocation.other_expenses[index], discount = allocation.discount[index];
    const gross = positive(total + freight + insurance + other - discount);
    // "Tipo desconto": unset keeps the ST base net of discount and the IPI base gross; Incondicional reduces both; Condicional neither.
    const discountType = item.discount_type ?? nature?.others?.discount_type ?? null;
    const ipiDiscount = discountType === 'I' ? discount : 0n, stDiscount = discountType === 'C' ? 0n : discount;
    const next = { ...item };
    let ownIcms = 0n, stValue = 0n, ipiValue = 0n, iiValue = centsOf(item.ii?.value ?? '0');
    if (iiRule) {
      const r = iiRule.data, ii = { ...(item.ii ?? {}), situation: r.situation, ...(r.taxation ? { taxation: r.taxation } : {}) };
      for (const k of ['base', 'rate', 'value']) delete ii[k];
      iiValue = 0n;
      if (r.situation === 'T' && r.rate) { const base = applyRate(total, r.base_rate ?? '100'); iiValue = applyRate(base, r.rate); Object.assign(ii, { base: money(base), rate: rateText(r.rate), value: money(iiValue) }); }
      next.ii = clean(ii);
    }
    if (ipiRule) {
      const r = ipiRule.data, ipi = { ...(item.ipi ?? {}), situation: r.situation, ...(r.framing_code ? { framing_code: r.framing_code } : {}), ...(r.taxation ? { taxation: r.taxation } : {}) };
      for (const key of ['base', 'base_rate', 'rate', 'value']) delete ipi[key];
      if (IPI_TAXED.includes(r.situation) && r.rate) {
        // Import IPI is levied on the customs value plus the import duty.
        const base = applyRate(positive(total + (nature?.include_freight_ipi_base ? freight : 0n) + (importNote ? iiValue : 0n) - ipiDiscount), r.base_rate ?? '100');
        ipiValue = applyRate(base, r.rate);
        Object.assign(ipi, { base_rate: rateText(r.base_rate ?? '100'), base: money(base), rate: rateText(r.rate), value: money(ipiValue) });
      } else if (IPI_TAXED.includes(r.situation) && has(item.ipi?.unit_value)) {
        // "Valor IPI Fixo Unit.": quantity × fixed value per unit.
        ipiValue = perUnit(item.quantity, item.ipi.unit_value);
        ipi.value = money(ipiValue);
      }
      next.ipi = clean(ipi);
    }
    if (icmsRule) {
      const r = icmsRule.data, situation = r.situation;
      const icms = { ...(item.icms ?? {}), situation, ...(r.taxation ? { taxation: r.taxation } : {}) };
      for (const key of ['benefit_code', 'presumed_credit_code', 'rbc_benefit_code', 'deson_reason', 'deson_deduct', 'reduction_reason', 'bc_mode', 'st_bc_mode', 'difal_type']) if (r[key] !== undefined) icms[key] = r[key];
      for (const key of ['base', 'value', 'base_rate', 'rate', 'credit_rate', 'credit_value', 'fcp_rate', 'fcp_value', 'deferral_rate', 'st_base', 'st_value', 'st_rate', 'st_mva', 'st_base_rate']) delete icms[key];
      const baseRate = r.base_rate ?? '100', mode = r.bc_mode ?? item.icms?.bc_mode ?? '3';
      let operation = ownBase(mode, gross, item.quantity, has(r.pauta_value) ? r.pauta_value : item.icms?.pauta_value);
      if (importNote) {
        // Import ICMS base: customs value, duty, customs expenses when "Somar outras despesas", IPI when the global setting asks; "Somar ICMS" grosses it up.
        const addOther = item.ii?.add_other ?? nature?.others?.add_other_expenses ?? false, addIcms = item.ii?.add_icms ?? nature?.others?.add_icms ?? false;
        operation = gross + iiValue + (addOther ? centsOf(item.ii?.customs_expense ?? '0') : 0n) + (settings.ipi_in_icms_import ? ipiValue : 0n);
        if (addIcms && r.rate) operation = inside(operation, r.rate) ?? operation;
      }
      const base = applyRate(operation, REDUCED.includes(situation) || r.base_rate ? baseRate : '100');
      if (OWN_ICMS[situation] && r.rate) {
        ownIcms = applyRate(base, r.rate);
        let value = ownIcms;
        if (situation === '51' && r.deferral_rate) { const deferred = applyRate(ownIcms, r.deferral_rate); value = ownIcms - deferred; icms.deferral_rate = rateText(r.deferral_rate); }
        Object.assign(icms, { base_rate: rateText(baseRate), base: money(base), rate: rateText(r.rate), value: money(value) });
      } else if (['201', '202', '203'].includes(situation) && r.rate) ownIcms = applyRate(base, r.rate);
      if (CREDIT.includes(situation)) {
        const creditRate = r.credit_rate ?? nature?.others?.simples_credit_rate;
        if (creditRate) Object.assign(icms, { credit_rate: rateText(creditRate), credit_value: money(applyRate(gross, creditRate)) });
      }
      if (r.fcp_rate && OWN_ICMS[situation]) Object.assign(icms, { fcp_rate: rateText(r.fcp_rate), fcp_value: money(applyRate(base, r.fcp_rate)) });
      // ICMS desonerado: the ICMS the full operation would carry minus the ICMS shown, only when the rule names the reason.
      if (DESONERATED.includes(situation) && r.deson_reason && r.rate) {
        const full = applyRate(operation, r.rate), shown = OWN_ICMS[situation] ? ownIcms : 0n;
        if (full > shown) icms.deson_value = money(full - shown);
      }
      // Retained ST (CST 60 / CSOSN 500) from the sale data, when "Calcular a base de cálculo do ICMS ST retido de acordo com os dados da venda" is on.
      if (RETAINED.includes(situation) && settings.st_retained_from_sale && r.retained_rate) {
        const retBase = applyRate(gross, r.retained_base_rate ?? '100');
        Object.assign(icms, { ret_base_rate: rateText(r.retained_base_rate ?? '100'), ret_base: money(retBase), ret_rate: rateText(r.retained_rate), ret_value: money(applyRate(retBase, r.retained_rate)) });
      }
      // Monophase ad rem: typed quantity × typed rate per unit.
      if (MONOPHASE.includes(situation) && has(item.icms?.mono_qty) && has(item.icms?.mono_rate)) icms.mono_value = money(perUnit(item.icms.mono_qty, item.icms.mono_rate));
      next.icms = clean(icms);
      if (r.cfop) next.cfop = r.cfop;
    }
    const stGross = positive(total + ipiValue + freight + insurance + other - stDiscount);
    if (icmsRule && ST_SITUATIONS.includes(icmsRule.data.situation) && icmsRule.data.st_rate) {
      const r = icmsRule.data, mode = r.st_bc_mode ?? item.icms?.st_bc_mode ?? '4';
      const { base: beforeRate, mva } = stBaseOf(mode, stGross, item.quantity, r, item);
      const stBase = applyRate(beforeRate, r.st_base_rate ?? '100');
      stValue = positive(applyRate(stBase, r.st_rate) - ownIcms);
      next.icms = clean({ ...next.icms, st_mva: mva ? rateText(mva) : null, st_base_rate: rateText(r.st_base_rate ?? '100'), st_base: money(stBase), st_rate: rateText(r.st_rate), st_value: money(stValue) });
    }
    const pisBase = positive(gross - (settings.exclude_icms_pis_cofins ? ownIcms : 0n) - (settings.exclude_icms_st_pis_cofins ? stValue : 0n));
    if (icmsRule) {
      // PIS ST and COFINS ST of the regime normal rule, on the same base as PIS/COFINS.
      const r = icmsRule.data, extra = {};
      if (r.st_pis_rate) Object.assign(extra, { pis_st_base: money(pisBase), pis_st_rate: rateText(r.st_pis_rate), pis_st_value: money(applyRate(pisBase, r.st_pis_rate)) });
      if (r.st_cofins_rate) Object.assign(extra, { cofins_st_base: money(pisBase), cofins_st_rate: rateText(r.st_cofins_rate), cofins_st_value: money(applyRate(pisBase, r.st_cofins_rate)) });
      if (Object.keys(extra).length) next.icms = clean({ ...next.icms, ...extra });
    }
    for (const [key, rule] of [['pis', pisRule], ['cofins', cofinsRule]]) {
      if (!rule) continue;
      const r = rule.data, group = { ...(item[key] ?? {}), situation: r.situation, ...(r.taxation ? { taxation: r.taxation } : {}) };
      for (const k of ['base', 'base_rate', 'rate', 'value']) delete group[k];
      if (PIS_RATED.includes(r.situation) && r.rate) {
        const base = applyRate(importNote ? total : pisBase, r.base_rate ?? '100');
        Object.assign(group, { base_rate: rateText(r.base_rate ?? '100'), base: money(base), rate: rateText(r.rate), value: money(applyRate(base, r.rate)) });
      } else if (r.situation === '03' && has(item[key]?.unit_value)) group.value = money(perUnit(item.quantity, item[key].unit_value));
      next[key] = clean(group);
    }
    if (icmsRule && difalMode !== 'none' && icmsRule.data.difal_type !== 'I' && icmsRule.data.difal_internal_rate) {
      const r = icmsRule.data, inter = r.rate ? rateText(r.rate) : null;
      if (inter && INTERSTATE[inter]) {
        const difal = { ...next.icms, difal_interstate_rate: inter, difal_share_rate: '100.0000', difal_internal_rate: rateText(r.difal_internal_rate) };
        if (difalMode === 'goods' || difalMode === 'inside') {
          const origin = applyRate(gross, inter);
          const operation = difalMode === 'goods' ? gross : inside(gross - origin, r.difal_internal_rate);
          if (operation !== null) {
            const base = applyRate(operation, r.difal_base_rate ?? '100');
            const dest = positive(applyRate(base, r.difal_internal_rate) - (difalMode === 'goods' ? applyRate(base, inter) : origin));
            Object.assign(difal, { difal_base_rate: rateText(r.difal_base_rate ?? '100'), difal_base: money(base), difal_dest_value: money(dest), difal_origin_value: '0.00',
              ...(r.difal_fcp_rate ? { difal_fcp_rate: rateText(r.difal_fcp_rate), difal_fcp_value: money(applyRate(base, r.difal_fcp_rate)) } : {}) });
          }
        }
        next.icms = clean(difal);
      }
    }
    if (nature?.others?.approx_tax_type === 'fixed' && nature.others.approx_tax_rate) next.others = clean({ ...(item.others ?? {}), ibpt_rate: rateText(nature.others.approx_tax_rate), approx_taxes: money(applyRate(total, nature.others.approx_tax_rate)) });
    return next;
  });
  const result = { ...invoice, items, cfop: items.find(i => i.cfop)?.cfop ?? invoice.cfop ?? null };
  const texts = natureTexts(result, header, applied, orders, options);
  return { invoice: { ...result, nature_additional_info: texts.additional, nature_fiscal_info: texts.fiscal }, rules_applied: applied.length };
}

const brMoney = cents => { const text = money(cents), [whole, fraction] = text.split('.'); return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${fraction}`; };
const brRate = value => { const v = rateOf(value); const whole = v / 10000n, fraction = String(v % 10000n).padStart(4, '0').replace(/0+$/, ''); return fraction ? `${whole},${fraction}` : String(whole); };
const brDate = value => value ? value.split('-').reverse().join('/') : '';
const sum = (items, group, field) => items.reduce((total, item) => total + (item[group]?.[field] ? centsOf(item[group][field]) : 0n), 0n);
/** Values of the External information variables Fagoo can compute; the rest are empty, like External without that data. */
export function infoVariables(invoice, orders = [], extra = {}) {
  const items = invoice.items, credit = sum(items, 'icms', 'credit_value'), creditRate = items.find(i => i.icms?.credit_rate)?.icms.credit_rate;
  const ref = invoice.references?.[0], di = invoice.import_declaration;
  const deferral = items.reduce((t, i) => t + (i.icms?.deferral_rate && i.icms?.base && i.icms?.rate ? applyRate(applyRate(centsOf(i.icms.base), i.icms.rate), i.icms.deferral_rate) : 0n), 0n);
  const difalRate = items.find(i => i.icms?.difal_internal_rate)?.icms.difal_internal_rate;
  return {
    VALOR_BASE_ICMS: brMoney(sum(items, 'icms', 'base')), VALOR_ICMS: brMoney(sum(items, 'icms', 'value')), VALOR_BASE_DIFERIMENTO: deferral ? brMoney(sum(items.filter(i => i.icms?.deferral_rate), 'icms', 'base')) : '',
    VALOR_DIFERIMENTO: deferral ? brMoney(deferral) : '', ICMS_PRESUMIDO: '', VALOR_CREDITO_ICMS: brMoney(credit), ALIQUOTA_CREDITO_ICMS: creditRate ? brRate(creditRate) : '',
    VALOR_ICMS_ST: brMoney(sum(items, 'icms', 'st_value')), VALOR_ICMS_RETIDO: brMoney(sum(items, 'icms', 'ret_value')), ALIQUOTA_ICMS_RETIDO: (r => r ? brRate(r) : '')(items.find(i => i.icms?.ret_rate)?.icms.ret_rate),
    VALOR_BASE_ICMS_RETENCAO: brMoney(sum(items, 'icms', 'ret_base')), VALOR_IPI_DEVOLVIDO: brMoney(sum(items, 'ipi', 'devol_value')), APROX_TRIB: brMoney(sum(items, 'others', 'approx_taxes')),
    VALOR_PIS: brMoney(sum(items, 'pis', 'value')), VALOR_COFINS: brMoney(sum(items, 'cofins', 'value')), VALOR_FCP: brMoney(sum(items, 'icms', 'fcp_value')),
    VALOR_RET_IR: brMoney(sum(items, 'retentions', 'ir_value')), VALOR_RET_CSLL: brMoney(sum(items, 'retentions', 'csll_value')), VALOR_RET_PIS: brMoney(sum(items, 'retentions', 'pis_value')),
    VALOR_RET_COFINS: brMoney(sum(items, 'retentions', 'cofins_value')), VALOR_RET_ISS: '0,00', ALIQUOTA_DIFAL: difalRate ? brRate(difalRate) : '', VALOR_ICMS_DESONERADO: brMoney(sum(items, 'icms', 'deson_value')),
    PESO_LIQUIDO: invoice.transport?.volumes?.net_weight ?? '', PESO_BRUTO: invoice.transport?.volumes?.gross_weight ?? '', NUMERO_CUPOM: '', NUMERO_PEDIDO: orders.map(o => o.number).join(', '),
    NOME_FANTASIA: '', PEDIDO_COMPRA: [...new Set(items.map(i => i.others?.purchase_order).filter(Boolean))].join(', '), NOME_VENDEDOR: extra.sellerName ?? '', NUMERO_DI: di?.number ?? '',
    DATA_REGISTRO_DI: brDate(di?.registration_date), LOCAL_DESEMBARACO: di?.clearance_place ?? '', NOME_CANAL_VENDA: '', NOME_LOJA: '', DOC_REFERENCIADO_DATA: '',
    DOC_REFERENCIADO_NUMERO: ref?.number ?? (ref?.key ? String(Number(ref.key.slice(25, 34))) : ''), DOC_REFERENCIADO_CHAVE: ref?.key ?? '',
  };
}
/** Replaces [VARIAVEL] and {VARIAVEL}; unknown names are kept as typed. */
export function fillVariables(text, values) {
  if (!text) return text;
  return text.replace(/[[{]([A-Z_]{3,40})[\]}]/g, (match, name) => Object.hasOwn(values, name) ? values[name] : match);
}
export const SIMPLES_CREDIT_MESSAGE = (value, rate) => `PERMITE O APROVEITAMENTO DO CRÉDITO DE ICMS NO VALOR DE R$ ${value}, CORRESPONDENTE À ALÍQUOTA DE ${rate}%, NOS TERMOS DO ART. 23 DA LEI COMPLEMENTAR Nº 123, DE 2006`;
const TAX_GROUPS = ['icms', 'ipi', 'pis', 'cofins'];
function natureTexts(invoice, nature, rules, orders, options) {
  const values = infoVariables(invoice, orders, { sellerName: options.sellerName ?? null }), seen = new Set(), additional = [], fiscal = [];
  const push = (list, text) => { const filled = fillVariables(text, values)?.trim(); if (filled && !seen.has(filled)) { seen.add(filled); list.push(filled); } };
  push(additional, nature?.additional_info); push(fiscal, nature?.fiscal_info);
  for (const rule of rules) { push(additional, rule.additional_info); push(fiscal, rule.fiscal_info); }
  // Per-tax texts typed in the item modal join the note's informações complementares / de interesse do fisco.
  for (const item of invoice.items) for (const group of TAX_GROUPS) { push(additional, item[group]?.complementary_info); push(fiscal, item[group]?.fiscal_info); }
  if (options.simplesCreditMessage && values.VALOR_CREDITO_ICMS !== '0,00' && values.ALIQUOTA_CREDITO_ICMS) push(additional, SIMPLES_CREDIT_MESSAGE(values.VALOR_CREDITO_ICMS, values.ALIQUOTA_CREDITO_ICMS));
  if (options.trackingInInfo && invoice.transport?.tracking_code) push(additional, `Código de rastreio: ${invoice.transport.tracking_code}`);
  if (options.purchaseOrderInInfo && values.PEDIDO_COMPRA) push(additional, `Ordem de compra: ${values.PEDIDO_COMPRA}`);
  const limit = (text, max) => [...text].slice(0, max).join('');
  return { additional: additional.length ? limit(additional.join(' '), 5000) : null, fiscal: fiscal.length ? limit(fiscal.join(' '), 2000) : null };
}
