import { CatalogValidationError } from './catalog-base.ts';
import { isoDateValid, type ContactRecord } from './contact-form-model.ts';

// Cadastros > Vendedores no padrão do Origin (lane contatos, migração 126): o vendedor é um contato com as configurações
// abaixo. Somente "Usuário do sistema" já tem efeito (Contato acessível somente ao vendedor vinculado); as demais ficam
// guardadas para pedidos, propostas, OS e comissões, que ainda não as consultam; o módulo Frente de Caixa é aplicado pela
// frente de caixa (migrações 202610200204-206).
export interface SellerSettings {
  user_id: string | null; allow_unregistered_products: boolean; view_stock: boolean; access_hours_enabled: boolean;
  access_windows: { start: string; end: string; days: number[] }[]; modules: Record<string, boolean>;
  commission_rule: 'parcial' | 'faturamento' | 'primeira_parcela' | 'ultima_parcela'; commission_mode: 'fixa' | 'descontos';
  commission_rate: string | null; commission_bands: { discount_up_to: string; rate: string }[]; discount_limit: string; notes: string | null;
}
export interface SellerRecord extends SellerSettings { id: string; contact_id: string; version: number; user_name: string | null; created_at: string; updated_at: string }
export interface SellerEnvelope { seller: SellerRecord; contact: ContactRecord; can_write?: boolean; users?: { user_id: string; name: string | null; role: string }[] }
export const EMPTY_SETTINGS: SellerSettings = { user_id: null, allow_unregistered_products: false, view_stock: false, access_hours_enabled: false, access_windows: [], modules: {},
  commission_rule: 'parcial', commission_mode: 'fixa', commission_rate: null, commission_bands: [], discount_limit: '0', notes: null };
export const COMMISSION_RULES = [{ value: 'parcial', label: 'Liberação parcial vinculada ao pagamento das parcelas' }, { value: 'faturamento', label: 'Liberação integral no faturamento (lançamento de contas)' },
  { value: 'primeira_parcela', label: 'Liberação integral após o pagamento da primeira parcela' }, { value: 'ultima_parcela', label: 'Liberação integral após o pagamento da última parcela' }] as const;
export const WEEK_DAYS = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'] as const;
export const WEEK_DAY_NAMES = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'] as const;
// Módulos que podem ser acessados pelo vendedor (Origin VF-09 e VF-12): caixa com o módulo e as permissões recuadas.
export const SELLER_MODULES: readonly { key: string; label: string; children?: readonly { key: string; label: string }[] }[] = [
  { key: 'clientes', label: 'Clientes', children: [{ key: 'clientes_limite_credito', label: 'Permite editar limite de crédito dos clientes' }, { key: 'clientes_ver_clientes', label: 'Visualizar clientes' },
    { key: 'clientes_ver_fornecedores', label: 'Visualizar fornecedores' }, { key: 'clientes_ver_tecnicos', label: 'Visualizar técnicos' }, { key: 'clientes_ver_transportadores', label: 'Visualizar transportadores' },
    { key: 'clientes_ver_vendedores', label: 'Visualizar vendedores' }, { key: 'clientes_ver_desenvolvedores', label: 'Visualizar desenvolvedores' }] },
  { key: 'listas_precos', label: 'Listas de Preços' }, { key: 'comissoes', label: 'Comissões' }, { key: 'controle_caixa', label: 'Controle de Caixa' },
  { key: 'frente_caixa', label: 'Frente de Caixa', children: [{ key: 'pdv_registro_itens', label: 'Registro de Itens' }, { key: 'pdv_registro_pagamento', label: 'Registro de Pagamento' },
    { key: 'pdv_fechamento', label: 'Fechamento da Venda' }, { key: 'pdv_editar_preco', label: 'Editar o preço unitário' }, { key: 'pdv_exclusao_itens', label: 'Exclusão de itens' },
    { key: 'pdv_alterar_forma_pagamento', label: 'Permite alterar a forma de pagamento das parcelas' }, { key: 'pdv_gerenciador_pos', label: 'Gerenciador de POS no frente de caixa e formas de pagamentos' }] },
  { key: 'pedidos_venda', label: 'Pedidos de Venda', children: [{ key: 'pedidos_exportar', label: 'Exportar dados para planilha' }, { key: 'pedidos_alterar_forma_pagamento', label: 'Permite alterar a forma de pagamento das parcelas' }] },
  { key: 'visualizacao_lote', label: 'Visualização de lote' },
  { key: 'propostas', label: 'Propostas comerciais', children: [{ key: 'propostas_outros_vendedores', label: 'Pode acessar propostas comerciais de outros vendedores' }, { key: 'propostas_alterar_status', label: 'Pode alterar status das propostas comerciais' },
    { key: 'propostas_exportar', label: 'Exportar dados para planilha' }] },
  { key: 'gerenciador_arquivos', label: 'Gerenciador de Arquivos' }, { key: 'relatorio_controle_caixa', label: 'Relatório de controle de caixa' }, { key: 'relatorio_saldos_estoque', label: 'Relatório de saldos em estoque' },
  { key: 'relatorio_vendas', label: 'Relatório de vendas' }, { key: 'relatorio_visao_financeira_estoque', label: 'Relatório de visão financeira de estoque' },
  { key: 'ordens_servico', label: 'Ordens de Serviço', children: [{ key: 'os_alterar_forma_pagamento', label: 'Permite alterar a forma de pagamento das parcelas' }, { key: 'os_permitir_exclusao', label: 'Permitir exclusão de ordens de serviço' }] },
];
export const ALL_MODULE_KEYS = SELLER_MODULES.flatMap(module => [module.key, ...(module.children ?? []).map(child => child.key)]);
// Contact fields of the Vendedor form (VF-01, VF-03): "Campos obrigatórios" demands only these here, as the SQL does
// (erp_catalog.seller_contact_fields, migration 126).
export const SELLER_CONTACT_FIELDS = ['name', 'code', 'trade_name', 'person_type', 'document', 'taxpayer', 'ie', 'rg', 'birth_date', 'country', 'postal_code', 'state', 'city', 'district', 'street', 'number',
  'complement', 'phone', 'mobile', 'email'] as const;
export const sellerRequiredFields = (required: readonly string[]) => required.filter(key => (SELLER_CONTACT_FIELDS as readonly string[]).includes(key));
const PERCENT = /^(0|[1-9]\d?|100)([.,]\d{1,4})?$/;
const percent = (field: string, label: string, value: string, nullable: boolean) => {
  const text = value.trim().replace(',', '.');
  if (!text) { if (nullable) return null; throw new CatalogValidationError(field, `Informe ${label}.`); }
  if (!PERCENT.test(text) || (text.startsWith('100') && /[1-9]/.test(text.slice(4)))) throw new CatalogValidationError(field, `Informe ${label} entre 0 e 100, com até quatro casas decimais.`);
  return text;
};
/** Settings exactly as the API takes them (decimal strings, sorted bands, only checked modules). */
export function sellerSettingsPayload(form: { user_id: string; allow_unregistered_products: boolean; view_stock: boolean; access_hours_enabled: boolean; windows: { start: string; end: string; days: number[] }[];
  modules: Record<string, boolean>; commission_rule: string; commission_mode: string; commission_rate: string; bands: { discount_up_to: string; rate: string }[]; discount_limit: string; notes: string }): SellerSettings {
  const windows = form.access_hours_enabled ? form.windows : [];
  windows.forEach((row, index) => {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(row.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(row.end) || row.start >= row.end) throw new CatalogValidationError(`window-${index}`, `Confira o horário ${index + 1}: o início deve ser antes do fim (hh:mm).`);
    if (!row.days.length) throw new CatalogValidationError(`window-${index}`, `Marque ao menos um dia no horário ${index + 1}.`);
  });
  const bands = form.commission_mode === 'descontos' ? form.bands.map((band, index) => ({ discount_up_to: percent(`band-${index}`, 'o desconto de até (%)', band.discount_up_to, false)!, rate: percent(`band-${index}`, 'o % de comissão', band.rate, false)! })) : [];
  bands.sort((a, b) => Number(a.discount_up_to) - Number(b.discount_up_to));
  if (new Set(bands.map(band => Number(band.discount_up_to))).size !== bands.length) throw new CatalogValidationError('band-0', 'Cada faixa precisa de um desconto diferente.');
  const notes = form.notes.trim();
  if (notes.length > 4000) throw new CatalogValidationError('seller-notes', 'As observações têm até 4000 caracteres.');
  return { user_id: form.user_id || null, allow_unregistered_products: form.allow_unregistered_products, view_stock: form.view_stock, access_hours_enabled: form.access_hours_enabled,
    access_windows: windows.map(row => ({ start: row.start, end: row.end, days: [...row.days].sort() })), modules: Object.fromEntries(ALL_MODULE_KEYS.filter(key => form.modules[key]).map(key => [key, true])),
    commission_rule: (COMMISSION_RULES.some(rule => rule.value === form.commission_rule) ? form.commission_rule : 'parcial') as SellerSettings['commission_rule'],
    commission_mode: form.commission_mode === 'descontos' ? 'descontos' : 'fixa', commission_rate: form.commission_mode === 'fixa' ? percent('seller-commission_rate', 'a alíquota de comissão', form.commission_rate, true) : null,
    commission_bands: bands, discount_limit: percent('seller-discount_limit', 'o limite de desconto', form.discount_limit || '0', false)!, notes: notes || null };
}
export const validDate = isoDateValid;
