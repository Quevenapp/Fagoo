import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { parsePriceListSheet, sheetResultText, sheetTemplate } from '../src/lib/price-list-model.ts';

// Listas de preços, onda D (migração 192) na interface: Imprimir e Excluir lista no detalhe e a gaveta "Inserir produtos" com a
// planilha modelo. Dados sintéticos.
const downloads = [];
let previous;
test.before(() => {
  previous = globalThis.document;
  globalThis.document = { activeElement: null, getElementById: () => null, addEventListener() {}, removeEventListener() {}, body: { append() {}, classList: { add() {}, remove() {} } },
    createElement: () => ({ click() { downloads.push(this.download); }, remove() {} }) };
  globalThis.URL.createObjectURL ??= () => 'blob:synthetic'; globalThis.URL.revokeObjectURL ??= () => {};
});
test.after(() => { globalThis.document = previous; });
const actor = '97000000-0000-4000-8000-0000000000aa', stamp = '2026-10-20T12:00:00+00:00';
const ids = { list: '97000000-0000-4000-8000-0000000000f1' };
const header = extra => ({ id: ids.list, name: 'Especial', category: 'other', list_type: 'custom', factor: null, factor_unit: 'percent', direction: 'discount', considers_datetime: false, starts_on: null, ends_on: null, start_time: null, end_time: null,
  version: 4, created_at: stamp, updated_at: stamp, rule: 'Customizada', products: 2, contacts: [], sellers: [], payment_methods: [], regions: [], ...extra });
const item = n => ({ product_id: `97000000-0000-4000-8000-${String(1000 + n).padStart(12, '0')}`, name: `Produto ${n}`, code: `P${n}`, gtin: null, product_price: '10.0000', custom_price: null, list_price: '10.00' });
const textOf = value => Array.isArray(value) ? value.map(textOf).join('') : value && typeof value === 'object' ? textOf(value.props?.children) : value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);

test('planilha modelo model: template, separators, header, prices by list type, limits and the summary', () => {
  assert.equal(sheetTemplate(true), '﻿Código (SKU);Preço da lista\r\n');
  assert.equal(sheetTemplate(false), '﻿Código (SKU)\r\n');
  const custom = parsePriceListSheet('﻿Código (SKU);Preço da lista\r\nPAR-1;10,50\r\n"POR;1";\r\n\r\nARR;1.234,00\r\n;5\r\n', true);
  assert.deepEqual(custom.rows, [{ code: 'PAR-1', price: '10.50' }, { code: 'POR;1' }]);
  assert.deepEqual(custom.problems, ['Linha 4: preço inválido (use vírgula ou ponto, sem separador de milhares).', 'Linha 5: sem código.']);
  const rates = parsePriceListSheet('codigo,preco\nPAR-1,10\nPOR-1\n', false);
  assert.deepEqual([rates.rows, rates.blocking], [[{ code: 'PAR-1' }, { code: 'POR-1' }], false]);
  assert.match(rates.problems[0], /1 preço\(s\) ignorado\(s\)/);
  assert.equal(parsePriceListSheet('Código (SKU)\n', false).blocking, true);
  // Without a header, a first code that contains "SKU" or "codigo" is a product, not a header.
  assert.deepEqual(parsePriceListSheet('SKU-001\nCODIGO-7\n', false).rows, [{ code: 'SKU-001' }, { code: 'CODIGO-7' }]);
  assert.deepEqual(parsePriceListSheet('SKU;Preço\nA-1;2\n', true).rows, [{ code: 'A-1', price: '2' }]);
  assert.equal(parsePriceListSheet(Array.from({ length: 501 }, (_, i) => `C${i}`).join('\n'), false).blocking, true);
  assert.equal(sheetResultText({ added: 2, updated: 1, unchanged: 0, duplicates: 1, not_found: ['X'], not_found_total: 1, ambiguous: [], ambiguous_total: 0 }),
    'Planilha: 2 produto(s) incluído(s), 1 preço(s) atualizado(s), 1 linha(s) repetida(s). Códigos não encontrados (1): X.');
});

function server({ importAnswer, removeAnswer } = {}) {
  const calls = []; let version = 4;
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'admin' } }), subscribe: () => () => undefined,
    async catalog(path, options = {}) {
      calls.push({ path, method: options.method, body: options.body && structuredClone(options.body) });
      if (path === '/v1/cadastros') return { read: ['products'], write: ['products'], data_mode: 'erp_native' };
      if (path === '/v1/cadastros/listas-precos' && !options.method) return { items: [header({ version })], data_mode: 'erp_native' };
      if (path.startsWith(`/v1/cadastros/listas-precos/${ids.list}?`)) { const offset = Number(new URLSearchParams(path.split('?')[1]).get('offset') ?? 0); return { list: header({ version }), items: offset ? [] : [item(1), item(2)], total: 2, offset, limit: 100, data_mode: 'erp_native' }; }
      if (path === `/v1/cadastros/listas-precos/${ids.list}/importar`) { const answer = await importAnswer(options.body); version = answer.list.version; return answer; }
      if (path === `/v1/cadastros/listas-precos/${ids.list}/excluir`) return removeAnswer(options.body);
      throw new AccessError(404);
    },
  };
  return { calls, controller };
}
const file = text => ({ name: 'lista.csv', size: text.length, text: async () => text });
const open = async view => { view.find(node => node.type === 'button' && textOf(node.props.children) === 'Especial').props.onClick(); await view.flush(); };

test('price list detail: Imprimir lists every product with the summary; Excluir lista confirms, survives a lost answer with "Conferir resultado"', async () => {
  let attempt = 0;
  const service = server({ removeAnswer: async () => { attempt++; if (attempt === 1) throw new AccessError(503); return { deleted: true, id: ids.list, replayed: true, data_mode: 'erp_native' }; } });
  const view = await mountComponent('PriceLists.tsx', { controller: service.controller }, { location: '/listas-precos', expandChildren: ['PriceListEditor', 'PriceListPrint', 'PrintSheet', 'Modal', 'PriceListLinks'] });
  try {
    await open(view);
    view.find(node => node.type?.name === 'ToolButton' && node.props.title === 'Imprimir').props.onClick(); await view.flush(); await view.flush();
    assert.match(view.text(), /Especial · 2 registros/);
    assert.match(view.text(), /Tipo Lista: Lista customizada · Baseado em: Preço de venda · Fator a ser aplicado: Customizada/);
    assert.match(view.text(), /Produto 1.*P1.*R\$ 10,00/);
    await view.click('Fechar');
    view.find(node => node.type === 'button' && node.props['aria-label'] === 'Excluir lista').props.onClick(); await view.flush();
    assert.match(view.text(), /Excluir a lista “Especial” com 2 produto\(s\)\?/);
    view.nodes().filter(node => node.type === 'button' && textOf(node.props.children) === 'Excluir lista').at(-1).props.onClick(); await view.flush();
    assert.match(view.text(), /Não foi possível confirmar a exclusão/);
    const first = service.calls.filter(call => call.path.endsWith('/excluir')).at(-1).body;
    assert.deepEqual(Object.keys(first).sort(), ['command_id', 'expected_version']);
    await view.click('Conferir resultado');
    assert.equal(service.calls.filter(call => call.path.endsWith('/excluir')).at(-1).body.command_id, first.command_id, 'the same command');
    assert.match(view.text(), /Lista “Especial” excluída\./);
  } finally { view.unmount(); }
});

test('price list detail: Inserir produtos downloads the planilha modelo and links the sheet in one command, with the summary', async () => {
  let attempt = 0;
  const service = server({ importAnswer: async body => { attempt++; if (attempt === 1) throw new AccessError(503);
    return { saved: true, list: header({ version: 5, products: 3 }), added: 1, updated: 1, unchanged: 0, duplicates: 0, not_found: ['NADA'], not_found_total: 1, ambiguous: [], ambiguous_total: 0, replayed: attempt > 2, data_mode: 'erp_native', rows: body.rows }; } });
  const view = await mountComponent('PriceLists.tsx', { controller: service.controller }, { location: '/listas-precos', expandChildren: ['PriceListEditor', 'Modal', 'PriceListLinks'] });
  try {
    await open(view);
    await view.click('Inserir produtos');
    assert.match(view.text(), /Acesse a planilha modelo aqui e vincule seus produtos à uma lista de preço\./);
    await view.click('aqui');
    assert.deepEqual(downloads.at(-1), 'planilha-modelo-lista-customizada.csv');
    view.input('price-list-sheet').props.onChange({ target: { files: [file('Código (SKU);Preço da lista\nPAR-1;7,5\nPOR-1;\nNADA;1\n')] } }); await view.flush(); await view.flush();
    assert.match(view.text(), /lista\.csv: 3 linha\(s\) para vincular\./);
    await view.click('Vincular produtos da planilha');
    assert.match(view.text(), /Não foi possível confirmar o resultado/);
    const first = service.calls.filter(call => call.path.endsWith('/importar')).at(-1).body;
    assert.deepEqual([first.expected_version, first.rows], [4, [{ code: 'PAR-1', price: '7.5' }, { code: 'POR-1' }, { code: 'NADA', price: '1' }]]);
    await view.click('Conferir resultado');
    assert.equal(service.calls.filter(call => call.path.endsWith('/importar')).at(-1).body.command_id, first.command_id, 'the same command');
    assert.match(view.text(), /Planilha: 1 produto\(s\) incluído\(s\), 1 preço\(s\) atualizado\(s\)\. Códigos não encontrados \(1\): NADA\./);
    assert.doesNotMatch(view.text(), /Acesse a planilha modelo/, 'the drawer closes');
  } finally { view.unmount(); }
});
