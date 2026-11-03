import {useEffect,useRef,useState} from 'react';
import {Link,useNavigate} from 'react-router-dom';
import type {AccessState} from '../lib/real-access';
import {UPDATE_PROGRESS_KEY,updateMessage,updateSnapshot,type UpdatePort,type UpdateSnapshot} from '../lib/system-updates';
import './system-updates.css';

export default function SystemUpdates({controller,state}:{controller:Partial<UpdatePort>;state:AccessState}){
 const [snapshot,setSnapshot]=useState<UpdateSnapshot|null>(null),[pending,setPending]=useState(false),[message,setMessage]=useState('');
 const active=useRef(true),busy=useRef(false),navigate=useNavigate(),applyRequest=useRef<{version:string;manifest_sha256:string;request_id:string}|null>(null);
 const admin=state.phase==='ready'&&state.membership?.role==='admin';
 useEffect(()=>{active.current=true;const abort=new AbortController();
  const load=async()=>{if(!admin||!controller.updates)return;try{const next=updateSnapshot(await controller.updates('status',{signal:abort.signal}));if(active.current){setSnapshot(next);setMessage('');}}catch(error){if(active.current&&!abort.signal.aborted)setMessage(updateMessage(error));}};
  void load();const timer=setInterval(()=>{if(!busy.current)void load();},5000);
  return()=>{active.current=false;abort.abort();clearInterval(timer);};
 },[controller,admin]);
 if(!admin)return <section className="real-state-panel"><h1>Atualizações do sistema</h1><p>Somente administradores podem gerenciar as atualizações desta instalação.</p></section>;
 const operate=async(action:'check'|'apply')=>{
  if(busy.current||!controller.updates)return;busy.current=true;setPending(true);setMessage('');
  try{
   if(action==='apply'&&snapshot?.latest&&applyRequest.current?.manifest_sha256!==snapshot.latest.manifest_sha256)applyRequest.current={version:snapshot.latest.version,manifest_sha256:snapshot.latest.manifest_sha256,request_id:crypto.randomUUID()};
   const body=action==='apply'?applyRequest.current:undefined;
   const next=updateSnapshot(await controller.updates(action,{body}));if(!active.current)return;setSnapshot(next);
   if(action==='apply'){
    if(!/^[A-Za-z0-9_-]{43}$/.test(next.progress_token||''))throw new Error('INVALID_UPDATE_RESPONSE');
    const progress={token:next.progress_token,created:Date.now()};
    try{sessionStorage.setItem(UPDATE_PROGRESS_KEY,JSON.stringify(progress));}catch{/* The navigation state keeps progress available in this tab. */}
    navigate('/atualizacao',{state:{progress}});
   }
  }catch(error){if(active.current)setMessage(updateMessage(error));}
  finally{busy.current=false;if(active.current)setPending(false);}
 };
 const running=snapshot&&['queued','running'].includes(snapshot.status.state);
 return <section className="system-updates" aria-labelledby="system-updates-title">
  <nav className="preferences-breadcrumb" aria-label="Localização"><Link to="/preferencias">Preferências</Link> › <Link to="/preferencias/sistema">Sistema</Link> › Atualizações</nav>
  <header className="updates-heading"><div><p className="fagoo-eyebrow">SUA INSTALAÇÃO</p><h1 id="system-updates-title">Atualizações do sistema</h1><p>Mantenha os serviços, a API e a interface na mesma versão.</p></div>
   <button type="button" className="secondary-button" onClick={()=>void operate('check')} disabled={pending||!!running||snapshot?.status.state==='checking'||!controller.updates}>Verificar atualizações</button></header>
  {(message||!controller.updates)&&<p className="real-alert" role="alert">{message||'O serviço de atualização precisa ser ativado nesta instalação.'}</p>}
  {!snapshot&&!message&&<p role="status">Consultando a instalação…</p>}
  {snapshot&&<>
   <div className="updates-version-grid"><article><span>VERSÃO INSTALADA</span><strong>{snapshot.installed.version}</strong><p>{snapshot.installed.installed_at?'Instalada em '+new Date(snapshot.installed.installed_at).toLocaleString('pt-BR'):'Versão desta instalação'}</p></article>
    <article><span>VERSÃO DISPONÍVEL</span><strong>{snapshot.latest?.version||'Aguardando verificação'}</strong><p>{snapshot.status.state==='checking'?'Procurando uma versão pública assinada…':snapshot.status.error==='NO_PUBLIC_RELEASE'?'Ainda não há uma versão pública neste canal.':snapshot.update_available?'Uma nova versão está disponível.':snapshot.latest?'Você está na versão mais recente disponível.':'Use “Verificar atualizações”.'}</p></article></div>
   {!snapshot.cloudflare_configured&&<aside className="updates-notice"><h2>Ative a publicação automática</h2><p>A credencial do Cloudflare precisa ser salva durante a configuração inicial do servidor. Depois disso, as atualizações poderão ser iniciadas por este painel.</p><a href="https://github.com/Quevenapp/Fagoo/blob/main/docs/operations/installation.md" target="_blank" rel="noreferrer">Consultar o manual de instalação</a></aside>}
   {snapshot.latest?.notes&&<article className="updates-release-notes"><h2>O que muda nesta versão</h2><p>{snapshot.latest.notes}</p></article>}
   <article className="updates-action"><div><h2>Atualizar esta instalação</h2><p>O FAGOO prepara a nova versão, salva um backup e pausa o acesso durante a instalação. Empresa, usuários, documentos, arquivos e configurações são preservados.</p><p>O processo continua no servidor se você fechar o navegador. Avise sua equipe antes de começar.</p></div>
    <button type="button" className="primary-button" disabled={pending||!snapshot.can_apply} onClick={()=>void operate('apply')}>{pending?'Aguarde…':'Atualizar agora'}</button></article>
   {running&&<p role="status">Atualização em andamento. Etapa: {snapshot.status.phase}. Aguarde a conclusão.</p>}
   {snapshot.status.state==='succeeded'&&<p className="updates-success" role="status">Última atualização concluída. A instalação está pronta para uso.</p>}
   {snapshot.status.recovery_required&&<aside className="real-alert" role="alert"><h2>Recuperação necessária</h2><p>A atualização foi interrompida e o backup foi preservado. O servidor precisa ser recuperado antes de uma nova tentativa.</p><a href="https://github.com/Quevenapp/Fagoo/blob/main/docs/operations/updates.md#recuperação" target="_blank" rel="noreferrer">Abrir instruções de recuperação</a></aside>}
   {snapshot.status.state==='failed'&&!snapshot.status.recovery_required&&<p className="real-alert" role="alert">Não foi possível concluir a atualização. Confira a conexão e a configuração do servidor antes de tentar novamente. Código: {snapshot.status.error}</p>}
  </>}
 </section>;
}
