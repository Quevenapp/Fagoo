import { useEffect, useRef, useState } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import { CATEGORY_ISSUE_TEXT, dateTimeText, mirrorCategoriesPath, mirrorDeletionsPath, readOriginCategories, readOriginDeletions, syncSummary,
  type OriginCategories, type OriginDeletion, type OriginDeletions } from '../lib/origin-mirror-model';
import './origin-mirror.css';

type Controller = Pick<AccessController, 'originMirror' | 'getSnapshot'>;
const failureText = (error: unknown) => error instanceof AccessError
  ? error.status === 403 ? 'Somente o administrador aplica a sincronização com o Origin.' : error.status === 409 ? 'O cadastro mudou no Origin ou no FAGOO. A lista foi atualizada.' : 'Não foi possível concluir. Confira o resultado antes de repetir.'
  : 'Não foi possível concluir. Confira o resultado antes de repetir.';
const isAdmin = (controller: Controller) => controller.getSnapshot()?.membership?.role === 'admin';

/**
 * Leva H (351): Cadastros › Categorias de produtos › "Categorias do Origin". The Origin categories (collected by the integration)
 * are brought to the Brufap tree by their external id: rename, move and inactivation never duplicate the tree. The administrador
 * runs "Sincronizar categorias do Origin"; a command not confirmed is repeated with "Conferir resultado".
 */
export function OriginCategorySync({ controller, onSynced }: { controller: Controller; onSynced: () => void }) {
  const [state, setState] = useState<OriginCategories | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState(''), [reload, setReload] = useState(0);
  const [command, setCommand] = useState<string | null>(null), [busy, setBusy] = useState(false), [open, setOpen] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const request = new AbortController();
    void Promise.resolve().then(() => controller.originMirror(mirrorCategoriesPath(), { signal: request.signal }))
      .then(value => { if (!request.signal.aborted) setState(readOriginCategories(value)); })
      .catch(() => { /* A secondary panel: an unreadable state leaves it hidden; the categories screen stays usable. */ });
    return () => request.abort();
  }, [controller, reload]);
  const sync = async () => {
    const id = command ?? crypto.randomUUID(); setCommand(id); setBusy(true); setError(''); setNotice('');
    try {
      const value = await controller.originMirror(mirrorCategoriesPath(true), { method: 'POST', body: { command_id: id } }) as { counts?: Record<string, number> };
      if (!mounted.current) return;
      setCommand(null); setNotice(syncSummary(value.counts ?? {})); setReload(n => n + 1); onSynced();
    } catch (failure) {
      if (!mounted.current) return;
      if (failure instanceof AccessError && failure.status < 500) setCommand(null);
      setError(failureText(failure));
    } finally { if (mounted.current) setBusy(false); }
  };
  if (!state) return null;
  const linked = state?.items ?? [], issues = linked.filter(item => item.issue || item.inactive || item.removed_locally);
  return <section className="origin-sync-panel" aria-label="Categorias do Origin">
    <p className="real-help">{state ? <>Categorias no Origin: {state.source_count} · vinculadas: {linked.filter(item => !item.removed_locally).length}{state.pending ? ` · ${state.pending} para sincronizar` : ''}
      {state.source_seen_at ? ` · última leitura do Origin em ${dateTimeText(state.source_seen_at)}` : ''}</> : null}</p>
    {isAdmin(controller) && <button type="button" className="secondary-button" disabled={busy} onClick={() => void sync()}>{command && !busy ? 'Conferir resultado' : 'Sincronizar categorias do Origin'}</button>}
    {issues.length > 0 && <button type="button" className="text-button" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Ocultar' : 'Ver'} pendências ({issues.length})</button>}
    {error && <p className="real-alert" role="alert">{error}</p>}
    {notice && <p className="real-help" role="status">{notice}</p>}
    {open && <table className="data-table"><thead><tr><th scope="col">Categoria no Origin</th><th scope="col">Situação</th></tr></thead>
      <tbody>{issues.map(item => <tr key={item.source_id}><td>{item.source_name} <span className="origin-mirror-badge">id {item.source_id}</span></td>
        <td>{[item.removed_locally ? 'Excluída no FAGOO (não é recriada)' : null, item.inactive ? 'Inativa no Origin' : null, item.issue ? CATEGORY_ISSUE_TEXT[item.issue] ?? item.issue : null].filter(Boolean).join(' · ')}</td></tr>)}</tbody></table>}
  </section>;
}

const STATUS_TEXT: Record<string, string> = { E: 'Excluído', A: 'Ativo', I: 'Inativo' };
/**
 * Leva H (352): Produtos › "Exclusões do Origin". Products excluded in the Origin (still in the Brufap) and products the Brufap
 * excluded because of the Origin that the Origin restored. The administrador applies each one; nothing changes by itself.
 */
export function OriginProductDeletions({ controller, onChanged }: { controller: Controller; onChanged: () => void }) {
  const [page, setPage] = useState<OriginDeletions | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState(''), [reload, setReload] = useState(0), [open, setOpen] = useState(false);
  const [pending, setPending] = useState<{ id: string; command: string } | null>(null), [busy, setBusy] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const request = new AbortController();
    void Promise.resolve().then(() => controller.originMirror(`${mirrorDeletionsPath()}?limit=100`, { signal: request.signal }))
      .then(value => { if (!request.signal.aborted) setPage(readOriginDeletions(value)); })
      .catch(() => { /* A secondary panel: an unreadable state leaves it hidden; the product list stays usable. */ });
    return () => request.abort();
  }, [controller, reload]);
  const apply = async (item: OriginDeletion) => {
    const command = pending?.id === item.id ? pending.command : crypto.randomUUID();
    setPending({ id: item.id, command }); setBusy(item.id); setError(''); setNotice('');
    try {
      await controller.originMirror(mirrorDeletionsPath(item.id), { method: 'POST', body: { command_id: command, expected_version: item.version, action: item.action } });
      if (!mounted.current) return;
      setPending(null); setNotice(item.action === 'delete' ? `${item.name} foi para Excluídos.` : `${item.name} foi restaurado.`); setReload(n => n + 1); onChanged();
    } catch (failure) {
      if (!mounted.current) return;
      if (failure instanceof AccessError && failure.status < 500) { setPending(null); if (failure.status === 409) setReload(n => n + 1); }
      setError(failureText(failure));
    } finally { if (mounted.current) setBusy(''); }
  };
  if (!page || page.items.length === 0) return null;
  return <section className="origin-sync-panel" aria-label="Exclusões do Origin">
    <p className="real-help">Exclusões do Origin: {page.items.filter(i => i.action === 'delete').length} excluído(s) no Origin e {page.items.filter(i => i.action === 'restore').length} restaurado(s) no Origin aguardam revisão.
      <button type="button" className="text-button" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Ocultar' : 'Revisar'}</button></p>
    {error && <p className="real-alert" role="alert">{error}</p>}
    {notice && <p className="real-help" role="status">{notice}</p>}
    {open && <table className="data-table"><thead><tr><th scope="col">Produto</th><th scope="col">Situação no Origin</th><th scope="col">Ação</th></tr></thead>
      <tbody>{page.items.map(item => <tr key={item.id}><td>{item.name}{item.code ? ` (${item.code})` : ''} <span className="origin-mirror-badge">id {item.source_id}</span></td>
        <td>{STATUS_TEXT[item.source_status] ?? item.source_status}{item.deleted_at ? ` · excluído no FAGOO em ${dateTimeText(item.deleted_at)}` : ''}</td>
        <td>{page.writable ? <button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => void apply(item)}>
          {pending?.id === item.id && busy !== item.id ? 'Conferir resultado' : item.action === 'delete' ? 'Mover para Excluídos' : 'Restaurar'}</button> : <span className="real-help">Somente o administrador aplica</span>}</td></tr>)}</tbody></table>}
    <p className="real-help">Os vínculos com pedidos, notas e estoque ficam preservados. Nada é alterado no Origin.</p>
  </section>;
}
