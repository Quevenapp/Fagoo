import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent } from './helpers/component-recovery-harness.mjs';
import { resolveMenu, resolvePreferences } from '../src/lib/origin-menu.ts';

const withWindow = async run => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { addEventListener() {}, removeEventListener() {}, innerWidth: 1600, innerHeight: 900 } });
  try { await run(); } finally { if (previous) Object.defineProperty(globalThis, 'window', previous); else delete globalThis.window; }
};
const links = view => view.nodes().filter(node => node.props?.to).map(node => node.props.to);

test('sidebar groups company destinations and toggles the selected section', () => withWindow(async () => {
  const view = await mountComponent('OriginTopBar.tsx', { groups: resolveMenu('real', {role:'admin',resources:['products','contacts']}), homeTo: '/acesso', preferencesTo: '/preferencias', user: { name: 'Administrador', company: 'Empresa' }, theme: 'dark', onTheme() {} }, { location: '/acesso' });
  try {
    assert.ok(view.find(node => node.type === 'aside' && node.props['aria-label'] === 'Navegação do FAGOO'));
    assert.match(view.text(), /Resultados.*Comercial.*Compras.*Catálogo.*Estoque.*Financeiro.*Fiscal.*Pessoas/s);
    const panel = () => view.find(node => node.props.id === view.button('Catálogo').props['aria-controls']);
    assert.equal(panel().props.hidden, true);
    await view.click('Catálogo');
    assert.equal(panel().props.hidden, false);
    assert.equal(view.button('Catálogo').props['aria-expanded'], true);
    assert.ok(links(view).includes('/cadastros-reais?cadastro=products'));
    await view.click('Catálogo');
    assert.equal(panel().props.hidden, true);
    assert.equal(view.button('Catálogo').props['aria-expanded'], false);
  } finally { view.unmount(); }
}));

test('global search lists matching screens and Enter opens the first one', () => withWindow(async () => {
  const view = await mountComponent('OriginTopBar.tsx', { groups: resolveMenu('real', {role:'admin',resources:['products','contacts']}), homeTo: '/acesso', preferencesTo: '/preferencias', user: { name: 'Administrador', company: 'Empresa' }, theme: 'light', onTheme() {} }, { location: '/acesso' });
  try {
    const input = view.find(node => node.type === 'input' && node.props['aria-label'] === 'Pesquisar');
    input.props.onChange({ target: { value: 'contas a rec' } }); await view.flush();
    assert.match(view.text(), /Contas a receber/);
    const form = view.find(node => node.type === 'form' && node.props.role === 'search');
    form.props.onSubmit({ preventDefault() {} }); await view.flush();
    assert.equal(view.location().pathname, '/financeiro-empresa');
    assert.equal(view.location().search, '?area=receivable');
  } finally { view.unmount(); }
}));

test('user menu exposes Tema escuro and Sair da conta only when a logout handler exists', () => withWindow(async () => {
  let toggled = 0, logouts = 0;
  const view = await mountComponent('OriginTopBar.tsx', { groups: [], homeTo: '/acesso', preferencesTo: '/preferencias', user: { name: 'Administrador', company: 'FAGOO' }, theme: 'light', onTheme() { toggled++; }, onLogout() { logouts++; } }, { location: '/acesso' });
  try {
    view.find(node => node.type === 'button' && node.props['aria-label'] === 'Menu do usuário Administrador').props.onClick(); await view.flush();
    assert.match(view.text(), /FAGOO.*Todas as configurações.*Tema escuro.*Sair da conta/s);
    view.find(node => node.type === 'input' && node.props.role === 'switch').props.onChange(); await view.flush();
    assert.equal(toggled, 1);
    await view.click('Sair da conta');
    assert.equal(logouts, 1);
  } finally { view.unmount(); }
}));

test('period picker applies date presets and the typed start date on Enter', async () => {
  const applied = [];
  const view = await mountComponent('OriginList.tsx', { from: '', to: '', today: '2026-10-19', dateType: 'Data do pedido', dateTypes: ['Data do pedido', 'Data prevista'], prefixLabel: true, onApply: range => applied.push(range) }, { componentName: 'PeriodPicker' });
  try {
    assert.match(view.text(), /Data do pedido: todo o período/);
    await view.click('Data do pedido: todo o período');
    assert.match(view.text(), /Início do período.*Fim do período.*Hoje.*Esta semana.*Semana passada.*Este mês.*Mês passado.*Selecionar mês.*Período customizado/s);
    await view.click('Este mês'); await view.click('Filtrar');
    assert.deepEqual(applied.at(-1), { from: '2026-10-01', to: '2026-10-31', dateType: 'Data do pedido' });
    await view.click('Data do pedido: todo o período');
    const start = view.find(node => node.type === 'input' && node.props.placeholder === 'dd/mm/aaaa');
    start.props.onChange({ target: { value: '05/10/2026' } }); await view.flush();
    view.find(node => node.type === 'input' && node.props.placeholder === 'dd/mm/aaaa').props.onKeyDown({ key: 'Enter', preventDefault() {} }); await view.flush();
    assert.deepEqual(applied.at(-1), { from: '2026-10-05', to: '2026-10-05', dateType: 'Data do pedido' }, 'Enter applies the typed day as a single-day period');
  } finally { view.unmount(); }
});

test('row menu shows document indicators, keeps disabled items inert and runs enabled ones', () => withWindow(async () => {
  let cloned = 0, toggles = 0;
  const items = [{ label: 'Gerar nota fiscal', letter: { text: 'N', color: 'darkred' }, disabled: true }, { label: 'Clonar venda', icon: 'clone', onClick() { cloned++; } }];
  const view = await mountComponent('OriginList.tsx', { label: 'PV-1', items, open: true, onToggle() { toggles++; } }, { componentName: 'RowMenu', expandChildren: true });
  try {
    assert.match(view.text(), /N.*Gerar nota fiscal.*Clonar venda/s);
    assert.equal(view.button('NGerar nota fiscal').disabled, true);
    await view.click('Clonar venda');
    assert.equal(cloned, 1); assert.equal(toggles, 1);
  } finally { view.unmount(); }
}));

test('pagination shows Primeira/Anterior/pages/Próxima/Última and the record range label', async () => {
  const pages = [];
  const view = await mountComponent('OriginList.tsx', { page: 2, pages: 4, size: 100, total: 322, onPage: page => pages.push(page) }, { componentName: 'OriginPagination' });
  try {
    assert.match(view.text(), /Primeira.*Anterior.*4.*3.*2.*1.*Próxima.*Última.*101 - 200 de 322/s);
    await view.click('Última'); await view.click('Primeira'); await view.click('3');
    assert.deepEqual(pages, [4, 1, 3]);
  } finally { view.unmount(); }
});

test('Preferências lists categories, filters by search and links only allowed pages', async () => {
  const view = await mountComponent('PreferencesPage.tsx', { homeTo: '/acesso', categories: resolvePreferences({ role: 'fiscal' }) });
  try {
    assert.match(view.text(), /Organize as regras e os recursos da sua operação/);
    assert.match(view.text(), /Empresa.*Notas Fiscais.*Certificado Digital/s);
    assert.equal(links(view).includes('/importar-cadastros'), false, 'admin-only import is hidden from fiscal');
    view.find(node => node.type === 'input' && node.props['aria-label'] === 'Pesquisar preferências').props.onChange({ target: { value: 'sefaz' } }); await view.flush();
    assert.ok(links(view).includes('/conexao-sefaz'));
    assert.equal(links(view).includes('/empresa-configuracoes'), false);
  } finally { view.unmount(); }
});
