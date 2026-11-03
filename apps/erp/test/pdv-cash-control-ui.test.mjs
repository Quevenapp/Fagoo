import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent } from './helpers/component-recovery-harness.mjs';

// Synthetic data only. Financeiro › Controle de caixa (173) with the Frente de caixa (202610200206): Total registrado per forma,
// Ver vendas, Movimentos dos Grupos de Produtos and the cash sales in the Dinheiro esperado.
globalThis.document = { activeElement: null, addEventListener() {}, removeEventListener() {} };
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = id(1), CAIXA = id(30), SESSION = id(40), DINHEIRO = id(50), CARTAO = id(51);
const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);
const settle = async view => { for (let i = 0; i < 3; i++) { await new Promise(resolve => setTimeout(resolve, 5)); await view.flush(); } };
const detail = { id: SESSION, account_id: CAIXA, account_name: 'Caixa loja', operator_id: actor, operator_name: 'Operadora Sintética', opened_at: '2026-10-20T12:00:00Z', opened_on: '2026-10-20', previous_change_cents: '0', change_cents: '5000',
  state: 'open', closed_by_name: null, closed_at: null, checked: false, supply_cents: '0', withdrawal_cents: '0', expected_cash_cents: '5000', informed_cents: '3000', version: 3, created_at: '2026-10-20T12:00:00Z',
  values: [{ payment_method_id: DINHEIRO, payment_method_name: 'Dinheiro', amount_cents: '3000' }], methods: [{ payment_method_id: DINHEIRO, name: 'Dinheiro', registered_cents: '0', informed_cents: '3000', difference_cents: '3000' }], moves: [] };
const summary = { entity: 'pos_cash_summary', data_mode: 'erp_native', session_id: SESSION, statuses: ['fulfilled', 'verified'], sales_count: 2, total_cents: '5600', returns_cents: '900',
  methods: [{ payment_method_id: CARTAO, name: 'Cartão de crédito', payment_type: '03', registered_cents: '2000', sales: 1 }, { payment_method_id: DINHEIRO, name: 'Dinheiro', payment_type: '01', registered_cents: '3600', sales: 1 }],
  groups: [{ group_id: id(60), name: 'Papelaria', quantity: '4.000000', value: '40.00', percent: '71.43' }, { group_id: null, name: 'Sem grupo', quantity: '1.000000', value: '16.00', percent: '28.57' }] };

function server({ pos = true } = {}) {
  const calls = [];
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'financeiro' } }), subscribe: () => () => {}, retry() {},
    async catalog() { return { items: [], page: 1, size: 100, total: 0, can_write: false, data_mode: 'erp_native' }; },
    async finance(path) {
      calls.push(path);
      if (path === '/v1/financeiro') return { read: true, write: true, data_mode: 'erp_native' };
      if (path.startsWith('/v1/financeiro/contas-financeiras')) return { entity: 'financial_accounts', page: 1, limit: 100, total: 0, items: [], data_mode: 'erp_native' };
      if (path === `/v1/financeiro/controle-caixa/${SESSION}`) return { entity: 'cash_sessions', record: structuredClone(detail), data_mode: 'erp_native' };
      throw new Error(path);
    },
    ...(pos ? { async pos(path) {
      calls.push(path);
      if (path === `/v1/frente-caixa/caixas/${SESSION}/resumo`) return structuredClone(summary);
      if (path.startsWith('/v1/frente-caixa/vendas?')) return { entity: 'pos_sales', data_mode: 'erp_native', total: 1, items: [{ id: id(70), document_id: id(71), number: '42', document_version: 3, status: 'fulfilled', state: 'finished', kind: 'balcao', table_number: null,
        date: '2026-10-20', created_at: '2026-10-20T13:00:00Z', finished_at: '2026-10-20T13:00:01Z', cancelled_at: null, operator_id: actor, operator_name: 'Operadora Sintética', account_id: CAIXA, account_name: 'Caixa loja', cash_session_id: SESSION,
        contact_id: id(72), contact_name: 'Consumidor final', customer_identified: false, total_cents: '3600', cash_received_cents: null, change_cents: '0', effects: {}, invoice: null, version: 2 }] };
      throw new Error(path);
    } } : {}),
  };
  return { controller, calls };
}
const EXPAND = ['BusyGuard', 'Modal', 'CashSessionDetail', 'PdvCashMethods', 'PdvCashGroups', 'PdvCashSales'];
const mount = source => mountComponent('FinanceCashControl.tsx', { controller: source.controller }, { location: `/financeiro-empresa?area=controle-caixa&caixa=${SESSION}`, expandChildren: EXPAND });

test('Controle de caixa shows the Total registrado of the Frente de caixa, the differences and the product groups', async () => {
  const source = server(), view = await mount(source);
  try {
    await settle(view);
    const shown = view.text();
    assert.match(shown, /Vendas em dinheiro \(Frente de caixa\)R\$ 27,00/, 'Dinheiro registrado minus the devoluções');
    assert.match(shown, /Dinheiro esperadoR\$ 77,00/);
    const rows = view.nodes().filter(node => node.type === 'tr').map(text);
    assert.ok(rows.includes('Cartão de créditoVer vendasR$ 20,00R$ 0,00- R$ 20,00'), rows.join('|'));
    assert.ok(rows.includes('DinheiroVer vendasR$ 36,00R$ 30,00- R$ 6,00'));
    assert.ok(rows.includes('TotalR$ 56,00R$ 30,00- R$ 26,00'));
    assert.ok(rows.includes('Papelaria471,43R$ 40,00'));
    assert.match(shown, /devoluções em dinheiro: R\$ 9,00/);
    view.nodes().filter(node => node.type === 'button' && text(node) === 'Ver vendas')[1].props.onClick(); await settle(view);
    assert.match(view.text(), /Vendas · Dinheiro/); assert.match(view.text(), /Consumidor final/);
    assert.ok(source.calls.includes(`/v1/frente-caixa/vendas?caixa=${SESSION}&method=${DINHEIRO}&limit=50`));
  } finally { view.unmount(); }
});

test('Without the Frente de caixa API the registered total stays zero and Ver vendas is off', async () => {
  const source = server({ pos: false }), view = await mount(source);
  try {
    await settle(view);
    const ver = view.nodes().find(node => node.type === 'button' && text(node) === 'Ver vendas');
    assert.equal(ver.disabled, true);
    assert.match(view.text(), /DinheiroVer vendasR\$ 0,00R\$ 30,00R\$ 30,00/);
    assert.match(view.text(), /Nenhum produto vendido na Frente de caixa neste caixa\./);
  } finally { view.unmount(); }
});

test('Pedido de venda › Detalhes da venda shows the Nº da mesa of a PDV mesa sale and nothing without the Frente de caixa', async () => {
  const DOCUMENT = id(81), calls = [];
  const controller = { getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'vendas' } }),
    async pos(path) { calls.push(path); return { entity: 'pos_order', data_mode: 'erp_native', document_id: DOCUMENT, record: { sale_id: id(80), kind: 'mesa', table_number: 12, state: 'finished', account_name: 'Caixa loja' } }; } };
  const view = await mountComponent('PdvOrderOrigin.tsx', { controller, documentId: DOCUMENT });
  try {
    await settle(view);
    assert.deepEqual(calls, [`/v1/frente-caixa/pedidos/${DOCUMENT}`]);
    assert.equal(view.input('doc-pdv-table').props.value, '12');
    assert.match(view.text(), /Nº da mesaVenda registrada na Frente de caixa \(Caixa loja\)\./);
  } finally { view.unmount(); }
  const without = await mountComponent('PdvOrderOrigin.tsx', { controller: { getSnapshot: controller.getSnapshot }, documentId: DOCUMENT });
  try { await settle(without); assert.equal(without.text(), ''); } finally { without.unmount(); }
});
