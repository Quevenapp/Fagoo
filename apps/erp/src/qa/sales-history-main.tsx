import {createRoot} from 'react-dom/client';
import {useMemo,useState} from 'react';
import OriginSalesHistory from '../components/OriginSalesHistory';
import {createSalesHistoryQaFixture} from './sales-history-fixture';
import '../styles.css';
import '../components/real-access.css';
if(!import.meta.env.DEV||location.hostname!=='127.0.0.1')throw new Error('LOCAL_QA_ONLY');
function QA(){const[,render]=useState(0),f=useMemo(()=>createSalesHistoryQaFixture(()=>render(n=>n+1)),[]);return <div className="real-shell"><header className="real-topbar"><strong>FAGOO · histórico comercial fictício</strong></header><main className="real-main"><p>Cenário local sem rede: QA-083-01 tem origem alterada; QA-083-02 tem origem removida. A captura permanece disponível em ambos.</p><p role="status">Consultas de lista: {f.counts.list} · Consultas de detalhe: {f.counts.detail} · Ações recusadas: {f.counts.rejected}</p><OriginSalesHistory controller={f.controller}/></main></div>;}
createRoot(document.getElementById('root')!).render(<QA/>);
