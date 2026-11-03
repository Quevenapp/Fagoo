// QA_SYNTHETIC_CNAB_RETURN_AMOUNTS
import { createRoot } from 'react-dom/client';
import CnabReturnAmounts from '../components/CnabReturnAmounts';
import { cnabReturnAmountsQa } from './cnab-return-amounts-fixture';
import '../styles.css';
import '../components/real-access.css';
if (!import.meta.env.DEV || location.hostname !== '127.0.0.1') throw new Error('LOCAL_QA_ONLY');
createRoot(document.getElementById('root')!).render(<main className="real-main"><h1>Valores de retorno · exemplos fictícios</h1><p>Somente apresentação local. Nenhuma requisição, perfil bancário ou movimento financeiro.</p>{cnabReturnAmountsQa().map(value => <article key={value.label}><h2>{value.label}</h2><CnabReturnAmounts event={value.event} historical={value.historical} /></article>)}</main>);
