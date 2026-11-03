import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent } from './helpers/component-recovery-harness.mjs';

// Documentos lane, wave E: the Transportador of pedidos and propostas comes from the cadastro (picker filtered by the type
// Transportador); the Origin reference of an imported document is shown read-only. Synthetic data only.
const transport = (extra = {}) => ({ freight_mode: '1', volume_count: null, gross_weight: null, delivery_days: null, carrier_reference: null, service_reference: null, tracking_code: null, ...extra });
const commercial = extra => ({ introduction: null, attention_to: null, seller_reference: null, store_reference: null, business_unit_reference: null, transport: transport(extra) });

test('the Origin reference of the transportador is read-only; the serviço de transporte keeps its fields', async () => {
  const changes = [];
  const view = await mountComponent('DocumentCommercialFields.tsx', { value: commercial({ carrier_reference: { system: 'origin', source_id: '9876', label: 'Transportadora do Origin' } }), onChange: value => changes.push(value), disabled: false }, { expandChildren: ['CommercialReferenceFields'] });
  try {
    assert.match(view.text(), /Transportador no Origin: Transportadora do Origin · ID 9876/);
    assert.equal(view.nodes().some(node => node.props?.id === 'doc-carrier_reference-id'), false, 'no editable ID of the transportador');
    assert.ok(view.input('doc-service_reference-id'), 'the serviço de transporte reference stays');
  } finally { view.unmount(); }
  const empty = await mountComponent('DocumentCommercialFields.tsx', { value: commercial(), onChange() {}, disabled: false });
  try { assert.doesNotMatch(empty.text(), /Transportador no Origin/); } finally { empty.unmount(); }
});
