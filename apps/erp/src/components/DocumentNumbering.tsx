import { useEffect, useRef, useState } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { documentNumber } from '../../../../packages/erp-domain/src/index.mjs';
import type { DocumentKind } from '../lib/real-documents-model';

// Origin Preferências "Próximo número" (202610200129): read the next and the lowest free number, set it with CAS on the
// number read and a command of its own; an unconfirmed answer repeats the same command ("Conferir resultado").
const TITLES: Record<DocumentKind, string> = { sales_orders: 'Pedidos de venda', sales_proposals: 'Propostas comerciais', service_orders: 'Ordens de serviço', purchase_orders: 'Pedidos de compra' };
type Numbering = { next_number: string | null; minimum_next_number: string | null };
const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const actorOf = (controller: AccessController) => controller.getSnapshot?.()?.membership?.user_id ?? null;
function readNumbering(value: unknown, kind: DocumentKind, setting: boolean): Numbering {
  const result = value as { kind?: unknown; next_number?: unknown; minimum_next_number?: unknown; reserved?: unknown; replayed?: unknown };
  const number = (v: unknown) => v === null || documentNumber(v);
  if (!result || result.kind !== kind || result.reserved !== false || !number(result.next_number) || (result.minimum_next_number !== undefined && !number(result.minimum_next_number))
    || (setting && (typeof result.replayed !== 'boolean' || result.next_number === null))) throw new AccessError(502);
  return { next_number: result.next_number as string | null, minimum_next_number: (result.minimum_next_number ?? null) as string | null };
}
const lessThan = (a: string, b: string) => a.length !== b.length ? a.length < b.length : a < b;

export default function DocumentNumbering({ controller, kind, onClose }: { controller: AccessController; kind: DocumentKind; onClose: () => void }) {
  const [current, setCurrent] = useState<Numbering | null>(null), [draft, setDraft] = useState(''), [loading, setLoading] = useState(true), [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const command = useRef<{ id: string; actor: string | null; body: { expected_next_number: string; next_number: string }; uncertain: boolean } | null>(null), pending = useRef<AbortController | null>(null), mounted = useRef(true);
  const dirty = Boolean(current && draft.trim() !== (current.next_number ?? ''));
  const guard = useUnsavedChanges(dirty || uncertain, busy);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; pending.current?.abort(); }; }, []);
  useEffect(() => {
    // A reread after a conflict keeps the message that explains it.
    const request = new AbortController(), actor = actorOf(controller); setLoading(true);
    void Promise.resolve().then(() => controller.documents(`/v1/documentos/${kind}/proximo-numero`, { signal: request.signal })).then(value => {
      if (request.signal.aborted || actorOf(controller) !== actor) return;
      const read = readNumbering(value, kind, false); setCurrent(read); setDraft(read.next_number ?? ''); setLoading(false);
    }).catch(failure => { if (!request.signal.aborted && !aborted(failure)) { setError(failure instanceof AccessError && failure.status === 403 ? 'Somente o administrador ajusta o próximo número.' : 'Não foi possível consultar a numeração.'); setLoading(false); } });
    return () => request.abort();
  }, [controller, kind, reload]);
  const execute = async () => {
    const op = command.current; if (!op || pending.current) return;
    if (actorOf(controller) !== op.actor) { command.current = null; setUncertain(false); setError('A sessão mudou. Consulte a numeração antes de repetir.'); return; }
    const request = new AbortController(); pending.current = request; setBusy(true); setError(''); setNotice('');
    try {
      const value = await controller.documents(`/v1/documentos/${kind}/proximo-numero`, { method: 'POST', body: { ...op.body, command_id: op.id }, signal: request.signal });
      if (request.signal.aborted || !mounted.current) return;
      if (actorOf(controller) !== op.actor) { command.current = null; setUncertain(false); setError('A sessão mudou durante a operação. Consulte a numeração antes de repetir.'); return; }
      const read = readNumbering(value, kind, true); command.current = null; setUncertain(false); setCurrent(read); setDraft(read.next_number ?? '');
      setNotice(`Próximo número alterado para ${read.next_number}.`);
    } catch (failure) {
      if (request.signal.aborted || aborted(failure) || !mounted.current) return;
      // A replayed command that fails is still unconfirmed: the first attempt may be registered.
      if (op.uncertain || !(failure instanceof AccessError) || ![400, 403, 409].includes(failure.status)) { op.uncertain = true; setUncertain(true); setError('Não foi possível confirmar a alteração. Use “Conferir resultado” para repetir o mesmo comando.'); return; }
      command.current = null; setUncertain(false);
      setError(failure.status === 403 ? 'Somente o administrador ajusta o próximo número.' : failure.status === 409 ? 'A numeração mudou ou o número já foi usado. A numeração atual foi consultada de novo; confira e tente outra vez.' : 'Informe um número diferente do atual, de 1 a 9999999999.');
      if (failure.status === 409) setReload(value => value + 1);
    } finally { if (pending.current === request) pending.current = null; if (mounted.current && !request.signal.aborted) setBusy(false); }
  };
  const save = () => {
    if (!current?.next_number || busy || uncertain || command.current) return;
    const next = draft.trim();
    if (!documentNumber(next)) { setError('Informe um número de 1 a 9999999999, sem zeros à esquerda.'); return; }
    if (current.minimum_next_number && lessThan(next, current.minimum_next_number)) { setError(`O próximo número precisa ser ${current.minimum_next_number} ou maior: os números abaixo já foram usados.`); return; }
    if (next === current.next_number) { setError('Informe um número diferente do atual.'); return; }
    command.current = { id: crypto.randomUUID(), actor: actorOf(controller), body: { expected_next_number: current.next_number, next_number: next }, uncertain: false }; void execute();
  };
  return <section className="real-editor document-numbering" aria-labelledby="document-numbering-title">
    <header className="real-editor-heading"><div><h2 id="document-numbering-title">Próximo número · {TITLES[kind]}</h2><p>Preferências › numeração dos documentos</p></div>
      <div className="document-editor-buttons"><div><button type="button" className="secondary-button" disabled={busy || uncertain} onClick={() => guard.confirmLeave(onClose)}>Cancelar</button><button type="button" className="primary-button" disabled={busy || uncertain || loading || !current?.next_number || !current.minimum_next_number} onClick={save}>{busy ? 'Salvando…' : 'Salvar'}</button></div></div></header>
    {loading && <p role="status">Consultando a numeração…</p>}
    {error && <p className="real-alert" role="alert">{error}</p>}
    {notice && <p className="real-success" role="status">{notice}</p>}
    {uncertain && <div className="real-editor-actions"><button type="button" className="primary-button" disabled={busy} onClick={() => void execute()}>{busy ? 'Conferindo…' : 'Conferir resultado'}</button></div>}
    {current && <div className="document-grid"><div className="form-field"><label htmlFor="doc-numbering-next">Próximo número</label><input id="doc-numbering-next" inputMode="numeric" maxLength={10} value={draft} disabled={busy || uncertain || !current.minimum_next_number} onChange={event => { setDraft(event.target.value); setError(''); setNotice(''); }} />
      <small>{current.minimum_next_number ? `Use ${current.minimum_next_number} ou um número maior (os anteriores já foram usados). O número só é reservado quando um documento é salvo.` : 'A numeração ainda não pode ser ajustada neste banco.'}</small></div></div>}
    <p className="real-help">A alteração vale para os próximos documentos deste tipo e fica registrada com o seu usuário. Documentos já salvos mantêm o número.</p>
  </section>;
}
