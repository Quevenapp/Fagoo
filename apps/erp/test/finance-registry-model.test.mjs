import test from 'node:test';
import assert from 'node:assert/strict';
import { accountsApiPath, accountsParams, accountsRoute, accountPage, categoryImportRows, categorySheet, categoryTree, treeRows, toggleTreeSelection, categoryPathName, descendants } from '../src/lib/finance-registry-model.ts';
import { parseCsv, readSheet, readXlsx, sheetRecords } from '../src/lib/finance-sheet-import.ts';
import { searchInstitutions } from '../src/lib/bank-institutions.ts';
import { textCell, toXlsx, zipStore } from '../src/lib/spreadsheet-export.ts';
import { parseFinanceRoute } from '../../../workers/erp-api/src/finance.mjs';
import { categoryTreeResponse } from './helpers/finance-category-tree-fixture.mjs';

// Synthetic data only. 135: routes, response checks, the category tree and the spreadsheets of the importers.
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const account = (n, extra = {}) => ({ id: id(n), name: `Conta ${n}`, kind: 'bank', account_type: 'checking', institution_code: '341', institution_name: 'Itaú Unibanco', agency: '1', account_number: '2', account_digit: '3', start_on: '2026-01-01', active: true,
  default_movements: false, default_boleto: false, boleto: 'none', opening_recorded: true, opening_cents: '0', balance_cents: '0', first_movement_on: '2026-01-01', in_use: true, cnab: null, version: 1, created_at: 'x', updated_at: 'x', ...extra });

test('135 Contas Financeiras URL: Situação Ativo by default, Tipo de Conta list and the API path accepted by the Worker', async () => {
  const route = accountsRoute(new URLSearchParams(''));
  assert.deepEqual(route, { q: '', situacao: 'ativo', tipos: [], page: 1 });
  assert.equal(accountsParams(route).toString(), 'area=contas-financeiras');
  const filtered = accountsRoute(new URLSearchParams('area=contas-financeiras&situacao=todos&tipos=cash,savings&pagina=2&q=itau'));
  assert.equal(accountsApiPath(filtered), '/v1/financeiro/contas-financeiras?page=2&limit=100&q=itau&tipos=cash%2Csavings');
  assert.deepEqual(accountsRoute(accountsParams(filtered)), filtered);
  const parsed = await parseFinanceRoute(new Request(`https://api.example.test${accountsApiPath(filtered)}`));
  assert.deepEqual(parsed.args, { p_page: 2, p_limit: 100, p_query: 'itau', p_active: null, p_types: ['cash', 'savings'] });
  for (const bad of ['situacao=ativos', 'tipos=bank', 'tipos=cash,cash', 'pagina=0', `q=${'x'.repeat(121)}`]) assert.throws(() => accountsRoute(new URLSearchParams(bad)), /inválidos/, bad);
  const page = accountPage({ entity: 'financial_accounts', page: 1, limit: 100, total: 1, items: [account(1)], data_mode: 'erp_native' }, route);
  assert.equal(page.items[0].name, 'Conta 1');
  assert.throws(() => accountPage({ entity: 'financial_accounts', page: 1, limit: 100, total: 1, items: [account(1, { active: false })] }, route), /conferir/);
  assert.throws(() => accountPage({ entity: 'financial_accounts', page: 1, limit: 100, total: 1, items: [account(1, { boleto: 'x' })] }, route), /conferir/);
  assert.deepEqual(searchInstitutions('itau').map(item => item.code), ['341']);
  assert.deepEqual(searchInstitutions('077').map(item => item.name), ['Banco Inter']);
});

test('135 category tree: alphabetical rows, expansion, search with ancestors, Situação Ativo and parent selection with descendants', () => {
  const tree = categoryTree(categoryTreeResponse('payable', [
    { id: id(1), name: 'Despesas administrativas' }, { id: id(2), name: 'Aluguel', parent_id: id(1) }, { id: id(3), name: 'Escritório', parent_id: id(2), depth: 3 },
    { id: id(4), name: 'Compras', active: false }, { id: id(5), name: 'Água', parent_id: id(1) }]), 'payable');
  assert.deepEqual(treeRows(tree.items, { expanded: new Set() }).map(row => row.node.name), ['Compras', 'Despesas administrativas']);
  assert.deepEqual(treeRows(tree.items, { expanded: new Set([id(1), id(2)]) }).map(row => [row.node.name, row.level]), [['Compras', 1], ['Despesas administrativas', 1], ['Água', 2], ['Aluguel', 2], ['Escritório', 3]]);
  assert.deepEqual(treeRows(tree.items, { expanded: new Set(), query: 'escrit' }).map(row => row.node.name), ['Despesas administrativas', 'Aluguel', 'Escritório'], 'a match shows its ancestors');
  assert.deepEqual(treeRows(tree.items, { expanded: new Set(), onlyActive: true }).map(row => row.node.name), ['Despesas administrativas']);
  assert.deepEqual(toggleTreeSelection(tree.items, ['none'], id(1), true).sort(), ['none', id(1), id(2), id(3), id(5)].sort());
  assert.deepEqual(toggleTreeSelection(tree.items, [id(1), id(2), id(3), id(5)], id(2), false).sort(), [id(1), id(5)].sort());
  assert.equal(categoryPathName(tree.items, id(3)), 'Despesas administrativas > Aluguel > Escritório');
  assert.deepEqual(descendants(tree.items, id(1)).sort(), [id(2), id(3), id(5)].sort());
  assert.throws(() => categoryTree(categoryTreeResponse('receivable', [{ id: id(9), name: 'Neta', parent_id: id(8), depth: 2 }]), 'receivable'), /conferir/, 'orphans are refused');
  assert.throws(() => categoryTree({ ...categoryTreeResponse('receivable', []), kind: 'payable' }, 'receivable'), /conferir/);
  // The export follows the template: Nome da categoria | Categoria pai | Grupo de DRE, parents first.
  assert.deepEqual(categorySheet(tree.items, 'payable').map(row => row.join('|')), ['Nome da categoria|Categoria pai|Grupo de DRE', 'Compras||', 'Despesas administrativas||', 'Água|Despesas administrativas|', 'Aluguel|Despesas administrativas|', 'Escritório|Aluguel|']);
});

test('135 category import: parents first, DRE only on main categories, depth of the tab and duplicates that SQL skips', () => {
  const existing = categoryTree(categoryTreeResponse('receivable', [{ id: id(1), name: 'Vendas' }]), 'receivable').items;
  const records = sheetRecords(parseCsv('﻿Nome da categoria;Categoria pai;Grupo de DRE\r\nVendas;;\r\nProdutos;Vendas;\r\nServiços;;Receita Operacional Bruta\r\nNeta;Produtos;\r\nX;Inexistente;\r\nY;;Despesas Operacionais\r\n;;\r\n'), ['Nome da categoria', 'Categoria pai', 'Grupo de DRE']);
  const result = categoryImportRows(records, 'receivable', existing);
  assert.deepEqual(result.rows.map(row => [row.line, row.name, row.parent, row.dre_group]), [[2, 'Vendas', null, null], [3, 'Produtos', 'Vendas', null], [4, 'Serviços', null, 'gross_revenue']]);
  assert.deepEqual(result.errors, ['Linha 5: Receitas aceitam até 2 níveis.', 'Linha 6: a categoria pai "Inexistente" não existe nesta aba nem nas linhas anteriores.', 'Linha 7: grupo de DRE "Despesas Operacionais" não existe em Receitas.']);
});

test('135 spreadsheets: CSV with quotes and both separators; XLSX stored and deflated, shared and inline strings', async () => {
  assert.deepEqual(parseCsv('a,"b, c",d\n"e ""f""",g,\n'), [['a', 'b, c', 'd'], ['e "f"', 'g', '']]);
  assert.throws(() => parseCsv('a;"b'), /aspas/);
  const stored = toXlsx('Categorias', [['Nome da categoria', 'Categoria pai'].map(textCell), ['Vendas & cia', ''].map(textCell), ['Produtos', 'Vendas & cia'].map(textCell)]);
  assert.deepEqual(await readXlsx(stored), [['Nome da categoria', 'Categoria pai'], ['Vendas & cia', ''], ['Produtos', 'Vendas & cia']]);
  // A deflated workbook with shared strings, as saved by spreadsheet programs.
  const { deflateRawSync } = await import('node:zlib');
  const sheet = '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>12.5</v></c></row></sheetData></worksheet>';
  const shared = '<sst><si><t>Nome da categoria</t></si><si><r><t>Grupo de </t></r><r><t>DRE</t></r></si><si><t xml:space="preserve">Água &amp; luz</t></si></sst>';
  const entries = [['xl/worksheets/sheet1.xml', sheet], ['xl/sharedStrings.xml', shared]].map(([name, text]) => ({ name, raw: new TextEncoder().encode(text) }));
  const deflated = deflatedZip(entries.map(entry => ({ name: entry.name, data: new Uint8Array(deflateRawSync(entry.raw)), size: entry.raw.length })));
  assert.deepEqual(await readXlsx(deflated), [['Nome da categoria', '', 'Grupo de DRE'], ['Água & luz', '12.5']]);
  await assert.rejects(() => readSheet('x.pdf', new Uint8Array([1])), /\.xlsx ou \.csv/);
  await assert.rejects(() => readSheet('x.xlsx', new Uint8Array(3 * 1024 * 1024)), /2 MB/);
  await assert.rejects(() => readSheet('x.xlsx', new Uint8Array([1, 2, 3])), /válida/);
  assert.ok(zipStore);
});

// Minimal ZIP writer with method 8 (deflate) for the reader test.
function deflatedZip(files) {
  const enc = new TextEncoder(), parts = [], central = []; let offset = 0;
  const u16 = n => [n & 255, (n >> 8) & 255], u32 = n => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
  for (const file of files) {
    const name = enc.encode(file.name);
    const local = Uint8Array.from([...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(8), ...u16(0), ...u16(0), ...u32(0), ...u32(file.data.length), ...u32(file.size), ...u16(name.length), ...u16(0)]);
    parts.push(local, name, file.data);
    central.push(Uint8Array.from([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(8), ...u16(0), ...u16(0), ...u32(0), ...u32(file.data.length), ...u32(file.size), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset)]), name);
    offset += local.length + name.length + file.data.length;
  }
  const size = central.reduce((sum, part) => sum + part.length, 0);
  const end = Uint8Array.from([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(size), ...u32(offset), ...u16(0)]);
  const all = [...parts, ...central, end], out = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0)); let at = 0;
  for (const part of all) { out.set(part, at); at += part.length; }
  return out;
}

test('135 category import: a subcategoria under an inactive parent is refused before SQL, as in Nova categoria', () => {
  const existing = categoryTree(categoryTreeResponse('payable', [{ id: id(1), name: 'Despesas antigas', active: false }, { id: id(2), name: 'Despesas atuais' }]), 'payable').items;
  const records = sheetRecords(parseCsv('Nome da categoria;Categoria pai;Grupo de DRE\r\nLuz;Despesas antigas;\r\nÁgua;Despesas atuais;\r\n'), ['Nome da categoria', 'Categoria pai', 'Grupo de DRE']);
  const result = categoryImportRows(records, 'payable', existing);
  assert.deepEqual(result.rows.map(row => row.name), ['Água']);
  assert.deepEqual(result.errors, ['Linha 2: a categoria pai "Despesas antigas" está inativa; ative-a antes de importar.']);
  // Names written by the old cadastro (up to 200 characters) are still read.
  assert.equal(categoryTree(categoryTreeResponse('payable', [{ id: id(3), name: 'x'.repeat(180) }]), 'payable').items[0].name.length, 180);
});
