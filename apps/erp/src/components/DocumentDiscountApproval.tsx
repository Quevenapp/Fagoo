import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AccessError, type AccessController } from '../lib/real-access';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { readSituations, type SituationModel } from '../lib/document-situations-model';
import { readDiscountApproval, type DiscountApproval } from '../lib/document-approval-model';

// Preferências › Vendas › Vendas "Situação para aprovação de descontos" (202610200239): up to five custom situações of Em digitação,
// in order. A pedido of a vendedor above his "Limite de desconto" goes to the first active one and waits for an approver. The
// administrador saves with CAS on the version read and a command of its own; an unconfirmed answer repeats the same command.
const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const actorOf = (controller: AccessController) => controller.getSnapshot?.()?.membership?.user_id ?? null;
const PATH = '/v1/documentos/sales_orders/aprovacao-descontos';

export default function DocumentDiscountApproval({ controller, onClose }: { controller: AccessController; onClose: () => void }) {
  const [current, setCurrent] = useState<DiscountApproval | null>(null), [model, setModel] = useState<SituationModel | null>(null), [draft, setDraft] = useState<string[]>([]);
  const [loading, setLoading] = useState(true), [reload, setReload] = useState(0), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const command = useRef<{ id: string; actor: string | null; body: { expected_version: number; situations: string[] }; uncertain: boolean } | null>(null), pending = useRef<AbortController | null>(null), mounted = useRef(true);
  const dirty = Boolean(current && JSON.stringify(draft) !== JSON.stringify(current.situations.map(s => s.id)));
  const guard = useUnsavedChanges(dirty || uncertain, busy);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; pending.current?.abort(); }; }, []);
  useEffect(() => {
    const request = new AbortController(), actor = actorOf(controller); setLoading(true);
    void Promise.all([controller.documents(PATH, { signal: request.signal }), controller.documents('/v1/documentos/sales_orders/situacoes', { signal: request.signal })]).then(([value, situations]) => {
      if (request.signal.aborted || actorOf(controller) !== actor) return;
      const read = readDiscountApproval(value, false); setCurrent(read); setDraft(read.situations.map(s => s.id)); setModel(readSituations(situations, 'sales_orders')); setLoading(false);
    }).catch(failure => { if (!request.signal.aborted && !aborted(failure)) { setError(failure instanceof AccessError && failure.status === 403 ? 'Seu perfil não consulta os pedidos de venda.' : 'Não foi possível consultar a configuração.'); setLoading(false); } });
    return () => request.abort();
  }, [controller, reload]);
  const execute = async () => {
    const op = command.current; if (!op || pending.current) return;
    if (actorOf(controller) !== op.actor) { command.current = null; setUncertain(false); setError('A sessão mudou. Abra a configuração de novo antes de repetir.'); return; }
    const request = new AbortController(); pending.current = request; setBusy(true); setError(''); setNotice('');
    try {
      const value = await controller.documents(PATH, { method: 'POST', body: { ...op.body, command_id: op.id }, signal: request.signal });
      if (request.signal.aborted || !mounted.current) return;
      if (actorOf(controller) !== op.actor) { command.current = null; setUncertain(false); setError('A sessão mudou durante a operação. Abra a configuração de novo antes de repetir.'); return; }
      const read = readDiscountApproval(value, true); command.current = null; setUncertain(false); setCurrent(read); setDraft(read.situations.map(s => s.id));
      setNotice(read.situations.length ? `Situação para aprovação de descontos: ${read.situations.map(s => s.name).join(', ')}.` : 'Sem situação de aprovação: o pedido acima do limite de desconto do vendedor volta a ser recusado.');
    } catch (failure) {
      if (request.signal.aborted || aborted(failure) || !mounted.current) return;
      if (op.uncertain || !(failure instanceof AccessError) || ![400, 403, 409].includes(failure.status)) { op.uncertain = true; setUncertain(true); setError('Não foi possível confirmar a alteração. Use “Conferir resultado” para repetir o mesmo comando.'); return; }
      command.current = null; setUncertain(false);
      setError(failure.status === 403 ? 'Somente o administrador escolhe a situação para aprovação de descontos.' : failure.status === 409 ? 'A configuração mudou. Ela foi consultada de novo; confira e tente outra vez.' : 'Escolha até cinco situações personalizadas ativas de Em digitação.');
      if (failure.status === 409) setReload(value => value + 1);
    } finally { if (pending.current === request) pending.current = null; if (mounted.current && !request.signal.aborted) setBusy(false); }
  };
  const save = () => {
    if (!current || busy || uncertain || command.current || !dirty) return;
    command.current = { id: crypto.randomUUID(), actor: actorOf(controller), body: { expected_version: current.version, situations: [...draft] }, uncertain: false }; void execute();
  };
  // Custom situações of Em digitação: the active ones, plus a configured one that was inactivated (to remove it).
  const options = (model?.situations ?? []).filter(s => !s.default && s.base_status === 'draft' && (s.active || draft.includes(s.key)));
  const toggle = (key: string, on: boolean) => setDraft(previous => on ? (previous.includes(key) || previous.length >= 5 ? previous : [...previous, key]) : previous.filter(item => item !== key));
  const locked = busy || uncertain || loading || !current?.can_write;
  return <section className="real-editor document-numbering" aria-labelledby="document-approval-title">
    <header className="real-editor-heading"><div><h2 id="document-approval-title">Situação para aprovação de descontos</h2><p>Preferências › Vendas › Vendas</p></div>
      <div className="document-editor-buttons"><div><button type="button" className="secondary-button" disabled={busy || uncertain} onClick={() => guard.confirmLeave(onClose)}>Cancelar</button>
        <button type="button" className="primary-button" disabled={locked || !dirty} onClick={save}>{busy ? 'Salvando…' : 'Salvar'}</button></div></div></header>
    {loading && <p role="status">Consultando a configuração…</p>}
    {error && <p className="real-alert" role="alert">{error}</p>}
    {notice && <p className="real-success" role="status">{notice}</p>}
    {uncertain && <div className="real-editor-actions"><button type="button" className="primary-button" disabled={busy} onClick={() => void execute()}>{busy ? 'Conferindo…' : 'Conferir resultado'}</button></div>}
    {current && !current.can_write && <p className="real-notice" role="note">Somente o administrador altera esta configuração.</p>}
    {current && (options.length ? <fieldset className="documents-status-filter" disabled={locked}><legend>Situações personalizadas de Em digitação (até cinco, na ordem escolhida)</legend>
      {options.map(s => <label key={s.key} htmlFor={`approval-${s.key}`}><input id={`approval-${s.key}`} type="checkbox" checked={draft.includes(s.key)} onChange={event => toggle(s.key, event.target.checked)} />
        {s.name}{draft.includes(s.key) ? ` (${draft.indexOf(s.key) + 1}ª)` : ''}{s.active ? '' : ' (inativa)'}</label>)}</fieldset>
      : <p className="real-help">Não há situações personalizadas de Em digitação. Crie uma em <Link to="/preferencias/sistema/gerenciador-transicoes">Preferências › Sistema › Gerenciador de transições</Link> (por exemplo, “Aguardando aprovação”) e a transição dela para as situações em que o pedido segue.</p>)}
    <p className="real-help">O pedido de venda de um vendedor com desconto acima do “Limite de desconto” (Cadastros › Vendedores) vai para Em digitação na primeira situação ativa escolhida, com a ocorrência “Venda enviada para aprovação do desconto”. Só o administrador ou quem tem “Desconsiderar limite de desconto do vendedor” (Sistema › Usuários › Permissões) tira o pedido dessas situações. Sem situação escolhida, o pedido acima do limite é recusado. A Frente de caixa, as propostas e as ordens de serviço continuam recusando o desconto acima do limite.</p>
  </section>;
}
