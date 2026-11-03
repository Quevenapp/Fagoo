import test from 'node:test'; import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { createMovementPeriodFixture, movementPeriodIds as ids } from '../src/qa/finance-movement-period-fixture.ts';
const mount = f => mountComponent('FinanceMovementHistory.tsx', { controller: f.controller, accountId: ids.account });
const input = (v, field) => v.find(n => n.type === 'input' && n.props.id.endsWith(`-${field}`)).props.id;
const hasNote = (v, note) => v.nodes().some(n => n.type === 'td' && n.props.children === note);
const defer = () => { let resolve; const promise = new Promise(r => resolve = r); return { resolve, promise }; };
test('typing is local; applying and clearing use inclusive posted_on and reset the pagination', async () => {
  const f = createMovementPeriodFixture(), v = await mount(f);
  try {
    assert.equal(f.calls.length, 1); assert.match(v.text(), /Movimento fictício 1/); await v.click('Próxima'); assert.match(v.text(), /Página 2/);
    await v.change(input(v, 'from'), '2026-10-17'); await v.change(input(v, 'to'), '2026-10-17');
    assert.equal(f.calls.length, 2); assert.match(v.text(), /Movimento fictício 30/); assert.match(v.text(), /ainda não aplicado/); assert.equal(v.button('Anterior').disabled, true);
    await v.submit(); assert.equal(f.calls.length, 3); assert.match(v.text(), /Página 1/); assert.match(f.calls[2].path, /from=2026-10-17&to=2026-10-17/); assert.doesNotMatch(f.calls[2].path, /after=/); assert.equal(hasNote(v, 'Movimento fictício 1'), false);
    await v.click('Limpar período'); assert.equal(f.calls.length, 4); assert.doesNotMatch(f.calls[3].path, /from=|to=|after=|kind=/); assert.match(v.text(), /Movimento fictício 1/);
    assert.ok(f.calls.every(c => c.options.method === 'GET' && c.options.body === undefined));
  } finally { v.unmount(); }
});
test('invalid range leaves the applied table intact without requesting an enlarged period', async () => {
  const f = createMovementPeriodFixture(), v = await mount(f);
  try { await v.change(input(v, 'from'), '2026-11-01'); await v.change(input(v, 'to'), '2026-10-01'); await v.submit(); assert.equal(f.calls.length, 1); assert.match(v.text(), /Confira as datas/); assert.match(v.text(), /Movimento fictício 1/); } finally { v.unmount(); }
});
test('pending query freezes filters and handlers; error removes the previous page and retry uses identical selection', async () => {
  const f = createMovementPeriodFixture(), original = f.controller.finance, late = defer(), v = await mount(f);
  try {
    await v.change(input(v, 'from'), '2026-10-17'); const oldClear = v.button('Limpar período'); let sent = [];
    f.controller.finance = async (p, o) => { sent.push(p); return late.promise; };
    await v.submit(); assert.equal(v.input(input(v, 'from')).disabled, true); assert.equal(v.button('Limpar período').disabled, true); assert.equal(hasNote(v, 'Movimento fictício 1'), false);
    oldClear.props.onClick(); await v.submit(); assert.equal(sent.length, 1);
    late.resolve({}); await v.flush(); assert.match(v.text(), /Não foi possível consultar/); assert.equal(v.nodes().filter(n => n.type === 'tbody').length, 0);
    f.controller.finance = async (p, o) => { sent.push(p); return original(p, o); };
    await v.click('Tentar consultar o mesmo período'); assert.equal(sent[0], sent[1]); assert.match(v.text(), /Movimento fictício 16/);
  } finally { v.unmount(); }
});
test('all movement kinds remain visible with signed exact amounts, without a period balance or total', async () => {
  const f = createMovementPeriodFixture(), v = await mount(f);
  try { for (const label of ['Saldo inicial', 'Baixa', 'Estorno', 'Transferência · saída', 'Transferência · entrada', 'Tarifa bancária', 'Estorno de tarifa bancária']) assert.ok(v.text().includes(label)); assert.match(v.text(), /R\$ -123,45/); assert.doesNotMatch(v.text(), /Saldo do período|Total do período|Saldo final|Saldo acumulado/); assert.match(v.text(), /datas inicial e final são inclusivas/); } finally { v.unmount(); }
});
test('next and previous page retain the applied dates and refuse a retained handler after filter editing', async () => {
  const f = createMovementPeriodFixture(), v = await mount(f);
  try { await v.change(input(v, 'from'), '2026-10-01'); await v.submit(); const oldNext = v.button('Próxima'); await v.click('Próxima'); await v.click('Anterior'); assert.ok(f.calls.slice(1).every(c => c.path.includes('from=2026-10-01'))); const count = f.calls.length; await v.change(input(v, 'to'), '2026-10-17'); oldNext.props.onClick(); await v.flush(); assert.equal(f.calls.length, count); } finally { v.unmount(); }
});
test('role/checking loss aborts late responses; same actor restoration reauthorizes the applied period', async () => {
  for (const change of ['phase', 'role']) {
    const f = createMovementPeriodFixture(), original = f.controller.finance, v = await mount(f), state = f.controller.getSnapshot(), late = defer(); let signal;
    try { await v.change(input(v, 'from'), '2026-10-17'); await v.submit(); f.controller.finance = async (p, o) => { signal = o.signal; return late.promise; }; const oldApply = v.nodes().find(n => n.type === 'form').props.onSubmit; await v.submit();
      f.setSession(change === 'phase' ? { ...state, phase: 'checking' } : { ...state, membership: { ...state.membership, role: 'vendas' } }); oldApply({ preventDefault() {} }); assert.equal(signal.aborted, true); late.resolve(f.response(f.calls[1].path)); await v.flush(); assert.match(v.text(), /indisponível nesta sessão/); assert.doesNotMatch(v.text(), /Movimento fictício/);
      f.controller.finance = original; f.setSession(state); await v.flush(); assert.equal(f.calls.length, 3); assert.match(f.calls[2].path, /from=2026-10-17/); assert.match(v.text(), /Movimento fictício 16/);
    } finally { v.unmount(); }
  }
});
test('another actor or controller resets local filters and stale callbacks cannot dispatch', async () => {
  for (const change of ['actor', 'controller']) {
    const f = createMovementPeriodFixture(), v = await mount(f);
    try { await v.change(input(v, 'from'), '2026-10-17'); await v.submit(); const old = v.nodes().find(n => n.type === 'form').props.onSubmit;
      if (change === 'actor') { const s = f.controller.getSnapshot(); f.setSession({ ...s, membership: { ...s.membership, user_id: ids.otherActor } }); await v.flush(); } else await v.updateProps({ controller: createMovementPeriodFixture().controller });
      const before = f.calls.length; old({ preventDefault() {} }); await v.flush(); assert.equal(f.calls.length, before); assert.equal(v.input(input(v, 'from')).props.value, ''); assert.equal(hasNote(v, 'Movimento fictício 1'), true);
    } finally { v.unmount(); }
  }
});
test('logout drops account query presentation and retained submit; a later session starts a new authorized read', async () => {
  const f = createMovementPeriodFixture(), original = f.controller.finance, v = await mount(f), state = f.controller.getSnapshot(), late = defer(); let signal;
  try {
    await v.change(input(v, 'from'), '2026-10-17'); await v.submit();
    f.controller.finance = async (_, o) => { signal = o.signal; return late.promise; }; const old = v.nodes().find(n => n.type === 'form').props.onSubmit; await v.submit();
    f.setSession({ ...state, phase: 'signed_out', membership: null }); old({ preventDefault() {} }); assert.equal(signal.aborted, true);
    late.resolve(f.response(f.calls[1].path)); await v.flush(); assert.match(v.text(), /indisponível nesta sessão/); assert.equal(v.nodes().some(n => n.type === 'td'), false);
    f.controller.finance = original; f.setSession(state); await v.flush(); assert.equal(f.calls.length, 3); assert.equal(v.input(input(v, 'from')).props.value, ''); assert.doesNotMatch(f.calls[2].path, /from=/);
  } finally { v.unmount(); }
});
test('account change and unmount discard an outstanding response; malformed/403 pages never become zeros', async () => {
  const f = createMovementPeriodFixture(), late = defer(); let signal;
  f.controller.finance = async (_, o) => { signal = o.signal; return late.promise; }; const v = await mount(f);
  try { await v.updateProps({ accountId: ids.otherAccount }); late.resolve(f.response(`/v1/financeiro/movements?parent_id=${ids.account}&limit=25`)); await v.flush(); assert.equal(v.nodes().filter(n => n.type === 'tbody').length, 0); assert.match(v.text(), /Não foi possível consultar/); } finally { v.unmount(); }
  const g = createMovementPeriodFixture(); g.controller.finance = async () => { throw new AccessError(403); }; const denied = await mount(g); try { assert.match(denied.text(), /acesso à consulta/); assert.equal(denied.nodes().filter(n => n.type === 'tbody').length, 0); } finally { denied.unmount(); }
  const h = createMovementPeriodFixture(), pending = defer(); h.controller.finance = async (_, o) => { signal = o.signal; return pending.promise; }; const gone = await mount(h); gone.unmount(); assert.equal(signal.aborted, true); pending.resolve(h.response(`/v1/financeiro/movements?parent_id=${ids.account}&limit=25`));
});
