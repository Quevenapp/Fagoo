import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { serviceLabels } from '../src/lib/document-list-export.ts';
import { documentRowActions } from '../src/lib/document-list-model.ts';
import { record, input } from './helpers/document-commercial-fixtures.mjs';

// Origin OS "⋮ Imprimir etiqueta" and "Etiquetas selecionadas" (VND-224). Synthetic data; no DOM, no network.
const actor = 'a0000000-0000-4000-8000-000000000224';
const os = record('service_orders', { ...input(), equipment: 'Furadeira sintética', serial_number: 'SN-224', date: '2026-10-18' });
const row = { id: os.id, kind: 'service_orders', number: os.number, version: os.version, status: 'open', date: '2026-10-18', total: '12.50', contact_id: os.contact_id, contact_name: 'Contato fictício',
  created_at: '2026-10-18T12:00:00Z', updated_at: '2026-10-18T12:00:00Z', expected_date: null, next_contact: null, template: false, warehouse_id: null, warehouse_name: null, source_proposal_id: null,
  source_proposal_number: null, finance_active: false, stock_active: false, receipt_active: false, reservation_active: false, fiscal_draft: null, internal_notes: null, invoice: null, pendencies: false,
  service_order_number: null, template_name: null, invoice_linked: false };

test('the OS label identifies the equipment received', () => {
  assert.deepEqual(serviceLabels([os]), [{ name: 'Contato fictício', address: 'Equipamento: Furadeira sintética · Nº de série: SN-224', reference: `Ordem de serviço ${os.number} · Entrada 18/10/2026` }]);
  assert.equal(serviceLabels([{ ...os, equipment: null, serial_number: null }])[0].address, 'Equipamento não informado');
  const action = documentRowActions('service_orders', row, { role: 'consulta', writable: false }).find(item => item.action === 'print_label');
  assert.deepEqual([action.label, action.enabled], ['Imprimir etiqueta', true], 'reading profiles print labels too');
});

test('⋮ Imprimir etiqueta reads the saved OS and opens the A4 labels', async () => {
  const calls = [];
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'vendas' } }), subscribe: () => () => {},
    async documents(path) {
      calls.push(path);
      if (path === '/v1/documentos') return { read: ['service_orders'], write: ['service_orders'], data_mode: 'erp_native' };
      if (path === `/v1/documentos/service_orders/${os.id}`) return { kind: 'service_orders', document: os, data_mode: 'erp_native', operational_effects: false };
      if (path.includes('?')) { const q = new URLSearchParams(path.split('?')[1]); return { kind: 'service_orders', items: [row], limit: Number(q.get('limit')), page: Number(q.get('page')), order: 'date_desc', has_more: false, next_cursor: null, total_count: 1, total_amount: '12.50', data_mode: 'erp_native', operational_effects: false }; }
      throw new AccessError(404);
    },
    async catalog(path) { if (path === '/v1/cadastros') return { read: [], write: [] }; return { items: [] }; }, async documentCopy() { throw new AccessError(404); },
  };
  const view = await mountComponent('RealDocuments.tsx', { controller, initialKind: 'service_orders' }, { location: '/documentos-empresa?tipo=service_orders', expandChildren: ['NativeListLayout', 'DocumentList'] });
  try {
    await view.flush();
    const menu = view.nodes().find(n => typeof n.type === 'function' && n.type.name === 'RowMenu');
    menu.props.items.find(entry => entry.label === 'Imprimir etiqueta').onClick(); await view.flush(); await new Promise(resolve => setTimeout(resolve, 20)); await view.flush();
    assert.ok(calls.includes(`/v1/documentos/service_orders/${os.id}`));
    const labels = view.nodes().find(n => typeof n.type === 'function' && n.type.name === 'DocumentLabelsPrint');
    assert.ok(labels, 'the labels open');
    assert.equal(labels.props.labels[0].address, 'Equipamento: Furadeira sintética · Nº de série: SN-224');
    assert.deepEqual(labels.props.heading.noun, ['ordem de serviço', 'ordens de serviço']);
    assert.equal(view.button('Etiquetas selecionadas').disabled, true, 'the panel needs a selection');
  } finally { view.unmount(); }
});

test('Preferências › Serviços "Mensagem padrão para envio de OS por Whatsapp" fills its variables', async () => {
  const { whatsappTemplateMessage, whatsappUrl } = await import('../src/lib/document-whatsapp.ts');
  const { documentPreferences } = await import('../src/lib/document-preferences.ts');
  const withPhone = { ...os, contact_snapshot: { ...os.contact_snapshot, mobile: '(19) 99999-0000' } };
  const template = 'Olá {nome_cliente}, a OS {numero_os} ({equipamento}, série {numero_serie}) de {data_os} está pronta: {valor_total}. {desconhecida}';
  assert.equal(whatsappTemplateMessage(withPhone, template), `Olá Contato fictício, a OS ${os.number} (Furadeira sintética, série SN-224) de 18/10/2026 está pronta: R$ 12,50. {desconhecida}`);
  const url = whatsappUrl(withPhone, template);
  assert.match(decodeURIComponent(url.split('text=')[1]), /a OS .* está pronta/);
  assert.match(decodeURIComponent(whatsappUrl(withPhone, null).split('text=')[1]), /^Ordem de serviço nº/, 'without the template the summary stays');
  const prefs = documentPreferences('service_orders', { page: 'servicos-os', items: [{ key: 'os.mensagem_whatsapp', value: template }] }, null);
  assert.equal(prefs.print.whatsappTemplate, template);
});
