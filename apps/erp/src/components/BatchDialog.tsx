import { useRef, useState, type ReactNode } from 'react';
import { Modal } from './Modal';
import { BATCH_OUTCOME_LABEL, batchSummaryText, runBatch, summarizeBatch, type BatchItem, type BatchPlan, type BatchResult, type BatchStep } from '../lib/origin-batch';
import './batch-dialog.css';

/**
 * Ação em lote no padrão Origin: mostra a prévia (quantos registros, quais serão ignorados e por quê),
 * executa item a item só depois da confirmação e termina com o resultado de cada registro.
 */
export function BatchDialog<T extends BatchItem>({ title, description, plan, confirmLabel, canConfirm = true, run, onClose, progressLabel, onRetry }: {
  title: string; description?: ReactNode; plan: BatchPlan<T>; confirmLabel: string; canConfirm?: boolean;
  /** Origin wording of the running state, e.g. "Alterando situações de vendas, 2 de 5". */
  progressLabel?: (current: number, count: number) => string;
  run: (item: T) => Promise<BatchStep>; onClose: (results: BatchResult[] | null) => void;
  /** Optional Origin "Tentar novamente": receives the ids that failed or were not confirmed (the caller opens a new round). */
  onRetry?: (ids: string[]) => void;
}) {
  const [phase, setPhase] = useState<'preview' | 'running' | 'done'>('preview');
  const [results, setResults] = useState<readonly BatchResult[]>([]);
  const abort = useRef<AbortController | null>(null);
  const start = async () => {
    if (phase !== 'preview' || !plan.eligible.length || !canConfirm) return;
    const controller = new AbortController(); abort.current = controller;
    setPhase('running'); setResults(plan.skipped);
    const final = await runBatch(plan, run, { signal: controller.signal, onProgress: partial => setResults(partial) });
    setResults(final); setPhase('done');
  };
  const close = () => {
    if (phase === 'running') { abort.current?.abort(); return; }
    onClose(phase === 'done' ? [...results] : null);
  };
  const summary = summarizeBatch(results);
  const shown: readonly BatchResult[] = phase === 'preview' ? [...plan.eligible.map(item => ({ id: item.id, label: item.label, outcome: 'ok' as const })), ...plan.skipped] : results;
  const eligibleIds = new Set(plan.eligible.map(item => item.id));
  const retryIds = phase === 'done' && onRetry ? results.filter(r => (r.outcome === 'failed' || r.outcome === 'uncertain') && eligibleIds.has(r.id)).map(r => r.id) : [];
  const actions = phase === 'preview'
    ? <><button type="button" className="secondary-button" onClick={close}>Cancelar</button><button type="button" className="primary-button" disabled={!plan.eligible.length || !canConfirm} onClick={() => void start()}>{confirmLabel}</button></>
    : phase === 'running'
      ? <button type="button" className="secondary-button" onClick={close}>Interromper</button>
      : <>{retryIds.length > 0 && <button type="button" className="secondary-button" onClick={() => onRetry!(retryIds)}>Tentar novamente</button>}<button type="button" className="primary-button" onClick={close}>Fechar</button></>;
  return <Modal title={title} onClose={close} actions={actions}>
    <div className="batch-dialog">
      {description}
      {phase === 'preview'
        ? <p className="batch-dialog-lead"><strong>{plan.eligible.length}</strong> {plan.eligible.length === 1 ? 'registro será processado' : 'registros serão processados'}{plan.skipped.length ? <>, <strong>{plan.skipped.length}</strong> {plan.skipped.length === 1 ? 'será ignorado' : 'serão ignorados'}</> : null}. Cada registro é conferido de novo no servidor.</p>
        : <p className="batch-dialog-lead" role="status" aria-live="polite">{phase === 'running' ? (progressLabel ?? ((current: number, count: number) => `Processando ${current} de ${count}…`))(Math.min(results.length - plan.skipped.length + 1, plan.eligible.length), plan.eligible.length) : batchSummaryText(summary)}</p>}
      <ul className="batch-dialog-list">
        {shown.map(result => <li key={result.id} className={`is-${phase === 'preview' && result.outcome === 'ok' ? 'pending' : result.outcome}`}>
          <span className="batch-dialog-label">{result.label}</span>
          {(phase !== 'preview' || result.outcome === 'skipped') && <span className="batch-dialog-outcome">{BATCH_OUTCOME_LABEL[result.outcome]}</span>}
          {result.message && <small>{result.message}</small>}
        </li>)}
      </ul>
    </div>
  </Modal>;
}
