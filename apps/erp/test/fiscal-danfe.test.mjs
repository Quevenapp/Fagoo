import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { nfeXml } from '../../../workers/erp-api/test/helpers/fiscal-import-xml.mjs';
import { DanfeError, brNumber, danfeData, danfePages, danfeSettings, formatKey, noteNumber, parseXml, validKey } from '../src/lib/danfe.ts';

// DANFE of the wave E (A4, Simplificado and NFC-e) from a synthetic authorized XML. No DOM, no network, synthetic data only.
const port = { appended: [] };
globalThis.document ??= {};
Object.assign(globalThis.document, { activeElement: null, getElementById: () => null, addEventListener: globalThis.document.addEventListener ?? (() => undefined), removeEventListener: globalThis.document.removeEventListener ?? (() => undefined),
  createElement: () => ({ className: '', remove() {}, append() {} }), body: { append: node => port.appended.push(node), appendChild() {}, classList: { add() {}, remove() {} } } });
const textOf = value => Array.isArray(value) ? value.map(textOf).join('') : value && typeof value === 'object' ? textOf(value.props?.children) : value == null || typeof value === 'boolean' ? '' : String(value);
const settle = async view => { for (let i = 0; i < 6; i++) { await view.flush(); await new Promise(r => setTimeout(r, 5)); } };

test('danfeData reads the fields the DANFE prints from an authorized nfeProc, exactly as written in the XML', () => {
  const { xml, key, total } = nfeXml({ items: [{ code: 'P-1', name: 'Peça & cia <sintética>', quantity: '2.0000', price: '12.3456789000', ean: '7891234567895', ipi: '1.23' }], freight: '5.00' });
  const d = danfeData(xml);
  assert.equal(d.key, key); assert.equal(d.model, '55'); assert.equal(d.environment, '1'); assert.equal(d.operation, '1'); assert.equal(d.number, '321'); assert.equal(d.series, '1');
  assert.equal(d.items[0].description, 'Peça & cia <sintética>', 'entities are decoded');
  assert.deepEqual([d.items[0].quantity, d.items[0].unit_price, d.items[0].cst, d.items[0].origin, d.items[0].ipi, d.items[0].info], ['2.0000', '12.3456789000', '00', '0', '1.23', 'Lote sintético 1']);
  assert.equal(d.totals.vNF, total); assert.equal(d.totals.vFrete, '5.00');
  assert.equal(d.protocol?.number, '135260000000777'); assert.equal(d.protocol?.received_at, '2026-10-18T09:31:05-03:00');
  assert.equal(d.transport.carrier?.name, 'Transportadora sintética'); assert.equal(d.transport.volumes[0].quantity, '2');
  assert.deepEqual(d.billing.duplicates, [{ number: '001', due: '2026-11-18', amount: total }]);
  assert.equal(d.payments[0].description, 'Boleto Bancário');
  assert.equal(d.additional.complementary, 'Pedido do cliente OC-9. Documento sintético.');
  assert.equal(d.issuer.name, 'Fornecedor sintético S.A.'); assert.equal(d.recipient?.document, '11222333000181');
});

test('danfeData refuses what is not an NF-e 4.00 with a valid key, and the XML reader refuses DTDs and broken trees', () => {
  const { xml, key } = nfeXml();
  assert.throws(() => danfeData(xml.replace(`NFe${key}`, `NFe${key.slice(0, 43)}${(Number(key[43]) + 1) % 10}`)), e => e instanceof DanfeError && e.code === 'DANFE_KEY_INVALID');
  assert.throws(() => danfeData(xml.replace('versao="4.00" Id=', 'versao="3.10" Id=')), e => e.code === 'DANFE_VERSION_UNSUPPORTED');
  assert.throws(() => danfeData(`<!DOCTYPE x [<!ENTITY a "b">]>${xml}`), e => e.code === 'XML_FORBIDDEN');
  assert.throws(() => parseXml('<a><b></a>'), e => e.code === 'XML_STRUCTURE_INVALID');
  assert.throws(() => parseXml('<a>&ent;</a>'), e => e.code === 'XML_ENTITY_INVALID');
  assert.throws(() => danfeData('<cteProc/>'), e => e.code === 'DANFE_DOCUMENT_UNSUPPORTED');
  assert.equal(parseXml('<a x="1 &gt; 0"><![CDATA[<b>]]></a>').text, '<b>');
  assert.equal(validKey(key), true);
  // A homologation XML and an NF-e without protocol are read (the DANFE marks them).
  assert.equal(danfeData(nfeXml({ tpAmb: '2' }).xml).environment, '2');
  assert.equal(danfeData(nfeXml({ withProtocol: false }).xml).protocol, null);
});

test('pagination follows "Nro de itens impressos na primeira página / nas demais páginas", or the printed lines when 0', () => {
  const items = Array.from({ length: 40 }, (_, i) => ({ position: i + 1, description: 'Item', info: null }));
  assert.deepEqual(danfePages(items, { firstPage: 5, otherPages: 10 }).map(p => p.length), [5, 10, 10, 10, 5]);
  const automatic = danfePages(items, { firstPage: 0, otherPages: 0 });
  assert.deepEqual(automatic.map(p => p.length), [30, 10]);
  assert.deepEqual(danfePages([], { firstPage: 0, otherPages: 0 }), [[]]);
  const long = Array.from({ length: 12 }, (_, i) => ({ position: i + 1, description: 'x'.repeat(100), info: 'y'.repeat(30) }));
  assert.equal(danfePages(long, { firstPage: 0, otherPages: 0 })[0].length, 7, 'a long description takes more lines (3 + 1 each)');
  assert.deepEqual(danfeSettings([{ key: 'nfe.itens_primeira_pagina', value: 12 }, { key: 'nfe.itens_demais_paginas', value: 30 }, { key: 'nfe.danfe_simplificado_produtos', value: true }, { key: 'nfe.danfe_simplificado_total', value: 'x' }]),
    { firstPage: 12, otherPages: 30, simplifiedProducts: true, simplifiedTotal: false });
  assert.deepEqual(danfeSettings(null), { firstPage: 0, otherPages: 0, simplifiedProducts: false, simplifiedTotal: false });
  assert.equal(brNumber('1234567.5', 2, 4), '1.234.567,50'); assert.equal(brNumber('12.3456789000', 2, 10), '12,3456789'); assert.equal(noteNumber('321'), '000.000.321');
  assert.equal(formatKey('1234'.repeat(11)), '1234 '.repeat(10) + '1234');
});

test('the A4 DANFE, the DANFE Simplificado and the NFC-e print the XML data with the marks of the note', async () => {
  const a4 = { data: danfeData(nfeXml({ tpAmb: '2', number: 9876 }).xml), status: null };
  const view = await mountComponent('FiscalDanfe.tsx', { title: 'Imprimir DANFE', layout: 'a4', documents: [a4], settings: { firstPage: 0, otherPages: 0, simplifiedProducts: false, simplifiedTotal: false }, onClose() {} },
    { expandChildren: ['DanfeA4', 'Header', 'Box', 'Barcode', 'ItemsTable'] });
  try {
    const text = view.text();
    for (const expected of ['DANFE', 'Documento Auxiliar da Nota Fiscal Eletrônica', 'Nº 000.009.876', 'SÉRIE 001', 'FOLHA 1/1', formatKey(a4.data.key), 'SEM VALOR FISCAL', 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGAÇÃO - SEM VALOR FISCAL',
      'Venda de mercadoria sintética', '135260000000777 - 18/10/2026 09:31:05', 'Comprador sintético Ltda', '11.222.333/0001-81', 'Parafuso sintético', 'Transportadora sintética', '0-Por conta do Emitente', 'RECEBEMOS DE FORNECEDOR SINTÉTICO S.A.'])
      assert.ok(text.includes(expected), expected);
    assert.ok(view.nodes().some(n => n.type === 'svg' && String(n.props['aria-label']).startsWith('Código de barras da chave')));
  } finally { view.unmount(); }
  const cancelled = { data: danfeData(nfeXml().xml), status: 'cancelled' };
  const simple = await mountComponent('FiscalDanfe.tsx', { title: 'DANFE Simplificado', layout: 'simple', documents: [cancelled], settings: { firstPage: 0, otherPages: 0, simplifiedProducts: true, simplifiedTotal: true }, onClose() {} },
    { expandChildren: ['DanfeSimplified', 'Box', 'Barcode'] });
  try {
    const text = simple.text();
    for (const expected of ['DANFE SIMPLIFICADO - ETIQUETA', 'CANCELADA', 'VALOR TOTAL DA NOTA', 'Parafuso sintético', 'Fornecedor sintético S.A.']) assert.ok(text.includes(expected), expected);
  } finally { simple.unmount(); }
  const { xml, key } = nfeXml({ model: '65', dest_block: false, crt: '1' });
  const qr = `https://www.homologacao.nfce.fazenda.sp.gov.br/qrcode?p=${key}|2|2|1|ABCDEF0123456789ABCDEF0123456789ABCDEF01`;
  const nfce = { data: danfeData(xml.replace('</NFe>', `<infNFeSupl><qrCode>${qr}</qrCode><urlChave>https://www.homologacao.nfce.fazenda.sp.gov.br/consulta</urlChave></infNFeSupl></NFe>`)), status: null };
  const roll = await mountComponent('FiscalDanfe.tsx', { title: 'DANFE NFC-e', layout: 'nfce', documents: [nfce], settings: { firstPage: 0, otherPages: 0, simplifiedProducts: false, simplifiedTotal: false }, onClose() {} },
    { expandChildren: ['DanfeNfce', 'QrCode'] });
  try {
    const text = roll.text();
    for (const expected of ['Documento Auxiliar da Nota Fiscal de Consumidor Eletrônica', 'CONSUMIDOR NÃO IDENTIFICADO', 'Valor a Pagar R$', 'FORMA PAGAMENTO', 'Boleto Bancário', 'Consulte pela Chave de Acesso em',
      'https://www.homologacao.nfce.fazenda.sp.gov.br/consulta', 'Protocolo de autorização: 135260000000777']) assert.ok(text.includes(expected), expected);
    assert.ok(roll.nodes().some(n => n.type === 'svg' && n.props['aria-label'] === 'QR Code da NFC-e'), 'the QR Code of the XML is drawn');
  } finally { roll.unmount(); }
});

test('Origin DANFE actions stay disabled even with collected XML, with no XML download or print preview', async () => {
  const { xml, key } = nfeXml({ number: 555 });
  const bytes = Buffer.from(xml, 'utf8'), hash = createHash('sha256').update(bytes).digest('hex');
  const row = (n, over = {}) => ({ origin: 'origin', id: String(9000 + n), version: null, number: 550 + n, series: 1, issue_date: '2026-10-18', entry_date: null, name: `Cliente ${n}`, document: '11222333000181', state: 'SP', nature: 'Venda',
    status: 6, status_raw: '5', total: '25.00', total_known: true, environment: '1', issue_type: null, access_key: null, xml_id: null, xml_hash: null, xml_size: null, protocol_present: true, event_count: 0, orders: [], ...over });
  const withXml = row(5, { access_key: key, xml_id: '40000000-0000-4000-8000-000000000005', xml_hash: hash, xml_size: bytes.length });
  const calls = [];
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: '40000000-0000-4000-8000-0000000000aa', role: 'consulta' } }), subscribe: () => () => {},
    async fiscalInvoices(path, options = {}) {
      calls.push(path);
      if (path.startsWith('/v1/notas-fiscais?')) return { items: [withXml, row(6)], origin: 'origin', model: '55', direction: '1', page: 1, limit: 100, order: 'date_desc', has_more: false, total_count: 2, total_amount: '50.00', amount_unknown: 0,
        brufap_visible: false, show_totals: true, data_mode: 'origin_mirror_readonly' };
      void options; throw new AccessError(404);
    },
    async syncedXmlDownload(path) { calls.push(path); return new Blob([bytes]); },
    async preferences(path) { calls.push(path); return { items: [{ key: 'nfe.itens_primeira_pagina', value: 5 }] }; },
    async listPreferences(path) { return { scope: 'list_preferences', data_mode: 'erp_native', list_id: path.split('/').at(-1), version: 0, columns: null, filters: null, updated_at: null }; },
    async catalog() { return { items: [], has_more: false }; },
  };
  const view = await mountComponent('RealFiscalInvoices.tsx', { controller, screen: 'nfe' }, { location: '/historico-fiscal?modelo=55', expandChildren: ['NativeListLayout'] });
  try {
    await settle(view);
    const menus = view.nodes().filter(n => typeof n.type === 'function' && n.type.name === 'RowMenu');
    const item = (menu, label) => menu.props.items.find(i => i.label === label);
    for (const menu of menus) for (const label of ['Imprimir DANFE', 'Imprimir DANFE Simplificado', 'Gerar PDF DANFE']) {
      const action = item(menu, label); assert.equal(action.disabled, true); assert.match(action.title, /reimpressão.*no Origin/); action.onClick(); await settle(view);
    }
    for (const label of ['Selecionar nota 000555', 'Selecionar nota 000556']) { view.nodes().find(n => n.type === 'input' && n.props['aria-label'] === label).props.onClick({ shiftKey: false }); await view.flush(); }
    await settle(view);
    const batch = view.nodes().find(n => n.type === 'button' && textOf(n).includes('Imprimir NF-es selecionadas'));
    assert.equal(batch.props.disabled, true); assert.match(batch.props.title, /reimpressão.*no Origin/); batch.props.onClick(); await settle(view);
    assert.equal(view.nodes().some(n => typeof n.type === 'function' && n.type.name === 'FiscalDanfePrint'), false);
    assert.equal(calls.some(path => path.startsWith('/v1/xmls-sincronizados/') || path === '/v1/preferencias/notas-nfe'), false);
  } finally { view.unmount(); }
});

test('Gerar PDF DANFE: a valid PDF 1.4 with one A4 page per folha, the XML values and the WinAnsi accents', async () => {
  const { danfePdf, danfePdfPages } = await import('../src/lib/danfe-pdf.ts');
  const { textWidth, wrapText } = await import('../src/lib/pdf-writer.ts');
  const items = Array.from({ length: 40 }, (_, i) => ({ code: `P-${i + 1}`, name: `Peça sintética ${i + 1}`, quantity: '1.0000', price: '2.5000', ean: '7891234567895' }));
  const doc = { data: danfeData(nfeXml({ tpAmb: '2', number: 4321, items }).xml), status: null };
  const pages = danfePdfPages(doc, { firstPage: 0, otherPages: 0 });
  assert.ok(pages.length >= 2, 'forty items need a second folha');
  assert.equal(danfePdfPages(doc, { firstPage: 10, otherPages: 15 }).length, 3, 'the item counts of the preferences: 10 + 15 + 15');
  const bytes = danfePdf([doc, { data: danfeData(nfeXml({ number: 4322 }).xml), status: 'cancelled' }], { firstPage: 0, otherPages: 0 });
  const text = Buffer.from(bytes).toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4\n')); assert.ok(text.trimEnd().endsWith('%%EOF'));
  // Every xref offset points at its object and startxref points at the table.
  const xref = Number(/startxref\n(\d+)\n%%EOF/.exec(text)[1]);
  assert.equal(text.slice(xref, xref + 4), 'xref');
  const entries = text.slice(xref).split('\n').slice(2).filter(line => / 00000 n $/.test(line)).map(line => Number(line.slice(0, 10)));
  entries.forEach((offset, index) => assert.ok(text.startsWith(`${index + 1} 0 obj`, offset), `object ${index + 1}`));
  assert.equal(Number(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/.exec(text)[1]), pages.length + 1);
  for (const expected of ['DANFE', 'SEM VALOR FISCAL', 'CANCELADA', '000.004.321', formatKey(doc.data.key), String.raw`Pe\347a sint\351tica 1`]) assert.ok(text.includes(expected), expected);
  // Metrics: Helvetica widths wrap the text.
  assert.equal(Math.round(textWidth('Aa', 10)), 12);
  assert.deepEqual(wrapText('um dois três', textWidth('um dois', 10), 10), ['um dois', 'três']);
});

test('the print preview of Gerar PDF DANFE downloads the PDF file', async () => {
  const saved = []; const previous = { create: URL.createObjectURL, revoke: URL.revokeObjectURL, createElement: globalThis.document.createElement };
  globalThis.document.createElement = () => ({ className: '', remove() {}, append() {}, click() {} });
  URL.createObjectURL = value => { saved.push(value); return 'blob:sintetico'; }; URL.revokeObjectURL = () => {};
  const doc = { data: danfeData(nfeXml({ number: 777 }).xml), status: null };
  const view = await mountComponent('FiscalDanfe.tsx', { title: 'Gerar PDF DANFE', layout: 'a4', documents: [doc], settings: { firstPage: 0, otherPages: 0, simplifiedProducts: false, simplifiedTotal: false }, pdf: true, onClose() {} });
  try {
    view.nodes().find(n => n.type === 'button' && textOf(n).trim() === 'Baixar PDF').props.onClick(); await view.flush();
    assert.equal(saved.length, 1); assert.equal(saved[0].type, 'application/pdf');
    assert.ok(Buffer.from(await saved[0].arrayBuffer()).toString('latin1').startsWith('%PDF-1.4'));
    assert.match(view.text(), /PDF gerado com 1 DANFE\(s\)\./);
  } finally { view.unmount(); URL.createObjectURL = previous.create; URL.revokeObjectURL = previous.revoke; globalThis.document.createElement = previous.createElement; }
});

test('Origin NF-e and NFC-e DANFE stay disabled; XML export of NFC-e remains available', async () => {
  const { SCREENS, rowActions } = await import('../src/lib/fiscal-invoice-list-model.ts');
  const row = { origin: 'origin', id: '9001', version: null, number: 7, series: 1, issue_date: '2026-10-20', entry_date: null, name: 'Cliente sintético', document: null, state: 'SP', nature: null, status: 6, status_raw: '5',
    total: '10.00', total_known: true, environment: '1', issue_type: null, access_key: null, xml_id: '40000000-0000-4000-8000-000000000001', xml_hash: 'a'.repeat(64), xml_size: 100, protocol_present: true, event_count: 0, orders: [] };
  const nfce = rowActions(SCREENS.nfce, row, { writable: true }), nfe = rowActions(SCREENS.nfe, row, { writable: true });
  assert.equal(nfce.some(a => a.id === 'pdf'), false);
  assert.equal(nfce.find(a => a.id === 'danfe')?.enabled, false);
  assert.equal(nfe.find(a => a.id === 'pdf')?.enabled, false);
  assert.equal(nfce.find(a => a.id === 'xml')?.enabled, true);
});
