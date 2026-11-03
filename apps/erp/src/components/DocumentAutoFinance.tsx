import { useEffect, useRef, useState } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import { parsePreferencesPage, parsePreferencesResult, type PreferencesPageView } from '../lib/preferences-model';
import { preferencesCommandPath, preferencesPagePath } from '../lib/preferences-request';
import { Modal } from './Modal';

type Controller = Pick<AccessController, 'preferences' | 'getSnapshot'>;
const KEY = 'vendas.contas_automaticas_pedido', PAGE = 'vendas-vendas';
const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

/**
 * Origin modal "Lançamento automático de contas a receber" of the pedido de venda (202610200196): "Ativar em Pedidos de venda"
 * saves Preferências › Vendas › Vendas "Lançamento automático de contas em Pedidos de Venda" (administrador, one command with
 * "Conferir resultado"). The notas fiscais of the Brufap do not post contas yet, so that switch stays disabled.
 */
export default function DocumentAutoFinance({ controller, onClose }: { controller: Controller; onClose: (changed: boolean) => void }) {
  const [view, setView] = useState<PreferencesPageView | null>(null), [checked, setChecked] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false), [saved, setSaved] = useState(false);
  const actor = useRef(controller.getSnapshot().membership?.user_id ?? null), attempt = useRef<{ command_id: string; changes: { key: string; expected_version: number; value: boolean }[] } | null>(null);
  const alive = useRef(true);
  const same = () => alive.current && (controller.getSnapshot().membership?.user_id ?? null) === actor.current;
  useEffect(() => {
    alive.current = true; const request = new AbortController();
    void Promise.resolve().then(() => controller.preferences(preferencesPagePath(PAGE), { method: 'GET', signal: request.signal })).then(raw => {
      if (request.signal.aborted || !same()) return; const page = parsePreferencesPage(raw, PAGE); setView(page); setChecked(page.items.find(item => item.key === KEY)?.value === true);
    }).catch(failure => { if (!request.signal.aborted && !aborted(failure)) setError('Não foi possível consultar as Preferências de vendas.'); });
    return () => { alive.current = false; request.abort(); };
  }, [controller]);
  const item = view?.items.find(entry => entry.key === KEY);
  const run = async (lookup: boolean) => {
    const body = attempt.current; if (!body || busy || !same()) return;
    setBusy(true); setError('');
    try {
      const raw = lookup ? await controller.preferences(preferencesCommandPath(body.command_id), { method: 'GET' }) : await controller.preferences(preferencesPagePath(PAGE), { method: 'POST', body });
      if (!same()) return;
      const result = parsePreferencesResult(raw, { commandId: body.command_id, pageId: PAGE, input: body, lookup });
      attempt.current = null; setUncertain(false); setView(result.page); setChecked(result.page.items.find(entry => entry.key === KEY)?.value === true); setSaved(true);
    } catch (failure) {
      if (!same()) return;
      const definitive = !lookup && !uncertain && failure instanceof AccessError && [400, 403, 404, 409].includes(failure.status);
      if (definitive) { attempt.current = null; setError(failure.status === 403 ? 'Somente o administrador altera as Preferências de vendas.' : 'A preferência mudou desde a consulta. Feche e abra de novo para conferir.'); }
      else { setUncertain(true); setError('Não foi possível confirmar a gravação. Use “Conferir resultado” para conferir o mesmo comando.'); }
    } finally { if (alive.current) setBusy(false); }
  };
  const save = () => {
    if (!view?.can_manage || !item || busy || uncertain || attempt.current) return;
    if (checked === (item.value === true)) { onClose(saved); return; }
    attempt.current = { command_id: crypto.randomUUID(), changes: [{ key: KEY, expected_version: item.version, value: checked }] }; void run(false);
  };
  return <Modal title="Lançamento automático de contas a receber" onClose={() => { if (!busy) onClose(saved); }}
    actions={<><button type="button" className="secondary-button" disabled={busy} onClick={() => onClose(saved)}>Fechar</button>
      {uncertain ? <button type="button" className="primary-button" disabled={busy} onClick={() => void run(true)}>{busy ? 'Conferindo…' : 'Conferir resultado'}</button>
        : view?.can_manage && <button type="button" className="primary-button" disabled={busy || !item} onClick={save}>{busy ? 'Salvando…' : 'Salvar'}</button>}</>}>
    <p>Com o lançamento automático, as contas a receber do pedido são lançadas ao salvar o pedido numa situação de lançamento (Verificado, Em andamento, Atendido parcialmente ou Atendido) ou ao mudar para uma delas, com as parcelas do pedido.</p>
    <label className="document-check"><input id="doc-auto-finance-orders" type="checkbox" checked={checked} disabled={!view?.can_manage || busy || uncertain} onChange={event => setChecked(event.target.checked)}/>Ativar em Pedidos de venda</label>
    <label className="document-check"><input id="doc-auto-finance-invoices" type="checkbox" checked={false} disabled onChange={() => undefined}/>Ativar em Notas fiscais</label>
    <p className="real-help">As notas fiscais do FAGOO ainda não lançam contas; esta opção fica desativada.</p>
    {view && !view.can_manage && <p className="real-help">Somente o administrador altera esta preferência.</p>}
    <p className="real-help">Para desativar essa função acesse: Preferências &gt; Vendas &gt; Vendas</p>
    {saved && !error && <p className="real-success" role="status">Preferência salva.</p>}
    {error && <p className="real-alert" role="alert">{error}</p>}
  </Modal>;
}
