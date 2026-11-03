import { AccessError, type NativeRequestOptions } from './real-access.ts';
import { EXPORT_BLOCK, EXPORT_LIMIT, contactFilterParams, type ContactListState } from './contact-list-model.ts';
import type { ContactRecord } from './contact-form-model.ts';

// Exportar para a planilha, Imprimir listagem e Aniversariantes: os mesmos filtros da listagem, lidos em blocos de 100
// (o Worker responde até 1 MiB), até 10.000 contatos. Um total que muda no meio da leitura interrompe tudo.
export type ExportKind = 'contacts' | 'birthdays';
type Port = { catalog: (path: string, options?: NativeRequestOptions) => Promise<unknown> };
export class ExportTooLarge extends Error {}
export async function fetchContactRows(controller: Port, kind: ExportKind, state: Omit<ContactListState, 'page'>, { birthFrom, birthTo, signal, onProgress }: { birthFrom?: string; birthTo?: string; signal: AbortSignal; onProgress?: (done: number, total: number) => void }) {
  const rows: ContactRecord[] = []; let total = -1;
  for (let offset = 0; total < 0 || offset < total;) {
    const params = contactFilterParams(new URLSearchParams({ kind, offset: String(offset), limit: String(EXPORT_BLOCK) }), state);
    if (kind === 'birthdays') { params.set('birth_from', birthFrom ?? ''); params.set('birth_to', birthTo ?? ''); }
    let result: { kind?: string; offset?: number; total?: number; items?: ContactRecord[] };
    try { result = await controller.catalog(`/v1/cadastros/contatos/exportar?${params}`, { signal }) as typeof result; }
    // Only the too-large refusal is "too large" (an API without the specific codes answered a plain 400 for it).
    catch (failure) { if (offset === 0 && failure instanceof AccessError && failure.status === 400 && (failure.code === undefined || failure.code === 'ERP_CONTACT_EXPORT_TOO_LARGE')) throw new ExportTooLarge(); throw failure; }
    if (signal.aborted) throw new DOMException('Request cancelled', 'AbortError');
    if (result.kind !== kind || result.offset !== offset || !Array.isArray(result.items) || !Number.isSafeInteger(result.total) || (result.total as number) > EXPORT_LIMIT) throw new AccessError(502);
    if (total < 0) total = result.total as number; else if (result.total !== total) throw new Error('EXPORT_CHANGED');
    if (!result.items.length) break;
    rows.push(...result.items); offset += result.items.length; onProgress?.(rows.length, total);
  }
  return rows;
}
