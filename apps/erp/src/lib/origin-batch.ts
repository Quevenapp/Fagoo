// Ações em lote no padrão Origin, com prévia, execução item a item e resultado por registro.
// docs/product-scope.md (contrato 6): lote tem prévia, permissões, resumo por item e falhas parciais visíveis.
export type BatchOutcome = 'ok' | 'failed' | 'skipped' | 'uncertain';
export type BatchItem = { id: string; label: string };
export type BatchResult = { id: string; label: string; outcome: BatchOutcome; message?: string };
export type BatchPlan<T extends BatchItem> = { eligible: readonly T[]; skipped: readonly BatchResult[] };
export type BatchStep = void | { uncertain?: boolean; message?: string };
export type BatchSummary = { total: number; ok: number; failed: number; skipped: number; uncertain: number };

/** Separates the selected items into the ones the action can run on and the ones skipped, with the reason. */
export function planBatch<T extends BatchItem>(items: readonly T[], reasonToSkip: (item: T) => string | null | undefined): BatchPlan<T> {
  const eligible: T[] = [], skipped: BatchResult[] = [];
  for (const item of items) {
    const reason = reasonToSkip(item);
    if (reason) skipped.push({ id: item.id, label: item.label, outcome: 'skipped', message: reason });
    else eligible.push(item);
  }
  return { eligible, skipped };
}

const messageOf = (error: unknown) => error instanceof Error && error.message ? error.message : typeof error === 'string' && error ? error : 'Falha sem detalhe.';

/**
 * Runs the action one item at a time, in order. A failure never stops the remaining items; an abort stops
 * before the next item and marks the rest as skipped. An item whose outcome is unknown is reported as uncertain.
 */
export async function runBatch<T extends BatchItem>(plan: BatchPlan<T>, run: (item: T) => Promise<BatchStep>, options: { signal?: AbortSignal; onProgress?: (results: readonly BatchResult[]) => void } = {}): Promise<BatchResult[]> {
  const results: BatchResult[] = [...plan.skipped];
  for (const item of plan.eligible) {
    if (options.signal?.aborted) { results.push({ id: item.id, label: item.label, outcome: 'skipped', message: 'Interrompido antes de executar.' }); continue; }
    try {
      const step = await run(item);
      results.push(step && step.uncertain
        ? { id: item.id, label: item.label, outcome: 'uncertain', message: step.message || 'Resultado não confirmado. Confira o registro antes de repetir.' }
        : { id: item.id, label: item.label, outcome: 'ok', ...(step && step.message ? { message: step.message } : {}) });
    } catch (error) {
      results.push({ id: item.id, label: item.label, outcome: 'failed', message: messageOf(error) });
    }
    options.onProgress?.(results.slice());
  }
  return results;
}

export function summarizeBatch(results: readonly BatchResult[]): BatchSummary {
  const summary: BatchSummary = { total: results.length, ok: 0, failed: 0, skipped: 0, uncertain: 0 };
  for (const result of results) summary[result.outcome]++;
  return summary;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
export function batchSummaryText(summary: BatchSummary) {
  const parts = [plural(summary.ok, 'concluído', 'concluídos')];
  if (summary.failed) parts.push(plural(summary.failed, 'com falha', 'com falha'));
  if (summary.uncertain) parts.push(plural(summary.uncertain, 'a conferir', 'a conferir'));
  if (summary.skipped) parts.push(plural(summary.skipped, 'ignorado', 'ignorados'));
  return parts.join(' · ');
}

export const BATCH_OUTCOME_LABEL: Readonly<Record<BatchOutcome, string>> = { ok: 'Concluído', failed: 'Falhou', skipped: 'Ignorado', uncertain: 'Conferir' };
