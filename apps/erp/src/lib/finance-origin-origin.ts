export type FinanceOriginOrigin = {
  system: 'origin'; entity: 'receivables' | 'payables'; source_id: string; batch_id: string;
  imported_at: string; source_hash: string; source_version: string;
  core_fields_locked: true; cnab_reservation_blocked: true;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

/** Bind the minimal provenance response to the title actually being displayed. */
export function financeOriginOrigin(value: unknown, titleId: string, kind: 'receivable' | 'payable'): FinanceOriginOrigin | null {
  const fail = (): never => { throw new Error('Não foi possível conferir a origem deste título. Consulte novamente antes de editá-lo.'); };
  if (!uuid.test(titleId) || !object(value) || value.data_mode !== 'erp_native' || value.read_only !== true || value.title_id !== titleId) return fail();
  if (value.origin === null) return null;
  const origin = value.origin;
  if (!object(origin) || origin.system !== 'origin' || origin.entity !== (kind === 'receivable' ? 'receivables' : 'payables')
    || typeof origin.source_id !== 'string' || !/^[0-9]{1,40}$/.test(origin.source_id) || /^0+$/.test(origin.source_id)
    || typeof origin.batch_id !== 'string' || !uuid.test(origin.batch_id)
    || typeof origin.source_hash !== 'string' || !/^[0-9a-f]{64}$/.test(origin.source_hash)
    || typeof origin.source_version !== 'string' || !/^[1-9][0-9]{0,18}$/.test(origin.source_version) || BigInt(origin.source_version) > 9223372036854775807n
    || typeof origin.imported_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(origin.imported_at) || !Number.isFinite(Date.parse(origin.imported_at))
    || origin.core_fields_locked !== true || origin.cnab_reservation_blocked !== true) return fail();
  return { system: 'origin', entity: kind === 'receivable' ? 'receivables' : 'payables', source_id: origin.source_id, batch_id: origin.batch_id,
    imported_at: origin.imported_at, source_hash: origin.source_hash, source_version: origin.source_version,
    core_fields_locked: true, cnab_reservation_blocked: true };
}
