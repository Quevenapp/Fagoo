import {createRoot} from 'react-dom/client';import {useMemo,useState} from 'react';
import FiscalReceiptQueries from '../components/FiscalReceiptQueries';
import {createReceiptQueryQa} from './receipt-query-fixture';
import {createReceiptQueryProcessedQa} from './receipt-query-processed-fixture';
import '../styles.css';import '../components/real-access.css';
// QA_SYNTHETIC_RECEIPT_QUERY
if(!import.meta.env.DEV||location.hostname!=='127.0.0.1')throw new Error('LOCAL_QA_ONLY');
function Qa(){
 const [,tick]=useState(0),[open,setOpen]=useState(true),params=new URLSearchParams(location.search),fixture=useMemo(()=>{const scenario=params.get('scenario')??'pending',model=params.get('model')==='65'?'65':'55',changed=()=>tick(n=>n+1);return scenario==='processed'||scenario==='processed-conflict'?createReceiptQueryProcessedQa({model,conflict:scenario==='processed-conflict',changed}):createReceiptQueryQa({model,scenario,changed});},[]);
 return <div className="real-shell" data-qa="QA_SYNTHETIC_RECEIPT_QUERY"><header className="real-topbar"><strong>FAGOO · recibo fictício</strong></header><main className="real-main"><h2>Consulta de processamento · teste local</h2><p>Portas sintéticas, sem rede, certificado ou emissão.</p>{open?<FiscalReceiptQueries controller={fixture.controller} reference={fixture.reference} onDismiss={()=>{setOpen(false);return true;}}/>:<button type="button" className="secondary-button" onClick={()=>setOpen(true)}>Reabrir consultas</button>}<details><summary>Contadores do teste local</summary><p>Leituras: {fixture.calls.filter(c=>!c.mutation).length}. Consultas confirmadas: {fixture.calls.filter(c=>c.mutation).length}.</p></details></main></div>;
}
createRoot(document.getElementById('root')!).render(<Qa/>);
