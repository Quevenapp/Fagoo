import { useEffect, useRef, useState } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { PRINT_HEADER_TITLES, printHeaderPath, readPrintHeader, type PrintHeader } from '../lib/print-header-model';
import { normalizeRichText, richTextEmpty, type RichText } from '../lib/rich-text-model';
import type { DocumentKind } from '../lib/real-documents-model';
import { RichTextEditor } from './RichTextEditor';
import { RichTextView } from './RichTextView';

// 202610200270 "Exibir tipo de cabeçalho: Personalizado": the header of the prints of the kind. The administrador saves it with a
// command of its own, the version read (CAS) and "Conferir resultado"; the other profiles see it. The text never becomes HTML.
const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const actorOf = (controller: AccessController) => controller.getSnapshot?.()?.membership?.user_id ?? null;
const same = (a: RichText | null, b: RichText | null) => JSON.stringify(a) === JSON.stringify(b);

export default function DocumentPrintHeader({ controller, kind, onClose }: { controller: AccessController; kind: DocumentKind; onClose: () => void }) {
  const [current, setCurrent] = useState<PrintHeader | null>(null), [draft, setDraft] = useState<RichText | null>(null), [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const command = useRef<{ id: string; actor: string | null; body: { expected_version: number; content: RichText | null }; uncertain: boolean } | null>(null), pending = useRef<AbortController | null>(null), mounted = useRef(true);
  const content = draft && !richTextEmpty(draft) ? draft : null, dirty = Boolean(current && !same(content, current.content));
  const guard = useUnsavedChanges(dirty || uncertain, busy);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; pending.current?.abort(); }; }, []);
  useEffect(() => {
    const request = new AbortController(), actor = actorOf(controller); setLoading(true);
    void Promise.resolve().then(() => controller.documents(printHeaderPath(kind), { signal: request.signal })).then(value => {
      if (request.signal.aborted || actorOf(controller) !== actor) return;
      const read = readPrintHeader(value, kind); setCurrent(read); setDraft(read.content); setLoading(false);
    }).catch(failure => { if (!request.signal.aborted && !aborted(failure)) { setError(failure instanceof AccessError && failure.status === 403 ? 'Seu perfil não consulta os documentos deste tipo.' : 'Não foi possível consultar o cabeçalho personalizado.'); setLoading(false); } });
    return () => request.abort();
  }, [controller, kind, reload]);
  const execute = async () => {
    const op = command.current; if (!op || pending.current) return;
    if (actorOf(controller) !== op.actor) { command.current = null; setUncertain(false); setError('A sessão mudou. Consulte o cabeçalho antes de repetir.'); return; }
    const request = new AbortController(); pending.current = request; setBusy(true); setError(''); setNotice('');
    try {
      const value = await controller.documents(printHeaderPath(kind), { method: 'POST', body: { ...op.body, command_id: op.id }, signal: request.signal });
      if (request.signal.aborted || !mounted.current) return;
      if (actorOf(controller) !== op.actor) { command.current = null; setUncertain(false); setError('A sessão mudou durante a operação. Consulte o cabeçalho antes de repetir.'); return; }
      const read = readPrintHeader(value, kind, true); command.current = null; setUncertain(false); setCurrent(read); setDraft(read.content);
      setNotice(read.content ? 'Cabeçalho personalizado salvo.' : 'Cabeçalho personalizado removido: a impressão volta ao cabeçalho padrão.');
    } catch (failure) {
      if (request.signal.aborted || aborted(failure) || !mounted.current) return;
      if (op.uncertain || !(failure instanceof AccessError) || ![400, 403, 409].includes(failure.status)) { op.uncertain = true; setUncertain(true); setError('Não foi possível confirmar a gravação. Use “Conferir resultado” para repetir o mesmo comando.'); return; }
      command.current = null; setUncertain(false);
      setError(failure.status === 403 ? 'Somente o administrador altera o cabeçalho personalizado.' : failure.status === 409 ? 'O cabeçalho foi alterado em outra tela. A versão atual foi consultada de novo; confira e salve outra vez.' : 'Confira o texto do cabeçalho.');
      if (failure.status === 409) setReload(value => value + 1);
    } finally { if (pending.current === request) pending.current = null; if (mounted.current && !request.signal.aborted) setBusy(false); }
  };
  const save = () => {
    if (!current || busy || uncertain || command.current) return;
    try { normalizeRichText(content); } catch { setError('Confira o texto do cabeçalho.'); return; }
    command.current = { id: crypto.randomUUID(), actor: actorOf(controller), body: { expected_version: current.version, content }, uncertain: false }; void execute();
  };
  const manage = Boolean(current?.can_manage);
  return <section className="real-editor" aria-labelledby="document-print-header-title">
    <header className="real-editor-heading"><div><h2 id="document-print-header-title">Cabeçalho personalizado · {PRINT_HEADER_TITLES[kind]}</h2>
      <p>Usado na impressão quando as Preferências escolhem “Exibir tipo de cabeçalho: Personalizado”. Sem texto, a impressão mantém o cabeçalho padrão com os dados da empresa.</p></div>
      <div className="document-editor-buttons"><div><button type="button" className="secondary-button" disabled={busy} onClick={() => guard.confirmLeave(onClose)}>Voltar</button>
        {manage && <button type="button" className="primary-button" disabled={busy || uncertain || !dirty} onClick={save}>{busy ? 'Salvando…' : 'Salvar'}</button>}</div></div></header>
    {loading && <p role="status">Consultando o cabeçalho…</p>}
    {error && <p className="real-alert" role="alert">{error}</p>}{notice && <p className="real-success" role="status">{notice}</p>}
    {uncertain && <div className="real-editor-actions"><button type="button" className="primary-button" disabled={busy} onClick={() => void execute()}>{busy ? 'Conferindo…' : 'Conferir resultado'}</button></div>}
    {current && (manage ? <RichTextEditor id="document-print-header-text" label="Cabeçalho" value={draft} disabled={busy || uncertain} onChange={value => { setDraft(value); setNotice(''); }} />
      : <><p className="real-notice">Somente o administrador altera o cabeçalho personalizado.</p>{current.content ? <RichTextView value={current.content} label="Cabeçalho" /> : <p>Nenhum cabeçalho personalizado.</p>}</>)}
  </section>;
}
