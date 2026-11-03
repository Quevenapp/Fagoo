import { useEffect, useState } from 'react';
import type { AccessController } from '../lib/real-access';

// Origin "Atenção — Este pedido possui pendências cadastrais para emissão de nota fiscal" (202610200131): grouped by section,
// with Ocultar/Mostrar. Read from the current cadastros on every open; a failed read (or a database before 131) shows nothing.
type Pendency = { section: string; message: string };
export default function DocumentPendencies({ controller, documentId, version }: { controller: Pick<AccessController, 'documents' | 'getSnapshot'>; documentId: string; version: number }) {
  const [items, setItems] = useState<Pendency[] | null>(null), [open, setOpen] = useState(true);
  useEffect(() => {
    const request = new AbortController(), actor = controller.getSnapshot?.()?.membership?.user_id ?? null; setItems(null);
    void Promise.resolve().then(() => controller.documents(`/v1/documentos/sales_orders/${documentId}/pendencias`, { signal: request.signal })).then(value => {
      const result = value as { document?: { id?: unknown }; pendencies?: unknown } | null;
      if (request.signal.aborted || (controller.getSnapshot?.()?.membership?.user_id ?? null) !== actor || result?.document?.id !== documentId || !Array.isArray(result.pendencies)) return;
      setItems((result.pendencies as Pendency[]).filter(item => typeof item?.section === 'string' && typeof item?.message === 'string'));
    }).catch(() => { /* Without the check the editor keeps working; the server still validates the nota. */ });
    return () => request.abort();
  }, [controller, documentId, version]);
  if (!items?.length) return null;
  const sections = [...new Set(items.map(item => item.section))];
  return <section className="document-pendencies" role="status" aria-label="Pendências cadastrais">
    <p><strong>Atenção</strong> — Este pedido possui pendências cadastrais para emissão de nota fiscal. <button type="button" className="text-button" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? 'Ocultar' : 'Mostrar'}</button></p>
    {open && <ul>{sections.map(section => <li key={section}><strong>{section}</strong><ul>{items.filter(item => item.section === section).map(item => <li key={item.message}>{item.message}</li>)}</ul></li>)}</ul>}
  </section>;
}
