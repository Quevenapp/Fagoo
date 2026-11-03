import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { normalizeDocument } from '../../../packages/erp-domain/src/index.mjs';
import { defaultDocumentPreferences } from '../src/lib/document-preferences.ts';
import { documentPrintModel } from '../src/lib/document-print-model.ts';

// 202610200270 (synthetic controller, no DOM): Outros itens ou serviços and Condições comerciais (Nenhum | Parcela | Texto) of the
// proposta, the Cabeçalho personalizado screen and the print with the texto rico.
const actor = 'a0000000-0000-4000-8000-000000000270', docId = 'b0000000-0000-4000-8000-000000000270', contact = 'c0000000-0000-4000-8000-000000000270';
const run = (text, extra = {}) => ({ text, bold: false, italic: false, underline: false, color: null, background: null, size: null, ...extra });
const rich = (...blocks) => ({ version: 1, blocks: blocks.map(runs => ({ align: 'left', indent: 0, code: false, runs })) });
const node = (view, name, predicate = () => true) => view.nodes().find(n => typeof n.type === 'function' && n.type.name === name && predicate(n.props));
const body = (extra = {}) => ({ date: '2026-10-20', contact_id: contact, items: [{ id: 'e0000000-0000-4000-8000-000000000001', product_id: null, description: 'Item sintético', code: null, unit: 'UN', quantity: '1', unit_price: '10', detailed_description: null }], ...extra });
function record(data = body(), extra = {}) {
  const normalized = normalizeDocument('sales_proposals', data);
  return { ...normalized, id: docId, kind: 'sales_proposals', number: '270', version: 1, status: 'open', created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z', source_proposal_id: null,
    contact_snapshot: { id: contact, version: 1, name: 'Cliente sintético' }, effect_flags: { finance_active: false, stock_active: false }, items: normalized.items.map(item => ({ ...item, product_snapshot: null })), ...extra };
}
function setup() {
  const posts = [];
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { role: 'vendas', user_id: actor } }),
    async catalog(path) { if (path === '/v1/cadastros') return { read: ['contacts', 'products'], write: [], data_mode: 'erp_native' }; if (path.startsWith('/v1/cadastros/contacts/')) return { entity: 'contacts', record: { id: contact, name: 'Cliente sintético', active: true } }; return { items: [], has_more: false }; },
    async documents(path, options = {}) {
      if (path.endsWith('/proximo-numero')) return { kind: 'sales_proposals', next_number: '270', reserved: false, data_mode: 'erp_native', operational_effects: false };
      if (options.method) posts.push(structuredClone(options.body));
      const { number, ...data } = posts.at(-1)?.data ?? body();
      return { kind: 'sales_proposals', document: record(data, { version: 2 }), data_mode: 'erp_native', operational_effects: false };
    },
    async stockPositions() { return { items: [] }; }, async documentCopy() { throw new AccessError(404); },
  };
  return { controller, posts };
}
const mount = (s, current = record()) => mountComponent('RealDocuments.tsx', { controller: s.controller, kind: 'sales_proposals', record: current, writable: true, onSaved() {}, onClose() {}, onConverted() {}, preferences: { ...defaultDocumentPreferences('sales_proposals'), loaded: true } },
  { componentName: 'Editor', location: '/documentos-empresa', expandChildren: ['DocumentCommercialFields', 'DocumentOptionalSection'] });

test('proposta: Outros itens ou serviços with Total outros itens in the total; Condições comerciais Texto clears the parcelas; the save sends both', async () => {
  const s = setup(), current = record(body({ installments: [{ due_date: '2026-11-20', amount: '10.00', method: null }] }));
  const view = await mount(s, current);
  try {
    assert.match(view.text(), /Outros itens ou serviços/); assert.match(view.text(), /Produtos e serviços eventuais ou não cadastrados/);
    const editor = node(view, 'RichTextEditor', props => props.id === 'doc-other-items');
    editor.props.onChange(rich([run('Instalação', { bold: true })])); await view.flush();
    await view.change('doc-other-items-total', '25,50');
    assert.match(view.text(), /Total outros itensR\$ 25,50/); assert.match(view.text(), /Total da propostaR\$ 35,50/);
    // Tabs: Parcela (the proposta saved before 270), Texto clears the parcelas and shows the editor.
    const tab = label => view.nodes().find(n => n.type === 'button' && n.props.role === 'tab' && n.props.children === label);
    assert.equal(tab('Parcela').props['aria-selected'], true);
    tab('Texto').props.onClick(); await view.flush();
    assert.equal(tab('Texto').props['aria-selected'], true);
    const conditions = node(view, 'RichTextEditor', props => props.id === 'doc-conditions-text');
    assert.ok(conditions); conditions.props.onChange(rich([run('50% na aprovação')])); await view.flush();
    assert.equal(view.nodes().some(n => n.props?.id === 'doc-payment'), false, 'no Condição de pagamento in the Texto tab');
    await view.submit();
    assert.equal(s.posts.length, 1);
    const data = s.posts[0].data;
    assert.deepEqual(data.other_items, { content: rich([run('Instalação', { bold: true })]), total: '25.50' });
    assert.deepEqual(data.commercial_conditions, { mode: 'text', text: rich([run('50% na aprovação')]) });
    assert.deepEqual(data.installments, []);
    assert.equal(normalizeDocument('sales_proposals', data).totals.total, '35.50');
  } finally { view.unmount(); }
});

test('Nenhum: no parcelas and no Condição; clearing the outros itens sends null', async () => {
  const s = setup(), view = await mount(s, record(body({ other_items: { content: rich([run('Frete especial')]), total: '5.00' }, commercial_conditions: { mode: 'installments', text: null } })));
  try {
    view.nodes().find(n => n.type === 'button' && n.props.role === 'tab' && n.props.children === 'Nenhum').props.onClick(); await view.flush();
    assert.match(view.text(), /Sem condições comerciais nesta proposta\./);
    node(view, 'RichTextEditor', props => props.id === 'doc-other-items').props.onChange(rich([])); await view.flush();
    await view.change('doc-other-items-total', '0');
    await view.submit();
    assert.deepEqual([s.posts[0].data.other_items, s.posts[0].data.commercial_conditions.mode], [null, 'none']);
  } finally { view.unmount(); }
});

test('Cabeçalho personalizado: the administrador saves with the version read and Conferir resultado; other profiles only see it', async () => {
  const calls = [], header = rich([run('FAGOO Indústria', { bold: true, size: 16 })]);
  let fail = 1;
  const controller = role => ({ getSnapshot: () => ({ phase: 'ready', membership: { role, user_id: actor } }),
    async documents(path, options = {}) {
      calls.push({ path, method: options.method ?? 'GET', body: options.body });
      if (path !== '/v1/documentos/sales_orders/cabecalho') throw new AccessError(404);
      if (options.method === 'POST') { if (fail-- > 0) throw new AccessError(503); return { kind: 'sales_orders', content: options.body.content, version: 1, updated_at: '2026-10-21T12:00:00Z', can_manage: true, replayed: false, data_mode: 'erp_native', operational_effects: false }; }
      return { kind: 'sales_orders', content: null, version: 0, updated_at: null, can_manage: role === 'admin', data_mode: 'erp_native', operational_effects: false };
    } });
  const settle = async view => { for (let i = 0; i < 3; i++) { await new Promise(resolve => setTimeout(resolve, 5)); await view.flush(); } };
  const view = await mountComponent('DocumentPrintHeader.tsx', { controller: controller('admin'), kind: 'sales_orders', onClose() {} }, { expandChildren: [] });
  try {
    await settle(view);
    assert.match(view.text(), /Cabeçalho personalizado · Pedidos de venda/);
    const save = () => view.nodes().find(n => n.type === 'button' && n.props.children === 'Salvar');
    assert.equal(save().props.disabled, true, 'nothing to save yet');
    node(view, 'RichTextEditor').props.onChange(header); await view.flush();
    save().props.onClick(); await settle(view);
    assert.match(view.text(), /Conferir resultado/);
    view.nodes().find(n => n.type === 'button' && n.props.children === 'Conferir resultado').props.onClick(); await settle(view);
    const posts = calls.filter(call => call.method === 'POST');
    assert.equal(posts.length, 2); assert.equal(posts[0].body.command_id, posts[1].body.command_id, 'the same command');
    assert.deepEqual([posts[0].body.expected_version, posts[0].body.content], [0, header]);
    assert.match(view.text(), /Cabeçalho personalizado salvo\./);
  } finally { view.unmount(); }
  const readOnly = await mountComponent('DocumentPrintHeader.tsx', { controller: controller('vendas'), kind: 'sales_orders', onClose() {} }, { expandChildren: [] });
  try {
    await settle(readOnly);
    assert.match(readOnly.text(), /Somente o administrador altera o cabeçalho personalizado\./);
    assert.equal(readOnly.nodes().some(n => n.type === 'button' && n.props.children === 'Salvar'), false);
  } finally { readOnly.unmount(); }
});

test('print: the Cabeçalho personalizado replaces the company identity only with "Personalizado"; Outros itens and Condições comerciais Texto', async () => {
  const header = rich([run('Cabeçalho da FAGOO', { bold: true })]);
  const current = record(body({ other_items: { content: rich([run('Instalação')]), total: '25.00' }, commercial_conditions: { mode: 'text', text: rich([run('50% na aprovação')]) } }));
  const prefs = { ...defaultDocumentPreferences('sales_proposals').print, headerType: 'personalizado' };
  const model = documentPrintModel(current, null, { prefs, customHeader: header });
  assert.deepEqual([model.customHeader, model.otherItems.total, model.conditionsText.blocks[0].runs[0].text, model.paymentTerms], [header, 'R$ 25,00', '50% na aprovação', null]);
  assert.ok(model.totals.some(row => row.label === 'Total outros itens' && row.value === 'R$ 25,00'));
  assert.equal(documentPrintModel(current, null, { prefs: { ...prefs, headerType: 'padrao' }, customHeader: header }).customHeader, null, 'Padrão do Sistema keeps the company');
  const view = await mountComponent('DocumentPrintPreview.tsx', { model }, { componentName: 'DocumentPrintSheet', expandChildren: ['RichTextView'] });
  try {
    const shown = view.text();
    assert.match(shown, /Cabeçalho da FAGOO/); assert.doesNotMatch(shown, /Identificação da empresa ainda não cadastrada/);
    assert.match(shown, /Outros itens ou serviçosInstalaçãoTotal outros itens: R\$ 25,00/); assert.match(shown, /Condições comerciais50% na aprovação/);
  } finally { view.unmount(); }
});

test('print dialog: with "Personalizado" it waits for the header of the kind, then prints it; a failed read keeps the standard header', async () => {
  const previous = globalThis.document, previousElement = globalThis.HTMLElement;
  globalThis.HTMLElement ??= class {};
  globalThis.document = { activeElement: null, getElementById: () => null, addEventListener() {}, removeEventListener() {}, body: { append() {}, children: [], style: {}, classList: { add() {}, remove() {} } }, createElement: () => ({ remove() {} }) };
  const header = rich([run('Cabeçalho próprio das propostas', { bold: true })]);
  const settle = async view => { for (let i = 0; i < 3; i++) { await new Promise(resolve => setTimeout(resolve, 5)); await view.flush(); } };
  try {
    for (const failing of [false, true]) {
      const paths = [];
      const controller = { async company() { return { section: 'identity', data_mode: 'erp_native', emission_enabled: false, record: null }; },
        async documents(path) { paths.push(path); if (failing) throw new AccessError(503); return { kind: 'sales_proposals', content: header, version: 3, updated_at: '2026-10-21T12:00:00Z', can_manage: false, data_mode: 'erp_native', operational_effects: false }; } };
      const options = { prefs: { ...defaultDocumentPreferences('sales_proposals').print, headerType: 'personalizado' } };
      const view = await mountComponent('DocumentPrintPreview.tsx', { record: record(), controller, onClose() {}, options }, { expandChildren: ['DocumentPrintSheet', 'RichTextView'] });
      try {
        await settle(view);
        assert.deepEqual(paths, ['/v1/documentos/sales_proposals/cabecalho']);
        assert.equal(view.button('Imprimir documento').disabled, false);
        if (failing) { assert.match(view.text(), /o documento sai com o cabeçalho padrão/); assert.doesNotMatch(view.text(), /Cabeçalho próprio/); }
        else assert.match(view.text(), /Cabeçalho próprio das propostas/);
      } finally { view.unmount(); }
    }
    // "Padrão do Sistema": the header is not read.
    const untouched = { async company() { return { section: 'identity', data_mode: 'erp_native', emission_enabled: false, record: null }; }, async documents() { throw new Error('not read'); } };
    const plain = await mountComponent('DocumentPrintPreview.tsx', { record: record(), controller: untouched, onClose() {}, options: { prefs: defaultDocumentPreferences('sales_proposals').print } }, { expandChildren: ['DocumentPrintSheet'] });
    try { await settle(plain); assert.equal(plain.button('Imprimir documento').disabled, false); } finally { plain.unmount(); }
  } finally { globalThis.document = previous; globalThis.HTMLElement = previousElement; }
});

test('RichTextEditor: the Origin tools, and a disabled editor shows the formatted text only', async () => {
  const value = rich([run('Texto formatado', { italic: true })]);
  const view = await mountComponent('RichTextEditor.tsx', { id: 'editor-teste', label: 'Outros itens ou serviços', value, onChange() {} }, { componentName: 'RichTextEditor', expandChildren: [] });
  try {
    for (const title of ['Negrito', 'Itálico', 'Sublinhado', 'Alinhar à esquerda', 'Centralizar', 'Alinhar à direita', 'Justificar', 'Diminuir recuo', 'Aumentar recuo', 'Código', 'Desfazer', 'Refazer'])
      assert.ok(view.nodes().some(n => n.type === 'button' && n.props.title === title), title);
    assert.ok(view.nodes().some(n => n.type === 'select' && n.props['aria-label'] === 'Tamanho da fonte'));
    assert.ok(view.nodes().some(n => n.type === 'input' && n.props['aria-label'] === 'Cor do texto') && view.nodes().some(n => n.type === 'input' && n.props['aria-label'] === 'Cor de fundo'));
    assert.ok(view.nodes().some(n => n.type === 'div' && n.props.contentEditable === true && n.props.role === 'textbox'));
  } finally { view.unmount(); }
  const disabled = await mountComponent('RichTextEditor.tsx', { id: 'editor-teste', label: 'Texto', value, onChange() {}, disabled: true }, { componentName: 'RichTextEditor', expandChildren: ['RichTextView'] });
  try { assert.match(disabled.text(), /Texto formatado/); assert.equal(disabled.nodes().some(n => n.props?.contentEditable), false); } finally { disabled.unmount(); }
});
