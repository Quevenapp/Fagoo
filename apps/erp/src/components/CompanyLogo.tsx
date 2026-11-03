import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { AccessError, type AccessController } from '../lib/real-access';
import { attachmentSize } from '../lib/attachment-model';
import { COMPANY_LOGO_PATH, companyLogoPath, logoDataUrl, logoFileType, logoHash, readCompanyLogo, readCompanyLogoPage, verifiedLogo, type CompanyLogo as Logo, type CompanyLogoMime } from '../lib/company-logo-model';
import { Icon } from './Icon';

type Controller = Pick<AccessController, 'attachments' | 'getSnapshot'> & Partial<Pick<AccessController, 'subscribe'>>;
const NO_SUBSCRIBE = () => () => {};
const cancelled = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const actorOf = (controller: Controller) => { const s = controller.getSnapshot(); return s?.phase === 'ready' ? `${s.membership?.user_id}:${s.membership?.role}` : null; };
/** A refusal that repeating the same command cannot change (nothing stays pending). */
const definitive = (error: unknown) => error instanceof AccessError && [400, 403, 404, 409].includes(error.status);
const message = (error: unknown) => error instanceof AccessError
  ? error.status === 403 ? 'Somente administradores alteram o logo da empresa.' : error.status === 415 ? 'O conteúdo não corresponde a uma imagem PNG ou JPEG.'
    : error.status === 400 ? 'Confira o formato e o tamanho da imagem (PNG ou JPEG de até 2 MB).' : error.status === 404 ? 'Logo não encontrado. Atualize a tela.'
      : error.status === 409 ? 'O logo mudou, está em envio ou já foi removido. Confira o resultado.' : 'Não foi possível concluir. Confira o resultado antes de repetir.'
  : 'Não foi possível concluir. Confira o resultado antes de repetir.';
/** One upload kept with its command until the result is confirmed ("Conferir resultado" repeats exactly the same operation). */
type Upload = { file: File; mime: CompanyLogoMime; sha: string; commandId: string; logoId?: string };

/**
 * Origin empresa.php, aba "Sua marca": Logo (envio de imagem). The logo appears in the prints that show the company header, such
 * as the recibo of contas a receber and the comprovante of contas a pagar when "Exibir cabeçalho com logo e informações da
 * empresa ao imprimir recibo" is on (Preferências › Finanças). Administrador only for changes; every member sees it.
 */
export default function CompanyLogo({ controller }: { controller: Controller }) {
  const [logo, setLogo] = useState<Logo | null>(null), [canManage, setCanManage] = useState(false), [url, setUrl] = useState(''), [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [reload, setReload] = useState(0);
  const [upload, setUpload] = useState<Upload | null>(null), [removal, setRemoval] = useState<{ id: string; command: string } | null>(null);
  const input = useRef<HTMLInputElement>(null), pending = useRef<AbortController | null>(null), reading = useRef<AbortController | null>(null), actor = useRef(actorOf(controller)), mounted = useRef(true);
  // Review: the screen is not remounted when the user or the role changes (Empresa › Dados da empresa), so it follows the access
  // snapshot itself: a change drops what was pending for the previous actor and reads the logo and "can_manage" again.
  const live = useSyncExternalStore(controller.subscribe ?? NO_SUBSCRIBE, () => actorOf(controller)), stale = live !== actor.current;
  useUnsavedChanges(Boolean(upload || removal) && !stale, Boolean(busy) && !stale);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; pending.current?.abort(); }; }, []);
  useEffect(() => {
    if (!stale) return;
    pending.current?.abort(); pending.current = null; reading.current?.abort(); actor.current = live;
    setUpload(null); setRemoval(null); setBusy(''); setError(''); setNotice(''); setLogo(null); setUrl(''); setCanManage(false); if (input.current) input.current.value = '';
    setReload(value => value + 1);
  }, [stale, live]);
  useEffect(() => {
    const request = new AbortController(); reading.current = request; setLoading(true); setError('');
    void Promise.resolve().then(() => controller.attachments(COMPANY_LOGO_PATH, { signal: request.signal })).then(async value => {
      const page = readCompanyLogoPage(value);
      if (request.signal.aborted || actorOf(controller) !== actor.current) return;
      setLogo(page.logo); setCanManage(page.can_manage);
      if (!page.logo) { setUrl(''); setLoading(false); return; }
      const blob = await verifiedLogo(controller.attachments, page.logo, request.signal);
      const data = await logoDataUrl(blob, page.logo.mime_type);
      if (request.signal.aborted || actorOf(controller) !== actor.current) return;
      setUrl(data); setLoading(false);
    }).catch(failure => { if (!request.signal.aborted && !cancelled(failure)) { setError('Não foi possível carregar o logo da empresa.'); setLoading(false); } });
    return () => request.abort();
  }, [controller, reload]);
  const act = async (label: string, work: (signal: AbortSignal) => Promise<void>) => {
    if (pending.current || actorOf(controller) !== actor.current) return;
    const request = new AbortController(); pending.current = request; setBusy(label); setError(''); setNotice('');
    try { await work(request.signal); if (actorOf(controller) !== actor.current) throw new AccessError(403); }
    catch (failure) { if (!cancelled(failure) && !request.signal.aborted && mounted.current) setError(message(failure)); }
    finally { if (pending.current === request) pending.current = null; if (mounted.current && !request.signal.aborted) setBusy(''); }
  };
  const send = (attempt: Upload) => act('Enviando o logo…', async signal => {
    if (!attempt.logoId) {
      const value = await controller.attachments(COMPANY_LOGO_PATH, { method: 'POST', signal, body: { command_id: attempt.commandId, mime_type: attempt.mime, size_bytes: attempt.file.size, sha256: attempt.sha } }) as { logo?: unknown };
      const row = readCompanyLogo(value?.logo);
      if (row.sha256 !== attempt.sha || row.size_bytes !== attempt.file.size || row.mime_type !== attempt.mime) throw new AccessError(502);
      if (row.status === 'aborted') throw new AccessError(409);
      attempt.logoId = row.id;
      if (row.status === 'reserved') await controller.attachments(companyLogoPath(row.id, 'upload'), { method: 'PUT', body: attempt.file, contentType: attempt.mime, signal });
    } else await controller.attachments(companyLogoPath(attempt.logoId, 'upload'), { method: 'PUT', body: attempt.file, contentType: attempt.mime, signal });
    const page = readCompanyLogoPage(await controller.attachments(COMPANY_LOGO_PATH, { signal }));
    if (!page.logo || page.logo.id !== attempt.logoId || page.logo.sha256 !== attempt.sha) throw new AccessError(502);
    if (signal.aborted) return;
    setUpload(null); if (input.current) input.current.value = ''; setNotice('Logo enviado. Ele passa a aparecer nas impressões com o cabeçalho da empresa.'); setReload(value => value + 1);
  });
  const choose = async (file: File | null) => {
    if (!file || !canManage || pending.current || upload || removal) return;
    let mime: CompanyLogoMime; try { mime = logoFileType(file); } catch (failure) { setError((failure as Error).message); if (input.current) input.current.value = ''; return; }
    const attempt: Upload = { file, mime, sha: await logoHash(file), commandId: crypto.randomUUID() };
    setUpload(attempt); await send(attempt);
  };
  const discard = (attempt: Upload) => act('Cancelando a reserva…', async signal => {
    if (attempt.logoId) await controller.attachments(companyLogoPath(attempt.logoId, 'abort'), { method: 'POST', body: {}, signal });
    setUpload(null); if (input.current) input.current.value = '';
  });
  const remove = (current: { id: string; command: string }) => act('Removendo o logo…', async signal => {
    try { await controller.attachments(companyLogoPath(current.id, 'exclusao'), { method: 'POST', body: { command_id: current.command }, signal }); }
    catch (failure) { if (definitive(failure)) { setRemoval(null); setReload(value => value + 1); } throw failure; }
    setRemoval(null); setNotice('Logo removido. As impressões voltam a mostrar só a identificação da empresa.'); setReload(value => value + 1);
  });
  const locked = Boolean(busy) || Boolean(upload) || Boolean(removal) || loading || stale;
  return <section className="real-editor company-settings-section company-logo" aria-label="Sua marca">
    <header className="real-editor-heading"><div><h2>Sua marca</h2><p>Logo da empresa usado no cabeçalho das impressões (recibos e comprovantes das contas, com a opção ligada em Preferências › Finanças).</p></div></header>
    {error && <p className="real-alert" role="alert">{error}</p>}{notice && <p className="real-success" role="status">{notice}</p>}
    <div className="form-field"><span className="contact-label">Logo</span>
      {url ? <img src={url} alt="Logo da empresa" className="company-logo-preview" /> : <p className="real-help">{loading ? 'Carregando o logo…' : 'Nenhum logo enviado.'}</p>}
      {logo && <small className="real-help">{logo.mime_type === 'image/png' ? 'PNG' : 'JPEG'} · {attachmentSize(logo.size_bytes)}{logo.owner_name ? ` · enviado por ${logo.owner_name}` : ''}</small>}
    </div>
    {canManage && !stale && <div className="contact-files-actions">
      <label className="secondary-button" htmlFor="company-logo-file"><Icon name="image" size={12} />{logo ? 'Trocar logo' : 'Enviar logo'}</label>
      <input ref={input} id="company-logo-file" className="sr-only" type="file" accept=".png,.jpg,.jpeg" disabled={locked} onChange={event => void choose(event.target.files?.[0] ?? null)} />
      {logo && <button type="button" className="text-button" disabled={locked} onClick={() => { const current = { id: logo.id, command: crypto.randomUUID() }; setRemoval(current); void remove(current); }}>Remover logo</button>}
      <button type="button" className="text-button" disabled title="Envie a imagem do logo da empresa.">Gerar nova logo</button>
    </div>}
    {upload && !stale && <p className="real-notice">O envio do logo precisa ser confirmado. O arquivo e a operação ficam preservados.
      <button type="button" className="text-button" disabled={Boolean(busy)} onClick={() => void send(upload)}>Conferir resultado</button>
      <button type="button" className="text-button" disabled={Boolean(busy)} onClick={() => void discard(upload)}>Descartar o envio</button></p>}
    {removal && !stale && <p className="real-notice">A remoção do logo precisa ser confirmada. <button type="button" className="text-button" disabled={Boolean(busy)} onClick={() => void remove(removal)}>Conferir resultado</button></p>}
    {busy && <small role="status">{busy}</small>}
    <small className="real-help">{canManage ? 'PNG ou JPEG de até 2 MB. Um logo novo substitui o anterior.' : 'Somente administradores enviam ou removem o logo.'}</small>
  </section>;
}
