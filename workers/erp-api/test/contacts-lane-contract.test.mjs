import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHandler } from '../src/index.mjs';
import { contactsFixture } from './helpers/contacts-fixture.mjs';

// Worker → real SQL (every published migration + 124-128 in PGlite): the strict validators accept what the RPCs return,
// and the database decides permissions. Synthetic actors and data only.
const SETTINGS = { user_id: null, allow_unregistered_products: false, view_stock: false, access_hours_enabled: false, access_windows: [], modules: {}, commission_rule: 'parcial', commission_mode: 'fixa',
  commission_rate: '5', commission_bands: [], discount_limit: '0', notes: null };
const METHOD = { description: 'Dinheiro', payment_type: '01', condition: null, destination: 'caixa', account_id: null, business_days: false, applicable: 'ambos', interest_rate: null, fine_rate: null,
  card_brand: null, card_integration: null, card_cnpj: null, auto_settle: false, pix_integration: null, pix_cnpj: null, fee_type: 'aliquota', fee_rate: null, fee_fixed: null, settlement_days: null };
const EMPLOYEE = { name: 'Funcionário', cpf: '529.982.247-25', rg: null, job_title: null, pis: null, ctps: null, code: null, phone: null, mobile: null, email: null, emergency_phone: null, postal_code: null,
  state: null, city: null, district: null, street: null, number: null, complement: null, birth_date: null, admission_date: null, salary: '1000', notes: null };

test('contatos lane HTTP routes agree with the SQL contract', async () => {
  const f = await contactsFixture();
  const env = { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-server-key', ALLOWED_ORIGINS: '' };
  try {
    const handler = createHandler({ fetchImpl: async (url, options) => {
      if (url.endsWith('/auth/v1/user')) return new Response(JSON.stringify({ id: f.users[options.headers.Authorization.split('-').at(-1)] }));
      const name = new URL(url).pathname.split('/').at(-1);
      try { return new Response(JSON.stringify(await f.rpc(name, JSON.parse(options.body)))); }
      catch (error) { return new Response(JSON.stringify({ code: error.code, message: 'private SQL details' }), { status: 400 }); }
    } });
    const call = async (path, method = 'GET', data, actor = 'admin') => {
      const response = await handler(new Request(`https://api.example.test${path}`, { method, headers: { Authorization: `Bearer synthetic-${actor}`, ...(data ? { 'Content-Type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : undefined }), env);
      return { status: response.status, data: await response.json() };
    };
    const ok = async (...args) => { const result = await call(...args); assert.equal(result.status, 200, `${args[0]} ${JSON.stringify(result.data)}`); return result.data; };

    const created = await ok('/v1/cadastros/contatos', 'POST', { command_id: randomUUID(), data: { name: 'Cliente HTTP', person_type: 'F', types: ['customer', 'technician'], birth_date: '1991-02-03',
      credit_limit_mode: 'value', credit_limit: '250', avg_tax_load: '7', email: 'a@b.test, c@d.test', next_visit: '2026-10-22', fax: '(19) 3333-4444' } }, 'vendas');
    const id = created.record.id;
    assert.deepEqual([created.record.credit_limit, created.record.avg_tax_load, created.record.roles], ['250.00', '7.00', ['customer']]);
    assert.equal((await ok(`/v1/cadastros/contatos/${id}`, 'GET', undefined, 'estoque')).record.types.join(), 'customer,technician');
    assert.equal((await call('/v1/cadastros/contatos', 'POST', { command_id: randomUUID(), data: { name: 'Sem permissão' } }, 'consulta')).status, 403);
    assert.equal((await call('/v1/cadastros/contatos', 'POST', { command_id: randomUUID(), data: { name: 'PJ com RG', person_type: 'J', rg: '1' } })).status, 400);
    assert.equal((await call(`/v1/cadastros/contatos/${id}`, 'PATCH', { command_id: randomUUID(), expected_version: 9, data: { name: 'x' } })).status, 409);
    const page = await ok('/v1/cadastros/contatos?situation=all&type=technician&period=next_visit&from=2026-10-20&to=2026-10-31');
    assert.deepEqual(page.items.map(i => i.id), [id]);
    assert.deepEqual((await ok('/v1/cadastros/contatos/conferir', 'POST', { data: { person_type: 'F', document: '111.111.111-11' } })).warnings.map(w => w.code), ['invalid_document']);
    assert.equal((await ok(`/v1/cadastros/contatos/${id}/situacao`, 'PATCH', { command_id: randomUUID(), expected_version: 1, situation: 'S' })).record.situation, 'S');
    const exported = await ok('/v1/cadastros/contatos/exportar?situation=all');
    assert.equal(exported.total, 1); assert.equal(exported.items[0].email, 'a@b.test, c@d.test');
    assert.equal((await ok('/v1/cadastros/contatos/exportar?kind=birthdays&situation=all&birth_from=2026-02-01&birth_to=2026-02-28')).items.length, 1);
    assert.equal((await ok(`/v1/cadastros/contatos/${id}/comentarios`, 'POST', { command_id: randomUUID(), body: 'Retornar ligação' }, 'financeiro')).item.author_name, 'financeiro@sintetico.test');
    assert.equal((await ok(`/v1/cadastros/contatos/${id}/comentarios`, 'GET', undefined, 'consulta')).items.length, 1);
    assert.deepEqual((await ok(`/v1/cadastros/contatos/${id}/historico`)).items, []);
    const types = await ok('/v1/cadastros/tipos-contato');
    assert.equal(types.items.length, 9);
    const type = await ok('/v1/cadastros/tipos-contato', 'POST', { command_id: randomUUID(), label: 'Parceiro' });
    assert.equal((await call(`/v1/cadastros/tipos-contato/${type.item.id}/excluir`, 'POST', { command_id: randomUUID() }, 'vendas')).status, 403);
    assert.equal((await ok(`/v1/cadastros/tipos-contato/${type.item.id}/excluir`, 'POST', { command_id: randomUUID() })).unlinked, 0);
    const code = await ok('/v1/cadastros/contatos/codigo');
    assert.equal((await ok('/v1/cadastros/contatos/codigo', 'PATCH', { command_id: randomUUID(), expected_version: code.version, next_number: '100' })).next_number, '100');
    assert.deepEqual((await ok('/v1/cadastros/contatos/importar', 'POST', { dry_run: true, rows: [{ row: 2, data: { name: 'Importado' } }, { row: 3, data: { name: 'Ruim', email: 'x' } }] })).items,
      [{ row: 2, status: 'valid' }, { row: 3, status: 'invalid', code: 'invalid', field: 'email' }]);
    assert.equal((await ok('/v1/cadastros/contatos/importar', 'POST', { command_id: randomUUID(), dry_run: false, rows: [{ row: 2, data: { name: 'Importado' } }] })).items[0].status, 'created');

    const seller = await ok('/v1/cadastros/vendedores', 'POST', { command_id: randomUUID(), contact: { name: 'Vendedor HTTP', city: 'Piracicaba', state: 'SP' }, settings: SETTINGS });
    assert.equal(seller.seller.commission_rate, '5.0000');
    assert.equal((await call('/v1/cadastros/vendedores', 'POST', { command_id: randomUUID(), contact: { name: 'x' }, settings: SETTINGS }, 'vendas')).status, 403);
    assert.equal((await ok(`/v1/cadastros/vendedores/${seller.seller.id}`)).can_write, true);
    assert.equal((await ok('/v1/cadastros/vendedores?situation=all', 'GET', undefined, 'financeiro')).total, 1);
    assert.deepEqual((await ok('/v1/cadastros/vendedores/opcoes?q=vend', 'GET', undefined, 'estoque')).items.map(i => i.name), ['Vendedor HTTP']);
    const current = await ok(`/v1/cadastros/contatos/${id}`);
    assert.equal((await ok(`/v1/cadastros/contatos/${id}/vendedor`, 'PATCH', { command_id: randomUUID(), expected_version: current.record.version, seller_id: seller.seller.id }, 'vendas')).record.seller_name, 'Vendedor HTTP');
    const other = await ok('/v1/cadastros/contatos', 'POST', { command_id: randomUUID(), data: { name: 'Outro' } });
    assert.deepEqual((await ok('/v1/cadastros/vendedores/a-partir-do-contato', 'POST', { command_id: randomUUID(), contact_id: other.record.id })).contact.types, ['seller']);

    const method = await ok('/v1/cadastros/formas-pagamento', 'POST', { command_id: randomUUID(), data: METHOD }, 'financeiro');
    assert.equal((await ok('/v1/cadastros/formas-pagamento?situation=all', 'GET', undefined, 'vendas')).items.length, 1);
    assert.equal((await ok(`/v1/cadastros/formas-pagamento/${method.item.id}/acao`, 'POST', { command_id: randomUUID(), expected_version: 1, action: 'default' })).item.is_default, true);
    assert.equal((await call(`/v1/cadastros/formas-pagamento/${method.item.id}`, 'PATCH', { command_id: randomUUID(), expected_version: 2, data: METHOD }, 'vendas')).status, 403);
    assert.equal((await ok(`/v1/cadastros/formas-pagamento/${method.item.id}/acao`, 'POST', { command_id: randomUUID(), expected_version: 2, action: 'delete' })).item, null);

    const employee = await ok('/v1/cadastros/funcionarios', 'POST', { command_id: randomUUID(), data: EMPLOYEE });
    assert.equal((await ok(`/v1/cadastros/funcionarios/${employee.item.id}`)).item.salary, '1000.00');
    assert.equal((await ok(`/v1/cadastros/funcionarios/${employee.item.id}`, 'PATCH', { command_id: randomUUID(), expected_version: 1, data: null, situation: 'desligado' })).item.version, 2);
    assert.equal((await call('/v1/cadastros/funcionarios', 'GET', undefined, 'financeiro')).status, 403);
    assert.equal((await ok('/v1/cadastros/funcionarios?situation=desligados')).total, 1);
  } finally { await f.close(); }
});
