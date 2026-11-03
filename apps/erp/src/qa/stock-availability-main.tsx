import {createRoot} from 'react-dom/client';
import {useState} from 'react';
import StockAvailability from '../components/StockAvailability';
import {createStockAvailabilityFixture} from './stock-availability-fixture';
import '../styles.css';import '../components/real-access.css';
// QA_SYNTHETIC_STOCK_AVAILABILITY
if(!import.meta.env.DEV||location.hostname!=='127.0.0.1')throw Error('LOCAL_QA_ONLY');
const fixture=createStockAvailabilityFixture();
function Screen(){const [basis,setBasis]=useState(0);return <div className="real-shell" data-qa="QA_SYNTHETIC_STOCK_AVAILABILITY"><header className="real-topbar"><strong>FAGOO · estoque fictício</strong></header><main className="real-main"><header className="real-heading"><div><h1>Controle de estoque</h1><p>Consulta local, sem rede ou movimentação.</p></div><span className="real-mode">Somente consulta</span></header><section className="real-records"><h2>{fixture.product.name}</h2><p>{fixture.product.code} · UN</p><button className="secondary-button" onClick={()=>setBasis(v=>v+1)}>Atualizar ficha de demonstração</button><StockAvailability controller={fixture.controller} productId={fixture.product.id} warehouses={fixture.warehouses} basis={String(basis)}/></section></main></div>;}
createRoot(document.getElementById('root')!).render(<Screen/>);
