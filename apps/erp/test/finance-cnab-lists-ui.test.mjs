import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { cnabListApiPath, cnabListParams, cnabListRoute, remittancePath, occurrenceLabel } from '../src/lib/finance-cnab-lists-model.ts';
import { parseFinanceRoute } from '../../../workers/erp-api/src/finance.mjs';

// Synthetic data only. 213: Remessas e Retornos (CNAB) no padrão Origin, with bank operations off.
globalThis.document = { activeElement: null, addEventListener() {}, removeEventListener() {} };
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = '40000000-0000-4000-8000-000000000001', PROFILE = id(9);
const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);
const remittance = (n, extra = {}) => ({ id: id(n), profile_id: PROFILE, purpose: 'operational', state: 'ready', sequence: String(n), generated_on: `2026-03-0${n}`, created_at: '2026-03-01T12:00:00Z', filename: `ITAU_COBRANCA_000000${n}.REM`,
  bank: '341', bank_name: 'Itaú', file_hash: 'a'.repeat(64), byte_size: 1200, encoding_profile: 'itau109-no-charges-v1', excludable: false, titles: 2, total_cents: '35000', ...extra });
const returned = (n, extra = {}) => ({ id: id(50 + n), profile_id: PROFILE, purpose: 'operational', generated_on: `2026-03-1${n}`, created_at: '2026-03-12T12:00:00Z', filename: `RETORNO_${id(50 + n)}.RET`, bank: '341', bank_name: 'Itaú', excludable: n === 1, titles: 3, total_cents: '45000', ...extra });
function server({ post } = {}) {
  const calls = [], rows = [remittance(1), remittance(3, { state: 'reserved', file_hash: null, byte_size: null, excludable: true, titles: 1, total_cents: '5000' })];
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'financeiro' } }), subscribe: () => () => {},
    async finance(path, options = {}) {
      const call = { path, ...options, body: options.body ? structuredClone(options.body) : undefined }; calls.push(call);
      if (path === '/v1/financeiro') return { read: true, write: true, data_mode: 'erp_native' };
      if (options.method === 'POST') return post(call, rows);
      const url = new URL(path, 'https://synthetic.invalid');
      if (url.pathname === '/v1/financeiro/remessas') { const items = rows.filter(row => !url.searchParams.get('q') || row.filename.toLowerCase().includes(url.searchParams.get('q').toLowerCase())); return { entity: 'cnab_remittances', page: 1, limit: 50, total: items.length, items: structuredClone(items), data_mode: 'erp_native' }; }
      if (url.pathname === `/v1/financeiro/remessas/${id(1)}`) return { entity: 'cnab_remittance', record: remittance(1), account: { bank: '341', bank_name: 'Itaú', agency: '1500', account: '12345', account_digit: '6', wallet: '109', name: 'Itaú sintético' },
        titles: [{ billing_title_id: id(70), title_id: id(80), contact_name: 'Alfa Pagadora', our_number: '100001', document_number: '10', issued_on: '2026-03-01', due_on: '2026-03-10', description: 'Boleto sintético', amount_cents: '35000' }], titles_total: 1, total_cents: '35000', data_mode: 'erp_native' };
      if (url.pathname === '/v1/financeiro/retornos') return { entity: 'cnab_returns', page: 1, limit: 50, total: 2, items: [returned(1), returned(2)], data_mode: 'erp_native' };
      if (url.pathname === `/v1/financeiro/retornos/${id(51)}`) {
        const group = url.searchParams.get('grupo');
        const items = group === 'entradas' ? [{ line: 2, event_id: id(60), duplicate: false, kind: 'REGISTERED', occurrence: '02', document_number: '10', our_number: '100001', occurrence_date: '2026-03-03', credit_date: null, due_date: '2026-03-10', contact_name: 'Alfa Pagadora', fee_cents: '0', interest_cents: '0', amount_cents: '10000', paid_cents: '0' }]
          : [{ line: 3, event_id: id(61), duplicate: false, kind: 'PAID', occurrence: '06', document_number: '11', our_number: '100011', occurrence_date: '2026-03-15', credit_date: '2026-03-16', due_date: '2026-03-15', contact_name: 'Alfa Pagadora', fee_cents: '100', interest_cents: '250', amount_cents: '25000', paid_cents: '25150' }];
        return { entity: 'cnab_return', record: returned(1, { created_at: '2026-03-13T01:30:00Z' }), summary: { titles: 3, amount_cents: '45000', amount_with_additions_cents: '45250', entries: 1, entries_cents: '10000', settlements: 1, settlements_cents: '25150', others: 1, interest_cents: '250', discount_cents: '0', fee_cents: '100' },
          group: group === 'entradas' ? 'entries' : 'settlements', page: 1, limit: 100, total: 1, items, data_mode: 'erp_native' };
      }
      throw new Error(`Unexpected ${path}`);
    },
  };
  return { calls, controller, posts: () => calls.filter(call => call.method === 'POST'), rows };
}
const mount = (name, source, location) => mountComponent(name, { controller: source.controller }, { location, expandChildren: ['NativeListLayout', 'BatchDialog', 'Modal', 'TitlesTable', 'Summary', 'EventsTable', 'StockPrintPreview'] });

test('213 list routes are canonical, their API paths are accepted by the Worker and Acessar remessa opens the detail', async () => {
  const route = cnabListRoute('remessas', new URLSearchParams('area=remessas&q=ITAU&de=2026-03-01&ate=2026-03-31&page=2'));
  assert.deepEqual(route, { q: 'ITAU', from: '2026-03-01', to: '2026-03-31', page: 2, id: null, group: 'baixas' });
  assert.equal(cnabListParams('remessas', route).toString(), 'area=remessas&q=ITAU&de=2026-03-01&ate=2026-03-31&page=2');
  assert.deepEqual((await parseFinanceRoute(new Request(`https://api.example.test${cnabListApiPath('remessas', route)}`))).args, { p_query: 'ITAU', p_from: '2026-03-01', p_to: '2026-03-31', p_page: 2, p_limit: 50 });
  const detail = cnabListRoute('retornos', new URLSearchParams(`area=retornos&retorno=${id(51)}&grupo=entradas`));
  assert.deepEqual((await parseFinanceRoute(new Request(`https://api.example.test${cnabListApiPath('retornos', detail)}`))).args, { p_id: id(51), p_group: 'entries', p_page: 1, p_limit: 100 });
  assert.equal(remittancePath(id(1)), `/financeiro-empresa?area=remessas&remessa=${id(1)}`);
  for (const bad of ['area=remessas&grupo=baixas', 'area=remessas&remessa=x', 'area=retornos&de=2026-03-31&ate=2026-03-01', 'area=remessas&page=0', 'area=remessas&x=1']) assert.throws(() => cnabListRoute(bad.includes('retornos') ? 'retornos' : 'remessas', new URLSearchParams(bad)), /Confira/, bad);
  assert.deepEqual(['REGISTERED', 'PAID', 'CANCELLED', 'X'].map(occurrenceLabel), ['Entrada confirmada', 'Liquidação normal', 'Baixa simples', 'Ocorrência para conferência']);
});

test('213 Remessas: Origin columns, Quantidade de remessas, Pesquisar and the detail with the títulos, the account and print', async () => {
  const source = server(), view = await mount('FinanceRemittances.tsx', source, '/financeiro-empresa?area=remessas');
  try {
    for (const label of ['Data', 'Nome (arquivo)', 'Banco', 'Nº Remessa', 'Nro Títulos', 'Valor Títulos']) assert.ok(view.nodes().some(node => node.type === 'th' && text(node) === label), label);
    assert.match(view.text(), /ITAU_COBRANCA_0000001\.REM/); assert.match(view.text(), /Quantidade de remessas2/); assert.match(view.text(), /R\$ 350,00/); assert.match(view.text(), /Em preparação/);
    await view.change('remittance-search', 'COBRANCA_0000003'); await view.submit();
    assert.equal(view.location().search, '?area=remessas&q=COBRANCA_0000003');
    assert.ok(source.calls.some(call => call.path === '/v1/financeiro/remessas?page=1&limit=50&q=COBRANCA_0000003'));
    await view.navigate(`/financeiro-empresa?area=remessas&remessa=${id(1)}`);
    assert.match(view.text(), /Dados da Conta/); assert.match(view.text(), /341 - Itaú/); assert.match(view.text(), /12345-6/); assert.match(view.text(), /Alfa Pagadora/); assert.match(view.text(), /Valor total dos títulos/);
    await view.click('Imprimir lista de títulos da remessa'); assert.ok(view.nodes().some(node => typeof node.type === 'function' && node.type.name === 'StockPrintPreview') || /Títulos da remessa/.test(view.text()));
  } finally { view.unmount(); }
});

test('213 Excluir as remessas selecionadas skips the remessa with file and keeps the command of an unconfirmed answer', async () => {
  let attempts = 0;
  const source = server({ post: (call, rows) => { if (++attempts === 1) throw new AccessError(503); return { entity: 'cnab_remittance_exclusion', action: 'remittance_exclude', replayed: attempts > 2, record: { id: call.body.data.id, sequence: call.body.data.sequence, titles: 1, released_sequence: true }, data_mode: 'erp_native' }; } });
  const view = await mount('FinanceRemittances.tsx', source, '/financeiro-empresa?area=remessas');
  try {
    view.input('remittance-all').props.onChange({ target: { checked: true } }); await view.flush();
    await view.click('Excluir as remessas selecionadas');
    assert.match(view.text(), /Remessa com arquivo gerado não é excluída/);
    await view.click('Excluir'); await new Promise(resolve => setTimeout(resolve, 20)); await view.flush();
    const first = source.posts()[0];
    assert.deepEqual([first.path, first.body.data], ['/v1/financeiro/actions/remittance_exclude', { id: id(3), sequence: '3' }]);
    assert.equal(source.posts().length, 1, 'the remessa with file is never sent');
    await view.click('Fechar');
    view.input('remittance-all').props.onChange({ target: { checked: true } }); await view.flush();
    await view.click('Excluir as remessas selecionadas'); await view.click('Excluir'); await new Promise(resolve => setTimeout(resolve, 20)); await view.flush();
    assert.equal(source.posts()[1].body.command_id, first.body.command_id, 'the unconfirmed exclusion is checked with the same command');
  } finally { view.unmount(); }
});

test('213 Retornos: list, Resumo do processamento and the Entradas / Baixas groups, Excluir only without ocorrência aplicada', async () => {
  const source = server({ post: call => ({ entity: 'cnab_return_exclusion', action: 'return_exclude', replayed: false, record: { id: call.body.data.id, excluded: true }, data_mode: 'erp_native' }) });
  const view = await mount('FinanceReturns.tsx', source, '/financeiro-empresa?area=retornos');
  try {
    for (const label of ['Data', 'Nome (arquivo .RET)', 'Banco', 'Nro Títulos', 'Valor Títulos']) assert.ok(view.nodes().some(node => node.type === 'th' && text(node) === label), label);
    assert.match(view.text(), /Quantidade de retornos2/);
    view.input('return-all').props.onChange({ target: { checked: true } }); await view.flush();
    await view.click('Excluir selecionados'); assert.match(view.text(), /ocorrência aplicada/);
    await view.click('Excluir'); await new Promise(resolve => setTimeout(resolve, 20)); await view.flush();
    assert.deepEqual(source.posts().map(call => call.body.data.id), [id(51)]);
    await view.click('Fechar');
    await view.navigate(`/financeiro-empresa?area=retornos&retorno=${id(51)}`);
    assert.match(view.text(), /Data de importação12\/03\/2026/, 'the import day is the São Paulo one (22:30 of the 12th), not the UTC 13th'); assert.match(view.text(), /Total de títulos lidos3/); assert.match(view.text(), /Valor total das baixas/); assert.match(view.text(), /Liquidação normal \(06\)/); assert.match(view.text(), /R\$ 251,50|R\$ 250,00/);
    await view.click('Detalhe das entradas'); assert.match(view.location().search, /grupo=entradas/); assert.match(view.text(), /Entrada confirmada \(02\)/);
  } finally { view.unmount(); }
});
