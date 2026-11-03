import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import { financeLinkActor } from '../lib/document-finance-link';
import { FINANCE_KIND, financeDate, financeMoney } from '../lib/real-finance-model';
import { captureFinanceMovementQuery, financeMovementPage, financeMovementPath, type FinanceMovementPage, type FinanceMovementQuery } from '../lib/finance-movement-period';
import './finance-movement-history.css';

type Controller = Pick<AccessController, 'finance' | 'getSnapshot' | 'subscribe'>;
type Selection = { owner: object; draft: { from: string; to: string }; applied: { from: string; to: string }; after: string | null; cursors: (string | null)[]; revision: number };
const empty = (owner: object): Selection => ({ owner, draft: { from: '', to: '' }, applied: { from: '', to: '' }, after: null, cursors: [], revision: 0 });
const sessionKey = (c: Controller) => { const s = c.getSnapshot(); return `${s.phase}:${s.membership?.user_id ?? ''}:${s.membership?.role ?? ''}`; };
const errorMessage = (e: unknown) => e instanceof AccessError && e.status === 403 ? 'Seu acesso à consulta financeira foi alterado.'
  : e instanceof AccessError && e.status === 404 ? 'A conta não foi localizada nesta consulta.' : 'Não foi possível consultar os movimentos. Tente novamente com o mesmo período.';

/** GET-only account history. Filtering never changes a financial record or computes a period balance. */
export default function FinanceMovementHistory({ controller, accountId }: { controller: Controller; accountId: string }) {
  const id = useId(), mounted = useRef(true), pending = useRef<AbortController | null>(null), fence = useRef(0);
  const [epoch, setEpoch] = useState(0), snapshot = controller.getSnapshot(), actor = financeLinkActor(snapshot);
  const owner = useMemo(() => ({}), [controller, accountId, snapshot.membership?.user_id]);
  const scope = useMemo(() => ({}), [owner, epoch]);
  const [selection, setSelection] = useState<Selection>(() => empty(owner));
  const selected = selection.owner === owner ? selection : empty(owner), selectionRef = useRef(selected); selectionRef.current = selected;
  const [read, setRead] = useState<{ scope: object; key: string; page: FinanceMovementPage | null; error: string; busy: boolean } | null>(null);
  const [validation, setValidation] = useState('');
  const key = JSON.stringify([selected.applied.from, selected.applied.to, selected.after, selected.revision]);
  const generation = fence.current, live = useRef({ controller, scope, owner, key }); live.current = { controller, scope, owner, key };
  const allowed = () => mounted.current && live.current.controller === controller && live.current.scope === scope
    && fence.current === generation && actor !== null && financeLinkActor(controller.getSnapshot()) === actor;
  const available = () => allowed() && !pending.current && selectionRef.current === selected;
  const current = read?.scope === scope && read.key === key ? read : null;
  const loading = Boolean(actor && (!current || current.busy));
  const dirty = selected.draft.from !== selected.applied.from || selected.draft.to !== selected.applied.to;
  const commit = (next: Selection) => { selectionRef.current = next; setSelection(next); };

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; pending.current?.abort(); pending.current = null; }; }, []);
  useEffect(() => {
    let previous = sessionKey(controller);
    return controller.subscribe(() => {
      const next = sessionKey(controller); if (next === previous) return; previous = next;
      fence.current++; pending.current?.abort(); pending.current = null; setRead(null); setValidation(''); setEpoch(value => value + 1);
    });
  }, [controller]);
  useEffect(() => {
    setValidation('');
    if (!allowed()) return;
    let query: FinanceMovementQuery;
    try { query = captureFinanceMovementQuery({ accountId, ...selected.applied, after: selected.after }); }
    catch { setRead({ scope, key, page: null, error: 'Não foi possível identificar a consulta da conta.', busy: false }); return; }
    const request = new AbortController(); pending.current = request;
    setRead({ scope, key, page: null, error: '', busy: true });
    const valid = () => allowed() && pending.current === request && !request.signal.aborted && live.current.key === key;
    void controller.finance(financeMovementPath(query), { method: 'GET', signal: request.signal }).then(raw => {
      if (!valid()) return; const page = financeMovementPage(raw, query); if (!valid()) return;
      setRead({ scope, key, page, error: '', busy: false });
    }).catch(error => { if (valid()) setRead({ scope, key, page: null, error: errorMessage(error), busy: false }); })
      .finally(() => { if (pending.current === request) pending.current = null; });
    return () => { request.abort(); if (pending.current === request) pending.current = null; };
  }, [scope, key, actor]);

  const apply = (clear = false) => {
    if (!available() || loading) return;
    try {
      const q = captureFinanceMovementQuery({ accountId, ...(clear ? { from: '', to: '' } : selected.draft), after: null });
      const period = { from: q.from, to: q.to };
      commit({ ...selected, draft: period, applied: period, after: null, cursors: [], revision: selected.revision + 1 }); setValidation('');
    } catch { setValidation('Confira as datas do período: use datas válidas entre 1900 e 2100, com início até o fim.'); }
  };
  const paginate = (next: boolean) => {
    if (!available() || loading || dirty || !current?.page) return;
    if (next && current.page.has_more) commit({ ...selected, after: current.page.next_cursor, cursors: [...selected.cursors, selected.after] });
    if (!next && selected.cursors.length) commit({ ...selected, after: selected.cursors.at(-1) ?? null, cursors: selected.cursors.slice(0, -1) });
  };
  if (!actor) return <p className="real-help">Consulta de movimentos indisponível nesta sessão.</p>;
  return <section className="finance-history finance-movement-history" aria-labelledby={`${id}-heading`} aria-busy={loading}>
    <h3 id={`${id}-heading`}>Movimentos da conta</h3>
    <p className="real-help">Movimentos registrados no FAGOO, pela data de lançamento. As datas inicial e final são inclusivas. A consulta é paginada e não representa conciliação bancária.</p>
    <form aria-label="Período dos movimentos" onSubmit={event => { event.preventDefault(); apply(); }}>
      <fieldset disabled={loading}><legend>Período de lançamento</legend><div className="finance-movement-filters">
        {(['from', 'to'] as const).map(field => <div className="form-field" key={field}><label htmlFor={`${id}-${field}`}>{field === 'from' ? 'De' : 'Até'}</label><input id={`${id}-${field}`} type="date" min="1900-01-01" max="2100-12-31" value={selected.draft[field]} onChange={event => {
          if (!available() || loading) return; commit({ ...selected, draft: { ...selected.draft, [field]: event.target.value } }); setValidation('');
        }} /></div>)}
        <button type="submit" className="secondary-button">Aplicar período</button><button type="button" className="text-button" onClick={() => apply(true)}>Limpar período</button>
      </div></fieldset>
    </form>
    {validation && <p role="alert" className="real-alert">{validation}</p>}
    {dirty && <p className="real-notice">Período alterado, ainda não aplicado. Os movimentos exibidos seguem o período aplicado abaixo.</p>}
    <p className="real-help">Período aplicado: {selected.applied.from ? financeDate(selected.applied.from) : 'sem data inicial'} até {selected.applied.to ? financeDate(selected.applied.to) : 'sem data final'}.</p>
    {loading && <p role="status">Consultando movimentos…</p>}
    {current?.error && <><p role="alert" className="real-alert">{current.error}</p><button type="button" className="secondary-button" disabled={loading || dirty} onClick={() => {
      if (available() && !loading && !dirty) commit({ ...selected, revision: selected.revision + 1 });
    }}>Tentar consultar o mesmo período</button></>}
    {current?.page && !loading && <><div className="table-scroll"><table className="data-table"><thead><tr><th>Data de lançamento</th><th>Operação</th><th className="numeric">Movimento</th><th>Observação</th></tr></thead><tbody>{current.page.items.map(item => <tr key={item.id}><td>{financeDate(item.posted_on)}</td><td>{FINANCE_KIND[item.kind]}</td><td className="numeric">{financeMoney(item.delta_cents)}</td><td>{item.note || '—'}</td></tr>)}</tbody></table></div>
      {!current.page.items.length && <p className="real-help">Nenhum movimento encontrado nesta consulta.</p>}
      <footer className="table-footer real-pagination"><span>Página {selected.cursors.length + 1} · {current.page.items.length} movimento(s) nesta página</span><div className="pagination">
        <button type="button" className="secondary-button" disabled={loading || dirty || !selected.cursors.length} onClick={() => paginate(false)}>Anterior</button>
        <button type="button" className="secondary-button" disabled={loading || dirty || !current.page.has_more} onClick={() => paginate(true)}>Próxima</button>
      </div></footer></>}
  </section>;
}
