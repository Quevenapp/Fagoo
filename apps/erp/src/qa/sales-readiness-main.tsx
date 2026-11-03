/** Separate DEV-only entry, never imported from the ERP production graph. */
import {createRoot} from 'react-dom/client';
import {useMemo,useState} from 'react';
import OriginSalesReadiness from '../components/OriginSalesReadiness';
import {createSalesReadinessQaFixture} from './sales-readiness-fixture';
import '../styles.css';
import '../components/real-access.css';
if(!import.meta.env.DEV||location.hostname!=='127.0.0.1')throw new Error('LOCAL_QA_ONLY');
function QA(){
 const [,render]=useState(0),fixture=useMemo(()=>createSalesReadinessQaFixture(()=>render(value=>value+1)),[]);
 return <div className="real-shell"><header className="real-topbar"><strong>FAGOO · QA local de vendas · dados fictícios</strong></header><main className="real-main"><p className="real-notice">Cenário sintético, sem rede ou banco. QA-081-01 tem preços vinculados; QA-081-02 tem pendências de captura e produto.</p><p role="status">Consultas de lista: {fixture.counts.list} · Consultas de detalhe: {fixture.counts.detail} · Ações recusadas: {fixture.counts.rejected}</p><OriginSalesReadiness controller={fixture.controller}/></main></div>;
}
createRoot(document.getElementById('root')!).render(<QA/>);
