import { useEffect, useState } from 'react';
import type { AccessController } from '../lib/real-access';
import type { DocumentRecord } from '../lib/real-documents-model';
import { readStructures, structurePath, type StructureItem } from '../lib/document-structure-model';

/** At most this many documents are read per print (one read of the structures for each). */
export const STRUCTURES_LOOKUP_LIMIT = 50;
export interface StructuresState {
  /** Record id → structure items of its products (only documents with linked products are read). */
  structures: Record<string, StructureItem[]>;
  /** True while the structures are being read: the print waits for them. */
  loading: boolean;
  /** Documents beyond the first 50 printed without the structure. */
  unchecked: number;
  /** Records whose structure could not be read (they print without it). */
  failed: number;
}

/**
 * 202610200240: the structure (Estoque › composições) and the Produção of the products of each printed document, read only when
 * a print option asks for it ("Desmembrar produtos da estrutura", "Ocultar itens produzidos por terceiros", Relatório de Produção
 * with "Exibir estrutura de itens"). A failed read prints the document without it and says so.
 */
export function useDocumentStructures(controller: unknown, records: readonly DocumentRecord[], enabled: boolean): StructuresState {
  const [state, setState] = useState<{ key: string; structures: Record<string, StructureItem[]>; failed: number }>({ key: '', structures: {}, failed: 0 });
  const wanted = enabled ? records.filter(record => record.items.some(item => item.product_id)) : [];
  const key = `${enabled}|${wanted.map(record => `${record.id}:${record.version}`).join(',')}`;
  const port = controller as Partial<Pick<AccessController, 'documents'>> | null;
  const active = wanted.length > 0 && typeof port?.documents === 'function';
  useEffect(() => {
    if (!active) return;
    const request = new AbortController(), read = wanted.slice(0, STRUCTURES_LOOKUP_LIMIT);
    void Promise.all(read.map(record => Promise.resolve().then(() => port!.documents!(structurePath(record.kind, record.id), { signal: request.signal }))
      .then(value => [record.id, readStructures(value, record.kind, record.id)] as const).catch(() => null)))
      .then(entries => {
        if (request.signal.aborted) return;
        const ok = entries.filter((entry): entry is readonly [string, StructureItem[]] => entry !== null);
        setState({ key, structures: Object.fromEntries(ok), failed: entries.length - ok.length });
      });
    return () => request.abort();
  }, [controller, key, active]);
  const ready = state.key === key;
  return { structures: ready ? state.structures : {}, loading: active && !ready, unchecked: active ? Math.max(0, wanted.length - STRUCTURES_LOOKUP_LIMIT) : 0, failed: ready ? state.failed : 0 };
}
