import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DocumentPrintSheet, DocumentReceiptSheet } from './DocumentPrintPreview';
import { documentPrintModel, type PrintOptions } from '../lib/document-print-model';
// Produtos lane (wave D): "Código no fornecedor" of the purchase order print.
import { useSupplierCodes } from '../hooks/useSupplierCodes';
// 202610200240: the structures for "Desmembrar produtos da estrutura" and "Ocultar itens produzidos por terceiros".
import { useDocumentStructures } from '../hooks/useDocumentStructures';
// 202610200270 "Exibir tipo de cabeçalho: Personalizado".
import { usePrintHeader } from '../hooks/usePrintHeader';
import type { DocumentRecord } from '../lib/real-documents-model';
import type { CompanyController, CompanyEnvelope, CompanyRecord } from '../lib/company-model';
import './document-print.css';
import './document-list.css';
import { isMirrorRecord, type DocumentReadRecord } from '../lib/document-mirror-model';
import { DocumentMirrorSheet } from './DocumentMirrorView';

/** "Imprimir selecionados": the saved versions read one by one in the batch, one A4 sheet per document. */
/** `receipt` prints the Origin "Comprovantes selecionados"; `options` carries the "Opções de impressão". */
type BatchPrintProps = { records: readonly DocumentReadRecord[]; controller: CompanyController; onClose: () => void; receipt?: boolean; options?: PrintOptions };
export default function DocumentBatchPrint({ records, controller, onClose, receipt = false, options = {} }: BatchPrintProps) {
  const nativeRecords = useMemo(() => records.filter((record): record is DocumentRecord => !isMirrorRecord(record)), [records]);
  const dialog = useRef<HTMLDivElement>(null), close = useRef<HTMLButtonElement>(null), onCloseRef = useRef(onClose);
  const [printError, setPrintError] = useState(false);
  const [company, setCompany] = useState<CompanyRecord | null>(null); const [companyState, setCompanyState] = useState<'loading' | 'ready' | 'error'>('loading'); const [companyReload, setCompanyReload] = useState(0);
  onCloseRef.current = onClose;
  const [portal] = useState(() => { const node = document.createElement('div'); node.className = 'document-print-root'; return node; });
  const lookup = useSupplierCodes(controller, nativeRecords, options.prefs), codes = lookup.codes;
  const structures = useDocumentStructures(controller, nativeRecords, Boolean(options.explode || options.hideThirdParty)), rows = structures.structures;
  const header = usePrintHeader(controller, nativeRecords[0]?.kind ?? 'sales_orders', Boolean(nativeRecords.length) && !receipt && options.prefs?.headerType === 'personalizado');
  const models = useMemo(() => records.map(record => { if (isMirrorRecord(record)) return { id: record.id, mirror: record, model: null }; try { return { id: record.id, mirror: null, model: documentPrintModel(record, company, { ...options, ...(codes[record.id] ? { supplierCodes: codes[record.id] } : {}), structures: rows[record.id] ?? null, customHeader: header.header }) }; } catch { return { id: record.id, mirror: null, model: null }; } }), [records, company, options.detailed, options.order, options.explode, options.hideThirdParty, codes, rows, header.header]);
  const invalid = models.some(item => !item.model && !item.mirror);
  useEffect(() => {
    if (!nativeRecords.length) { setCompanyState('ready'); return; }
    const request = new AbortController(); setCompanyState('loading'); setCompany(null);
    void controller.company('/v1/empresa/identidade', { signal: request.signal }).then(value => {
      const response = value as CompanyEnvelope<CompanyRecord>;
      if (!response || response.section !== 'identity' || response.data_mode !== 'erp_native' || response.emission_enabled !== false || response.record === undefined) throw new Error('PRINT_COMPANY_RESPONSE_INVALID');
      if (response.record !== null && (!response.record || typeof response.record !== 'object' || !Number.isInteger(response.record.version) || !response.record.data)) throw new Error('PRINT_COMPANY_RESPONSE_INVALID');
      if (!request.signal.aborted) { setCompany(response.record); setCompanyState('ready'); }
    }).catch(() => { if (!request.signal.aborted) setCompanyState('error'); });
    return () => request.abort();
  }, [controller, companyReload, nativeRecords.length]);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow, siorigins = Array.from(document.body.children).filter((element): element is HTMLElement => element instanceof HTMLElement && element !== portal).map(element => ({ element, inert: element.inert }));
    document.body.append(portal); document.body.style.overflow = 'hidden'; document.body.classList.add('document-print-open');
    for (const { element } of siorigins) element.inert = true;
    close.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onCloseRef.current(); return; }
      if (event.key !== 'Tab') return;
      const fields = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]),[tabindex="0"]') || []), first = fields[0], last = fields.at(-1);
      if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); for (const { element, inert } of siorigins) element.inert = inert; document.body.style.overflow = overflow; document.body.classList.remove('document-print-open'); portal.remove(); if (previous?.isConnected) previous.focus(); };
  }, [portal]);
  return createPortal(<div className="document-print-dialog" role="dialog" aria-modal="true" aria-labelledby="document-batch-print-title" ref={dialog}>
    <header className="document-print-controls"><div><h2 id="document-batch-print-title">Prévia para impressão · {records.length} {records.length === 1 ? 'documento' : 'documentos'}</h2><p>Versões salvas, uma por página, com a identificação atual da empresa. Observações internas, regime fiscal e anexos não são impressos.</p></div><div><button type="button" className="secondary-button" ref={close} onClick={onClose}>Fechar prévia</button><button type="button" className="primary-button" disabled={invalid || companyState !== 'ready' || !records.length || lookup.loading || structures.loading || header.loading} onClick={() => { setPrintError(false); try { window.print(); } catch { setPrintError(true); } }}>Imprimir documentos</button></div></header>
    {companyState === 'loading' && <p className="document-print-error" role="status">Consultando identificação da empresa…</p>}{companyState === 'error' && <p className="document-print-error" role="alert">Não foi possível conferir a identificação da empresa. <button type="button" onClick={() => setCompanyReload(value => value + 1)}>Tentar novamente</button></p>}
    {lookup.loading && <p className="document-print-error" role="status">Consultando os códigos no fornecedor…</p>}
    {structures.loading && <p className="document-print-error" role="status">Consultando a estrutura dos produtos…</p>}
    {header.loading && <p className="document-print-error" role="status">Consultando o cabeçalho personalizado…</p>}{header.failed && <p className="document-print-error" role="status">Não foi possível consultar o cabeçalho personalizado; os documentos saem com o cabeçalho padrão.</p>}
    {structures.unchecked > 0 && <p className="document-print-error" role="status">A estrutura dos produtos foi consultada nos 50 primeiros pedidos; os outros {structures.unchecked} saem sem desmembrar e sem ocultar itens.</p>}
    {structures.failed > 0 && <p className="document-print-error" role="status">Não foi possível consultar a estrutura de {structures.failed} pedido(s); eles saem sem ela.</p>}
    {lookup.unchecked > 0 && <p className="document-print-error" role="status">Os códigos no fornecedor foram consultados nos 50 primeiros pedidos. {lookup.unchecked === 1 ? 'Um pedido sai' : `${lookup.unchecked} pedidos saem`} sem o Código secundário; imprima-os em outro lote para ver os códigos.</p>}
    {printError && <p className="document-print-error" role="alert">Não foi possível abrir a impressão. Confira as permissões do navegador e tente novamente.</p>}
    <div className="document-print-scroll document-batch-print" tabIndex={0} aria-label="Documentos para impressão">{companyState !== 'ready' ? <p className="document-print-blocked">Documentos indisponíveis para impressão: a identificação da empresa ainda não foi conferida.</p>
      : invalid ? <p className="document-print-blocked" role="alert">Não foi possível conferir os valores de um dos documentos. Feche a prévia e repita a impressão.</p>
        : models.map(item => item.mirror ? <DocumentMirrorSheet key={item.id} record={item.mirror} /> : receipt ? <DocumentReceiptSheet key={item.id} model={item.model!} format="a4" /> : <DocumentPrintSheet key={item.id} model={item.model!} />)}</div>
  </div>, portal);
}
