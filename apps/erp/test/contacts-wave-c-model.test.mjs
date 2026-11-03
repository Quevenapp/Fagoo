import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccessController } from '../src/lib/real-access.ts';
import { contactOptionsPath, contactHistoryPath, contactRecordPath, contactSummary, historyMoney, pickerOptions } from '../src/lib/contact-picker-model.ts';
import { quickContactFullPayload } from '../src/lib/contact-quick-model.ts';
import { contactRefusalText, refusalField } from '../src/components/contact-errors.ts';

// Contatos lane, wave C: the refusal detail kept by the access controller, the picker paths and parsers, the full
// "Contato rápido" payload and the refusal messages. Synthetic data only.
const id = 'b0000000-0000-4000-8000-000000000001';
function controllerWith(answer) {
  const session = { access_token: 'synthetic-token', user: { id: 'a0000000-0000-4000-8000-000000000001' } };
  const auth = { getSession: async () => ({ data: { session }, error: null }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), signInWithPassword: async () => ({ data: { session }, error: null }), signOut: async () => ({ error: null }) };
  return createAccessController(auth, 'https://api.example.test', async url => {
    if (url.endsWith('/me')) return new Response(JSON.stringify({ user_id: session.user.id, role: 'admin', resources: [], data_mode: 'staging_readonly' }));
    return answer();
  });
}
test('the access controller keeps only the allow-listed code and field of a refusal', async () => {
  for (const [body, code, field] of [
    [JSON.stringify({ error: { code: 'ERP_CONTACT_REQUIRED_FIELD', field: 'email', request_id: id } }), 'ERP_CONTACT_REQUIRED_FIELD', 'email'],
    [JSON.stringify({ error: { code: 'ERP_CONFLICT', request_id: id } }), 'ERP_CONFLICT', undefined],
    [JSON.stringify({ error: { code: 'select * from x', field: 'Email; drop' } }), undefined, undefined],
    ['not json', undefined, undefined], [JSON.stringify({ error: { code: 'ERP_X', field: 'x'.repeat(41) }, pad: 'p'.repeat(5000) }), undefined, undefined],
  ]) {
    const controller = controllerWith(() => new Response(body, { status: 400 })), stop = controller.start(); await new Promise(resolve => setTimeout(resolve, 0));
    try {
      await assert.rejects(() => controller.catalog('/v1/cadastros/contatos'), error => error.status === 400 && error.code === code && error.field === field && !String(error.message).includes('drop'));
    } finally { stop(); }
  }
});

test('picker paths, parsers and the money of the history are exact', () => {
  assert.equal(contactOptionsPath({ q: ' Peças ', role: 'supplier', city: 'São Carlos', limit: 50 }), '/v1/cadastros/contatos/opcoes?limit=50&q=Pe%C3%A7as&papel=fornecedor&cidade=S%C3%A3o+Carlos');
  assert.equal(contactOptionsPath({}), '/v1/cadastros/contatos/opcoes?limit=25');
  assert.equal(contactHistoryPath(id, 'sales_orders'), `/v1/cadastros/contatos/${id}/historico?tipo=pedidos-venda`);
  assert.equal(contactRecordPath(id), `/cadastros-reais?cadastro=contacts&registro=${id}`);
  assert.equal(historyMoney('1234567.5'), 'R$ 1.234.567,50'); assert.equal(historyMoney('0.05'), 'R$ 0,05');
  assert.equal(pickerOptions({ scope: 'contact_options', has_more: false, items: [{ id: 'x', name: 'a' }] }), null);
  assert.equal(pickerOptions({ scope: 'contact_options', has_more: false, items: [{ id, name: 'a', code: null, document: null, trade_name: null, city: null, state: null }] }).items.length, 1);
  assert.equal(contactSummary({ scope: 'contact_summary', id: 'other', name: 'a', notes: null, contact_info: null, persons: [] }, id), null, 'another contact is not this summary');
});

test('the full quick contact keeps the legacy checks, clears fields of another Tipo da Pessoa and sends types', () => {
  const base = { name: 'Cliente Sintético', person_type: 'F', document: '529.982.247-25', phone: '', mobile: '', email: '', roles: ['customer'], rg: '12.345', birth_date: '1990-01-02', country: 'Argentina', nfe_email: '' };
  const { data } = quickContactFullPayload('sales_orders', base, '2026-10-20');
  assert.deepEqual([data.types, data.roles, data.rg, data.birth_date, data.country, data.situation, data.taxpayer], [['customer'], undefined, '12.345', '1990-01-02', null, 'A', '9']);
  assert.equal(quickContactFullPayload('purchase_orders', { ...base, person_type: 'E', document: '', roles: ['supplier'] }, '2026-10-20').data.country, 'Argentina');
  for (const [values, field] of [[{ birth_date: '2026-10-21' }, 'birth_date'], [{ nfe_email: 'sem arroba' }, 'nfe_email'], [{ situation: 'E' }, 'situation'], [{ taxpayer: '3' }, 'taxpayer'],
    [{ rg: 'r'.repeat(21) }, 'rg'], [{ contact_info: 'a\u0001' }, 'contact_info'], [{ document: '529.982.247-24' }, 'document'], [{ roles: ['supplier'] }, 'roles']])
    assert.throws(() => quickContactFullPayload('sales_orders', { ...base, ...values }, '2026-10-20'), error => error.field === field, field);
});

test('refusal messages name the field with the Origin label and stay null for generic codes', () => {
  assert.match(contactRefusalText({ status: 400, code: 'ERP_CONTACT_REQUIRED_FIELD', field: 'billing_city' }), /O campo Cidade é obrigatório/);
  assert.match(contactRefusalText({ status: 409, code: 'ERP_CONTACT_DUPLICATE_DOCUMENT' }), /não permitem CPF \/ CNPJ duplicado/);
  assert.match(contactRefusalText({ status: 400, code: 'ERP_PAYMENT_METHOD_INVALID_FIELD', field: 'card_cnpj' }), /CNPJ credenciadora/);
  assert.equal(contactRefusalText({ status: 400, code: 'ERP_INVALID_QUERY' }), null);
  assert.equal(contactRefusalText(new Error('x')), null);
  assert.equal(refusalField({ code: 'ERP_CONTACT_INVALID_FIELD', field: 'website' }), 'website');
  assert.equal(refusalField({ code: 'ERP_PAYMENT_METHOD_INVALID_FIELD', field: 'fee' }), null, 'only contact fields are highlighted in the contact forms');
});
