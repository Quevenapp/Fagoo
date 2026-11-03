import test from 'node:test';
import assert from 'node:assert/strict';
import { brazilHolidays, drawerCreateData, drawerEditData, drawerInitial, drawerLocks, drawerPlan, isBusinessDay, nextBusinessDay, nextWeekday, overdueDays, percentInput, percentText, recurrenceChanges, recurrenceCreateData, referenceOptions, titleCharges, titleDetail, weekdayOf, DrawerError } from '../src/lib/finance-title-drawer.ts';
import { planTitleBatch, titleBatchCommand, titleSituation } from '../src/lib/finance-title-list.ts';

// Synthetic only. 108 drawer model: percentuais, dias úteis, parcelas, Resumo, commands and the detail contract.
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const title = extra => ({ id: id(1), kind: 'receivable', version: 3, group_id: id(2), installment: 1, installments: 1, contact_id: id(3), contact_name: 'Cliente', category_id: null, category_name: null, description: 'Conta', source_reference: null, issued_on: '2026-01-01', due_on: '2026-02-01', amount_cents: '1000', settled_cents: '0', balance_cents: '1000', cancelled: false, status: 'open', overdue: false, document_linked: false,
  competence_on: '2026-01-01', account_id: null, bank_number: null, interest_month_bp: 0, penalty_bp: 0, original_due_on: '2026-02-01', deleted_at: null, ...extra });

test('108 percentuais are integer hundredths; text keeps two decimals', () => {
  assert.deepEqual(['', '0', '1', '1,5', '1,50', '2,05', '100', '100,00'].map(percentInput), [0, 0, 100, 150, 150, 205, 10000, 10000]);
  for (const bad of ['1.5', '1,555', '-1', '100,01', '1000', 'abc', '1,']) assert.throws(() => percentInput(bad), bad);
  assert.deepEqual([0, 5, 150, 10000, null, -1, 1.5].map(percentText), ['0,00', '0,05', '1,50', '100,00', '0,00', '0,00', '0,00']);
});

test('108 dias úteis skip weekends, national holidays, Carnaval, Sexta-feira Santa and Corpus Christi', () => {
  const holidays = brazilHolidays(2026);
  for (const day of ['2026-01-01', '2026-02-16', '2026-02-17', '2026-04-03', '2026-04-21', '2026-05-01', '2026-06-04', '2026-09-07', '2026-10-12', '2026-11-02', '2026-11-15', '2026-11-20', '2026-12-25']) assert.ok(holidays.has(day), day);
  assert.equal(brazilHolidays(2023).has('2023-11-20'), false, 'Consciência Negra is national from 2024');
  assert.equal(isBusinessDay('2026-02-14'), false); assert.equal(nextBusinessDay('2026-02-14'), '2026-02-18');
  assert.equal(nextBusinessDay('2026-04-03'), '2026-04-06'); assert.equal(nextBusinessDay('2026-10-20'), '2026-10-20');
});

test('108/172 Parcelada gives every parcela the Valor (as Origin); the next parcelas use the dia de vencimento capped at the month end', () => {
  const values = { amount: '100,00', due_on: '2026-01-31', issued_on: '2026-01-01', occurrence: 'parcelada', due_day: '31', count: '3', business_days: false };
  assert.deepEqual(drawerPlan(values), [{ amount_cents: '10000', due_on: '2026-01-31' }, { amount_cents: '10000', due_on: '2026-02-28' }, { amount_cents: '10000', due_on: '2026-03-31' }]);
  assert.deepEqual(drawerPlan({ ...values, business_days: true }).map(part => part.due_on), ['2026-02-02', '2026-03-02', '2026-03-31']);
  assert.deepEqual(drawerPlan({ ...values, due_day: '10' }).map(part => part.due_on), ['2026-01-31', '2026-02-10', '2026-03-10']);
  assert.deepEqual(drawerPlan({ ...values, occurrence: 'unica', business_days: true }), [{ amount_cents: '10000', due_on: '2026-01-31' }], 'Única ignores dias úteis, as in Origin');
  assert.deepEqual(drawerPlan({ ...values, occurrence: 'mensal', business_days: true }), [{ amount_cents: '10000', due_on: '2026-02-02' }], 'a recorrente starts with one conta on the vencimento (31/01/2026 is a Saturday)');
  for (const bad of [{ count: '1' }, { count: '121' }, { due_day: '0' }, { due_day: '32' }, { amount: '0,00' }])
    assert.throws(() => drawerPlan({ ...values, ...bad }), error => error instanceof DrawerError, JSON.stringify(bad));
});

test('108 Resumo: juros mensais pró-rata and multa only after vencimento, rounded half up', () => {
  assert.equal(overdueDays('2026-02-01', '2026-02-01'), 0); assert.equal(overdueDays('2026-02-01', '2026-03-03'), 30);
  assert.deepEqual(titleCharges('10000', '2026-02-01', 100, 200, '2026-03-03'), { days: 30, interest_cents: '100', penalty_cents: '200', total_cents: '10300' });
  assert.deepEqual(titleCharges('10001', '2026-02-01', 300, 200, '2026-02-16'), { days: 15, interest_cents: '150', penalty_cents: '200', total_cents: '10351' });
  assert.deepEqual(titleCharges('10000', '2026-02-01', 300, 200, '2026-01-31'), { days: 0, interest_cents: '0', penalty_cents: '0', total_cents: '10000' });
  assert.deepEqual(titleCharges('999999999999999', '2026-02-01', 10000, 10000, '2026-03-03').interest_cents, '999999999999999', 'no Number in the arithmetic');
});

test('108 commands: create carries every drawer field; edit sends only changes and refuses locked ones', () => {
  const values = { ...drawerInitial('2026-10-20'), contact: { id: id(3), name: 'Cliente' }, amount: '10,00', description: ' Conta nova ', interest: '1,00', bank_number: ' 123 ' };
  assert.deepEqual(drawerCreateData('receivable', values), { kind: 'receivable', contact_id: id(3), category_id: null, account_id: null, description: 'Conta nova', source_reference: null, bank_number: '123', issued_on: '2026-10-20', competence_on: '2026-10-20', interest_month_bp: 100, penalty_bp: 0, total_cents: '1000', installments: [{ amount_cents: '1000', due_on: '2026-10-20' }] });
  assert.equal(Object.hasOwn(drawerCreateData('payable', values), 'bank_number'), false, 'contas a pagar have no nº no banco in the drawer');
  for (const [bad, tab] of [[{ contact: null }, 'cabecalho'], [{ description: ' ' }, 'cabecalho'], [{ description: 'x'.repeat(2001) }, 'cabecalho'], [{ due_on: '2026-10-19' }, 'cabecalho'], [{ penalty: '200' }, 'pagamento'], [{ bank_number: 'x'.repeat(61) }, 'pagamento'], [{ competence_on: '2026-02-30' }, 'cabecalho']])
    assert.throws(() => drawerCreateData('receivable', { ...values, ...bad }), error => error instanceof DrawerError && error.tab === tab, JSON.stringify(bad));
  const current = title({ account_id: id(9), interest_month_bp: 100 }), initial = drawerInitial('2026-10-20', current);
  assert.equal(drawerEditData(current, initial, drawerLocks(current, null)), null, 'nothing changed');
  assert.deepEqual(drawerEditData(current, { ...initial, account_id: '', interest: '1,00', due_on: '2026-02-05', competence_on: '2025-12-01' }, drawerLocks(current, null)), { id: id(1), expected_version: 3, competence_on: '2025-12-01', due_on: '2026-02-05', account_id: null });
  const linked = title({ document_linked: true }), locks = drawerLocks(linked, null);
  assert.deepEqual(locks, { contact: true, amount: true, issued: true, reference: true, bank: false, occurrence: true });
  assert.throws(() => drawerEditData(linked, { ...drawerInitial('2026-10-20', linked), amount: '11,00' }, locks), /fica com a origem/);
  const billedLocks = drawerLocks(title(), { billing: { our_number: '1' }, imported: false, settled_before: false });
  assert.deepEqual([billedLocks.contact, billedLocks.amount, billedLocks.issued, billedLocks.bank], [true, true, false, true]);
  assert.deepEqual(drawerLocks(title({ settled_cents: '1' }), null).issued, true);
  // 174: a conta of a Faturamento agrupado keeps the cliente, the emissão and the valor (the SQL guard refuses them).
  const grouped = title({ grouped_billing_id: id(40) }), groupedLocks = drawerLocks(grouped, null);
  assert.deepEqual(groupedLocks, { contact: true, amount: true, issued: true, reference: false, bank: false, occurrence: true });
  assert.throws(() => drawerEditData(grouped, { ...drawerInitial('2026-10-20', grouped), amount: '11,00' }, groupedLocks), /fica com a origem/);
});

test('108 detail contract and option pages are bound to the requested conta', () => {
  const record = title(), valid = { entity: 'titles', data_mode: 'erp_native', record, origin: null, account: null, billing: null, imported: false, settled_before: false, original: null };
  assert.equal(titleDetail(valid, id(1), 'receivable').record.id, id(1));
  for (const bad of [{ ...valid, record: { ...record, id: id(7) } }, { ...valid, record: { ...record, kind: 'payable' } }, { ...valid, account: { id: id(9), name: 'X', active: true } }, { ...valid, record: { ...record, account_id: id(9) } },
    { ...valid, billing: { remittance_id: id(4), remittance_state: 'ready', file_generated: false, our_number: null, document_number: 'D', remittance_sequence: 1 } }, { ...valid, imported: 'no' }, { ...valid, origin: { document_id: id(5) } }, { ...valid, record: { ...record, document_linked: true } }])
    assert.throws(() => titleDetail(bad, id(1), 'receivable'));
  const accounts = { entity: 'accounts', data_mode: 'erp_native', limit: 100, has_more: false, next_cursor: null, items: [{ id: id(1), name: 'A', kind: 'bank', active: true }, { id: id(2), name: 'B', kind: 'cash', active: false }] };
  assert.deepEqual(referenceOptions(accounts, 'accounts', null).items.map(item => item.name), ['A', 'B']);
  assert.throws(() => referenceOptions({ ...accounts, items: [...accounts.items].reverse() }, 'accounts', null));
  assert.throws(() => referenceOptions({ ...accounts, entity: 'categories' }, 'accounts', null));
});

test('108 situation badge and Excluir batch plan', () => {
  assert.deepEqual(titleSituation(title({ overdue: true, due_on: '2026-10-10' }), '2026-10-20'), { label: 'Atrasada', hint: 'Atrasada por 10 dias' });
  assert.deepEqual(titleSituation(title({ overdue: true, due_on: '2026-10-19' }), '2026-10-20'), { label: 'Atrasada', hint: 'Atrasada por 1 dia' });
  assert.equal(titleSituation(title({ due_on: '2026-10-20' }), '2026-10-20').label, 'Vence hoje');
  assert.deepEqual(['paid', 'partial'].map(status => titleSituation(title({ status, due_on: '2099-01-01' }), '2026-10-20').label), ['Recebida', 'Parcialmente recebida']);
  assert.deepEqual(['paid', 'partial'].map(status => titleSituation(title({ kind: 'payable', status, due_on: '2099-01-01' }), '2026-10-20').label), ['Paga', 'Parcialmente paga']);
  assert.equal(titleSituation(title({ cancelled: true, status: 'cancelled' }), '2026-10-20').label, 'Cancelada');
  assert.equal(titleSituation(title({ due_on: '2099-01-01' }), '2026-10-20').label, 'Em aberto');
  const plan = planTitleBatch('delete', [title(), title({ id: id(2), settled_cents: '1', balance_cents: '999', status: 'partial' }), title({ id: id(3), document_linked: true }), title({ id: id(4), cancelled: true, status: 'cancelled' })], {});
  assert.deepEqual(plan.eligible.map(item => item.id), [id(1), id(4)]);
  assert.deepEqual(plan.skipped.map(item => item.message), ['Possui baixa registrada. Estorne a baixa antes de excluir.', 'Conta gerada por um documento. Desfaça o lançamento no documento de origem.']);
  assert.deepEqual(titleBatchCommand('delete', title(), {}), { action: 'title_delete', data: { id: id(1), expected_version: 3 } });
});

test('138 recurring Ocorrência: recurrence_create carries the schedule; Semanal follows the vencimento weekday; edits propagate only shared fields', () => {
  const base = { ...drawerInitial('2026-10-20'), contact: { id: id(3), name: 'Cliente' }, amount: '50,00', description: ' Aluguel ', due_on: '2026-11-10', interest: '1,00' };
  assert.deepEqual(recurrenceCreateData('receivable', { ...base, occurrence: 'mensal', due_day: '10', end_on: '2027-06-30', business_days: true }), { kind: 'receivable', contact_id: id(3), category_id: null, account_id: null, description: 'Aluguel', source_reference: null, bank_number: null,
    issued_on: '2026-10-20', competence_on: '2026-10-20', due_on: '2026-11-10', amount_cents: '5000', interest_month_bp: 100, penalty_bp: 0, frequency: 'monthly', business_days: true, end_on: '2027-06-30', due_day: 10 });
  assert.deepEqual(Object.entries(recurrenceCreateData('payable', { ...base, occurrence: 'quinzenal', due_day: '10', second_day: '25' })).filter(([key]) => ['frequency', 'due_day', 'second_day', 'weekday', 'end_on', 'bank_number'].includes(key)),
    [['frequency', 'biweekly'], ['end_on', null], ['due_day', 10], ['second_day', 25]], 'Quinzenal has the 2º vencimento; a pagar has no nº no banco');
  assert.equal(weekdayOf('2026-11-10'), 2); assert.equal(nextWeekday('2026-11-10', 5), '2026-11-13'); assert.equal(nextWeekday('2026-11-10', 2), '2026-11-10'); assert.equal(nextWeekday('2026-11-10', 0), '2026-11-15');
  const weekly = recurrenceCreateData('receivable', { ...base, occurrence: 'semanal', weekday: '2' });
  assert.deepEqual([weekly.frequency, weekly.weekday, Object.hasOwn(weekly, 'due_day')], ['weekly', 2, false]);
  // 172/175: the Forma de pagamento chosen in the gaveta goes with the recurrence (Parcelada included) and its contas.
  const parcelada = recurrenceCreateData('payable', { ...base, occurrence: 'parcelada', due_day: '10', count: '3', payment_method_id: id(9) });
  assert.deepEqual([parcelada.frequency, parcelada.installments, parcelada.payment_method_id, Object.hasOwn(parcelada, 'end_on')], ['installments', 3, id(9), false]);
  assert.equal(Object.hasOwn(recurrenceCreateData('payable', { ...base, occurrence: 'mensal', due_day: '10' }), 'payment_method_id'), false, 'Selecione sends no forma');
  for (const bad of [{ occurrence: 'semanal', weekday: '3' }, { occurrence: 'mensal', due_day: '0' }, { occurrence: 'quinzenal', due_day: '10', second_day: '10' }, { occurrence: 'quinzenal', due_day: '10', second_day: '' }, { occurrence: 'mensal', end_on: '2026-11-01' }, { occurrence: 'unica' }, { occurrence: 'mensal', amount: '0,00' }])
    assert.throws(() => recurrenceCreateData('receivable', { ...base, ...bad }), error => error instanceof DrawerError, JSON.stringify(bad));
  assert.deepEqual(recurrenceChanges({ id: id(1), expected_version: 3, due_on: '2026-12-01', amount_cents: '700', description: 'Novo' }), { description: 'Novo', amount_cents: '700' });
  assert.equal(recurrenceChanges({ id: id(1), expected_version: 3, due_on: '2026-12-01', competence_on: '2026-12-01' }), null, 'vencimento and competência stay with each conta');
});
