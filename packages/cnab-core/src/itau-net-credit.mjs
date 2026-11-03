/** Exact arithmetic only. A plan is neither bank authentication nor permission to post. */
export const ITAU_NET_CREDIT_POLICY = 'itau109-net-credit-v1';
export const ITAU_NET_CREDIT_ISSUES = Object.freeze([
  'ITAU109_REQUIRED', 'NET_CREDIT_ADJUSTMENTS_UNSUPPORTED', 'MORA_PENALTY_UNSUPPORTED',
  'NET_CREDIT_AMOUNT_INVALID', 'NET_CREDIT_EQUATION_DIFFERS', 'FEE_REQUIRED',
  'FEE_CATEGORY_NOT_READY', 'FEE_CATEGORY_VERSION_CHANGED',
]);
const cents = v => typeof v === 'string' && /^(0|[1-9][0-9]{0,14})$/.test(v);
const uuid = v => typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const version = v => Number.isInteger(v) && v > 0 && v <= 2147483647;
const fail = () => { throw new Error('ITAU_NET_CREDIT_INPUT_INVALID'); };
function capture(v, keys) {
  if (!v || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) fail();
  const d = Object.getOwnPropertyDescriptors(v);
  if (Reflect.ownKeys(d).some(k => typeof k !== 'string' || !keys.includes(k) || !d[k].enumerable || !Object.hasOwn(d[k], 'value')) || keys.some(k => !Object.hasOwn(d, k))) fail();
  return Object.fromEntries(keys.map(k => [k, d[k].value]));
}
function freeze(v) { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }
export function planItau109NetCredit(input) {
  const v = capture(input, ['bank', 'wallet', 'nominal_cents', 'credited_cents', 'adjustments', 'fee_category', 'expected_fee_category_version']);
  if (!['341', '077'].includes(v.bank) || typeof v.wallet !== 'string' || !cents(v.nominal_cents) || !cents(v.credited_cents) || !version(v.expected_fee_category_version)) fail();
  const a = v.adjustments === null ? null : capture(v.adjustments, ['fee', 'iof', 'abatement', 'discount', 'interest', 'otherCredits']);
  if (a && Object.values(a).some(x => !cents(x))) fail();
  const c = v.fee_category === null ? null : capture(v.fee_category, ['id', 'version', 'name', 'kind', 'active']);
  if (c && (!uuid(c.id) || !version(c.version) || typeof c.name !== 'string' || !c.name.length || Array.from(c.name).length > 200 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(c.name) || !['receivable', 'payable', 'both'].includes(c.kind) || typeof c.active !== 'boolean')) fail();
  const issues = [];
  if (v.bank !== '341' || v.wallet !== '109') issues.push('ITAU109_REQUIRED');
  if (!a || ['iof', 'abatement', 'discount', 'otherCredits'].some(k => a[k] !== '0')) issues.push('NET_CREDIT_ADJUSTMENTS_UNSUPPORTED');
  if (a && a.interest !== '0') issues.push('MORA_PENALTY_UNSUPPORTED');
  if (v.nominal_cents === '0' || v.credited_cents === '0') issues.push('NET_CREDIT_AMOUNT_INVALID');
  if (a && BigInt(v.credited_cents) + BigInt(a.fee) !== BigInt(v.nominal_cents)) issues.push('NET_CREDIT_EQUATION_DIFFERS');
  if (a && a.fee === '0') issues.push('FEE_REQUIRED');
  if (!c || !c.active || !['payable', 'both'].includes(c.kind)) issues.push('FEE_CATEGORY_NOT_READY');
  if (c && c.version !== v.expected_fee_category_version) issues.push('FEE_CATEGORY_VERSION_CHANGED');
  return freeze({ policy: ITAU_NET_CREDIT_POLICY, issues, posting: issues.length ? null : {
    principal_cents: v.nominal_cents, interest_cents: '0', penalty_cents: '0', fee_cents: a.fee,
    gross_credit_cents: v.nominal_cents, net_cash_cents: v.credited_cents,
    fee_category: { id: c.id, version: c.version, name: c.name, kind: c.kind },
    legs: [{ kind: 'payment', delta_cents: v.nominal_cents }, { kind: 'bank_fee', delta_cents: `-${a.fee}` }],
  } });
}
