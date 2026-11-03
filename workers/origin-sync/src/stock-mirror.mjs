/** One small database-only batch. Staging and upstream collection stay independent. */
export async function projectStockMirror(repo, { deadline, clock = Date.now }) {
  if (clock() >= deadline) return { status: 'skipped_time', processed: 0, applied: 0, failed: 0, pending: null };
  const result = await repo.rpc('erp_stock_mirror_project', { p_limit: 50 }, { deadline });
  if (!result || ['processed', 'applied', 'failed', 'pending'].some(key => !Number.isSafeInteger(result[key]) || result[key] < 0)
    || result.processed > 50 || result.applied + result.failed > result.processed) throw new Error('STOCK_MIRROR_RESULT_INVALID');
  return { status: result.failed ? 'partial' : 'completed', processed: result.processed, applied: result.applied, failed: result.failed, pending: result.pending };
}
