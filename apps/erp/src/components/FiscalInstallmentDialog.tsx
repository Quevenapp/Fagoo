import { useState, type ReactNode } from 'react';
import { CARD_BRAND_OPTIONS, CARD_INTEGRATION_OPTIONS, PAYMENT_OPTIONS, formaOptions, formaValue, withForma, type InstallmentDraft, type PaymentMethodOption, type Values } from '../lib/fiscal-invoice-form-model';
import { Modal } from './Modal';

/**
 * Popup "Informação" da parcela (Origin, ícone de detalhe da tabela Parcelas): Dias, Data, Forma, Destino/Conta financeira, Tipo de
 * pagamento, Bandeira, Tipo integração, CNPJ credenciadora, Código de autorização, Valor, Valor Recebido, Valor de taxa, Valor de
 * taxa comissão e Observação. "Salvar" só altera o rascunho da nota; Destino/Conta financeira fica em leitura porque a nota do
 * Brufap não lança contas.
 */
export default function FiscalInstallmentDialog({ installment, position, direction, readOnly, onSave, onCancel, methods = [] }: {
  installment: InstallmentDraft; position: number; direction: '0' | '1'; readOnly: boolean; onSave: (installment: InstallmentDraft) => void; onCancel: () => void;
  /** Cadastros › Formas de pagamento for "Forma" (202610200219). */
  methods?: readonly PaymentMethodOption[];
}) {
  const [draft, setDraft] = useState<InstallmentDraft>(() => ({ ...installment, card: installment.card ? { ...installment.card } : null }));
  const [error, setError] = useState('');
  const value = (key: string) => String(draft[key] ?? '');
  const cardValue = (key: string) => String(draft.card?.[key] ?? '');
  const set = (key: string, next: string) => { if (!readOnly) setDraft(d => ({ ...d, [key]: next })); };
  const setCard = (key: string, next: string) => { if (readOnly) return; setDraft(d => { const card: Values = { ...(d.card ?? {}), [key]: next }; if (next === '') delete card[key]; return { ...d, card: Object.keys(card).length ? card : null }; }); };
  const kind = PAYMENT_OPTIONS.find(([code]) => code === value('method'))?.[1] ?? '';
  const save = () => {
    const cnpj = cardValue('cnpj');
    if (cnpj && !/^\d{14}$/.test(cnpj)) { setError('O CNPJ da credenciadora deve ter 14 dígitos.'); return; }
    for (const [key, label] of [['received', 'Valor Recebido'], ['fee', 'Valor de taxa'], ['commission_fee', 'Valor de taxa comissão']] as const)
      if (cardValue(key) && !/^\d{1,13}([.,]\d{1,2})?$/.test(cardValue(key))) { setError(`Confira o campo ${label}.`); return; }
    if (!value('date') || !/^\d{1,13}([.,]\d{1,2})?$/.test(value('amount'))) { setError('Cada parcela precisa de data e valor.'); return; }
    onSave(draft);
  };
  const field = (id: string, label: string, control: ReactNode, title?: string) => <div className="form-field"><label htmlFor={id} title={title}>{label}</label>{control}</div>;
  const input = (id: string, current: string, onChange: (next: string) => void, extra: { max?: number; inputMode?: 'numeric' | 'decimal'; type?: string } = {}) =>
    <input id={id} type={extra.type ?? 'text'} value={current} maxLength={extra.max} inputMode={extra.inputMode} disabled={readOnly} onChange={event => onChange(event.target.value)} />;
  const select = (id: string, current: string, options: readonly (readonly [string, string])[], onChange: (next: string) => void) =>
    <select id={id} value={current} disabled={readOnly} onChange={event => onChange(event.target.value)}><option value="">Selecione</option>{options.map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select>;
  return <Modal title={`Informação · parcela ${position}`} onClose={onCancel}
    actions={<>{!readOnly && <button type="button" className="primary-button" onClick={save}>Salvar</button>}<button type="button" className="secondary-button" onClick={onCancel}>{readOnly ? 'Fechar' : 'Cancelar'}</button></>}>
    <div className="document-grid fiscal-installment-detail">
      {field('fiscal-installment-days', 'Dias', input('fiscal-installment-days', value('days'), next => set('days', next.replace(/\D/g, '')), { max: 4, inputMode: 'numeric' }))}
      {field('fiscal-installment-date', 'Data', input('fiscal-installment-date', value('date'), next => set('date', next), { type: 'date' }))}
      {field('fiscal-installment-method', 'Forma', select('fiscal-installment-method', formaValue(draft), formaOptions(methods, draft), next => { if (!readOnly) setDraft(d => withForma(d, next, methods)); }))}
      {field('fiscal-installment-destination', 'Destino/Conta financeira', <select id="fiscal-installment-destination" disabled title="A conta financeira é usada ao lançar contas pela nota, que fica desligado enquanto o Origin é o sistema principal."><option>{direction === '1' ? 'Contas a Receber' : 'Contas a Pagar'}</option></select>)}
      {field('fiscal-installment-kind', 'Tipo de pagamento', <input id="fiscal-installment-kind" readOnly value={kind} placeholder="Conforme a forma" />, 'Meio de pagamento informado na NF-e (tPag), conforme a forma da parcela.')}
      {field('fiscal-installment-brand', 'Bandeira', select('fiscal-installment-brand', cardValue('brand'), CARD_BRAND_OPTIONS, next => setCard('brand', next)))}
      {field('fiscal-installment-integration', 'Tipo integração', select('fiscal-installment-integration', cardValue('integration'), CARD_INTEGRATION_OPTIONS, next => setCard('integration', next)))}
      {field('fiscal-installment-cnpj', 'CNPJ credenciadora', input('fiscal-installment-cnpj', cardValue('cnpj'), next => setCard('cnpj', next.replace(/\D/g, '')), { max: 14, inputMode: 'numeric' }))}
      {field('fiscal-installment-authorization', 'Código de autorização', input('fiscal-installment-authorization', cardValue('authorization'), next => setCard('authorization', next), { max: 128 }))}
      {field('fiscal-installment-amount', 'Valor', input('fiscal-installment-amount', value('amount'), next => set('amount', next), { max: 20, inputMode: 'decimal' }))}
      {field('fiscal-installment-received', 'Valor Recebido', input('fiscal-installment-received', cardValue('received'), next => setCard('received', next), { max: 20, inputMode: 'decimal' }))}
      {field('fiscal-installment-fee', 'Valor de taxa', input('fiscal-installment-fee', cardValue('fee'), next => setCard('fee', next), { max: 20, inputMode: 'decimal' }))}
      {field('fiscal-installment-commission', 'Valor de taxa comissão', input('fiscal-installment-commission', cardValue('commission_fee'), next => setCard('commission_fee', next), { max: 20, inputMode: 'decimal' }))}
      <div className="form-field fiscal-wide"><label htmlFor="fiscal-installment-note">Observação</label><textarea id="fiscal-installment-note" rows={2} maxLength={255} disabled={readOnly} value={value('note')} onChange={event => set('note', event.target.value)} /></div>
    </div>
    {error && <p className="real-alert" role="alert">{error}</p>}
  </Modal>;
}
