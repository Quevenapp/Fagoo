import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { occurrenceBody, readOccurrenceResult, readOccurrences, saoPauloNow } from '../src/lib/document-occurrence-model.ts';

// Origin "Ocorrências" modal with a synthetic controller (no DOM, no network).
const doc = '10000000-0000-4000-8000-000000000103', actor = '20000000-0000-4000-8000-000000000001', other = '20000000-0000-4000-8000-000000000002';
const item = (sequence, over = {}) => ({ id: `30000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`, sequence, occurred_on: '2026-10-19', occurred_time: '10:00', text: `Ocorrência ${sequence}`, status_before: 'open', status_after: null, next_contact: null, actor_id: actor, actor_role: 'admin', document_version: 3, recorded_at: '2026-10-19T13:00:00Z', ...over });
const textOf = value => Array.isArray(value) ? value.map(textOf).join('') : value && typeof value === 'object' ? textOf(value.props?.children) : value == null || typeof value === 'boolean' ? '' : String(value);
const walk = (value, visit) => { if (Array.isArray(value)) { value.forEach(v => walk(v, visit)); return; } if (!value || typeof value !== 'object') return; visit(value); walk(value.props?.children, visit); };
async function modalAction(view, label) {
  const modal = view.nodes().filter(n => typeof n.type === 'function' && n.type.name === 'Modal').at(-1); let found;
  walk(modal.props.actions, node => { if (node.type === 'button' && textOf(node) === label) found = node; });
  if (!found) throw new Error(`Missing dialog action ${label}`); if (found.props.disabled) throw new Error(`Disabled dialog action ${label}`);
  found.props.onClick?.({ preventDefault() {} }); await view.flush();
}
function server({ kind = 'sales_orders', items = [item(2, { actor_id: other, actor_role: 'vendas', status_after: 'open', status_before: 'draft', text: null }), item(1)], canWrite = true, status = 'open', post } = {}) {
  const calls = []; let snapshot = { phase: 'ready', membership: { user_id: actor, role: 'admin' } }, version = 3, current = status;
  const controller = {
    getSnapshot: () => snapshot,
    async documents(path, options = {}) {
      const call = { path, method: options.method ?? 'GET', body: options.body ? structuredClone(options.body) : undefined }; calls.push(call);
      if (call.method === 'GET') return { kind, document: { id: doc, kind, number: '103', status: current, version }, items, has_more: false, can_write: canWrite, data_mode: 'erp_native', operational_effects: false };
      if (post) post(call, calls);
      if (call.body.status) { current = call.body.status; version += 1; }
      return { kind, document: { id: doc, kind, status: current, version }, replayed: false, occurrence: item(items.length + 1, { occurred_on: call.body.occurred_on, occurred_time: call.body.occurred_time, text: call.body.text, status_after: call.body.status, next_contact: call.body.next_contact ?? null }), data_mode: 'erp_native', operational_effects: false };
    },
  };
  return { calls, controller, posts: () => calls.filter(call => call.method === 'POST'), become: value => { snapshot = value; } };
}
const mount = (srv, kind = 'sales_orders', extra = {}) => mountComponent('DocumentOccurrences.tsx', { controller: srv.controller, kind, documentId: doc, label: 'Pedido 103 · Cliente sintético', targets: status => status === 'open' ? ['in_progress', 'cancelled'] : ['open'], reasonNeeded: (_, to) => to === 'cancelled', onClose: () => {}, ...extra });

test('lists Data | Hora | Ocorrência | Usuário | Situação newest first and saves a text-only occurrence with the same date defaults', async () => {
  const srv = server(), view = await mount(srv);
  try {
    assert.match(view.text(), /Data.*Hora.*Ocorrência.*Usuário.*Situação/s);
    assert.match(view.text(), /2\. 19\/10\/2026.*10:00.*—.*Vendas \(outro usuário\).*Em digitação → Em aberto.*1\. 19\/10\/2026.*Ocorrência 1.*Você.*Em aberto/s);
    assert.match(view.text(), /Atualize a situação do pedido de venda\. Ex\.: Cancelado\./);
    const today = saoPauloNow();
    assert.equal(view.input('occurrence-date').props.value, today.date); assert.match(view.input('occurrence-time').props.value, /^\d{2}:\d{2}$/);
    assert.deepEqual(view.input('occurrence-status').props.children.map(option => option.props.value), ['open', 'in_progress', 'cancelled']);
    await view.click('Salvar ocorrência');
    assert.match(view.text(), /Descreva a ocorrência ou escolha outra situação/); assert.equal(srv.posts().length, 0);
    await view.change('occurrence-text', 'Cliente pediu boleto'); await view.change('occurrence-time', '14:30');
    await view.click('Salvar ocorrência');
    assert.deepEqual(srv.posts().map(call => [call.path, call.body.expected_version, call.body.text, call.body.status, call.body.occurred_time]), [[`/v1/documentos/sales_orders/${doc}/ocorrencias`, 3, 'Cliente pediu boleto', null, '14:30']]);
    assert.match(view.text(), /Ocorrência salva\./); assert.equal(srv.calls.filter(call => call.method === 'GET').length, 2, 'the history is read again');
    assert.equal(view.input('occurrence-text').props.value, '');
  } finally { view.unmount(); }
});

test('another situação moves the document; cancel needs the description as reason; close reports the change', async () => {
  const closed = [];
  const srv = server(), view = await mount(srv, 'sales_orders', { onClose: changed => closed.push(changed) });
  try {
    await view.change('occurrence-status', 'cancelled'); await view.change('occurrence-text', 'ok'); await view.click('Salvar ocorrência');
    assert.match(view.text(), /pelo menos três caracteres/); assert.equal(srv.posts().length, 0);
    await view.change('occurrence-text', 'Cliente desistiu'); await view.click('Salvar ocorrência');
    assert.deepEqual([srv.posts()[0].body.status, srv.posts()[0].body.text], ['cancelled', 'Cliente desistiu']);
    assert.match(view.text(), /Ocorrência salva e situação alterada para Cancelado\./);
    await modalAction(view, 'Fechar'); assert.deepEqual(closed, [true]);
  } finally { view.unmount(); }
});

test('an unknown outcome repeats the same command; a session change never resends it', async () => {
  let fail = 1;
  const srv = server({ post: () => { if (fail-- > 0) throw new AccessError(503); } }), view = await mount(srv);
  try {
    await view.change('occurrence-text', 'Ligação sem resposta'); await view.click('Salvar ocorrência');
    assert.match(view.text(), /Use “Conferir resultado”/);
    assert.equal(view.input('occurrence-text').disabled, true, 'the entry stays frozen while the outcome is unknown');
    const first = srv.posts()[0].body.command_id;
    await modalAction(view, 'Conferir resultado');
    assert.equal(srv.posts()[1].body.command_id, first); assert.match(view.text(), /Ocorrência salva\./);
  } finally { view.unmount(); }
  const lost = server({ post: () => { throw new AccessError(503); } }), lostView = await mount(lost);
  try {
    await lostView.change('occurrence-text', 'Outra tentativa'); await lostView.click('Salvar ocorrência');
    lost.become({ phase: 'ready', membership: { user_id: other, role: 'admin' } });
    await modalAction(lostView, 'Conferir resultado');
    assert.equal(lost.posts().length, 1); assert.match(lostView.text(), /A sessão mudou/);
  } finally { lostView.unmount(); }
});

test('consulta reads without the new line; propostas show and send Próximo Contato', async () => {
  const readOnly = server({ canWrite: false }), view = await mount(readOnly);
  try { assert.equal(view.nodes().some(n => n.props?.id === 'occurrence-text'), false); assert.match(view.text(), /Seu perfil permite apenas consultar as ocorrências\./); }
  finally { view.unmount(); }
  const proposal = server({ kind: 'sales_proposals', items: [item(1, { next_contact: '2026-10-25' })] }), proposalView = await mount(proposal, 'sales_proposals');
  try {
    assert.match(proposalView.text(), /Próximo Contato.*25\/10\/2026/s);
    await proposalView.change('occurrence-text', 'Retornar na segunda'); await proposalView.change('occurrence-next-contact', '2026-10-26'); await proposalView.click('Salvar ocorrência');
    assert.equal(proposal.posts()[0].body.next_contact, '2026-10-26');
  } finally { proposalView.unmount(); }
});

test('occurrence model validates the page and the result against the request', () => {
  const page = readOccurrences({ kind: 'service_orders', document: { id: doc, kind: 'service_orders', number: '1', status: 'open', version: 2 }, items: [item(1)], has_more: false, can_write: true }, 'service_orders', doc);
  assert.equal(page.items.length, 1);
  assert.throws(() => readOccurrences({ kind: 'service_orders', document: { id: other, kind: 'service_orders', number: '1', status: 'open', version: 2 }, items: [], has_more: false, can_write: true }, 'service_orders', doc));
  const body = occurrenceBody('sales_orders', { status: 'open', version: 3 }, { occurred_on: '2026-10-20', occurred_time: '08:00', text: ' x ', status: 'open', next_contact: '' }, false);
  assert.deepEqual(body, { expected_version: 3, occurred_on: '2026-10-20', occurred_time: '08:00', text: 'x', status: null });
  assert.throws(() => occurrenceBody('sales_orders', { status: 'open', version: 3 }, { occurred_on: '2026-10-20', occurred_time: '8:00', text: 'x', status: '', next_contact: '' }, false), /hora/);
  assert.throws(() => readOccurrenceResult({ kind: 'sales_orders', replayed: false, document: { id: doc, kind: 'sales_orders', status: 'open', version: 3 }, occurrence: item(1) }, 'sales_orders', doc, { expected_version: 3, status: 'cancelled' }), /OCCURRENCE_INVALID/, 'a result in another situação is refused');
});

test('OS (202610200240): the entries of the diário da OS appear with the occurrences, newest first; a failed read keeps the occurrences', async () => {
  const entry = (n, recorded_at, actor_id = actor) => ({ id: `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`, document_id: doc, sequence: String(n), document_version: 3, text: `Diário ${n}`, actor_id, recorded_at });
  // 2026-10-19 13:30Z is 10:30 in São Paulo: between occurrence 1 (10:00) and occurrence 2 (dated 2026-10-20).
  const journalItems = [entry(2, '2026-10-21T15:00:00Z', other), entry(1, '2026-10-19T13:30:00Z')];
  const srv = server({ kind: 'service_orders', items: [item(2, { occurred_on: '2026-10-20', actor_id: other, actor_role: 'vendas', actor_name: 'Bia Sintética' }), item(1)] });
  const paths = []; let fail = false;
  srv.controller.serviceJournal = async path => { paths.push(path); if (fail) throw new AccessError(403); return { scope: 'service_order_journal', document_id: doc, document_version: 3, can_write: true, data_mode: 'erp_native', operational_effects: false, items: journalItems, limit: 100, has_more: false, next_before: null }; };
  const view = await mount(srv, 'service_orders');
  try {
    await view.flush();
    assert.deepEqual(paths, [`/v1/ordens-servico/${doc}/diario?limit=100`]);
    assert.match(view.text(), /21\/10\/2026.*12:00.*Diário 2.*Bia Sintética.*Diário da OS.*2\. 20\/10\/2026.*Ocorrência 2.*19\/10\/2026.*10:30.*Diário 1.*Você.*Diário da OS.*1\. 19\/10\/2026.*Ocorrência 1/s);
    assert.equal(view.nodes().filter(n => n.type === 'button' && String(n.props['aria-label'] ?? '').startsWith('Remover ocorrência')).length, 2, 'the diário has no Remover');
    fail = true; await view.change('occurrence-text', 'Peça chegou'); await view.click('Salvar ocorrência'); await view.flush();
    assert.match(view.text(), /Não foi possível consultar o diário da OS; a lista mostra só as ocorrências\./);
    assert.match(view.text(), /Ocorrência 1/); assert.doesNotMatch(view.text(), /Diário 1/);
  } finally { view.unmount(); }
  const sales = server(), other_ = await mount(sales);
  try { assert.doesNotMatch(other_.text(), /Diário/, 'only the OS read the diário'); } finally { other_.unmount(); }
});

test('a user who does not write the kind (OS without Inclusão e edição, 202610200239) gets no new line and no Remover', async () => {
  const srv = server({ kind: 'service_orders', items: [item(1)], canWrite: true }), view = await mount(srv, 'service_orders', { writable: false });
  try {
    await view.flush();
    assert.equal(view.nodes().some(n => n.props?.id === 'occurrence-text'), false);
    assert.equal(view.nodes().filter(n => n.type === 'button' && String(n.props['aria-label'] ?? '').startsWith('Remover ocorrência')).length, 0);
    assert.match(view.text(), /Seu perfil permite apenas consultar as ocorrências\./);
  } finally { view.unmount(); }
});
