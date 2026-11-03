import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';

// Tags no padrão do Origin (migração 153) na interface: Tipo nas telas Tags/Grupos de tags, "Editar tags" no contato, filtro
// Tags e Lista de preço, Marcadores e "Incluir tags para selecionados" na listagem de contatos. Synthetic data only.
globalThis.document ??= { activeElement: null, getElementById: () => null };
globalThis.document.addEventListener ??= () => undefined; globalThis.document.removeEventListener ??= () => undefined;
const actor = '95000000-0000-4000-8000-0000000000aa', stamp = '2026-10-20T12:00:00+00:00';
const ids = { ana: '95000000-0000-4000-8000-000000000001', bia: '95000000-0000-4000-8000-000000000002', vip: '95000000-0000-4000-8000-0000000000d1', promo: '95000000-0000-4000-8000-0000000000d2',
  segment: '95000000-0000-4000-8000-0000000000e1', line: '95000000-0000-4000-8000-0000000000e2', list: '95000000-0000-4000-8000-0000000000f1' };
const tax = (kind, id, name, tag_type, extra = {}) => ({ id, kind, parent_id: null, name, version: 1, created_at: stamp, updated_at: stamp, tag_type, children: 0, products: 0, contacts: 0, ...extra });
const TAGS = [tax('tags', ids.vip, 'VIP', 'contacts', { parent_id: ids.segment, contacts: 3 }), tax('tags', ids.promo, 'Promoção', 'products', { products: 2 })];
const GROUPS = [tax('tag_groups', ids.segment, 'Segmento', 'contacts', { children: 1 }), tax('tag_groups', ids.line, 'Linha', 'products')];
const textOf = value => Array.isArray(value) ? value.map(textOf).join('') : value && typeof value === 'object' ? textOf(value.props?.children) : value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);
const set = (contact, tags, version = 1) => ({ contact_id: contact, version, tag_ids: tags.map(tag => tag.id), tags: tags.map(tag => ({ id: tag.id, name: tag.name, group_id: tag.parent_id, group_name: tag.parent_id ? 'Segmento' : null })) });

function server({ read = ['contacts', 'products'], write = ['contacts'], role = 'financeiro', patch } = {}) {
  const calls = [];
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role } }), subscribe: () => () => {}, retry() {},
    async catalog(path, options = {}) {
      calls.push({ path, method: options.method, body: options.body && structuredClone(options.body) });
      if (path === '/v1/cadastros') return { read, write, data_mode: 'erp_native' };
      if (path === '/v1/cadastros/taxonomias/tags' && !options.method) return { kind: 'tags', items: TAGS, data_mode: 'erp_native' };
      if (path === '/v1/cadastros/taxonomias/grupos-tags' && !options.method) return { kind: 'tag_groups', items: GROUPS, data_mode: 'erp_native' };
      if (path === '/v1/cadastros/taxonomias/tags' && options.method === 'POST') return { kind: 'tags', saved: true, item: tax('tags', '95000000-0000-4000-8000-0000000000d9', options.body.data.name, options.body.data.tag_type), data_mode: 'erp_native' };
      if (path === '/v1/cadastros/listas-precos') return { items: [{ id: ids.list, name: 'Atacado SP' }], data_mode: 'erp_native' };
      if (path === '/v1/cadastros/tipos-contato') return { scope: 'contact_types', can_create: false, can_delete: false, items: [], data_mode: 'erp_native' };
      if (path.startsWith('/v1/cadastros/contatos/tags?')) return { entity: 'contacts', items: [set(ids.ana, [TAGS[0]])], data_mode: 'erp_native' };
      const one = /^\/v1\/cadastros\/contatos\/([^/]+)\/tags$/.exec(path);
      if (one && !options.method) return { entity: 'contacts', contact: set(one[1], [], 0), data_mode: 'erp_native' };
      if (one && options.method === 'PATCH') { if (patch) return patch(one[1], options.body, calls);
        return { entity: 'contacts', contact: set(one[1], TAGS.filter(tag => options.body.tag_ids.includes(tag.id)), 1), changed: true, replayed: false, data_mode: 'erp_native' }; }
      if (path.startsWith('/v1/cadastros/contatos?')) {
        const rows = [ids.ana, ids.bia].map((id, index) => ({ id, entity: 'contacts', version: 2, active: true, situation: 'A', name: index ? 'Bia Fornecedora' : 'Ana Cliente', code: null, trade_name: null, person_type: 'F', document: null, email: null,
          phone: null, mobile: null, city: 'Piracicaba', state: 'SP', roles: [], types: [], crt: null, seller_id: null, seller_name: null, next_visit: null, is_seller: false, created_at: stamp, updated_at: stamp, source: null }));
        return { entity: 'contacts', items: rows, page: 1, size: 100, total: rows.length, sort: 'created_desc', situation: 'latest', scoped: false, data_mode: 'erp_native' };
      }
      throw new AccessError(404);
    },
    async listPreferences() { return { scope: 'list_preferences', data_mode: 'erp_native', list_id: 'cadastros.contatos', version: 0, columns: null, filters: null, updated_at: null }; },
  };
  return { calls, controller, writes: () => calls.filter(call => call.method) };
}

test('Tags screen: Tipo filter, column and field; a contacts-only profile creates Contatos tags and only views Produtos tags', async () => {
  const service = server();
  const view = await mountComponent('ProductTaxonomy.tsx', { controller: service.controller, kind: 'tags' }, { location: '/tags?tipo=contatos' });
  try {
    assert.equal(view.input('taxonomy-type-filter').props.value, 'contacts', '?tipo=contatos presets the filter');
    assert.match(view.text(), /VIP/); assert.doesNotMatch(view.text(), /Promoção/);
    assert.deepEqual(view.find(node => node.type?.name === 'AppliedChips').props.chips.map(chip => chip.label), ['Tipo: Contatos']);
    await view.change('taxonomy-type-filter', '');
    assert.match(view.text(), /Promoção/);
    const promoMenu = view.find(node => node.type?.name === 'RowMenu' && node.props.label === 'Promoção').props.items;
    assert.deepEqual(promoMenu.map(item => item.label), ['Visualizar'], 'a Produtos tag is read only for this profile');
    assert.equal(view.nodes().some(node => node.props?.['aria-label'] === 'Selecionar Promoção'), false);
    assert.ok(view.nodes().some(node => node.props?.['aria-label'] === 'Selecionar VIP'));
    await view.click('Incluir tag');
    const type = view.input('taxonomy-type');
    assert.deepEqual([type.props.value, type.props.children.map(option => option.props.value)], ['contacts', ['contacts']]);
    const groups = view.input('taxonomy-group').props.children[1].map(option => option.props.children);
    assert.deepEqual(groups, ['Segmento'], 'only the groups of the chosen Tipo');
    await view.change('taxonomy-name', 'Inadimplente'); await view.change('taxonomy-group', ids.segment);
    await view.submit();
    assert.deepEqual(service.writes().at(-1).body.data, { name: 'Inadimplente', parent_id: ids.segment, tag_type: 'contacts' });
    assert.match(view.text(), /Tag incluída/);
  } finally { view.unmount(); }
  const groupsView = await mountComponent('ProductTaxonomy.tsx', { controller: server({ write: ['products'], role: 'estoque' }).controller, kind: 'tag_groups' }, {});
  try {
    assert.match(groupsView.text(), /Quantidade de grupos2/); assert.ok(groupsView.button('Incluir grupo tag'));
    const headers = groupsView.nodes().filter(node => node.type === 'th').map(node => textOf(node.props.children));
    assert.deepEqual(headers, ['Seleção', 'Nome', 'Tipo', 'Ações']);
  } finally { groupsView.unmount(); }
});

test('contact form "Editar tags": Contatos tags only, saved on their own with the tag-set version and "Conferir resultado"', async () => {
  let attempt = 0;
  const service = server({ patch(contact, body) {
    attempt++;
    if (attempt === 1) throw new AccessError(503);
    return { entity: 'contacts', contact: set(contact, TAGS.filter(tag => body.tag_ids.includes(tag.id)), 1), changed: true, replayed: attempt > 2, data_mode: 'erp_native' };
  } });
  const view = await mountComponent('ContactTags.tsx', { controller: service.controller, record: { id: ids.ana, situation: 'A' }, writable: true }, { componentName: 'ContactTagsField', expandChildren: ['TagsDrawer', 'Modal'] });
  try {
    assert.match(view.text(), /Nenhuma tag/);
    await view.click('Editar tags');
    assert.match(view.text(), /Marque as tags relacionadas ao contato/);
    assert.match(view.text(), /VIP/); assert.doesNotMatch(view.text(), /Promoção/, 'Produtos tags never appear for a contact');
    view.find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } }); await view.flush();
    await view.click('Salvar tags');
    const first = service.writes().at(-1);
    assert.deepEqual([first.path, first.body.mode, first.body.expected_version, first.body.tag_ids], [`/v1/cadastros/contatos/${ids.ana}/tags`, 'replace', 0, [ids.vip]]);
    assert.match(view.text(), /Conferir resultado/); assert.equal(view.guard().changed, true);
    await view.click('Conferir resultado');
    assert.equal(service.writes().at(-1).body.command_id, first.body.command_id, 'the same command is repeated');
    assert.match(view.text(), /Tags salvas/); assert.match(view.text(), /VIP/);
  } finally { view.unmount(); }
  const fresh = await mountComponent('ContactTags.tsx', { controller: server().controller, record: null, writable: true }, { componentName: 'ContactTagsField' });
  try { assert.equal(fresh.button('Editar tags').disabled, true); assert.equal(fresh.button('Editar tags').props.title, 'Salve o cadastro para incluir as tags.'); } finally { fresh.unmount(); }
  const excluded = await mountComponent('ContactTags.tsx', { controller: server().controller, record: { id: ids.ana, situation: 'E' }, writable: true }, { componentName: 'ContactTagsField' });
  try { assert.equal(excluded.button('Editar tags').disabled, true); } finally { excluded.unmount(); }
});

test('contact list: Tags and Lista de preço filters, Marcadores and "Incluir tags para selecionados" (mode add, one command per contact)', async () => {
  const service = server({ role: 'vendas', write: ['contacts'] });
  const view = await mountComponent('RealCatalog.tsx', { controller: service.controller, initialEntity: 'contacts' }, { expandChildren: ['NativeListLayout', 'ContactCatalog', 'ContactTagFilters', 'ContactMarkers'] });
  try {
    const tagSelect = view.input('contact-tag-filter');
    assert.deepEqual(tagSelect.props.children.slice(0, 2).map(option => option.props.children), ['Todos', 'Sem Tag']);
    assert.match(textOf(tagSelect.props.children), /VIP/); assert.doesNotMatch(textOf(tagSelect.props.children), /Promoção/);
    assert.equal(view.input('contact-price-list-filter').disabled, false);
    assert.match(view.text(), /Ana Cliente/);
    assert.ok(view.nodes().some(node => node.type === 'span' && node.props.className === 'product-tag' && textOf(node.props.children) === 'VIP'), 'Marcadores shows the tags of the row');
    await view.change('contact-tag-filter', ids.vip); await view.change('contact-price-list-filter', ids.list);
    await view.submit();
    const page = new URLSearchParams(service.calls.filter(call => call.path.startsWith('/v1/cadastros/contatos?')).at(-1).path.split('?')[1]);
    assert.deepEqual([page.get('tag'), page.get('price_list_id')], [ids.vip, ids.list]);
    const chips = view.find(node => node.type?.name === 'AppliedChips').props.chips.map(chip => chip.label);
    assert.ok(chips.includes('Tags: VIP') && chips.includes('Lista de preço: Atacado SP'), chips.join());
    view.find(node => node.type === 'input' && node.props['aria-label'] === 'Selecionar Bia Fornecedora').props.onClick({ shiftKey: false }); await view.flush();
    await view.click('Incluir tags para selecionados');
    const batch = view.find(node => node.type?.name === 'ContactTagsBatch');
    assert.deepEqual(batch.props.items, [{ id: ids.bia, label: 'Bia Fornecedora', excluded: false }]);
  } finally { view.unmount(); }
  // The batch itself: tags chosen in the drawer, then one PATCH mode add per contact; an excluded contact is skipped.
  const batchService = server();
  let closed = null;
  const batch = await mountComponent('ContactTags.tsx', { controller: batchService.controller, items: [{ id: ids.bia, label: 'Bia Fornecedora', excluded: false }, { id: ids.ana, label: 'Ana', excluded: true }],
    options: { tags: [TAGS[0]], groups: [GROUPS[0]], loaded: true, failed: false, lists: null, listsState: 'forbidden' }, writable: true, onClose: results => { closed = results; } }, { componentName: 'ContactTagsBatch', expandChildren: ['TagsDrawer', 'Modal'] });
  try {
    batch.find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } }); await batch.flush();
    await batch.click('Incluir tags');
    const dialog = batch.find(node => node.type?.name === 'BatchDialog').props;
    assert.deepEqual([dialog.plan.eligible.map(item => item.id), dialog.plan.skipped.map(item => item.message)], [[ids.bia], ['Cadastro excluído; restaure-o antes.']]);
    await dialog.run(dialog.plan.eligible[0]);
    const sent = batchService.writes().at(-1);
    assert.deepEqual([sent.path, sent.body.mode, sent.body.tag_ids, Object.hasOwn(sent.body, 'expected_version')], [`/v1/cadastros/contatos/${ids.bia}/tags`, 'add', [ids.vip], false]);
    dialog.onClose([]); await batch.flush();
    assert.deepEqual(closed, []);
  } finally { batch.unmount(); }
});
