import { useEffect, useState } from 'react';
import { parseReference, referencePath, type PlatformPort, type ReferenceDataset, type ReferenceItem, type ReferenceTable } from '../lib/platform-model';

/** Leva H (PRF-296, CTT-045, VND-042): suggestions from the official tables embedded in the database, for a datalist. Typing
 * waits 250 ms; without the API (demo, tests) or on a failure there are no suggestions and the field still accepts the value. */
export function useReferenceOptions(controller: Partial<PlatformPort> | null | undefined, table: ReferenceTable, query: string, { uf = null, enabled = true, minLength = 2 }: { uf?: string | null; enabled?: boolean; minLength?: number } = {}) {
  const [items, setItems] = useState<ReferenceItem[]>([]), [dataset, setDataset] = useState<ReferenceDataset | null>(null);
  const q = query.trim();
  useEffect(() => {
    if (!enabled || typeof controller?.platform !== 'function' || q.length < minLength) { setItems([]); return; }
    const request = new AbortController();
    const timer = setTimeout(() => {
      void controller.platform!(referencePath(table, q, uf), { method: 'GET', signal: request.signal }).then(raw => {
        if (request.signal.aborted) return; const value = parseReference(raw, table); setItems(value.items); setDataset(value.dataset);
      }).catch(() => { if (!request.signal.aborted) setItems([]); });
    }, 250);
    return () => { clearTimeout(timer); request.abort(); };
  }, [controller, table, q, uf, enabled, minLength]);
  return { items, dataset };
}
