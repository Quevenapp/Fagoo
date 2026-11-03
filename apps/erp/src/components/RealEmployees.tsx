import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import { badgeClass, brDate } from '../lib/origin-list';
import { UF_SELECT, emailListValid, isoDateValid, saoPauloToday } from '../lib/contact-form-model';
import { useUnsavedForm } from '../hooks/useUnsavedChanges';
import NativeListLayout from './NativeListLayout';
import { AppliedChips, OriginPagination, RowMenu } from './OriginList';
import { Icon } from './Icon';
import { CONFLICT_TEXT, aborted, errorText } from './catalog-shared';
import { contactRefusalText } from './contact-errors';
// 202610200272: the Foto of the funcionário (same private storage and proxy as the Foto of the contato).
import { ContactPhoto } from './ContactFiles';
import './contacts.css';

// Cadastros > Funcionários (Origin FL-01, FF-01, FF-03 e FF-04). Somente administrador: dados pessoais e salário. As
// colunas do Origin não foram capturadas (a conta não tinha funcionários): Nome, CPF, Cargo, Admissão e Situação.
// Pagamentos de salário, Pix recorrente e "Alteração de salário" ficam fora (Origin Conta / decisão do dono).
type Employee = { id: string; version: number; name: string; cpf: string; job_title: string | null; admission_date: string | null; situation: 'ativo' | 'desligado' };
type Page = { items: Employee[]; page: number; size: number; total: number };
const TEXT: readonly [string, string, number, string?][] = [['rg', 'RG', 20], ['job_title', 'Cargo', 100, 'Cargo ou função que o funcionário exerce'], ['pis', 'PIS/PASEP', 14], ['ctps', 'CTPS', 30], ['code', 'Código', 30]];
const CONTACT: readonly [string, string, number, string?][] = [['phone', 'Fone', 40], ['mobile', 'Celular', 40], ['email', 'Email', 254], ['emergency_phone', 'Telefone emergencial', 40, 'Telefone de parente ou pessoa próxima']];
const ADDRESS: readonly [string, string, number][] = [['postal_code', 'CEP', 20], ['city', 'Cidade', 100], ['district', 'Bairro', 100], ['street', 'Endereço', 200], ['number', 'Número', 30], ['complement', 'Complemento', 200]];
const KEYS = ['name', 'cpf', 'rg', 'job_title', 'pis', 'ctps', 'code', 'phone', 'mobile', 'email', 'emergency_phone', 'postal_code', 'state', 'city', 'district', 'street', 'number', 'complement', 'birth_date', 'admission_date', 'salary', 'notes'];
const cpfMask = (cpf: string) => cpf.length === 11 ? `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}` : cpf;
function validCpf(value: string) {
  if (!/^\d{11}$/.test(value) || /^(\d)\1{10}$/.test(value)) return false;
  for (const n of [9, 10]) { let sum = 0; for (let i = 0; i < n; i++) sum += Number(value[i]) * (n + 1 - i); let digit = (sum * 10) % 11; if (digit === 10) digit = 0; if (digit !== Number(value[n])) return false; }
  return true;
}

export default function RealEmployees({ controller }: { controller: AccessController }) {
  const [editing, setEditing] = useState<{ id: string | null; version: number } | null>(null), [notice, setNotice] = useState('');
  const [situation, setSituation] = useState('ativos'), [draft, setDraft] = useState('ativos'), [query, setQuery] = useState(''), [queryDraft, setQueryDraft] = useState('');
  const [pageNumber, setPageNumber] = useState(1), [reload, setReload] = useState(0), [page, setPage] = useState<Page | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState(''), [rowMenu, setRowMenu] = useState<string | null>(null);
  useEffect(() => { setPageNumber(1); }, [situation, query]);
  useEffect(() => {
    if (editing) return;
    const request = new AbortController(); setLoading(true); setError('');
    const params = new URLSearchParams({ page: String(pageNumber), size: '100' }); if (situation !== 'ativos') params.set('situation', situation); if (query) params.set('q', query);
    void controller.catalog(`/v1/cadastros/funcionarios?${params}`, { signal: request.signal }).then(value => {
      if (request.signal.aborted) return; const result = value as Page; if (!Array.isArray(result.items)) throw new AccessError(502); setPage(result); setLoading(false);
    }).catch(failure => { if (!request.signal.aborted && !aborted(failure)) { setError(errorText(failure)); setLoading(false); } });
    return () => request.abort();
  }, [controller, situation, query, pageNumber, reload, editing]);
  if (editing) return <EmployeeEditor key={`${editing.id ?? 'new'}:${editing.version}`} controller={controller} id={editing.id} onClose={() => setEditing(null)} onSaved={(id, version) => { setNotice('Funcionário salvo.'); setEditing({ id, version }); }} />;
  const label = { todas: 'Todas', ativos: 'Ativos', desligados: 'Desligados' } as Record<string, string>;
  return <section className="contact-aux">
    <header className="real-heading catalog-heading"><div className="catalog-title"><h1>Funcionários</h1></div><div className="catalog-heading-actions"><button type="button" className="primary-button" onClick={() => setEditing({ id: null, version: 0 })}><Icon name="plus" size={12} />Incluir cadastro</button></div></header>
    <p className="real-help">Somente administradores. Os pagamentos de salário do Origin (Origin Conta) não existem no FAGOO.</p>
    {notice && <p className="real-success" role="status">{notice}</p>}
    {error && <p className="real-alert" role="alert">{error}<button type="button" className="text-button" onClick={() => setReload(n => n + 1)}>Tentar novamente</button></p>}
    <form onSubmit={(event: FormEvent) => { event.preventDefault(); setSituation(draft); setQuery(queryDraft.trim()); }} aria-label="Filtros dos funcionários"><NativeListLayout filters={<>
      <div className="form-field"><label htmlFor="employee-situation-filter">Situação</label><select id="employee-situation-filter" value={draft} onChange={event => setDraft(event.target.value)}><option value="todas">Todas</option><option value="ativos">Ativos</option><option value="desligados">Desligados</option></select></div>
      <button type="submit" className="primary-button">Filtrar</button></>} actions={<div className="native-list-summary"><h3>Informações</h3><dl className="native-list-stat"><dt>Quantidade de funcionários</dt><dd>{page ? page.total : '—'}</dd></dl></div>}>
      <div className="native-list-toolbar"><div className="form-field"><label htmlFor="employee-search">Pesquisar</label><input id="employee-search" type="search" maxLength={120} placeholder="Pesquisar" value={queryDraft} onChange={event => setQueryDraft(event.target.value)} /></div>
        <button type="submit" className="secondary-button" title="Pesquisar" aria-label="Pesquisar"><Icon name="magnifying-glass" size={14} /></button></div>
      <AppliedChips chips={[...(situation !== 'todas' ? [{ label: `Situação: ${label[situation]}`, onRemove: () => { setSituation('todas'); setDraft('todas'); } }] : []), ...(query ? [{ label: `Pesquisa: ${query}`, onRemove: () => { setQuery(''); setQueryDraft(''); } }] : [])]}
        onClear={() => { setSituation('todas'); setDraft('todas'); setQuery(''); setQueryDraft(''); }} />
      {loading && <p role="status">Obtendo funcionários...</p>}
      {page && !page.total && !query && situation !== 'desligados' ? <div className="origin-empty"><span><Icon name="users" size={22} /></span><h2>Nenhum item registrado</h2><p>Ainda não existem cadastros no seu sistema, comece agora mesmo</p><button type="button" className="primary-button" onClick={() => setEditing({ id: null, version: 0 })}>Incluir cadastro</button></div>
        : page && <><div className="table-scroll"><table className="data-table real-table origin-table contact-aux-table"><thead><tr><th scope="col">Nome</th><th scope="col">CPF</th><th scope="col">Cargo</th><th scope="col">Admissão</th><th scope="col">Situação</th><th scope="col" className="row-actions"><span className="real-sr-only">Ações</span></th></tr></thead>
          <tbody>{page.items.map(item => <tr key={item.id} onClick={() => setEditing({ id: item.id, version: item.version })}><td><button type="button" className="text-button record-link" onClick={event => { event.stopPropagation?.(); setEditing({ id: item.id, version: item.version }); }}>{item.name}</button></td>
            <td>{cpfMask(item.cpf)}</td><td>{item.job_title ?? '—'}</td><td>{item.admission_date ? brDate(item.admission_date) : '—'}</td><td><span className={badgeClass(item.situation === 'ativo' ? 'Ativo' : 'Inativo')}>{item.situation === 'ativo' ? 'Ativo' : 'Desligado'}</span></td>
            <td className="row-actions" onClick={event => event.stopPropagation()}><RowMenu label={item.name} open={rowMenu === item.id} onToggle={() => setRowMenu(rowMenu === item.id ? null : item.id)} items={[{ label: 'Editar', icon: 'pen-to-square', onClick: () => setEditing({ id: item.id, version: item.version }) }]} /></td></tr>)}</tbody></table></div>
          {!page.items.length && <p className="real-help">Nenhum funcionário encontrado.</p>}
          {page.total > 0 && <OriginPagination page={page.page} pages={Math.max(1, Math.ceil(page.total / page.size))} size={page.size} total={page.total} onPage={setPageNumber} />}</>}
    </NativeListLayout></form>
  </section>;
}

function EmployeeEditor({ controller, id, onClose, onSaved }: { controller: AccessController; id: string | null; onClose: () => void; onSaved: (id: string, version: number) => void }) {
  const [record, setRecord] = useState<(Record<string, string | null> & { id: string; version: number; situation: string }) | null>(null), [loadError, setLoadError] = useState('');
  useEffect(() => {
    if (!id) return; const request = new AbortController();
    void controller.catalog(`/v1/cadastros/funcionarios/${id}`, { signal: request.signal }).then(value => { if (request.signal.aborted) return; const item = (value as { item?: typeof record }).item; if (!item || item.id !== id) throw new AccessError(502); setRecord(item); })
      .catch(failure => { if (!request.signal.aborted && !aborted(failure)) setLoadError(errorText(failure)); });
    return () => request.abort();
  }, [controller, id]);
  if (id && !record) return <section className="real-editor"><h2>Funcionário</h2>{loadError ? <p className="real-alert" role="alert">{loadError}<button type="button" className="text-button" onClick={onClose}>Voltar à listagem</button></p> : <p role="status">Carregando funcionário…</p>}</section>;
  return <EmployeeForm controller={controller} record={record} onClose={onClose} onSaved={onSaved} />;
}

function EmployeeForm({ controller, record, onClose, onSaved }: { controller: AccessController; record: (Record<string, string | null> & { id: string; version: number; situation: string }) | null; onClose: () => void; onSaved: (id: string, version: number) => void }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(KEYS.map(key => [key, key === 'salary' ? (record?.salary ?? '').replace('.', ',') : key === 'cpf' ? cpfMask(record?.cpf ?? '') : record?.[key] ?? ''])));
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null), command = useRef<{ id: string; body: Record<string, unknown>; uncertain: boolean } | null>(null), actor = useRef(controller.getSnapshot().membership?.user_id);
  const guard = useUnsavedForm(values, busy || uncertain);
  useEffect(() => () => pending.current?.abort(), []);
  const locked = busy || uncertain;
  const change = (key: string, value: string) => { setValues(current => ({ ...current, [key]: value })); setError(''); };
  const execute = async () => {
    if (!command.current || pending.current) return;
    const current = command.current, request = new AbortController(); pending.current = request; setBusy(true); setError('');
    try {
      const result = await controller.catalog(`/v1/cadastros/funcionarios${record ? `/${record.id}` : ''}`, { method: record ? 'PATCH' : 'POST', body: { ...current.body, command_id: current.id }, signal: request.signal }) as { item?: { id: string; version: number } };
      if (request.signal.aborted || controller.getSnapshot().membership?.user_id !== actor.current) return;
      if (!result.item?.id) throw new AccessError(502);
      command.current = null; setUncertain(false); onSaved(result.item.id, result.item.version);
    } catch (failure) {
      if (request.signal.aborted || aborted(failure)) return;
      const known = !current.uncertain && failure instanceof AccessError && [400, 403, 404, 409].includes(failure.status);
      if (!known) current.uncertain = true; else command.current = null;
      setUncertain(!known); setError(known ? contactRefusalText(failure) ?? ((failure as AccessError).status === 409 ? (record ? CONFLICT_TEXT : 'Já existe um funcionário com este CPF.') : errorText(failure)) : 'Não foi possível confirmar o resultado. Use “Conferir resultado” para repetir a mesma operação sem duplicar o cadastro.');
    } finally { if (pending.current === request) { pending.current = null; setBusy(false); } }
  };
  const send = (body: Record<string, unknown>) => { if (locked) return; command.current = { id: crypto.randomUUID(), body: { ...body, ...(record ? { expected_version: record.version } : {}) }, uncertain: false }; void execute(); };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const data: Record<string, string | null> = Object.fromEntries(KEYS.map(key => [key, values[key]!.trim() || null]));
    data.cpf = (data.cpf ?? '').replace(/[ ./-]/g, '') || null; data.pis = data.pis ? data.pis.replace(/[ ./-]/g, '') : null; data.state = data.state ? data.state.toUpperCase() : null;
    data.salary = data.salary ? data.salary.replace(',', '.') : null;
    if (!data.name) { setError('Informe o nome completo.'); return; }
    if (!data.cpf || !validCpf(data.cpf)) { setError('Informe um CPF válido.'); return; }
    if (data.salary && !/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/.test(data.salary)) { setError('Informe o salário sem separador de milhares e com até duas casas decimais.'); return; }
    if (data.email && !emailListValid(data.email, 254)) { setError('Informe um e-mail válido.'); return; }
    for (const key of ['birth_date', 'admission_date']) if (data[key] && !isoDateValid(data[key]!)) { setError('Confira as datas informadas.'); return; }
    if (data.birth_date && data.birth_date > saoPauloToday()) { setError('A data de nascimento não pode ser futura.'); return; }
    send({ data });
  };
  const input = ([key, label, max, hint]: readonly [string, string, number, string?], required = false) => <div className="form-field" key={key}><label htmlFor={`employee-${key}`}>{label}{required ? ' *' : ''}</label>
    <input id={`employee-${key}`} maxLength={max} value={values[key] ?? ''} title={hint} onChange={event => change(key, event.target.value)} />{hint && <small>{hint}</small>}</div>;
  return <section className="real-editor catalog-editor contact-editor" aria-labelledby="employee-title">
    <header className="real-editor-heading catalog-editor-heading"><div className="catalog-editor-title"><h2 id="employee-title">Funcionário</h2>{record && <span className={badgeClass(record.situation === 'ativo' ? 'Ativo' : 'Inativo')}>{record.situation === 'ativo' ? 'Ativo' : 'Desligado'}</span>}</div>
      <div className="catalog-editor-buttons"><button type="button" className="secondary-button" disabled={busy} onClick={() => guard.confirmLeave(onClose)}>Cancelar</button><button type="submit" form="employee-form" className="primary-button" disabled={locked}>{busy ? 'Salvando…' : 'Salvar'}</button></div></header>
    {error && <p className="real-alert" role="alert">{error}</p>}
    {uncertain && <div className="real-editor-actions"><button type="button" className="primary-button" disabled={busy} onClick={() => void execute()}>{busy ? 'Conferindo…' : 'Conferir resultado'}</button></div>}
    <form id="employee-form" onSubmit={submit}><fieldset disabled={locked} className="contact-form">
      <section className="contact-section"><h3 className="catalog-group-title">Dados cadastrais</h3><div className="contact-grid">
        {input(['name', 'Nome completo', 200], true)}{input(['cpf', 'CPF', 14], true)}{input(TEXT[0]!)}
        <div className="form-field"><label htmlFor="employee-birth_date">Data de nascimento</label><input id="employee-birth_date" type="date" value={values.birth_date} onChange={event => change('birth_date', event.target.value)} /></div>
        <ContactPhoto controller={controller} contactId={record?.id ?? null} writable={!locked} owner="employee" />
        {input(TEXT[1]!)}
        <div className="form-field"><label htmlFor="employee-admission_date">Data de admissão</label><input id="employee-admission_date" type="date" value={values.admission_date} onChange={event => change('admission_date', event.target.value)} /></div>
        {TEXT.slice(2).map(field => input(field))}
        <div className="form-field"><label htmlFor="employee-salary">Salário</label><input id="employee-salary" inputMode="decimal" maxLength={20} value={values.salary} onChange={event => change('salary', event.target.value)} /></div></div></section>
      <section className="contact-section"><h3 className="catalog-group-title">Contato</h3><div className="contact-grid">{CONTACT.map(field => input(field))}</div></section>
      <section className="contact-section"><h3 className="catalog-group-title">Endereço</h3><div className="contact-grid">{input(ADDRESS[0]!)}
        <div className="form-field"><label htmlFor="employee-state">UF</label><select id="employee-state" value={values.state} onChange={event => change('state', event.target.value)}>{UF_SELECT.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></div>
        {ADDRESS.slice(1).map(field => input(field))}
        <div className="form-field real-field-wide"><label htmlFor="employee-notes">Observações</label><textarea id="employee-notes" rows={3} maxLength={4000} value={values.notes} onChange={event => change('notes', event.target.value)} /></div></div></section>
      {record && <div className="real-editor-actions"><button type="button" className="secondary-button" disabled={locked} onClick={() => guard.confirmLeave(() => send({ data: null, situation: record.situation === 'ativo' ? 'desligado' : 'ativo' }))}>{record.situation === 'ativo' ? 'Desligar funcionário' : 'Reativar funcionário'}</button></div>}
    </fieldset></form>
  </section>;
}
