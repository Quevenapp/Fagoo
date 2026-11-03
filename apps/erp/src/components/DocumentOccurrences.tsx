import { useEffect, useRef, useState } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { STATES } from '../lib/real-documents-model';
import { OCCURRENCE_HELP, actorLabel, brDate, occurrenceBody, occurrenceLines, readOccurrenceRemoval, readOccurrenceResult, readOccurrences, saoPauloNow, type OccurrenceDraft, type OccurrenceKind, type OccurrencePage } from '../lib/document-occurrence-model';
import { journalPage, journalPath, type ServiceJournalEntry } from '../lib/service-journal-model';
import { Icon } from './Icon';
import { Modal } from './Modal';
import './document-occurrences.css';

type Controller = Pick<AccessController, 'documents' | 'getSnapshot'> & { serviceJournal?: AccessController['serviceJournal'] };
/** 202610200240 (Origin "Visualizar ocorrências" of the OS): the newest entries of the diário da OS shown with the occurrences. */
const JOURNAL_LIMIT = 100;
const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const known = (error: unknown) => error instanceof AccessError && [400, 403, 404, 409].includes(error.status);
const failureText = (error: unknown) => error instanceof AccessError ? error.status === 409 ? 'O documento mudou ou a situação atual não permite esta mudança. Feche e confira a versão atual.'
  : error.status === 403 ? 'Seu perfil não permite registrar ocorrências neste documento.' : error.status === 400 ? 'O servidor recusou a ocorrência. Confira a situação, a data e o texto (motivo).'
    : error.status === 404 ? 'Documento não encontrado.' : 'Não foi possível concluir a operação. Tente novamente.' : 'Não foi possível concluir a operação. Tente novamente.';
const actorOf = (controller: Controller) => controller.getSnapshot()?.membership?.user_id ?? null;
export const DATE_LOCKED = 'A ocorrência registra a data e a hora atuais. Para informar outra data e hora, ative “Permite a edição da data e hora das ocorrências” em Preferências › Empresa.';
// A command adds one occurrence (body) or removes one (remove = occurrence id); both repeat the same id when uncertain.
type Command = { id: string; actor: string | null; body: ReturnType<typeof occurrenceBody> | null; remove: string | null; uncertain: boolean };

/**
 * Origin "Ocorrências": history (Data | Hora | Ocorrência | Usuário | Situação, plus Próximo Contato on propostas) and one new
 * line with today's date and time. Choosing another situação moves the document through the same server transition.
 */
export default function DocumentOccurrences({ controller, kind, documentId, label, targets, reasonNeeded, onClose, situationLabel, transitionNote, writable }: {
  controller: Controller; kind: OccurrenceKind; documentId: string; label: string;
  targets: (status: string) => readonly string[]; reasonNeeded: (from: string, to: string) => boolean; onClose: (changed: boolean) => void;
  /** 202610200163: names of the situação keys (custom ones included) and the note of a transition with actions. */
  situationLabel?: (key: string) => string; transitionNote?: (from: string, to: string) => string | null;
  /** 202610200239: false when the user does not write the kind (OS without Inclusão e edição): no new note and no Remover, as the server refuses them. */
  writable?: boolean;
}) {
  const [page, setPage] = useState<OccurrencePage | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [draft, setDraft] = useState<OccurrenceDraft>(() => ({ ...(({ date, time }) => ({ occurred_on: date, occurred_time: time }))(saoPauloNow()), text: '', status: '', next_contact: '' }));
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [reload, setReload] = useState(0), [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const command = useRef<Command | null>(null), pending = useRef<AbortController | null>(null), changed = useRef(false), mounted = useRef(true);
  const currentKey = page ? page.document.situation?.key ?? page.document.status : '';
  const dirty = Boolean(draft.text.trim() || (page && draft.status && draft.status !== currentKey) || draft.next_contact);
  const guard = useUnsavedChanges(dirty || uncertain, busy);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; pending.current?.abort(); }; }, []);
  useEffect(() => {
    const request = new AbortController(), actor = actorOf(controller); setLoading(true); setError('');
    void Promise.resolve().then(() => controller.documents(`/v1/documentos/${kind}/${documentId}/ocorrencias`, { signal: request.signal })).then(value => {
      if (request.signal.aborted || actorOf(controller) !== actor) return;
      const read = readOccurrences(value, kind, documentId); setPage(read); setDraft(previous => ({ ...previous, status: previous.status || (read.document.situation?.key ?? read.document.status) })); setLoading(false);
    }).catch(failure => { if (!request.signal.aborted && !aborted(failure)) { setError(failure instanceof AccessError ? failureText(failure) : 'Não foi possível conferir as ocorrências.'); setLoading(false); } });
    return () => request.abort();
  }, [controller, kind, documentId, reload]);
  // The diário da OS (028) is read beside the occurrences; a profile or database without it keeps the occurrences alone.
  const [journal, setJournal] = useState<{ items: ServiceJournalEntry[]; has_more: boolean } | null>(null), [journalError, setJournalError] = useState('');
  useEffect(() => {
    if (kind !== 'service_orders' || typeof controller.serviceJournal !== 'function') return;
    let path: string; try { path = `${journalPath(documentId)}?limit=${JOURNAL_LIMIT}`; } catch { return; }
    const request = new AbortController(), actor = actorOf(controller); setJournalError('');
    void Promise.resolve().then(() => controller.serviceJournal!(path, { signal: request.signal })).then(value => {
      if (request.signal.aborted || actorOf(controller) !== actor) return;
      const read = journalPage(value, documentId.toLowerCase(), null, JOURNAL_LIMIT); setJournal({ items: read.items, has_more: read.has_more });
    }).catch(failure => { if (!request.signal.aborted && !aborted(failure)) { setJournal(null); setJournalError('Não foi possível consultar o diário da OS; a lista mostra só as ocorrências.'); } });
    return () => request.abort();
  }, [controller, kind, documentId, reload]);
  const execute = async () => {
    const op = command.current; if (!op || pending.current) return;
    if (actorOf(controller) !== op.actor) { command.current = null; setUncertain(false); setError('A sessão mudou. Confira as ocorrências antes de repetir.'); return; }
    const request = new AbortController(); pending.current = request; setBusy(true); setError(''); setNotice('');
    try {
      const value = await controller.documents(op.remove ? `/v1/documentos/${kind}/${documentId}/ocorrencias/${op.remove}/exclusao` : `/v1/documentos/${kind}/${documentId}/ocorrencias`, { method: 'POST', body: op.remove ? { command_id: op.id } : { ...op.body, command_id: op.id }, signal: request.signal });
      if (request.signal.aborted || !mounted.current) return;
      if (actorOf(controller) !== op.actor) { command.current = null; setUncertain(false); setError('A sessão mudou durante a operação. Confira as ocorrências antes de repetir.'); return; }
      if (op.remove) { try { readOccurrenceRemoval(value, kind, documentId, op.remove); } catch { throw new AccessError(502); } command.current = null; setUncertain(false); setConfirmRemove(null); setNotice('Ocorrência removida.'); setReload(value => value + 1); return; }
      let result; try { result = readOccurrenceResult(value, kind, documentId, op.body!); } catch { throw new AccessError(502); }
      command.current = null; setUncertain(false); changed.current = true;
      const now = saoPauloNow(), key = result.document.situation?.key ?? result.document.status; setDraft({ occurred_on: now.date, occurred_time: now.time, text: '', status: key, next_contact: '' });
      setNotice(op.body!.status ? `Ocorrência salva e situação alterada para ${statusText(key)}.` : 'Ocorrência salva.');
      setReload(value => value + 1);
    } catch (failure) {
      if (request.signal.aborted || aborted(failure) || !mounted.current) return;
      if (!op.uncertain && known(failure)) { command.current = null; setUncertain(false); setConfirmRemove(null); setError(op.remove && failure instanceof AccessError && failure.status === 404 ? 'Esta ocorrência já foi removida ou não pertence a este documento.' : failureText(failure)); if (op.remove) setReload(value => value + 1); }
      else { op.uncertain = true; setUncertain(true); setError(op.remove ? 'Não foi possível confirmar a remoção. Use “Conferir resultado” para repetir a mesma operação.' : 'Não foi possível confirmar a ocorrência. Use “Conferir resultado” para repetir a mesma operação sem duplicar.'); }
    } finally { if (pending.current === request) pending.current = null; if (mounted.current && !request.signal.aborted) setBusy(false); }
  };
  const save = () => {
    if (!page || busy || uncertain || command.current) return;
    let body; try { body = occurrenceBody(kind, page.document, draft, Boolean(draft.status && draft.status !== currentKey && reasonNeeded(currentKey, draft.status))); }
    catch (failure) { setError((failure as Error).message); return; }
    command.current = { id: crypto.randomUUID(), actor: actorOf(controller), body: structuredClone(body), remove: null, uncertain: false }; void execute();
  };
  // Origin "Remover ocorrência": confirmed first ("Confirma exclusão definitiva da ocorrência?"); the server keeps it in the audit.
  const remove = () => {
    if (!page || !confirmRemove || busy || uncertain || command.current || !page.items.some(item => item.id === confirmRemove)) return;
    command.current = { id: crypto.randomUUID(), actor: actorOf(controller), body: null, remove: confirmRemove, uncertain: false }; void execute();
  };
  const close = () => { if (busy) return; guard.confirmLeave(() => onClose(changed.current)); };
  const change = <K extends keyof OccurrenceDraft>(key: K, value: OccurrenceDraft[K]) => { if (busy || uncertain) return; setDraft(previous => ({ ...previous, [key]: value })); setError(''); };
  const me = actorOf(controller), proposal = kind === 'sales_proposals', editable = Boolean(page?.can_write) && writable !== false, frozen = busy || uncertain;
  const options = page ? [currentKey, ...targets(currentKey)] : [];
  const statusText = (status: string) => situationLabel ? situationLabel(status) : STATES[kind][status] ?? status;
  // Without the Preferências option the server records the current date and time; the fields then only show them.
  const dateLocked = page?.date_editable === false, note = page && draft.status && draft.status !== currentKey ? transitionNote?.(currentKey, draft.status) ?? null : null;
  const shown = (item: OccurrencePage['items'][number]) => item.situation_after ? `${item.situation_before?.name ?? statusText(item.status_before)} → ${item.situation_after.name}`
    : item.status_after ? `${statusText(item.status_before)} → ${statusText(item.status_after)}` : item.situation_before?.name ?? statusText(item.status_before);
  const lines = page ? occurrenceLines(page.items, kind === 'service_orders' ? journal?.items ?? [] : []) : [];
  // The diário keeps only the author id: the name of the same user in the occurrences (Sistema › Usuários), else Você / Outro usuário.
  const journalActor = (actorId: string) => page?.items.find(item => item.actor_id === actorId && item.actor_name)?.actor_name ?? (actorId === me ? 'Você' : 'Outro usuário');
  return <Modal title="Ocorrências" onClose={close} actions={<>{uncertain && <button type="button" className="primary-button" disabled={busy} onClick={() => void execute()}>{busy ? 'Conferindo…' : 'Conferir resultado'}</button>}<button type="button" className="secondary-button" disabled={busy} onClick={close}>Fechar</button></>}>
    <div className="document-occurrences">
      <p className="document-occurrences-label">{label}</p>
      <p className="real-help">{OCCURRENCE_HELP[kind]}</p>
      {loading && <p role="status">Consultando ocorrências…</p>}
      {error && <p className="real-alert" role="alert">{error}</p>}
      {notice && <p className="real-success" role="status">{notice}</p>}
      {confirmRemove && page && <div className="document-occurrence-confirm" role="alertdialog" aria-label="Remover ocorrência"><p>Confirma exclusão definitiva da ocorrência?</p><button type="button" className="primary-button" disabled={frozen} onClick={remove}>{busy ? 'Removendo…' : 'Sim'}</button><button type="button" className="secondary-button" disabled={frozen} onClick={() => setConfirmRemove(null)}>Não</button></div>}
      {page && <div className="table-scroll" tabIndex={0} aria-label="Ocorrências do documento"><table className="data-table document-occurrences-table"><thead><tr><th>Data</th><th>Hora</th><th>Ocorrência</th><th>Usuário</th><th>Situação</th>{proposal && <th>Próximo Contato</th>}<th><span className="sr-only">Ações</span></th></tr></thead>
        <tbody>
          {editable && <tr className="document-occurrence-new">
            <td><input id="occurrence-date" type="date" aria-label="Data da ocorrência" value={draft.occurred_on} disabled={frozen} readOnly={dateLocked} title={dateLocked ? DATE_LOCKED : undefined} onChange={event => { if (!dateLocked) change('occurred_on', event.target.value); }} /></td>
            <td><input id="occurrence-time" type="time" aria-label="Hora da ocorrência" value={draft.occurred_time} disabled={frozen} readOnly={dateLocked} title={dateLocked ? DATE_LOCKED : undefined} onChange={event => { if (!dateLocked) change('occurred_time', event.target.value); }} /></td>
            <td><textarea id="occurrence-text" aria-label="Ocorrência" rows={2} maxLength={1000} value={draft.text} disabled={frozen} onChange={event => change('text', event.target.value)} /></td>
            <td>{me ? 'Você' : ''}</td>
            <td><select id="occurrence-status" aria-label="Situação" value={draft.status} disabled={frozen} onChange={event => change('status', event.target.value)}>{options.map(status => <option key={status} value={status}>{statusText(status)}</option>)}</select></td>
            {proposal && <td><input id="occurrence-next-contact" type="date" aria-label="Próximo contato" value={draft.next_contact} disabled={frozen} onChange={event => change('next_contact', event.target.value)} /></td>}
            <td><button type="button" className="secondary-button" title="Salvar ocorrência" aria-label="Salvar ocorrência" disabled={frozen} onClick={save}>{busy ? 'Salvando…' : 'Salvar ocorrência'}</button></td>
          </tr>}
          {lines.map(line => line.type === 'journal'
            ? <tr key={`diario-${line.id}`} className="document-occurrence-journal"><td>{brDate(line.date)}</td><td>{line.time}</td><td className="document-occurrence-text">{line.text}</td><td>{journalActor(line.actor_id)}</td><td>Diário da OS</td><td /></tr>
            : <tr key={line.item.id}><td>{line.item.sequence}. {brDate(line.item.occurred_on)}</td><td>{line.item.occurred_time}</td><td className="document-occurrence-text">{line.item.text ?? '—'}</td><td>{actorLabel(line.item, me)}</td>
            <td>{shown(line.item)}</td>{proposal && <td>{brDate(line.item.next_contact)}</td>}<td>{editable && <button type="button" className="text-button document-occurrence-remove" title="Remover ocorrência" aria-label={`Remover ocorrência ${line.item.sequence}`} disabled={frozen || Boolean(confirmRemove)} onClick={() => { const id = line.item.id; setError(''); setNotice(''); setConfirmRemove(id); }}><Icon name="trash-can" size={12} /></button>}</td></tr>)}
          {!lines.length && <tr><td colSpan={proposal ? 7 : 6}>Nenhuma ocorrência registrada.</td></tr>}
        </tbody></table></div>}
      {note && <p className="real-notice" role="note">{note}</p>}
      {dateLocked && <p className="real-help">{DATE_LOCKED}</p>}
      {page?.has_more && <p className="real-help">São exibidas as 500 ocorrências mais recentes.</p>}
      {page && journal?.has_more && <p className="real-help">São exibidas as {JOURNAL_LIMIT} entradas mais recentes do diário da OS.</p>}
      {page && journalError && <p className="real-help" role="note">{journalError}</p>}
      {page && !editable && <p className="real-help">Seu perfil permite apenas consultar as ocorrências.</p>}
    </div>
  </Modal>;
}
