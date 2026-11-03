import { useEffect, useRef, useState } from 'react';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { AccessError, type AccessController } from '../lib/real-access';
import { attachmentFileType, attachmentSize, fileHash } from '../lib/attachment-model';
import { contactFileDay, contactFilesPath, ownerFilesPath, photoDataUrl, photoFileType, readContactFile, readContactFiles, type ContactFile, type ContactFilePurpose, type ContactFilesPage, type FileOwner } from '../lib/contact-files-model';
import { Icon } from './Icon';
import './contact-files.css';

type Controller = Pick<AccessController, 'attachments' | 'getSnapshot'>;
const cancelled = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const actorOf = (controller: Controller) => controller.getSnapshot()?.membership?.user_id ?? null;
/** A refusal that repeating the same command cannot change (the deletion is then no longer pending). */
const definitive = (error: unknown) => error instanceof AccessError && [400, 403, 404, 409].includes(error.status);
const message = (error: unknown) => error instanceof AccessError
  ? error.status === 403 ? 'Seu perfil não permite esta operação.' : error.status === 415 ? 'O conteúdo não corresponde ao formato do arquivo.'
    : error.status === 400 ? 'Confira o formato, o tamanho e o nome do arquivo.' : error.status === 404 ? 'Contato ou arquivo não encontrado. Atualize a lista.'
      : error.status === 409 ? 'O arquivo mudou, está em envio ou já foi excluído. Confira o resultado.' : 'Não foi possível concluir. Confira o resultado antes de repetir.'
  : 'Não foi possível concluir. Confira o resultado antes de repetir.';
/** One upload kept with its command until the result is confirmed ("Conferir resultado" repeats exactly the same operation). */
type Upload = { purpose: ContactFilePurpose; file: File; mime: string; sha: string; commandId: string; fileId?: string };
/** Deletions kept with their commands until confirmed. */
type Deletion = { ids: string[]; commands: Record<string, string> };

// 202610200272: the owner is the contato (default) or the funcionário (Foto only).
async function runUpload(controller: Controller, contactId: string, a: Upload, signal: AbortSignal, owner: FileOwner = 'contact'): Promise<ContactFilesPage> {
  if (!a.fileId) {
    const value = await controller.attachments(ownerFilesPath(owner, contactId), { method: 'POST', signal,
      body: { command_id: a.commandId, purpose: a.purpose, filename: a.file.name, mime_type: a.mime, size_bytes: a.file.size, sha256: a.sha } }) as { attachment?: unknown };
    const row = readContactFile(value?.attachment, contactId, owner);
    if (row.sha256 !== a.sha || row.size_bytes !== a.file.size || row.purpose !== a.purpose) throw new AccessError(502);
    if (row.status === 'aborted') throw new AccessError(409);
    a.fileId = row.id;
    if (row.status === 'reserved') await controller.attachments(ownerFilesPath(owner, contactId, row.id, 'upload'), { method: 'PUT', body: a.file, contentType: a.mime, signal });
  } else await controller.attachments(ownerFilesPath(owner, contactId, a.fileId, 'upload'), { method: 'PUT', body: a.file, contentType: a.mime, signal });
  const page = readContactFiles(await controller.attachments(ownerFilesPath(owner, contactId), { signal }), contactId, owner);
  const done = a.purpose === 'photo' ? page.photo : page.items.find(item => item.id === a.fileId) ?? null;
  if (!done || done.id !== a.fileId || done.status !== 'ready' || done.sha256 !== a.sha) throw new AccessError(502);
  return page;
}
async function verifiedBlob(controller: Controller, contactId: string, row: ContactFile, signal: AbortSignal, owner: FileOwner = 'contact') {
  const blob = await controller.attachments(ownerFilesPath(owner, contactId, row.id, 'download'), { download: true, signal }) as Blob;
  if (!(blob instanceof Blob) || blob.size !== row.size_bytes || await fileHash(blob) !== row.sha256) throw new AccessError(502);
  return blob;
}

/**
 * Origin "Anexos" of Clientes e fornecedores (seção recolhível): Anexar arquivo, Excluir selecionados and the table ☐ | Nome | Dono |
 * Tamanho | Data. Files stay private (download only); deletions are logical and audited.
 */
export default function ContactFiles({ controller, contactId, writable }: { controller: Controller; contactId: string; writable: boolean }) {
  const [page, setPage] = useState<ContactFilesPage | null>(null), [loading, setLoading] = useState(true), [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set()), [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [upload, setUpload] = useState<Upload | null>(null), [deletion, setDeletion] = useState<Deletion | null>(null);
  const input = useRef<HTMLInputElement>(null), pending = useRef<AbortController | null>(null), actor = useRef(actorOf(controller)), mounted = useRef(true);
  useUnsavedChanges(Boolean(upload || deletion), Boolean(busy));
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; pending.current?.abort(); }; }, []);
  useEffect(() => {
    const request = new AbortController(); setLoading(true); setError('');
    void Promise.resolve().then(() => controller.attachments(contactFilesPath(contactId), { signal: request.signal })).then(value => {
      if (request.signal.aborted) return;
      setPage(readContactFiles(value, contactId)); setLoading(false);
    }).catch(failure => { if (!request.signal.aborted && !cancelled(failure)) { setError(message(failure)); setLoading(false); } });
    return () => request.abort();
  }, [controller, contactId, reload]);
  const act = async (label: string, work: (signal: AbortSignal) => Promise<void>) => {
    if (pending.current) return;
    const request = new AbortController(); pending.current = request; setBusy(label); setError(''); setNotice('');
    try {
      await work(request.signal);
      if (actorOf(controller) !== actor.current) throw new AccessError(403);
    } catch (failure) { if (!cancelled(failure) && !request.signal.aborted && mounted.current) setError(message(failure)); }
    finally { if (pending.current === request) pending.current = null; if (mounted.current && !request.signal.aborted) setBusy(''); }
  };
  const choose = async (file: File | null) => {
    if (!file || !writable || pending.current || upload || deletion) return;
    let mime: string; try { mime = attachmentFileType(file); } catch (failure) { setError((failure as Error).message); if (input.current) input.current.value = ''; return; }
    const sha = await fileHash(file);
    const attempt: Upload = { purpose: 'attachment', file, mime, sha, commandId: crypto.randomUUID() };
    setUpload(attempt); await send(attempt);
  };
  const send = (attempt: Upload) => act(`Enviando ${attempt.file.name}…`, async signal => {
    const next = await runUpload(controller, contactId, attempt, signal);
    if (signal.aborted) return;
    setPage(next); setUpload(null); if (input.current) input.current.value = ''; setNotice(`Anexo ${attempt.file.name} enviado.`);
  });
  const discard = () => act('Cancelando a reserva…', async signal => {
    const attempt = upload; if (!attempt) return;
    if (attempt.fileId) await controller.attachments(contactFilesPath(contactId, attempt.fileId, 'abort'), { method: 'POST', body: {}, signal });
    setUpload(null); if (input.current) input.current.value = ''; setReload(value => value + 1);
  });
  const remove = (current: Deletion) => act('Excluindo os anexos selecionados…', async signal => {
    for (const id of [...current.ids]) {
      try { await controller.attachments(contactFilesPath(contactId, id, 'exclusao'), { method: 'POST', body: { command_id: current.commands[id] }, signal }); }
      catch (failure) {
        if (definitive(failure)) {
          setDeletion(null); setSelected(new Set());
          try { setPage(readContactFiles(await controller.attachments(contactFilesPath(contactId), { signal }), contactId)); } catch { /* "Atualizar" reads it again. */ }
        }
        throw failure;
      }
      current.ids = current.ids.filter(item => item !== id);
    }
    setDeletion(null); setSelected(new Set()); setReload(value => value + 1); setNotice('Anexos excluídos.');
  });
  const download = (row: ContactFile) => act(`Baixando ${row.filename}…`, async signal => {
    const blob = await verifiedBlob(controller, contactId, row, signal);
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = row.filename; link.rel = 'noopener'; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  const rows = page?.items ?? [], ready = rows.filter(row => row.status === 'ready');
  const locked = Boolean(busy) || Boolean(upload) || Boolean(deletion);
  return <div className="contact-files" aria-busy={Boolean(busy)}>
    <p className="real-help">Arquivos privados deste cadastro: PDF, PNG, JPEG, XML ou TXT, até 10 MiB cada. O conteúdo é disponibilizado somente para download.</p>
    {error && <p className="real-alert" role="alert">{error}</p>}{notice && <p className="real-success" role="status">{notice}</p>}
    {upload && <section className="real-notice" aria-label="Envio pendente do anexo"><p>O envio de {upload.file.name} precisa ser confirmado. O arquivo e a operação ficam preservados.</p>
      <button type="button" className="primary-button" disabled={Boolean(busy)} onClick={() => void send(upload)}>Conferir resultado</button>
      <button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => void discard()}>Descartar o envio</button></section>}
    {deletion && <section className="real-notice" aria-label="Exclusão pendente"><p>A exclusão de {deletion.ids.length} anexo(s) precisa ser confirmada.</p>
      <button type="button" className="primary-button" disabled={Boolean(busy)} onClick={() => void remove(deletion)}>Conferir resultado</button></section>}
    <div className="contact-files-actions">
      {writable && <><label className="secondary-button contact-files-pick" htmlFor={`contact-files-${contactId}`}><Icon name="paperclip" size={12} />Anexar arquivo</label>
        <input ref={input} id={`contact-files-${contactId}`} className="sr-only" type="file" accept=".pdf,.png,.jpg,.jpeg,.xml,.txt" disabled={locked || loading || rows.length >= 100}
          onChange={event => void choose(event.target.files?.[0] ?? null)} />
        <button type="button" className="secondary-button" disabled={locked || !selected.size} onClick={() => {
          const ids = [...selected].filter(id => ready.some(row => row.id === id)); if (!ids.length) return;
          const current: Deletion = { ids, commands: Object.fromEntries(ids.map(id => [id, crypto.randomUUID()])) }; setDeletion(current); void remove(current);
        }}><Icon name="trash-can" size={12} />Excluir selecionados</button></>}
      <button type="button" className="text-button" disabled={Boolean(busy) || loading} onClick={() => setReload(value => value + 1)}>Atualizar</button>
    </div>
    {busy && <p role="status">{busy}</p>}
    {loading ? <p role="status">Carregando anexos…</p> : !rows.length ? <p className="real-help">Nenhum anexo neste cadastro.</p>
      : <div className="table-scroll" tabIndex={0} aria-label="Anexos do cadastro"><table className="data-table"><thead><tr><th><span className="sr-only">Selecionar</span></th><th>Nome</th><th>Dono</th><th>Tamanho</th><th>Data</th></tr></thead>
        <tbody>{rows.map(row => <tr key={row.id}>
          <td><input type="checkbox" aria-label={`Selecionar ${row.filename}`} disabled={!writable || locked || row.status !== 'ready'} checked={selected.has(row.id)}
            onChange={event => setSelected(current => { const next = new Set(current); if (event.target.checked) next.add(row.id); else next.delete(row.id); return next; })} /></td>
          <td>{row.status === 'ready' ? <button type="button" className="text-button" disabled={Boolean(busy)} onClick={() => void download(row)}>{row.filename}</button>
            : <span>{row.filename} · {row.status === 'reserved' ? 'aguardando envio' : 'envio cancelado'}</span>}</td>
          <td>{row.owner_name ?? '—'}</td><td>{attachmentSize(row.size_bytes)}</td><td>{contactFileDay(row.finished_at ?? row.created_at)}</td></tr>)}</tbody></table></div>}
  </div>;
}

/** Origin "Foto" of the cadastro: preview, "Enviar foto" (PNG or JPEG up to 2 MB) and "Remover foto". */
export function ContactPhoto({ controller, contactId, writable, owner = 'contact' }: { controller: Controller; contactId: string | null; writable: boolean; owner?: FileOwner }) {
  const [photo, setPhoto] = useState<ContactFile | null>(null), [url, setUrl] = useState(''), [busy, setBusy] = useState(''), [error, setError] = useState(''), [reload, setReload] = useState(0);
  const [upload, setUpload] = useState<Upload | null>(null), [removal, setRemoval] = useState<{ id: string; command: string } | null>(null);
  const input = useRef<HTMLInputElement>(null), pending = useRef<AbortController | null>(null), actor = useRef(actorOf(controller)), mounted = useRef(true);
  useUnsavedChanges(Boolean(upload || removal), Boolean(busy));
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; pending.current?.abort(); }; }, []);
  useEffect(() => {
    if (!contactId) return;
    const request = new AbortController();
    void Promise.resolve().then(() => controller.attachments(ownerFilesPath(owner, contactId), { signal: request.signal })).then(async value => {
      const current = readContactFiles(value, contactId, owner).photo;
      if (request.signal.aborted) return;
      setPhoto(current);
      if (!current) { setUrl(''); return; }
      const blob = await verifiedBlob(controller, contactId, current, request.signal, owner);
      if (request.signal.aborted || actorOf(controller) !== actor.current) return;
      // A data: URL: the ERP Content-Security-Policy allows img-src 'self' data: only (a blob: URL would never render).
      const data = await photoDataUrl(blob, current.mime_type);
      if (request.signal.aborted || actorOf(controller) !== actor.current) return;
      setUrl(data);
    }).catch(failure => { if (!request.signal.aborted && !cancelled(failure)) setError('Não foi possível carregar a foto.'); });
    return () => request.abort();
  }, [controller, contactId, reload, owner]);
  if (!contactId) return <div className="form-field"><span className="contact-label">Foto</span><p className="real-help">Salve o cadastro para enviar a foto.</p></div>;
  const act = async (label: string, work: (signal: AbortSignal) => Promise<void>) => {
    if (pending.current) return;
    const request = new AbortController(); pending.current = request; setBusy(label); setError('');
    try { await work(request.signal); if (actorOf(controller) !== actor.current) throw new AccessError(403); }
    catch (failure) { if (!cancelled(failure) && !request.signal.aborted && mounted.current) setError(message(failure)); }
    finally { if (pending.current === request) pending.current = null; if (mounted.current && !request.signal.aborted) setBusy(''); }
  };
  const send = (attempt: Upload) => act('Enviando a foto…', async signal => {
    await runUpload(controller, contactId, attempt, signal, owner); if (signal.aborted) return;
    setUpload(null); if (input.current) input.current.value = ''; setReload(value => value + 1);
  });
  const choose = async (file: File | null) => {
    if (!file || !writable || pending.current || upload || removal) return;
    let mime: string; try { mime = photoFileType(file); } catch (failure) { setError((failure as Error).message); if (input.current) input.current.value = ''; return; }
    const attempt: Upload = { purpose: 'photo', file, mime, sha: await fileHash(file), commandId: crypto.randomUUID() };
    setUpload(attempt); await send(attempt);
  };
  const remove = (current: { id: string; command: string }) => act('Removendo a foto…', async signal => {
    try { await controller.attachments(ownerFilesPath(owner, contactId, current.id, 'exclusao'), { method: 'POST', body: { command_id: current.command }, signal }); }
    catch (failure) { if (definitive(failure)) { setRemoval(null); setReload(value => value + 1); } throw failure; }
    setRemoval(null); setReload(value => value + 1);
  });
  const locked = Boolean(busy) || Boolean(upload) || Boolean(removal);
  return <div className="form-field contact-photo"><span className="contact-label">Foto</span>
    {url ? <img src={url} alt={owner === 'employee' ? 'Foto do funcionário' : 'Foto do contato'} className="contact-photo-preview" /> : <p className="real-help">{photo ? 'Carregando a foto…' : 'Sem foto.'}</p>}
    {writable && <div className="contact-files-actions">
      <label className="secondary-button" htmlFor={`${owner}-photo-${contactId}`}><Icon name="image" size={12} />Enviar foto</label>
      <input ref={input} id={`${owner}-photo-${contactId}`} className="sr-only" type="file" accept=".png,.jpg,.jpeg" disabled={locked} onChange={event => void choose(event.target.files?.[0] ?? null)} />
      {photo && <button type="button" className="text-button" disabled={locked} onClick={() => { const current = { id: photo.id, command: crypto.randomUUID() }; setRemoval(current); void remove(current); }}>Remover foto</button>}
    </div>}
    {upload && <p className="real-notice">O envio da foto precisa ser confirmado. <button type="button" className="text-button" disabled={Boolean(busy)} onClick={() => void send(upload)}>Conferir resultado</button>
      <button type="button" className="text-button" disabled={Boolean(busy)} onClick={() => void act('Cancelando a reserva…', async signal => {
        if (upload.fileId) await controller.attachments(ownerFilesPath(owner, contactId, upload.fileId, 'abort'), { method: 'POST', body: {}, signal });
        setUpload(null); if (input.current) input.current.value = '';
      })}>Descartar o envio</button></p>}
    {removal && <p className="real-notice">A remoção da foto precisa ser confirmada. <button type="button" className="text-button" disabled={Boolean(busy)} onClick={() => void remove(removal)}>Conferir resultado</button></p>}
    {busy && <small role="status">{busy}</small>}{error && <small className="real-alert" role="alert">{error}</small>}
    <small className="real-help">PNG ou JPEG de até 2 MB.</small>
  </div>;
}
