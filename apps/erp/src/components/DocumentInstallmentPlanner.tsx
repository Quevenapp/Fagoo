import { useEffect, useRef, useState } from 'react';
import { decimalMoney } from '../lib/real-access';
import { documentPlanBasis, monthlyDocumentPlan, type DocumentMonthlyPlan } from '../lib/document-installment-plan';
import type { DocumentInput } from '../lib/real-documents-model';
import './document-installment-planner.css';

type Props = {
  source: string; values: DocumentInput; total: string | null; disabled: boolean;
  canAct: () => boolean; onDraft: (value: boolean) => void;
  onApply: (plan: DocumentMonthlyPlan) => boolean;
};
const dateLabel = (date: string) => date.split('-').reverse().join('/');

export default function DocumentInstallmentPlanner(props: Props) {
  const [open, setOpen] = useState(false), [count, setCount] = useState(''), [firstDue, setFirstDue] = useState('');
  const [review, setReview] = useState<DocumentMonthlyPlan | null>(null), [error, setError] = useState('');
  const live = useRef({ props, open, count, firstDue, review }); live.current = { props, open, count, firstDue, review };
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; live.current.props.onDraft(false); }; }, []);
  const allowed = () => mounted.current && !live.current.props.disabled && live.current.props.canAct();
  const close = () => {
    live.current.open = false; live.current.review = null;
    setOpen(false); setReview(null); setCount(''); setFirstDue(''); setError(''); live.current.props.onDraft(false);
  };
  const start = () => {
    if (!allowed() || live.current.open) return;
    live.current.open = true; live.current.props.onDraft(true); setOpen(true); setError('');
  };
  const prepare = () => {
    if (!allowed() || !live.current.open) return;
    const current = live.current;
    try {
      const next = monthlyDocumentPlan(current.props.source, current.props.values, current.count, current.firstDue);
      current.review = next; setReview(next); setError('');
    } catch (failure) { current.review = null; setReview(null); setError(failure instanceof Error ? failure.message : 'Confira os campos das parcelas.'); }
  };
  const apply = () => {
    if (!allowed() || !live.current.open || !live.current.review) return;
    const current = live.current;
    if (current.review!.basis !== documentPlanBasis(current.props.source, current.props.values)) { setError('O documento mudou. Confira novamente as parcelas.'); return; }
    if (current.props.onApply(current.review!)) close();
  };
  const change = (field: 'count' | 'firstDue', value: string) => {
    if (!allowed() || !live.current.open) return;
    live.current[field] = value; live.current.review = null;
    (field === 'count' ? setCount : setFirstDue)(value); setReview(null); setError('');
  };
  const previous = props.values.installments || [];
  return <section className="document-monthly-plan" aria-label="Gerar parcelas mensais">
    {!open ? <button type="button" className="secondary-button" disabled={props.disabled || !props.total} onClick={start}>Gerar parcelas mensais</button> : <>
      <h3>Gerar parcelas mensais</h3>
      <p>Total do documento atual: <strong>{props.total === null ? 'Confira os valores do documento' : decimalMoney(props.total)}</strong></p>
      <p className="real-help">Vencimentos no mesmo dia de cada mês; em meses mais curtos, no último dia. Os centavos restantes ficam nas primeiras parcelas.</p>
      <div className="document-grid">
        <div className="form-field"><label htmlFor="doc-plan-count">Quantidade de parcelas</label><input id="doc-plan-count" inputMode="numeric" maxLength={3} value={count} disabled={props.disabled} onChange={event => change('count', event.target.value)}/></div>
        <div className="form-field"><label htmlFor="doc-plan-first-due">Primeiro vencimento</label><input id="doc-plan-first-due" type="date" min={props.values.date} max="2099-12-31" value={firstDue} disabled={props.disabled} onChange={event => change('firstDue', event.target.value)}/></div>
      </div>
      {error && <p className="real-alert" role="alert">{error}</p>}
      {!review ? <div className="real-editor-actions"><button type="button" className="primary-button" disabled={props.disabled} onClick={prepare}>Conferir parcelas</button><button type="button" className="secondary-button" disabled={props.disabled} onClick={() => { if (allowed()) close(); }}>Cancelar geração</button></div> : <>
        {previous.length > 0 && <div className="document-plan-existing"><h4>Parcelas atuais que serão substituídas</h4><ol>{previous.map((row, index) => <li key={index}><span>{dateLabel(row.due_date)} · {row.amount ? decimalMoney(row.amount) : 'Valor não informado'}</span>{row.method && <span>Forma: {row.method}</span>}{row.note && <span>Observação: {row.note}</span>}{row.payment_reference && <span>Referência da origem: {row.payment_reference.label || row.payment_reference.source_id}</span>}</li>)}</ol><p>O novo plano substituirá as parcelas acima, incluindo suas formas, observações e referências. O texto das condições de pagamento será preservado.</p></div>}
        <h4>Novo plano · {review.installments.length} parcelas · {decimalMoney(review.total)}</h4>
        <div className="document-plan-table"><table><thead><tr><th>Parcela</th><th>Vencimento</th><th>Valor</th></tr></thead><tbody>{review.installments.map((row, index) => <tr key={index}><td>{index + 1}</td><td>{dateLabel(row.due_date)}</td><td>{decimalMoney(row.amount)}</td></tr>)}</tbody></table></div>
        <p className="real-help">As parcelas ficarão no formulário para revisão. Salve o documento para registrá-las. Esta ação não gera contas a pagar ou receber.</p>
        <div className="real-editor-actions"><button type="button" className="primary-button" disabled={props.disabled} onClick={apply}>{previous.length ? 'Substituir parcelas' : 'Usar estas parcelas'}</button><button type="button" className="secondary-button" disabled={props.disabled} onClick={() => { if (allowed()) { live.current.review = null; setReview(null); setError(''); } }}>Rever opções</button><button type="button" className="secondary-button" disabled={props.disabled} onClick={() => { if (allowed()) close(); }}>Cancelar geração</button></div>
      </>}
    </>}
  </section>;
}
