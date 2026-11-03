import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mountComponent } from './helpers/component-recovery-harness.mjs';
import { catalogData } from '../src/lib/catalog-model.ts';
import { productDetailPayload, EMPTY_LISTS, productFormValues } from '../src/lib/product-form-model.ts';

// RealCatalog.tsx only routes by entity: the list frame (CatalogList), the entity lists (ProductList, ContactList,
// WarehouseList) and the routed editors (ProductEditor, ContactEditor, WarehouseEditor). Each entity must still mount
// and save through exactly the controller calls of the single component it replaced. Synthetic data only.
globalThis.document ??= { activeElement: null, getElementById: () => null };
const actor = '94000000-0000-4000-8000-0000000000aa';
const created = '94000000-0000-4000-8000-0000000000ee';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const row = entity => ({ id: '94000000-0000-4000-8000-000000000001', entity, version: 1, active: true, name: 'Cadastro fictício', code: 'QA-1', created_at: '2026-10-19T12:00:00+00:00', updated_at: '2026-10-19T12:00:00+00:00', source: null, ...(entity === 'products' ? { unit: 'UN', price: '1.5000', kind: 'P', format: 'S', stock: { state: 'no_movements', quantity: null, warehouse: null } } : entity === 'contacts' ? { roles: [] } : {}) });
const EXPECT = {
  products: { title: 'Produtos', add: 'Incluir cadastro', headers: ['Seleção', 'Imagem', 'Descrição', 'Código', 'Unidade', 'Preço', 'Estoque', 'Marcadores', 'Situação', 'Origem', 'Ações'], form: /Dados básicos.*Características.*Estoque.*Tributação/, save: 'Salvar produto' },
  contacts: { title: 'Clientes e Fornecedores', add: 'Incluir cadastro', headers: ['Seleção', 'Código', 'Nome', 'CPF/CNPJ', 'Cidade', 'Telefone', 'Tipo de contato', 'Situação', 'Origem', 'Ações'], form: /Dados cadastrais.*Endereço.*Contato.*Dados adicionais.*Tipo de Contato/, save: 'Salvar' },
  warehouses: { title: 'Depósitos', add: 'Incluir depósito', headers: ['Seleção', 'Nome', 'Código', 'Situação', 'Origem', 'Ações'], form: /Descrição/, save: 'Salvar' },
};

function server(entity) {
  const calls = [], stored = new Map();
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'admin' } }),
    async catalog(path, options = {}) {
      calls.push({ path, method: options.method, body: options.body && structuredClone(options.body) });
      if (path === '/v1/cadastros') return { read: ['products', 'contacts', 'warehouses'], write: ['products', 'contacts', 'warehouses'], data_mode: 'erp_native' };
      const [route, search = ''] = path.split('?'), [, kind, id, tail] = route.match(/^\/v1\/cadastros\/(\w+)(?:\/([^/]+))?(?:\/(\w+))?$/);
      assert.equal(kind, entity, 'every request stays on the entity of the list');
      if (options.method) {
        const current = stored.get(id ?? created) ?? { ...row(entity), id: created, version: 0 };
        const record = { ...current, version: current.version + 1, ...(tail === 'active' ? { active: options.body.active } : options.body.data) };
        stored.set(record.id, record);
        return { entity, record, replayed: false, data_mode: 'erp_native' };
      }
      if (id) return { entity, record: stored.get(id), data_mode: 'erp_native' };
      const params = new URLSearchParams(search);
      return { entity, items: [row(entity)], page: Number(params.get('page')), size: 100, total: 1, sort: 'created_desc', ...(entity === 'products' ? { stock_visible: true } : {}), data_mode: 'erp_native' };
    },
    async stockPositions(path) { calls.push({ path }); return { items: [], limit: 100, has_more: false, next_cursor: null, data_mode: 'erp_native', scope: 'stock_warehouse_options' }; },
  };
  return { calls, controller };
}
const textOf = value => Array.isArray(value) ? value.map(textOf).join('') : value && typeof value === 'object' ? textOf(value.props?.children) : value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);
const headers = view => view.nodes().filter(node => node.type === 'th').map(node => textOf(node.props.children));
// Products use the v2 page (migration 120): Situação instead of active, and the list reads categorias, grupos de tags and tags.
const list = entity => entity === 'products' ? '/v1/cadastros/products?page=1&size=100&situation=latest' : `/v1/cadastros/${entity}?page=1&size=100&active=true`;
const TAXONOMIES = ['/v1/cadastros/taxonomias/categorias-produtos', '/v1/cadastros/taxonomias/grupos-tags', '/v1/cadastros/taxonomias/tags'];
// The product form also reads its taxonomies and the custom field definitions (migration 156): reference data, not the flow.
const withoutTaxonomies = paths => paths.filter(path => !path.includes('/taxonomias/') && path !== '/v1/cadastros/campos-customizados');

// Read-only list server: one synthetic row per entity, stock visible on product pages.
const listController = calls => ({
  getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'admin' } }),
  async catalog(path, options = {}) {
    calls.push(options.method ? `${options.method} ${path}` : path);
    if (path === '/v1/cadastros') return { read: ['products', 'contacts', 'warehouses'], write: ['products', 'contacts', 'warehouses'], data_mode: 'erp_native' };
    const entity = path.match(/^\/v1\/cadastros\/(\w+)\?/)[1], params = new URLSearchParams(path.split('?')[1]);
    return { entity, items: [row(entity)], page: Number(params.get('page')), size: 100, total: 1, sort: 'created_desc', ...(entity === 'products' ? { stock_visible: true } : {}), data_mode: 'erp_native' };
  },
  async stockPositions(path) { calls.push(path); return { items: [], limit: 100, has_more: false, next_cursor: null, data_mode: 'erp_native', scope: 'stock_warehouse_options' }; },
});

// Every hook call of the container, by kind, so a render with another entity can be compared with the first one.
const HOOK_LOG = '__catalogSplitHookLog';
const loggedModules = {
  react: `const log=kind=>globalThis.${HOOK_LOG}.push(kind);export const useState=(...a)=>(log('state'),r.useState(...a)),useRef=(...a)=>(log('ref'),r.useRef(...a)),useEffect=(...a)=>(log('effect'),r.useEffect(...a)),useLayoutEffect=(...a)=>(log('layout'),r.useLayoutEffect(...a)),useId=(...a)=>(log('id'),r.useId(...a)),useMemo=(...a)=>(log('memo'),r.useMemo(...a)),useSyncExternalStore=(...a)=>(log('store'),r.useSyncExternalStore(...a));`,
  'react-router-dom': `const log=kind=>globalThis.${HOOK_LOG}.push(kind);export const Link='test-router-link',useLocation=(...a)=>(log('location'),r.useLocation(...a)),useNavigate=(...a)=>(log('navigate'),r.useNavigate(...a)),useSearchParams=(...a)=>(log('search'),r.useSearchParams(...a));`,
  '../hooks/useUnsavedChanges': `const log=kind=>globalThis.${HOOK_LOG}.push(kind);export const useUnsavedChanges=(...a)=>(log('unsaved'),r.useUnsavedChanges(...a)),useUnsavedForm=(...a)=>(log('form'),r.useUnsavedForm(...a)),useUnsavedChangesGuard=(...a)=>(log('guard'),r.useUnsavedChangesGuard(...a));`,
};
// The container's first hook is useLocation (useCatalogList), so each render starts with "location".
const renders = log => log.reduce((all, kind) => { if (kind === 'location') all.push([]); all.at(-1)?.push(kind); return all; }, []);

test('in place (QA route), switching the entity keeps the same hooks in the same order and resets the product row state', async () => {
  globalThis[HOOK_LOG] = [];
  const calls = [], prepared = [], controller = listController(calls);
  // Only the container renders, so every logged hook belongs to it.
  const view = await mountComponent('RealCatalog.tsx', { controller, initialEntity: 'products', onPrepareWarehouses: () => prepared.push(true) }, { modules: loggedModules });
  try {
    const pencil = () => view.find(node => node.type === 'button' && node.props['aria-label'] === 'Editar o preço de Cadastro fictício');
    pencil().props.onClick({ stopPropagation() {} }); await view.flush();
    await view.change('catalog-inline-price', '2,00');
    assert.equal(view.guard().changed, true, 'an unsaved inline price is protected');

    await view.change('catalog-entity', 'contacts');
    // Clientes e fornecedores render their own list component (ContactList.tsx); its hooks live in that component.
    const contacts = view.find(node => node.type?.name === 'ContactCatalog');
    assert.equal(contacts.props.list.entity, 'contacts');
    assert.equal(view.guard().changed, false, 'the inline price is discarded with the product list');
    assert.throws(() => view.input('catalog-inline-price'));

    contacts.props.list.changeEntity('warehouses'); await view.flush();
    assert.deepEqual(headers(view), EXPECT.warehouses.headers);
    await view.click('Importar depósitos do Origin');
    assert.equal(prepared.length, 1);

    await view.change('catalog-entity', 'products');
    assert.deepEqual(headers(view), EXPECT.products.headers, 'the Estoque column comes back with the product page');
    pencil().props.onClick({ stopPropagation() {} }); await view.flush();
    assert.equal(view.input('catalog-inline-price').props.value, '1,50', 'a new inline price starts from the stored price');

    assert.deepEqual(withoutTaxonomies(calls), ['/v1/cadastros', list('products'), '/v1/posicoes-estoque/depositos?limit=100', list('warehouses'), list('products'), '/v1/posicoes-estoque/depositos?limit=100']);
    assert.deepEqual(calls.filter(path => path.includes('/taxonomias/')), [...TAXONOMIES, ...TAXONOMIES], 'the product list reads its filter options each time it is shown');
    const all = renders(globalThis[HOOK_LOG]);
    assert.ok(all.length > 8, 'every entity rendered several times');
    for (const hooks of all) assert.deepEqual(hooks, all[0], 'a hook called only for one entity would break React on the in-place switch');
  } finally { view.unmount(); delete globalThis[HOOK_LOG]; }
});

test('row state registered by a second entity list keeps the product inline price and stock column working', async () => {
  // Stands in for a future entity list with its own row state: the real WarehouseList plus a registration under "warehouses".
  const warehouseList = JSON.stringify(fileURLToPath(new URL('../src/components/WarehouseList.tsx', import.meta.url)));
  const events = globalThis.__catalogSplitRowEvents = [];
  const modules = { './WarehouseList': `import { useWarehouseList as real, warehouseListView } from ${warehouseList};
export { warehouseListView };
export const useWarehouseList = (list, prepare) => { list.rows.current.warehouses = { discard: () => globalThis.__catalogSplitRowEvents.push('discard'), loaded: page => globalThis.__catalogSplitRowEvents.push(page.entity) }; return real(list, prepare); };` };
  const calls = [], view = await mountComponent('RealCatalog.tsx', { controller: listController(calls), initialEntity: 'products' }, { modules, expandChildren: ['NativeListLayout'] });
  try {
    assert.deepEqual(headers(view), EXPECT.products.headers, 'the product page still tells the product list that stock is visible');
    assert.deepEqual(events, ['products'], 'the other list hears about the page too');
    view.find(node => node.type === 'button' && node.props['aria-label'] === 'Editar o preço de Cadastro fictício').props.onClick({ stopPropagation() {} }); await view.flush();
    await view.change('catalog-inline-price', '2,00');
    assert.equal(view.guard().changed, true);
    await view.change('catalog-search', 'Cadastro');
    await view.submit(); // Filtrar
    assert.equal(view.guard().changed, false, 'a list change still discards the product inline price');
    assert.throws(() => view.input('catalog-inline-price'));
    assert.deepEqual(headers(view), EXPECT.products.headers);
    // Opening the price and filtering are list changes; the filtered page is a new product page.
    assert.deepEqual(events, ['products', 'discard', 'discard', 'products']);
  } finally { view.unmount(); delete globalThis.__catalogSplitRowEvents; }
});

// Contacts have their own list and form (contacts-ui.test.mjs).
for (const entity of ['warehouses']) test(`${entity}: the routed list mounts and the routed editor creates, edits and inactivates with the same calls`, async () => {
  const service = server(entity), expected = EXPECT[entity];
  const view = await mountComponent('RealCatalog.tsx', { controller: service.controller, initialEntity: entity }, { expandChildren: ['NativeListLayout', 'Editor', 'ProductEditor', 'ContactEditor', 'WarehouseEditor', 'ProductFields', 'Field'] });
  try {
    const paths = () => service.calls.map(call => call.method ? `${call.method} ${call.path}` : call.path);
    assert.match(view.text(), new RegExp(expected.title));
    assert.deepEqual(headers(view), expected.headers);
    assert.deepEqual(paths(), ['/v1/cadastros', list(entity), ...(entity === 'products' ? ['/v1/posicoes-estoque/depositos?limit=100'] : [])]);
    const mounted = service.calls.length;

    await view.click(expected.add);
    assert.match(view.text(), expected.form, 'the editor of this entity is the one routed');
    assert.ok(view.button(expected.save));
    await view.change('catalog-name', 'Cadastro sintético');
    if (entity === 'contacts') { view.find(node => node.type === 'label' && textOf(node) === 'Fornecedor').props.children[0].props.onChange({ target: { checked: true } }); await view.flush(); }
    await view.submit();
    const roles = entity === 'contacts' ? ['supplier'] : [];
    const data = catalogData(entity, { name: 'Cadastro sintético' }, roles, null);
    const save = service.calls[mounted];
    assert.deepEqual(paths().slice(mounted), [`POST /v1/cadastros/${entity}`, `/v1/cadastros/${entity}/${created}`, list(entity)]);
    assert.deepEqual(Object.keys(save.body).sort(), ['command_id', 'data']);
    assert.match(save.body.command_id, UUID);
    assert.deepEqual(save.body.data, data, 'the payload is the shared catalogData of this entity');
    assert.match(view.text(), /Cadastro salvo\./);

    const edited = service.calls.length;
    await view.change('catalog-name', 'Cadastro sintético alterado');
    await view.submit();
    const patch = service.calls[edited];
    assert.deepEqual(paths().slice(edited), [`PATCH /v1/cadastros/${entity}/${created}`, `/v1/cadastros/${entity}/${created}`, list(entity)]);
    assert.equal(patch.body.expected_version, 1);
    assert.equal(patch.body.data.name, 'Cadastro sintético alterado');
    assert.notEqual(patch.body.command_id, save.body.command_id);

    const toggled = service.calls.length;
    await view.click('Inativar cadastro');
    const active = service.calls[toggled];
    assert.deepEqual(paths().slice(toggled), [`PATCH /v1/cadastros/${entity}/${created}/active`, `/v1/cadastros/${entity}/${created}`, list(entity)]);
    assert.deepEqual({ ...active.body, command_id: 'id' }, { expected_version: 2, active: false, command_id: 'id' });
    assert.match(view.text(), /Inativo/);
  } finally { view.unmount(); }
});

// Products (migration 119): the routed editor reads and saves the complete product (detail, lists and "Ativado") in one command.
test('products: the routed list mounts and the routed editor creates, edits and inactivates through the complete product route', async () => {
  const calls = [], stored = new Map();
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'admin' } }),
    async catalog(path, options = {}) {
      calls.push({ path, method: options.method, body: options.body && structuredClone(options.body) });
      if (path === '/v1/cadastros') return { read: ['products'], write: ['products'], data_mode: 'erp_native' };
      const taxonomy = /^\/v1\/cadastros\/taxonomias\/([a-z-]+)$/.exec(path);
      if (taxonomy) return { kind: { 'categorias-produtos': 'categories', 'grupos-produtos': 'product_groups', 'grupos-tags': 'tag_groups', tags: 'tags' }[taxonomy[1]], items: [], data_mode: 'erp_native' };
      const [route, search = ''] = path.split('?'), [, id, tail] = route.match(/^\/v1\/cadastros\/products(?:\/([^/]+))?(?:\/(\w+))?$/);
      if (options.method) {
        const key = id === 'completo' ? created : id, current = stored.get(key) ?? { ...row('products'), id: created, version: 0 };
        const record = { ...current, version: current.version + 1, ...options.body.data };
        stored.set(record.id, record);
        return { entity: 'products', record, replayed: false, data_mode: 'erp_native' };
      }
      if (id) return { entity: 'products', record: stored.get(id), data_mode: 'erp_native' };
      const params = new URLSearchParams(search);
      return { entity: 'products', items: [row('products')], page: Number(params.get('page')), size: 100, total: 1, sort: 'created_desc', stock_visible: true, data_mode: 'erp_native' };
    },
    async stockPositions(path) { calls.push({ path }); return { items: [], limit: 100, has_more: false, next_cursor: null, data_mode: 'erp_native', scope: 'stock_warehouse_options' }; },
  };
  const view = await mountComponent('RealCatalog.tsx', { controller, initialEntity: 'products' }, { expandChildren: ['NativeListLayout', 'Editor', 'ProductEditor', 'ProductForm', 'ExternalImages'] });
  try {
    const paths = () => withoutTaxonomies(calls.map(call => call.method ? `${call.method} ${call.path}` : call.path));
    assert.deepEqual(headers(view), EXPECT.products.headers);
    assert.deepEqual(paths(), ['/v1/cadastros', list('products'), '/v1/posicoes-estoque/depositos?limit=100']);
    let mounted = paths().length;
    await view.click('Incluir cadastro');
    assert.match(view.text(), /Dados básicos.*Características.*Imagens.*Estoque.*Fornecedores.*Tributação/);
    assert.equal(view.input('catalog-condition').props.value, 'unspecified', 'Não Especificado is the default condition');
    assert.equal(view.input('catalog-dimension_unit').props.value, 'cm', 'Centímetros is the default unit of measure');
    await view.change('catalog-name', 'Cadastro sintético');
    await view.submit();
    const save = calls.find(call => call.method === 'POST');
    assert.deepEqual(paths().slice(mounted), ['POST /v1/cadastros/products/completo', `/v1/cadastros/products/${created}`, list('products'), `/v1/cadastros/products/${created}/completo`]);
    const values = { ...productFormValues(null, undefined), name: 'Cadastro sintético' };
    assert.deepEqual(save.body.data, { ...catalogData('products', values, [], null), ...productDetailPayload(values, EMPTY_LISTS) }, 'catalog fields, detail and lists in one payload');
    assert.match(save.body.command_id, UUID);
    assert.match(view.text(), /Cadastro salvo\./);

    mounted = paths().length;
    await view.change('catalog-name', 'Cadastro sintético alterado');
    await view.submit();
    const patch = calls.filter(call => call.method === 'PATCH').at(-1);
    assert.deepEqual(paths().slice(mounted, mounted + 2), [`PATCH /v1/cadastros/products/${created}/completo`, `/v1/cadastros/products/${created}`]);
    assert.equal(patch.body.expected_version, 1); assert.equal(patch.body.data.name, 'Cadastro sintético alterado');

    await view.click('Inativar cadastro').then(() => assert.fail('products use the Ativado switch instead of the button'), () => undefined);
    view.input('catalog-active').props.onChange({ target: { checked: false } }); await view.flush();
    await view.submit();
    const inactive = calls.filter(call => call.method === 'PATCH').at(-1);
    assert.equal(inactive.body.data.active, false); assert.equal(inactive.body.expected_version, 2);
  } finally { view.unmount(); }
});
