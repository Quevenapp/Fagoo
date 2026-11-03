import {createRoot} from 'react-dom/client';
import {useMemo,useState} from 'react';
import ItauLegacyReadiness from '../components/ItauLegacyReadiness';
import {createItauLegacyQaFixture} from './itau-legacy-readiness-fixture';
import '../styles.css';
import '../components/real-access.css';
if(!import.meta.env.DEV||location.hostname!=='127.0.0.1')throw new Error('LOCAL_QA_ONLY');
function QA(){const[,render]=useState(0),f=useMemo(()=>createItauLegacyQaFixture(()=>render(n=>n+1)),[]);return<div className="real-shell"><header className="real-topbar"><strong>FAGOO · cobranças fictícias</strong></header><main className="real-main"><p role="status">Consulta local sem rede · {f.counts.list} GET · {f.counts.rejected} ações recusadas</p><ItauLegacyReadiness controller={f.controller}/></main></div>;}
createRoot(document.getElementById('root')!).render(<QA/>);
