import { useEffect, useRef, useState, type DragEvent } from 'react';
import { Link } from 'react-router-dom';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { AccessError, type AccessController } from '../lib/real-access';
import { fileHash } from '../lib/attachment-model';
import { PRODUCT_IMAGE_LIMIT, imageDataUrl, imageFileType, productImagesOrderPath, productImagesPath, readStoredImage, readStoredImages, storedSize,
  type StoredImage, type StoredImagesPage } from '../lib/product-images-model';
import { Icon } from './Icon';
import './product-registry.css';

type Controller = Pick<AccessController, 'attachments' | 'getSnapshot'>;
const cancelled = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const actorOf = (controller: Controller) => controller.getSnapshot()?.membership?.user_id ?? null;
/** A refusal that repeating the same command cannot change. */
const definitive = (error: unknown) => error instanceof AccessError && [400, 403, 404, 409, 415].includes(error.status);
const message = (error: unknown) => error instanceof AccessError
  ? error.status === 403 ? 'Seu perfil não permite esta operação.' : error.status === 415 ? 'O conteúdo não corresponde a uma imagem PNG ou JPEG.'
    : error.status === 400 ? 'Confira o formato, o tamanho e o nome da imagem.' : error.status === 404 ? 'Produto ou imagem não encontrado. Atualize as imagens.'
      : error.status === 409 ? 'A imagem mudou, o limite de imagens foi atingido ou o produto foi excluído. Atualize as imagens.' : 'Não foi possível concluir. Confira o resultado antes de repetir.'
  : 'Não foi possível concluir. Confira o resultado antes de repetir.';
/** One upload, or one change (order or removal), kept with its command until confirmed ("Conferir resultado" repeats it). */
type Upload = { file: File; mime: string; sha: string; commandId: string; imageId?: string };
type Change = { kind: 'order'; ids: string[]; command: string } | { kind: 'delete'; id: string; command: string };

async function runUpload(controller: Controller, productId: string, a: Upload, signal: AbortSignal) {
  if (!a.imageId) {
    const value = await controller.attachments(productImagesPath(productId), { method: 'POST', signal,
      body: { command_id: a.commandId, filename: a.file.name, mime_type: a.mime, size_bytes: a.file.size, sha256: a.sha } }) as { image?: unknown };
    const row = readStoredImage(value?.image, productId);
    if (row.sha256 !== a.sha || row.size_bytes !== a.file.size) throw new AccessError(502);
    if (row.status === 'aborted') throw new AccessError(409);
    a.imageId = row.id;
    if (row.status === 'ready') return;
  }
  await controller.attachments(productImagesPath(productId, a.imageId, 'upload'), { method: 'PUT', body: a.file, contentType: a.mime, signal });
}

/** One stored image read and checked by size and SHA-256, as a data: URL (the ERP Content-Security-Policy allows img-src data:). */
async function verifiedPreview(controller: Controller, productId: string, image: StoredImage, signal: AbortSignal): Promise<string | null> {
  const blob = await controller.attachments(productImagesPath(productId, image.id, 'download'), { download: true, signal }) as Blob;
  if (!(blob instanceof Blob) || blob.size !== image.size_bytes || await fileHash(blob) !== image.sha256) return null;
  return imageDataUrl(blob, image.mime_type);
}

/** Wave E: "Imagem principal" of the product form without an external image: the first stored image (one listing and at most one
 * download, only while `wanted`); null while unknown, without stored images or when it cannot be checked. */
export function useStoredMainImage(controller: Controller, productId: string | null, wanted: boolean): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    setUrl(null);
    if (!productId || !wanted || typeof controller.attachments !== 'function') return;
    const request = new AbortController(), actor = controller.getSnapshot?.()?.membership?.user_id ?? null;
    void (async () => {
      try {
        const first = readStoredImages(await controller.attachments(productImagesPath(productId), { signal: request.signal }), productId).items[0];
        if (!first || request.signal.aborted) return;
        const preview = await verifiedPreview(controller, productId, first, request.signal);
        if (preview && !request.signal.aborted && (controller.getSnapshot?.()?.membership?.user_id ?? null) === actor) setUrl(preview);
      } catch { /* The placeholder of the Imagem principal stays. */ }
    })();
    return () => request.abort();
  }, [controller, productId, wanted]);
  return url;
}

/**
 * Origin "Imagens" > imagens armazenadas: arrastar e soltar ou "anexar arquivos" (PNG ou JPEG até 2 MB, até 20), miniaturas na ordem
 * (a primeira é a principal das armazenadas), mudar a ordem e remover. Cada envio e cada mudança é uma operação própria, com
 * "Conferir resultado"; as imagens não mudam a versão do produto, então o formulário pode continuar aberto. `onFirst` recebe a
 * prévia da primeira imagem (a Imagem principal do formulário sem imagem externa) sempre que ela muda.
 */
export default function ProductStoredImages({ controller, productId, writable, onFirst }: { controller: Controller; productId: string | null; writable: boolean; onFirst?: (preview: string | null) => void }) {
  const [page, setPage] = useState<StoredImagesPage | null>(null), [previews, setPreviews] = useState<Record<string, string>>({}), [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [over, setOver] = useState(false);
  const [queue, setQueue] = useState<Upload[]>([]), [change, setChange] = useState<Change | null>(null);
  const input = useRef<HTMLInputElement>(null), pending = useRef<AbortController | null>(null), actor = useRef(actorOf(controller)), mounted = useRef(true);
  // Ids whose preview is already shown: an image never changes (id and SHA-256 are immutable), so a reload after an upload, an order
  // or a removal does not download the other images again.
  const shown = useRef(new Set<string>());
  useUnsavedChanges(Boolean(queue.length || change), Boolean(busy));
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; pending.current?.abort(); }; }, []);
  useEffect(() => {
    if (!productId) return;
    const request = new AbortController(); setError('');
    void Promise.resolve().then(() => controller.attachments(productImagesPath(productId), { signal: request.signal })).then(async value => {
      const current = readStoredImages(value, productId);
      if (request.signal.aborted) return;
      setPage(current);
      // Previews: each image is read once, checked by size and SHA-256, and shown as a data: URL.
      for (const image of current.items) {
        if (request.signal.aborted || actorOf(controller) !== actor.current) return;
        if (shown.current.has(image.id)) continue;
        try {
          const url = await verifiedPreview(controller, productId, image, request.signal);
          if (!url) continue;
          if (!request.signal.aborted && actorOf(controller) === actor.current) { shown.current.add(image.id); setPreviews(previous => ({ ...previous, [image.id]: url })); }
        } catch (failure) { if (cancelled(failure) || request.signal.aborted) return; }
      }
    }).catch(failure => { if (!request.signal.aborted && !cancelled(failure)) setError('Não foi possível carregar as imagens armazenadas.'); });
    return () => request.abort();
  }, [controller, productId, reload]);
  const firstId = page?.items[0]?.id ?? null, firstPreview = firstId ? previews[firstId] ?? null : null;
  useEffect(() => { if (page) onFirst?.(firstPreview); }, [page === null, firstId, firstPreview]);
  if (!productId) return <section className="product-stored-images" aria-label="Imagens armazenadas"><h3>Imagens armazenadas</h3><p className="real-help">Salve o produto para enviar imagens armazenadas no FAGOO.</p></section>;
  const act = async (label: string, work: (signal: AbortSignal) => Promise<void>) => {
    if (pending.current) return;
    const request = new AbortController(); pending.current = request; setBusy(label); setError(''); setNotice('');
    try { await work(request.signal); if (actorOf(controller) !== actor.current) throw new AccessError(403); }
    catch (failure) { if (!cancelled(failure) && !request.signal.aborted && mounted.current) setError(message(failure)); }
    finally { if (pending.current === request) pending.current = null; if (mounted.current && !request.signal.aborted) setBusy(''); }
  };
  // Uploads run one after the other; an unconfirmed one stops the queue and keeps its command for "Conferir resultado".
  const sendQueue = (items: Upload[]) => act(`Enviando ${items.length} imagem(ns)…`, async signal => {
    const rest = [...items];
    while (rest.length) {
      const current = rest[0];
      try { await runUpload(controller, productId, current, signal); }
      catch (failure) { if (definitive(failure)) { rest.shift(); setQueue([...rest]); setReload(value => value + 1); } else setQueue([...rest]); throw failure; }
      rest.shift(); setQueue([...rest]);
    }
    setReload(value => value + 1); setNotice('Imagens enviadas.');
  });
  const choose = async (files: readonly File[]) => {
    if (!writable || pending.current || queue.length || change || !files.length) return;
    const free = PRODUCT_IMAGE_LIMIT - (page?.items.length ?? 0) - (page?.pending.length ?? 0);
    if (files.length > free) { setError(`O produto pode ter até ${PRODUCT_IMAGE_LIMIT} imagens armazenadas; ${Math.max(0, free)} ainda cabem.`); return; }
    const items: Upload[] = [];
    for (const file of files) {
      let mime: 'image/png' | 'image/jpeg';
      try { mime = imageFileType(file); } catch (failure) { setError((failure as Error).message); if (input.current) input.current.value = ''; return; }
      items.push({ file, mime, sha: await fileHash(file), commandId: crypto.randomUUID() });
    }
    if (input.current) input.current.value = '';
    setQueue(items); await sendQueue(items);
  };
  const discard = () => act('Cancelando o envio…', async signal => {
    const current = queue[0];
    if (current?.imageId) await controller.attachments(productImagesPath(productId, current.imageId, 'abort'), { method: 'POST', body: {}, signal });
    setQueue([]); setReload(value => value + 1);
  });
  const apply = (current: Change) => act(current.kind === 'order' ? 'Mudando a ordem…' : 'Removendo a imagem…', async signal => {
    try {
      if (current.kind === 'order') {
        const value = await controller.attachments(productImagesOrderPath(productId), { method: 'POST', body: { command_id: current.command, ids: current.ids }, signal });
        setPage(readStoredImages(value, productId));
      } else await controller.attachments(productImagesPath(productId, current.id, 'exclusao'), { method: 'POST', body: { command_id: current.command }, signal });
    } catch (failure) { if (definitive(failure)) { setChange(null); setReload(value => value + 1); } throw failure; }
    setChange(null); if (current.kind === 'delete') setReload(value => value + 1);
  });
  const move = (index: number, to: number) => {
    if (!page || to < 0 || to >= page.items.length || busy || queue.length || change) return;
    const ids = page.items.map(item => item.id); const [id] = ids.splice(index, 1); ids.splice(to, 0, id);
    const current: Change = { kind: 'order', ids, command: crypto.randomUUID() }; setChange(current); void apply(current);
  };
  const remove = (image: StoredImage) => { if (busy || queue.length || change) return; const current: Change = { kind: 'delete', id: image.id, command: crypto.randomUUID() }; setChange(current); void apply(current); };
  const drop = (event: DragEvent<HTMLDivElement>) => { event.preventDefault(); setOver(false); if (writable) void choose([...(event.dataTransfer?.files ?? [])]); };
  const items = page?.items ?? [], locked = !writable || Boolean(busy) || queue.length > 0 || Boolean(change);
  return <section className="product-stored-images" aria-label="Imagens armazenadas" aria-busy={Boolean(busy)}>
    <h3>Imagens armazenadas<span className="product-info" title={`PNG ou JPEG, até 2 MB cada e ${PRODUCT_IMAGE_LIMIT} por produto, no armazenamento privado da empresa.`}><Icon name="circle-info" size={11} /></span></h3>
    <p className="real-help">{page ? `${items.length} de ${PRODUCT_IMAGE_LIMIT} imagens · ${storedSize(page.stored_bytes)} usados por este produto.` : 'Carregando…'} O espaço total da empresa fica em <Link to="/empresa-configuracoes?secao=armazenamento">Espaço e armazenamento</Link>.</p>
    {error && <p className="real-alert" role="alert">{error}</p>}{notice && <p className="real-success" role="status">{notice}</p>}{busy && <p role="status">{busy}</p>}
    {queue.length > 0 && !busy && <div className="real-notice" role="region" aria-label="Envio pendente"><p>O envio de {queue[0].file.name}{queue.length > 1 ? ` e de mais ${queue.length - 1} imagem(ns)` : ''} precisa ser confirmado.</p>
      <button type="button" className="primary-button" onClick={() => void sendQueue(queue)}>Conferir resultado</button><button type="button" className="secondary-button" onClick={() => void discard()}>Descartar o envio</button></div>}
    {change && !busy && <div className="real-notice" role="region" aria-label="Alteração pendente"><p>{change.kind === 'order' ? 'A nova ordem das imagens' : 'A remoção da imagem'} precisa ser confirmada.</p>
      <button type="button" className="primary-button" onClick={() => void apply(change)}>Conferir resultado</button></div>}
    {writable && <div className={`product-image-drop${over ? ' is-over' : ''}`} onDragOver={event => { event.preventDefault(); if (!locked) setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop}>
      <Icon name="image" size={18} /><span>Arraste e solte as imagens aqui ou</span>
      <label className="secondary-button" htmlFor={`product-images-${productId}`}><Icon name="paperclip" size={12} />anexar arquivos</label>
      <input ref={input} id={`product-images-${productId}`} className="sr-only" type="file" multiple accept=".png,.jpg,.jpeg,image/png,image/jpeg" disabled={locked || !page || items.length >= PRODUCT_IMAGE_LIMIT}
        onChange={event => void choose([...((event.target as HTMLInputElement).files ?? [])])} /></div>}
    {page && !items.length ? <p className="real-help">Nenhuma imagem armazenada.</p> : <ol className="product-image-grid">{items.map((image, index) => <li key={image.id}>
      {previews[image.id] ? <img src={previews[image.id]} alt={`Imagem armazenada ${index + 1}: ${image.filename}`} /> : <span className="product-image-placeholder" aria-label={`Carregando a imagem ${index + 1}`}><Icon name="image" size={20} /></span>}
      <small>{index === 0 ? 'Principal · ' : ''}{storedSize(image.size_bytes)}</small>
      {writable && <span className="product-order"><button type="button" className="icon-button" aria-label={`Mover a imagem armazenada ${index + 1} para a esquerda`} disabled={locked || index === 0} onClick={() => move(index, index - 1)}><Icon name="arrow-left" size={10} /></button>
        <button type="button" className="icon-button" aria-label={`Mover a imagem armazenada ${index + 1} para a direita`} disabled={locked || index === items.length - 1} onClick={() => move(index, index + 1)}><Icon name="arrow-right" size={10} /></button>
        <button type="button" className="icon-button" aria-label={`Remover a imagem armazenada ${index + 1}`} title="Remover" disabled={locked} onClick={() => remove(image)}><Icon name="trash-can" size={11} /></button></span>}
    </li>)}</ol>}
  </section>;
}
