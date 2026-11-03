import type { FilterDefinition, ModuleDefinition, PanelActionDefinition, RowActionDefinition } from './types';

// Origin list chrome per demo screen, transcribed from docs/references/origin-interface.md (captured 19/10/2026).
// Labels, order and icons follow Origin; marketplace, logística, NFS-e and Origin Conta items are omitted (out of scope).

const text = (key: string, label: string, info?: string): FilterDefinition => ({ key, label, options: [], kind: 'text', ...(info ? { info } : {}) });
const select = (key: string, label: string, options: string[], extra: Partial<FilterDefinition> = {}): FilterDefinition => ({ key, label, options, kind: 'select', ...extra });
const multi = (key: string, label: string, options: string[]): FilterDefinition => ({ key, label, options, kind: 'multi' });
const act = (label: string, icon: string, title?: string): PanelActionDefinition => ({ label, icon, ...(title ? { title } : {}) });
const row = (label: string, icon?: string, separatorBefore = false): RowActionDefinition => ({ label, ...(icon ? { icon } : {}), ...(separatorBefore ? { separatorBefore } : {}) });
const letter = (label: string, text: string, color: string, separatorBefore = false): RowActionDefinition => ({ label, letter: { text, color }, ...(separatorBefore ? { separatorBefore } : {}) });
const states = (labels: string[], first = true): RowActionDefinition[] => labels.map((label, index) => ({ label, icon: 'arrow-right', ...(first && index === 0 ? { separatorBefore: true } : {}) }));
const LOTE = 'Poderá filtrar até 50 lotes separando-os por ;';
const UFS = ['AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'EX', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO'];
const LOJAS = ['Todas as lojas', 'Nenhuma', 'FAGOO'];
const CONTAS = ['Todas as contas financeiras', 'Itaú — demonstração', 'Inter — demonstração', 'Caixa — demonstração'];
const SALE_STATES = ['Em aberto', 'Em digitação', 'Em andamento', 'Atendido', 'Cancelado', 'Verificado', 'Atendido parcialmente'];
const PROPOSAL_STATES = ['Em aberto', 'Rascunho', 'Pendente', 'Aguardando', 'Aprovado', 'Não aprovado', 'Concluído', 'Modelos'];
const SERVICE_STATES = ['Em aberto', 'Orçada', 'Aprovada', 'Não aprovada', 'Em andamento', 'Aguardando componentes', 'Serviço concluído', 'Finalizada', 'Finalizada sem conserto'];
const FINANCE_SUPPORT = [{ label: 'Gerenciar recebimentos' }, { label: 'Gerenciar contas recorrentes' }, { label: 'Gerenciar categorias', to: '/categorias-financeiras' }, { label: 'Importação de registros financeiros' }];

export const ORIGIN_LISTS: Record<string, Partial<ModuleDefinition>> = {
  vendas: {
    title: 'Pedidos de venda', formTitle: 'Pedido de venda', primaryAction: 'Incluir pedido', selector: { label: 'Loja', options: LOJAS },
    searchPlaceholder: 'Pesquisar por nome, e-mail, CPF/CNPJ ou n° do pedido', periodTypes: ['Data do pedido', 'Data prevista', 'Data de saída'], periodPrefix: true,
    filters: [multi('status', 'Situação', SALE_STATES), text('seller', 'Vendedor'), text('product', 'Produto'), text('lot', 'Lote', LOTE), text('postalCode', 'CEP'), text('city', 'Cidade'), select('state', 'UF', UFS),
      select('trackingStatus', 'Rastreamento', ['Com rastreamento', 'Sem rastreamento']), text('trackingCode', 'Código de rastreio'), text('component', 'Componente'), text('carrier', 'Transportador'), text('purchaseOrder', 'Nº do pedido de compra')],
    defaultFilters: { status: 'Em aberto' }, indicatorKey: 'indicators',
    panelActions: [act('Gerar NF-e dos pedidos selecionados', 'file-invoice-dollar', 'Gerar NF-e das vendas selecionadas'), act('Mudar situação dos pedidos selecionados', 'circle-half-stroke', 'Mudar situação dos pedidos'), act('Imprimir selecionados', 'square-check')],
    moreActions: [{ title: 'Gerar', items: ['NFC-es selecionadas', 'Comprovantes selecionados'] }, { title: 'Exportar', items: ['Dados para planilha', 'Endereços selecionados'] }, { title: 'Imprimir', items: ['Relatório de produção'] }, { title: 'Importar', items: ['Pedido XML'] }, { title: 'Outras', items: ['Faturar pedidos selecionados'] }],
    rowMenu: [letter('Gerar nota fiscal', 'N', 'darkred'), letter('Gerar nota fiscal parcial', 'N', 'darkred'), letter('Estornar estoque', 'E', 'blue'), letter('Estornar contas', 'C', 'green'), letter('Gerar NFC-e', 'N', 'darkgreen'), letter('Gerar ordem serviço', 'O', 'midgreen'), row('Clonar venda', 'clone'), row('Gerar reversão'),
      row('Imprimir', 'print', true), row('Imprimir comprovante', 'print'), row('Imprimir c/ detalhes', 'print'), row('Imprimir carnê', 'print'), row('Relatório de produção', 'print'),
      row('Enviar por e-mail', 'paper-plane', true), row('Enviar por WhatsApp', 'whatsapp'), row('Emitir boletos', 'barcode'), ...states(['Atendido', 'Cancelado', 'Em andamento', 'Em digitação', 'Verificado', 'Em aberto'])],
    info: { count: 'Quantidade de pedidos' },
  },
  propostas: {
    formTitle: 'Proposta', primaryAction: 'Incluir proposta', selector: { label: 'Loja', options: LOJAS }, searchPlaceholder: 'Pesquisa por nome ou número da proposta', periodTypes: ['Data', 'Próximo contato'], periodPrefix: true,
    filters: [select('status', 'Situação', PROPOSAL_STATES), text('city', 'Cidade'), text('customerEmail', 'Email do Cliente'), text('product', 'Produto'), text('seller', 'Vendedor')], indicatorKey: 'indicators',
    panelActions: [act('Mudar situação das propostas selecionadas', 'circle-half-stroke', 'Mudar situação das propostas'), act('Exportar para a planilha', 'file-excel')],
    rowMenu: [letter('Gerar venda', 'V', 'orange'), letter('Gerar ordem de serviço', 'O', 'midgreen'), row('Imprimir', 'print'), row('Enviar por e-mail', 'envelope'), row('Enviar por whatsapp', 'whatsapp'), ...states(['Rascunho', 'Pendente', 'Aguardando', 'Aprovado', 'Não aprovado', 'Concluído']), row('Clonar proposta', 'clone', true), row('Criar modelo')],
    info: { count: 'Quantidade de propostas' },
  },
  'notas-saida': {
    title: 'Notas Fiscais de Saída', formTitle: 'Nota fiscal', primaryAction: 'Incluir nota fiscal', selector: { label: 'Loja', options: LOJAS }, searchPlaceholder: 'Pesquisar por nome, CPF/CNPJ ou n° da nota', filterPanelOpen: true,
    filters: [select('status', 'Situação', ['Pendente', 'Autorizada', 'Cancelada', 'Rejeitada', 'Aguardando protocolo']), text('product', 'Produto'), text('lot', 'Lote', LOTE), text('seller', 'Vendedor'), select('trackingStatus', 'Rastreamento', ['Com rastreamento', 'Sem rastreamento']), text('trackingCode', 'Código de rastreio', 'Caso não localize a nota, tente realizar o mesmo filtro na tela de pedidos'), select('state', 'UF', UFS)],
    indicatorKey: 'indicators',
    panelActions: [act('Enviar NF-es selecionadas', 'paper-plane', 'Enviar notas selecionadas'), act('Imprimir NF-es selecionadas', 'print', 'Imprimir notas selecionadas'), act('Enviar notas pendentes', 'calendar-xmark'), act('Gerar PDF DANFE', 'file-pdf'), act('Exportar XML', 'file-code'), act('Imprimir DANFE Simplificado em lote', 'print', 'Imprimir DANFEs simplificados selecionados')],
    moreActions: [{ title: 'Importar', items: ['Pedido XML', 'XML NF-e'] }, { title: 'Imprimir', items: ['Etiquetas selecionadas'] }, { title: 'Outros', items: ['Inutilizar numeração'] }],
    rowMenu: [row('Enviar por e-mail', 'paper-plane'), row('Enviar por Whatsapp', 'whatsapp'), row('Enviar espelho NF'), row('Cancelar NF-e'), row('Outras opções de NF-e'), row('Carta de correção'), row('NFe complementar'), row('Gerar PDF DANFE', 'file-pdf', true), row('Emitir boletos', 'barcode'),
      letter('Estornar contas', 'C', 'green', true), letter('Estornar estoque', 'E', 'blue'), row('Gerar devolução', 'turn-down'), row('Clonar nota', 'clone'), row('Clonar para entrada'), row('Imprimir DANFE', 'print', true), row('Imprimir DANFE Simplificado'), row('Imprimir etiquetas'), row('Imprimir espelho NF')],
    info: { count: 'Quantidade de notas' },
  },
  nfce: {
    title: 'Nota fiscal de consumidor eletrônica (NFC-e)', formTitle: 'NFC-e', searchPlaceholder: 'Pesquisar por nome ou n° da nota',
    filters: [select('fiscalFilter', 'Situação', ['Pendentes', 'Emitidas', 'Canceladas', 'Em contingência'])], indicatorKey: 'indicators',
    panelActions: [act('Importar XML', 'file-code'), act('Exportar XML', 'file-code'), act('Inutilizar numeração', 'note-sticky')],
    rowMenu: [letter('Estornar estoque', 'E', 'blue'), letter('Lançar contas', 'C', 'green'), row('Cancelar NFC-e'), row('Gerar NF-e'), row('Imprimir DANFE', 'print', true), row('Enviar por e-mail', 'paper-plane'), row('Enviar por Whatsapp', 'whatsapp'), row('Exportar XML', 'file-code'), row('Gerar devolução', 'turn-down')],
    info: { count: 'Quantidade de notas fiscais' },
  },
  'frente-caixa': { info: { count: 'Quantidade de atendimentos' } },
  'ordens-servico': {
    title: 'Ordem de serviço', formTitle: 'Ordem de serviço', primaryAction: 'Incluir ordem', selector: { label: 'Loja', options: LOJAS }, searchPlaceholder: 'Pesquisar por nome, e-mail, CEP, CPF/CNPJ ou n° da ordem', filterPanelOpen: true, situationStyle: 'dot',
    periodTypes: ['Período', 'Previstos para', 'Concluídos para', 'Data de Saída', 'Garantia'],
    filters: [select('status', 'Situação', SERVICE_STATES), text('lot', 'Lote', LOTE), text('seller', 'Vendedor'), text('technician', 'Técnico'), text('equipment', 'Equipamento'), text('serialNumber', 'Número de série do equipamento'), text('product', 'Peça'), text('service', 'Serviço')],
    defaultFilters: { status: 'Em aberto' }, indicatorKey: 'indicators',
    panelActions: [act('Imprimir ordens selecionadas', 'file-lines', 'Imprime as ordens de serviço selecionadas'), act('Mudar situação das ordens selecionadas', 'circle-half-stroke', 'Altera a situação das ordens de serviço selecionadas'), act('Imprimir etiquetas', 'note-sticky'), act('Enviar selecionados por e-mail', 'envelope', 'Enviar por e-mail')],
    moreActions: [{ title: 'Gerar', items: ['Gerar nota fiscal agrupando'] }],
    rowMenu: [letter('Lançar contas', 'C', 'green'), letter('Lançar estoque', 'E', 'blue'), letter('Gerar nota fiscal', 'N', 'darkred'), row('Imprimir', 'print', true), row('Imprimir etiqueta'), row('Imprimir para técnico'), row('Emitir boleto', 'barcode'), row('Enviar por e-mail', 'paper-plane'), row('Enviar por whatsapp', 'whatsapp'), row('Clonar ordem', 'clone'),
      ...states(['Orçada', 'Serviço concluído', 'Finalizada', 'Não aprovada', 'Aprovada', 'Em andamento', 'Aguardando componentes', 'Finalizada sem conserto', 'Em aberto'])],
    info: { count: 'Quantidade de serviços' },
  },
  produtos: {
    primaryAction: 'Incluir cadastro', selector: { label: 'Loja', options: LOJAS }, searchPlaceholder: 'Pesquisar por código, descrição ou GTIN', filterPanelOpen: true, selections: ['Com variações', 'Variações', 'Simples', 'Serviços', 'Todos', 'Nenhum'],
    filters: [select('status', 'Situação', ['Últimos Incluídos', 'Ativos', 'Inativos', 'Excluídos']), select('stockFilter', 'Estoque', ['Igual a zero', 'Menor que zero', 'Maior que zero']), select('hasImages', 'Imagens', ['Sim', 'Não']), select('lotControl', 'Lote', ['Sim', 'Não'], { info: LOTE }),
      select('tag', 'Tags', ['Reposição', 'Linha padrão', 'Sob encomenda']), select('category', 'Categoria', ['Componentes', 'Ferramentas', 'Consumíveis', 'Serviços']), select('ncmFilter', 'NCM', ['Sem NCM', 'Com NCM']),
      select('classification', 'Classificação', ['Mercadoria para revenda', 'Matéria-prima', 'Embalagem', 'Produto em processo', 'Produto acabado', 'Subproduto', 'Produto intermediário', 'Material de uso e consumo', 'Ativo imobilizado', 'Serviços', 'Outros']),
      select('productType', 'Tipo', ['Produtos com composição', 'Produtos sem composição', 'Simples', 'Variações', 'Serviços']), select('brand', 'Marca', ['Linha Aurora', 'Linha Horizonte', 'Sem marca']), select('supplier', 'Fornecedor', ['Fornecedor Modelo 01 (demo)', 'Fornecedor Modelo 02 (demo)', 'Fornecedor Modelo 03 (demo)']), select('supplierCode', 'Cód fornecedor', ['DEMO-F01', 'DEMO-F02', 'DEMO-F03'])],
    defaultFilters: { status: 'Últimos Incluídos' },
    panelActions: [act('Incluir categorias para selecionados', 'sitemap'), act('Imprimir etiquetas selecionadas', 'note-sticky')],
    moreActions: [{ title: 'Planilhas', items: ['Exportar dados para planilha', 'Exportar dados de estrutura para planilha'] }, { title: 'Edição', items: ['Incluir tags para selecionados', 'Reajuste e sincronização de preços', 'Transferir estoque dos produtos selecionados', 'Mudar situação de produtos selecionados'] }, { title: 'Listas de Preços', items: ['Criar lista de preço', 'Vincular a uma lista'] }],
    rowMenu: [row('Imprimir etiquetas', 'print'), row('Clonar produto', 'clone')],
    info: { count: 'Quantidade de Produtos', total: false },
  },
  contatos: {
    title: 'Clientes e Fornecedores', formTitle: 'Cliente ou Fornecedor', primaryAction: 'Incluir cadastro', searchPlaceholder: 'Pesquisar por nome, fantasia, e-mail, CPF ou CNPJ',
    selector: { label: 'Tipo de contato', options: ['Todos', 'Cliente', 'Fornecedor', 'Cliente e fornecedor', 'Transportadora'], filterKey: 'role' },
    filters: [select('role', 'Tipo de contato', ['Cliente', 'Fornecedor', 'Cliente e fornecedor', 'Transportadora'], { hidden: true }), select('status', 'Situação', ['Últimos incluídos', 'Ativos', 'Excluídos', 'Inativos', 'Sem movimento']), select('personType', 'Tipo de Pessoa', ['Pessoa física', 'Pessoa jurídica', 'Estrangeiro']),
      select('seller', 'Vendedor', ['Equipe Alfa (demo)', 'Equipe Beta (demo)', 'Equipe Gama (demo)']), select('phoneFilter', 'Telefone / Celular', ['Informado', 'Não informado']), select('emailFilter', 'E-mail', ['Com e-mail', 'Sem e-mail']), select('state', 'Estado', ['SP', 'MG', 'PR']), select('city', 'Município', ['Piracicaba / SP', 'Limeira / SP', 'Rio Claro / SP', 'Americana / SP']), select('priceList', 'Lista de preço', ['Padrão (demo)', 'Atacado (demo)', 'Manutenção (demo)'])],
    panelActions: [act('Exportar para a planilha', 'file-excel'), act('Imprimir etiquetas', 'note-sticky', 'Imprime as etiquetas dos registros selecionados'), act('Vincular a vendedor', 'briefcase', 'Vincular contato a um vendedor')],
    moreActions: [{ title: 'Imprimir', items: ['Contatos agrupados', 'Aniversariantes'] }],
    rowMenu: [row('Ficha financeira', 'credit-card'), row('Tornar vendedor', 'briefcase'), row('Comentários', 'comment')],
    info: { count: 'Quantidade de contatos', total: false },
  },
  vendedores: {
    primaryAction: 'Incluir um Vendedor', selector: { label: 'Nome da loja', options: ['Todas as lojas', 'FAGOO'] }, searchPlaceholder: 'Pesquisar',
    filters: [select('status', 'Situação', ['Ativo', 'Inativo'])], panelActions: [act('Enviar e-mail', 'envelope', 'Enviar e-mail aos selecionados')],
    rowMenu: [row('Ver Comissões', 'dollar-sign'), row('Enviar validação de e-mail', 'envelope'), row('Ativar MFA', 'shield-halved')], info: { count: 'Quantidade de vendedores', total: false },
  },
  'formas-pagamento': {
    title: 'Formas Pagamento', formTitle: 'Forma de pagamento', primaryAction: 'Incluir forma', searchPlaceholder: 'Pesquisar', defaultFilters: { status: 'Ativo' },
    filters: [select('kind', 'Método aplicável', ['Boleto', 'Pix recebido externamente', 'Dinheiro', 'Transferência', 'Cartão']), select('account', 'Conta financeira', ['Itaú — demonstração', 'Inter — demonstração', 'Caixa — demonstração']), select('status', 'Situação', ['Ativo', 'Inativo'])],
    rowMenu: [row('Forma padrão', 'gear'), row('Duplicar', 'clone'), row('Inativar', 'ban')], info: { count: 'Quantidade de formas de pagamento', total: false },
  },
  'categorias-produtos': {
    primaryAction: 'Incluir categoria', selector: { label: 'Loja', options: LOJAS }, searchPlaceholder: 'Pesquisar por descrição',
    panelActions: [act('Clonar categoria', 'clone')], rowMenu: [row('Incluir subcategoria', 'sitemap')], info: { count: 'Quantidade de categoria', total: false },
  },
  'listas-precos': { primaryAction: 'Incluir lista', searchPlaceholder: 'Pesquisar', info: { count: 'Quantidade de listas de preços', total: false } },
  'contas-financeiras': {
    primaryAction: 'Incluir conta financeira', searchPlaceholder: 'Pesquisar', filterPanelOpen: true, defaultFilters: { status: 'Ativo' },
    panelActions: [act('Atualizar contas financeiras', 'file-signature')], info: { count: 'Quantidade de contas financeiras', total: false },
  },
  'categorias-financeiras': {
    primaryAction: 'Incluir categoria de receitas', searchPlaceholder: 'Pesquise por nome da categoria..', listTabs: undefined,
    panelActions: [act('Categorização para DRE', 'tag'), act('Mover categorias', 'right-left'), act('Importar categorias', 'tag'), act('Exportar', 'file-export')], info: { count: 'Quantidade de categorias', total: false },
  },
  compras: {
    title: 'Pedidos de compra', formTitle: 'Pedido de compra', primaryAction: 'Incluir pedido', searchPlaceholder: 'Pesquisa por nome, número do pedido ou ordem de compra', periodTypes: ['Período', 'Previstos para'],
    columns: [{ key: 'number', label: 'Número' }, { key: 'date', label: 'Data', type: 'date' }, { key: 'customer', label: 'Fornecedor' }, { key: 'internalNotes', label: 'Observação interna' }, { key: 'total', label: 'Total', type: 'money' }, { key: 'status', label: 'Situação', type: 'status' }],
    filters: [multi('status', 'Situação', ['Em aberto', 'Em andamento', 'Atendido', 'Cancelado', 'Atendido parcialmente']), text('product', 'Produto'), text('lot', 'Lote', LOTE), text('internalNotes', 'Observação interna')], indicatorKey: 'indicators',
    panelActions: [act('Exportar para a planilha', 'file-excel'), act('Imprimir etiquetas', 'note-sticky', 'Imprimir etiquetas selecionadas'), act('Imprimir selecionados', 'square-check')],
    moreActions: [{ title: 'Outras', items: ['Mudar situação dos pedidos selecionados'] }],
    rowMenu: [letter('Lançar estoque', 'E', 'blue'), letter('Lançar contas', 'C', 'green'), letter('Gerar nota fiscal', 'N', 'darkred'), row('Imprimir', 'print', true), row('Imprimir etiquetas', 'note-sticky'), row('Enviar por e-mail', 'envelope'), row('Enviar por whatsapp', 'whatsapp'), row('Clonar compra', 'clone'), ...states(['Atendido', 'Cancelado', 'Em andamento', 'Em aberto'])],
    info: { count: 'Quantidade de pedidos' },
  },
  'notas-entrada': {
    title: 'Notas Fiscais de Entrada', formTitle: 'Nota fiscal', primaryAction: 'Incluir nota fiscal', selector: { label: 'Loja', options: LOJAS }, searchPlaceholder: 'Pesquisar por nome, CPF/CNPJ ou n° da nota', periodTypes: ['Data de entrada', 'Data de emissão'], periodPrefix: true,
    filters: [select('status', 'Situação', ['Registrada', 'Cancelada', 'Pendente de conferência']), text('product', 'Produto'), text('lot', 'Lote', LOTE), select('state', 'UF', UFS)], indicatorKey: 'indicators',
    panelActions: [act('Enviar NF-es selecionadas', 'paper-plane', 'Enviar notas selecionadas'), act('Imprimir NF-es selecionadas', 'print', 'Imprimir notas selecionadas'), act('Enviar notas pendentes', 'calendar-xmark'), act('Gerar PDF DANFE', 'file-pdf'), act('Exportar XML', 'file-code'), act('Imprimir DANFE Simplificado em lote', 'print')],
    moreActions: [{ title: 'Importar', items: ['Pedido XML', 'XML NF-e'] }, { title: 'Imprimir', items: ['Etiquetas selecionadas'] }, { title: 'Outros', items: ['Inutilizar numeração', 'Vincular à pedido de compra', 'Desvincular pedido compra'] }],
    rowMenu: [row('Enviar por e-mail', 'paper-plane'), row('Enviar por Whatsapp', 'whatsapp'), row('Enviar espelho NF'), row('Outras opções de NF-e'), row('NFe complementar'), letter('Lançar contas', 'C', 'green', true), letter('Lançar estoque', 'E', 'blue'), row('Gerar devolução', 'turn-down'), row('Check-in de Recebimentos', 'file-signature'), row('Formação de preços', 'file-invoice-dollar'), row('Clonar nota', 'clone', true), row('Clonar para saída'), row('Imprimir etiquetas', 'print'), row('Imprimir espelho NF', 'print')],
    info: { count: 'Quantidade de notas' },
  },
  estoque: {
    title: 'Estoque', primaryAction: 'Incluir lançamento', searchPlaceholder: 'Pesquise por código, descrição ou GTIN', selector: { label: 'Depósito', options: ['Todos os depósitos', 'Geral (demo)', 'Reserva (demo)', 'Assistência (demo)'], filterKey: 'warehouse' },
    filters: [select('warehouse', 'Depósito', ['Geral (demo)', 'Reserva (demo)', 'Assistência (demo)'], { hidden: true }), select('movementType', 'Tipo', ['Entrada', 'Saída', 'Balanço']), select('originType', 'Tipo de Origem', ['Notas Fiscais', 'Vendas', 'Compras', 'Serviços', 'Transferências', 'Sem origem', 'Origem excluída']), select('product', 'Produto', ['Rolamento de apoio', 'Correia de transmissão', 'Conjunto de vedação', 'Parafuso sextavado', 'Porca de fixação'])],
    panelActions: [act('Gerenciar produtos', 'up-right-from-square'), act('Transferência entre depósitos', 'shuffle'), act('Mostrar totalizador estoque', 'eye')],
    info: { count: 'Quantidade de lançamentos', total: false },
  },
  'conferencia-estoque': { primaryAction: 'Incluir conferência', info: { count: 'Quantidade de conferências', total: false } },
  depositos: { primaryAction: 'Incluir depósito', searchPlaceholder: 'Pesquisar por descrição', info: { count: 'Quantidade de depósitos', total: false } },
  'caixas-bancos': {
    title: 'Caixas e Bancos', primaryAction: 'Incluir lançamento', readOnly: false, searchPlaceholder: 'Pesquisa por nome ou histórico',
    selector: { label: 'Conta financeira', options: ['Todas contas', 'Itaú — demonstração', 'Inter — demonstração', 'Caixa — demonstração'], filterKey: 'account' },
    columns: [{ key: 'date', label: 'Data', type: 'date' }, { key: 'category', label: 'Categoria' }, { key: 'description', label: 'Histórico' }, { key: 'customer', label: 'Cliente/Fornecedor' }, { key: 'value', label: 'Valor', type: 'money', signed: true }],
    filters: [select('account', 'Conta financeira', ['Itaú — demonstração', 'Inter — demonstração', 'Caixa — demonstração'], { hidden: true }), select('category', 'Categoria', ['Venda de produtos', 'Serviços', 'Compra de mercadorias', 'Despesas operacionais', 'Tarifas bancárias', 'Transferências']), select('movementType', 'Situação', ['Entrada', 'Saída', 'Transferência'])],
    panelActions: [act('Transferência entre contas', 'comments-dollar'), act('Alterar categorias', 'bookmark'), act('Ajustar saldos', 'pen-to-square', 'Ajuste de saldo')],
    supportLinks: [{ label: 'Importação de registros financeiros' }], info: { count: 'Quantidade de registros' },
  },
  'contas-receber': {
    formTitle: 'Conta a receber', formStyle: 'drawer', primaryAction: 'Incluir conta', searchPlaceholder: 'Pesquise por nome, e-mail, CPF/CNPJ, número ou histórico', selector: { label: 'Conta financeira', options: CONTAS, filterKey: 'account' },
    filters: [select('account', 'Conta financeira', CONTAS.slice(1), { hidden: true }), select('option', 'Opção', ['Em aberto', 'Atrasadas', 'Emitidas', 'Recebidas']), select('category', 'Categoria', ['Venda de produtos', 'Serviços', 'Outras receitas']), select('paymentType', 'Tipo de pagamento', ['Dinheiro', 'Cartão de crédito', 'Cartão de débito', 'Boleto bancário', 'Depósito bancário', 'Pix', 'Transferência bancária', 'Outros']),
      select('paymentMethod', 'Forma de pagamento', ['Boleto', 'Pix recebido externamente', 'Dinheiro', 'Transferência', 'Cartão']), select('remittanceStatus', 'Em remessa', ['Incluídas em remessa', 'Não incluídas']), select('valueRange', 'Valor', ['Até R$ 500', 'De R$ 500 a R$ 1.000', 'Acima de R$ 1.000']), select('seller', 'Vendedor', ['Equipe Alfa (demo)', 'Equipe Beta (demo)', 'Equipe Gama (demo)'])],
    indicatorKey: 'indicators',
    panelActions: [act('Baixar selecionados', 'circle-check'), act('Alterar categorias', 'bookmark', 'Atualizar categorias selecionados'), act('Gerar remessa', 'circle-right', 'Gerar remessa selecionados'), act('Gerar boletos em PDF', 'barcode'), act('Enviar boletos por email', 'envelope'), act('Gerar recibos', 'print'), act('Enviar e-mail de cobrança', 'envelope')],
    rowMenu: [row('Baixa total do recebimento', 'check'), row('Baixa parcial do recebimento'), row('Cancelar boleto', 'ban'), row('Imprimir recibo', 'print', true), row('Imprimir duplicata'), row('Emitir boleto', 'barcode'), row('Enviar por e-mail', 'paper-plane'), row('Enviar por whatsapp', 'whatsapp'), row('Acessar remessa', 'up-right-from-square', true), row('Retirar da remessa', 'circle-xmark'), row('Excluir', 'trash-can', true)],
    supportLinks: FINANCE_SUPPORT, info: { count: 'Quantidade de contas a receber' },
  },
  'contas-pagar': {
    formTitle: 'Conta a pagar', formStyle: 'drawer', primaryAction: 'Incluir conta', searchPlaceholder: 'Pesquise por nome, e-mail, CPF/CNPJ ou histórico', selector: { label: 'Conta financeira', options: CONTAS, filterKey: 'account' },
    filters: [select('account', 'Conta financeira', CONTAS.slice(1), { hidden: true }), select('option', 'Opção', ['Em aberto', 'Atrasadas', 'Emitidas', 'Pagas', 'Em processamento']), select('category', 'Categoria', ['Compra de mercadorias', 'Despesas operacionais', 'Manutenção']), select('paymentType', 'Tipo de pagamento', ['Dinheiro', 'Cartão de crédito', 'Cartão de débito', 'Boleto bancário', 'Depósito bancário', 'Pix', 'Transferência bancária', 'Outros']),
      select('paymentMethod', 'Forma de pagamento', ['Boleto', 'Pix recebido externamente', 'Dinheiro', 'Transferência', 'Cartão']), select('valueRange', 'Valor', ['Até R$ 500', 'De R$ 500 a R$ 1.000', 'Acima de R$ 1.000']), select('number', 'N° documento', ['CP-DEMO-2001', 'CP-DEMO-2002', 'CP-DEMO-2003'])],
    indicatorKey: 'indicators',
    panelActions: [act('Baixar selecionados', 'circle-check'), act('Alterar categorias', 'bookmark', 'Atualizar categorias selecionados'), act('Imprimir agrupado por fornecedor', 'dolly'), act('Gerar recibos', 'print')],
    rowMenu: [row('Baixa total do pagamento', 'check'), row('Baixa parcial do pagamento'), row('Cancelar', 'ban'), row('Excluir', 'trash-can', true)],
    supportLinks: [{ label: 'Gerenciar pagamentos' }, ...FINANCE_SUPPORT.slice(1)], info: { count: 'Quantidade de contas a pagar' },
  },
  'remessas-retornos': {
    title: 'Remessas', primaryAction: 'Incluir Remessa', readOnly: false, searchPlaceholder: 'Pesquisar',
    panelActions: [act('Ver retornos', 'circle-left'), act('Configurar contas', 'building-columns'), act('Gerar remessa', 'rotate-right'), act('Imprimir Boletos', 'print')], info: { count: 'Quantidade de remessas', total: false },
  },
  'ficha-financeira': {
    title: 'Ficha Financeira', selector: { label: 'Tipo', options: ['Todas as contas', 'Contas a pagar', 'Contas a receber'] }, searchPlaceholder: 'Pesquisar',
    panelActions: [act('Lançar crédito', 'circle-plus'), act('Lançar débito', 'circle-minus')], info: { count: 'Quantidade de contatos' },
  },
  comissoes: { panelActions: [act('Pagamento', 'credit-card'), act('Outro lançamento', 'money-bill-1', 'Outro lançamento manualmente')], info: { count: 'Quantidade de comissoes' } },
  'controle-caixa': { info: { count: 'Quantidade de controles' } },
  'faturamento-agrupado': { info: { count: 'Quantidade de agrupamentos' } },
};

export function withOriginList(module: ModuleDefinition): ModuleDefinition {
  const extra = ORIGIN_LISTS[module.id];
  if (!extra) return module;
  const merged: ModuleDefinition = { ...module, ...extra };
  if ('listTabs' in extra && extra.listTabs === undefined) delete (merged as { listTabs?: unknown }).listTabs;
  return merged;
}
