import { useEffect, useRef, useState } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { invoiceRecord, type InvoiceRecord } from '../../../../packages/erp-domain/src/fiscal-invoice-contract.mjs';
import { FISCAL_BASE } from '../lib/fiscal-invoice-list-model';
import type { CatalogPage, CatalogRecord } from '../lib/catalog-model';

const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const actorOf = (controller: AccessController) => controller.getSnapshot?.()?.membership?.user_id ?? null;
const roleOf = (controller: AccessController) => controller.getSnapshot?.()?.membership?.role ?? '';
type Choice = { product_id: string | null; name: string | null };
type Command = { id: string; actor: string | null; body: { expected_version: number; items: { position: number; product_id: string | null }[] }; uncertain: boolean };

/** "Conciliar produtos" of an imported XML note: links each item to a product of the cadastro (or removes the link). */
export default function FiscalReconcilePanel({ controller, record, onSaved }: { controller: AccessController; record: InvoiceRecord; onSaved: (record: InvoiceRecord) => void }) {
  const [choices, setChoices] = useState<Record<number, Choice>>({}), [search, setSearch] = useState<{ position: number; query: string; results: CatalogRecord[] } | null>(null);
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const command = useRef<Command | null>(null), life = useRef(new AbortController()), actor = useRef(actorOf(controller));
  useEffect(() => { const current = life.current; return () => current.abort(); }, []);
  useEffect(() => {
    const current = search; if (!current || current.query.trim().length < 2) return;
    const request = new AbortController();
    const timer = setTimeout(() => { void controller.catalog(`/v1/cadastros/products?${new URLSearchParams({ limit: '25', q: current.query.trim() })}`, { signal: request.signal })
      .then(v => { if (!request.signal.aborted) setSearch(s => s && s.position === current.position && s.query === current.query ? { ...s, results: (v as CatalogPage).items ?? [] } : s); }).catch(() => undefined); }, 250);
    return () => { clearTimeout(timer); request.abort(); };
  }, [controller, search?.position, search?.query]);
  const changes = Object.entries(choices).map(([position, choice]) => ({ position: Number(position), product_id: choice.product_id }))
    .filter(change => (record.items[change.position - 1]?.product_id ?? null) !== change.product_id);
  const send = async () => {
    const op = command.current; if (!op || busy) return;
    if (actorOf(controller) !== op.actor || !['admin', 'fiscal'].includes(roleOf(controller))) { command.current = null; setUncertain(false); setError('A sessão ou o perfil mudou. Nada foi enviado.'); return; }
    setBusy(true); setError('');
    try {
      const value = await controller.fiscalInvoices(`${FISCAL_BASE}/${record.id}/conciliar`, { method: 'POST', body: { ...op.body, command_id: op.id }, signal: life.current.signal }) as { invoice: unknown };
      if (life.current.signal.aborted) return;
      const saved = invoiceRecord(value?.invoice);
      if (saved.id !== record.id || saved.version !== op.body.expected_version + 1 || op.body.items.some(i => (saved.items[i.position - 1]?.product_id ?? null) !== i.product_id)) throw new AccessError(502);
      command.current = null; setUncertain(false); setChoices({}); setNotice('Produtos conciliados.'); onSaved(saved);
    } catch (problem) {
      if (life.current.signal.aborted || aborted(problem)) return;
      if (!op.uncertain && problem instanceof AccessError && [400, 403, 404, 409].includes(problem.status)) { command.current = null; setError(problem.status === 409 ? 'A nota mudou em outra tela. Recarregue e confira.' : 'O servidor recusou a conciliação.'); }
      else { op.uncertain = true; setUncertain(true); setError('Não foi possível confirmar a conciliação. Use "Conferir resultado" para repetir o mesmo comando.'); }
    } finally { if (!life.current.signal.aborted) setBusy(false); }
  };
  const save = () => { if (!changes.length || command.current) return; command.current = { id: crypto.randomUUID(), actor: actor.current, body: { expected_version: record.version, items: changes }, uncertain: false }; void send(); };
  const locked = busy || Boolean(command.current);
  // Products chosen but not saved, or a reconciliation whose outcome is unknown, ask before leaving the note.
  useUnsavedChanges(changes.length > 0 || uncertain, busy);
  return <section className="fiscal-reconcile" aria-label="Conciliar produtos"><h3>Conciliar produtos</h3>
    <p className="real-help">Nota importada do XML: os itens ficam como no XML. Ligue cada item ao produto do cadastro para usar a nota nos relatórios de produtos.</p>
    <table className="data-table"><thead><tr><th>#</th><th>Item do XML</th><th>Código no XML</th><th>Produto do cadastro</th><th><span className="sr-only">Ações</span></th></tr></thead>
      <tbody>{record.items.map(item => { const choice = choices[item.position], current = choice ? choice.product_id : item.product_id ?? null;
        return <tr key={item.position}><td>{item.position}</td><td>{item.description}</td><td>{String(item.code ?? '—')}</td>
          <td>{choice ? choice.name ?? 'Sem produto' : current ? 'Ligado ao cadastro' : 'Sem produto'}
            {search?.position === item.position ? <span className="fiscal-contact-search"><input aria-label={`Pesquisar produto do item ${item.position}`} type="search" autoFocus disabled={locked} value={search.query} onChange={event => setSearch({ position: item.position, query: event.target.value, results: [] })} />
              {search.results.length > 0 && <ul className="fiscal-picker" role="listbox" aria-label="Produtos">{search.results.map(p => <li key={p.id}><button type="button" onClick={() => { setChoices(c => ({ ...c, [item.position]: { product_id: p.id, name: p.name } })); setSearch(null); }}>{p.name}{p.code ? ` · ${p.code}` : ''}</button></li>)}</ul>}</span> : null}</td>
          <td><button type="button" className="text-button" disabled={locked} onClick={() => setSearch({ position: item.position, query: String(item.description ?? '').slice(0, 30), results: [] })}>Escolher produto</button>
            {current && <button type="button" className="text-button" disabled={locked} onClick={() => setChoices(c => ({ ...c, [item.position]: { product_id: null, name: null } }))}>Desligar</button>}</td></tr>; })}</tbody></table>
    {error && <p className="real-alert" role="alert">{error}</p>}{notice && <p className="real-success" role="status">{notice}</p>}
    <div className="real-editor-actions">{uncertain ? <button type="button" className="primary-button" disabled={busy} onClick={() => void send()}>{busy ? 'Conferindo…' : 'Conferir resultado'}</button>
      : <button type="button" className="primary-button" disabled={!changes.length || locked} onClick={save}>{busy ? 'Salvando…' : 'Salvar conciliação'}</button>}</div>
  </section>;
}
