import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { accessKey } from '../../../workers/erp-api/test/helpers/fiscal-import-xml.mjs';
import { record, item } from '../../../packages/fiscal-xml/test/native-invoice-fixtures.mjs';

// "Devolução de produto" (wave E, NFE-162): the modal finds another note by the Nº do pedido or by the number / access key typed or read
// by a barcode reader. Synthetic controller only.
globalThis.document ??= { activeElement: null, getElementById: () => null };
globalThis.document.addEventListener ??= () => undefined; globalThis.document.removeEventListener ??= () => undefined;
const textOf = value => Array.isArray(value) ? value.map(textOf).join('') : value && typeof value === 'object' ? textOf(value.props?.children) : value == null || typeof value === 'boolean' ? '' : String(value);
const settle = async view => { for (let i = 0; i < 6; i++) { await view.flush(); await new Promise(r => setTimeout(r, 5)); } };
const KEY_A = accessKey({ number: 701 }), KEY_B = accessKey({ number: 702 });
const id = n => `50000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (n, key) => ({ origin: 'brufap', id: id(n), version: 3, number: 700 + n, series: 1, issue_date: '2026-10-18', entry_date: null, name: `Cliente ${n}`, document: '11222333000181', state: 'SP', nature: 'Venda',
  status: 8, status_raw: null, total: '30.00', total_known: true, environment: null, issue_type: 'S', access_key: key, xml_id: null, xml_hash: null, xml_size: null, protocol_present: true, event_count: 0, orders: [] });
const detail = (n, key) => ({ invoice: { ...record({ items: [item({ description: `Peça ${n}`, quantity: '3', unit_price: '10' })], payment: { installments: [] } }),
  id: id(n), series: 1, number: 700 + n, access_key: key, status: 8, environment: null, issue_type: 'S' }, data_mode: 'erp_native', writable: false });
const page = items => ({ items, origin: 'brufap', model: '55', direction: '1', page: 1, limit: 100, order: 'date_desc', has_more: false, total_count: items.length, total_amount: '0.00', amount_unknown: 0,
  brufap_visible: true, show_totals: true, data_mode: 'erp_native_homologation' });

test('Devolução de produto: another FAGOO note is found inside the modal by its access key or by the Nº do pedido', async () => {
  const calls = [];
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: '50000000-0000-4000-8000-0000000000aa', role: 'admin' } }), subscribe: () => () => {},
    async fiscalInvoices(path) {
      calls.push(path);
      const q = path.startsWith('/v1/notas-fiscais?') ? new URLSearchParams(path.split('?')[1]) : null;
      if (q?.get('q') === KEY_B) return page([row(2, KEY_B)]);
      if (q?.get('order_number') === '404') return page([]);
      if (q) return page([row(1, KEY_A)]);
      if (path === `/v1/notas-fiscais/${id(1)}`) return detail(1, KEY_A);
      if (path === `/v1/notas-fiscais/${id(2)}`) return detail(2, KEY_B);
      if (path.startsWith('/v1/notas-fiscais/devolucoes/')) { const key = path.split('/').at(-1); return { key, returns: [], items: [], data_mode: 'erp_native' }; }
      throw new AccessError(404);
    },
    async listPreferences(path) { return { scope: 'list_preferences', data_mode: 'erp_native', list_id: path.split('/').at(-1), version: 0, columns: null, filters: null, updated_at: null }; },
    async catalog() { return { items: [], has_more: false }; },
  };
  const view = await mountComponent('RealFiscalInvoices.tsx', { controller, screen: 'nfe' }, { location: '/historico-fiscal?modelo=55&origem=brufap', expandChildren: ['NativeListLayout', 'FiscalReturnDialog'] });
  try {
    await settle(view);
    const menu = view.nodes().find(n => typeof n.type === 'function' && n.type.name === 'RowMenu');
    menu.props.items.find(i => i.label === 'Gerar devolução').onClick(); await settle(view);
    assert.equal(view.input('fiscal-return-key').props.value, `000701 · ${KEY_A}`);
    // The barcode reader types the key and Enter.
    await view.change('fiscal-return-search', KEY_B);
    view.input('fiscal-return-search').props.onKeyDown({ key: 'Enter', preventDefault() {} }); await settle(view);
    assert.ok(calls.some(c => c.includes(`q=${KEY_B}`)), 'the list is searched by the key');
    assert.equal(view.input('fiscal-return-key').props.value, `000702 · ${KEY_B}`, 'the modal now shows the note found');
    assert.ok(calls.includes(`/v1/notas-fiscais/devolucoes/${KEY_B}`), 'the returned balance of the note found is read');
    // A pedido without a note says so and keeps the chosen note.
    await view.change('fiscal-return-order', '404');
    view.nodes().find(n => n.type === 'button' && textOf(n).trim() === 'Buscar nota').props.onClick(); await settle(view);
    assert.match(view.text(), /Nenhuma nota encontrada em Registros do FAGOO com esse número de pedido\./);
    assert.equal(view.input('fiscal-return-key').props.value, `000702 · ${KEY_B}`);
  } finally { view.unmount(); }
});
