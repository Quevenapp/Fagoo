import {useEffect, useRef, useState} from 'react';
import {Link, useNavigate} from 'react-router-dom';
import type {AccessState} from '../lib/real-access';
import {UPDATE_PROGRESS_KEY, updateMessage, updateSnapshot, type UpdatePort, type UpdateSnapshot} from '../lib/system-updates';
import './system-updates.css';

type Verification = {
 state: 'pending' | 'checking' | 'verified' | 'failed';
 checkedAt?: string;
 manifest?: string | null;
 error?: string;
};
const initialVerification: Verification = {state: 'pending'};
const applying = (snapshot: UpdateSnapshot) => ['queued', 'running'].includes(snapshot.status.state);

export default function SystemUpdates({controller, state}: {controller: Partial<UpdatePort>; state: AccessState}) {
 const [snapshot, setSnapshot] = useState<UpdateSnapshot | null>(null);
 const [verification, setVerification] = useState<Verification>(initialVerification);
 const [pending, setPending] = useState(false);
 const [loadError, setLoadError] = useState('');
 const [actionError, setActionError] = useState('');
 const operation = useRef<((action: 'check' | 'apply') => Promise<void>) | null>(null);
 const navigate = useNavigate();
 const admin = state.phase === 'ready' && state.membership?.role === 'admin';
 const actor = state.membership?.user_id;

 useEffect(() => {
  const abort = new AbortController();
  let current: UpdateSnapshot | null = null, checked: Verification = initialVerification;
  let busy = false, loading = false, epoch = 0, needsCheck = true, followingCheck = false;
  let applyRequest: {version: string; manifest_sha256: string; request_id: string} | null = null;
  setSnapshot(null); setVerification(initialVerification); setPending(false); setLoadError(''); setActionError('');
  if (!admin || !controller.updates) return;
  const updates = controller.updates;
  const verify = (next: Verification) => { checked = next; setVerification(next); };

  const receive = (next: UpdateSnapshot) => {
   current = next; setSnapshot(next);
   if (next.status.state === 'checking') {
    needsCheck = false; followingCheck = true; verify({state: 'checking'});
   } else if (followingCheck) {
    followingCheck = false;
    if (applying(next) || next.status.recovery_required) {
     verify(initialVerification);
    } else if (next.status.state === 'idle' &&
      ((!next.status.error && next.status.phase === 'ready' && next.latest) || next.status.error === 'NO_PUBLIC_RELEASE')) {
     const timestamp = next.status.updated_at;
     verify({state: 'verified', manifest: next.latest?.manifest_sha256 ?? null,
      checkedAt: timestamp && Number.isFinite(Date.parse(timestamp)) ? timestamp : new Date().toISOString()});
    } else {
     verify({state: 'failed', error: updateMessage({code: next.status.error})});
    }
   } else if (next.status.state === 'failed' && next.status.phase === 'search') {
    verify({state: 'failed', error: updateMessage({code: next.status.error})});
   } else if (checked.state === 'verified' &&
     (applying(next) || next.status.recovery_required || checked.manifest !== (next.latest?.manifest_sha256 ?? null))) {
    // A different operation/candidate must not inherit this visit's verification.
    verify(initialVerification);
   }
  };

  const operate = async (action: 'check' | 'apply') => {
   if (busy || abort.signal.aborted || (current && (applying(current) || current.status.recovery_required || current.status.state === 'checking'))) return;
   if (action === 'apply' && (checked.state !== 'verified' || !current?.can_apply || !current.latest)) return;
   busy = true; ++epoch; setPending(true); setActionError(''); setLoadError('');
   if (action === 'check') {
    needsCheck = false; followingCheck = true; verify({state: 'checking'});
   }
   try {
    if (action === 'apply' && current?.latest && applyRequest?.manifest_sha256 !== current.latest.manifest_sha256) {
     applyRequest = {version: current.latest.version, manifest_sha256: current.latest.manifest_sha256, request_id: crypto.randomUUID()};
    }
    const next = updateSnapshot(await updates(action, {body: action === 'apply' ? applyRequest : undefined, signal: abort.signal}));
    if (abort.signal.aborted) return;
    receive(next);
    if (action === 'apply') {
     if (!/^[A-Za-z0-9_-]{43}$/.test(next.progress_token || '')) throw new Error('INVALID_UPDATE_RESPONSE');
     const progress = {token: next.progress_token, created: Date.now()};
     try { sessionStorage.setItem(UPDATE_PROGRESS_KEY, JSON.stringify(progress)); }
     catch { /* The navigation state keeps progress available in this tab. */ }
     navigate('/atualizacao', {state: {progress}});
    }
   } catch (error) {
    if (!abort.signal.aborted) {
     if (action === 'check') { followingCheck = false; verify({state: 'failed', error: updateMessage(error)}); }
     else setActionError(updateMessage(error));
    }
   } finally {
    busy = false;
    if (!abort.signal.aborted) setPending(false);
   }
  };
  operation.current = operate;

  const load = async () => {
   if (busy || loading || abort.signal.aborted) return;
   loading = true;
   const started = epoch;
   try {
    const next = updateSnapshot(await updates('status', {signal: abort.signal}));
    // Ignore a poll started before a newer check/apply, including a failed one.
    if (abort.signal.aborted || started !== epoch) return;
    setLoadError(''); receive(next);
    if (needsCheck && !applying(next) && !next.status.recovery_required) await operate('check');
   } catch (error) {
    if (!abort.signal.aborted && started === epoch) setLoadError(updateMessage(error));
   } finally { loading = false; }
  };
  void load();
  const timer = setInterval(() => { void load(); }, 5000);
  return () => { abort.abort(); clearInterval(timer); operation.current = null; };
 }, [controller, admin, actor, navigate]);

 if (!admin) return <section className="real-state-panel"><h1>Atualizações do sistema</h1><p>Somente administradores podem gerenciar as atualizações desta instalação.</p></section>;
 const running = snapshot && applying(snapshot);
 const checking = verification.state === 'checking';
 const verified = verification.state === 'verified';
 const message = actionError || loadError;
 const availableLabel = checking ? 'Verificando…' : verified ? snapshot?.latest?.version || 'Sem release pública' : verification.state === 'failed' ? 'Não foi possível verificar' : 'Verificação pendente';
 const availableMessage = checking ? 'Procurando uma versão pública assinada…'
  : verification.state === 'failed' ? 'A consulta não foi concluída. Tente novamente em “Verificar atualizações”.'
  : !verified ? snapshot?.status.recovery_required ? 'Conclua a recuperação antes de verificar novas versões.'
   : running ? 'Aguarde a atualização em andamento para verificar novas versões.' : 'As versões são consultadas automaticamente ao abrir esta página.'
  : snapshot?.status.error === 'NO_PUBLIC_RELEASE' ? 'Ainda não há uma versão pública neste canal.'
  : snapshot?.update_available ? 'Uma nova versão está disponível.' : 'Você está na versão mais recente disponível.';

 return <section className="system-updates" aria-labelledby="system-updates-title">
  <nav className="preferences-breadcrumb" aria-label="Localização"><Link to="/preferencias">Preferências</Link> › <Link to="/preferencias/sistema">Sistema</Link> › Atualizações</nav>
  <header className="updates-heading"><div><p className="fagoo-eyebrow">SUA INSTALAÇÃO</p><h1 id="system-updates-title">Atualizações do sistema</h1><p>Mantenha os serviços, a API e a interface na mesma versão.</p></div>
   <button type="button" className="secondary-button" onClick={() => void operation.current?.('check')} disabled={pending || !!running || !!snapshot?.status.recovery_required || checking || !controller.updates}>{checking ? 'Verificando…' : 'Verificar atualizações'}</button></header>
  {(message || !controller.updates) && <p className="real-alert" role="alert">{message || 'O serviço de atualização precisa ser ativado nesta instalação.'}</p>}
  {verification.error && <p className="real-alert" role="alert">{verification.error}</p>}
  {!snapshot && !message && <p role="status">Consultando a instalação…</p>}
  {snapshot && <>
   <div className="updates-version-grid">
    <article><span>VERSÃO INSTALADA</span><strong>{snapshot.installed.version}</strong><p>{snapshot.installed.installed_at ? 'Instalada em ' + new Date(snapshot.installed.installed_at).toLocaleString('pt-BR') : 'Versão desta instalação'}</p></article>
    <article aria-live="polite" aria-busy={checking}><span>VERSÃO DISPONÍVEL</span><strong>{availableLabel}</strong><p>{availableMessage}</p>
     {verified && verification.checkedAt && <small className="updates-check-detail">Verificado em <time dateTime={verification.checkedAt}>{new Date(verification.checkedAt).toLocaleString('pt-BR')}</time></small>}
     {!verified && snapshot.latest && <small className="updates-check-detail">Última versão conhecida: {snapshot.latest.version}. A consulta atual ainda não foi confirmada.</small>}
    </article>
   </div>
   {!snapshot.cloudflare_configured && <aside className="updates-notice"><h2>Ative a publicação automática</h2><p>A credencial do Cloudflare precisa ser salva durante a configuração inicial do servidor. Depois disso, as atualizações poderão ser iniciadas por este painel.</p><a href="https://github.com/Quevenapp/Fagoo/blob/main/docs/operations/installation.md" target="_blank" rel="noreferrer">Consultar o manual de instalação</a></aside>}
   {verified && snapshot.latest?.notes && <article className="updates-release-notes"><h2>O que muda nesta versão</h2><p>{snapshot.latest.notes}</p></article>}
   <article className="updates-action"><div><h2>Atualizar esta instalação</h2><p>O FAGOO prepara a nova versão, salva um backup e pausa o acesso durante a instalação. Empresa, usuários, documentos, arquivos e configurações são preservados.</p><p>O processo continua no servidor se você fechar o navegador. Avise sua equipe antes de começar.</p></div>
    <button type="button" className="primary-button" disabled={pending || !verified || !snapshot.can_apply} onClick={() => void operation.current?.('apply')}>{pending ? 'Aguarde…' : 'Atualizar agora'}</button></article>
   {running && <p role="status">Atualização em andamento. Etapa: {snapshot.status.phase}. Aguarde a conclusão.</p>}
   {snapshot.status.state === 'succeeded' && <p className="updates-success" role="status">Última atualização concluída. A instalação está pronta para uso.</p>}
   {snapshot.status.recovery_required && <aside className="real-alert" role="alert"><h2>Recuperação necessária</h2><p>A atualização foi interrompida e o backup foi preservado. O servidor precisa ser recuperado antes de uma nova tentativa.</p><a href="https://github.com/Quevenapp/Fagoo/blob/main/docs/operations/updates.md#recuperação" target="_blank" rel="noreferrer">Abrir instruções de recuperação</a></aside>}
   {snapshot.status.state === 'failed' && snapshot.status.phase !== 'search' && !snapshot.status.recovery_required && <p className="real-alert" role="alert">Não foi possível concluir a atualização. Confira a conexão e a configuração do servidor antes de tentar novamente. Código: {snapshot.status.error}</p>}
  </>}
 </section>;
}
