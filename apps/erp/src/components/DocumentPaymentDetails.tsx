import { useEffect, useRef, useState } from 'react';
import type { AccessController } from '../lib/real-access';
import type { DocumentInput, DocumentKind, InstallmentInput } from '../lib/real-documents-model';
import { CARD_BRANDS, CARD_INTEGRATIONS, NO_METHODS, PAYMENT_DETAILS_HELP, PAYMENT_INDICATORS, PAYMENT_MEANS, destinationKind, detailsTitle, emptyDetails, readPaymentOptions, withMethod,
  type InstallmentDetails, type PaymentOptions } from '../lib/document-payment-model';
import { daysFrom, dueFromDays } from '../lib/document-payment-condition';
import { documentDecimalDisplay, documentDecimalInput } from '../lib/document-decimals';
import { normalizeInstallmentDetails } from '../../../../packages/erp-domain/src/index.mjs';
import { Modal } from './Modal';

type Controller = Pick<AccessController, 'documents' | 'getSnapshot'>;
const actorOf = (controller: Controller) => controller.getSnapshot()?.membership?.user_id ?? null;

/**
 * Formas de pagamento and contas financeiras of the kind (GET /v1/documentos/{tipo}/pagamento, 202610200196), read once per user
 * when the Pagamento section is approached (`prefetch`: pointer or focus in the section) or needed (`load`: Gerar parcelas, Ver detalhes).
 */
export function usePaymentOptions(controller: Controller, kind: DocumentKind) {
  const [options, setOptions] = useState<PaymentOptions | null>(null), [failed, setFailed] = useState(false);
  const actor = actorOf(controller), pending = useRef<{ key: string; promise: Promise<PaymentOptions | null> } | null>(null), alive = useRef(true);
  const key = `${kind}:${actor ?? ''}`;
  const load = (): Promise<PaymentOptions | null> => {
    if (pending.current?.key === key) return pending.current.promise;
    const promise = Promise.resolve().then(() => controller.documents(`/v1/documentos/${kind}/pagamento`)).then(value => {
      const read = readPaymentOptions(value, kind);
      if (alive.current && pending.current?.key === key && actorOf(controller) === actor) { setOptions(read); setFailed(false); return read; }
      return null;
    }).catch(() => { if (alive.current && pending.current?.key === key) { setFailed(true); pending.current = null; } return null; });
    pending.current = { key, promise }; return promise;
  };
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (pending.current && pending.current.key !== key) { pending.current = null; setOptions(null); setFailed(false); } }, [controller, key]);
  const prefetch = () => { if (!pending.current || pending.current.key !== key) void load(); };
  return { options, failed, load, prefetch };
}

/**
 * Origin Pagamento: the warning without formas ("Configurar formas"), the Destino of the contas (pedidos de venda e de compra, OS)
 * and, in the pedido de venda, the Detalhes de pagamento used by the nota fiscal.
 */
export function DocumentPaymentHeader({ kind, values, options, disabled, accountName, onChange, onConfigure }: {
  kind: DocumentKind; values: DocumentInput; options: PaymentOptions | null; disabled: boolean; accountName: string | null;
  /** Absent for the profiles that cannot open Cadastros › Formas de pagamento (the warning stays, without a dead link). */
  onChange: (change: Partial<DocumentInput>) => void; onConfigure?: () => void;
}) {
  const account = values.payment_account_id ?? null, savedOnly = account && !options?.accounts.some(item => item.id === account);
  const showDestination = destinationKind(kind) && (Boolean(values.installments?.length) || Boolean(account));
  return <>
    {options && !options.methods.length && <p className="real-notice document-payment-warning" role="note">{NO_METHODS} {onConfigure ? <button type="button" className="text-button" onClick={onConfigure}>Configurar formas</button> : 'Peça ao administrador ou ao financeiro para cadastrar as formas de pagamento.'}</p>}
    {showDestination && <div className="form-field">
      <label htmlFor="doc-payment-destination">Destino</label>
      <select id="doc-payment-destination" value={account ?? ''} disabled={disabled || !options} onChange={event => onChange({ payment_account_id: event.target.value || null })}>
        <option value="">{kind === 'purchase_orders' ? 'Contas a Pagar' : 'Contas a Receber'}</option>
        {savedOnly && <option value={account}>{accountName ?? 'Conta financeira do documento'}</option>}
        {/* Leva H (VND-131, EST-053): Caixa and the contas financeiras only choose the conta prevista of the parcelas. */}
        {options && options.accounts.some(item => item.kind === 'cash') && <optgroup label="Caixa">{options.accounts.filter(item => item.kind === 'cash').map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</optgroup>}
        {options && options.accounts.some(item => item.kind !== 'cash') && <optgroup label="Contas financeiras">{options.accounts.filter(item => item.kind !== 'cash').map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</optgroup>}
      </select>
      <small className="real-help">O Destino escolhe a conta prevista: as contas lançadas ficam nela, em aberto. {kind === 'purchase_orders' ? 'Pagar' : 'Receber'} é sempre uma baixa própria no Financeiro, inclusive no Caixa. A Ficha Financeira do contato reúne as contas, os recebimentos e os créditos lançados, sem criar outra dívida.</small>
    </div>}
    {kind === 'sales_orders' && <fieldset className="document-payment-details" disabled={disabled}>
      <legend>Detalhes de pagamento</legend>
      <div className="form-field"><label htmlFor="doc-payment-means">Método de pagamento</label>
        <select id="doc-payment-means" value={values.payment_means ?? ''} onChange={event => onChange({ payment_means: event.target.value || null })}>
          <option value="">Selecione</option>{PAYMENT_MEANS.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
        </select></div>
      <div className="form-field"><label htmlFor="doc-payment-indicator">Forma de pagamento</label>
        <select id="doc-payment-indicator" value={values.payment_indicator ?? ''} onChange={event => onChange({ payment_indicator: (event.target.value || null) as DocumentInput['payment_indicator'] })}>
          <option value="">Selecione</option>{PAYMENT_INDICATORS.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
        </select></div>
      <small className="real-help">{PAYMENT_DETAILS_HELP}</small>
    </fieldset>}
  </>;
}

/** Forma of one parcela: the formas cadastradas (a forma no longer offered keeps its name). */
export function InstallmentMethod({ index, row, kind, options, names, disabled, onChange }: {
  index: number; row: InstallmentInput; kind: DocumentKind; options: PaymentOptions | null; names: Record<string, string> | undefined; disabled: boolean; onChange: (row: InstallmentInput) => void;
}) {
  const current = row.payment_method_id ?? null, known = options?.methods.some(item => item.id === current);
  return <label htmlFor={`doc-installment-method-${index}`}>Forma<select id={`doc-installment-method-${index}`} value={current ?? ''} disabled={disabled || !options}
    onChange={event => onChange(withMethod(row, options?.methods.find(item => item.id === event.target.value) ?? null, kind))}>
    <option value="">Nenhuma forma</option>
    {current && !known && <option value={current}>{names?.[current] ?? 'Forma do documento'}</option>}
    {options?.methods.map(item => <option key={item.id} value={item.id}>{item.description}</option>)}
  </select></label>;
}

const money = (value: string | null) => value === null ? '' : documentDecimalDisplay(value);
const typed = (value: string) => value.trim() === '' ? null : documentDecimalInput(value.trim());

/** Origin "Ver detalhes": Detalhes da parcela (Dados da parcela in the pedido de compra), applied to the form on OK. */
export function InstallmentDetailsDialog({ kind, index, row, baseDate, options, names, accountNames, onClose, onApply }: {
  kind: DocumentKind; index: number; row: InstallmentInput; baseDate: string; options: PaymentOptions | null; names: Record<string, string> | undefined;
  accountNames: Record<string, string> | undefined; onClose: () => void; onApply: (row: InstallmentInput) => void;
}) {
  const purchase = kind === 'purchase_orders';
  const [draft, setDraft] = useState<InstallmentInput>(() => ({ ...row, details: row.details ?? emptyDetails() }));
  const [error, setError] = useState('');
  const details = draft.details ?? emptyDetails();
  const set = (change: Partial<InstallmentDetails>) => setDraft(previous => ({ ...previous, details: { ...(previous.details ?? emptyDetails()), ...change } }));
  const account = details.account_id, accountKnown = options?.accounts.some(item => item.id === account);
  const apply = () => {
    try {
      const normalized = normalizeInstallmentDetails(kind, details);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.due_date) || !/^\d{1,12}(\.\d{1,2})?$/.test(draft.amount)) throw new Error('date');
      // Exact decimals (cents as BigInt), never floats.
      const cents = (value: string) => { const [whole, fraction = ''] = value.split('.'); return BigInt(whole!) * 100n + BigInt((fraction + '00').slice(0, 2)); };
      for (const key of ['received_amount', 'fee_amount', 'commission_fee_amount'] as const) if (normalized?.[key] && cents(normalized[key]!) > cents(draft.amount)) throw new Error('amount');
      onApply({ ...draft, details: normalized });
    } catch { setError('Confira a data, os valores (até duas casas decimais, sem passar do valor da parcela), o CNPJ da credenciadora (14 caracteres) e o código de autorização.'); }
  };
  return <Modal title={detailsTitle(kind)} onClose={onClose} actions={<><button type="button" className="secondary-button" onClick={onClose}>Cancelar</button><button type="button" className="primary-button" onClick={apply}>OK</button></>}>
    <p className="real-help">Parcela {index + 1}</p>
    <div className="document-grid document-installment-details">
      <div className="form-field"><label htmlFor="doc-detail-days">Dias</label><input id="doc-detail-days" inputMode="numeric" maxLength={4} value={daysFrom(baseDate, draft.due_date)} onChange={event => { const due = dueFromDays(baseDate, event.target.value); if (due) setDraft(previous => ({ ...previous, due_date: due })); }}/></div>
      <div className="form-field"><label htmlFor="doc-detail-date">Data</label><input id="doc-detail-date" type="date" value={draft.due_date} onChange={event => setDraft(previous => ({ ...previous, due_date: event.target.value }))}/></div>
      <InstallmentMethod index={-1} row={draft} kind={kind} options={options} names={names} disabled={false} onChange={next => setDraft({ ...next, details: next.details ?? emptyDetails() })}/>
      <div className="form-field"><label htmlFor="doc-detail-account">Destino/Conta financeira</label><select id="doc-detail-account" value={account ?? ''} disabled={!options} onChange={event => set({ account_id: event.target.value || null })}>
        <option value="">Destino do documento</option>{account && !accountKnown && <option value={account}>{accountNames?.[account] ?? 'Conta financeira da parcela'}</option>}
        {options?.accounts.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
      <div className="form-field"><label htmlFor="doc-detail-type">Tipo de pagamento</label><select id="doc-detail-type" value={details.payment_type ?? ''} onChange={event => set({ payment_type: event.target.value || null })}>
        <option value="">Selecione</option>{PAYMENT_MEANS.map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></div>
      {!purchase && <><div className="form-field"><label htmlFor="doc-detail-brand">Bandeira</label><select id="doc-detail-brand" value={details.card_brand ?? ''} onChange={event => set({ card_brand: event.target.value || null })}>
        <option value="">Selecione</option>{CARD_BRANDS.map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></div>
        <div className="form-field"><label htmlFor="doc-detail-integration">Tipo integração</label><select id="doc-detail-integration" value={details.integration_type ?? ''} onChange={event => set({ integration_type: (event.target.value || null) as InstallmentDetails['integration_type'] })}>
          <option value="">Selecione</option>{CARD_INTEGRATIONS.map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></div>
        <div className="form-field"><label htmlFor="doc-detail-cnpj">CNPJ credenciadora</label><input id="doc-detail-cnpj" maxLength={18} value={details.acquirer_cnpj ?? ''} onChange={event => set({ acquirer_cnpj: event.target.value.toUpperCase().replace(/[ ./-]/g, '') || null })}/></div></>}
      <div className="form-field"><label htmlFor="doc-detail-authorization">Código de autorização</label><input id="doc-detail-authorization" maxLength={128} value={details.authorization_code ?? ''} onChange={event => set({ authorization_code: event.target.value.trim() || null })}/></div>
      <div className="form-field"><label htmlFor="doc-detail-amount">Valor</label><input id="doc-detail-amount" inputMode="decimal" value={documentDecimalDisplay(draft.amount)} onChange={event => setDraft(previous => ({ ...previous, amount: documentDecimalInput(event.target.value) }))}/></div>
      <div className="form-field"><label htmlFor="doc-detail-received">Valor Recebido</label><input id="doc-detail-received" inputMode="decimal" value={money(details.received_amount)} onChange={event => set({ received_amount: typed(event.target.value) })}/></div>
      <div className="form-field"><label htmlFor="doc-detail-fee">Valor de taxa</label><input id="doc-detail-fee" inputMode="decimal" value={money(details.fee_amount)} onChange={event => set({ fee_amount: typed(event.target.value) })}/></div>
      {!purchase && <div className="form-field"><label htmlFor="doc-detail-commission">Valor de taxa comissão</label><input id="doc-detail-commission" inputMode="decimal" value={money(details.commission_fee_amount)} onChange={event => set({ commission_fee_amount: typed(event.target.value) })}/></div>}
      <div className="form-field document-wide"><label htmlFor="doc-detail-note">Observação</label><textarea id="doc-detail-note" rows={2} maxLength={2000} value={draft.note ?? ''} onChange={event => setDraft(previous => ({ ...previous, note: event.target.value || null }))}/></div>
    </div>
    {error && <p className="real-alert" role="alert">{error}</p>}
  </Modal>;
}
