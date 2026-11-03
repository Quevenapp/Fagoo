// "Busque pela instituição" do cadastro de contas financeiras do Origin: código de compensação (COMPE) e nome.
// Lista estática embarcada no app (sem consulta externa); o banco guarda o código e o nome escolhidos.
export interface BankInstitution { code: string; name: string }
export const BANK_INSTITUTIONS: readonly BankInstitution[] = [
  { code: '001', name: 'Banco do Brasil' }, { code: '003', name: 'Banco da Amazônia' }, { code: '004', name: 'Banco do Nordeste' }, { code: '021', name: 'Banestes' },
  { code: '025', name: 'Banco Alfa' }, { code: '033', name: 'Santander' }, { code: '036', name: 'Bradesco BBI' }, { code: '037', name: 'Banpará' },
  { code: '041', name: 'Banrisul' }, { code: '047', name: 'Banese' }, { code: '070', name: 'BRB - Banco de Brasília' }, { code: '077', name: 'Banco Inter' },
  { code: '084', name: 'Uniprime Norte do Paraná' }, { code: '085', name: 'Cooperativa Central Ailos' }, { code: '097', name: 'Credisis' }, { code: '104', name: 'Caixa Econômica Federal' },
  { code: '136', name: 'Unicred' }, { code: '197', name: 'Stone Instituição de Pagamento' }, { code: '208', name: 'BTG Pactual' }, { code: '212', name: 'Banco Original' },
  { code: '218', name: 'Banco BS2' }, { code: '237', name: 'Bradesco' }, { code: '246', name: 'Banco ABC Brasil' }, { code: '260', name: 'Nu Pagamentos (Nubank)' },
  { code: '290', name: 'PagSeguro Internet (PagBank)' }, { code: '318', name: 'Banco BMG' }, { code: '323', name: 'Mercado Pago' }, { code: '336', name: 'Banco C6' },
  { code: '341', name: 'Itaú Unibanco' }, { code: '380', name: 'PicPay' }, { code: '389', name: 'Banco Mercantil do Brasil' }, { code: '403', name: 'Cora' },
  { code: '422', name: 'Banco Safra' }, { code: '461', name: 'Asaas' }, { code: '536', name: 'Neon Pagamentos' }, { code: '611', name: 'Banco Paulista' },
  { code: '623', name: 'Banco Pan' }, { code: '633', name: 'Banco Rendimento' }, { code: '637', name: 'Banco Sofisa' }, { code: '643', name: 'Banco Pine' },
  { code: '655', name: 'Banco Votorantim (BV)' }, { code: '707', name: 'Banco Daycoval' }, { code: '739', name: 'Banco Cetelem' }, { code: '741', name: 'Banco Ribeirão Preto' },
  { code: '743', name: 'Banco Semear' }, { code: '745', name: 'Citibank' }, { code: '746', name: 'Banco Modal' }, { code: '748', name: 'Sicredi' },
  { code: '752', name: 'BNP Paribas' }, { code: '756', name: 'Sicoob' },
];
const fold = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
/** Search by code or name, accent-insensitive, at most `limit` results. */
export function searchInstitutions(query: string, limit = 12): BankInstitution[] {
  const text = fold(query.trim());
  if (!text) return BANK_INSTITUTIONS.slice(0, limit);
  return BANK_INSTITUTIONS.filter(item => item.code.startsWith(text) || fold(item.name).includes(text)).slice(0, limit);
}
export const institutionLabel = (code: string | null, name: string | null) => code && name ? `${code} - ${name}` : '';
