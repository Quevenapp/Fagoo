import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import { Modal } from './Modal';

type Controller = Pick<AccessController, 'catalog' | 'getSnapshot'>;
/** The whole row of Clientes e fornecedores, handed to the caller on Selecionar (the PDV shows Tipo, CNPJ/CPF, Código and Fantasia). */
export type DocumentContactRow = { id: string; name: string; trade_name: string | null; code: string | null; document: string | null; person_type: 'F' | 'J' | 'E' | null; city: string | null; state: string | null; situation: string };
type Row = DocumentContactRow;
type Filters = { q: string; city: string; state: string; type: string; person_type: string; situation: 'A' | 'S' };
const EMPTY: Filters = { q: '', city: '', state: '', type: '', person_type: '', situation: 'A' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, SIZE = 10;
const UFS = ['AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO'];
const actorOf = (controller: Controller) => controller.getSnapshot()?.membership?.user_id ?? null;
function readPage(value: unknown): { items: Row[]; total: number } {
  const page = value as { items?: unknown; total?: unknown } | null;
  if (!page || !Array.isArray(page.items) || page.items.length > SIZE || !Number.isSafeInteger(page.total)) throw new AccessError(502);
  return { total: page.total as number, items: page.items.map(item => {
    const row = item as Row;
    if (!row || !UUID.test(row.id) || typeof row.name !== 'string') throw new AccessError(502);
    const person = row.person_type === 'F' || row.person_type === 'J' || row.person_type === 'E' ? row.person_type : null;
    return { id: row.id, name: row.name, trade_name: row.trade_name ?? null, code: row.code ?? null, document: row.document ?? null, person_type: person, city: row.city ?? null, state: row.state ?? null, situation: row.situation };
  }) };
}

/**
 * Origin lupa "Pesquisar" of the Cliente/Fornecedor field (busca avançada): nome, fantasia, código ou CPF/CNPJ, cidade, UF, tipo de
 * contato and pessoa, over Clientes e fornecedores (only Ativo or Sem movimento can be chosen in a document).
 */
export default function DocumentContactSearch({ controller, label, initialQuery, onSelect, onClose }: {
  controller: Controller; label: string; initialQuery: string; onSelect: (row: DocumentContactRow) => void; onClose: () => void;
}) {
  const [draft, setDraft] = useState<Filters>({ ...EMPTY, q: initialQuery.slice(0, 120) }), [filters, setFilters] = useState<Filters>({ ...EMPTY, q: initialQuery.slice(0, 120) });
  const [page, setPage] = useState(1), [result, setResult] = useState<{ items: Row[]; total: number } | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [types, setTypes] = useState<{ slug: string; label: string }[]>([]);
  const actor = useRef(actorOf(controller));
  useEffect(() => {
    const request = new AbortController();
    void Promise.resolve().then(() => controller.catalog('/v1/cadastros/tipos-contato', { signal: request.signal })).then(value => {
      const items = (value as { items?: { slug?: unknown; label?: unknown }[] })?.items;
      if (!request.signal.aborted && Array.isArray(items)) setTypes(items.filter(item => typeof item.slug === 'string' && typeof item.label === 'string').map(item => ({ slug: item.slug as string, label: item.label as string })));
    }).catch(() => undefined);
    return () => request.abort();
  }, [controller]);
  useEffect(() => {
    const request = new AbortController(); setLoading(true); setError('');
    const params = new URLSearchParams({ page: String(page), size: String(SIZE), sort: 'name_asc', situation: filters.situation });
    for (const key of ['q', 'city', 'state', 'type', 'person_type'] as const) if (filters[key].trim()) params.set(key, filters[key].trim());
    void Promise.resolve().then(() => controller.catalog(`/v1/cadastros/contatos?${params}`, { signal: request.signal })).then(value => {
      if (request.signal.aborted) return;
      if (actorOf(controller) !== actor.current) { setError('A sessão mudou. Feche e abra a busca novamente.'); setLoading(false); return; }
      setResult(readPage(value)); setLoading(false);
    }).catch(failure => { if (!request.signal.aborted) { setResult(null); setLoading(false); setError(failure instanceof AccessError && failure.status === 403 ? 'Seu perfil não consulta os cadastros.' : 'Não foi possível pesquisar agora.'); } });
    return () => request.abort();
  }, [controller, filters, page]);
  const submit = (event: FormEvent) => { event.preventDefault(); event.stopPropagation(); setPage(1); setFilters({ ...draft }); };
  const set = (key: keyof Filters, value: string) => setDraft(current => ({ ...current, [key]: value }));
  const pages = result ? Math.max(1, Math.ceil(result.total / SIZE)) : 1;
  return <Modal title={`Pesquisar ${label.toLowerCase()}`} onClose={onClose} actions={<button type="button" className="secondary-button" onClick={onClose}>Fechar</button>}>
    <form className="document-contact-search" onSubmit={submit}>
      <div className="document-grid">
        <div className="form-field document-wide"><label htmlFor="contact-search-q">Nome, fantasia, código ou CPF/CNPJ</label><input id="contact-search-q" type="search" maxLength={120} value={draft.q} onChange={event => set('q', event.target.value)} /></div>
        <div className="form-field"><label htmlFor="contact-search-city">Cidade</label><input id="contact-search-city" maxLength={100} value={draft.city} onChange={event => set('city', event.target.value)} /></div>
        <div className="form-field"><label htmlFor="contact-search-state">UF</label><select id="contact-search-state" value={draft.state} onChange={event => set('state', event.target.value)}><option value="">Todas</option>{UFS.map(uf => <option key={uf} value={uf}>{uf}</option>)}</select></div>
        <div className="form-field"><label htmlFor="contact-search-type">Tipo de contato</label><select id="contact-search-type" value={draft.type} onChange={event => set('type', event.target.value)}><option value="">Todos</option>{types.map(type => <option key={type.slug} value={type.slug}>{type.label}</option>)}</select></div>
        <div className="form-field"><label htmlFor="contact-search-person">Tipo de pessoa</label><select id="contact-search-person" value={draft.person_type} onChange={event => set('person_type', event.target.value)}><option value="">Todas</option><option value="F">Física</option><option value="J">Jurídica</option><option value="E">Estrangeiro</option></select></div>
        <div className="form-field"><label htmlFor="contact-search-situation">Situação</label><select id="contact-search-situation" value={draft.situation} onChange={event => set('situation', event.target.value as 'A' | 'S')}><option value="A">Ativo</option><option value="S">Sem movimento</option></select></div>
      </div>
      <button type="submit" className="primary-button" disabled={loading}>Pesquisar</button>
    </form>
    {error && <p className="real-alert" role="alert">{error}</p>}
    {loading ? <p role="status">Pesquisando…</p> : result && (result.items.length ? <div className="table-scroll" tabIndex={0} aria-label="Resultado da pesquisa"><table className="data-table"><thead><tr><th>Nome</th><th>Fantasia</th><th>CPF/CNPJ</th><th>Cidade</th><th><span className="sr-only">Ação</span></th></tr></thead>
      <tbody>{result.items.map(row => <tr key={row.id}><td>{row.name}{row.code ? ` · ${row.code}` : ''}</td><td>{row.trade_name ?? '—'}</td><td>{row.document ?? '—'}</td><td>{row.city ? `${row.city}${row.state ? ` / ${row.state}` : ''}` : '—'}</td>
        <td><button type="button" className="text-button" onClick={() => onSelect({ ...row })}>Selecionar</button></td></tr>)}</tbody></table></div>
      : <p className="real-help">Nenhum cadastro encontrado com estes filtros.</p>)}
    {result && result.total > SIZE && <div className="document-contact-search-pages"><button type="button" className="text-button" disabled={loading || page <= 1} onClick={() => setPage(value => value - 1)}>Anterior</button>
      <span>Página {page} de {pages}</span><button type="button" className="text-button" disabled={loading || page >= pages} onClick={() => setPage(value => value + 1)}>Próxima</button></div>}
  </Modal>;
}
