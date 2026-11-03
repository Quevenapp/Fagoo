import { useEffect, useState } from 'react';
import { printHeaderPath, readPrintHeader } from '../lib/print-header-model';
import type { RichText } from '../lib/rich-text-model';
import type { DocumentKind } from '../lib/real-documents-model';

type Port = { documents?: (path: string, options?: { signal?: AbortSignal }) => Promise<unknown> };
/**
 * 202610200270: the "Cabeçalho personalizado" of the prints of a kind, read only when the Preferências choose "Personalizado". The
 * print waits for it; a failed read (or an empty header) keeps the standard header of the company and says so.
 */
export function usePrintHeader(controller: unknown, kind: DocumentKind, wanted: boolean): { loading: boolean; header: RichText | null; failed: boolean } {
  const port = controller as Port;
  const [state, setState] = useState<{ key: string; header: RichText | null; failed: boolean } | null>(null);
  const key = `${kind}:${wanted}`;
  useEffect(() => {
    if (!wanted || typeof port.documents !== 'function') return;
    const request = new AbortController();
    void Promise.resolve().then(() => port.documents!(printHeaderPath(kind), { signal: request.signal })).then(value => {
      if (!request.signal.aborted) setState({ key, header: readPrintHeader(value, kind).content, failed: false });
    }).catch(() => { if (!request.signal.aborted) setState({ key, header: null, failed: true }); });
    return () => request.abort();
  }, [controller, kind, wanted]);
  if (!wanted || typeof port.documents !== 'function') return { loading: false, header: null, failed: false };
  return state?.key === key ? { loading: false, header: state.header, failed: state.failed } : { loading: true, header: null, failed: false };
}
