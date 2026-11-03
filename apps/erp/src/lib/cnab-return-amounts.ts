/** Presentation of literal RET fields; this projection never proposes a posting. */
export interface ReturnAmountsEvent {
  bank: '341' | '077';
  amount_cents: string;
  paid_cents: string;
  adjustments: null | Readonly<Record<string, string>>;
}
export interface ReturnAmountRow { readonly field: string; readonly label: string; readonly cents: string; readonly formatted: string }
const adjustmentLabels = Object.freeze({ fee: 'Tarifa', iof: 'IOF', abatement: 'Abatimento', discount: 'Desconto', interest: 'Mora/multa (agregado)', otherCredits: 'Outros créditos' });
const invalid = (): never => { throw new Error('Não foi possível conferir os valores informados pelo arquivo.'); };
const cents = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]{0,14})$/.test(value);
function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return invalid();
  return descriptor.value;
}
function row(field: string, label: string, value: unknown): ReturnAmountRow {
  if (!cents(value)) return invalid();
  const amount = BigInt(value);
  const formatted = `R$ ${(amount / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${(amount % 100n).toString().padStart(2, '0')}`;
  return Object.freeze({ field, label, cents: value, formatted });
}
export function returnAmountRows(event: ReturnAmountsEvent): readonly ReturnAmountRow[] {
  const bank = own(event, 'bank'), adjustments = own(event, 'adjustments');
  if (bank !== '341' && bank !== '077') return invalid();
  const rows = [row('amount_cents', 'Valor nominal informado', own(event, 'amount_cents')), row('paid_cents', 'Valor recebido informado', own(event, 'paid_cents'))];
  if (bank === '077') { if (adjustments !== null) return invalid(); }
  else {
    if (!adjustments || typeof adjustments !== 'object' || Reflect.ownKeys(adjustments).length !== 6) return invalid();
    for (const [field, label] of Object.entries(adjustmentLabels)) rows.push(row(field, label, own(adjustments, field)));
  }
  return Object.freeze(rows);
}
