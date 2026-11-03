import {useEffect,useState} from 'react';
import {Link,useLocation} from 'react-router-dom';
import {accessConfig} from '../lib/access-config';
import {fetchUpdateProgress,UPDATE_PROGRESS_KEY,UPDATE_STEPS,type UpdateSnapshot} from '../lib/system-updates';
import './system-updates.css';

export default function SystemUpdateProgress(){
 const location=useLocation();
 const [value,setValue]=useState<UpdateSnapshot|null>(null),[message,setMessage]=useState('');
 useEffect(()=>{const abort=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const poll=async()=>{
   try{
    let saved=location.state?.progress;
    if(!saved){try{saved=JSON.parse(sessionStorage.getItem(UPDATE_PROGRESS_KEY)||'null');}catch{/* Storage can be disabled by the browser. */}}
    const config=accessConfig(import.meta.env);
    if(!saved||!config||Date.now()-saved.created>7200000){setMessage('Este acompanhamento não está disponível nesta sessão. Entre no FAGOO para consultar a instalação.');return;}
    const next=await fetchUpdateProgress(config.apiUrl,saved.token,abort.signal);if(abort.signal.aborted)return;setValue(next);setMessage('');
    if(['succeeded','failed','interrupted'].includes(next.status.state))return;
   }catch{if(abort.signal.aborted)return;setMessage('Reconectando ao servidor. A atualização continua mesmo quando esta tela perde a conexão.');}
   timer=setTimeout(()=>void poll(),4000);
  };void poll();return()=>{abort.abort();if(timer)clearTimeout(timer);};
 },[location.state]);
 const done=value?.status.state==='succeeded',failed=value&&['failed','interrupted'].includes(value.status.state),current=UPDATE_STEPS.findIndex(([id])=>id===value?.status.phase);
 return <main className="system-update-progress" id="main-content"><div className="updates-brand">FAGOO<span>ATUALIZAÇÃO DO SISTEMA</span></div>
  <header><p className="fagoo-eyebrow">{done?'TUDO PRONTO':failed?'ATENÇÃO NECESSÁRIA':'ACOMPANHE A INSTALAÇÃO'}</p><h1>{done?'FAGOO atualizado':failed?'A atualização foi interrompida':'Estamos atualizando seu FAGOO'}</h1>
   <p>{done?'A API, a interface e os serviços foram verificados. Você já pode voltar ao sistema.':failed?'Confira a situação abaixo antes de iniciar outra tentativa.':'Você pode manter esta página aberta. O processo é executado no servidor.'}</p></header>
  {message&&<p className="updates-notice" role="status">{message}</p>}
  {value&&<><div className="updates-progress-summary">{done?<><span>Versão instalada</span><strong>{value.installed.version}</strong></>:<><span>{value.installed.version}</span><span aria-hidden="true">→</span><strong>{value.status.version||value.latest?.version}</strong></>}</div>
   <ol className="updates-steps" aria-label="Etapas da atualização">{UPDATE_STEPS.map(([id,label],index)=><li key={id} className={done||index<current?'done':index===current?'current':''} aria-current={index===current&&!done?'step':undefined}><span>{done||index<current?'✓':index+1}</span><div><strong>{label}</strong>{index===current&&!done&&<small>{failed?'Interrompida nesta etapa':'Em andamento'}</small>}</div></li>)}</ol>
   {value.status.backup_id&&<p className="updates-backup">Backup preservado: <code>{value.status.backup_id}</code></p>}
   {failed&&<aside className="real-alert" role="alert"><p>{value.status.recovery_required?'O ERP permanece em manutenção para proteger os dados. Use o procedimento de recuperação no servidor.':'A preparação foi interrompida antes de alterar os serviços. Volte ao painel, confira a configuração e tente novamente.'}</p><p>Código: {value.status.error}</p>
    {value.status.recovery_required&&<a href="https://github.com/Quevenapp/Fagoo/blob/main/docs/operations/updates.md#recuperação" target="_blank" rel="noreferrer">Consultar recuperação</a>}</aside>}
  </>}
  {done?<button type="button" className="primary-button" onClick={()=>{try{sessionStorage.removeItem(UPDATE_PROGRESS_KEY);}catch{}window.location.assign('/acesso');}}>Abrir FAGOO atualizado</button>:(!value||failed&&!value.status.recovery_required)&&<Link className="secondary-button" to="/preferencias/sistema/atualizacoes">Voltar às atualizações</Link>}
 </main>;
}
