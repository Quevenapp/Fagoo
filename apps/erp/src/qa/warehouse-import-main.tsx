import {createRoot} from 'react-dom/client';
import {createBrowserRouter,RouterProvider} from 'react-router-dom';
import OriginWarehouseImport from '../components/OriginWarehouseImport';
import {UnsavedChangesProvider} from '../hooks/useUnsavedChanges';
import {createWarehouseImportFixture} from './warehouse-import-fixture';
import '../styles.css';import '../components/real-access.css';
// QA_SYNTHETIC_WAREHOUSE_IMPORT
if(!import.meta.env.DEV||location.hostname!=='127.0.0.1')throw Error('LOCAL_QA_ONLY');
const fixture=createWarehouseImportFixture({lostAck:new URLSearchParams(location.search).get('scenario')==='lost-ack'});
const router=createBrowserRouter([{path:'*',element:<UnsavedChangesProvider><div className="real-shell" data-qa="QA_SYNTHETIC_WAREHOUSE_IMPORT"><header className="real-topbar"><strong>FAGOO · depósitos fictícios</strong></header><main className="real-main"><OriginWarehouseImport controller={fixture.controller}/></main></div></UnsavedChangesProvider>}]);
createRoot(document.getElementById('root')!).render(<RouterProvider router={router}/>);
