import { useEffect, useRef, useState } from 'react';
import { AccessError, decimalMoney, type AccessController } from '../lib/real-access';
import { originDetail, type OriginDetail } from '../../../../packages/erp-domain/src/fiscal-invoice-contract.mjs';
import { verifySyncedXmlBlob } from '../lib/synced-xml-model';
import { ORIGIN_DANFE_REASON, ORIGIN_FISCAL_READONLY_REASON, FISCAL_BASE, brDay, statusClass, statusLabel, type ScreenConfig } from '../lib/fiscal-invoice-list-model';
import { Modal } from './Modal';
import { Icon } from './Icon';

const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const SYNCED = '/v1/xmls-sincronizados';
/**
 * Downloads an archived Origin XML only after its size and SHA-256 match the list metadata (same check as the
 * synced XML history). Returns the text for "Ver o XML da nota"; with download=true also saves the file.
 */
export async function downloadVerifiedXml(controller: AccessController, file: { id: string; hash: string; size: number }, model: '55' | '65', signal: AbortSignal, download: boolean): Promise<string> {
  const blob = await controller.syncedXmlDownload(`${SYNCED}/${file.id}/download`, signal);
  const verified = await verifySyncedXmlBlob(blob, { size_bytes: file.size, xml_hash: file.hash }, signal);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(await verified.arrayBuffer());
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  if (download) {
    const address = URL.createObjectURL(verified), link = document.createElement('a');
    try { link.href = address; link.download = `origin-${model}-${file.hash.slice(0, 12)}.xml`; document.body.appendChild(link); link.click(); }
    finally { link.remove(); setTimeout(() => URL.revokeObjectURL(address), 1000); }
  }
  return text;
}

/** Nota do Origin aberta em leitura: o Origin continua sendo o emissor durante a convivência. */
export default function FiscalOriginInvoiceView({ controller, config, sourceId, writable, onBack }: {
  controller: AccessController; config: ScreenConfig; sourceId: string; writable: boolean; onBack: () => void;
}) {
  const [detail, setDetail] = useState<OriginDetail | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(true), [reload, setReload] = useState(0);
  const [xml, setXml] = useState<string | null>(null), [xmlError, setXmlError] = useState(''), [notice, setNotice] = useState('');
  const download = useRef<AbortController | null>(null);
  useEffect(() => {
    const request = new AbortController(); setLoading(true); setError('');
    void Promise.resolve().then(() => controller.fiscalInvoices(`${FISCAL_BASE}/origin/${config.model === '55' ? 'nfe' : 'nfce'}/${sourceId}`, { signal: request.signal })).then(value => {
      if (request.signal.aborted) return;
      const checked = originDetail(value);
      if (checked.source_id !== sourceId || checked.model !== config.model) throw new AccessError(502);
      setDetail(checked); setLoading(false);
    }).catch(problem => { if (!request.signal.aborted && !aborted(problem)) { setLoading(false); setError(problem instanceof AccessError && problem.status === 404 ? 'Nota não encontrada no espelho do Origin.' : 'Não foi possível carregar ou conferir a nota do Origin.'); } });
    return () => { request.abort(); download.current?.abort(); };
  }, [controller, config.model, sourceId, reload]);
  const getXml = async (save: boolean) => {
    if (!detail?.xml || download.current) return;
    const request = new AbortController(); download.current = request; setXmlError('');
    try { const text = await downloadVerifiedXml(controller, detail.xml, config.model, request.signal, save); if (!request.signal.aborted && !save) setXml(text); }
    catch (problem) { if (!request.signal.aborted && !aborted(problem)) setXmlError('Não foi possível conferir o XML. Nenhum arquivo foi entregue.'); }
    finally { if (download.current === request) download.current = null; }
  };
  const copy = async () => { if (!detail?.access_key) return; try { await globalThis.navigator?.clipboard?.writeText(detail.access_key); setNotice('Chave de acesso copiada.'); } catch { setXmlError('Não foi possível copiar a chave de acesso.'); } };
  const row = detail ? { status: detail.status, status_raw: detail.status_raw } : null;
  return <section className="fiscal-invoice-view">
    <header className="real-heading"><div><h1>{config.model === '65' ? 'NFC-e' : 'Nota fiscal'} - {detail?.number ? String(detail.number).padStart(6, '0') : '…'}</h1>
      <p>Nota emitida pelo Origin, somente leitura. Envio, cancelamento, correção e lançamentos continuam no Origin durante a convivência.</p></div>
      <div className="real-editor-actions"><button type="button" className="secondary-button" onClick={onBack}>Voltar</button>
        {writable && detail && <><button type="button" className="secondary-button" disabled title={ORIGIN_FISCAL_READONLY_REASON}>Clonar nota</button>{config.model === '55' && <button type="button" className="secondary-button" disabled title={ORIGIN_FISCAL_READONLY_REASON}>{config.direction === '1' ? 'Clonar para entrada' : 'Clonar para saída'}</button>}</>}</div></header>
    {loading && <p role="status">Carregando nota do Origin…</p>}
    {error && <p className="real-alert" role="alert">{error}<button type="button" className="text-button" onClick={() => setReload(n => n + 1)}>Tentar novamente</button></p>}
    {notice && <p className="real-success" role="status">{notice}</p>}
    {xmlError && <p className="real-alert" role="alert">{xmlError}</p>}
    {detail && row && <>
      <dl className="fiscal-view-grid">
        <div><dt>Situação</dt><dd><span className={statusClass(row, config.model)}>{statusLabel(row, config.model)}</span></dd></div>
        <div><dt>Série</dt><dd>{detail.series ?? '—'}</dd></div><div><dt>Número</dt><dd>{detail.number ?? '—'}</dd></div>
        <div><dt>Data de emissão</dt><dd>{brDay(detail.issue_date)}</dd></div><div><dt>{config.direction === '0' ? 'Data entrada' : 'Data saída'}</dt><dd>{brDay(detail.operation_date)}</dd></div>
        <div><dt>Chave de acesso</dt><dd className="fiscal-key">{detail.access_key ?? '—'}</dd></div><div><dt>Protocolo</dt><dd>{detail.xml?.protocol ?? '—'}</dd></div>
        <div><dt>Total da Nota (R$)</dt><dd>{detail.total_known ? decimalMoney(detail.total) : '—'}</dd></div>{detail.freight && <div><dt>Valor do Frete (R$)</dt><dd>{decimalMoney(detail.freight)}</dd></div>}
      </dl>
      <div className="real-editor-actions">
        <button type="button" className="secondary-button" disabled={!detail.xml} title={detail.xml ? undefined : 'O XML desta nota ainda não foi coletado do Origin.'} onClick={() => void getXml(false)}><Icon name="file-code" size={13} /> Ver o XML da nota</button>
        <button type="button" className="secondary-button" disabled={!detail.xml} title={detail.xml ? undefined : 'O XML desta nota ainda não foi coletado do Origin.'} onClick={() => void getXml(true)}><Icon name="download" size={13} /> Baixar XML</button>
        <button type="button" className="secondary-button" disabled={!detail.access_key} onClick={() => void copy()}><Icon name="copy" size={13} /> Copiar chave de acesso</button>
        <button type="button" className="secondary-button" disabled title={ORIGIN_DANFE_REASON}><Icon name="print" size={13} /> Imprimir DANFE</button>
      </div>
      <p className="real-help">{ORIGIN_FISCAL_READONLY_REASON} {ORIGIN_DANFE_REASON}</p>
      <section className="document-section"><h2>{config.direction === '0' ? 'Remetente' : 'Destinatário'}</h2><dl className="fiscal-view-grid">
        {([['Nome do contato', detail.contact.name], ['CNPJ / CPF', detail.contact.document], ['Inscrição Estadual', detail.contact.ie], ['E-mail', detail.contact.email], ['Fone/FAX', detail.contact.phone],
          ['Endereço', [detail.contact.street, detail.contact.number, detail.contact.complement].filter(Boolean).join(', ') || null], ['Bairro', detail.contact.district], ['CEP', detail.contact.postal_code],
          ['Município', detail.contact.city], ['UF', detail.contact.state]] as const).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || '—'}</dd></div>)}</dl></section>
      <section className="document-section"><h2>Itens da nota fiscal</h2>{detail.items.length ? <div className="table-scroll" tabIndex={0}><table className="data-table"><thead><tr><th>#</th><th>Produto ou serviço</th><th>Código</th><th>UN</th><th className="numeric">Qtde</th><th className="numeric">Preço un</th><th className="numeric">Preço total</th><th>NCM</th><th>CFOP</th></tr></thead>
        <tbody>{detail.items.map((item, index) => <tr key={index}><td>{index + 1}</td><td>{item.description ?? '—'}</td><td>{item.code ?? '—'}</td><td>{item.unit ?? '—'}</td><td className="numeric">{item.quantity ?? '—'}</td><td className="numeric">{item.unit_price ?? '—'}</td><td className="numeric">{item.total ? decimalMoney(item.total) : '—'}</td><td>{item.ncm ?? '—'}</td><td>{item.cfop ?? '—'}</td></tr>)}</tbody></table></div> : <p className="real-help">A coleta do Origin não trouxe os itens desta nota.</p>}</section>
      {detail.installments.length > 0 && <section className="document-section"><h2>Pagamento</h2><table className="data-table"><thead><tr><th>Data</th><th className="numeric">Valor</th><th>Observação</th></tr></thead><tbody>{detail.installments.map((i, index) => <tr key={index}><td>{brDay(i.date)}</td><td className="numeric">{i.amount ? decimalMoney(i.amount) : '—'}</td><td>{i.note ?? ''}</td></tr>)}</tbody></table></section>}
      {(detail.transport.carrier || detail.transport.freight_by) && <section className="document-section"><h2>Transportador/Volumes</h2><p>{detail.transport.carrier ?? 'Sem transportadora'}{detail.transport.freight_by ? ` · Frete por conta ${detail.transport.freight_by}` : ''}</p></section>}
      {detail.additional_info && <section className="document-section"><h2>Informações adicionais</h2><p className="fiscal-pre">{detail.additional_info}</p></section>}
      {detail.events.length > 0 && <section className="document-section"><h2>Eventos</h2><ul>{detail.events.map(e => <li key={e.id}>{e.type === '110110' ? 'Carta de correção' : e.type === '110111' ? 'Cancelamento' : `Evento ${e.type ?? ''}`}{e.sequence ? ` · sequência ${e.sequence}` : ''}</li>)}</ul></section>}
      <p className="real-help">Observada no Origin em {new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(Date.parse(detail.observed_at))}.</p>
    </>}
    {xml !== null && <Modal title="XML da nota" onClose={() => setXml(null)} actions={<button type="button" className="secondary-button" onClick={() => setXml(null)}>Fechar</button>}><pre className="fiscal-xml-view" tabIndex={0}>{xml}</pre></Modal>}
  </section>;
}
