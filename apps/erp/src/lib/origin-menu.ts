// Navigation that mirrors the Origin top menu (captured on 19/10/2026, docs/references/origin-interface.md).
// Labels, grouping, column titles and order follow Origin exactly. Items that Brufap will never offer
// (marketplaces, loja virtual, logística, CT-e, NFS-e, DAS MEI, GNRE, Origin Conta, multiempresa and ordens de
// produção, per docs/product-scope.md) are left out; items that
// exist in Origin and are planned for Brufap stay in place, disabled, so positions remain familiar.

import { preferencePage, preferencePageHref } from '../../../../packages/erp-domain/src/preferences/catalog.mjs';

export type MenuGroupName = 'Meu Negócio' | 'Cadastros' | 'Vendas' | 'Estoque' | 'Financeiro';
export type CompanyRole = 'admin' | 'consulta' | 'financeiro' | 'vendas' | 'estoque' | 'fiscal';

export interface RealTarget { to: string; roles?: readonly CompanyRole[]; resource?: string }
export interface MenuItemDefinition { label: string; demo?: string; real?: RealTarget }
export interface MenuColumnDefinition { title: string; items: readonly MenuItemDefinition[] }
export interface MenuGroupDefinition { name: MenuGroupName; columns: readonly MenuColumnDefinition[]; footer?: MenuItemDefinition }

const FINANCE: readonly CompanyRole[] = ['admin', 'consulta', 'financeiro'];
const FISCAL_READ: readonly CompanyRole[] = ['admin', 'consulta', 'fiscal'];

export const ORIGIN_MENU: readonly MenuGroupDefinition[] = [
  { name: 'Meu Negócio', columns: [{ title: 'Dashboards', items: [
    { label: 'Dashboard geral', demo: '/inicio', real: { to: '/acesso' } },
    // Preferências lane (migration 150): Meu Negócio dashboards on /meu-negocio; cost needs purchase orders (margem).
    { label: 'Dashboard vendas', real: { to: '/meu-negocio?painel=mensal', roles: ['admin', 'consulta', 'vendas', 'financeiro', 'estoque', 'fiscal'] } },
    { label: 'Dashboard margem por pedido', real: { to: '/meu-negocio?painel=margem-pedido', roles: ['admin', 'consulta', 'financeiro', 'estoque', 'fiscal'] } },
    { label: 'Dashboard produtos', real: { to: '/painel-produtos-empresa', roles: ['admin', 'consulta', 'vendas', 'estoque', 'fiscal'] } },
    { label: 'Dashboard clientes', real: { to: '/meu-negocio?painel=novos-recorrentes', roles: ['admin', 'consulta', 'vendas', 'financeiro', 'estoque', 'fiscal'] } },
    { label: 'Curva ABC', real: { to: '/meu-negocio?painel=curva-abc', roles: ['admin', 'consulta', 'vendas', 'financeiro', 'estoque', 'fiscal'] } },
    { label: 'Metas', real: { to: '/meu-negocio?painel=metas', roles: ['admin', 'consulta', 'vendas', 'financeiro', 'estoque', 'fiscal'] } },
  ] }] },
  { name: 'Cadastros', columns: [
    { title: 'Cadastros', items: [
      { label: 'Produtos', demo: '/produtos', real: { to: '/cadastros-reais?cadastro=products', resource: 'products' } },
      { label: 'Clientes e fornecedores', demo: '/contatos', real: { to: '/cadastros-reais?cadastro=contacts', resource: 'contacts' } },
      { label: 'Vendedores', demo: '/vendedores', real: { to: '/vendedores-empresa', roles: ['admin', 'consulta', 'vendas', 'financeiro'] } },
      { label: 'Funcionários', real: { to: '/funcionarios-empresa', roles: ['admin'] } },
      { label: 'Contas Financeiras', demo: '/contas-financeiras', real: { to: '/financeiro-empresa?area=contas-financeiras', roles: FINANCE } },
      { label: 'Categorias Financeiras', demo: '/categorias-financeiras', real: { to: '/financeiro-empresa?area=categories', roles: FINANCE } },
      { label: 'Formas de pagamento', demo: '/formas-pagamento', real: { to: '/formas-pagamento-empresa', roles: ['admin', 'consulta', 'financeiro', 'vendas'] } },
    ] },
    { title: 'Ferramentas', items: [
      { label: 'Categorias de produtos', demo: '/categorias-produtos', real: { to: '/categorias-produtos', resource: 'products' } },
      { label: 'Listas de preços', demo: '/listas-precos', real: { to: '/listas-precos', resource: 'products' } },
    ] },
  ], footer: { label: 'Ver relatórios de cadastros', demo: '/relatorios?filter.area=Cadastros' } },
  { name: 'Vendas', columns: [
    { title: 'Gestão', items: [
      { label: 'Pedidos de venda', demo: '/vendas', real: { to: '/documentos-empresa?tipo=sales_orders', roles: ['admin', 'consulta', 'financeiro', 'vendas', 'estoque', 'fiscal'] } },
      { label: 'Notas fiscais de saída', demo: '/notas-saida', real: { to: '/historico-fiscal?modelo=55', roles: FISCAL_READ } },
      { label: 'NFC-e', demo: '/nfce', real: { to: '/historico-fiscal?modelo=65', roles: FISCAL_READ } },
      { label: 'Frente de caixa', demo: '/frente-caixa', real: { to: '/frente-caixa-empresa', roles: ['admin', 'consulta', 'vendas', 'financeiro'] } },
      { label: 'Propostas comerciais', demo: '/propostas', real: { to: '/documentos-empresa?tipo=sales_proposals', roles: ['admin', 'consulta', 'financeiro', 'vendas'] } },
    ] },
    { title: 'Serviços', items: [
      { label: 'Ordens de serviço', demo: '/ordens-servico', real: { to: '/documentos-empresa?tipo=service_orders', roles: ['admin', 'consulta', 'financeiro', 'vendas'] } },
      { label: 'Relatórios de serviço', demo: '/relatorios?filter.area=Serviços', real: { to: '/documentos-empresa?tipo=service_orders&acao=relatorios', roles: ['admin', 'consulta', 'financeiro', 'vendas'] } },
    ] },
    // Logística: only Checkout de pedidos is in scope (objetos de postagem, logística reversa and Origin Envios are out).
    { title: 'Logística', items: [
      { label: 'Checkout de pedidos', real: { to: '/documentos-empresa?tipo=sales_orders&acao=checkout', roles: ['admin', 'vendas'] } },
    ] },
  ], footer: { label: 'Ver relatórios de vendas', demo: '/relatorios?filter.area=Vendas', real: { to: '/documentos-empresa?tipo=sales_orders&acao=relatorios', roles: ['admin', 'consulta', 'financeiro', 'vendas', 'estoque', 'fiscal'] } } },
  { name: 'Estoque', columns: [
    { title: 'Compras', items: [
      { label: 'Pedidos de compra', demo: '/compras', real: { to: '/documentos-empresa?tipo=purchase_orders', roles: ['admin', 'consulta', 'financeiro', 'estoque', 'fiscal'] } },
      { label: 'Notas fiscais de entrada', demo: '/notas-entrada', real: { to: '/notas-entrada', roles: ['admin', 'fiscal', 'consulta'] } },
      { label: 'Fornecedores', demo: '/contatos?filter.role=Fornecedor', real: { to: '/cadastros-reais?cadastro=contacts&contato=fornecedor', resource: 'contacts' } },
      { label: 'Sugestão de Compras', real: { to: '/painel-produtos-empresa?painel=sugestao', roles: ['admin', 'consulta', 'estoque', 'fiscal'] } },
      { label: 'Check-in de Recebimentos', real: { to: '/checkin-recebimentos', roles: ['admin', 'estoque', 'fiscal'] } },
    ] },
    { title: 'Estoque', items: [
      { label: 'Lançamentos de estoque', demo: '/estoque', real: { to: '/estoque-empresa', roles: ['admin', 'consulta', 'vendas', 'estoque', 'fiscal'] } },
      { label: 'Conferência de estoque', demo: '/conferencia-estoque', real: { to: '/conferencia-estoque-empresa', roles: ['admin', 'estoque'] } },
      { label: 'Depósitos', demo: '/depositos', real: { to: '/cadastros-reais?cadastro=warehouses', roles: ['admin', 'consulta', 'estoque'] } },
    ] },
  ], footer: { label: 'Ver relatórios de compras e estoque', demo: '/relatorios?filter.area=Estoque', real: { to: '/relatorios-estoque', roles: ['admin', 'consulta', 'vendas', 'estoque', 'fiscal'] } } },
  { name: 'Financeiro', columns: [
    { title: 'Gestão financeira', items: [
      { label: 'Caixas e bancos', demo: '/caixas-bancos', real: { to: '/financeiro-empresa?area=accounts', roles: FINANCE } },
      { label: 'Contas a pagar', demo: '/contas-pagar', real: { to: '/financeiro-empresa?area=payable', roles: FINANCE } },
      { label: 'Contas a receber', demo: '/contas-receber', real: { to: '/financeiro-empresa?area=receivable', roles: FINANCE } },
      { label: 'Remessas e retornos', demo: '/remessas-retornos', real: { to: '/financeiro-empresa?area=remessas', roles: FINANCE } },
      { label: 'Ficha Financeira', demo: '/ficha-financeira', real: { to: '/financeiro-empresa?area=ficha', roles: FINANCE } },
      { label: 'Comissões', demo: '/comissoes', real: { to: '/financeiro-empresa?area=comissoes', roles: FINANCE } },
      { label: 'Controle de caixa', demo: '/controle-caixa', real: { to: '/financeiro-empresa?area=controle-caixa', roles: FINANCE } },
      { label: 'Faturamento agrupado', demo: '/faturamento-agrupado', real: { to: '/financeiro-empresa?area=faturamento-agrupado', roles: FINANCE } },
    ] },
  ], footer: { label: 'Ver relatórios financeiros', demo: '/relatorios?filter.area=Financeiro', real: { to: '/financeiro-empresa?area=relatorios', roles: FINANCE } } },
];

// Preferências, as in Origin (gear → Preferências): categories in Origin order with Origin's groups ("Configurações de …",
// "Tabelas e configurações adicionais", "Planilhas modelo") and items in Origin order. Logística is out of scope and omitted.
// A page or screen Brufap does not have yet stays listed and disabled with the reason; Brufap's own tools sit in the extra
// group "Ferramentas do Brufap" of their category, so no previous entry became unreachable. Each settings page has its
// schema in packages/erp-domain/src/preferences (roles of the page = roles of the module it configures).
export interface PreferenceEntry { label: string; to?: string; roles?: readonly CompanyRole[]; description?: string; disabledReason?: string }
export interface PreferenceSection { title: string; entries: readonly PreferenceEntry[] }
export interface PreferenceCategory { id: string; label: string; icon: string; notice?: { title: string; text: string }; sections: readonly PreferenceSection[] }

const page = (id: string): PreferenceEntry => {
  const schema = preferencePage(id);
  if (!schema) throw new Error(`PREFERENCE_PAGE_MISSING ${id}`);
  return { label: schema.title, to: preferencePageHref(schema), roles: schema.readRoles };
};
const soon = (label: string, disabledReason: string, roles?: readonly CompanyRole[]): PreferenceEntry => ({ label, disabledReason, ...(roles ? { roles } : {}) });
const ADMIN: readonly CompanyRole[] = ['admin'];
const NOT_YET = 'Ainda não disponível no FAGOO.';
// Readers of the product cadastros (erp_access.resources_for_role 'products'): the product taxonomy screens follow them.
const PRODUCT_READERS: readonly CompanyRole[] = ['admin', 'consulta', 'vendas', 'estoque', 'fiscal'];
// Tags of Produtos and of Contatos (migration 153): whoever reads products or contacts.
const TAG_READERS: readonly CompanyRole[] = ['admin', 'consulta', 'vendas', 'financeiro', 'estoque', 'fiscal'];
const TOOLS = 'Ferramentas do FAGOO';

export const COMPANY_PREFERENCES: readonly PreferenceCategory[] = [
  { id: 'empresa', label: 'Empresa', icon: 'building', sections: [
    { title: 'Configurações da empresa', entries: [page('empresa-geral')] },
    { title: 'Tabelas e configurações adicionais', entries: [{ label: 'Alterar dados da empresa', to: '/empresa-configuracoes', description: 'Cadastro fiscal e dados gerais da empresa.' }] },
  ] },
  { id: 'sistema', label: 'Sistema', icon: 'desktop', sections: [
    { title: 'Configurações do sistema', entries: [page('sistema-interface')] },
    { title: 'Tabelas e configurações adicionais', entries: [
      { label: 'Consulta de exclusões realizadas', to: '/preferencias/sistema/consulta-exclusoes', roles: ADMIN }, { label: 'Gerenciador de arquivos', to: '/preferencias/sistema/gerenciador-arquivos', roles: ADMIN }, { label: 'Relatórios customizados', to: '/preferencias/sistema/relatorios-customizados', description: 'Relatórios padrão e os customizados liberados para você.' },
      { label: 'Etiquetas customizadas', to: '/preferencias/sistema/etiquetas-customizadas', roles: ADMIN }, { label: 'Registro de atividades', to: '/preferencias/sistema/registro-atividades', roles: ADMIN }, { label: 'Usuários', to: '/preferencias/sistema/usuarios', roles: ADMIN },
      { label: 'Gerenciador de transições', to: '/preferencias/sistema/gerenciador-transicoes', roles: ADMIN, description: 'Situações personalizadas e transições de pedidos de venda, de compra e ordens de serviço.' }, { label: 'Campos customizados', to: '/campos-customizados', roles: PRODUCT_READERS, description: 'Campos próprios do cadastro de produtos, por categoria (aba Produtos).' },
    ] },
  ] },
  { id: 'cadastros', label: 'Cadastros', icon: 'address-book', sections: [
    { title: 'Configurações de cadastros', entries: [page('cadastros-contatos'), page('cadastros-lotes'), page('cadastros-produtos')] },
    { title: 'Tabelas e configurações adicionais', entries: [{ label: 'Categorias de produtos', to: '/categorias-produtos', roles: PRODUCT_READERS }, { label: 'Gerenciar tipos de contatos', to: '/tipos-contatos-empresa', roles: ADMIN }] },
    // Contatos lane: Cadastros > Vendedores e Funcionários ainda sem item real no menu (o atalho do Início segue o menu).
    { title: TOOLS, entries: [{ label: 'Vendedores', to: '/vendedores-empresa', roles: ['admin', 'consulta', 'vendas', 'financeiro'], description: 'Cadastros › Vendedores: vendedores, usuário vinculado, comissionamento e descontos.' },
      { label: 'Funcionários', to: '/funcionarios-empresa', roles: ADMIN, description: 'Cadastros › Funcionários: dados cadastrais, contato e endereço.' }] },
  ] },
  { id: 'suprimentos', label: 'Suprimentos', icon: 'boxes-stacked', sections: [
    { title: 'Configurações de suprimentos', entries: [page('suprimentos-estoque'), page('suprimentos-compras')] },
    { title: 'Tabelas e configurações adicionais', entries: [{ label: 'Gerenciar grupos de tags', to: '/grupos-tags', roles: TAG_READERS }, { label: 'Gerenciar tags', to: '/tags', roles: TAG_READERS },
      { label: 'Depósitos de estoque', to: '/cadastros-reais?cadastro=warehouses', roles: ['admin', 'consulta', 'estoque'], description: 'Depósito padrão e "Desconsiderar saldo deste depósito".' }, { label: 'Grupos de produtos', to: '/grupos-produtos', roles: PRODUCT_READERS }] },
    { title: TOOLS, entries: [{ label: 'Estoque · saldo de abertura e estoque negativo', to: '/estoque-abertura', roles: ADMIN, description: 'Política "Permitir estoque negativo" e adoção do saldo do Origin por depósito.' }] },
  ] },
  { id: 'vendas', label: 'Vendas', icon: 'users', sections: [
    { title: 'Configurações de vendas', entries: [page('vendas-frente-caixa'), page('vendas-propostas'), page('vendas-vendas')] },
  ] },
  { id: 'notas-fiscais', label: 'Notas Fiscais', icon: 'file-invoice', notice: { title: 'Importante', text: 'Antes de alterar as configurações entre em contato com o seu contador.' }, sections: [
    { title: 'Configurações de notas fiscais', entries: [page('notas-nfce'), page('notas-nfe')] },
    { title: 'Tabelas e configurações adicionais', entries: [
      { label: 'Consulta de inutilizações de NF-es', to: '/inutilizacoes-nfe', roles: ['admin', 'fiscal'] },
      { label: 'Consulta de correções de NF-es', to: '/cartas-correcao', roles: ['admin', 'fiscal'] },
      { label: 'Naturezas de operação', to: '/naturezas-operacao', roles: FISCAL_READ, description: 'Naturezas com regras de ICMS, IPI, PIS, COFINS e II, padrões e configurações globais de impostos.' },
    ] },
    { title: TOOLS, entries: [
      { label: 'Emissor de NF-e · rascunhos', to: '/emissor-fiscal?modelo=55', roles: ['admin', 'fiscal'] },
      { label: 'Emissor de NFC-e · rascunhos', to: '/emissor-fiscal?modelo=65', roles: ['admin', 'fiscal'] },
      { label: 'Séries fiscais · homologação', to: '/numeracao-fiscal', roles: ['admin', 'fiscal'] },
      { label: 'Conexão com a SEFAZ', to: '/conexao-sefaz', roles: ['admin', 'fiscal'] },
      { label: 'XMLs sincronizados do Origin', to: '/xmls-sincronizados', roles: ['admin', 'fiscal', 'consulta'] },
    ] },
  ] },
  { id: 'certificado', label: 'Certificado Digital', icon: 'certificate', sections: [
    { title: 'Configurações do certificado digital', entries: [page('certificado-digital')] },
    { title: TOOLS, entries: [{ label: 'Certificado A1 · custódia', to: '/certificado-a1', roles: ['admin', 'fiscal'] }] },
  ] },
  { id: 'financas', label: 'Finanças', icon: 'dollar-sign', sections: [
    { title: 'Configurações de finanças', entries: [page('financas-pagar'), page('financas-receber')] },
    { title: 'Tabelas e configurações adicionais', entries: [{ label: 'Importação de registros financeiros', to: '/financeiro-empresa?area=importacao', roles: FINANCE },
      { label: 'Gerenciar categorias de receita e despesa', to: '/financeiro-empresa?area=categories', roles: FINANCE },
      { label: 'Gerenciar contas financeiras', to: '/financeiro-empresa?area=contas-financeiras', roles: FINANCE },
      { label: 'Gerenciar formas de pagamento', to: '/formas-pagamento-empresa', roles: FINANCE }, { label: 'Controle de caixa', to: '/financeiro-empresa?area=controle-caixa', roles: FINANCE }] },
    { title: TOOLS, entries: [
      { label: 'Cobrança bancária · homologação', to: '/cobranca-empresa', roles: FINANCE },
      { label: 'Retornos operacionais', to: '/retornos-operacionais', roles: FINANCE },
      { label: 'Relatório de vencimentos', to: '/relatorio-vencimentos', roles: FINANCE },
      { label: 'Ficha financeira', to: '/financeiro-empresa?area=ficha', roles: FINANCE },
      { label: 'Conferir boletos antigos', to: '/cobrancas-legadas-itau', roles: ADMIN },
    ] },
  ] },
  { id: 'servicos', label: 'Serviços', icon: 'screwdriver-wrench', sections: [
    { title: 'Configurações de serviços', entries: [page('servicos-os')] },
  ] },
  { id: 'integracoes', label: 'Integrações', icon: 'plug', sections: [
    { title: TOOLS, entries: [
      { label: 'Dados sincronizados do Origin', to: '/dados-origin' },
      { label: 'Andamento da integração Origin', to: '/integracao-origin', roles: ADMIN },
      { label: 'Histórico de vendas do Origin', to: '/historico-vendas-origin', roles: ADMIN },
      { label: 'Conferir vendas do Origin', to: '/conferir-vendas-origin', roles: ADMIN },
      { label: 'Conferir compras do Origin', to: '/conferir-compras-origin', roles: ADMIN },
    ] },
  ] },
  { id: 'contabilidade', label: 'Contabilidade', icon: 'calculator', sections: [
    { title: 'Configurações de contabilidade', entries: [page('contabilidade-contador')] },
  ] },
  { id: 'importacoes', label: 'Importações de Dados', icon: 'file-import', sections: [
    // 228: the spreadsheet import framework; 265 adds composições, campos customizados, lista de preços and fornecedores de produto.
    // In the order of the Origin hub: Produtos (produtos, composições, Campos Customizados, Lista de Preços), Contatos, Suprimentos
    // (pedidos de compra, movimentações de estoque em massa, fornecedores de produto), Fiscal, Finanças and Vendas.
    { title: 'Planilhas modelo', entries: [{ label: 'Importar e atualizar produtos', to: '/preferencias/importacoes/produtos', roles: ADMIN, description: 'Inclui produtos e atualiza os já cadastrados pelo Código.' },
      { label: 'Importar composições', to: '/preferencias/importacoes/composicoes', roles: ADMIN, description: 'A estrutura das composições, um componente por linha.' },
      { label: 'Importar campos customizados', to: '/preferencias/importacoes/campos-customizados', roles: ADMIN, description: 'Os valores dos campos customizados dos produtos, pelo nome do campo.' },
      { label: 'Importar lista de preços', to: '/listas-precos', roles: ADMIN, description: 'Em Cadastros › Listas de preços: abra a lista, Inserir produtos e a planilha modelo (código e preço).' },
      // 300: Lotes (Origin: Produtos › Lotes), the lots of the products with Controle de lote.
      { label: 'Importar lotes', to: '/preferencias/importacoes/lotes', roles: ADMIN, description: 'Inclui lotes nos produtos com Controle de lote e atualiza as datas e a Obs. dos já cadastrados.' },
      { label: 'Importar e atualizar contatos', to: '/preferencias/importacoes/contatos', roles: ADMIN, description: 'Inclui contatos e atualiza os já cadastrados pelo CPF/CNPJ.' },
      { label: 'Importar pedidos de compra', to: '/preferencias/importacoes/pedidos-compra', roles: ADMIN }, { label: 'Importar movimentações de estoque em massa', to: '/preferencias/importacoes/movimentacoes-estoque', roles: ADMIN },
      { label: 'Importar fornecedores de produto', to: '/preferencias/importacoes/fornecedores-produtos', roles: ADMIN, description: 'Inclui ou atualiza os fornecedores de cada produto.' },
      { label: 'Importar notas fiscais em Lote', to: '/preferencias/importacoes/notas-fiscais', roles: ADMIN, description: 'Rascunhos de NF-e de saída em homologação, um por número da planilha.' }, { label: 'Importar contas a receber/pagar', to: '/preferencias/importacoes/contas-receber', roles: ADMIN, description: 'Contas em aberto, sem baixa.' },
      { label: 'Importar vendas', to: '/preferencias/importacoes/vendas', roles: ADMIN, description: 'Pedidos de venda em aberto, sem lançar estoque nem contas.' }] },
    { title: TOOLS, entries: [
      { label: 'Importar cadastros', to: '/importar-cadastros', roles: ADMIN },
      { label: 'Importar orçamentos', to: '/importar-orcamentos', roles: ADMIN },
      { label: 'Importar contatos (somente inclusão)', to: '/importar-contatos', roles: ADMIN, description: 'Tela de Clientes e fornecedores que inclui contatos sem atualizar os existentes.' },
    ] },
  ] },
  { id: 'backup', label: 'Backup e Exportação de Dados', icon: 'database', sections: [
    { title: 'Backup e exportação', entries: [{ label: 'Backup', to: '/preferencias/backup/exportacao', roles: ADMIN, description: 'Pacote ZIP com os dados e os arquivos da empresa, gerado no servidor.' }, soon('Gerar arquivo auxiliar do SPED PIS/COFINS (Contribuições)', NOT_YET, ADMIN),
      soon('Gerar arquivo auxiliar do SPED ICMS/IPI (Fiscal)', NOT_YET, ADMIN), soon('Exportar dados para Sintegra', NOT_YET, ADMIN)] },
    { title: TOOLS, entries: [{ label: 'Preparação da virada', to: '/preparacao-virada', roles: ADMIN }] },
  ] },
];

export interface CompanyAccess { role?: string; resources?: readonly string[] }

export function realTargetAllowed(target: RealTarget | undefined, access: CompanyAccess): target is RealTarget {
  if (!target || !access.role) return false;
  if (target.resource && !(access.resources || []).includes(target.resource)) return false;
  return !target.roles || target.roles.includes(access.role as CompanyRole);
}

export type ResolvedItem = { label: string; to?: string; disabled: boolean };
export type ResolvedColumn = { title: string; items: ResolvedItem[] };
export type ResolvedGroup = { name: MenuGroupName; columns: ResolvedColumn[]; footer?: ResolvedItem };

// Disabled items keep Origin positions visible; a group or column with no enabled item is hidden.
export function resolveMenu(area: 'demo' | 'real', access: CompanyAccess = {}): ResolvedGroup[] {
  const resolve = (item: MenuItemDefinition): ResolvedItem => {
    const to = area === 'demo' ? item.demo : realTargetAllowed(item.real, access) ? item.real.to : undefined;
    return { label: item.label, to, disabled: !to };
  };
  return ORIGIN_MENU.map(group => {
    const columns = group.columns.map(column => ({ title: column.title, items: column.items.map(resolve) })).filter(column => column.items.some(item => !item.disabled));
    const footer = group.footer ? resolve(group.footer) : undefined;
    return { name: group.name, columns, ...(footer && !footer.disabled ? { footer } : {}) };
  }).filter(group => group.columns.length > 0);
}

export type ResolvedPreferenceCategory = { id: string; label: string; icon: string; notice?: { title: string; text: string }; sections: { title: string; entries: PreferenceEntry[] }[]; entries: LinkedPreferenceEntry[] };
export type LinkedPreferenceEntry = PreferenceEntry & { to: string };
// Entries for other roles are hidden (enabled or not); a category with nothing left is hidden. "entries" lists only the
// enabled ones (search links and breadcrumbs), "sections" keeps Origin's groups with the disabled items in place.
export function resolvePreferences(access: CompanyAccess): ResolvedPreferenceCategory[] {
  if (!access.role) return [];
  const mine = (entry: PreferenceEntry) => !entry.roles || entry.roles.includes(access.role as CompanyRole);
  return COMPANY_PREFERENCES.map(category => {
    const sections = category.sections.map(section => ({ title: section.title, entries: section.entries.filter(mine) })).filter(section => section.entries.length > 0);
    return { id: category.id, label: category.label, icon: category.icon, ...(category.notice ? { notice: category.notice } : {}), sections, entries: sections.flatMap(section => section.entries.filter((entry): entry is LinkedPreferenceEntry => Boolean(entry.to))) };
  }).filter(category => category.sections.length > 0);
}

export function matchesLocation(to: string, pathname: string, search: string) {
  const [path, query = ''] = to.split('?');
  if (pathname !== path) return false;
  const current = new URLSearchParams(search);
  return [...new URLSearchParams(query)].every(([key, value]) => current.get(key) === value);
}

export function activeGroupFor(groups: readonly ResolvedGroup[], pathname: string, search: string): ResolvedGroup | undefined {
  return groups.find(group => group.columns.some(column => column.items.some(item => item.to && matchesLocation(item.to, pathname, search))));
}

// Demo "Preferências" page: the 14 Origin categories with their sections, in Origin order. Entries with a
// demo screen link to it; the rest stay listed and disabled so the layout matches what the team knows.
export interface DemoPreferenceSection { title: string; entries: readonly { label: string; to?: string }[] }
export interface DemoPreferenceCategory { id: string; label: string; icon: string; sections: readonly DemoPreferenceSection[] }
const items = (...labels: string[]) => labels.map(label => ({ label }));
export const DEMO_PREFERENCES: readonly DemoPreferenceCategory[] = [
  { id: 'empresa', label: 'Empresa', icon: 'building', sections: [{ title: 'Configurações da empresa', entries: items('Geral') }, { title: 'Tabelas e configurações adicionais', entries: items('Alterar dados da empresa') }] },
  { id: 'sistema', label: 'Sistema', icon: 'desktop', sections: [{ title: 'Configurações do sistema', entries: items('Interface') }, { title: 'Tabelas e configurações adicionais', entries: items('Consulta de exclusões realizadas', 'Gerenciador de arquivos', 'Relatórios customizados', 'Etiquetas customizadas', 'Registro de atividades', 'Usuários', 'Gerenciador de transições', 'Campos customizados') }] },
  { id: 'cadastros', label: 'Cadastros', icon: 'address-book', sections: [{ title: 'Configurações de cadastros', entries: [{ label: 'Configurações de clientes e fornecedores' }, { label: 'Controle de lotes' }, { label: 'Configurações de produtos' }, { label: 'Categorias de produtos', to: '/categorias-produtos' }, { label: 'Gerenciar tipos de contatos' }] }] },
  { id: 'suprimentos', label: 'Suprimentos', icon: 'boxes-stacked', sections: [{ title: 'Configurações de suprimentos', entries: items('Estoque', 'Configurações de pedidos de compras') }, { title: 'Tabelas e configurações adicionais', entries: [{ label: 'Gerenciar grupos de tags' }, { label: 'Gerenciar tags' }, { label: 'Depósitos de estoque', to: '/depositos' }, { label: 'Grupos de produtos' }] }] },
  { id: 'vendas', label: 'Vendas', icon: 'users', sections: [{ title: 'Configurações de vendas', entries: [{ label: 'Frente de caixa', to: '/frente-caixa' }, { label: 'Propostas comerciais' }, { label: 'Vendas' }] }] },
  { id: 'notas-fiscais', label: 'Notas Fiscais', icon: 'file-invoice', sections: [{ title: 'Configurações de notas fiscais', entries: items('Configurações de NFC-e', 'Configurações de NF-e') }, { title: 'Tabelas e configurações adicionais', entries: items('Consulta de inutilizações de NF-es', 'Consulta de correções de NF-es', 'Naturezas de operação') }] },
  { id: 'certificado', label: 'Certificado Digital', icon: 'certificate', sections: [{ title: 'Configurações do certificado digital', entries: items('Configurações de certificado digital') }] },
  { id: 'financas', label: 'Finanças', icon: 'dollar-sign', sections: [{ title: 'Configurações de finanças', entries: items('Contas a pagar', 'Contas a receber') }, { title: 'Tabelas e configurações adicionais', entries: [{ label: 'Importação de registros financeiros' }, { label: 'Gerenciar categorias de receita e despesa', to: '/categorias-financeiras' }, { label: 'Gerenciar contas financeiras', to: '/contas-financeiras' }, { label: 'Gerenciar formas de pagamento', to: '/formas-pagamento' }, { label: 'Controle de caixa', to: '/controle-caixa' }] }] },
  { id: 'servicos', label: 'Serviços', icon: 'screwdriver-wrench', sections: [{ title: 'Configurações de serviços', entries: items('Ordens de serviço') }] },
  { id: 'integracoes', label: 'Integrações', icon: 'plug', sections: [{ title: 'Configurações de integrações', entries: items('API Para Web Services') }] },
  { id: 'contabilidade', label: 'Contabilidade', icon: 'calculator', sections: [{ title: 'Configurações de contabilidade', entries: items('Espaço Meu Contador') }] },
  { id: 'importacoes', label: 'Importações de Dados', icon: 'file-import', sections: [{ title: 'Planilhas modelo', entries: items('Importar e atualizar produtos', 'Importar e atualizar contatos', 'Importar pedidos de compra', 'Importar movimentações de estoque em massa', 'Importar notas fiscais em Lote', 'Importar contas a receber/pagar', 'Importar vendas') }] },
  { id: 'backup', label: 'Backup e Exportação de Dados', icon: 'database', sections: [{ title: 'Backup e exportação', entries: items('Backup', 'Gerar arquivo auxiliar do SPED PIS/COFINS (Contribuições)', 'Gerar arquivo auxiliar do SPED ICMS/IPI (Fiscal)', 'Exportar dados para Sintegra') }] },
];
