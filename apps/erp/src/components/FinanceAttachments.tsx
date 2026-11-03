import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { useEffect, useRef, useState } from 'react';
import { AccessError, type AttachmentRequestOptions } from '../lib/real-access';
import { attachmentDay, attachmentFileType, attachmentSize, fileHash } from '../lib/attachment-model';
import { FINANCE_FILE_LIMIT, financeFileEnvelope, financeFiles, financeFilesPath, resumableFinanceFile, type FinanceFileOwner, type FinanceFileRecord } from '../lib/finance-files-model';
import './document-attachments.css';

const cancelled = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
type UploadAttempt = { kind: 'upload'; file: File; mime: string; sha: string; commandId: string; fileId?: string; phase: 'reserve' | 'upload' | 'readback'; expectedStatus?: 'ready' | 'aborted'; failure?: string; uncertain: boolean };
type AbortAttempt = { kind: 'abort'; row: FinanceFileRecord; phase: 'abort' | 'readback'; expectedStatus?: 'aborted'; failure?: string; uncertain: boolean };
type Controller = { attachments(path: string, options?: AttachmentRequestOptions): Promise<unknown> };
function message(error: unknown) {
  if (error instanceof AccessError) return error.status === 403 ? 'Seu perfil não permite esta operação.'
    : error.status === 409 ? 'O envio está em andamento, foi cancelado, a conta foi excluída ou o arquivo difere da reserva. Atualize a lista e confira o arquivo.'
      : error.status === 415 ? 'O conteúdo não corresponde ao formato indicado. XML deve ser UTF-8, bem formado e sem DTD.'
        : error.status === 400 ? 'Confira o formato, o tamanho e o nome do arquivo.'
          : error.status === 404 ? 'Anexo, conta ou lançamento não encontrado. Atualize a lista.'
            : 'Não foi possível concluir. Você pode tentar novamente com o mesmo arquivo.';
  return error instanceof Error && error.message ? error.message : 'Não foi possível concluir. Você pode tentar novamente com o mesmo arquivo.';
}

/**
 * Aba Anexos das contas a receber/pagar e da gaveta do lançamento de caixa (Origin "Solte seus arquivos aqui ou clique para adicionar"):
 * reserva com command_id, envio conferido pelo SHA-256, "Confirmar a mesma operação" quando o resultado é incerto, download conferido
 * e "Excluir selecionados" com exclusão lógica auditada. PDF, PNG, JPEG, XML ou TXT de até 10 MiB; até 100 registros por conta ou lançamento.
 */
export default function FinanceAttachments({ controller, owner, ownerId, writable, canAct }: { controller: Controller; owner: FinanceFileOwner; ownerId: string; writable: boolean; canAct?: () => boolean }) {
  const [rows, setRows] = useState<FinanceFileRecord[]>([]), [loading, setLoading] = useState(true), [reload, setReload] = useState(0);
  const [file, setFile] = useState<File | null>(null), [resume, setResume] = useState<FinanceFileRecord | null>(null);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [unresolved, setUnresolved] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set()), [deletion, setDeletion] = useState<{ ids: string[]; commands: Record<string, string> } | null>(null);
  const [dragging, setDragging] = useState(false);
  useUnsavedChanges(Boolean(file || resume || deletion), Boolean(busy) || unresolved);
  const input = useRef<HTMLInputElement>(null), pending = useRef<AbortController | null>(null), urls = useRef(new Set<string>()), attempt = useRef<UploadAttempt | AbortAttempt | null>(null);
  const allowed = () => canAct?.() !== false;
  const readList = async (signal: AbortSignal) => financeFiles(await controller.attachments(financeFilesPath(owner, ownerId), { signal }), owner, ownerId);
  useEffect(() => {
    const request = new AbortController(); setLoading(true); setError('');
    void readList(request.signal).then(value => { if (!request.signal.aborted) { setRows(value); setLoading(false); } })
      .catch(failure => { if (!request.signal.aborted && !cancelled(failure)) { setError(message(failure)); setLoading(false); } });
    return () => request.abort();
  }, [controller, owner, ownerId, reload]);
  useEffect(() => () => { pending.current?.abort(); for (const url of urls.current) URL.revokeObjectURL(url); urls.current.clear(); }, []);
  const clearFile = () => { setFile(null); setResume(null); if (input.current) input.current.value = ''; };
  const chooseFile = (chosen: File | null) => {
    if (busy || pending.current || attempt.current || !allowed()) return;
    setError(''); setNotice(''); setFile(null);
    if (!chosen) return;
    try { attachmentFileType(chosen); setFile(chosen); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Arquivo inválido.'); if (input.current) input.current.value = ''; }
  };
  const finishReadback = async (a: UploadAttempt | AbortAttempt, signal: AbortSignal) => {
    const current = await readList(signal); if (signal.aborted) return;
    const id = a.kind === 'upload' ? a.fileId : a.row.id, row = current.find(item => item.id === id);
    if (!row || (a.expectedStatus && row.status !== a.expectedStatus) || (a.kind === 'upload' && (row.sha256 !== a.sha || row.size_bytes !== a.file.size || row.mime_type !== a.mime))) throw new AccessError(502);
    setRows(current);
    // A reserved row does not prove that an upload with a lost answer has stopped: keep its bytes and command.
    if (row.status === 'reserved' && a.uncertain) { a.phase = a.kind === 'upload' ? 'upload' : 'abort'; a.expectedStatus = undefined; setError('O resultado ainda está pendente. Confirme a mesma operação; o arquivo permanece preservado.'); return; }
    attempt.current = null; setUnresolved(false);
    if (a.kind === 'upload') {
      if (row.status === 'ready') { clearFile(); setNotice(`Anexo ${row.filename} disponível.`); }
      else if (row.status === 'aborted') { clearFile(); setNotice('A reserva foi cancelada. O registro permanece no histórico.'); }
      else { setResume(row); setError(a.failure || 'O arquivo permanece reservado. Retome o envio ou cancele a reserva.'); }
    } else if (row.status === 'aborted') { if (resume?.id === row.id) clearFile(); setNotice('Reserva cancelada. O registro permanece no histórico.'); }
    else setError(a.failure || 'A reserva não foi cancelada. Confira a situação atual.');
  };
  const perform = async (a: UploadAttempt | AbortAttempt, request: AbortController) => {
    if (a.kind === 'upload') {
      if (a.phase === 'reserve') {
        setBusy('Preparando envio…');
        const value = financeFileEnvelope(await controller.attachments(financeFilesPath(owner, ownerId), { method: 'POST', signal: request.signal,
          body: { command_id: a.commandId, filename: a.file.name, mime_type: a.mime, size_bytes: a.file.size, sha256: a.sha } }), owner, ownerId);
        if (request.signal.aborted) return;
        if (value.sha256 !== a.sha || value.size_bytes !== a.file.size || value.mime_type !== a.mime) throw new AccessError(502);
        a.fileId = value.id; a.uncertain = false;
        if (value.status === 'reserved') a.phase = 'upload'; else { a.phase = 'readback'; a.expectedStatus = value.status; }
      }
      if (a.phase === 'upload') {
        setBusy('Enviando e conferindo…');
        const value = financeFileEnvelope(await controller.attachments(financeFilesPath(owner, ownerId, a.fileId, 'upload'), { method: 'PUT', body: a.file, contentType: a.mime, signal: request.signal }), owner, ownerId);
        if (request.signal.aborted) return;
        // The upload may already be committed: only a fresh list releases this attempt.
        a.phase = 'readback'; a.expectedStatus = 'ready';
        if (value.id !== a.fileId || value.status !== 'ready') throw new AccessError(502);
      }
    } else if (a.phase === 'abort') {
      await controller.attachments(financeFilesPath(owner, ownerId, a.row.id, 'abort'), { method: 'POST', body: {}, signal: request.signal });
      if (request.signal.aborted) return; a.phase = 'readback'; a.expectedStatus = 'aborted';
    }
    setBusy('Consultando resultado atual…'); await finishReadback(a, request.signal);
  };
  const recover = async (a: UploadAttempt | AbortAttempt, request: AbortController) => {
    try { await perform(a, request); }
    catch (failure) {
      if (cancelled(failure) || request.signal.aborted) return;
      const definitive = a.phase !== 'readback' && failure instanceof AccessError && [400, 403, 404, 409, 415].includes(failure.status);
      if (definitive) {
        if (a.kind === 'upload' && !a.fileId && !a.uncertain) { attempt.current = null; setUnresolved(false); setError(message(failure)); }
        else if (a.kind === 'upload' && !a.fileId) setError('A reserva pode estar registrada. Confirme a mesma operação antes de selecionar outro arquivo.');
        else { if (failure.status === 409) a.uncertain = true; a.phase = 'readback'; a.failure = message(failure); try { await finishReadback(a, request.signal); } catch { if (!request.signal.aborted) setError('Consulte o resultado atual antes de iniciar outro envio.'); } }
      } else { a.uncertain = true; setError(a.phase === 'readback' ? 'A operação pode estar registrada. Consulte o resultado atual; nenhum novo envio será iniciado.' : message(failure)); }
    }
  };
  const upload = async () => {
    if (busy || (pending.current && !pending.current.signal.aborted) || !writable || (!file && !attempt.current) || !allowed()) return;
    const request = new AbortController(); pending.current = request; setBusy('Conferindo arquivo…'); setError(''); setNotice('');
    try {
      if (!attempt.current) {
        const chosen = file!, mime = attachmentFileType(chosen), sha = await fileHash(chosen); if (request.signal.aborted) return;
        if (resume && !resumableFinanceFile(resume, chosen.size, sha, mime)) { setError('Para retomar, selecione exatamente o arquivo reservado: mesmo conteúdo, tamanho e formato.'); return; }
        attempt.current = { kind: 'upload', file: chosen, mime, sha, commandId: crypto.randomUUID(), fileId: resume?.id, phase: resume ? 'upload' : 'reserve', uncertain: false }; setUnresolved(true);
      }
      await recover(attempt.current, request);
    } catch (failure) { if (!cancelled(failure) && !request.signal.aborted) setError(message(failure)); }
    finally { if (!request.signal.aborted) { pending.current = null; setBusy(''); } }
  };
  const download = async (row: FinanceFileRecord) => {
    if (busy || pending.current || attempt.current || !allowed()) return; const request = new AbortController(); pending.current = request; setBusy(`Baixando ${row.filename}…`); setError(''); setNotice('');
    try {
      const blob = await controller.attachments(financeFilesPath(owner, ownerId, row.id, 'download'), { download: true, signal: request.signal }) as Blob;
      if (blob.size !== row.size_bytes || await fileHash(blob) !== row.sha256) throw new AccessError(502);
      if (request.signal.aborted) return;
      const url = URL.createObjectURL(blob); urls.current.add(url);
      const link = document.createElement('a'); link.href = url; link.download = row.filename; link.rel = 'noopener'; document.body.append(link); link.click(); link.remove();
      setTimeout(() => { URL.revokeObjectURL(url); urls.current.delete(url); }, 1000);
      setNotice('Download preparado.');
    } catch (failure) { if (!cancelled(failure) && !request.signal.aborted) setError(message(failure)); }
    finally { if (!request.signal.aborted) { pending.current = null; setBusy(''); } }
  };
  const removeSelected = async (current: { ids: string[]; commands: Record<string, string> }) => {
    if (busy || pending.current || !writable || attempt.current || !allowed()) return; const request = new AbortController(); pending.current = request; setBusy('Excluindo os anexos selecionados…'); setError(''); setNotice('');
    try {
      for (const id of [...current.ids]) {
        await controller.attachments(financeFilesPath(owner, ownerId, id, 'exclusao'), { method: 'POST', body: { command_id: current.commands[id] }, signal: request.signal });
        if (request.signal.aborted) return; current.ids = current.ids.filter(item => item !== id);
      }
      setDeletion(null); setSelected(new Set()); setNotice('Anexos excluídos.'); setReload(value => value + 1);
    } catch (failure) {
      if (cancelled(failure) || request.signal.aborted) return;
      if (failure instanceof AccessError && [400, 403, 404, 409].includes(failure.status)) {
        setDeletion(null); setSelected(new Set()); setError(`${message(failure)} A exclusão foi recusada e não fica pendente; os anexos já confirmados continuam excluídos.`);
        try { const fresh = await readList(request.signal); if (!request.signal.aborted) setRows(fresh); } catch { /* "Atualizar lista" reads it again. */ }
      } else setError(`${message(failure)} A exclusão fica pendente até ser confirmada.`);
    }
    finally { if (!request.signal.aborted) { pending.current = null; setBusy(''); } }
  };
  const abort = async (row: FinanceFileRecord) => {
    if (busy || pending.current || !writable || attempt.current || !allowed()) return; const request = new AbortController(); pending.current = request; setBusy('Cancelando reserva…'); setError(''); setNotice('');
    const a: AbortAttempt = { kind: 'abort', row, phase: 'abort', uncertain: false }; attempt.current = a; setUnresolved(true);
    try { await recover(a, request); } catch (failure) { if (!cancelled(failure) && !request.signal.aborted) setError(message(failure)); }
    finally { if (!request.signal.aborted) { pending.current = null; setBusy(''); } }
  };
  const inputId = `finance-file-${owner}-${ownerId}`;
  return <div className="document-attachments finance-attachments" aria-busy={Boolean(busy)}>
    <p className="real-help">Arquivos privados {owner === 'contas' ? 'desta conta' : 'deste lançamento'}. PDF, PNG, JPEG, XML ou TXT, até 10 MiB por arquivo. O conteúdo é disponibilizado somente para download.</p>
    {error && <p className="real-alert" role="alert">{error}</p>}{notice && <p className="real-success" role="status">{notice}</p>}
    {unresolved && <section className="real-notice" aria-label="Confirmação pendente do anexo"><p>O resultado precisa ser confirmado. O arquivo e a operação ficam preservados; sair da tela não desfaz um envio já registrado.</p><button type="button" className="primary-button" disabled={Boolean(busy)} onClick={() => void upload()}>{attempt.current?.phase === 'readback' ? 'Consultar resultado atual' : 'Confirmar a mesma operação'}</button></section>}
    {/* A group, not a form: the panel lives inside the gaveta's own form, and none of its buttons submits it. */}
    {writable && <div role="group" className={`attachment-upload${dragging ? ' attachment-dropping' : ''}`} aria-label="Solte seus arquivos aqui ou clique para adicionar"
      onDragOver={event => { event.preventDefault(); if (!dragging) setDragging(true); }} onDragLeave={() => setDragging(false)}
      onDrop={event => { event.preventDefault(); setDragging(false); const dropped = event.dataTransfer?.files?.[0] ?? null; if (dropped) chooseFile(dropped); }}>
      <label htmlFor={inputId}>{resume ? `Retomar ${resume.filename}` : 'Solte seus arquivos aqui ou clique para adicionar'}</label>
      <input ref={input} id={inputId} type="file" accept=".pdf,.png,.jpg,.jpeg,.xml,.txt" disabled={Boolean(busy) || unresolved || loading || (!resume && rows.length >= FINANCE_FILE_LIMIT)} onChange={event => chooseFile(event.target.files?.[0] || null)} />
      {file && <span className="attachment-selected">{file.name} · {attachmentSize(file.size)}</span>}
      <div className="attachment-actions"><button className="primary-button" type="button" disabled={!file || Boolean(busy) || unresolved || loading} onClick={() => void upload()}>{busy || (resume ? 'Retomar envio' : 'Enviar arquivo')}</button>
        {(file || resume) && <button className="secondary-button" type="button" disabled={Boolean(busy) || unresolved} onClick={() => { if (!busy && !attempt.current) clearFile(); }}>Limpar seleção</button>}</div>
      {!resume && rows.length >= FINANCE_FILE_LIMIT && <p className="real-notice">O limite de {FINANCE_FILE_LIMIT} registros de anexo foi atingido. Envios cancelados permanecem no histórico.</p>}
    </div>}
    {deletion && <section className="real-notice" aria-label="Exclusão pendente dos anexos"><p>A exclusão de {deletion.ids.length} anexo(s) precisa ser confirmada.</p><button type="button" className="primary-button" disabled={Boolean(busy)} onClick={() => void removeSelected(deletion)}>Conferir resultado</button></section>}
    <div className="attachment-list-heading"><span role="status">{busy || (loading ? 'Carregando anexos…' : `${rows.length} registro(s) de anexo`)}</span><div className="attachment-actions">
      {writable && <button className="secondary-button" type="button" disabled={Boolean(busy) || unresolved || loading || Boolean(deletion) || !rows.some(row => selected.has(row.id) && row.status === 'ready')} onClick={() => {
        const ids = rows.filter(row => selected.has(row.id) && row.status === 'ready').map(row => row.id); if (!ids.length) return;
        const current = { ids, commands: Object.fromEntries(ids.map(id => [id, crypto.randomUUID()])) }; setDeletion(current); void removeSelected(current);
      }}>Excluir selecionados</button>}
      <button className="secondary-button" type="button" disabled={Boolean(busy) || unresolved || loading} onClick={() => setReload(value => value + 1)}>Atualizar lista</button></div></div>
    {!loading && !rows.length && <p className="real-help">Nenhum anexo.</p>}
    {rows.length > 0 && <div className="table-scroll" tabIndex={0} aria-label="Anexos"><table className="data-table attachment-table"><thead><tr>{writable && <th><span className="sr-only">Selecionar</span></th>}<th>Arquivo</th><th>Dono</th><th>Tamanho</th><th>Data</th><th>Situação</th><th>Ações</th></tr></thead><tbody>{rows.map(row => <tr key={row.id}>
      {writable && <td><input type="checkbox" aria-label={`Selecionar ${row.filename}`} disabled={row.status !== 'ready' || Boolean(busy) || Boolean(deletion) || unresolved} checked={selected.has(row.id)} onChange={event => { const checked = event.target.checked; setSelected(current => { const next = new Set(current); if (checked) next.add(row.id); else next.delete(row.id); return next; }); }} /></td>}
      <td>{row.filename}</td><td>{row.owner_name ?? '—'}</td><td>{attachmentSize(row.size_bytes)}</td><td>{attachmentDay(row.finished_at ?? row.created_at)}</td><td>{row.status === 'ready' ? 'Disponível' : row.status === 'reserved' ? 'Aguardando envio' : 'Reserva cancelada'}</td>
      <td><div className="attachment-actions">{row.status === 'ready' && <button className="text-button" type="button" disabled={Boolean(busy) || unresolved} onClick={() => void download(row)}>Baixar</button>}
        {row.status === 'reserved' && writable && <><button className="text-button" type="button" disabled={Boolean(busy) || unresolved} onClick={() => { if (busy || pending.current || attempt.current || !allowed()) return; clearFile(); setResume(row); setError(''); setNotice(''); input.current?.focus(); }}>Retomar</button>
          <button className="text-button" type="button" disabled={Boolean(busy) || unresolved} onClick={() => void abort(row)}>Cancelar reserva</button></>}</div></td>
    </tr>)}</tbody></table></div>}
  </div>;
}
