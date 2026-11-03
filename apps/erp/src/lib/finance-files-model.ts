// Anexos das contas e dos lançamentos de Caixas e bancos (SQL 211): caminhos do proxy e leitura conferida das respostas.
export type FinanceFileOwner = 'contas' | 'lancamentos';
export type FinanceFileRecord = { id: string; owner_kind: 'title' | 'cash_entry'; owner_id: string; filename: string; mime_type: string; size_bytes: number; sha256: string;
  status: 'reserved' | 'ready' | 'aborted'; created_at: string; finished_at: string | null; deleted: boolean; owner_name: string | null };
export const FINANCE_FILE_LIMIT = 100;
const KIND: Record<FinanceFileOwner, FinanceFileRecord['owner_kind']> = { contas: 'title', lancamentos: 'cash_entry' };
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const MIMES = ['application/pdf', 'image/png', 'image/jpeg', 'application/xml', 'text/plain'];
export const financeFilesPath = (owner: FinanceFileOwner, ownerId: string, id?: string, action?: 'upload' | 'download' | 'abort' | 'exclusao') => {
  if (!UUID.test(ownerId) || (id !== undefined && !UUID.test(id))) throw new Error('Confira o anexo.');
  return `/v1/anexos-financeiro/${owner}/${ownerId}${id ? `/${id}/${action}` : ''}`;
};
function record(value: unknown, owner: FinanceFileOwner, ownerId: string): FinanceFileRecord {
  const row = value as Record<string, unknown> | null;
  if (!row || typeof row.id !== 'string' || !UUID.test(row.id) || row.owner_kind !== KIND[owner] || row.owner_id !== ownerId || typeof row.filename !== 'string' || !MIMES.includes(String(row.mime_type))
    || !Number.isInteger(row.size_bytes) || (row.size_bytes as number) < 1 || (row.size_bytes as number) > 10 * 1024 * 1024 || typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256)
    || !['reserved', 'ready', 'aborted'].includes(String(row.status)) || typeof row.created_at !== 'string' || (row.finished_at !== null && typeof row.finished_at !== 'string')
    || typeof row.deleted !== 'boolean' || (row.owner_name !== null && typeof row.owner_name !== 'string')) throw new Error('Não foi possível conferir os anexos.');
  return row as unknown as FinanceFileRecord;
}
/** GET list of a conta or lançamento: at most 100 rows, all of that owner, none excluded. */
export function financeFiles(value: unknown, owner: FinanceFileOwner, ownerId: string): FinanceFileRecord[] {
  const page = value as { data_mode?: unknown; owner_kind?: unknown; owner_id?: unknown; items?: unknown } | null;
  if (!page || page.data_mode !== 'erp_native' || page.owner_kind !== KIND[owner] || page.owner_id !== ownerId || !Array.isArray(page.items) || page.items.length > FINANCE_FILE_LIMIT) throw new Error('Não foi possível conferir os anexos.');
  const rows = page.items.map(item => record(item, owner, ownerId));
  if (rows.some(row => row.deleted)) throw new Error('Não foi possível conferir os anexos.');
  return rows;
}
/** Envelope of a reserve, upload, abort or exclusão. */
export function financeFileEnvelope(value: unknown, owner: FinanceFileOwner, ownerId: string): FinanceFileRecord {
  const envelope = value as { data_mode?: unknown; attachment?: unknown } | null;
  if (!envelope || envelope.data_mode !== 'erp_native') throw new Error('Não foi possível conferir o anexo.');
  return record(envelope.attachment, owner, ownerId);
}
export const resumableFinanceFile = (row: FinanceFileRecord, size: number, sha: string, mime: string) => row.status === 'reserved' && row.size_bytes === size && row.sha256 === sha && row.mime_type === mime;
