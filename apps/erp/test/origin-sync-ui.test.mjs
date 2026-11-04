// Botão Sincronizar (mão dupla com o Origin, 202610220009-011) e documentos de origem Origin convertidos para o modelo nativo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent } from './helpers/component-recovery-harness.mjs';
import { readOriginSyncStatus, issueText, runText, statsText } from '../src/lib/origin-sync-model.ts';
import { isDocumentMirror, documentOriginLabel, documentSelectionTotals } from '../src/lib/document-mirror-model.ts';

const status = (patch = {}) => ({ scope: 'origin_sync', enabled: true, actor_configured: true, push: { pending: 2, failed: 0, last_sent_at: '2026-10-22T13:00:00Z' },
  pull: { pending: 1, failed: 0, last_applied_at: '2026-10-22T13:05:00Z' }, issues: 0, recent_issues: [], run: null, ...patch });
function server(respond) {
  const calls = [];
  return { calls, controller: { async originSync(path, options = {}) { calls.push({ path, ...options }); return respond(options.method ?? 'GET', calls.length); } } };
}

test('the top bar tool shows the queue and asks for a run; the read-only profile cannot ask', async () => {
  const queued = { id: 'r1', state: 'queued', phase: 'push', requested_at: '2026-10-22T13:06:00Z', started_at: null, finished_at: null, stats: {}, error: null };
  let requested = false;
  const s = server(method => { if (method === 'POST') requested = true; return requested ? status({ run: queued, ...(method === 'POST' ? { requested_run: 'r1' } : {}) }) : status(); });
  const view = await mountComponent('OriginSyncButton.tsx', { controller: s.controller, canRequest: true });
  try {
    await view.click('Sincronizar');
    assert.match(view.text(), /A enviar ao Origin2/); assert.match(view.text(), /A aplicar no FAGOO1/);
    assert.match(view.text(), /vale a alteração mais recente/);
    await view.click('Sincronizar agora (3 na fila)');
    const posts = s.calls.filter(call => call.method === 'POST');
    assert.equal(posts.length, 1); assert.equal(posts[0].path, '/v1/sincronizacao-origin'); assert.equal(posts[0].body, undefined);
    assert.match(view.text(), /Sincronização pedida; começa em instantes/);
    assert.equal(view.button('Sincronizando…').disabled, true);
  } finally { view.unmount(); }
  const readOnly = await mountComponent('OriginSyncButton.tsx', { controller: server(() => status()).controller, canRequest: false });
  try { await readOnly.click('Sincronizar'); assert.equal(readOnly.button('Sincronizar agora (3 na fila)').disabled, true); } finally { readOnly.unmount(); }
});

test('issues are explained in plain words and a malformed status is never shown', async () => {
  const issues = [{ at: '2026-10-22T13:00:00Z', direction: 'push', entity: 'service_orders', record_id: null, source_id: null, code: 'ORIGIN_API_HAS_NO_SERVICE_ORDER_WRITE', detail: null },
    { at: '2026-10-22T13:01:00Z', direction: 'push', entity: 'contacts', record_id: null, source_id: null, code: 'ORIGIN_VALIDATION_ERROR', detail: 'ORIGIN_VALIDATION_ERROR: O campo numeroDocumento é inválido' }];
  const view = await mountComponent('OriginSyncButton.tsx', { controller: server(() => status({ issues: 2, recent_issues: issues })).controller, canRequest: true });
  try {
    await view.click('Sincronizar2');
    assert.match(view.text(), /2 pendências para conferir/);
    assert.match(view.text(), /Este conector não envia ordens de serviço ao Origin/);
    assert.match(view.text(), /O campo numeroDocumento é inválido/);
  } finally { view.unmount(); }
  const broken = await mountComponent('OriginSyncButton.tsx', { controller: server(() => ({ scope: 'other' })).controller, canRequest: true });
  try { await broken.click('Sincronizar'); assert.match(broken.text(), /Não foi possível consultar a sincronização/); assert.doesNotMatch(broken.text(), /A enviar ao Origin/); } finally { broken.unmount(); }
  assert.throws(() => readOriginSyncStatus(status({ push: { pending: -1, failed: 0, last_sent_at: null } })));
  assert.equal(runText({ id: 'r', state: 'running', phase: 'census', stats: {}, error: null }), 'Conferindo no Origin o que foi criado ou excluído lá…');
  assert.equal(runText({ id: 'r', state: 'failed', phase: 'push', stats: {}, error: 'ORIGIN_WRITE_NOT_CONFIGURED' }), 'A última sincronização parou: A API do FAGOO ainda não recebeu as credenciais do aplicativo do Origin..');
  assert.equal(statsText({ pushed: 3, pulled: 0, deleted_in_origin: 1 }), '3 enviados · 1 excluídos no Origin');
  assert.match(issueText({ direction: 'pull', entity: 'sales_orders', source_id: '123', code: 'STATUS_UNMAPPED', detail: '99' }), /^Recebimento do Origin · Pedido de venda 123: Situação do Origin sem correspondência/);
});

test('a document of Origin origin converted to the native model is editable; only one still under the Origin authority is read-only', () => {
  assert.equal(isDocumentMirror({ origin: 'origin', authority: 'brufap', readonly: false }), false);
  assert.equal(isDocumentMirror({ origin: 'origin', authority: 'origin', readonly: true }), true);
  assert.equal(documentOriginLabel({ origin: 'origin', authority: 'brufap' }), 'Origin');
  assert.equal(documentOriginLabel({ origin: 'brufap', authority: 'brufap' }), 'FAGOO');
  const totals = documentSelectionTotals([{ origin: 'origin', authority: 'brufap', total: '10.00' }, { origin: 'brufap', authority: 'brufap', total: '5.00' }]);
  assert.equal(totals.origin.total, '10.00'); assert.equal(totals.brufap.total, '5.00');
});

test('connection modes show the configured provider and prevent manual sends while paused or receiving', async () => {
  for (const mode of ['paused', 'receive']) {
    const s = server(() => status({ connection: { name: 'Fornecedor sintético', mode, setup_url: 'https://api.example.test/integracao-externa' } }));
    const view = await mountComponent('OriginSyncButton.tsx', { controller: s.controller, canRequest: true, canConfigure: true });
    try {
      await view.click('Sincronizar');
      assert.match(view.text(), /Fornecedor sintético/);
      assert.match(view.text(), /Configurar conexão/);
      assert.equal(s.calls.filter(call => call.method === 'POST').length, 0);
    } finally { view.unmount(); }
  }
  assert.throws(() => readOriginSyncStatus(status({ connection: { name: 'X', mode: 'receive', setup_url: 'javascript:alert(1)' } })));
});
