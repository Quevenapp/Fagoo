import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent } from './helpers/component-recovery-harness.mjs';

const row = (extra = {}) => ({ origin: 'origin', id: '9001', number: 5794, series: 1, issue_date: '2026-10-21', name: 'Cliente sintético', document: null, state: 'SP', status: 6,
  total: '10.00', total_known: true, source_origin: 'origin', source_environment: '1', observed_at: '2026-10-22T15:30:00Z', ...extra });
const mount = rows => mountComponent('FiscalInvoicePrint.tsx', { title: 'Notas fiscais', rows, total: rows.length, amount: '10.00', period: 'Todo o período', model: '55', onClose() {} },
  { componentName: 'FiscalListPrint', expandChildren: ['PrintPortal'] });

test('fiscal list print preserves Origin origin, source ID and observation time independently of the document date', async () => {
  const view = await mount([row()]);
  try {
    for (const text of ['Número / origem', 'Nota do Origin · produção', 'ID Origin 9001', '22/10/2026, 12:30', '21/10/2026', 'horário de São Paulo']) assert.ok(view.text().includes(text), text);
    assert.equal(view.nodes().find(node => node.type === 'time').props.dateTime, '2026-10-22T15:30:00Z');
  } finally { view.unmount(); }
});

test('fiscal list print marks native homologation and imported production separately, without inventing observation times', async () => {
  const view = await mount([row({ origin: 'brufap', id: 'native-1', source_origin: 'brufap_native', source_environment: '2', observed_at: null }),
    row({ origin: 'brufap', id: 'native-2', source_origin: 'xml_import', source_environment: '1', observed_at: null }), row({ id: '9002', observed_at: undefined })]);
  try {
    assert.match(view.text(), /Nota do FAGOO · homologação · sem valor fiscal/);
    assert.match(view.text(), /XML importado · produção/);
    assert.equal(view.nodes().some(node => node.type === 'time'), false);
    assert.equal(view.text().includes('ID Origin native'), false);
  } finally { view.unmount(); }
});
