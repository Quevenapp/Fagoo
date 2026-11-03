import { createRoot } from 'react-dom/client';
import FinanceMovementHistory from '../components/FinanceMovementHistory';
import { createMovementPeriodFixture } from './finance-movement-period-fixture';
import { financeMoney } from '../lib/real-finance-model';
import '../styles.css'; import '../components/real-access.css'; import '../components/real-finance.css';
// QA_SYNTHETIC_FINANCE_MOVEMENT_PERIOD
if (!import.meta.env.DEV || location.hostname !== '127.0.0.1') throw Error('LOCAL_QA_ONLY');
const f = createMovementPeriodFixture();
createRoot(document.getElementById('root')!).render(<div className="real-shell" data-qa="QA_SYNTHETIC_FINANCE_MOVEMENT_PERIOD"><header className="real-topbar"><strong>FAGOO · Financeiro fictício</strong></header><main className="real-main"><section className="real-editor"><h1>{f.account.name}</h1><p>Consulta local, sem banco ou operações financeiras.</p><dl className="finance-summary"><div><dt>Saldo registrado no FAGOO</dt><dd>{financeMoney(f.account.balance_cents)}</dd></div></dl><FinanceMovementHistory controller={f.controller} accountId={f.account.id}/></section></main></div>);
