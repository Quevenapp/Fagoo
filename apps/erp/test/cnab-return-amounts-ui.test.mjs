import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent } from './helpers/component-recovery-harness.mjs';
import { detail, netDetail, selection, uid } from './helpers/itau-net-credit-fixtures.mjs';
import { cnabReturnAmountsQa } from '../src/qa/cnab-return-amounts-fixture.ts';
const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : value == null || typeof value === 'boolean' ? '' : String(value);
const labels = view => view.nodes().filter(n => n.type === 'dt').map(text);

test('display labels the aggregate and does not claim settlement, split money, or offer actions', async () => {
  const sample = cnabReturnAmountsQa()[1], view = await mountComponent('CnabReturnAmounts.tsx', sample, { expandChildren: true });
  try {
    assert.ok(labels(view).includes('Mora/multa (agregado)')); assert.equal(labels(view).includes('Juros'), false);
    assert.match(view.text(), /R\$ 1,23/); assert.match(view.text(), /não confirma baixa no FAGOO/);
    assert.match(view.text(), /não separa juros de multa/); assert.match(view.text(), /não calcula taxas/);
    assert.equal(view.nodes().some(n => ['button', 'input', 'form', 'a'].includes(n.type)), false);
  } finally { view.unmount(); }
});
test('Inter only displays its two available amounts, with no synthetic zero adjustments', async () => {
  const sample = cnabReturnAmountsQa()[3], view = await mountComponent('CnabReturnAmounts.tsx', sample, { expandChildren: true });
  try { assert.deepEqual(labels(view), ['Valor nominal informado', 'Valor recebido informado']); assert.doesNotMatch(view.text(), /Mora\/multa|Tarifa|IOF/); }
  finally { view.unmount(); }
});
test('operational parent displays literal values once with no action or extra request on open', async () => {
  for (const fee of ['0', '345']) {
    const d = netDetail(); d.context.event.adjustments.fee = fee; d.context.event.adjustments.interest = '123';
    const calls = [], before = structuredClone(d), controller = {
      getSnapshot: () => ({ phase: 'ready', membership: { user_id: uid(100), role: 'consulta' } }),
      async cnabReturns(path, options = {}) { calls.push({ path, method: options.method ?? 'GET' }); assert.equal(options.method ?? 'GET', 'GET'); return structuredClone(d); },
      async finance() { assert.fail('new display must not fetch categories'); }, async itauNetCredit() { assert.fail('no command/preview on open'); },
    };
    const view = await mountComponent('RealCnabOperationalReturns.tsx', { controller, selection, writeAllowed: false, onClose() {} }, { componentName: 'ReturnEventEditor', expandChildren: true });
    try {
      assert.ok(labels(view).includes('Mora/multa (agregado)')); assert.match(view.text(), /R\$ 1,23/);
      assert.equal(labels(view).filter(x => x === 'Valor nominal informado').length, 1);
      assert.equal(labels(view).filter(x => x === 'Valor recebido informado').length, 1);
      assert.doesNotMatch(view.text(), /Nominal \/ recebido|Confirmar baixa integral|Confirmar baixa e tarifa|Baixa com tarifa registrada/);
      assert.equal(calls.length, 1); assert.equal(calls[0].method, 'GET'); assert.deepEqual(d, before);
      assert.deepEqual(d.context.settlement, { allowed: false, issues: ['PAYMENT_AMOUNT_DIFFERS', 'PAYMENT_ADJUSTMENTS_UNSUPPORTED'] });
    } finally { view.unmount(); }
  }
});
test('historical human review uses its stored event and never substitutes current title money', async () => {
  const c = detail().context;
  c.event.adjustments.interest = '123'; c.event.paid_cents = '12468'; c.title.amount_cents = c.title.balance_cents = '99999';
  const value = {
    ...c, occurrence: { ...c.file, file_id: c.file.id, file_hash: c.file.hash },
    profile: { ...c.profile, bank: '341', wallet: '109', account_name: c.account.name, account_mask: '***000', account_version: 1, account_active: true, contract_verified: false, policy_verified: false },
    billing: { ...c.billing, remittance_state: 'ready' }, proposal: { reason: 'PAYMENT_AMOUNTS_REQUIRE_REVIEW' },
    comparison: { reference_matches: true, bank_number_matches: true, amount_matches: false, due_matches: true, fully_open: true, paid_matches_balance: false, has_adjustments: true, reason: 'TITLE_AMOUNT_OR_DUE_DATE_CHANGED' },
  };
  const view = await mountComponent('RealCnabReview.tsx', { value, historical: true }, { componentName: 'ContextView', expandChildren: true });
  try {
    assert.match(view.text(), /Valores preservados no contexto desta revisão/); assert.match(view.text(), /Título no momento da revisão/);
    assert.match(view.text(), /R\$ 123,45/); assert.match(view.text(), /R\$ 124,68/); assert.match(view.text(), /R\$ 999,99/);
    assert.equal(labels(view).filter(x => x === 'Mora/multa (agregado)').length, 1); assert.equal(labels(view).includes('Juros'), false);
    assert.equal(labels(view).filter(x => x === 'Valor nominal informado').length, 1); assert.equal(labels(view).filter(x => x === 'Valor recebido informado').length, 1);
  } finally { view.unmount(); }
});
