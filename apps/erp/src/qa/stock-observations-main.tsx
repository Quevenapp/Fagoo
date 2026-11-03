import {createRoot} from 'react-dom/client';
import OriginStockObservations from '../components/OriginStockObservations';
import {createStockObservationsFixture,stockQaWarehouse,STOCK_OBS_QA_WAREHOUSE} from './stock-observations-fixture';
import '../styles.css';import '../components/real-access.css';
// QA_SYNTHETIC_STOCK_OBSERVATIONS
if(!import.meta.env.DEV||location.hostname!=='127.0.0.1')throw Error('LOCAL_QA_ONLY');
const changed=new URLSearchParams(location.search).get('scenario')==='warehouse-missing';
const warehouse=changed?{...stockQaWarehouse(),source:null,source_state:'missing' as const,record:{...stockQaWarehouse().record,active:false}}:undefined;
const fixture=createStockObservationsFixture({warehouse});
createRoot(document.getElementById('root')!).render(<div className="real-shell" data-qa="QA_SYNTHETIC_STOCK_OBSERVATIONS"><header className="real-topbar"><strong>FAGOO · estoque fictício</strong></header><main className="real-main"><OriginStockObservations controller={fixture.controller} warehouseSourceId={STOCK_OBS_QA_WAREHOUSE}/></main></div>);
