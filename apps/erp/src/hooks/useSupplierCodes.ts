import { useEffect, useMemo, useState } from 'react';
import type { AccessController } from '../lib/real-access';
import type { DocumentRecord } from '../lib/real-documents-model';
import type { DocumentPrintPreferences } from '../lib/document-preferences';
import { supplierCodes, supplierCodesPath } from '../lib/document-supplier-codes';

/** At most this many orders are looked up per print (one read of the products for each order). */
export const SUPPLIER_CODES_LOOKUP_LIMIT = 50;
export interface SupplierCodesState {
  /** Record id → product id → code at the supplier of that order. */
  codes: Record<string, Record<string, string | null>>;
  /** True while the codes of this set of records are being read: the print waits for them. */
  loading: boolean;
  /** Orders that need the codes but were not looked up (beyond the first 50 of the print). */
  unchecked: number;
}

/**
 * Pedido de compra, "Código secundário: Código no fornecedor" (produtos lane, wave D): the code of each product at the supplier of
 * each printed order, by record id. Read only when the preference asks for it; a failed read (for example a profile that does not
 * read products) leaves the column empty instead of blocking the print. At most 50 orders are looked up per print; `unchecked` says
 * how many others print without the code, and `loading` keeps the Imprimir button waiting until the reads end.
 */
export function useSupplierCodes(controller: unknown, records: readonly DocumentRecord[], prefs: DocumentPrintPreferences | null | undefined): SupplierCodesState {
  const [state, setState] = useState<{ key: string; codes: Record<string, Record<string, string | null>> }>({ key: '', codes: {} });
  const key = `${records.map(record => `${record.id}:${record.version}`).join(',')}|${prefs?.secondaryCode ?? ''}`;
  const port = controller as Partial<Pick<AccessController, 'catalog'>> | null;
  const lookups = useMemo(() => records.map(record => ({ record, path: supplierCodesPath(record, prefs) })).filter((entry): entry is { record: DocumentRecord; path: string } => entry.path !== null),
    [key]);
  const enabled = lookups.length > 0 && typeof port?.catalog === 'function';
  useEffect(() => {
    if (!enabled) return;
    const request = new AbortController(), wanted = lookups.slice(0, SUPPLIER_CODES_LOOKUP_LIMIT);
    void Promise.all(wanted.map(({ record, path }) => Promise.resolve().then(() => port!.catalog!(path, { signal: request.signal })).then(value => [record.id, supplierCodes(value, record)] as const).catch(() => null)))
      .then(entries => { if (!request.signal.aborted) setState({ key, codes: Object.fromEntries(entries.filter((entry): entry is readonly [string, Record<string, string | null>] => entry !== null)) }); });
    return () => request.abort();
  }, [controller, key, enabled]);
  return { codes: state.key === key ? state.codes : {}, loading: enabled && state.key !== key, unchecked: enabled ? Math.max(0, lookups.length - SUPPLIER_CODES_LOOKUP_LIMIT) : 0 };
}
