import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';

// Telas auxiliares da lane contatos: Tipos de contatos, Vendedores, Formas de pagamento, Funcionários, Importar contatos
// e o Próximo número. Synthetic data only.
globalThis.document ??= { activeElement: null, getElementById: () => null };
const actor = '96000000-0000-4000-8000-0000000000aa', stamp = '2026-10-20T12:00:00+00:00';
const uuid = n => `96000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const textOf = value => Array.isArray(value) ? value.map(textOf).join('') : value && typeof value === 'object' ? textOf(value.props?.children) : value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);
const headers = view => view.nodes().filter(node => node.type === 'th').map(node => textOf(node.props.children));
const component = (view, name) => view.find(node => node.type?.name === name);
const TYPES = [['customer', 'Cliente', true], ['seller', 'Vendedor', true], ['accountant', 'Contador', false], ['t1', 'Parceiro', false]].map(([slug, label, system], index) => ({ id: uuid(100 + index), slug, label, system, deletable: !system, position: index + 1, contacts: index }));
function server(handler, role = 'admin') {
  const calls = [], snapshot = { phase: 'ready', membership: { user_id: actor, role } };
  return { calls, snapshot, controller: { getSnapshot: () => snapshot, subscribe: () => () => {}, async catalog(path, options = {}) {
    calls.push({ path, method: options.method, body: options.body && structuredClone(options.body) });
    if (path === '/v1/cadastros/tipos-contato' && !options.method) return { scope: 'contact_types', can_create: true, can_delete: role === 'admin', items: TYPES, data_mode: 'erp_native' };
    return handler(path, options);
  } } };
}

test('Tipos de contatos: system types have no checkbox, a created type and a deletion run one command each', async () => {
  const service = server((path, options) => {
    if (path === '/v1/cadastros/tipos-contato') return { scope: 'contact_type', item: { ...TYPES[3], id: uuid(150), label: options.body.label, contacts: 0 }, replayed: false, data_mode: 'erp_native' };
    if (path.endsWith('/excluir')) return { scope: 'contact_type_delete', id: path.split('/')[4], unlinked: 2, replayed: false, data_mode: 'erp_native' };
    throw new Error(path);
  });
  const view = await mountComponent('ContactTypes.tsx', { controller: service.controller });
  try {
    assert.deepEqual(headers(view), ['Seleção', 'Tipo de contato']);
    assert.match(view.text(), /Quantidade de tipos de contatos4/);
    assert.throws(() => view.find(node => node.props?.['aria-label'] === 'Selecionar Cliente'), 'system types cannot be selected');
    view.find(node => node.props?.['aria-label'] === 'Selecionar Contador').props.onChange({ target: { checked: true } }); await view.flush();
    component(view, 'ToolButton').props.onClick(); await view.flush();
    const dialog = component(view, 'BatchDialog').props;
    const step = await dialog.run(TYPES[2]);
    assert.match(step.message, /2 contatos deixaram de ter este tipo/);
    const sent = service.calls.find(call => call.method === 'POST');
    assert.equal(sent.path, `/v1/cadastros/tipos-contato/${TYPES[2].id}/excluir`); assert.ok(sent.body.command_id);
    await view.change('contact-types-search', 'parc');
    assert.equal(view.nodes().filter(node => node.type === 'tr').length, 2, 'search filters the types');
  } finally { view.unmount(); }
  const reader = server(() => { throw new Error('no writes'); }, 'vendas'), readOnly = await mountComponent('ContactTypes.tsx', { controller: reader.controller });
  try { assert.deepEqual(headers(readOnly), ['Tipo de contato'], 'only administrators delete types'); assert.ok(readOnly.button('Incluir')); } finally { readOnly.unmount(); }
});

const sellerItem = { id: uuid(1), entity: 'contacts', version: 3, active: true, situation: 'A', name: 'Vendedora Sintética', code: null, trade_name: null, person_type: 'F', document: null, email: null, phone: null, mobile: null,
  city: 'Piracicaba', state: 'SP', roles: [], types: ['seller'], crt: null, seller_id: uuid(2), seller_name: null, next_visit: null, is_seller: true, created_at: stamp, updated_at: stamp, source: null, seller_version: 1 };
const sellerContact = { id: uuid(1), entity: 'contacts', version: 3, active: true, created_at: stamp, updated_at: stamp, name: 'Vendedora Sintética', code: null, person_type: 'F', situation: 'A', roles: [], types: ['seller'], persons: [], source: null,
  ie_exempt: false, credit_limit_mode: 'unlimited', taxpayer: '9', state: 'SP', city: 'Piracicaba', seller_record_id: uuid(2), finance_category_name: null, operation_nature_name: null, seller_name: null, updated_by_name: null };
const sellerDto = { id: uuid(2), contact_id: uuid(1), version: 1, user_id: null, user_name: null, allow_unregistered_products: false, view_stock: false, access_hours_enabled: false, access_windows: [], modules: { clientes: true },
  commission_rule: 'parcial', commission_mode: 'fixa', commission_rate: '5.0000', commission_bands: [], discount_limit: '10.0000', notes: null, created_at: stamp, updated_at: stamp };

test('Vendedores: Origin list and filters; the form saves contact and settings in one command and keeps the Vendedor type', async () => {
  let failSave = 1;
  const service = server((path, options) => {
    if (path.startsWith('/v1/cadastros/vendedores?')) { const params = new URLSearchParams(path.split('?')[1]); return { entity: 'sellers', items: [sellerItem], page: Number(params.get('page')), size: 100, total: 1, sort: params.get('sort') ?? 'created_desc', situation: params.get('situation') ?? 'latest', can_write: true, data_mode: 'erp_native' }; }
    if (path === `/v1/cadastros/vendedores/${uuid(2)}` && !options.method) return { entity: 'sellers', seller: sellerDto, contact: sellerContact, can_write: true, users: [{ user_id: uuid(9), name: 'Usuária Vendas', role: 'vendas' }], data_mode: 'erp_native' };
    if (options.method === 'PATCH') { if (failSave-- > 0) throw new AccessError(503); return { entity: 'sellers', seller: { ...sellerDto, version: 2 }, contact: sellerContact, replayed: false, data_mode: 'erp_native' }; }
    throw new Error(path);
  });
  const view = await mountComponent('RealSellers.tsx', { controller: service.controller }, { expandChildren: ['NativeListLayout', 'SellerEditor', 'SellerForm'] });
  try {
    assert.deepEqual(headers(view), ['Seleção', 'Nome', 'Cidade', 'Estado', 'Ações']);
    assert.deepEqual(component(view, 'AppliedChips').props.chips.map(chip => chip.label), ['Exibindo pela ordem de inclusão']);
    assert.match(view.text(), /Quantidade de vendedores1/);
    assert.deepEqual(view.input('seller-type-filter').props.children.map(option => option.props.children), ['Todos', 'Cliente', 'Vendedor', 'Contador', 'Parceiro', 'Sem tipo definido']);
    await view.change('seller-situation-filter', 'E'); await view.submit();
    assert.equal(new URLSearchParams(service.calls.filter(call => call.path.startsWith('/v1/cadastros/vendedores?')).at(-1).path.split('?')[1]).get('situation'), 'E');
    // Financeiro > Comissões (SQL 171): Ver Comissões opens the extrato of the seller for the finance profiles.
    assert.equal(component(view, 'RowMenu').props.items.find(item => item.label === 'Ver Comissões').to, `/financeiro-empresa?area=comissoes&vendedor=${uuid(2)}`);
    await view.click('Vendedora Sintética');
    assert.equal(view.input('seller-name').props.value, 'Vendedora Sintética');
    assert.equal(view.input('seller-commission_rate').props.value, '5'); assert.equal(view.input('seller-discount_limit').props.value, '10');
    // 202610200241 (wave E): the access data say what is applied (no longer "Guardado").
    assert.match(view.text(), /Aplicado: sem “Permite incluir produtos não cadastrados”.*fora dos horários de acesso/s);
    await view.change('seller-user', uuid(9));
    await view.change('seller-discount_limit', '12,5');
    await view.submit();
    assert.match(view.text(), /Conferir resultado/);
    const first = service.calls.find(call => call.method === 'PATCH');
    await view.click('Conferir resultado');
    const patches = service.calls.filter(call => call.method === 'PATCH');
    assert.equal(patches.length, 2); assert.equal(patches[1].body.command_id, first.body.command_id);
    assert.deepEqual([first.body.expected_version, first.body.contact_expected_version, first.body.settings.user_id, first.body.settings.discount_limit, first.body.settings.commission_rate], [1, 3, uuid(9), '12.5', '5']);
    assert.ok(first.body.contact.types.includes('seller'));
    assert.match(view.text(), /Vendedor salvo\./);
  } finally { view.unmount(); }
});

const methodItem = { id: uuid(20), version: 2, active: true, is_default: false, created_at: stamp, updated_at: stamp, account_name: 'Caixa', description: 'Cartão de Crédito', payment_type: '03', condition: '30 60', destination: 'contas', account_id: uuid(21),
  business_days: false, applicable: 'recebimentos', interest_rate: null, fine_rate: null, card_brand: '01', card_integration: '2', card_cnpj: '11222333000181', auto_settle: false, pix_integration: null, pix_cnpj: null, fee_type: 'aliquota', fee_rate: '2.5000', fee_fixed: null, settlement_days: 30 };
test('Formas de pagamento: Origin columns and indicators, Forma padrão and Duplicar, and sections by payment type', async () => {
  const service = server((path, options) => {
    if (path.startsWith('/v1/cadastros/formas-pagamento?')) return { entity: 'payment_methods', items: [methodItem], page: 1, size: 100, total: 1, can_write: true, accounts: [{ id: uuid(21), name: 'Caixa', active: true }], data_mode: 'erp_native' };
    if (path.endsWith('/acao')) return { entity: 'payment_methods', id: methodItem.id, action: options.body.action, item: { ...methodItem, is_default: true, version: 3 }, previous_default: null, replayed: false, data_mode: 'erp_native' };
    if (options.method === 'POST') return { entity: 'payment_methods', item: { ...methodItem, id: uuid(22), version: 1 }, replayed: false, data_mode: 'erp_native' };
    throw new Error(path);
  }, 'financeiro');
  const view = await mountComponent('RealPaymentMethods.tsx', { controller: service.controller }, { expandChildren: ['NativeListLayout', 'PaymentMethodEditor'] });
  try {
    assert.deepEqual(headers(view), ['Seleção', 'Descrição', 'Tipo de pagamento', 'Destino', 'Conta financeira', 'Aplicável à', 'Situação', 'Marcador', 'Ações']);
    assert.deepEqual(component(view, 'AppliedChips').props.chips.map(chip => chip.label), ['Situação: Ativa']);
    assert.ok(view.find(node => node.props?.['aria-label'] === 'Recebimento')); assert.throws(() => view.find(node => node.props?.['aria-label'] === 'Pagamento'));
    const menu = component(view, 'RowMenu').props.items;
    // 371 (leva H): the default of each purpose the forma serves (this one only recebimentos).
    assert.deepEqual(menu.map(item => item.label), ['Forma padrão de recebimentos', 'Forma padrão de devoluções', 'Duplicar', 'Inativar']);
    menu[0].onClick(); await view.flush();
    await component(view, 'BatchDialog').props.run(methodItem);
    assert.deepEqual({ ...service.calls.find(call => call.path.endsWith('/acao')).body, command_id: 'x' }, { command_id: 'x', expected_version: 2, action: 'default_recebimentos' });
    component(view, 'BatchDialog').props.onClose(null); await view.flush();
    component(view, 'RowMenu').props.items[2].onClick(); await view.flush();
    assert.equal(view.input('payment-description').props.value, 'Cartão de Crédito', 'Duplicar opens a prefilled new form');
    assert.ok(view.input('payment-card_brand')); assert.throws(() => view.input('payment-interest_rate'), 'boleto section hidden for cards');
    await view.change('payment-payment_type', '15');
    assert.ok(view.input('payment-interest_rate')); assert.throws(() => view.input('payment-card_brand'));
    await view.submit();
    const post = service.calls.find(call => call.method === 'POST' && call.path === '/v1/cadastros/formas-pagamento');
    assert.deepEqual([post.body.data.payment_type, post.body.data.card_brand, post.body.data.card_cnpj, post.body.data.fee_rate], ['15', null, null, '2.5']);
  } finally { view.unmount(); }
});

test('Funcionários: empty state, Situação Ativos by default, CPF checked before saving and Desligar', async () => {
  const items = [];
  const service = server((path, options) => {
    if (path.startsWith('/v1/cadastros/funcionarios?') || path === '/v1/cadastros/funcionarios' && !options.method) { const params = new URLSearchParams(path.split('?')[1] ?? ''); return { entity: 'employees', items, page: Number(params.get('page') ?? 1), size: 100, total: items.length, situation: params.get('situation') ?? 'ativos', data_mode: 'erp_native' }; }
    if (options.method === 'POST') return { entity: 'employees', item: { id: uuid(30), version: 1 }, replayed: false, data_mode: 'erp_native' };
    if (path === `/v1/cadastros/funcionarios/${uuid(30)}` && !options.method) return { entity: 'employees', item: { id: uuid(30), version: 1, situation: 'ativo', created_at: stamp, updated_at: stamp, name: 'Func', cpf: '52998224725', rg: null, job_title: null, pis: null, ctps: null, code: null, phone: null, mobile: null, email: null,
      emergency_phone: null, postal_code: null, state: null, city: null, district: null, street: null, number: null, complement: null, birth_date: null, admission_date: null, salary: '1000.00', notes: null }, data_mode: 'erp_native' };
    if (options.method === 'PATCH') return { entity: 'employees', item: { id: uuid(30), version: 2 }, replayed: false, data_mode: 'erp_native' };
    throw new Error(path);
  });
  const view = await mountComponent('RealEmployees.tsx', { controller: service.controller }, { expandChildren: ['NativeListLayout', 'EmployeeEditor', 'EmployeeForm'] });
  try {
    assert.match(view.text(), /Nenhum item registrado/); assert.match(view.text(), /Ainda não existem cadastros no seu sistema, comece agora mesmo/);
    assert.deepEqual(component(view, 'AppliedChips').props.chips.map(chip => chip.label), ['Situação: Ativos']);
    view.nodes().filter(node => node.type === 'button' && textOf(node) === 'Incluir cadastro')[0].props.onClick(); await view.flush();
    await view.change('employee-name', 'Func'); await view.change('employee-cpf', '111.111.111-11'); await view.submit();
    assert.match(view.text(), /Informe um CPF válido/); assert.equal(service.calls.some(call => call.method), false);
    await view.change('employee-cpf', '529.982.247-25'); await view.change('employee-salary', '1000'); await view.submit();
    const post = service.calls.find(call => call.method === 'POST');
    assert.deepEqual([post.body.data.cpf, post.body.data.salary, Object.keys(post.body.data).length], ['52998224725', '1000', 22]);
    assert.equal(view.input('employee-cpf').props.value, '529.982.247-25', 'the saved employee is read again');
    await view.click('Desligar funcionário');
    assert.deepEqual({ ...service.calls.find(call => call.method === 'PATCH').body, command_id: 'x' }, { command_id: 'x', data: null, situation: 'desligado', expected_version: 1 });
  } finally { view.unmount(); }
});

test('Importar contatos: a CSV is read, validated in batches and only the valid rows are imported with one command per batch', async () => {
  const service = server((path, options) => {
    if (path === '/v1/cadastros/contatos/importar') return { scope: 'contact_import', dry_run: options.body.dry_run, replayed: false, data_mode: 'erp_native',
      items: options.body.rows.map(row => options.body.dry_run ? (row.data.email === 'ruim' ? { row: row.row, status: 'invalid', code: 'invalid', field: 'email' } : { row: row.row, status: 'valid' }) : { row: row.row, status: 'created', record_id: uuid(40 + row.row) }) };
    throw new Error(path);
  }, 'vendas');
  const view = await mountComponent('RealImportContacts.tsx', { controller: service.controller });
  try {
    assert.match(view.text(), /Selecione o arquivo de contatos/); assert.match(view.text(), /Limite de 10\.000 contatos por planilha\./);
    const csv = '﻿"Nome";"E-Mail";"Tipo de Contato"\r\n"Ana";"ana@sintetico.test";"Cliente"\r\n"Bia";"ruim";""\r\n"";"x@y.test";""\r\n';
    await view.input('contact-import-file').props.onChange({ target: { files: [new File([csv], 'contatos.csv')] } }); await view.flush();
    assert.match(view.text(), /3 linhas/); assert.match(view.text(), /Nome: obrigatório/);
    await view.click('Validar');
    const dry = service.calls.find(call => call.body?.dry_run === true);
    assert.deepEqual(dry.body.rows.map(row => row.row), [2, 3], 'rows with local problems are not sent');
    assert.deepEqual(dry.body.rows[0].data, { name: 'Ana', email: 'ana@sintetico.test', types: ['customer'] });
    assert.match(view.text(), /Confira E-Mail/);
    await view.click('Importar 1 contato');
    const apply = service.calls.find(call => call.body?.dry_run === false);
    assert.deepEqual(apply.body.rows.map(row => row.row), [2]); assert.ok(apply.body.command_id);
    assert.match(view.text(), /1 contato importado\. 2 linhas ficaram de fora\./);
    // Contatos onda C: .XLS is read too (Excel 97-2003, XML 2003 or an HTML table); anything else is refused with a message.
    await view.input('contact-import-file').props.onChange({ target: { files: [new File(['x'], 'antigo.xls')] } }); await view.flush();
    assert.match(view.text(), /Confira se o arquivo é um \.XLSX, \.XLS ou \.CSV válido/);
    await view.input('contact-import-file').props.onChange({ target: { files: [new File(['<table><tr><td>Nome</td><td>E-Mail</td></tr><tr><td>Caio</td><td>caio@sintetico.test</td></tr></table>'], 'exportado.xls')] } }); await view.flush();
    assert.match(view.text(), /1 linha/);
  } finally { view.unmount(); }
});

test('ContactModules routes by path and role; Próximo número is edited by the administrator with CAS and a command', async () => {
  const denied = await mountComponent('ContactModules.tsx', { controller: server(() => { throw new Error('no call'); }, 'vendas').controller, pathname: '/funcionarios-empresa', role: 'vendas' }, { expandChildren: ['Denied'] });
  try { assert.match(denied.text(), /Somente administradores consultam os funcionários/); } finally { denied.unmount(); }
  const service = server((path, options) => {
    if (path === '/v1/cadastros/contatos/codigo' && !options.method) return { scope: 'contact_code', mode: 'sequencial', next_number: '11', version: 2, highest_used: '10', can_edit: true, replayed: false, data_mode: 'erp_native' };
    if (options.method === 'PATCH') { if (options.body.next_number === '5') throw new AccessError(400); return { scope: 'contact_code', mode: 'sequencial', next_number: options.body.next_number, version: 3, highest_used: '10', can_edit: true, replayed: false, data_mode: 'erp_native' }; }
    throw new Error(path);
  });
  const view = await mountComponent('ContactModules.tsx', { controller: service.controller, pathname: '/numeracao-contatos', role: 'admin' }, { expandChildren: ['ContactNumbering'] });
  try {
    assert.match(view.text(), /Sequencial/); assert.match(view.text(), /11/);
    view.find(node => node.props?.['aria-label'] === 'Editar próximo número').props.onClick(); await view.flush();
    await view.change('contact-next-number', '5'); await view.click('Salvar');
    assert.match(view.text(), /maior que o maior código numérico já usado \(10\)/);
    await view.change('contact-next-number', '50'); await view.click('Salvar');
    const sent = service.calls.filter(call => call.method === 'PATCH').at(-1);
    assert.deepEqual({ ...sent.body, command_id: 'x' }, { command_id: 'x', expected_version: 2, next_number: '50' });
    assert.match(view.text(), /Próximo número salvo\./);
  } finally { view.unmount(); }
});

test('Importar contatos: after a refused batch, validating again never sends the rows already imported', async () => {
  let refuse = 1;
  const service = server((path, options) => {
    if (path !== '/v1/cadastros/contatos/importar') throw new Error(path);
    if (!options.body.dry_run && options.body.rows[0].row > 2 && refuse-- > 0) throw new AccessError(400);
    return { scope: 'contact_import', dry_run: options.body.dry_run, replayed: false, data_mode: 'erp_native',
      items: options.body.rows.map(row => options.body.dry_run ? { row: row.row, status: 'valid' } : { row: row.row, status: 'created', record_id: uuid(1000 + row.row) }) };
  });
  const view = await mountComponent('RealImportContacts.tsx', { controller: service.controller });
  try {
    const lines = Array.from({ length: 51 }, (_, index) => `"Contato ${index + 1}"`).join('\r\n');
    await view.input('contact-import-file').props.onChange({ target: { files: [new File([`"Nome"\r\n${lines}\r\n`], 'lote.csv')] } }); await view.flush();
    await view.click('Validar');
    await view.click('Importar 51 contatos');
    assert.match(view.text(), /O lote 2 foi recusado e nada dele foi gravado/);
    await view.click('Validar');
    assert.deepEqual(service.calls.filter(call => call.body?.dry_run === true).at(-1).body.rows.map(row => row.row), [52], 'the 50 imported rows are not validated again');
    await view.click('Importar 1 contato');
    const imports = service.calls.filter(call => call.body?.dry_run === false);
    assert.equal(imports.length, 3); assert.deepEqual(imports[2].body.rows.map(row => row.row), [52]);
    assert.notEqual(imports[2].body.command_id, imports[1].body.command_id, 'a refused batch is a definitive answer: the new batch has its own command');
    assert.match(view.text(), /51 contatos importados\./);
  } finally { view.unmount(); }
});

test('Vendedores: Campos obrigatórios marks and checks only the fields the Vendedor form shows', async () => {
  const service = server((path, options) => {
    if (path.startsWith('/v1/cadastros/vendedores?')) return { entity: 'sellers', items: [], page: 1, size: 100, total: 0, sort: 'created_desc', situation: 'latest', can_write: true, data_mode: 'erp_native' };
    if (path === '/v1/cadastros/vendedores/opcoes') return { scope: 'seller_options', users: [], items: [], data_mode: 'erp_native' };
    if (path === '/v1/cadastros/vendedores' && options.method === 'POST') return { entity: 'sellers', seller: sellerDto, contact: sellerContact, replayed: false, data_mode: 'erp_native' };
    throw new Error(path);
  });
  service.controller.preferences = async () => ({ items: [{ key: 'contatos.campos_obrigatorios', value: ['cep', 'email_nfe'], version: 1 }] });
  const view = await mountComponent('RealSellers.tsx', { controller: service.controller }, { expandChildren: ['NativeListLayout', 'SellerEditor', 'SellerForm'] });
  try {
    await view.click('Incluir um Vendedor');
    assert.match(view.text(), /CEP \*/); assert.match(view.text(), /Nome \*/);
    await view.change('seller-name', 'Vendedora Nova'); await view.submit();
    assert.match(view.text(), /O campo CEP é obrigatório/);
    assert.equal(service.calls.some(call => call.method === 'POST'), false);
    await view.change('seller-postal_code', '13400-000'); await view.submit();
    const post = service.calls.find(call => call.method === 'POST');
    assert.equal(post.body.contact.postal_code, '13400-000'); assert.equal(post.body.contact.nfe_email, null, 'E-Mail para envio da NFe is not on this form, so it is not demanded');
  } finally { view.unmount(); }
});
