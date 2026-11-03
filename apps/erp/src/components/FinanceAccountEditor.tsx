import { Link } from 'react-router-dom';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { AccessError } from '../lib/real-access';
import { useUnsavedForm } from '../hooks/useUnsavedChanges';
import { centsInput, financeMoney, moneyInput, postingDate, todaySP } from '../lib/real-finance-model';
import { ACCOUNT_TYPE_CARDS, financialAccount, isBankType, needsInstitution, type AccountType, type FinancialAccount } from '../lib/finance-registry-model';
import { institutionLabel, searchInstitutions } from '../lib/bank-institutions';
import { Icon } from './Icon';

type Finance = (path: string, options?: { method?: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal }) => Promise<unknown>;
type Values = { account_type: Exclude<AccountType, 'integration'>; institution_code: string; institution_name: string; name: string; agency: string; account_number: string; account_digit: string; start_on: string; opening: string; default_movements: boolean; default_boleto: boolean };
const STEPS = [{ id: 'tipo', label: 'Tipo de Conta' }, { id: 'dados', label: 'Dados da Conta' }, { id: 'boleto', label: 'Emissão de Boleto' }] as const;
const known = (failure: unknown) => failure instanceof AccessError && [400, 403, 404, 409].includes(failure.status);
const failureText = (failure: unknown) => failure instanceof AccessError ? failure.status === 409 ? 'A conta mudou desde que foi aberta ou já é usada. Volte à listagem e abra a conta de novo.' : failure.status === 400 ? 'A conta não foi aceita. Confira a instituição, a agência, a conta, a data de início (sem movimentos antes dela) e o saldo inicial.' : failure.status === 403 ? 'Seu acesso a esta operação foi alterado.' : failure.status === 404 ? 'A conta não foi encontrada.' : 'Não foi possível confirmar o resultado.' : failure instanceof Error ? failure.message : 'Não foi possível concluir a operação.';
function Field({ label, children, wide = false, hint }: { label: string; children: (id: string) => ReactNode; wide?: boolean; hint?: ReactNode }) { const id = useId(); return <div className={`form-field${wide ? ' finance-drawer-wide' : ''}`}><label htmlFor={id}>{label}</label>{children(id)}{hint}</div>; }
function initial(account: FinancialAccount | null, today: string): Values {
  const type = account && account.account_type !== 'integration' ? account.account_type : 'checking';
  return { account_type: type, institution_code: account?.institution_code ?? '', institution_name: account?.institution_name ?? '', name: account?.name ?? '',
    agency: account?.agency ?? account?.cnab?.agency ?? '', account_number: account?.account_number ?? account?.cnab?.account ?? '', account_digit: account?.account_digit ?? account?.cnab?.account_digit ?? '',
    start_on: account?.start_on ?? account?.first_movement_on ?? today, opening: account?.opening_cents ? centsInput(account.opening_cents) : '0,00',
    default_movements: account?.default_movements ?? false, default_boleto: account?.default_boleto ?? false };
}

/**
 * Conta financeira — incluir (assistente) e editar, como no Origin: navegação lateral "Cadastro de Conta" (Tipo de Conta >
 * Dados da Conta > Emissão de Boleto), tipo em cards, instituição, Descrição com 50 caracteres, agência, conta e DV, data de
 * início dos lançamentos, saldo inicial e os padrões. "Adicionar Conta" / "Atualizar Conta" gravam com command_id; um
 * resultado incerto trava o formulário até "Conferir resultado" repetir o mesmo comando. A guarda de alterações não salvas
 * continua valendo no Voltar (desvio deliberado: no Origin o Voltar sai sem confirmação).
 */
export default function FinanceAccountEditor({ finance, account, writable, mayWrite, onBack, onSaved }: { finance: Finance; account: FinancialAccount | null; writable: boolean; mayWrite: () => boolean; onBack: () => void; onSaved: (account: FinancialAccount, created: boolean) => void }) {
  const today = todaySP(), [values, setValues] = useState<Values>(() => initial(account, today)), [query, setQuery] = useState(''), [active, setActive] = useState<string>('tipo');
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [error, setError] = useState('');
  const command = useRef<{ id: string; path: string; body: { data: Record<string, unknown> } } | null>(null), request = useRef<AbortController | null>(null);
  const guard = useUnsavedForm(values, busy || uncertain), heading = useRef<HTMLHeadingElement>(null);
  const sections = useRef<Record<string, HTMLElement | null>>({});
  const set = <K extends keyof Values>(key: K, value: Values[K]) => setValues(previous => ({ ...previous, [key]: value }));
  const integration = account?.account_type === 'integration', disabled = !writable || busy || uncertain || integration;
  const bank = isBankType(values.account_type), institution = needsInstitution(values.account_type), openingEditable = !account || !account.opening_recorded;
  const steps = STEPS.filter(step => step.id !== 'boleto' || bank);
  useEffect(() => { heading.current?.focus(); return () => request.current?.abort(); }, []);
  // The step in view is highlighted on the side navigation, as in Origin.
  useEffect(() => {
    if (typeof IntersectionObserver !== 'function') return;
    const observer = new IntersectionObserver(entries => { const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]; if (visible) setActive((visible.target as HTMLElement).dataset.step ?? 'tipo'); }, { threshold: 0.3 });
    for (const element of Object.values(sections.current)) if (element) observer.observe(element);
    return () => observer.disconnect();
  }, [bank]);
  const go = (step: string) => { setActive(step); sections.current[step]?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }); };
  const build = () => {
    const name = values.name.trim();
    if (!name) throw new Error('Informe a descrição da conta.');
    if (name.length > 50 && (!account || name !== account.name)) throw new Error('A descrição tem no máximo 50 caracteres.');
    if (institution && (!values.institution_code || !values.institution_name)) throw new Error('Busque e selecione a instituição.');
    if (bank && (!/^[0-9A-Za-z-]{1,10}$/.test(values.agency.trim()) || !/^[0-9A-Za-z.-]{1,20}$/.test(values.account_number.trim()) || !/^[0-9A-Za-z]{1,2}$/.test(values.account_digit.trim()))) throw new Error('Informe a agência, a conta e o DV da conta bancária.');
    postingDate(values.start_on);
    if (account?.first_movement_on && values.start_on > account.first_movement_on) throw new Error('A data de início não pode ser posterior ao primeiro lançamento da conta.');
    const data: Record<string, unknown> = { account_type: values.account_type, institution_code: institution ? values.institution_code : null, institution_name: institution ? values.institution_name : null, name,
      agency: bank ? values.agency.trim() : null, account_number: bank ? values.account_number.trim() : null, account_digit: bank ? values.account_digit.trim() : null, start_on: values.start_on, default_movements: values.default_movements };
    if (openingEditable) data.opening_cents = moneyInput(values.opening, true);
    if (account) { data.id = account.id; data.expected_version = account.version; if (bank) data.default_boleto = values.default_boleto; }
    return data;
  };
  const save = async () => {
    if (busy || !writable || integration) return; setError('');
    if (!command.current) {
      let data: Record<string, unknown>; try { data = build(); } catch (failure) { setError((failure as Error).message); return; }
      command.current = { id: crypto.randomUUID(), path: `/v1/financeiro/actions/${account ? 'account_update' : 'account_create'}`, body: { data } };
    }
    if (!mayWrite()) { setError('Seu acesso a esta operação foi alterado.'); return; }
    const operation = command.current, controller = new AbortController(); request.current = controller; setBusy(true);
    try {
      const result = await finance(operation.path, { method: 'POST', body: { ...structuredClone(operation.body), command_id: operation.id }, signal: controller.signal }) as { record?: unknown };
      if (controller.signal.aborted) return;
      const saved = financialAccount(result?.record); command.current = null; setUncertain(false); onSaved(saved, !account);
    } catch (failure) {
      if (controller.signal.aborted) return;
      if (known(failure) && !uncertain) { command.current = null; setError(failureText(failure)); }
      else { setUncertain(true); setError(known(failure) ? `${failureText(failure)} O envio anterior continua sem confirmação.` : 'Não foi possível confirmar o resultado. Use “Conferir resultado” para repetir a mesma gravação; ela não será duplicada.'); }
    } finally { if (request.current === controller) request.current = null; setBusy(false); }
  };
  const results = institution && !values.institution_code ? searchInstitutions(query) : [];
  const counter = `${values.name.length}/50`;
  return <section className="finance-account-editor">
    <header className="real-editor-heading"><div><h1 ref={heading} tabIndex={-1}>{account ? 'Editar conta financeira' : 'Incluir conta financeira'}</h1><p>{account ? account.name : 'Cadastro de Conta'}</p></div></header>
    {integration && <p className="real-notice">Contas de integração de pagamento são mantidas pela integração e não podem ser editadas.</p>}
    {!writable && <p className="real-notice">Seu perfil consulta a conta, sem alterar.</p>}
    {error && <p className="real-alert" role="alert">{error}</p>}
    <div className="finance-account-layout">
      <nav className="finance-account-steps" aria-label="Cadastro de Conta"><h2>Cadastro de Conta</h2><ol>{steps.map(step => <li key={step.id}><button type="button" aria-current={active === step.id ? 'step' : undefined} onClick={() => go(step.id)}>{step.label}</button></li>)}</ol></nav>
      <form className="finance-account-form" onSubmit={event => { event.preventDefault(); void save(); }} aria-busy={busy}><fieldset disabled={disabled} className="finance-account-fieldset"><legend className="real-sr-only">Dados da conta financeira</legend>
        <section ref={element => { sections.current.tipo = element; }} data-step="tipo" className="finance-account-section"><h2>Tipo de Conta</h2>
          <div className="finance-account-cards" role="radiogroup" aria-label="Tipo de Conta">{ACCOUNT_TYPE_CARDS.map(card => <label key={card.type} className={`finance-account-card${values.account_type === card.type ? ' selected' : ''}`} htmlFor={`account-type-${card.type}`}>
            <input id={`account-type-${card.type}`} type="radio" name="account-type" checked={values.account_type === card.type} disabled={Boolean(account?.cnab) && !isBankType(card.type)} onChange={() => setValues(previous => ({ ...previous, account_type: card.type, ...(needsInstitution(card.type) ? {} : { institution_code: '', institution_name: '' }), ...(isBankType(card.type) ? {} : { default_boleto: false }) }))} />
            <Icon name={card.type === 'cash' ? 'cash-register' : card.type === 'receiving' ? 'credit-card' : card.type === 'other' ? 'money-bill-1' : 'building-columns'} size={16} />{card.label}</label>)}</div>
          {account?.cnab && <p className="real-help">Esta conta tem cobrança bancária configurada; ela continua sendo uma conta bancária.</p>}
          {institution && <Field label="Busque pela instituição *" wide>{id => values.institution_code ? <div className="finance-selected"><strong><Icon name="building-columns" size={14} /> {institutionLabel(values.institution_code, values.institution_name)}</strong><button type="button" className="text-button" onClick={() => setValues(previous => ({ ...previous, institution_code: '', institution_name: '' }))}>Trocar</button></div>
            : <><input id={id} type="search" maxLength={80} placeholder="Nome ou código do banco" value={query} onChange={event => setQuery(event.target.value)} />
              <div className="finance-institution-results" role="listbox" aria-label="Instituições">{results.map(item => <button key={item.code} type="button" role="option" aria-selected={false} onClick={() => { setValues(previous => ({ ...previous, institution_code: item.code, institution_name: item.name })); setQuery(''); }}>{item.code} - {item.name}</button>)}{!results.length && <p className="real-help">Nenhuma instituição encontrada.</p>}</div></>}</Field>}
        </section>
        <section ref={element => { sections.current.dados = element; }} data-step="dados" className="finance-account-section"><h2>Dados da Conta</h2><div className="finance-drawer-fields">
          <Field label="Descrição *" wide hint={<small className="finance-drawer-counter">{counter}</small>}>{id => <input id={id} required maxLength={account && account.name.length > 50 ? account.name.length : 50} value={values.name} onChange={event => set('name', event.target.value)} />}</Field>
          {bank && <><Field label="Agência *">{id => <input id={id} required maxLength={10} inputMode="numeric" value={values.agency} onChange={event => set('agency', event.target.value)} />}</Field>
            <Field label="Conta *">{id => <input id={id} required maxLength={20} inputMode="numeric" value={values.account_number} onChange={event => set('account_number', event.target.value)} />}</Field>
            <Field label="DV *">{id => <input id={id} required maxLength={2} value={values.account_digit} onChange={event => set('account_digit', event.target.value)} />}</Field></>}
          <Field label="Data de início dos lançamentos *" hint={<small className="real-help">Início da conciliação; não são aceitos lançamentos antes desta data.</small>}>{id => <input id={id} type="date" required max={account?.first_movement_on ?? today} value={values.start_on} onChange={event => set('start_on', event.target.value)} />}</Field>
          <Field label="Saldo inicial da conta (R$) *" hint={!openingEditable ? <small className="real-help">Saldo inicial já registrado. Para corrigir o saldo, use “Ajustar saldos” em Caixas e bancos.</small> : <small className="real-help">Lançado na data de início. Use sinal negativo para saldo devedor.</small>}>{id => <input id={id} inputMode="decimal" required readOnly={!openingEditable} value={openingEditable ? values.opening : financeMoney(account!.opening_cents ?? '0')} onChange={event => set('opening', event.target.value)} />}</Field>
          {bank && <label className="finance-drawer-switch finance-drawer-wide" title={account?.cnab ? undefined : 'A emissão de boletos depende da cobrança bancária configurada para esta conta.'}><input type="checkbox" role="switch" checked={Boolean(account?.cnab)} disabled onChange={() => undefined} />Emitir boletos com esta conta</label>}
          {bank && <label className="finance-drawer-switch finance-drawer-wide" title={account?.cnab ? undefined : 'Disponível para a conta com cobrança bancária configurada.'}><input type="checkbox" role="switch" checked={values.default_boleto} disabled={!account?.cnab || !account.active} onChange={event => set('default_boleto', event.target.checked)} />Tornar padrão de emissão de boletos</label>}
          <label className="finance-drawer-switch finance-drawer-wide"><input type="checkbox" role="switch" checked={values.default_movements} disabled={Boolean(account && !account.active)} onChange={event => set('default_movements', event.target.checked)} />Tornar conta padrão de movimentações</label>
        </div></section>
        {bank && <section ref={element => { sections.current.boleto = element; }} data-step="boleto" className="finance-account-section"><h2>Emissão de Boleto</h2>
          {account?.cnab ? <p>Cobrança bancária configurada: banco {account.cnab.bank ?? '—'}, agência {account.cnab.agency ?? '—'}, conta {account.cnab.account ?? '—'}{account.cnab.account_digit ? `-${account.cnab.account_digit}` : ''}. Carteira, instruções, juros, multa e remessas ficam na <Link to="/cobranca-empresa">cobrança bancária</Link>.</p>
            : <p className="real-help">Esta conta ainda não emite boletos. A carteira, as instruções e a homologação são configuradas na <Link to="/cobranca-empresa">cobrança bancária</Link>; o envio ao banco continua desligado.</p>}
        </section>}
      </fieldset>
      <div className="real-editor-actions finance-drawer-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => guard.confirmLeave(onBack)}>Voltar</button>{writable && !integration && <button type="submit" className="primary-button" disabled={busy}>{busy ? 'Salvando…' : uncertain ? 'Conferir resultado' : account ? 'Atualizar Conta' : 'Adicionar Conta'}</button>}</div>
      </form>
    </div>
  </section>;
}
