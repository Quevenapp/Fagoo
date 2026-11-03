import { useEffect, useState } from 'react';
import type { DocumentRecord } from '../lib/real-documents-model';
import { fileHash } from '../lib/attachment-model';
import { imageDataUrl, productImagesPath, readStoredImages } from '../lib/product-images-model';

type Port = {
  documents?: (path: string, options?: { signal?: AbortSignal }) => Promise<unknown>;
  attachments?: (path: string, options?: { download?: boolean; signal?: AbortSignal }) => Promise<unknown>;
};
/** At most this many products have their image printed (each image is one list and one download of up to 2 MB). */
export const PRINT_IMAGE_PRODUCTS = 30;
type Extras = { images: Record<string, string> | null; descriptions: Record<string, string> | null };
/**
 * 202610200294: what the print reads besides the document: the first stored image of each product (Vendas "Exibir imagem do produto na
 * venda detalhada", Propostas "Exibir imagem de produtos") as a data: URL (the CSP allows img-src data: only), and the description of
 * the product at the supplier ("Exibir descrição do produto no fornecedor"). The print waits; a failed read prints without them.
 */
export function usePrintExtras(controller: unknown, record: DocumentRecord, wanted: { images: boolean; descriptions: boolean }): Extras & { loading: boolean; failed: boolean } {
  const port = controller as Port;
  const products = [...new Set(record.items.map(item => item.product_id).filter((id): id is string => Boolean(id)))].slice(0, PRINT_IMAGE_PRODUCTS);
  const key = `${record.id}:${record.version}:${wanted.images}:${wanted.descriptions}`;
  const [state, setState] = useState<{ key: string; failed: boolean } & Extras | null>(null);
  useEffect(() => {
    if (!wanted.images && !wanted.descriptions) return;
    const request = new AbortController(), signal = request.signal;
    void (async () => {
      let failed = false;
      const images: Record<string, string> = {}, descriptions: Record<string, string> = {};
      if (wanted.images && typeof port.attachments === 'function') for (const id of products) {
        try {
          const first = readStoredImages(await port.attachments(productImagesPath(id), { signal }), id).items[0];
          if (!first) continue;
          const blob = await port.attachments(productImagesPath(id, first.id, 'download'), { download: true, signal }) as Blob;
          // The bytes are checked by size and SHA-256 (as the product form does); an image that does not match is not printed.
          if (!(blob instanceof Blob) || blob.size !== first.size_bytes || await fileHash(blob) !== first.sha256) { failed = true; continue; }
          images[id] = await imageDataUrl(blob, first.mime_type);
        } catch { if (signal.aborted) return; failed = true; }
      }
      if (wanted.descriptions && typeof port.documents === 'function') {
        try {
          const value = await port.documents(`/v1/documentos/${record.kind}/${record.id}/descricoes-fornecedor`, { signal }) as { document_id?: string; items?: { item_id: string; description: string }[] };
          if (value?.document_id !== record.id || !Array.isArray(value.items)) throw new Error('PRINT_SUPPLIER_DESCRIPTIONS_INVALID');
          for (const item of value.items) descriptions[item.item_id] = item.description;
        } catch { if (signal.aborted) return; failed = true; }
      }
      if (!signal.aborted) setState({ key, failed, images: wanted.images ? images : null, descriptions: wanted.descriptions ? descriptions : null });
    })();
    return () => request.abort();
  }, [controller, key]);
  if (!wanted.images && !wanted.descriptions) return { loading: false, failed: false, images: null, descriptions: null };
  return state?.key === key ? { loading: false, failed: state.failed, images: state.images, descriptions: state.descriptions } : { loading: true, failed: false, images: null, descriptions: null };
}
