import {createRoot} from 'react-dom/client';
import {createHashRouter,RouterProvider} from 'react-router-dom';
import {UnsavedChangesProvider} from '../hooks/useUnsavedChanges';
import CompanyNavigation from '../components/CompanyNavigation';
import CompanyPreferences from '../components/CompanyPreferences';
import {createPreferencesFixture} from './preferences-fixture';
import {createUsersFixture} from './users-fixture';
import {createActivityFixture} from './activity-fixture';
import {createBusinessFixture} from './business-fixture';
import '../styles.css';import '../components/real-access.css';
// QA_SYNTHETIC_PREFERENCES — synthetic local ports for Preferências and Sistema; DEV + loopback only, absent from the build.
if(!import.meta.env.DEV||location.hostname!=='127.0.0.1')throw Error('LOCAL_QA_ONLY');
const role=(new URLSearchParams(location.search).get('perfil')??'admin') as 'admin';
const prefs=createPreferencesFixture({role}),users=createUsersFixture({role}),activity=createActivityFixture({role}),business=createBusinessFixture({role});
const controller={...prefs.controller,accessUsers:users.controller.accessUsers,listPreferences:users.controller.listPreferences,systemLog:activity.controller.systemLog,attachments:activity.controller.attachments,system:business.controller.system};
function Shell(){const state=controller.getSnapshot();return <div className="real-shell" data-qa="QA_SYNTHETIC_PREFERENCES"><CompanyNavigation state={state} onLogout={()=>{}}/><main className="real-main"><CompanyPreferences controller={controller} state={state}/></main></div>;}
const router=createHashRouter([{path:'*',element:<UnsavedChangesProvider><Shell/></UnsavedChangesProvider>}]);
createRoot(document.getElementById('root')!).render(<RouterProvider router={router}/>);
