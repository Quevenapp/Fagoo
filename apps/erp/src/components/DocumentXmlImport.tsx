import { useEffect, useRef, useState } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import type { DocumentKind } from '../lib/real-documents-model';
import { XML_IMPORT_MAX_BYTES, XML_IMPORT_REFUSED, importDraft, readXmlImport, type ImportDraft } from '../lib/document-xml-import-model';
import { Modal } from './Modal';

type Controller = Pick<AccessController, 'documents' | 'getSnapshot'>;
const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const actorOf = (controller: Controller) => controller.getSnapshot()?.membership?.user_id ?? null;

/**
 * Origin "Importar › Pedido XML" (upload + Processar): reads the XML of an authorized NF-e, looks up the contact and the products
 * and opens a new pedido in the form. A read only: nothing is saved until the user reviews and saves the pedido.
 */
export default function DocumentXmlImport({ controller, kind, today, onClose, onImported }: {
  controller: Controller; kind: Extract<DocumentKind, 'sales_orders' | 'purchase_orders'>; today: string; onClose: () => void; onImported: (draft: ImportDraft) => void;
}) {
  const [file, setFile] = useState<File | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; pending.current?.abort(); }; }, []);
  const process = async () => {
    if (!file || busy || pending.current) return;
    if (file.size > XML_IMPORT_MAX_BYTES) { setError('O arquivo passa de 1 MB.'); return; }
    const request = new AbortController(), actor = actorOf(controller); pending.current = request; setBusy(true); setError('');
    try {
      const xml = await file.text();
      const value = await controller.documents(`/v1/documentos/${kind}/importar-xml`, { method: 'POST', body: { xml }, signal: request.signal });
      if (request.signal.aborted || !mounted.current) return;
      if (actorOf(controller) !== actor) { setError('A sessão mudou durante a leitura. Repita a importação.'); return; }
      let read; try { read = readXmlImport(value); } catch { throw new AccessError(502); }
      onImported(importDraft(kind, read, today));
    } catch (failure) {
      if (request.signal.aborted || aborted(failure) || !mounted.current) return;
      setError(failure instanceof AccessError ? failure.status === 422 || failure.status === 400 ? XML_IMPORT_REFUSED : failure.status === 403 ? 'Seu perfil não permite incluir pedidos.' : 'Não foi possível ler o XML agora. Tente novamente.' : 'Não foi possível ler o arquivo.');
    } finally { if (pending.current === request) pending.current = null; if (mounted.current && !request.signal.aborted) setBusy(false); }
  };
  return <Modal title={kind === 'purchase_orders' ? 'Importar pedido de compra (XML da NF-e)' : 'Importar pedido (XML da NF-e)'} onClose={() => { if (!busy) onClose(); }}
    actions={<><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Cancelar</button><button type="button" className="primary-button" disabled={!file || busy} onClick={() => void process()}>{busy ? 'Processando…' : 'Processar'}</button></>}>
    <div className="form-field"><label htmlFor="document-xml-file">Arquivo XML da NF-e</label>
      <input id="document-xml-file" type="file" accept=".xml,application/xml,text/xml" disabled={busy} onChange={event => { setFile(event.target.files?.[0] ?? null); setError(''); }} /></div>
    <p className="real-help">{kind === 'purchase_orders' ? 'O fornecedor é o emitente da nota.' : 'O cliente é o destinatário da nota.'} Contato e produtos são procurados pelo CPF/CNPJ, pelo GTIN e pelo código; o pedido abre para conferência e só é gravado ao salvar.</p>
    {error && <p className="real-alert" role="alert">{error}</p>}
  </Modal>;
}
