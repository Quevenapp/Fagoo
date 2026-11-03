import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { CNAB_ENCODINGS as E } from '../src/lib/cnab-operational-v2-model.ts';
import { fixture, clone, actor, entry, profile, title, zeroTitle } from './helpers/cnab-operational-v2-fixtures.mjs';
import { operationalTitleRecord } from '../src/lib/cnab-operational-model.ts';

// Synthetic data only. FIN-054: "Gerar remessa" of Contas a receber opens Incluir Remessa with the contas chosen there.
const text = v => Array.isArray(v) ? v.map(text).join('') : v && typeof v === 'object' ? text(v.props?.children) : v === null || v === undefined || typeof v === 'boolean' ? '' : String(v);
const input = (view, label) => view.input(view.find(n => n.type === 'label' && text(n) === label).props.htmlFor);
const cb = (view, label) => view.find(n => n.type === 'input' && n.props.type === 'checkbox' && n.props['aria-label'] === label);
const late = { ...title, id: '30000000-0000-4000-8000-000000000009', description: 'TITULO VENCIDO', due_on: '2000-01-01', issued_on: '2000-01-01' };
// Em aberto also lists contas with a partial baixa: they are read, then left out as not eligible for a boleto.
const partial = { ...title, id: '30000000-0000-4000-8000-000000000008', description: 'TITULO PARCIAL', settled_cents: '1570' };
function withTitles(s) {
  const list = s.controller.finance;
  s.controller.finance = async (path, options) => { const match = /^\/v1\/financeiro\/titles\/([0-9a-f-]{36})$/.exec(path); if (!match) return list(path, options); const record = [title, zeroTitle, late, partial].find(item => item.id === match[1]); return { entity: 'titles', data_mode: 'erp_native', record: clone(record) }; };
  return s;
}

test('FIN-054 the conta record of Incluir Remessa is bound to the conta asked for', () => {
  assert.equal(operationalTitleRecord({ entity: 'titles', data_mode: 'erp_native', record: title }, title.id).description, 'TITULO FICTICIO');
  assert.throws(() => operationalTitleRecord({ entity: 'titles', data_mode: 'erp_native', record: title }, zeroTitle.id));
  assert.throws(() => operationalTitleRecord({ entity: 'titles', data_mode: 'erp_native', record: { ...title, kind: 'payable' } }, title.id));
  assert.equal(operationalTitleRecord({ entity: 'titles', data_mode: 'erp_native', record: partial }, partial.id).settled_cents, '1570');
  for (const settled of ['01', '1d', '9999']) assert.throws(() => operationalTitleRecord({ entity: 'titles', data_mode: 'erp_native', record: { ...title, settled_cents: settled } }, title.id), undefined, settled);
});

test('FIN-054 the contas chosen in Contas a receber join the selection once the conta and the formato are chosen; ineligible ones stay out', async () => {
  const s = withTitles(fixture({ ErrorType: AccessError }));
  const view = await mountComponent('CnabOperationalV2.tsx', { controller: s.controller, actor, profiles: clone(s.state.profiles), onClose: () => {}, initialTitleIds: [title.id, late.id, partial.id] }, { componentName: 'V2RemittanceEditor', expandChildren: true });
  try {
    assert.match(view.text(), /3 conta\(s\) selecionada\(s\) em Contas a receber\. Escolha a conta e o formato/);
    await view.change(input(view, 'Conta para cobrança *').props.id, profile.id); await view.change(input(view, 'Formato da remessa *').props.id, E[1]);
    for (let i = 0; i < 3; i++) { await new Promise(resolve => setTimeout(resolve, 5)); await view.flush(); }
    assert.equal(cb(view, 'Selecionar ' + title.description).props.checked, true);
    assert.match(view.text(), /1 de 3 conta\(s\) de Contas a receber incluída\(s\)/);
    assert.ok(view.nodes().some(n => n.type === 'label' && text(n) === 'Documento · TITULO FICTICIO *'), 'the documento of the included conta is asked');
    assert.equal(s.calls.filter(call => ['approval', 'generate', 'resume'].includes(call.op)).length, 0, 'nothing is reserved without the usual confirmation');
  } finally { view.unmount(); }
});

test('FIN-054 ?titulos= opens Incluir Remessa for a profile that may generate; without permission it stays on the list', async () => {
  const s = withTitles(fixture({ ErrorType: AccessError }));
  const view = await mountComponent('CnabOperationalV2.tsx', { controller: s.controller }, { location: `/cobranca-operacional?titulos=${title.id}`, expandChildren: true });
  try { for (let i = 0; i < 3; i++) { await new Promise(resolve => setTimeout(resolve, 5)); await view.flush(); } assert.match(view.text(), /Nova remessa Itaú/); assert.match(view.text(), /1 conta\(s\) selecionada\(s\)/); }
  finally { view.unmount(); }
  // Without a conta de cobrança enabled for remessas the editor stays closed and the screen says why.
  const blocked = withTitles(fixture({ ErrorType: AccessError, profiles: [{ ...entry, approval: { ...entry.approval, effective_enabled: false, issues: ['BANK_ACCOUNT_INACTIVE'] } }] }));
  const waiting = await mountComponent('CnabOperationalV2.tsx', { controller: blocked.controller }, { location: `/cobranca-operacional?titulos=${title.id}`, expandChildren: true });
  try { for (let i = 0; i < 3; i++) { await new Promise(resolve => setTimeout(resolve, 5)); await waiting.flush(); } assert.doesNotMatch(waiting.text(), /Nova remessa Itaú/); assert.match(waiting.text(), /1 conta\(s\) selecionada\(s\) em Contas a receber\. Nenhuma conta de cobrança está habilitada/); }
  finally { waiting.unmount(); }
  const reader = withTitles(fixture({ ErrorType: AccessError, role: 'consulta' }));
  const list = await mountComponent('CnabOperationalV2.tsx', { controller: reader.controller }, { location: `/cobranca-operacional?titulos=${title.id}`, expandChildren: true });
  try { for (let i = 0; i < 3; i++) { await new Promise(resolve => setTimeout(resolve, 5)); await list.flush(); } assert.doesNotMatch(list.text(), /Nova remessa Itaú/); }
  finally { list.unmount(); }
});
