import test from 'node:test'; import assert from 'node:assert/strict';
import { mountComponent } from './helpers/component-recovery-harness.mjs';
import { createMovementPeriodFixture } from '../src/qa/finance-movement-period-fixture.ts';
import { createDocumentFinanceLinkFixture } from '../src/qa/document-finance-link-fixture.ts';
const child = (v, name) => v.nodes().find(n => typeof n.type === 'function' && n.type.name === name);
test('account detail composes one movement reader and keeps its original account balance outside the period table', async () => {
  const f = createMovementPeriodFixture();
  const v = await mountComponent('RealFinance.tsx', { controller: f.controller, entity: 'accounts', record: f.account, writable: false, onClose() {}, onEdit() { throw Error('No mutation'); } }, { componentName: 'FinanceDetail', expandChildren: ['FinanceMovementHistory'] });
  try { assert.equal(f.calls.length, 1); assert.equal(child(v, 'FinancialHistory'), undefined); assert.match(v.text(), /Saldo registrado no FAGOOR\$ 1.234,56/); const input = v.find(n => n.type === 'input' && n.props.id.endsWith('-from')); await v.change(input.props.id, '2026-10-17'); await v.submit(); assert.equal(f.calls.length, 2); assert.match(v.text(), /Saldo registrado no FAGOOR\$ 1.234,56/); assert.ok(f.calls.every(x => x.options.method === 'GET' && !x.options.body)); } finally { v.unmount(); }
});
test('title detail keeps the existing settlement history and offers no movement period reader', async () => {
  const f = createDocumentFinanceLinkFixture();
  const v = await mountComponent('RealFinance.tsx', { controller: f.controller, entity: 'titles', record: f.title, writable: false, onClose() {}, onEdit() { throw Error('No mutation'); } }, { componentName: 'FinanceDetail' });
  try { assert.ok(child(v, 'FinancialHistory')); assert.equal(child(v, 'FinanceMovementHistory'), undefined); assert.equal(f.counts.rejected, 0); assert.equal(f.counts.origin, 1); } finally { v.unmount(); }
});
