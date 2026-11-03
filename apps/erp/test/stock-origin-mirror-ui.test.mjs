import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent } from './helpers/component-recovery-harness.mjs';
import { mirrorActor, mirrorPage, mirrorPosition, mirrorProduct, otherMirrorProduct } from './helpers/stock-origin-mirror-fixture.mjs';

function server(respond = () => mirrorPage()) {
  const calls = [], listeners = new Set(); let snapshot = { phase: 'ready', membership: { user_id: mirrorActor, role: 'consulta' } };
  return { calls, controller: { getSnapshot: () => snapshot, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }, async stock(path, options) { calls.push({ path, ...options }); return respond(new URL(path, 'https://example.invalid'), calls.length); } },
    changeSession(patch) { snapshot = { ...snapshot, ...patch }; listeners.forEach(listener => listener()); } };
}
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const control = (view, suffix) => view.find(node => typeof node.props.id === 'string' && node.props.id.endsWith(suffix)).props.id;

test('mirror shows source IDs, observed moment, negative and partial quantities without enaorigin any native command', async () => {
  const s = server(() => mirrorPage({ items: [mirrorPosition(), mirrorPosition(2, { physical: null, physical_state: 'null', virtual: '0.000000', reserved: null, issues: ['BALANCE_INCOMPLETE'] })] }));
  const view = await mountComponent('StockOriginMirror.tsx', { controller: s.controller });
  try {
    assert.match(view.text(), /Origem Origin.*Somente leitura/); assert.match(view.text(), /Produto ID 900000000000001/);
    assert.match(view.text(), /22\/10\/2026, 11:20:30/); assert.match(view.text(), /−2,125/);
    assert.match(view.text(), /Não informado \(nulo\)/); assert.match(view.text(), /Cobertura parcial desta posição/);
    assert.match(view.text(), /Saldo incompleto na fonte/); assert.match(view.text(), /nunca equivalem a zero/);
    for (const label of ['Lançar saldo do espelho', 'Reservar saldo do espelho', 'Transferir saldo do espelho']) assert.equal(view.button(label).disabled, true);
    assert.ok(s.calls.every(call => call.method === 'GET' && call.path.startsWith('/v1/estoque/espelho?') && !call.body));
  } finally { view.unmount(); }
});

test('source depot, search and state apply together; cursor paginates and new filter starts at the first page', async () => {
  const s = server(url => url.searchParams.get('after') ? mirrorPage({ items: [mirrorPosition(2)] }) : mirrorPage({ has_more: true, next_after: 1 }));
  const view = await mountComponent('StockOriginMirror.tsx', { controller: s.controller });
  try {
    await view.click('Próxima página'); assert.match(s.calls.at(-1).path, /after=1/); assert.match(view.text(), /Página 2/);
    await view.change(control(view, '-query'), 'peça & cabo'); await view.change(control(view, '-warehouse'), '123'); await view.change(control(view, '-state'), 'pending');
    const count = s.calls.length; assert.equal(count, 2, 'draft controls do not issue requests'); await view.submit();
    const query = new URL(s.calls.at(-1).path, 'https://example.invalid').searchParams;
    assert.equal(query.get('q'), 'peça & cabo'); assert.equal(query.get('warehouse_source_id'), '123'); assert.equal(query.get('state'), 'pending'); assert.equal(query.has('after'), false);
    assert.match(view.text(), /Página 1/); await view.click('Limpar filtros'); assert.equal(s.calls.at(-1).path, '/v1/estoque/espelho?limit=50');
  } finally { view.unmount(); }
});

test('late response from another product cannot render and role revocation removes all loaded balances', async () => {
  const pending = deferred(), s = server((url, count) => count === 1 ? pending.promise : mirrorPage({ items: [mirrorPosition(2, { product_id: otherMirrorProduct, product_name: 'Produto atual' })] }));
  const view = await mountComponent('StockOriginMirror.tsx', { controller: s.controller, productId: mirrorProduct });
  try {
    await view.updateProps({ productId: otherMirrorProduct }); assert.match(view.text(), /Produto atual/);
    pending.resolve(mirrorPage({ items: [mirrorPosition(1, { product_name: 'Resposta antiga' })] })); await view.flush();
    assert.doesNotMatch(view.text(), /Resposta antiga/); assert.equal(s.calls[0].signal.aborted, true);
    s.changeSession({ membership: { user_id: mirrorActor, role: 'financeiro' } }); await view.flush();
    assert.doesNotMatch(view.text(), /Produto atual|−2,125/); assert.match(view.text(), /indisponível nesta sessão/);
    assert.equal(s.calls.length, 2, 'revoked role does not fetch again');
  } finally { view.unmount(); }
});

test('empty mirror is not a zero balance and malformed native response never appears as a mirror', async () => {
  for (const [response, expected] of [[mirrorPage({ items: [] }), /A ausência de uma posição não significa saldo zero/], [mirrorPage({ data_mode: 'erp_native' }), /Não foi possível consultar/]]) {
    const s = server(() => response), view = await mountComponent('StockOriginMirror.tsx', { controller: s.controller });
    try { assert.match(view.text(), expected); assert.doesNotMatch(view.text(), /−2,125/); } finally { view.unmount(); }
  }
});
