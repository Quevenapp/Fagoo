import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import type { DocumentKind } from '../lib/real-documents-model';
import { attachmentDay, attachmentFileType, attachmentFormat, attachmentPath, attachmentSize, fileHash, resumableFile, thumbnailDataUrl, thumbnailRows, type AttachmentEnvelope, type AttachmentPage, type AttachmentRecord } from '../lib/attachment-model';
import './document-attachments.css';

const cancelled = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
type UploadAttempt={kind:'upload';file:File;mime:string;sha:string;commandId:string;attachmentId?:string;phase:'reserve'|'upload'|'readback';expectedStatus?:'ready'|'aborted';failure?:string;uncertain:boolean};
type AbortAttempt={kind:'abort';row:AttachmentRecord;phase:'abort'|'readback';expectedStatus?:'aborted';failure?:string;uncertain:boolean};
function message(error: unknown) {
  if (error instanceof AccessError) return error.status === 403 ? 'Seu perfil não permite esta operação.'
    : error.status === 409 ? 'O envio está em andamento, foi cancelado ou o arquivo difere da reserva. Atualize a lista e confira o arquivo.'
      : error.status === 415 ? 'O conteúdo não corresponde ao formato indicado. XML deve ser UTF-8, bem formado e sem DTD.'
        : error.status === 400 ? 'Confira o formato, o tamanho e o nome do arquivo.'
          : error.status === 404 ? 'Anexo ou documento não encontrado. Atualize a lista.'
            : 'Não foi possível concluir. Você pode tentar novamente com o mesmo arquivo.';
  return 'Não foi possível concluir. Você pode tentar novamente com o mesmo arquivo.';
}
export default function DocumentAttachments({ controller, kind, documentId, writable, blocked = false, canAct, onDraft, onBusy }: { controller: AccessController; kind: DocumentKind; documentId: string; writable: boolean; blocked?: boolean; canAct?: () => boolean; onDraft?: (state: boolean) => void; onBusy?: (state: boolean) => void }) {
  const [rows, setRows] = useState<AttachmentRecord[]>([]), [loading, setLoading] = useState(true), [reload, setReload] = useState(0);
  const [file, writeFile] = useState<File | null>(null), [resume, writeResume] = useState<AttachmentRecord | null>(null);
  const [busy, writeBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [unresolved,writeUnresolved]=useState(false);
  // 202610200170 "Excluir selecionados": the commands stay until the result is confirmed.
  const [selected, setSelected] = useState<Set<string>>(new Set()), [deletion, setDeletion] = useState<{ ids: string[]; commands: Record<string, string> } | null>(null);
  // Origin "Digite o nome do arquivo" (filters the list on screen) and the dropzone "Arraste e solte o arquivo aqui".
  const [nameQuery, setNameQuery] = useState(''), [dragging, setDragging] = useState(false);
  const draft = Boolean(file || resume);
  useUnsavedChanges(draft || Boolean(deletion), Boolean(busy)||unresolved);
  const callbacks = useRef({ onDraft, onBusy }); callbacks.current = { onDraft, onBusy };
  // Publish coordination before React renders so retained siorigin handlers cannot race.
  const coordination=useRef({file,resume,busy,unresolved});coordination.current={file,resume,busy,unresolved};
  const publish=()=>{const s=coordination.current;callbacks.current.onDraft?.(Boolean(s.file||s.resume));callbacks.current.onBusy?.(Boolean(s.busy||s.unresolved));};
  const sync=<K extends keyof typeof coordination.current,>(key:K,value:(typeof coordination.current)[K],write:(value:(typeof coordination.current)[K])=>void)=>{coordination.current[key]=value;write(value);publish();};
  const setFile:typeof writeFile=value=>sync('file',typeof value==='function'?value(coordination.current.file):value,writeFile);
  const setResume:typeof writeResume=value=>sync('resume',typeof value==='function'?value(coordination.current.resume):value,writeResume);
  const setBusy:typeof writeBusy=value=>sync('busy',typeof value==='function'?value(coordination.current.busy):value,writeBusy);
  const setUnresolved:typeof writeUnresolved=value=>sync('unresolved',typeof value==='function'?value(coordination.current.unresolved):value,writeUnresolved);
  useLayoutEffect(publish,[draft,busy,unresolved]);
  useLayoutEffect(() => () => { callbacks.current.onDraft?.(false); callbacks.current.onBusy?.(false); }, []);
  const input = useRef<HTMLInputElement>(null), pending = useRef<AbortController | null>(null), urls = useRef(new Set<string>());
  const attempt = useRef<UploadAttempt|AbortAttempt|null>(null);
  const readList=async(signal:AbortSignal)=>{
    const page=await controller.attachments(attachmentPath(kind,documentId),{signal})as AttachmentPage;
    if(page.data_mode!=='erp_native'||page.document_id!==documentId||!Array.isArray(page.items)||page.items.length>100||page.items.some(row=>row.document_id!==documentId))throw new AccessError(502);
    return page.items;
  };
  useEffect(() => {
    const request = new AbortController(); setLoading(true); setError('');
    void readList(request.signal).then(value => {
      if (!request.signal.aborted) { setRows(value); setLoading(false); }
    }).catch(failure => { if (!request.signal.aborted && !cancelled(failure)) { setError(message(failure)); setLoading(false); } });
    return () => request.abort();
  }, [controller, kind, documentId, reload]);
  useEffect(() => () => { pending.current?.abort(); for (const url of urls.current) URL.revokeObjectURL(url); urls.current.clear(); }, []);
  // 202610200240 Origin "Miniatura": the small images of the list are read one at a time, checked by size and SHA-256, and kept by id
  // and hash; a failed read leaves the format label. The session that read them must still be the current one.
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const thumbnailKey = thumbnailRows(rows).map(row => `${row.id}:${row.sha256}`).join(',');
  useEffect(() => {
    const wanted = thumbnailRows(rows).filter(row => !thumbnails[`${row.id}:${row.sha256}`]); if (!wanted.length) return;
    const request = new AbortController(), actor = controller.getSnapshot?.()?.membership?.user_id ?? null;
    void (async () => {
      for (const row of wanted) {
        try {
          const blob = await controller.attachments(attachmentPath(kind, documentId, row.id, 'download'), { download: true, signal: request.signal }) as Blob;
          if (request.signal.aborted) return;
          if (!(blob instanceof Blob) || blob.size !== row.size_bytes || await fileHash(blob) !== row.sha256) continue;
          const url = await thumbnailDataUrl(blob, row.mime_type);
          if (request.signal.aborted || (controller.getSnapshot?.()?.membership?.user_id ?? null) !== actor) return;
          setThumbnails(current => ({ ...current, [`${row.id}:${row.sha256}`]: url }));
        } catch (failure) { if (cancelled(failure) || request.signal.aborted) return; }
      }
    })();
    return () => request.abort();
  }, [controller, kind, documentId, thumbnailKey]);
  const clearFile = () => { setFile(null); setResume(null); if (input.current) input.current.value = ''; };
  const resetFile = () => {if(busy||attempt.current)return;clearFile();};
  const chooseFile = (selected: File | null) => {
    if (blocked || busy || pending.current || attempt.current || canAct?.() === false) return;
    setError(''); setNotice(''); setFile(null);
    if (!selected) return;
    try { attachmentFileType(selected); setFile(selected); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Arquivo inválido.'); if (input.current) input.current.value = ''; }
  };
  const finishReadback=async(a:UploadAttempt|AbortAttempt,signal:AbortSignal)=>{
    const current=await readList(signal);if(signal.aborted)return;
    const id=a.kind==='upload'?a.attachmentId:a.row.id,row=current.find(item=>item.id===id);
    if(!row||a.expectedStatus&&row.status!==a.expectedStatus||a.kind==='upload'&&(row.sha256!==a.sha||row.size_bytes!==a.file.size||row.mime_type!==a.mime))throw new AccessError(502);
    setRows(current);
    // A reserved row does not prove an upload with a lost response has stopped.
    // Keep its exact bytes and command, even if a retry encounters the upload lease.
    if(row.status==='reserved'&&a.uncertain){a.phase=a.kind==='upload'?'upload':'abort';a.expectedStatus=undefined;setError('O resultado ainda está pendente. Confirme a mesma operação; o arquivo permanece preservado.');return;}
    attempt.current=null;setUnresolved(false);
    if(a.kind==='upload'){
      if(row.status==='ready'){clearFile();setNotice(`Anexo ${row.filename} disponível. O estado atual foi consultado.`);}
      else if(row.status==='aborted'){clearFile();setNotice('A reserva foi cancelada. O registro permanece no histórico.');}
      else{setResume(row);setError(a.failure||'O arquivo permanece reservado. Retome o envio ou cancele a reserva.');}
    }else if(row.status==='aborted'){if(resume?.id===row.id)clearFile();setNotice('Reserva cancelada. O registro permanece no histórico.');}
    else setError(a.failure||'A reserva não foi cancelada. Confira a situação atual.');
  };
  const perform=async(a:UploadAttempt|AbortAttempt,request:AbortController)=>{
    if(a.kind==='upload'){
      if(a.phase==='reserve'){
        setBusy('Preparando envio…');
        const value=await controller.attachments(attachmentPath(kind,documentId),{method:'POST',signal:request.signal,
          body:{command_id:a.commandId,filename:a.file.name,mime_type:a.mime,size_bytes:a.file.size,sha256:a.sha}})as AttachmentEnvelope;
        if(request.signal.aborted)return;
        if(value.data_mode!=='erp_native'||value.attachment.document_id!==documentId||value.attachment.sha256!==a.sha||value.attachment.size_bytes!==a.file.size||value.attachment.mime_type!==a.mime)throw new AccessError(502);
        a.attachmentId=value.attachment.id;
        // A valid reservation replay resolves only reservation uncertainty. A
        // later definitive rejection of the first upload must remain correctable.
        a.uncertain=false;
        if(value.attachment.status==='reserved')a.phase='upload';else{a.phase='readback';a.expectedStatus=value.attachment.status;}
      }
      if(a.phase==='upload'){
        setBusy('Enviando e conferindo…');
        const value=await controller.attachments(attachmentPath(kind,documentId,a.attachmentId,'upload'),{method:'PUT',body:a.file,contentType:a.mime,signal:request.signal})as AttachmentEnvelope;
        if(request.signal.aborted)return;
        // The upload may already be committed. Only a fresh list can release this attempt.
        a.phase='readback';a.expectedStatus='ready';
        if(value.data_mode!=='erp_native'||value.attachment.id!==a.attachmentId||value.attachment.status!=='ready')throw new AccessError(502);
      }
    }else if(a.phase==='abort'){
      await controller.attachments(attachmentPath(kind,documentId,a.row.id,'abort'),{method:'POST',body:{},signal:request.signal});
      if(request.signal.aborted)return;a.phase='readback';a.expectedStatus='aborted';
    }
    setBusy('Consultando resultado atual…');await finishReadback(a,request.signal);
  };
  const recover=async(a:UploadAttempt|AbortAttempt,request:AbortController)=>{
    try{await perform(a,request);}
    catch(failure){if(!cancelled(failure)&&!request.signal.aborted){
      const definitive=a.phase!=='readback'&&failure instanceof AccessError&&[400,403,404,409,415].includes(failure.status);
      if(definitive){
        if(a.kind==='upload'&&!a.attachmentId&&!a.uncertain){attempt.current=null;setUnresolved(false);setError(message(failure));}
        else if(a.kind==='upload'&&!a.attachmentId)setError('A reserva pode estar registrada. Confirme a mesma operação antes de selecionar outro arquivo.');
        else{if(failure.status===409)a.uncertain=true;a.phase='readback';a.failure=message(failure);try{await finishReadback(a,request.signal);}catch{if(!request.signal.aborted)setError('Consulte o resultado atual antes de iniciar outro envio.');}}
      }else{a.uncertain=true;setError(a.phase==='readback'?'A operação pode estar registrada. Consulte o resultado atual; nenhum novo envio será iniciado.':message(failure));}
    }}
  };
  const upload = async (event?: FormEvent) => {
    event?.preventDefault(); if (busy || pending.current&&!pending.current.signal.aborted || blocked || !writable || (!file&&!attempt.current) || canAct?.() === false) return;
    const request = new AbortController(); pending.current = request; setBusy('Conferindo arquivo…'); setError(''); setNotice('');
    try {
      if(!attempt.current){
        const selected=file!,mime=attachmentFileType(selected),sha=await fileHash(selected);if(request.signal.aborted)return;
        if(resume&&!resumableFile(resume,selected.size,sha,mime)){setError('Para retomar, selecione exatamente o arquivo reservado: mesmo conteúdo, tamanho e formato.');return;}
        attempt.current={kind:'upload',file:selected,mime,sha,commandId:crypto.randomUUID(),attachmentId:resume?.id,phase:resume?'upload':'reserve',uncertain:false};setUnresolved(true);
      }
      await recover(attempt.current,request);
    } catch (failure) { if (!cancelled(failure) && !request.signal.aborted) setError(message(failure)); }
    finally { if (!request.signal.aborted){pending.current=null;setBusy('');} }
  };
  const download = async (row: AttachmentRecord) => {
    if (busy || pending.current || blocked || attempt.current || canAct?.() === false) return; const request = new AbortController(); pending.current = request; setBusy(`Baixando ${row.filename}…`); setError(''); setNotice('');
    try {
      const blob = await controller.attachments(attachmentPath(kind, documentId, row.id, 'download'), { download: true, signal: request.signal }) as Blob;
      if (blob.size !== row.size_bytes || await fileHash(blob) !== row.sha256) throw new AccessError(502);
      if (request.signal.aborted) return;
      const url = URL.createObjectURL(blob); urls.current.add(url);
      const link = document.createElement('a'); link.href = url; link.download = row.filename; link.rel = 'noopener'; document.body.append(link); link.click(); link.remove();
      setTimeout(() => { URL.revokeObjectURL(url); urls.current.delete(url); }, 1000);
      setNotice('Download preparado.');
    } catch (failure) { if (!cancelled(failure) && !request.signal.aborted) setError(message(failure)); }
    finally { if (!request.signal.aborted){pending.current=null;setBusy('');} }
  };
  const removeSelected = async (current: { ids: string[]; commands: Record<string, string> }) => {
    if (busy || pending.current || blocked || !writable || attempt.current || canAct?.() === false) return; const request = new AbortController(); pending.current = request; setBusy('Excluindo os anexos selecionados…'); setError(''); setNotice('');
    try {
      for (const id of [...current.ids]) {
        await controller.attachments(attachmentPath(kind, documentId, id, 'exclusao'), { method: 'POST', body: { command_id: current.commands[id] }, signal: request.signal });
        if (request.signal.aborted) return; current.ids = current.ids.filter(item => item !== id);
      }
      setDeletion(null); setSelected(new Set()); setNotice('Anexos excluídos.'); setReload(value => value + 1);
    } catch (failure) {
      if (cancelled(failure) || request.signal.aborted) return;
      // A definitive refusal (the file changed, was already deleted or the profile changed) ends the pending deletion: repeating
      // the same commands would only be refused again. Only an unconfirmed answer keeps "Conferir resultado".
      if (failure instanceof AccessError && [400, 403, 404, 409].includes(failure.status)) {
        setDeletion(null); setSelected(new Set()); setError(`${message(failure)} A exclusão foi recusada e não fica pendente; os anexos já confirmados continuam excluídos.`);
        try { const current = await readList(request.signal); if (!request.signal.aborted) setRows(current); } catch { /* "Atualizar lista" reads it again. */ }
      }
      else setError(`${message(failure)} A exclusão fica pendente até ser confirmada.`);
    }
    finally { if (!request.signal.aborted){pending.current=null;setBusy('');} }
  };
  const abort = async (row: AttachmentRecord) => {
    if (busy || pending.current || blocked || !writable || attempt.current || canAct?.() === false) return; const request = new AbortController(); pending.current = request; setBusy('Cancelando reserva…'); setError(''); setNotice('');
    const a:AbortAttempt={kind:'abort',row,phase:'abort',uncertain:false};attempt.current=a;setUnresolved(true);
    try {
      await recover(a,request);
    } catch (failure) { if (!cancelled(failure) && !request.signal.aborted) setError(message(failure)); }
    finally { if (!request.signal.aborted){pending.current=null;setBusy('');} }
  };
  return <div className="document-attachments" aria-busy={Boolean(busy)}>
    <p className="real-help">Arquivos privados deste documento. PDF, PNG, JPEG, XML ou TXT, até 10 MiB por arquivo. O conteúdo é disponibilizado somente para download.</p>
    {blocked && <p className="real-notice">Conclua ou descarte as alterações da outra seção antes de iniciar uma operação com anexos.</p>}
    {error && <p className="real-alert" role="alert">{error}</p>}{notice && <p className="real-success" role="status">{notice}</p>}
    {unresolved&&<section className="real-notice" aria-label="Confirmação pendente do anexo"><p>O resultado precisa ser confirmado. O arquivo e a operação ficam preservados; sair da tela não desfaz um envio já registrado.</p><button type="button" className="primary-button" disabled={Boolean(busy)||blocked} onClick={()=>void upload()}>{attempt.current?.phase==='readback'?'Consultar resultado atual':'Confirmar a mesma operação'}</button></section>}
    {writable && <form onSubmit={event => void upload(event)} className={`attachment-upload${dragging ? ' attachment-dropping' : ''}`} aria-label="Arraste e solte o arquivo aqui ou escolha um arquivo"
      onDragOver={event => { event.preventDefault(); if (!dragging) setDragging(true); }} onDragLeave={() => setDragging(false)}
      onDrop={event => { event.preventDefault(); setDragging(false); const dropped = event.dataTransfer?.files?.[0] ?? null; if (dropped) chooseFile(dropped); }}>
      {!resume && <p className="attachment-drop-text">Arraste e solte o arquivo aqui para upload</p>}
      <label htmlFor={`attachment-file-${documentId}`}>{resume ? `Retomar ${resume.filename}` : 'Procurar arquivo'}</label>
      <input ref={input} id={`attachment-file-${documentId}`} type="file" accept=".pdf,.png,.jpg,.jpeg,.xml,.txt" disabled={blocked || Boolean(busy) || unresolved || loading || (!resume && rows.length >= 100)} onChange={event => chooseFile(event.target.files?.[0] || null)} />
      {file && <span className="attachment-selected">{file.name} · {attachmentSize(file.size)}</span>}
      <div className="attachment-actions"><button className="primary-button" type="submit" disabled={!file || blocked || Boolean(busy) || unresolved || loading}>{busy || (resume ? 'Retomar envio' : 'Enviar arquivo')}</button>
        {(file || resume) && <button className="secondary-button" type="button" disabled={Boolean(busy)||unresolved} onClick={resetFile}>Limpar seleção</button>}</div>
      {resume && <small>Selecione o arquivo original para retomar a reserva. O conteúdo será conferido antes do envio.</small>}
      {!resume && rows.length >= 100 && <p className="real-notice">O limite de 100 registros de anexo deste documento foi atingido. Envios cancelados permanecem no histórico.</p>}
    </form>}
    {deletion && <section className="real-notice" aria-label="Exclusão pendente dos anexos"><p>A exclusão de {deletion.ids.length} anexo(s) precisa ser confirmada.</p><button type="button" className="primary-button" disabled={Boolean(busy) || blocked} onClick={() => void removeSelected(deletion)}>Conferir resultado</button></section>}
    <div className="attachment-list-heading"><span role="status">{busy || (loading ? 'Carregando anexos…' : `${rows.length} registro(s) de anexo`)}</span><div className="attachment-actions">
      {writable && <button className="secondary-button" type="button" disabled={Boolean(busy) || unresolved || loading || blocked || Boolean(deletion) || !rows.some(row => selected.has(row.id) && row.status === 'ready')} onClick={() => {
        const ids = rows.filter(row => selected.has(row.id) && row.status === 'ready').map(row => row.id); if (!ids.length) return;
        const current = { ids, commands: Object.fromEntries(ids.map(id => [id, crypto.randomUUID()])) }; setDeletion(current); void removeSelected(current);
      }}>Excluir selecionados</button>}
      <button className="secondary-button" type="button" disabled={Boolean(busy) || unresolved || loading} onClick={() => setReload(value => value + 1)}>Atualizar lista</button></div></div>
    {rows.length > 0 && <div className="form-field attachment-search"><label htmlFor={`attachment-search-${documentId}`} className="sr-only">Pesquisar anexo</label><input id={`attachment-search-${documentId}`} type="search" maxLength={120} placeholder="Digite o nome do arquivo" value={nameQuery} onChange={event => setNameQuery(event.target.value)} /></div>}
    {!loading && !rows.length && <p className="real-help">Nenhum anexo neste documento.</p>}
    {rows.length > 0 && <div className="table-scroll" tabIndex={0} aria-label="Anexos do documento"><table className="data-table attachment-table"><thead><tr>{writable && <th><span className="sr-only">Selecionar</span></th>}<th>Miniatura</th><th>Nome</th><th>Tamanho</th><th>Data</th><th>Dono</th><th>Situação</th><th>Ações</th></tr></thead><tbody>{rows.filter(row => !nameQuery.trim() || row.filename.toLocaleLowerCase('pt-BR').includes(nameQuery.trim().toLocaleLowerCase('pt-BR'))).map(row => <tr key={row.id}>
      {writable && <td><input type="checkbox" aria-label={`Selecionar ${row.filename}`} disabled={row.status !== 'ready' || Boolean(busy) || Boolean(deletion) || unresolved} checked={selected.has(row.id)} onChange={event => setSelected(current => { const next = new Set(current); if (event.target.checked) next.add(row.id); else next.delete(row.id); return next; })} /></td>}
      <td className="attachment-thumbnail">{thumbnails[`${row.id}:${row.sha256}`] ? <img src={thumbnails[`${row.id}:${row.sha256}`]} alt={`Miniatura de ${row.filename}`} /> : <span className="attachment-format">{attachmentFormat(row.mime_type)}</span>}</td>
      <td>{row.filename}</td><td>{attachmentSize(row.size_bytes)}</td><td>{attachmentDay(row.finished_at ?? row.created_at)}</td><td>{row.owner_name ?? '—'}</td><td>{row.status === 'ready' ? 'Disponível' : row.status === 'reserved' ? 'Aguardando envio' : 'Reserva cancelada'}</td>
      <td><div className="attachment-actions">{row.status === 'ready' && <button className="text-button" type="button" disabled={blocked || Boolean(busy)||unresolved} onClick={() => void download(row)}>Baixar</button>}
        {row.status === 'reserved' && writable && <><button className="text-button" type="button" disabled={blocked || Boolean(busy)||unresolved} onClick={() => { if (blocked || busy || pending.current || attempt.current || canAct?.() === false) return; resetFile(); setResume(row); setError(''); setNotice(''); input.current?.focus(); }}>Retomar</button>
          <button className="text-button" type="button" disabled={blocked || Boolean(busy)||unresolved} onClick={() => void abort(row)}>Cancelar reserva</button></>}</div></td>
    </tr>)}</tbody></table></div>}
  </div>;
}
