import test from 'node:test';
import assert from 'node:assert/strict';
import { cancelEventXml, correctionEventXml, inutilizationXml, saoPauloMoment, CORRECTION_CONDITION } from '../../../packages/fiscal-xml/src/events.mjs';
import { mountComponent } from './helpers/component-recovery-harness.mjs';

// Unsigned homologation XML of the queued fiscal events (synthetic keys and CNPJ only). Production is refused by construction.
const KEY = '35261011222333000181550020000001231123456781', CNPJ = '11222333000181';
const at = new Date('2026-10-20T15:04:05Z');
// A tiny reader is enough here: the builders write flat elements with escaped text.
const read = xml => xml;
const text = (xml, name) => { const m = new RegExp(`<${name}(?: [^>]*)?>([^<]*)</${name}>`).exec(xml); return m && m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&'); };
const idOf = (xml, name) => new RegExp(`<${name} Id="([^"]+)"`).exec(xml)?.[1];

test('cancelamento and carta de correção follow envEvento 1.00 in homologation, with the São Paulo time and escaped texts', () => {
  assert.equal(saoPauloMoment(at), '2026-10-20T12:04:05-03:00');
  const cancel = read(cancelEventXml({ key: KEY, cnpj: CNPJ, protocol: '135260000000777', justification: 'Pedido cancelado pelo cliente & sem entrega', at, environment: '2' }));
  assert.equal(idOf(cancel, 'infEvento'), `ID110111${KEY}01`);
  assert.deepEqual(['cOrgao', 'tpAmb', 'CNPJ', 'chNFe', 'dhEvento', 'tpEvento', 'nSeqEvento', 'descEvento', 'nProt', 'xJust'].map(n => text(cancel, n)),
    ['35', '2', CNPJ, KEY, '2026-10-20T12:04:05-03:00', '110111', '1', 'Cancelamento', '135260000000777', 'Pedido cancelado pelo cliente & sem entrega']);
  const letter = read(correctionEventXml({ key: KEY, cnpj: CNPJ, text: 'Corrigir o endereço\nde entrega <bloco B>', sequence: 3, at, environment: '2' }));
  assert.equal(idOf(letter, 'infEvento'), `ID110110${KEY}03`);
  assert.equal(text(letter, 'xCorrecao'), 'Corrigir o endereço de entrega <bloco B>'); assert.equal(text(letter, 'xCondUso'), CORRECTION_CONDITION); assert.equal(text(letter, 'descEvento'), 'Carta de Correcao');
});

test('inutilização follows inutNFe 4.00 and every builder refuses production or invalid input', () => {
  const doc = read(inutilizationXml({ cnpj: CNPJ, model: '55', series: 2, from: 40, to: 45, justification: 'Faixa pulada por erro de digitação', year: '26', environment: '2' }));
  assert.equal(idOf(doc, 'infInut'), `ID3526${CNPJ}55002000000040000000045`);
  assert.deepEqual(['tpAmb', 'xServ', 'cUF', 'ano', 'mod', 'serie', 'nNFIni', 'nNFFin'].map(n => text(doc, n)), ['2', 'INUTILIZAR', '35', '26', '55', '2', '40', '45']);
  for (const build of [() => cancelEventXml({ key: KEY, cnpj: CNPJ, protocol: '135260000000777', justification: 'x'.repeat(20), environment: '1' }),
    () => correctionEventXml({ key: KEY, cnpj: CNPJ, text: 'x'.repeat(20), sequence: 1, environment: '1' }), () => inutilizationXml({ cnpj: CNPJ, model: '55', series: 1, from: 1, to: 1, justification: 'x'.repeat(20), year: '26', environment: '1' })])
    assert.throws(build, /EVENT_PRODUCTION_LOCKED/);
  assert.throws(() => cancelEventXml({ key: KEY, cnpj: CNPJ, protocol: '', justification: 'x'.repeat(20), environment: '2' }), /EVENT_PROTOCOL_REQUIRED/);
  assert.throws(() => correctionEventXml({ key: KEY, cnpj: CNPJ, text: 'curto', sequence: 1, environment: '2' }), /EVENT_TEXT_INVALID/);
  assert.throws(() => correctionEventXml({ key: KEY, cnpj: CNPJ, text: 'x'.repeat(20), sequence: 21, environment: '2' }), /EVENT_INPUT_INVALID/);
  assert.throws(() => inutilizationXml({ cnpj: CNPJ, model: '55', series: 1, from: 1, to: 10001, justification: 'x'.repeat(20), year: '26', environment: '2' }), /EVENT_INPUT_INVALID/);
});

test('Consulta de inutilizações › Gerar XML (suporte) shows the unsigned request with the company CNPJ, without enabled no-op controls', async () => {
  const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: id(1), role: 'fiscal' } }), subscribe: () => () => {},
    async fiscalInvoices() { return { items: [{ id: id(7), kind: 'inutilization', invoice_id: null, model: '55', environment: '2', series: 2, number_from: 40, number_to: 45, sequence: null, text: 'Faixa sintética pulada por teste', state: 'pending', protocol: null, requested_at: '2026-10-20T12:00:00Z', access_key: null }],
      kind: 'inutilization', page: 1, limit: 100, total_count: 1, transmission_enabled: false, data_mode: 'erp_native_homologation' }; },
    async company() { return { section: 'identity', data_mode: 'erp_native', emission_enabled: false, record: { version: 1, data: { legal_name: 'EMPRESA FICTICIA', cnpj: CNPJ, state: 'SP' } } }; },
  };
  const view = await mountComponent('FiscalEventList.tsx', { controller, kind: 'inutilization' }, { location: '/inutilizacoes-nfe' });
  try {
    assert.equal(view.nodes().some(n => n.type === 'input' && n.props['aria-label'] === 'Selecionar todos'), false, 'no select-all without selectable rows');
    const menu = view.nodes().find(n => typeof n.type === 'function' && n.type.name === 'RowMenu');
    menu.props.items.find(i => i.label === 'Gerar XML (suporte)').onClick(); await view.flush(); await view.flush();
    assert.match(view.text(), /XML de homologação, sem assinatura e não transmitido/);
    assert.match(view.text(), new RegExp(`ID3526${CNPJ}55002000000040000000045`));
  } finally { view.unmount(); }
});
