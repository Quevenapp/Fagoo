// Preferências › Vendas, Propostas comerciais, Serviços › Ordens de serviço e Suprimentos › Pedidos de compra, read by the
// document screens (docs/integrations/documentos-origin-paridade.md). Unreadable pages (profile without access, database
// before 115) keep the defaults of the schema, which are the behaviour the Brufap had before reading them.
import { parsePreferencesPage, type PreferencesPageView } from '../../../../packages/erp-domain/src/preferences/dto.mjs';
import { preferencePage } from '../../../../packages/erp-domain/src/preferences/catalog.mjs';
import { storedFields, type PreferenceValue } from '../../../../packages/erp-domain/src/preferences/core.mjs';
import type { DocumentKind } from './real-documents-model.ts';

export const DOCUMENT_PREFERENCE_PAGES: Record<DocumentKind, string> = { sales_orders: 'vendas-vendas', sales_proposals: 'vendas-propostas', service_orders: 'servicos-os', purchase_orders: 'suprimentos-compras' };
export type SectionMode = 'sim' | 'opcional' | 'nao';
export type InstallmentBase = 'date' | 'ship_date' | 'expected_date';
// 202610200268: the Serviços labels (Descrição, Código, Quantidade, Valor, Orçar and Observações) of the separate Serviços executados grid.
export type OsLabel = 'cliente' | 'equipamento' | 'numero_serie' | 'problema' | 'observacoes_recebimento' | 'data_entrada' | 'peca_descricao'
  | 'servico_descricao' | 'servico_codigo' | 'servico_quantidade' | 'servico_valor' | 'servico_orcar' | 'servico_observacoes';
const OS_LABELS: readonly OsLabel[] = ['cliente', 'equipamento', 'numero_serie', 'problema', 'observacoes_recebimento', 'data_entrada', 'peca_descricao',
  'servico_descricao', 'servico_codigo', 'servico_quantidade', 'servico_valor', 'servico_orcar', 'servico_observacoes'];
export interface DocumentPrintPreferences {
  /** Origin "Exibir descrição complementar nos itens" (pedido, proposta e compra). */
  detailedDescription: boolean; itemNumber: boolean; quantitySum: boolean; contactCode: boolean; ncm: boolean; location: boolean;
  /** Leva H (PRF-133, VND-315): "Exibir colunas adicionais para Peças" — the Marca of the product of the cadastro (no field is invented). */
  brand?: boolean;
  quantities: boolean; values: boolean; totals: boolean; dueDates: boolean; listDiscount: boolean;
  order: 'insertion' | 'alphabetical' | 'code' | 'location'; title: string | null; dueLabel: string | null; signatureLabel: string | null; signature: boolean;
  hideValues: boolean; hideContact: boolean; secondaryCode: 'nenhum' | 'codigo_fornecedor' | 'gtin' | 'gtin_tributario';
  /** Vendas "Título" (Número pedido) and "Seção auxiliar" (Número da ordem de compra) of the printed pedido. */
  titleNumber: boolean; auxiliaryPo: boolean;
  /** Serviços "Mensagem padrão para envio de OS por Whatsapp" (null keeps the summary of the OS). */
  whatsappTemplate: string | null;
  /** Vendas "Código utilizado na venda detalhada". */
  detailedCode: 'codigo' | 'gtin' | 'gtin_tributario';
  /** Vendas "Configuração de Impressão do Comprovante" (comprovante não fiscal). */
  receipt: { limitDescription: boolean; code: boolean; notes: boolean; comments: boolean; discount: boolean; footer: string | null; fontSize: number; location?: boolean };
  /** Serviços "Data base da garantia" (202610200168): the end of the garantia printed with the OS (Não utilizar prints none). */
  warrantyBase: WarrantyBase;
  /** 202610200240 Vendas: "Código de barras do código", "Código de barras no número do título" and "Substituir endereço do contato com o alternativo". */
  codeBarcode: boolean; titleBarcode: boolean; alternativeAddress: boolean;
  /** 202610200240 Propostas "Exibir campos de data da aprovação e assinatura do cliente"; Serviços "Imprimir pessoas de contato". */
  approvalFields: boolean; contactPersons: boolean;
  /** 202610200240 Vendas "Configuração de Impressão do Relatório de Produção". */
  production: { itemNumber: boolean; carrierAddress: boolean; structure: boolean; clientData: boolean; detailedDescription: boolean; location?: boolean };
  /** 202610200270 "Exibir tipo de cabeçalho": Padrão do Sistema (logotipo e identidade) or Personalizado (the header of the kind). */
  headerType: 'padrao' | 'personalizado';
  /** 202610200294 Vendas "Imprimir rodapé pela impressão normal" and "Exibir descrição do produto no fornecedor"; Vendas "Exibir imagem
   * do produto na venda detalhada" / Propostas "Exibir imagem de produtos"; Compras "Exibir IPI". */
  footer: boolean; supplierDescription: boolean; images: boolean; ipi: boolean;
}
export type WarrantyBase = 'nao_utilizar' | 'data_os' | 'data_prevista' | 'data_conclusao' | 'data_saida';
const WARRANTY_BASES: readonly WarrantyBase[] = ['nao_utilizar', 'data_os', 'data_prevista', 'data_conclusao', 'data_saida'];
/** Same rule as erp_documents.warranty_until (SQL 168): the garantia (dias) counted from the chosen date of the OS. */
export function warrantyUntil(input: { warranty_days?: string | null; date?: string | null; expected_date?: string | null; finish_date?: string | null; ship_date?: string | null }, base: WarrantyBase): string | null {
  if (base === 'nao_utilizar' || !input.warranty_days || !/^(0|[1-9]\d{0,3})$/.test(input.warranty_days)) return null;
  const from = base === 'data_os' ? input.date : base === 'data_prevista' ? input.expected_date || input.date : base === 'data_conclusao' ? input.finish_date || input.date : input.ship_date || input.date;
  if (!from || !/^\d{4}-\d{2}-\d{2}$/.test(from)) return null;
  const day = new Date(`${from}T00:00:00Z`); if (!Number.isFinite(day.getTime())) return null;
  day.setUTCDate(day.getUTCDate() + Number(input.warranty_days));
  return day.toISOString().slice(0, 10);
}
export interface DocumentPreferences {
  kind: DocumentKind; loaded: boolean;
  observation: string; numberEditable: boolean; installmentBase: InstallmentBase; sumGrossWeight: boolean; totalsVisible: boolean;
  freightFirstInstallment: boolean; showDetails: SectionMode; showAdditional: SectionMode; showCarrier: SectionMode; freeItems: boolean;
  nextContactRequired: boolean; repeatedItems: boolean; labels: Partial<Record<OsLabel, string>>; print: DocumentPrintPreferences;
  /** OS: "Inserção de dados da OS por partes" and "Exibir desconto e preço de lista dos itens". */
  receptionInParts: boolean; showListDiscount: boolean;
  /** 202610200164 "Vendedor obrigatório" (pedidos, propostas except modelos, OS). */
  sellerRequired: boolean;
  /** Vendas "Permite a visualização das contas a receber em aberto nos pedidos" / Suprimentos "... a pagar ..." (financeiro, SQL 172). */
  openTitles: boolean;
}
type Values = Record<string, PreferenceValue>;
const defaultsOf = (pageId: string): Values => Object.fromEntries(storedFields(preferencePage(pageId)!).map(field => [field.key, field.default as PreferenceValue]));
const bool = (values: Values, key: string) => values[key] === true;
const text = (values: Values, key: string) => typeof values[key] === 'string' ? values[key] as string : '';
const label = (values: Values, key: string) => { const value = text(values, key).trim(); return value || null; };
const BASES: Record<string, InstallmentBase> = { data_venda: 'date', data_os: 'date', data_compra: 'date', data_saida: 'ship_date', data_prevista: 'expected_date' };
const ORDERS: Record<string, DocumentPrintPreferences['order']> = { insercao: 'insertion', alfabetica: 'alphabetical', codigo: 'code', localizacao: 'location' };

/** Typed view of one page; `userId` decides "Exibir totais em listas … para os usuários" of the pedidos. */
export function documentPreferences(kind: DocumentKind, view: PreferencesPageView | null, userId: string | null, productsView: PreferencesPageView | null = null): DocumentPreferences {
  // Leva H (PRD-126, PRF-055): Cadastros › Configurações de produtos "Exibir localização no recibo não fiscal / no Relatório de Produção".
  const products: Values = { ...defaultsOf('cadastros-produtos'), ...(productsView ? Object.fromEntries(productsView.items.map(item => [item.key, item.value])) : {}) };
  const pageId = DOCUMENT_PREFERENCE_PAGES[kind], values: Values = { ...defaultsOf(pageId), ...(view ? Object.fromEntries(view.items.map(item => [item.key, item.value])) : {}) };
  const prefix = { sales_orders: 'vendas', sales_proposals: 'propostas', service_orders: 'os', purchase_orders: 'compras' }[kind];
  const mode = (key: string): SectionMode => ['sim', 'opcional', 'nao'].includes(values[key] as string) ? values[key] as SectionMode : 'sim';
  const users = Array.isArray(values['vendas.exibir_totais_usuarios']) ? values['vendas.exibir_totais_usuarios'] as string[] : [];
  const totalsVisible = kind === 'purchase_orders' ? true : kind === 'sales_orders' ? bool(values, 'vendas.exibir_totais') && (!users.length || Boolean(userId && users.includes(userId))) : bool(values, `${prefix}.exibir_totais`);
  const p = (key: string) => bool(values, `${prefix}.imprimir_${key}`);
  const labels: Partial<Record<OsLabel, string>> = {};
  if (kind === 'service_orders') for (const key of OS_LABELS) { const value = label(values, `os.rotulo_${key}`); if (value) labels[key] = value; }
  return {
    kind, loaded: Boolean(view),
    observation: text(values, `${prefix}.observacao_padrao`),
    numberEditable: bool(values, `${prefix}.editar_numero`),
    installmentBase: BASES[values[`${prefix}.data_parcelas`] as string] ?? 'date',
    sumGrossWeight: bool(values, `${prefix}.somar_peso_bruto`), totalsVisible,
    freightFirstInstallment: kind === 'sales_orders' && bool(values, 'vendas.frete_primeira_parcela'),
    showDetails: kind === 'sales_orders' ? mode('vendas.exibir_detalhes') : 'sim', showAdditional: kind === 'sales_orders' ? mode('vendas.exibir_dados_adicionais') : 'sim',
    showCarrier: kind === 'sales_orders' ? mode('vendas.exibir_transportadora') : kind === 'sales_proposals' && values['propostas.exibir_transportadora'] === 'nao' ? 'nao' : 'sim',
    freeItems: kind !== 'sales_orders' || values['vendas.produtos_nao_cadastrados'] !== false,
    nextContactRequired: kind === 'sales_proposals' && bool(values, 'propostas.proximo_contato_obrigatorio'),
    repeatedItems: kind !== 'service_orders' || values['os.itens_repetidos'] !== false,
    labels,
    openTitles: kind === 'sales_orders' ? bool(values, 'vendas.ver_contas_receber') : kind === 'purchase_orders' && bool(values, 'compras.ver_contas_pagar'),
    receptionInParts: kind === 'service_orders' && bool(values, 'os.insercao_partes'), showListDiscount: kind === 'service_orders' && bool(values, 'os.desconto_lista'),
    sellerRequired: kind !== 'purchase_orders' && bool(values, `${prefix}.vendedor_obrigatorio`),
    print: {
      detailedDescription: kind === 'service_orders' ? true : kind === 'purchase_orders' ? bool(values, 'compras.imprimir_descricao_complementar') : p('descricao_complementar'),
      itemNumber: kind === 'sales_orders' || kind === 'sales_proposals' ? p('numero_item') : true,
      quantitySum: kind === 'sales_orders' && p('soma_quantidades'), contactCode: kind === 'sales_orders' && p('codigo_cliente'),
      ncm: (kind === 'sales_orders' || kind === 'sales_proposals') && p('ncm'),
      brand: (kind === 'sales_orders' || kind === 'service_orders') && bool(values, 'vendas.imprimir_colunas_pecas'),
      location: kind === 'sales_orders' ? p('localizacao') : kind === 'service_orders' ? bool(values, 'os.imprimir_localizacao') : kind === 'purchase_orders' && bool(values, 'compras.imprimir_localizacao'),
      quantities: kind !== 'sales_proposals' || p('quantidades'), values: kind !== 'sales_proposals' || p('valores'), totals: kind !== 'sales_proposals' || p('totais'),
      dueDates: kind === 'sales_proposals' ? p('vencimento_parcelas') : kind === 'purchase_orders' ? bool(values, 'compras.imprimir_vencimento_parcelas') : true,
      listDiscount: kind === 'sales_orders' || kind === 'sales_proposals' ? p('desconto_lista') : kind === 'service_orders' && bool(values, 'os.imprimir_desconto_lista'),
      order: kind === 'sales_orders' ? ORDERS[values['vendas.imprimir_ordem'] as string] ?? 'insertion' : 'insertion',
      title: kind === 'purchase_orders' ? label(values, 'compras.rotulo_titulo') : null,
      dueLabel: kind === 'service_orders' ? label(values, 'os.rotulo_vencimento') : null,
      signatureLabel: kind === 'service_orders' ? label(values, 'os.rotulo_assinatura') : null, signature: kind === 'service_orders' && bool(values, 'os.exibir_assinatura'),
      hideValues: kind === 'service_orders' && bool(values, 'os.ocultar_valores'), hideContact: kind === 'service_orders' && bool(values, 'os.ocultar_cliente'),
      titleNumber: kind !== 'sales_orders' || !Array.isArray(values['vendas.imprimir_titulo']) || (values['vendas.imprimir_titulo'] as string[]).includes('numero_pedido'),
      whatsappTemplate: kind === 'service_orders' ? label(values, 'os.mensagem_whatsapp') : null,
      auxiliaryPo: kind === 'sales_orders' && Array.isArray(values['vendas.imprimir_secao_auxiliar']) && (values['vendas.imprimir_secao_auxiliar'] as string[]).includes('ordem_compra'),
      detailedCode: kind === 'sales_orders' && ['gtin', 'gtin_tributario'].includes(values['vendas.imprimir_codigo'] as string) ? values['vendas.imprimir_codigo'] as 'gtin' | 'gtin_tributario' : 'codigo',
      warrantyBase: kind === 'service_orders' && WARRANTY_BASES.includes(values['os.garantia_base'] as WarrantyBase) ? values['os.garantia_base'] as WarrantyBase : 'nao_utilizar',
      receipt: { limitDescription: bool(values, 'vendas.comprovante_limitar_descricao'), code: bool(values, 'vendas.comprovante_codigo'), notes: bool(values, 'vendas.comprovante_observacao'), comments: bool(values, 'vendas.comprovante_comentario'),
        discount: bool(values, 'vendas.comprovante_desconto'), footer: label(values, 'vendas.comprovante_rodape'), fontSize: typeof values['vendas.comprovante_fonte'] === 'number' ? values['vendas.comprovante_fonte'] as number : 12, location: kind === 'sales_orders' && bool(products, 'produtos.localizacao_recibo') },
      secondaryCode: kind === 'purchase_orders' && ['nenhum', 'codigo_fornecedor', 'gtin', 'gtin_tributario'].includes(values['compras.codigo_secundario'] as string) ? values['compras.codigo_secundario'] as DocumentPrintPreferences['secondaryCode'] : 'nenhum',
      codeBarcode: kind === 'sales_orders' && p('codigo_barras'), titleBarcode: kind === 'sales_orders' && p('codigo_barras_titulo'), alternativeAddress: kind === 'sales_orders' && p('endereco_alternativo'),
      approvalFields: kind === 'sales_proposals' && p('aprovacao'), contactPersons: kind === 'service_orders' && bool(values, 'os.imprimir_contatos'),
      production: { itemNumber: kind === 'sales_orders' && bool(values, 'vendas.producao_numero_item'), carrierAddress: kind === 'sales_orders' && bool(values, 'vendas.producao_endereco_transportadora'),
        structure: kind === 'sales_orders' && bool(values, 'vendas.producao_estrutura'), clientData: kind === 'sales_orders' && bool(values, 'vendas.producao_dados_cliente'),
        detailedDescription: kind === 'sales_orders' && bool(values, 'vendas.producao_descricao_complementar'), location: kind === 'sales_orders' && bool(products, 'produtos.localizacao_relatorio_producao') },
      headerType: values[`${prefix}.tipo_cabecalho`] === 'personalizado' ? 'personalizado' : 'padrao',
      footer: kind === 'sales_orders' && p('rodape'), supplierDescription: kind === 'sales_orders' && p('descricao_fornecedor'),
      images: (kind === 'sales_orders' || kind === 'sales_proposals') && p('imagem'), ipi: kind === 'purchase_orders' && bool(values, 'compras.imprimir_ipi'),
    },
  };
}
export const defaultDocumentPreferences = (kind: DocumentKind) => documentPreferences(kind, null, null);

type PreferencesPort = { preferences?: (path: string, options?: { signal?: AbortSignal }) => Promise<unknown>; getSnapshot?: () => { membership?: { user_id?: string } | null } | null };
/** Reads the page of the document kind; any failure keeps the defaults (the server still enforces every rule). */
export async function readDocumentPreferences(controller: PreferencesPort, kind: DocumentKind, signal: AbortSignal): Promise<DocumentPreferences> {
  const userId = controller.getSnapshot?.()?.membership?.user_id ?? null;
  if (typeof controller.preferences !== 'function') return defaultDocumentPreferences(kind);
  const pageId = DOCUMENT_PREFERENCE_PAGES[kind];
  const view = parsePreferencesPage(await controller.preferences(`/v1/preferencias/${pageId}`, { signal }), pageId);
  // The products page is read for the location options only; without it (another profile, a failure) they stay off.
  const productsView = kind === 'sales_orders' ? await controller.preferences('/v1/preferencias/cadastros-produtos', { signal }).then(value => parsePreferencesPage(value, 'cadastros-produtos')).catch(() => null) : null;
  return documentPreferences(kind, view, userId, productsView);
}
