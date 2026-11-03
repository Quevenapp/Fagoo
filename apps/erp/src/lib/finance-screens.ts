// Financeiro screens opened by /financeiro-empresa?area=<area> besides the contas lists (RealFinance) and borderôs.
// Onda C: Comissões (SQL 171), Controle de caixa (SQL 173) e Faturamento agrupado (SQL 174).
// Onda D: Ver relatórios financeiros (SQL 212) e Remessas / Retornos no padrão Origin (SQL 213).
// Leva H: Relatório complementar de comissões (SQL 370).
export const FINANCE_SCREENS = ['contas-financeiras', 'categories', 'accounts', 'ficha', 'conciliacao', 'recorrentes', 'importacao', 'comissoes', 'controle-caixa', 'faturamento-agrupado', 'relatorios', 'remessas', 'retornos', 'comissoes-relatorio'] as const;
export type FinanceScreen = typeof FINANCE_SCREENS[number];
export const financeScreen = (area: string | null): area is FinanceScreen => (FINANCE_SCREENS as readonly string[]).includes(area ?? '');
