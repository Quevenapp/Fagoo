import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';

// 202610200129 Preferências "Próximo número" (RealDocuments → DocumentNumbering) with a synthetic controller; no DOM, no network.
const actor = '20000000-0000-4000-8000-000000000131';
function server({ role = 'admin', replies = [] } = {}) {
  const calls = []; let state = { next_number: '12', minimum_next_number: '10' };
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role } }), subscribe: () => () => {},
    async documents(path, options = {}) {
      calls.push({ path, method: options.method ?? 'GET', body: options.body === undefined ? undefined : structuredClone(options.body) });
      if (path === '/v1/documentos') return { read: ['sales_orders'], write: role === 'consulta' ? [] : ['sales_orders'], data_mode: 'erp_native' };
      if (path === '/v1/documentos/sales_orders/proximo-numero') {
        if (!options.method) return { kind: 'sales_orders', ...state, reserved: false, data_mode: 'erp_native', operational_effects: false };
        const reply = replies.shift(); if (reply instanceof Error) throw reply;
        state = { ...state, next_number: options.body.next_number };
        return { kind: 'sales_orders', ...state, reserved: false, replayed: reply === 'replayed', data_mode: 'erp_native', operational_effects: false };
      }
      if (path.includes('?')) return { kind: 'sales_orders', items: [], limit: 100, page: 1, order: 'date_desc', has_more: false, next_cursor: null, total_count: 0, total_amount: '0.00', data_mode: 'erp_native', operational_effects: false };
      throw new AccessError(404);
    },
    async catalog() { return { read: [], write: [] }; }, async documentCopy() { throw new AccessError(404); },
  };
  return { calls, controller, posts: () => calls.filter(call => call.method === 'POST') };
}
const mount = srv => mountComponent('RealDocuments.tsx', { controller: srv.controller, initialKind: 'sales_orders' }, { location: '/documentos-empresa?tipo=sales_orders&acao=numeracao', expandChildren: ['DocumentNumbering'] });

test('the administrador reads the next and the lowest free number and saves a new one with CAS', async () => {
  const srv = server(), view = await mount(srv);
  try {
    assert.match(view.text(), /Próximo número · Pedidos de venda/);
    assert.equal(view.input('doc-numbering-next').props.value, '12');
    assert.match(view.text(), /Use 10 ou um número maior/);
    await view.change('doc-numbering-next', '9'); await view.click('Salvar');
    assert.match(view.text(), /O próximo número precisa ser 10 ou maior/); assert.equal(srv.posts().length, 0);
    await view.change('doc-numbering-next', '012'); await view.click('Salvar');
    assert.match(view.text(), /sem zeros à esquerda/); assert.equal(srv.posts().length, 0);
    await view.change('doc-numbering-next', '500'); await view.click('Salvar');
    assert.deepEqual([srv.posts()[0].body.expected_next_number, srv.posts()[0].body.next_number], ['12', '500']);
    assert.match(srv.posts()[0].body.command_id, /^[0-9a-f-]{36}$/);
    assert.match(view.text(), /Próximo número alterado para 500\./);
    assert.equal(view.input('doc-numbering-next').props.value, '500');
  } finally { view.unmount(); }
});

test('an unconfirmed answer repeats the same command; a conflict rereads the numbering', async () => {
  const srv = server({ replies: [new AccessError(503), 'replayed', new AccessError(409)] }), view = await mount(srv);
  try {
    await view.change('doc-numbering-next', '300'); await view.click('Salvar');
    assert.match(view.text(), /Use “Conferir resultado”/); assert.equal(view.input('doc-numbering-next').disabled, true, 'frozen while unconfirmed');
    await view.click('Conferir resultado');
    assert.equal(srv.posts()[1].body.command_id, srv.posts()[0].body.command_id);
    assert.match(view.text(), /Próximo número alterado para 300\./);
    const reads = srv.calls.filter(call => call.path.endsWith('/proximo-numero') && call.method === 'GET').length;
    await view.change('doc-numbering-next', '301'); await view.click('Salvar');
    assert.match(view.text(), /A numeração mudou ou o número já foi usado/);
    assert.equal(srv.calls.filter(call => call.path.endsWith('/proximo-numero') && call.method === 'GET').length, reads + 1);
  } finally { view.unmount(); }
});

test('other profiles never see the setting', async () => {
  const srv = server({ role: 'vendas' }), view = await mount(srv);
  try { assert.match(view.text(), /Somente o administrador ajusta o próximo número\./); assert.equal(view.nodes().some(n => n.props?.id === 'doc-numbering-next'), false); }
  finally { view.unmount(); }
});
