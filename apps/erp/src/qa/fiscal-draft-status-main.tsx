/** Separate DEV-only entry; never imported from production. */
import {createRoot} from 'react-dom/client';
import {useMemo,useState} from 'react';
import FiscalDraftStatus from '../components/FiscalDraftStatus';
import {createFiscalDraftStatusQaFixture} from './fiscal-draft-status-fixture';
import '../styles.css';
import '../components/real-access.css';
if(!import.meta.env.DEV||location.hostname!=='127.0.0.1')throw new Error('LOCAL_QA_ONLY');
function QA(){const[,render]=useState(0),fixture=useMemo(()=>createFiscalDraftStatusQaFixture(()=>render(n=>n+1)),[]),[opened,setOpened]=useState('');return <div className="real-shell"><header className="real-topbar"><strong>FAGOO · QA local de resumo fiscal · dados fictícios</strong></header><main className="real-main"><p className="real-notice">Três exemplos sintéticos: NF-e autorizada após conferência da resposta, NFC-e rejeitada (código 245) e NFC-e somente numerada. Nenhuma comunicação externa.</p><p role="status">Consultas GET: {fixture.counts.get} · Ações recusadas: {fixture.counts.rejected}</p>{opened&&<p>Preparação selecionada: pedido {opened}. A fixture não abre o editor nem envia comandos.</p>}<FiscalDraftStatus controller={fixture.controller} onOpenDraft={draft=>setOpened(draft.order_number)}/></main></div>;}
createRoot(document.getElementById('root')!).render(<QA/>);
