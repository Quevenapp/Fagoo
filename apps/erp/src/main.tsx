import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import {ACTIVATION_PATH} from './lib/invite-activation';
import {captureBrowserInvite} from './lib/invite-activation-entry';
import './styles.css';
import './fonts.css';

const root=createRoot(document.getElementById('root')!);
const unavailable=()=>root.render(<main className="activation-bootstrap-error"><h1>Não foi possível abrir esta página</h1><p>Tente novamente mais tarde. Se estiver ativando sua conta, solicite orientação ao administrador.</p><a href="/acesso">Ir para o login</a></main>);
if(window.location.pathname===ACTIVATION_PATH){
 // Capture once, outside React: StrictMode never consumes or destroys the handoff twice.
 const controller=captureBrowserInvite({href:window.location.href,origin:window.location.origin,replaceUrl:path=>window.history.replaceState(null,'',path),env:{VITE_SUPABASE_DEPLOYMENT:import.meta.env.VITE_SUPABASE_DEPLOYMENT,VITE_SUPABASE_URL:import.meta.env.VITE_SUPABASE_URL,VITE_SUPABASE_ANON_KEY:import.meta.env.VITE_SUPABASE_ANON_KEY,VITE_SUPABASE_PUBLISHABLE_KEY:import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,VITE_ERP_API_URL:import.meta.env.VITE_ERP_API_URL}});
 window.addEventListener('pagehide',()=>controller.dispose(),{once:true});
 // A restored page cannot reuse the one-time handoff or a discarded Auth client.
 window.addEventListener('pageshow',event=>{if(event.persisted)unavailable();});
 void import('./components/InviteActivation').then(({default:InviteActivation})=>root.render(<StrictMode><InviteActivation controller={controller}/></StrictMode>)).catch(()=>{controller.dispose();unavailable();});
}else{
 void import('./erp-entry').then(({mountErp})=>mountErp(root)).catch(unavailable);
}
