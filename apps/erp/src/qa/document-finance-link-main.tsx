import {createRoot} from 'react-dom/client';
import {useState} from 'react';
import {createMemoryRouter,RouterProvider,useLocation,useNavigate} from 'react-router-dom';
import {UnsavedChangesProvider,useUnsavedChanges} from '../hooks/useUnsavedChanges';
import DocumentFinance from '../components/DocumentFinance';
import RealFinance from '../components/RealFinance';
import {documentFinanceTitlePath} from '../lib/document-finance-link';
import {createDocumentFinanceLinkFixture} from './document-finance-link-fixture';
import '../styles.css';import '../components/real-access.css';
// QA_SYNTHETIC_DOCUMENT_FINANCE_LINK — the memory router never opens a real ERP route.
if(!import.meta.env.DEV||location.hostname!=='127.0.0.1')throw Error('LOCAL_QA_ONLY');
const kind=new URLSearchParams(location.search).get('kind')==='purchase_orders'?'purchase_orders':new URLSearchParams(location.search).get('kind')==='service_orders'?'service_orders':'sales_orders';
const fixture=createDocumentFinanceLinkFixture(kind);
function Screen(){const location=useLocation(),navigate=useNavigate(),[note,setNote]=useState(''),guard=useUnsavedChanges(note!=='');return<div className="real-shell"><header className="real-topbar"><strong>FAGOO · documento e parcela fictícios</strong></header><main className="real-main"><p>QA local: consulta de parcela sem rede. Nenhuma gravação financeira está disponível.</p>{location.pathname==='/financeiro-empresa'?<><button className="secondary-button" onClick={()=>guard.confirmLeave(()=>navigate('/documento'))}>Voltar ao documento de demonstração</button><RealFinance controller={fixture.controller} initialTab={kind==='purchase_orders'?'payable':'receivable'}/></>:<><h1>{kind==='purchase_orders'?'Compra':kind==='service_orders'?'Ordem de serviço':'Pedido de venda'} QA-8501</h1><label>Observação local para testar descarte<input value={note} onChange={e=>setNote(e.target.value)}/></label><DocumentFinance controller={fixture.controller} record={fixture.record} writable={false} blocked={false} onActive={()=>{}} onBusy={()=>{}} onDraft={()=>{}} onChanged={()=>{}} onOpenTitle={id=>guard.confirmLeave(()=>{setNote('');navigate(documentFinanceTitlePath(kind,id));})}/></>}</main></div>;}
const router=createMemoryRouter([{path:'*',element:<UnsavedChangesProvider><Screen/></UnsavedChangesProvider>}],{initialEntries:['/documento']});
createRoot(document.getElementById('root')!).render(<RouterProvider router={router}/>);
