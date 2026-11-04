import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMenu } from '../src/lib/origin-menu.ts';
import { workspaceMenu, focusModule } from '../src/lib/fagoo-menu.ts';
import { workspaceActions, goToShortcuts, menuDestinations, shortcutIntent, typingTarget, matchesSearch } from '../src/lib/workspace-actions.ts';
import { documentSteps, isSaveShortcut, stepIndexForKey, isSalesFlow } from '../src/lib/document-steps.ts';

const RESOURCES = ['contacts', 'products', 'sales_orders', 'sales_proposals', 'purchase_orders', 'nfe', 'nfce'];
const menu = role => resolveMenu('real', { role, resources: RESOURCES, capabilities: { originIntegration: false, originHistory: false } });

test('quick actions only lead to destinations the menu already resolved for the profile', () => {
  for (const role of ['admin', 'consulta', 'vendas', 'estoque', 'financeiro', 'fiscal']) {
    const groups = menu(role), allowed = menuDestinations(groups);
    for (const action of workspaceActions(groups, role)) {
      const base = action.to.replace('&acao=incluir', '');
      assert.ok(allowed.has(base), `${role}: ${action.to}`);
      if (action.create) assert.ok(['admin', 'vendas'].includes(role), `${role} cannot create ${action.id}`);
    }
  }
  const seller = workspaceActions(menu('vendas'), 'vendas').map(action => action.id);
  assert.deepEqual(seller.slice(0, 2), ['new-sales-order', 'new-proposal']);
  assert.ok(seller.includes('customers') && seller.includes('products'));
  assert.equal(workspaceActions(menu('consulta'), 'consulta').some(action => action.create), false, 'read-only profiles get no creation shortcut');
  assert.deepEqual(workspaceActions([], 'vendas'), []);
  assert.equal(workspaceActions(menu('vendas'), 'vendas')[0].to, '/documentos-empresa?tipo=sales_orders&acao=incluir');
});

test('go-to shortcuts follow the access and always offer the overview', () => {
  const seller = goToShortcuts(menu('vendas'));
  assert.deepEqual(seller.map(item => item.key), ['i', 'p', 'o', 'c', 'a', 'e', 'f', 'r']);
  const stock = goToShortcuts(menu('estoque'));
  assert.ok(stock.some(item => item.key === 'i' && item.to === '/acesso'));
  assert.equal(stock.some(item => item.key === 'o'), false, 'estoque does not read proposals');
  assert.deepEqual(goToShortcuts([]).map(item => item.key), ['i']);
});

test('single-key shortcuts never fire while typing; Ctrl+K always opens the search', () => {
  const groups = menu('vendas'), actions = workspaceActions(groups, 'vendas'), goTo = goToShortcuts(groups);
  const intent = (event, pendingGo = false) => shortcutIntent({ target: { tagName: 'BODY' }, ...event }, { pendingGo, actions, goTo });
  assert.deepEqual(intent({ key: 'k', code: 'KeyK', ctrlKey: true, target: { tagName: 'INPUT', type: 'text' } }), { kind: 'palette' });
  assert.deepEqual(intent({ key: 'k', code: 'KeyK', metaKey: true }), { kind: 'palette' });
  assert.deepEqual(intent({ key: 'n' }), { kind: 'navigate', to: '/documentos-empresa?tipo=sales_orders&acao=incluir' });
  assert.deepEqual(intent({ key: 'o' }), { kind: 'navigate', to: '/documentos-empresa?tipo=sales_proposals&acao=incluir' });
  assert.equal(intent({ key: 'n', target: { tagName: 'INPUT', type: 'search' } }), null);
  assert.equal(intent({ key: 'n', target: { tagName: 'TEXTAREA' } }), null);
  assert.equal(intent({ key: 'n', target: { tagName: 'DIV', isContentEditable: true } }), null);
  assert.equal(intent({ key: 'n', altKey: true }), null, 'Alt+letter stays with the screen (Alt+Z adds a line)');
  assert.equal(intent({ key: 'N', shiftKey: true }), null);
  assert.deepEqual(intent({ key: '/' }), { kind: 'palette' });
  assert.deepEqual(intent({ key: '?', shiftKey: true }), { kind: 'help' });
  assert.deepEqual(intent({ key: 'g' }), { kind: 'go-pending' });
  assert.deepEqual(intent({ key: 'p' }, true), { kind: 'navigate', to: '/documentos-empresa?tipo=sales_orders' });
  assert.equal(intent({ key: 'z' }, true), null, 'an unknown letter after G cancels the sequence');
  assert.equal(shortcutIntent({ key: 'n', target: null }, { pendingGo: false, actions: workspaceActions(menu('consulta'), 'consulta'), goTo }), null, 'no creation shortcut without permission');
  assert.equal(typingTarget({ tagName: 'INPUT', type: 'checkbox' }), false);
  assert.equal(typingTarget({ tagName: 'SELECT' }), true);
});

test('the command search ignores accents, case and word order', () => {
  assert.ok(matchesSearch('Propostas comerciais', 'comerc propo'));
  assert.ok(matchesSearch('Lançamentos de estoque', 'lancamento'));
  assert.ok(matchesSearch('Contas a receber', 'contas a rec'));
  assert.equal(matchesSearch('Contas a pagar', 'contas a rec'), false);
  assert.equal(matchesSearch('Pedidos de venda', '   '), false);
});

test('each profile sees its own modules first; the destinations stay the same', () => {
  const groups = menu('vendas');
  assert.deepEqual(workspaceMenu(groups, 'vendas').map(module => module.name).slice(0, 3), ['Comercial', 'Catálogo', 'Pessoas']);
  assert.equal(focusModule('vendas'), 'Comercial');
  assert.equal(focusModule('admin'), undefined);
  const flat = list => list.flatMap(module => module.columns.flatMap(column => column.items.map(item => item.to))).sort();
  assert.deepEqual(flat(workspaceMenu(groups, 'vendas')), flat(workspaceMenu(groups)));
  assert.deepEqual(workspaceMenu(menu('admin'), 'admin').map(module => module.name), workspaceMenu(menu('admin')).map(module => module.name));
});

test('sales documents follow Cliente, Itens, Pagamento, Entrega and Observações; Alt+number and Ctrl+S are recognized', () => {
  assert.deepEqual(documentSteps('sales_orders', false).map(step => step.label), ['Cliente', 'Itens', 'Pagamento', 'Entrega', 'Observações']);
  assert.deepEqual(documentSteps('sales_orders', true).map(step => step.id).at(-1), 'document-operations');
  assert.equal(documentSteps('sales_proposals', false)[2].label, 'Condições');
  assert.deepEqual(documentSteps('purchase_orders', false).map(step => step.label), ['Fornecedor', 'Itens e valores', 'Pagamento', 'Operações e histórico']);
  assert.equal(isSalesFlow('service_orders'), false);
  assert.equal(stepIndexForKey({ key: '¡', code: 'Digit1', altKey: true }), 0, 'Option+1 on a Mac');
  assert.equal(stepIndexForKey({ key: '3', code: 'Digit3', altKey: true }), 2);
  assert.equal(stepIndexForKey({ key: '3', code: 'Digit3', altKey: true, ctrlKey: true }), null);
  assert.equal(stepIndexForKey({ key: '3', code: 'Digit3' }), null);
  assert.equal(isSaveShortcut({ key: 's', code: 'KeyS', ctrlKey: true }), true);
  assert.equal(isSaveShortcut({ key: 'S', code: 'KeyS', metaKey: true }), true);
  assert.equal(isSaveShortcut({ key: 's', code: 'KeyS', ctrlKey: true, shiftKey: true }), false);
});
