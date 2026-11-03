import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { nfeXml } from '../../../workers/erp-api/test/helpers/fiscal-import-xml.mjs';
import { competenceRange, previousCompetence, summaryCell } from '../src/lib/fiscal-accountant-package.ts';

// Espaço Meu Contador › Arquivos (wave E, PRF-021): the package of a competência with the checked XMLs of the notes and a resumo.csv.
// Synthetic controller only (no DOM, no network, synthetic data).
const textOf = value => Array.isArray(value) ? value.map(textOf).join('') : value && typeof value === 'object' ? textOf(value.props?.children) : value == null || typeof value === 'boolean' ? '' : String(value);
const settle = async view => { for (let i = 0; i < 8; i++) { await view.flush(); await new Promise(r => setTimeout(r, 5)); } };

test('competência: the previous month in São Paulo and the first and last day of a month', () => {
  assert.equal(previousCompetence(new Date('2026-01-15T12:00:00Z')), '2025-12');
  assert.equal(previousCompetence(new Date('2026-11-01T02:00:00Z')), '2026-09', 'still 31/10 in São Paulo');
  assert.deepEqual(competenceRange('2024-02'), { from: '2024-02-01', to: '2024-02-29' });
  assert.equal(competenceRange('2026-13'), null); assert.equal(competenceRange('1899-12'), null);
});

test('resumo.csv: a contact name that starts like a formula is kept as text and quotes are escaped', () => {
  assert.equal(summaryCell('=HYPERLINK("x")'), '"\x27=HYPERLINK(""x"")"');
  assert.equal(summaryCell(' @SOMA(A1)'), '"\x27 @SOMA(A1)"');
  assert.equal(summaryCell('Cliente; Ltda'), '"Cliente; Ltda"');
  assert.equal(summaryCell('25,00'), '"25,00"');
});

test('Arquivos para o contador: every list of the competência goes into one ZIP, with what had no XML named', async () => {
  const sale = nfeXml({ number: 801 }), consumer = nfeXml({ model: '65', number: 802, dest_block: false, crt: '1' }), imported = nfeXml({ number: 803, tpNF: '0' });
  const blob = xml => { const bytes = Buffer.from(xml, 'utf8'); return { bytes, hash: createHash('sha256').update(bytes).digest('hex') }; };
  const files = { a: blob(sale.xml), b: blob(consumer.xml) };
  const row = (over) => ({ origin: 'origin', id: '9801', version: null, number: 801, series: 1, issue_date: '2026-09-10', entry_date: null, name: 'Cliente', document: '11222333000181', state: 'SP', nature: 'Venda', status: 6, status_raw: '5',
    total: '25.00', total_known: true, environment: '1', issue_type: null, access_key: null, xml_id: null, xml_hash: null, xml_size: null, protocol_present: true, event_count: 0, orders: [], ...over });
  const lists = [];
  const pageOf = (q, items) => ({ items, origin: q.get('origin') ?? 'origin', model: q.get('model'), direction: q.get('direction') ?? '1', page: 1, limit: 100, order: 'date_desc', has_more: false, total_count: items.length, total_amount: '0.00', amount_unknown: 0,
    brufap_visible: true, show_totals: true, data_mode: q.get('origin') === 'brufap' ? 'erp_native_homologation' : 'origin_mirror_readonly' });
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: '60000000-0000-4000-8000-0000000000aa', role: 'fiscal' } }), subscribe: () => () => {},
    async fiscalInvoices(path) {
      if (path.startsWith('/v1/notas-fiscais?')) {
        const q = new URLSearchParams(path.split('?')[1]); lists.push(q.toString());
        if (q.get('origin') === 'brufap') return pageOf(q, q.get('direction') === '0' ? [row({ origin: 'brufap', id: '60000000-0000-4000-8000-000000000003', version: 1, number: 803, issue_type: 'X', environment: null, protocol_present: true, access_key: imported.key })] : []);
        if (q.get('model') === '65') return pageOf(q, [row({ id: '9802', number: 802, access_key: consumer.key, xml_id: '60000000-0000-4000-8000-000000000002', xml_hash: files.b.hash, xml_size: files.b.bytes.length })]);
        if (q.get('direction') === '0') return pageOf(q, []);
        return pageOf(q, [row({ access_key: sale.key, xml_id: '60000000-0000-4000-8000-000000000001', xml_hash: files.a.hash, xml_size: files.a.bytes.length }), row({ id: '9804', number: 804 })]);
      }
      if (path === '/v1/notas-fiscais/60000000-0000-4000-8000-000000000003/xml') { const b = blob(imported.xml); return { invoice_id: '60000000-0000-4000-8000-000000000003', access_key: imported.key, sha256: b.hash, size: b.bytes.length, xml: imported.xml }; }
      throw new AccessError(404);
    },
    async syncedXmlDownload(path) { return new Blob([path.includes('000000000001') ? files.a.bytes : files.b.bytes]); },
  };
  const saved = []; const previous = { document: globalThis.document, create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  globalThis.document = { activeElement: null, addEventListener() {}, removeEventListener() {}, createElement: () => ({ click() {}, remove() {} }), body: { appendChild() {} } };
  URL.createObjectURL = value => { saved.push(value); return 'blob:sintetico'; }; URL.revokeObjectURL = () => {};
  const view = await mountComponent('FiscalAccountantPackage.tsx', { controller, writable: true, onClose() {} }, { expandChildren: ['Modal'] });
  try {
    await view.change('fiscal-accountant-month', '2026-09');
    view.nodes().find(n => n.type === 'button' && textOf(n).trim() === 'Gerar pacote').props.onClick(); await settle(view);
    assert.ok(lists.some(q => q.includes('model=55') && q.includes('date_from=2026-09-01') && q.includes('date_to=2026-09-30')), 'the period of the competência');
    assert.ok(lists.some(q => q.includes('direction=0') && q.includes('date_type=entry')), 'entry notes by the date of entry');
    assert.equal(saved.length, 1);
    const zip = Buffer.from(await saved[0].arrayBuffer()).toString('latin1');
    for (const name of [`NFe-saida/NFe${sale.key}.xml`, `NFCe/NFe${consumer.key}.xml`, `NFe-entrada/NFe${imported.key}.xml`, 'resumo.csv']) assert.ok(zip.includes(name), name);
    assert.match(view.text(), /1 nota\(s\) sem XML no pacote/);
    assert.match(view.text(), /Pacote da competência 09\/2026 baixado: 3 XML\(s\) e o resumo\.csv\./);
  } finally { view.unmount(); globalThis.document = previous.document; URL.createObjectURL = previous.create; URL.revokeObjectURL = previous.revoke; }
});
