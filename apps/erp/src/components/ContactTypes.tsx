import { useEffect, useRef, useState } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import { planBatch, summarizeBatch, batchSummaryText, type BatchResult, type BatchStep } from '../lib/origin-batch';
import type { ContactTypeItem, ContactTypes as ContactTypesPage } from '../lib/contact-list-model';
import { BatchDialog } from './BatchDialog';
import { ContactTypeModal } from './ContactTypeModal';
import { Icon } from './Icon';
import { ToolButton } from './OriginList';
import { aborted, errorText, knownFailure } from './catalog-shared';
import { contactRefusalText } from './contact-errors';
import './contacts.css';

// Tipos de contatos (Origin TC-01 a TC-03): Busca "Pesquisar", Lixeira, Checkbox todos, Recarregar, "+ Incluir", coluna
// "Tipo de contato" e "Quantidade de tipos de contatos". Os tipos do sistema não têm caixa de seleção e não são
// excluídos; Contador, Fornecedor verificado e os tipos criados podem ser excluídos pelo administrador.
const fold = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export default function ContactTypes({ controller }: { controller: AccessController }) {
  const [page, setPage] = useState<ContactTypesPage | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState(''), [reload, setReload] = useState(0);
  const [query, setQuery] = useState(''), [selected, setSelected] = useState<ReadonlySet<string>>(new Set()), [adding, setAdding] = useState(false), [batch, setBatch] = useState<ContactTypeItem[] | null>(null);
  const batchSignal = useRef<AbortController | null>(null), actor = useRef(controller.getSnapshot().membership?.user_id);
  useEffect(() => {
    const request = new AbortController(); setError('');
    void controller.catalog('/v1/cadastros/tipos-contato', { signal: request.signal }).then(value => {
      if (request.signal.aborted) return; const result = value as ContactTypesPage;
      if (!Array.isArray(result.items)) throw new AccessError(502); setPage(result); setSelected(new Set());
    }).catch(failure => { if (!request.signal.aborted && !aborted(failure)) setError(errorText(failure)); });
    return () => request.abort();
  }, [controller, reload]);
  useEffect(() => () => batchSignal.current?.abort(), []);
  const shown = (page?.items ?? []).filter(item => !query.trim() || fold(item.label).includes(fold(query.trim())));
  const deletable = shown.filter(item => item.deletable), canDelete = Boolean(page?.can_delete);
  const all = deletable.length > 0 && deletable.every(item => selected.has(item.id));
  const run = async (item: ContactTypeItem): Promise<BatchStep> => {
    const signal = batchSignal.current?.signal;
    if (!signal || signal.aborted || controller.getSnapshot().membership?.user_id !== actor.current) throw new Error('A sessão mudou durante a operação. Este tipo não foi excluído.');
    const body = { command_id: crypto.randomUUID() };
    const send = async () => { const result = await controller.catalog(`/v1/cadastros/tipos-contato/${item.id}/excluir`, { method: 'POST', body, signal }) as { id?: string; unlinked?: number }; if (result.id !== item.id) throw new AccessError(502); return result.unlinked ?? 0; };
    try { const unlinked = await send(); return unlinked ? { message: `${unlinked} ${unlinked === 1 ? 'contato deixou' : 'contatos deixaram'} de ter este tipo.` } : undefined; }
    catch (failure) {
      if (!aborted(failure) && knownFailure(failure)) throw new Error(contactRefusalText(failure) ?? errorText(failure));
      try { if (!signal.aborted) { await send(); return { message: 'Confirmado ao repetir a mesma operação.' }; } } catch { /* Still unknown. */ }
      return { uncertain: true, message: 'Não foi possível confirmar o resultado. Recarregue a lista antes de repetir.' };
    }
  };
  const plan = batch ? planBatch(batch.map(item => ({ ...item, label: item.label })), () => null) : null;
  return <section className="contact-aux real-section" aria-labelledby="contact-types-title">
    <header className="real-heading catalog-heading"><div className="catalog-title"><h1 id="contact-types-title">Tipos de contatos</h1></div>
      <div className="catalog-heading-actions">{page?.can_create && <button type="button" className="primary-button" onClick={() => setAdding(true)}><Icon name="plus" size={12} />Incluir</button>}</div></header>
    {notice && <p className="real-success" role="status">{notice}</p>}
    {error && <p className="real-alert" role="alert">{error}<button type="button" className="text-button" onClick={() => setReload(n => n + 1)}>Tentar novamente</button></p>}
    <div className="native-list-toolbar"><div className="form-field"><label htmlFor="contact-types-search">Pesquisar</label><input id="contact-types-search" type="search" maxLength={60} placeholder="Pesquisar" value={query} onChange={event => setQuery(event.target.value)} /></div>
      {canDelete && <ToolButton icon="trash-can" title="Excluir selecionados" disabled={!selected.size} onClick={() => setBatch((page?.items ?? []).filter(item => selected.has(item.id)))} />}</div>
    <div className="origin-list-controls">{canDelete && <span className="origin-select-all"><input type="checkbox" aria-label="Selecionar todos" checked={all} disabled={!deletable.length} onChange={() => setSelected(all ? new Set() : new Set(deletable.map(item => item.id)))} /></span>}
      <button type="button" className="origin-refresh" title="Recarregar" aria-label="Recarregar" onClick={() => setReload(n => n + 1)}><Icon name="rotate-right" size={12} /></button></div>
    <div className="table-scroll"><table className="data-table real-table origin-table contact-aux-table"><thead><tr>{canDelete && <th scope="col" className="checkbox-cell"><span className="real-sr-only">Seleção</span></th>}<th scope="col">Tipo de contato</th></tr></thead>
      <tbody>{shown.map(item => <tr key={item.id}>{canDelete && <td className="checkbox-cell">{item.deletable && <input type="checkbox" aria-label={`Selecionar ${item.label}`} checked={selected.has(item.id)} onChange={event => setSelected(previous => { const next = new Set(previous); if (event.target.checked) next.add(item.id); else next.delete(item.id); return next; })} />}</td>}
        <td>{item.label}{item.system && <span className="real-sr-only"> (tipo do sistema)</span>}</td></tr>)}</tbody></table></div>
    {page && !shown.length && <p className="real-help">Nenhum tipo de contato encontrado.</p>}
    <div className="native-list-summary"><h3>Informações</h3><dl className="native-list-stat"><dt>Quantidade de tipos de contatos</dt><dd>{page ? page.items.length : '—'}</dd></dl></div>
    {adding && <ContactTypeModal controller={controller} showManageLink={false} onClose={() => setAdding(false)} onCreated={type => { setAdding(false); setNotice(`Tipo de contato "${type.label}" incluído.`); setReload(n => n + 1); }} />}
    {batch && plan && <BatchDialog title="Excluir tipos de contato" plan={plan} confirmLabel="Excluir" run={item => { batchSignal.current ??= new AbortController(); return run(item); }}
      description={<p>Os contatos marcados com estes tipos deixam de tê-los. Os tipos do sistema não podem ser excluídos.</p>}
      onClose={(results: BatchResult[] | null) => { setBatch(null); batchSignal.current = null; if (results) { setNotice(`Exclusão de tipos: ${batchSummaryText(summarizeBatch(results))}.`); setReload(n => n + 1); } }} />}
  </section>;
}
