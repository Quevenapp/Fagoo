import { useEffect, useRef, useState } from 'react';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { AccessError, type AccessController } from '../lib/real-access';
import { CATEGORY, EMPTY, MAX_LINKS, STATES, TYPE, hours, priceListData, validity, type Draft, type Link, type ListCategory, type ListType, type PriceList } from '../lib/price-list-model';
import { SellerPicker } from './SellerPicker';
import { Icon } from './Icon';
import { Modal } from './Modal';
import { aborted, errorText, knownFailure } from './catalog-shared';
import './product-registry.css';

// Assistente "Lista de preços" do Origin (Incluir lista e "Criar lista de preço" da listagem de produtos, com ou sem seleção):
// categoria, vínculos, como montar a lista, regra, nome e validade e o Resumo; grava tudo num único comando no fim (com os
// produtos da seleção) e repete o mesmo comando em "Conferir resultado". "Vincular a uma lista" acrescenta os produtos
// selecionados a uma lista existente, com a versão da lista. A categoria Loja fica fora do escopo do Brufap.
type Controller = AccessController;
const CARDS: ListCategory[] = ['contact', 'seller', 'payment_method', 'region', 'other'];
const STEPS = ['Categoria', 'Vínculos', 'Montagem', 'Regra', 'Nome e validade', 'Resumo'] as const;
type Step = typeof STEPS[number];
type Option = { id: string; name: string; code?: string | null };

/** Formas de pagamento ativas (Cadastros > Formas de pagamento), para a categoria Forma de pagamento. */
function usePaymentMethods(controller: Controller, enabled: boolean) {
  const [state, setState] = useState<{ items: Link[] | null; error: string }>({ items: null, error: '' });
  useEffect(() => {
    if (!enabled) return;
    const request = new AbortController();
    void Promise.resolve().then(() => controller.catalog('/v1/cadastros/formas-pagamento?situation=active&size=100', { signal: request.signal })).then(value => {
      const items = (value as { items?: { id?: unknown; description?: unknown }[] }).items;
      if (request.signal.aborted) return;
      if (!Array.isArray(items)) throw new AccessError(502);
      setState({ items: items.filter(item => typeof item?.id === 'string' && typeof item.description === 'string').map(item => ({ id: item.id as string, name: item.description as string })), error: '' });
    }).catch(failure => { if (!request.signal.aborted && !aborted(failure)) setState({ items: null, error: failure instanceof AccessError && failure.status === 403 ? 'Seu perfil não consulta as formas de pagamento.' : 'Não foi possível carregar as formas de pagamento.' }); });
    return () => request.abort();
  }, [controller, enabled]);
  return state;
}

/** Vínculos da lista conforme a categoria: contatos e vendedores (até 30), formas de pagamento (até 30) e UFs. */
export function PriceListLinks({ controller, draft, set, locked }: { controller: Controller; draft: Draft; set: (patch: Partial<Draft>) => void; locked: boolean }) {
  const [query, setQuery] = useState(''), [options, setOptions] = useState<Option[]>([]);
  const methods = usePaymentMethods(controller, draft.category === 'payment_method');
  useEffect(() => {
    if (draft.category !== 'contact' || !query.trim()) { setOptions([]); return; }
    const request = new AbortController();
    const timer = setTimeout(() => void Promise.resolve().then(() => controller.catalog(`/v1/cadastros/contacts?${new URLSearchParams({ limit: '10', q: query.trim(), active: 'true' })}`, { signal: request.signal })).then(value => {
      const found = (value as { items?: Option[] }).items;
      if (!request.signal.aborted && Array.isArray(found)) setOptions(found.filter(item => typeof item?.id === 'string' && typeof item.name === 'string').map(item => ({ id: item.id, name: item.name, code: item.code ?? null })));
    }).catch(() => undefined), 250);
    return () => { clearTimeout(timer); request.abort(); };
  }, [controller, draft.category, query]);
  const chips = (key: 'contacts' | 'sellers' | 'payment_methods') => draft[key].map(item => <span key={item.id} className="product-tag">{item.name}{!locked && <button type="button" className="icon-button" aria-label={`Retirar ${item.name}`} onClick={() => set({ [key]: draft[key].filter(row => row.id !== item.id) } as Partial<Draft>)}><Icon name="xmark" size={9} /></button>}</span>);
  if (draft.category === 'contact') return <div className="form-field real-field-wide"><label htmlFor="price-list-contact-search">Contatos (máx. {MAX_LINKS})</label>
    <div className="product-tags">{chips('contacts')}</div>
    {!locked && draft.contacts.length < MAX_LINKS && <input id="price-list-contact-search" value={query} maxLength={120} autoComplete="off" placeholder="Inserir contato: pesquise pelo nome" onChange={event => setQuery(event.target.value)} />}
    {options.length > 0 && <ul className="product-options" role="listbox" aria-label="Contatos encontrados">{options.map(option => <li key={option.id}><button type="button" role="option" aria-selected={false}
      onClick={() => { if (!draft.contacts.some(item => item.id === option.id)) set({ contacts: [...draft.contacts, { id: option.id, name: option.name }].slice(0, MAX_LINKS) }); setQuery(''); setOptions([]); }}>{option.name}{option.code ? ` (${option.code})` : ''}</button></li>)}</ul>}</div>;
  if (draft.category === 'seller') return <div className="form-field real-field-wide"><span className="product-field-label">Vendedores (máx. {MAX_LINKS})</span>
    <div className="product-tags">{chips('sellers')}</div>
    {!locked && draft.sellers.length < MAX_LINKS && <SellerPicker controller={controller} id="price-list-seller" label="Inserir vendedor" value={null} onChange={seller => { if (seller && !draft.sellers.some(item => item.id === seller.id)) set({ sellers: [...draft.sellers, { id: seller.id, name: seller.name }].slice(0, MAX_LINKS) }); }} />}</div>;
  if (draft.category === 'payment_method') return <fieldset className="form-field real-field-wide" disabled={locked}><legend>Formas de Pagamento (máx. {MAX_LINKS})</legend>
    {methods.error ? <p className="real-help">{methods.error}</p> : !methods.items ? <p role="status">Carregando as formas de pagamento…</p> : !methods.items.length ? <p className="real-help">Nenhuma forma de pagamento ativa cadastrada.</p>
      : <div className="product-tags">{methods.items.map(method => <label key={method.id} className="product-check"><input type="checkbox" checked={draft.payment_methods.some(item => item.id === method.id)} disabled={!draft.payment_methods.some(item => item.id === method.id) && draft.payment_methods.length >= MAX_LINKS}
        onChange={event => set({ payment_methods: event.target.checked ? [...draft.payment_methods, method] : draft.payment_methods.filter(item => item.id !== method.id) })} />{method.name}</label>)}</div>}
    {draft.payment_methods.filter(item => !methods.items?.some(method => method.id === item.id)).length > 0 && <div className="product-tags">{chips('payment_methods')}</div>}</fieldset>;
  if (draft.category === 'region') return <fieldset className="form-field real-field-wide" disabled={locked}><legend>Selecione as UFs</legend><div className="product-tags">{STATES.map(state => <label key={state} className="product-check"><input type="checkbox" checked={draft.regions.includes(state)} onChange={event => set({ regions: event.target.checked ? [...draft.regions, state].sort() : draft.regions.filter(item => item !== state) })} />{state}</label>)}</div></fieldset>;
  return null;
}

type Saving = { command: string; body: Record<string, unknown>; uncertain: boolean; busy: boolean };
export function PriceListWizard({ controller, products = [], onClose, onSaved }: { controller: Controller; products?: readonly Link[]; onClose: () => void; onSaved: (list: PriceList) => void }) {
  const [draft, setDraft] = useState<Draft>(EMPTY), [step, setStep] = useState<Step>('Categoria'), [error, setError] = useState(''), [saving, setSaving] = useState<Saving | null>(null);
  const request = useRef<AbortController | null>(null), actor = useRef(controller.getSnapshot().membership?.user_id);
  const dirty = JSON.stringify(draft) !== JSON.stringify(EMPTY);
  const guard = useUnsavedChanges(dirty || Boolean(saving?.uncertain), Boolean(saving?.busy || saving?.uncertain));
  useEffect(() => () => request.current?.abort(), []);
  const set = (patch: Partial<Draft>) => { if (saving?.busy || saving?.uncertain) return; setDraft(current => ({ ...current, ...patch })); setError(''); };
  const steps = STEPS.filter(item => !(item === 'Vínculos' && draft.category === 'other') && !(item === 'Regra' && draft.list_type === 'custom'));
  const index = steps.indexOf(step);
  const check = (target: Step): string => {
    if (target === 'Vínculos' && draft.category === 'contact' && !draft.contacts.length) return 'Inclua ao menos um contato.';
    if (target === 'Vínculos' && draft.category === 'seller' && !draft.sellers.length) return 'Inclua ao menos um vendedor.';
    if (target === 'Vínculos' && draft.category === 'payment_method' && !draft.payment_methods.length) return 'Marque ao menos uma forma de pagamento.';
    if (target === 'Vínculos' && draft.category === 'region' && !draft.regions.length) return 'Selecione ao menos uma UF.';
    if (target === 'Regra') { const result = priceListData({ ...draft, name: draft.name || 'x' }); if (typeof result === 'string' && /fator|desconto/i.test(result)) return result; }
    if (target === 'Nome e validade') { const result = priceListData(draft); if (typeof result === 'string') return result; }
    return '';
  };
  const next = () => { const problem = check(step); if (problem) { setError(problem); return; } setError(''); setStep(steps[Math.min(index + 1, steps.length - 1)]); };
  const back = () => { setError(''); setStep(steps[Math.max(index - 1, 0)]); };
  const send = async (operation: Saving) => {
    if (request.current) return;
    const signal = new AbortController(); request.current = signal; setSaving({ ...operation, busy: true }); setError('');
    try {
      const result = await controller.catalog('/v1/cadastros/listas-precos', { method: 'POST', body: { command_id: operation.command, data: operation.body }, signal: signal.signal }) as { saved?: boolean; reason?: string; list?: PriceList };
      if (signal.signal.aborted || controller.getSnapshot().membership?.user_id !== actor.current) return;
      if (!result.saved || !result.list) { setSaving(null); setStep('Nome e validade'); setError('Já existe uma lista de preços com este nome.'); return; }
      setSaving(null); onSaved(result.list);
    } catch (failure) {
      if (signal.signal.aborted) return;
      const known = !operation.uncertain && !aborted(failure) && knownFailure(failure);
      setSaving(known ? null : { ...operation, uncertain: true, busy: false });
      setError(known ? errorText(failure) : 'Não foi possível confirmar a gravação. Use “Conferir resultado” para repetir a mesma operação sem duplicar.');
    } finally { if (request.current === signal) request.current = null; }
  };
  const save = () => {
    const body = priceListData(draft, products.map(item => item.id));
    if (typeof body === 'string') { setError(body); return; }
    void send({ command: crypto.randomUUID(), body, uncertain: false, busy: false });
  };
  const locked = Boolean(saving?.busy || saving?.uncertain);
  const card = (value: ListCategory) => <button key={value} type="button" role="radio" aria-checked={draft.category === value} className={`price-list-card${draft.category === value ? ' is-active' : ''}`} disabled={locked}
    onClick={() => set({ category: value, contacts: [], sellers: [], payment_methods: [], regions: [] })}>{CATEGORY[value]}</button>;
  const choice = <T extends string>(name: string, value: T, options: [T, string][], change: (value: T) => void) => <div className="product-inline" role="radiogroup" aria-label={name}>{options.map(([option, label]) =>
    <label key={option} className="product-check"><input type="radio" name={name} checked={value === option} disabled={locked} onChange={() => change(option)} />{label}</label>)}</div>;
  const summary = <dl className="price-list-summary"><div><dt>Nome da lista</dt><dd>{draft.name || '—'}</dd></div><div><dt>Tipo de lista</dt><dd>{TYPE[draft.list_type]}</dd></div>
    <div><dt>Categoria</dt><dd>{CATEGORY[draft.category]}</dd></div><div><dt>Validade</dt><dd>{validity({ starts_on: draft.starts_on || null, ends_on: draft.ends_on || null })}</dd></div>
    <div><dt>Horário</dt><dd>{hours({ considers_datetime: draft.considers_datetime, start_time: draft.start_time || null, end_time: draft.end_time || null })}</dd></div>
    {products.length > 0 && <div><dt>Produtos</dt><dd>{products.length}</dd></div>}</dl>;
  return <Modal title="Lista de preços" onClose={() => { if (!locked) guard.confirmLeave(onClose); }} actions={<>
    <button type="button" className="secondary-button" disabled={locked} onClick={() => guard.confirmLeave(onClose)}>Cancelar</button>
    {index > 0 && <button type="button" className="secondary-button" disabled={locked} onClick={back}>Voltar</button>}
    {step !== 'Resumo' ? <button type="button" className="primary-button" disabled={locked} onClick={next}>Avançar</button>
      : saving?.uncertain ? <button type="button" className="primary-button" disabled={saving.busy} onClick={() => void send(saving)}>Conferir resultado</button>
      : <button type="button" className="primary-button" disabled={locked} onClick={save}>{saving?.busy ? 'Salvando…' : 'Salvar'}</button>}</>}>
    <p><strong>Vamos configurar a lista de preços!</strong> Etapa {index + 1} de {steps.length}: {step}.</p>
    {products.length > 0 && <p className="real-notice" role="status">Criando lista de preços a partir da seleção de {products.length} produto(s).</p>}
    {step === 'Categoria' && <div className="form-field real-field-wide"><span className="product-field-label">Qual categoria se aplicaria a lista?</span><div className="price-list-cards" role="radiogroup" aria-label="Categoria">{CARDS.map(card)}</div>
      <small className="real-help">A categoria Loja (multilojas) não faz parte do FAGOO.</small></div>}
    {step === 'Vínculos' && <PriceListLinks controller={controller} draft={draft} set={set} locked={locked} />}
    {step === 'Montagem' && <div className="form-field real-field-wide"><span className="product-field-label">Como gostaria de montar a lista?</span>
      {choice<ListType>('price-list-build', draft.list_type, [['rates', 'Percentual/valor'], ['period', 'Por período'], ['custom', 'Customizada']], value => set({ list_type: value, ...(value === 'custom' ? { factor: '' } : {}) }))}
      <small className="real-help">{draft.list_type === 'custom' ? 'Na lista customizada o preço de cada produto é informado depois, na própria lista.' : draft.list_type === 'period' ? 'A lista por período vale só entre as datas de validade.' : 'O fator é aplicado sobre o preço de venda de cada produto da lista.'}</small></div>}
    {step === 'Regra' && <div className="real-editor-fields">
      <div className="form-field"><span className="product-field-label">Qual regra deseja aplicar?</span>{choice<Draft['factor_unit']>('price-list-unit', draft.factor_unit, [['percent', 'Porcentagem'], ['amount', 'Valor em R$']], value => set({ factor_unit: value }))}</div>
      <div className="form-field"><label htmlFor="price-list-wizard-factor">{draft.factor_unit === 'percent' ? 'Qual porcentagem deseja aplicar?' : 'Qual valor deseja aplicar?'} *</label><input id="price-list-wizard-factor" value={draft.factor} inputMode="decimal" maxLength={17} disabled={locked} onChange={event => set({ factor: event.target.value })} /></div>
      <div className="form-field"><span className="product-field-label">Desconto ou acréscimo?</span>{choice<Draft['direction']>('price-list-direction-wizard', draft.direction, [['increase', 'Acréscimo'], ['discount', 'Desconto']], value => set({ direction: value }))}</div></div>}
    {step === 'Nome e validade' && <div className="real-editor-fields">
      <div className="form-field real-field-wide"><label htmlFor="price-list-wizard-name">Escolha um nome para a lista *</label><input id="price-list-wizard-name" value={draft.name} maxLength={120} disabled={locked} onChange={event => set({ name: event.target.value })} /></div>
      <div className="form-field real-field-wide"><label className="product-check"><input type="checkbox" checked={draft.considers_datetime} disabled={locked} onChange={event => set({ considers_datetime: event.target.checked, ...(event.target.checked ? {} : { start_time: '', end_time: '' }) })} />Considerar data e hora na lista de preços</label></div>
      <div className="form-field"><label htmlFor="price-list-wizard-start">Data de início{draft.list_type === 'period' ? ' *' : ''}</label><input id="price-list-wizard-start" type="date" value={draft.starts_on} disabled={locked} onChange={event => set({ starts_on: event.target.value })} /></div>
      <div className="form-field"><label htmlFor="price-list-wizard-end">Data de término</label><input id="price-list-wizard-end" type="date" value={draft.ends_on} disabled={locked} onChange={event => set({ ends_on: event.target.value })} /></div>
      {draft.considers_datetime && <><div className="form-field"><label htmlFor="price-list-wizard-start-time">Hora de início</label><input id="price-list-wizard-start-time" type="time" value={draft.start_time} disabled={locked} onChange={event => set({ start_time: event.target.value })} /></div>
        <div className="form-field"><label htmlFor="price-list-wizard-end-time">Hora de término</label><input id="price-list-wizard-end-time" type="time" value={draft.end_time} disabled={locked} onChange={event => set({ end_time: event.target.value })} /></div></>}</div>}
    {step === 'Resumo' && <><h3>Resumo</h3>{summary}</>}
    {error && <p className="real-alert" role="alert">{error}</p>}
  </Modal>;
}

/** "Vincular a uma lista": acrescenta os produtos selecionados a uma lista existente (um comando, com a versão da lista). */
export function LinkToPriceList({ controller, products, onClose, onDone }: { controller: Controller; products: readonly Link[]; onClose: () => void; onDone: (list: PriceList) => void }) {
  const [lists, setLists] = useState<PriceList[] | null>(null), [chosen, setChosen] = useState(''), [error, setError] = useState(''), [reload, setReload] = useState(0);
  const [saving, setSaving] = useState<{ command: string; list: string; version: number; uncertain: boolean; busy: boolean } | null>(null);
  const request = useRef<AbortController | null>(null), actor = useRef(controller.getSnapshot().membership?.user_id);
  useUnsavedChanges(Boolean(saving?.uncertain), Boolean(saving?.busy || saving?.uncertain));
  useEffect(() => {
    const signal = new AbortController();
    void Promise.resolve().then(() => controller.catalog('/v1/cadastros/listas-precos', { signal: signal.signal })).then(value => {
      const items = (value as { items?: PriceList[] }).items;
      if (!signal.signal.aborted) { if (!Array.isArray(items)) throw new AccessError(502); setLists(items); }
    }).catch(failure => { if (!signal.signal.aborted && !aborted(failure)) setError(errorText(failure)); });
    return () => signal.abort();
  }, [controller, reload]);
  useEffect(() => () => request.current?.abort(), []);
  const send = async (operation: NonNullable<typeof saving>) => {
    if (request.current) return;
    const signal = new AbortController(); request.current = signal; setSaving({ ...operation, busy: true }); setError('');
    try {
      const result = await controller.catalog(`/v1/cadastros/listas-precos/${operation.list}/itens`, { method: 'POST', body: { command_id: operation.command, expected_version: operation.version, change: { add: products.map(item => item.id) } }, signal: signal.signal }) as { saved?: boolean; list?: PriceList };
      if (signal.signal.aborted || controller.getSnapshot().membership?.user_id !== actor.current) return;
      if (!result.saved || result.list?.id !== operation.list) throw new AccessError(502);
      setSaving(null); onDone(result.list);
    } catch (failure) {
      if (signal.signal.aborted) return;
      const known = !operation.uncertain && !aborted(failure) && knownFailure(failure);
      setSaving(known ? null : { ...operation, uncertain: true, busy: false });
      setError(known ? failure instanceof AccessError && failure.status === 409 ? 'A lista foi alterada por outra operação. Escolha a lista de novo.' : failure instanceof AccessError && failure.status === 400 ? 'Algum produto selecionado não pode entrar na lista (excluído) ou a lista passaria de 15.000 produtos.' : errorText(failure)
        : 'Não foi possível confirmar a inclusão. Use “Conferir resultado” para repetir a mesma operação sem duplicar.');
      if (known && failure instanceof AccessError && failure.status === 409) { setLists(null); setChosen(''); setReload(value => value + 1); }
    } finally { if (request.current === signal) request.current = null; }
  };
  const list = lists?.find(item => item.id === chosen);
  const locked = Boolean(saving?.busy || saving?.uncertain);
  return <Modal title="Vincular a uma lista" onClose={() => { if (!locked) onClose(); }} actions={<><button type="button" className="secondary-button" disabled={locked} onClick={onClose}>Cancelar</button>
    {saving?.uncertain ? <button type="button" className="primary-button" disabled={saving.busy} onClick={() => void send(saving)}>Conferir resultado</button>
      : <button type="button" className="primary-button" disabled={!list || locked} onClick={() => list && void send({ command: crypto.randomUUID(), list: list.id, version: list.version, uncertain: false, busy: false })}>{saving?.busy ? 'Vinculando…' : 'Vincular'}</button>}</>}>
    <p>Vincular {products.length} produto(s) selecionado(s) a uma lista de preços existente. Os produtos que já estão na lista continuam como estão.</p>
    {!lists && !error ? <p role="status">Carregando as listas de preços…</p> : lists && !lists.length ? <p className="real-help">Nenhuma lista de preços cadastrada. Use “Criar lista de preço”.</p>
      : lists && <div className="form-field"><label htmlFor="price-list-link">Lista de preços</label><select id="price-list-link" value={chosen} disabled={locked} onChange={event => setChosen(event.target.value)}><option value="">Selecione uma lista</option>
        {lists.map(item => <option key={item.id} value={item.id}>{item.name} ({item.rule})</option>)}</select></div>}
    {list && <p className="real-help">{TYPE[list.list_type]} · {list.products} produto(s) na lista.</p>}
    {error && <p className="real-alert" role="alert">{error}</p>}
  </Modal>;
}
