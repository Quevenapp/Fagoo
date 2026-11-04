import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { AccessController } from '../lib/real-access';
import type { CatalogEntity, CatalogPage, CatalogRecord } from '../lib/catalog-model';
import { EMPTY_POSITION_FILTERS, positionParams, stockPositionPage, type PositionFilters } from '../lib/stock-positions-model';
import { findProductByCode, productCodeMessage, productStockLabels, PRODUCT_SEARCH_PLACEHOLDER } from '../lib/document-editor-pickers';
import { Icon } from './Icon';
// Contatos (onda C): contact search through the contacts picker (seller scope, papel) and the Origin contact tools.
import { ContactPickerTools, type ContactTools } from './ContactPickerTools';
import { contactOptionsPath } from '../lib/contact-picker-model';
import './document-pickers.css';

type Controller = Pick<AccessController, 'catalog' | 'stockPositions' | 'getSnapshot'>;
const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const failureText = (error: unknown) => {
  const status = error && typeof error === 'object' && 'status' in error ? (error as { status: unknown }).status : null;
  return status === 403 ? 'Seu perfil não permite esta operação.' : status === 400 ? 'Confira os campos, valores e referências selecionadas.' : 'Não foi possível concluir a operação. Tente novamente.';
};
const QUEUE_LIMIT = 20;

/**
 * Busca de cadastro do editor de documentos. Enter nunca envia o formulário do documento.
 * Produtos: Enter com código/GTIN exato inclui o item (leitor de código de barras) e as opções
 * mostram o estoque físico do depósito do documento, sem bloquear a escolha.
 */
export function CatalogPicker({ controller, entity, label, selected, disabled, onSelect, onCode, stockWarehouse, onCreate, status, invalid, contactTools, productKind, placeholder }: {
  controller: Controller; entity: CatalogEntity; label: string; selected?: { id: string; name: string } | null; disabled?: boolean;
  onSelect: (record: CatalogRecord | null) => unknown;
  /** Products only: adds or increments an exact code/GTIN match and returns the message to show. */
  onCode?: (record: CatalogRecord) => string;
  /** Products only: undefined hides stock; null shows the total of every depósito. */
  stockWarehouse?: string | null;
  /** Opens the “Contato rápido” form with the current search text. */
  onCreate?: (query: string) => void;
  status?: string;
  /** Highlights the field after a Origin "O campo … é obrigatório" message. */
  invalid?: boolean;
  /** Contacts only: lupa/ENTER busca avançada, pessoas de contato, Editar Contato, histórico and Observações (contatos lane). */
  contactTools?: ContactTools;
  /** 202610200268, products only: the Tipo of the products listed (OS: Peças P, Serviços S). */
  productKind?: 'P' | 'S';
  /** 202610200268: the Origin text of the search (default "Pesquise por código, descrição ou GTIN"). */
  placeholder?: string;
}) {
  const [query, setQuery] = useState(''); const [rows, setRows] = useState<CatalogRecord[]>([]); const [loading, setLoading] = useState(!disabled); const [error, setError] = useState('');
  const [stock, setStock] = useState<{ key: string; labels: Map<string, string> | null } | null>(null);
  const [codeBusy, setCodeBusy] = useState(false); const [codeStatus, setCodeStatus] = useState(''); const [advanced, setAdvanced] = useState(false);
  const inputId = useRef(`picker-${crypto.randomUUID()}`).current;
  const mounted = useRef(true), queue = useRef<string[]>([]), draining = useRef(false), lookup = useRef<AbortController | null>(null);
  const live = useRef({ onCode, disabled }); live.current = { onCode, disabled };
  const stockKey = entity === 'products' && stockWarehouse !== undefined ? `stock:${stockWarehouse ?? 'all'}` : '';
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; queue.current = []; lookup.current?.abort(); lookup.current = null; }; }, []);
  useEffect(() => {
    if (disabled) return; const request = new AbortController(); const timer = setTimeout(() => {
      setLoading(true); setError(''); const params = new URLSearchParams({ limit: '25', active: 'true' }); if (query.trim()) params.set('q', query.trim()); if (entity === 'products' && productKind) params.set('kind', productKind);
      void controller.catalog(entity === 'contacts' ? contactOptionsPath({ q: query, role: contactTools?.role }) : `/v1/cadastros/${entity}?${params}`, { signal: request.signal }).then(value => { if (!request.signal.aborted) { setRows((value as CatalogPage).items); setLoading(false); } }).catch(failure => { if (!aborted(failure) && !request.signal.aborted) { setError(failureText(failure)); setLoading(false); } });
      if (!stockKey) return;
      // Same text, same active filter and the same id order as the product search, so this page covers its rows.
      const filters: PositionFilters = { ...EMPTY_POSITION_FILTERS, q: query.trim(), active: 'true', warehouse_id: stockWarehouse ?? '' }, actor = controller.getSnapshot().membership?.user_id;
      let path: string; try { path = `/v1/posicoes-estoque?${positionParams(filters)}`; } catch { setStock({ key: stockKey, labels: null }); return; }
      void controller.stockPositions(path, { signal: request.signal }).then(value => {
        if (request.signal.aborted || controller.getSnapshot().membership?.user_id !== actor) return;
        setStock({ key: stockKey, labels: productStockLabels(stockPositionPage(value, filters)) });
      }).catch(failure => { if (!aborted(failure) && !request.signal.aborted) setStock({ key: stockKey, labels: null }); });
    }, 250); return () => { clearTimeout(timer); request.abort(); };
  }, [controller, entity, query, disabled, stockKey, productKind]);
  const resolve = async (code: string) => {
    const request = new AbortController(), actor = controller.getSnapshot().membership?.user_id; lookup.current = request;
    try {
      const outcome = await findProductByCode((path, options) => controller.catalog(path, options), code, request.signal);
      if (request.signal.aborted || !mounted.current || controller.getSnapshot().membership?.user_id !== actor) return null;
      if (outcome.kind !== 'add') return productCodeMessage(code, outcome);
      const add = live.current.onCode;
      return add && !live.current.disabled ? add(outcome.row) : 'O documento não está liberado para incluir itens agora. Nenhum item foi incluído.';
    } catch (failure) {
      if (request.signal.aborted || aborted(failure) || !mounted.current) return null;
      return `Não foi possível conferir o código ${code.slice(0, 60)}. ${failureText(failure)}`;
    } finally { if (lookup.current === request) lookup.current = null; }
  };
  const drain = async () => {
    if (draining.current) return; draining.current = true; setCodeBusy(true);
    try { while (queue.current.length && mounted.current) { const message = await resolve(queue.current.shift()!); if (message !== null && mounted.current) setCodeStatus(message); } }
    finally { draining.current = false; if (mounted.current) setCodeBusy(false); }
  };
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // ↓ goes from the search to its results and opens them, so a record is chosen without the mouse.
    if (event.key === 'ArrowDown' && !event.altKey && !event.ctrlKey && !event.metaKey) {
      const list = (event.currentTarget as HTMLInputElement | undefined)?.parentElement?.querySelector?.('select');
      if (list && !list.disabled && rows.length) { event.preventDefault(); list.focus(); try { (list as HTMLSelectElement & { showPicker?: () => void }).showPicker?.(); } catch { /* The focused list still answers to the arrows. */ } }
      return;
    }
    if (event.key !== 'Enter' || (event.nativeEvent as { isComposing?: boolean } | undefined)?.isComposing) return;
    event.preventDefault(); // A scanner's Enter must never save the document.
    if (entity === 'contacts' && contactTools && !disabled) { setAdvanced(true); return; } // Origin: ENTER opens the busca avançada.
    const code = query.trim();
    if (!onCode || disabled || !code) return;
    if (queue.current.length >= QUEUE_LIMIT) { setCodeStatus('Aguarde a conferência dos códigos já lidos antes de ler outro.'); return; }
    setQuery(''); setCodeStatus(''); queue.current.push(code); void drain();
  };
  const option = (row: CatalogRecord) => { const stockLabel = stock?.key === stockKey ? stock.labels?.get(row.id) : undefined; return `${row.name}${row.code ? ` · ${row.code}` : ''}${stockLabel ? ` · ${stockLabel}` : ''}`; };
  const stockShown = Boolean(stockKey) && stock?.key === stockKey;
  return <div className="document-picker">
    <div className="document-picker-label"><label htmlFor={inputId}>{label}</label>{onCreate && <button type="button" className="document-picker-add" aria-label="Adicionar novo" title="Adicionar novo" disabled={disabled} onClick={() => { if (!disabled) onCreate(query.trim()); }}><Icon name="plus" size={12} /></button>}</div>
    <input id={inputId} type="search" maxLength={120} placeholder={placeholder ?? (entity === 'products' ? PRODUCT_SEARCH_PLACEHOLDER : 'Pesquisar cadastro ativo')} value={query} disabled={disabled} aria-busy={codeBusy || undefined} aria-invalid={invalid || undefined} onChange={event => setQuery(event.target.value)} onKeyDown={keyDown} />
    <select aria-label={`Selecionar ${label.toLowerCase()}`} aria-invalid={invalid || undefined} disabled={disabled || loading} value={selected?.id || ''} onChange={event => { const found = rows.find(row => row.id === event.target.value); if (found) onSelect(found); else if (!event.target.value) onSelect(null); }}><option value="">{loading ? 'Pesquisando…' : 'Selecione um cadastro'}</option>{selected && !rows.some(row => row.id === selected.id) && <option value={selected.id}>{selected.name}</option>}{rows.map(row => <option key={row.id} value={row.id}>{option(row)}</option>)}</select>
    {entity === 'contacts' && contactTools && <ContactPickerTools controller={controller} contact={selected} tools={contactTools} disabled={disabled} searchOpen={advanced} searchText={query} onSearch={() => setAdvanced(true)} onSearchClose={() => setAdvanced(false)} onSelect={onSelect} />}
    {error && <small role="alert">{error}</small>}
    {stockShown && (stock?.labels ? <small>{stockWarehouse ? 'Estoque físico no depósito do documento. A escolha não depende do saldo.' : 'Estoque físico somado de todos os depósitos, porque o documento não tem depósito previsto. A escolha não depende do saldo.'}</small> : <small>Estoque não consultado. A escolha do produto continua liberada.</small>)}
    {onCode && <small>Leitor de código de barras: digite ou leia o código ou GTIN e tecle Enter.</small>}
    {codeBusy && <small role="status">Conferindo código…</small>}
    {codeStatus && <small role="status">{codeStatus}</small>}
    {status && <small role="status">{status}</small>}
    {!loading && !error && !rows.length && !disabled && (entity === 'contacts' && onCreate && query.trim()
      // Origin: a typed name without cadastro offers the "Contato rápido" already filled with it.
      ? <small className="document-picker-unregistered" role="status"><strong>Contato não cadastrado</strong> — <button type="button" className="text-button" onClick={() => { if (!disabled) onCreate(query.trim()); }}>Para completar os dados clique aqui</button></small>
      : <small>{onCreate ? 'Nenhum cadastro ativo encontrado. Use “Adicionar novo” (+) para cadastrar.' : 'Nenhum cadastro ativo encontrado. Cadastre-o em Cadastros da empresa.'}</small>)}
  </div>;
}
