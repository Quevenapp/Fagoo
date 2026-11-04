import { useEffect, useMemo, useRef, useState } from 'react';
import { ORIGIN_SYNC_PATH, issueText, readOriginSyncStatus, runActive, runText, statsText, when, type OriginSyncController, type OriginSyncStatus } from '../lib/origin-sync-model';
import { Icon } from './Icon';
import './origin-sync-button.css';

/** Top bar tool "Sincronizar": envia ao Origin o que mudou no Brufap, traz o que mudou no Origin e mostra a situação.
 * The run itself is done by the API Worker (and continues in its cron); this only asks for it and follows it. */
export default function OriginSyncButton({ controller, canRequest, canConfigure = false }: { controller: OriginSyncController; canRequest: boolean; canConfigure?: boolean }) {
  const [status, setStatus] = useState<OriginSyncStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const load = useMemo(() => async (signal?: AbortSignal) => {
    try {
      const value = readOriginSyncStatus(await controller.originSync(ORIGIN_SYNC_PATH, { method: 'GET', signal }));
      if (alive.current && !signal?.aborted) { setStatus(value); setError(null); }
    } catch { if (alive.current && !signal?.aborted) setError('Não foi possível consultar a sincronização.'); }
  }, [controller]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // Follows an active run closely; otherwise refreshes the counters every minute.
  const active = runActive(status);
  useEffect(() => {
    const request = new AbortController();
    void load(request.signal);
    const timer = setInterval(() => void load(request.signal), active ? 5000 : 60000);
    return () => { clearInterval(timer); request.abort(); };
  }, [load, active]);
  const synchronize = async () => {
    setBusy(true); setError(null);
    try { const value = readOriginSyncStatus(await controller.originSync(ORIGIN_SYNC_PATH, { method: 'POST' })); if (alive.current) setStatus(value); }
    catch { if (alive.current) setError('Não foi possível pedir a sincronização. Tente de novo.'); }
    finally { if (alive.current) setBusy(false); }
  };
  const pending = (status?.push.pending ?? 0) + (status?.pull.pending ?? 0);
  const problems = status?.issues ?? 0;
  const name = status?.connection?.name ?? 'Origin';
  const mode = status?.connection?.mode ?? 'bidirectional';
  const label = `${active ? 'Sincronizando' : 'Sincronizar'} com ${name}`;
  return <div className="origin-tool origin-sync">
    <button type="button" className={`origin-sync-button${active ? ' is-running' : ''}${problems ? ' has-issues' : ''}`} aria-expanded={open} aria-label={label} title={label} onClick={() => setOpen(!open)}>
      <Icon name="arrows-rotate" size={14} /><span>Sincronizar</span>{problems > 0 && <span className="origin-sync-badge" aria-label={`${problems} pendências`}>{problems > 99 ? '99+' : problems}</span>}
    </button>
    {open && <><button type="button" className="origin-dismiss" tabIndex={-1} aria-label="Fechar sincronização" onClick={() => setOpen(false)} />
      <section className="origin-popover origin-sync-panel" aria-label={`Sincronização com ${name}`}>
        <h3>Sincronização com {name}</h3>
        <p className="origin-sync-lead">{mode === 'bidirectional' ? `Cadastros, pedidos, títulos e estoque compatíveis são sincronizados com ${name} nos dois sentidos. Em conflito, vale a alteração mais recente. Operações sem suporte ou sem vínculo aparecem nas pendências.` : mode === 'receive' ? `Recebimento automático de ${name}. As alterações do FAGOO aguardam a ativação do envio.` : 'A conexão está em preparação. A coleta e o envio estão pausados.'}</p>
        {error && <p className="origin-sync-error" role="alert">{error}</p>}
        {status && !status.enabled && <p className="origin-sync-error">A sincronização está desligada.</p>}
        {status && <>
          <p className="origin-sync-run" role="status">{runText(status.run).replaceAll('Origin', name)}{status.run && statsText(status.run.stats) ? ` ${statsText(status.run.stats).replaceAll('Origin', name)}.` : ''}</p>
          <dl className="origin-sync-counts">
            <div><dt>A enviar ao {name}</dt><dd>{status.push.pending}</dd></div>
            <div><dt>A aplicar no FAGOO</dt><dd>{status.pull.pending}</dd></div>
            <div><dt>Último envio</dt><dd>{when(status.push.last_sent_at)}</dd></div>
            <div><dt>Último recebimento</dt><dd>{when(status.pull.last_applied_at)}</dd></div>
          </dl>
          {status.recent_issues.length > 0 && <details className="origin-sync-issues"><summary>{problems} pendência{problems === 1 ? '' : 's'} para conferir</summary>
            <ul>{status.recent_issues.map((issue, index) => <li key={`${issue.at}-${index}`}><small>{when(issue.at)}</small> {issueText(issue, name)}</li>)}</ul></details>}
        </>}
        {canConfigure && status?.connection && <a href={status.connection.setup_url} target="_blank" rel="noopener noreferrer">Configurar conexão</a>}
        <button type="button" className="primary-button origin-sync-start" disabled={!canRequest || !status || busy || active || status.enabled === false || mode !== 'bidirectional'}
          title={!canRequest ? 'Seu perfil é somente consulta.' : undefined} onClick={() => void synchronize()}>
          <Icon name="arrows-rotate" size={13} />{mode === 'paused' ? 'Sincronização pausada' : mode === 'receive' ? 'Recebimento automático' : busy ? 'Pedindo…' : active ? 'Sincronizando…' : pending > 0 ? `Sincronizar agora (${pending} na fila)` : 'Sincronizar agora'}
        </button>
      </section></>}
  </div>;
}
