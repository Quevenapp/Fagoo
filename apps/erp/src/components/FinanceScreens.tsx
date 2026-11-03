import type { AccessController } from '../lib/real-access';
import type { FinanceScreen } from '../lib/finance-screens';
import FinanceAccountsRegistry from './FinanceAccountsRegistry';
import FinanceCategoryTree from './FinanceCategoryTree';
import FinanceStatement from './FinanceStatement';
import FinanceContactLedger from './FinanceContactLedger';
import FinanceReconciliation from './FinanceReconciliation';
import FinanceRecurring from './FinanceRecurring';
import FinanceImport from './FinanceImport';
import FinanceCommissions from './FinanceCommissions';
import FinanceCommissionReport from './FinanceCommissionReport';
import FinanceCashControl from './FinanceCashControl';
import FinanceGroupedBilling from './FinanceGroupedBilling';
import FinanceReports from './FinanceReports';
import FinanceRemittances from './FinanceRemittances';
import FinanceReturns from './FinanceReturns';

/** Financeiro screens of the Origin parity (Contas Financeiras, Categorias, Caixas e bancos, Ficha financeira, …), one per ?area=. */
export default function FinanceScreens({ controller, area }: { controller: AccessController; area: FinanceScreen }) {
  if (area === 'contas-financeiras') return <FinanceAccountsRegistry controller={controller} />;
  if (area === 'accounts') return <FinanceStatement controller={controller} />;
  if (area === 'ficha') return <FinanceContactLedger controller={controller} />;
  if (area === 'conciliacao') return <FinanceReconciliation controller={controller} />;
  if (area === 'recorrentes') return <FinanceRecurring controller={controller} />;
  if (area === 'importacao') return <FinanceImport controller={controller} />;
  if (area === 'comissoes') return <FinanceCommissions controller={controller} />;
  if (area === 'comissoes-relatorio') return <FinanceCommissionReport controller={controller} />;
  if (area === 'controle-caixa') return <FinanceCashControl controller={controller} />;
  if (area === 'faturamento-agrupado') return <FinanceGroupedBilling controller={controller} />;
  if (area === 'relatorios') return <FinanceReports controller={controller} />;
  if (area === 'remessas') return <FinanceRemittances controller={controller} />;
  if (area === 'retornos') return <FinanceReturns controller={controller} />;
  return <FinanceCategoryTree controller={controller} />;
}
