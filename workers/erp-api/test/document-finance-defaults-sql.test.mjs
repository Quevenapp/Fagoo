import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { documentsCFixture } from './helpers/documents-c-fixture.mjs';

// 202610200165 (categoria padrão nas contas lançadas pelos documentos) on PGlite through the real Worker. Synthetic data only.
let f;
before(async () => { f = await documentsCFixture({ upto: '202610200165' }); });
after(() => f?.close());
const ok = async (path, method = 'GET', body, user) => { const r = await f.call(path, method, body, user); assert.equal(r.status, 200, `${method} ${path} ${JSON.stringify(r.value)}`); return r.value; };
const category = async (kind, name) => (await f.rpc('erp_finance_category_execute', { p_user_id: f.users.financeiro, p_command_id: randomUUID(), p_action: 'category_create', p_data: { kind, name } })).record.id;
const setDefault = async (key, id) => f.rpc('erp_finance_category_execute', { p_user_id: f.users.financeiro, p_command_id: randomUUID(), p_action: 'category_set_default', p_data: { key, category_id: id, expected_version: await f.scalar('select version v from erp_finance.category_default where key=$1', [key]) } });
const verifiedOrder = async () => {
  const doc = (await ok('/v1/documentos/sales_orders', 'POST', { command_id: randomUUID(), data: f.data('sales_orders', { installments: [{ due_date: '2026-11-20', amount: '10.00', method: null }] }) })).document;
  return (await ok(`/v1/documentos/sales_orders/${doc.id}/status`, 'POST', { command_id: randomUUID(), expected_version: doc.version, status: 'verified', reason: null })).document;
};
const post = async doc => {
  const base = `/v1/documentos/sales_orders/${doc.id}/financeiro`;
  const preview = await ok(`${base}/preview`, 'POST', { expected_document_version: doc.version, category_id: null, installments: null }, f.users.financeiro);
  const posted = await ok(`${base}/post`, 'POST', { expected_document_version: doc.version, category_id: null, installments: null, command_id: randomUUID(), preview_hash: preview.preview.preview_hash }, f.users.financeiro);
  return { preview: preview.preview, posted };
};

test('165 grants', async () => {
  assert.equal(await f.scalar("select has_function_privilege('service_role','erp_documents.finance_category(text,uuid)','EXECUTE') v"), false);
  for (const fn of ['public.erp_document_finance_preview(uuid,text,uuid,integer,uuid,jsonb)', 'public.erp_document_finance_post(uuid,text,uuid,integer,uuid,text,uuid,jsonb)']) {
    assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v", [fn]), true);
    assert.equal(await f.scalar("select has_function_privilege('authenticated',$1,'EXECUTE') v", [fn]), false);
  }
});

test('Lançar contas without a category uses Padrão venda; without a default the titles stay without category', async () => {
  const none = await post(await verifiedOrder());
  assert.equal(none.preview.category_id, null);
  const sale = await category('receivable', 'Vendas sintéticas');
  await setDefault('sale', sale);
  const withDefault = await post(await verifiedOrder());
  assert.deepEqual([withDefault.preview.category_id, withDefault.preview.category_name], [sale, 'Vendas sintéticas']);
  assert.equal(withDefault.posted.titles[0].category_id, sale);
});
