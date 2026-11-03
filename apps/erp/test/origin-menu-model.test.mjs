import test from 'node:test';
import assert from 'node:assert/strict';
import { ORIGIN_MENU, COMPANY_PREFERENCES, activeGroupFor, matchesLocation, resolveMenu, resolvePreferences } from '../src/lib/origin-menu.ts';

const labels = group => group.columns.map(column => `${column.title}: ${column.items.map(item => item.label).join(', ')}`);

test('menu keeps the Origin top-level order, column titles and item order', () => {
  assert.deepEqual(ORIGIN_MENU.map(group => group.name), ['Meu Negócio', 'Cadastros', 'Vendas', 'Estoque', 'Financeiro']);
  const byName = Object.fromEntries(ORIGIN_MENU.map(group => [group.name, group]));
  assert.deepEqual(labels(byName.Cadastros), [
    'Cadastros: Produtos, Clientes e fornecedores, Vendedores, Funcionários, Contas Financeiras, Categorias Financeiras, Formas de pagamento',
    'Ferramentas: Categorias de produtos, Listas de preços',
  ]);
  assert.deepEqual(labels(byName.Vendas), [
    'Gestão: Pedidos de venda, Notas fiscais de saída, NFC-e, Frente de caixa, Propostas comerciais',
    'Serviços: Ordens de serviço, Relatórios de serviço',
    'Logística: Checkout de pedidos',
  ]);
  assert.deepEqual(labels(byName.Estoque), [
    'Compras: Pedidos de compra, Notas fiscais de entrada, Fornecedores, Sugestão de Compras, Check-in de Recebimentos',
    'Estoque: Lançamentos de estoque, Conferência de estoque, Depósitos',
  ]);
  assert.deepEqual(labels(byName.Financeiro), ['Gestão financeira: Caixas e bancos, Contas a pagar, Contas a receber, Remessas e retornos, Ficha Financeira, Comissões, Controle de caixa, Faturamento agrupado']);
  assert.deepEqual(['Cadastros', 'Vendas', 'Estoque', 'Financeiro'].map(name => byName[name].footer.label), ['Ver relatórios de cadastros', 'Ver relatórios de vendas', 'Ver relatórios de compras e estoque', 'Ver relatórios financeiros']);
});

test('out-of-scope Origin entries never appear', () => {
  const all = ORIGIN_MENU.flatMap(group => group.columns.flatMap(column => column.items.map(item => item.label)));
  for (const label of ['Gestão de anúncios', 'Loja Virtual', 'Importar pedidos manualmente', 'Objetos de postagem', 'Origin Envios', 'CT-e', 'Notas de serviço', 'DAS MEI', 'GNRE e DARE-SP', 'Origin Conta Digital', 'Multiempresa', 'Ordens de produção']) assert.equal(all.includes(label), false, label);
});

test('demo area enables every item with a demo screen and keeps planned items disabled in place', () => {
  const menu = resolveMenu('demo');
  const cadastros = menu.find(group => group.name === 'Cadastros');
  const items = cadastros.columns[0].items;
  assert.deepEqual(items.map(item => item.label).slice(0, 4), ['Produtos', 'Clientes e fornecedores', 'Vendedores', 'Funcionários']);
  assert.equal(items.find(item => item.label === 'Funcionários').disabled, true);
  assert.equal(items.find(item => item.label === 'Produtos').to, '/produtos');
  assert.equal(cadastros.footer.to, '/relatorios?filter.area=Cadastros');
});

test('real area respects roles and resources and hides groups with nothing enabled', () => {
  const none = resolveMenu('real', {});
  assert.deepEqual(none, []);
  const sales = resolveMenu('real', { role: 'vendas', resources: ['contacts'] });
  assert.deepEqual(sales.map(group => group.name), ['Meu Negócio', 'Cadastros', 'Vendas', 'Estoque']);
  const cadastros = sales.find(group => group.name === 'Cadastros');
  assert.equal(cadastros.columns[0].items.find(item => item.label === 'Produtos').disabled, true);
  assert.equal(cadastros.columns[0].items.find(item => item.label === 'Clientes e fornecedores').to, '/cadastros-reais?cadastro=contacts');
  assert.equal(cadastros.columns.length, 1, 'Ferramentas has no enabled real item');
  const vendas = sales.find(group => group.name === 'Vendas');
  assert.equal(vendas.columns[0].items.find(item => item.label === 'Notas fiscais de saída').disabled, true);
  assert.equal(vendas.footer.to, '/documentos-empresa?tipo=sales_orders&acao=relatorios', 'Ver relatórios de vendas opens the sales reports');
  const finance = resolveMenu('real', { role: 'financeiro', resources: [] }).find(group => group.name === 'Financeiro');
  assert.equal(finance.columns[0].items.find(item => item.label === 'Contas a receber').to, '/financeiro-empresa?area=receivable');
  assert.equal(finance.footer.to, '/financeiro-empresa?area=relatorios');
});

test('location matching compares path and every query value of the target', () => {
  assert.equal(matchesLocation('/financeiro-empresa?area=payable', '/financeiro-empresa', '?area=payable&page=2'), true);
  assert.equal(matchesLocation('/financeiro-empresa?area=payable', '/financeiro-empresa', '?area=receivable'), false);
  assert.equal(matchesLocation('/estoque-empresa', '/estoque-empresa', ''), true);
  const menu = resolveMenu('real', { role: 'admin', resources: ['contacts', 'products'] });
  assert.equal(activeGroupFor(menu, '/documentos-empresa', '?tipo=purchase_orders').name, 'Estoque');
  assert.equal(activeGroupFor(menu, '/certificado-a1', ''), undefined);
});

test('preferences expose FAGOO-only pages by role, keeping every previous navigation entry reachable', () => {
  assert.deepEqual(resolvePreferences({}), []);
  const admin = resolvePreferences({ role: 'admin', capabilities: { originHistory: true } }).flatMap(category => category.entries.map(entry => entry.to));
  for (const to of ['/empresa-configuracoes', '/dados-origin', '/certificado-a1', '/conexao-sefaz', '/numeracao-fiscal', '/importar-cadastros', '/importar-orcamentos', '/conferir-compras-origin', '/conferir-vendas-origin', '/preparacao-virada', '/integracao-origin', '/historico-vendas-origin', '/emissor-fiscal?modelo=55', '/emissor-fiscal?modelo=65', '/xmls-sincronizados', '/cobranca-empresa', '/retornos-operacionais', '/relatorio-vencimentos', '/cobrancas-legadas-itau']) assert.ok(admin.includes(to), to);
  const sales = resolvePreferences({ role: 'vendas', capabilities: { originHistory: true } });
  // Origin categories in Origin order; a role sees a category only when it reads at least one of its pages or tools.
  assert.deepEqual(sales.map(category => category.id), ['empresa', 'sistema', 'cadastros', 'suprimentos', 'vendas', 'servicos', 'integracoes']);
  assert.equal(sales.some(category => category.entries.some(entry => ['/preferencias/notas-fiscais/nfe', '/preferencias/financas/contas-receber', '/estoque-abertura'].includes(entry.to))), false);
  assert.deepEqual(COMPANY_PREFERENCES.map(category => category.label), ['Empresa', 'Sistema', 'Cadastros', 'Suprimentos', 'Vendas', 'Notas Fiscais', 'Certificado Digital', 'Finanças', 'Serviços', 'Integrações', 'Contabilidade', 'Importações de Dados', 'Backup e Exportação de Dados']);
  assert.equal(COMPANY_PREFERENCES.every(category => category.sections.length > 0 && category.sections.every(section => section.entries.length > 0)), true);
  assert.equal(COMPANY_PREFERENCES.flatMap(category => category.sections.flatMap(section => section.entries)).every(entry => entry.to || entry.disabledReason), true);
});
