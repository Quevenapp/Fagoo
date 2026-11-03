import { useEffect, useMemo, useState } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import { returnedRecord, type Returned } from '../../../../packages/erp-domain/src/fiscal-invoice-order.mjs';
import { FISCAL_BASE, brDay } from '../lib/fiscal-invoice-list-model';
import { returnLines, type ReturnSourceItem } from '../lib/fiscal-invoice-form-model';
import { Modal } from './Modal';

const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const scaled = (value: string) => { const text = value.replace(',', '.').trim(); if (!/^\d{1,11}(\.\d{1,4})?$/.test(text)) return null; const [whole, fraction = ''] = text.split('.'); return BigInt(whole!) * 10000n + BigInt((fraction + '0000').slice(0, 4)); };
const shown = (value: string) => value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '').replace('.', ',') : value;

/**
 * Modal "Devolução de produto" (Origin, ⋮ Gerar devolução): a nota, o contato, Devolução total | parcial e, por item, o total da nota,
 * o total já devolvido pelas devoluções do Brufap e quanto devolver agora. Confirmar abre a nota de devolução no formulário (finalidade
 * 4, chave em Documento referenciado), para conferir e salvar; o retorno ao estoque e o estorno ou crédito das contas continuam desligados.
 */
export default function FiscalReturnDialog({ controller, accessKey, number, contactName, direction, items, onConfirm, onClose, onFind }: {
  controller: AccessController; accessKey: string; number: number | null; contactName: string | null; direction: '0' | '1'; items: readonly ReturnSourceItem[];
  onConfirm: (quantities: string[]) => void; onClose: () => void;
  /** Wave E: another note by "Nº do pedido" or "Nº da nota fiscal ou chave de acesso" (a barcode reader types the key and Enter); a message when not found. */
  onFind?: (search: { order: string; note: string }) => Promise<string | null>;
}) {
  const [orderSearch, setOrderSearch] = useState(''), [noteSearch, setNoteSearch] = useState(''), [finding, setFinding] = useState(false), [findError, setFindError] = useState('');
  const find = async () => {
    if (!onFind || finding || (!orderSearch.trim() && !noteSearch.trim())) return;
    setFinding(true); setFindError('');
    try { const message = await onFind({ order: orderSearch.trim(), note: noteSearch.trim() }); if (message) setFindError(message); }
    finally { setFinding(false); }
  };
  const [returned, setReturned] = useState<Returned | null>(null), [error, setError] = useState(''), [mode, setMode] = useState<'total' | 'partial'>('total');
  const [values, setValues] = useState<Record<number, string>>({}), [problem, setProblem] = useState('');
  useEffect(() => {
    const request = new AbortController();
    void controller.fiscalInvoices(`${FISCAL_BASE}/devolucoes/${accessKey}`, { signal: request.signal }).then(value => { if (!request.signal.aborted) setReturned(returnedRecord(value, accessKey)); })
      .catch(failure => { if (request.signal.aborted || aborted(failure)) return; setError(failure instanceof AccessError && failure.status === 403 ? 'Seu perfil não consulta as devoluções da nota.' : 'Não foi possível conferir as devoluções desta nota.'); });
    return () => request.abort();
  }, [controller, accessKey]);
  const lines = useMemo(() => returned ? returnLines(items, returned.items) : null, [returned, items]);
  const quantity = (index: number) => mode === 'total' ? lines![index]!.remaining : values[index] ?? lines![index]!.remaining;
  const confirm = () => {
    if (!lines) return;
    const chosen = lines.map((_, index) => quantity(index));
    for (const [index, value] of chosen.entries()) {
      const amount = scaled(value), left = scaled(lines[index]!.remaining) ?? 0n;
      if (amount === null) { setProblem(`Confira a quantidade do item ${index + 1} (até 4 casas decimais).`); return; }
      if (amount > left) { setProblem(`O item ${index + 1} tem ${shown(lines[index]!.remaining)} para devolver.`); return; }
    }
    if (!chosen.some(value => (scaled(value) ?? 0n) > 0n)) { setProblem(lines.every(l => (scaled(l.remaining) ?? 0n) === 0n) ? 'Todos os itens desta nota já foram devolvidos.' : 'Informe a quantidade de pelo menos um item.'); return; }
    onConfirm(chosen.map(value => { const amount = scaled(value) ?? 0n; return `${amount / 10000n}.${String(amount % 10000n).padStart(4, '0')}`; }));
  };
  return <Modal title="Devolução de produto" onClose={onClose} actions={<>
    <button type="button" className="primary-button" disabled={!lines} onClick={confirm}>Gerar nota de devolução</button>
    <button type="button" className="secondary-button" onClick={onClose}>Cancelar</button></>}>
    <div className="document-grid">
      {onFind && <><div className="form-field"><label htmlFor="fiscal-return-order">Nº do pedido</label><input id="fiscal-return-order" maxLength={20} value={orderSearch} disabled={finding}
        onChange={event => { setOrderSearch(event.target.value); setFindError(''); }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void find(); } }} /></div>
        <div className="form-field"><label htmlFor="fiscal-return-search">Nº da nota fiscal ou chave de acesso</label><input id="fiscal-return-search" maxLength={60} value={noteSearch} disabled={finding} placeholder="Digite ou use o leitor de código de barras"
          onChange={event => { setNoteSearch(event.target.value); setFindError(''); }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void find(); } }} /></div>
        <button type="button" className="secondary-button" disabled={finding || (!orderSearch.trim() && !noteSearch.trim())} onClick={() => void find()}>{finding ? 'Buscando…' : 'Buscar nota'}</button></>}
      <div className="form-field"><label htmlFor="fiscal-return-key">{onFind ? 'Nota escolhida' : 'Nº da nota fiscal ou chave de acesso'}</label><input id="fiscal-return-key" readOnly value={number ? `${String(number).padStart(6, '0')} · ${accessKey}` : accessKey} /></div>
      <div className="form-field"><label htmlFor="fiscal-return-contact">{direction === '1' ? 'Cliente' : 'Fornecedor'}</label><input id="fiscal-return-contact" readOnly value={contactName ?? ''} /></div>
      <div className="form-field"><span>Devolução</span>
        <label htmlFor="fiscal-return-total"><input id="fiscal-return-total" type="radio" name="fiscal-return-mode" checked={mode === 'total'} onChange={() => setMode('total')} /> Devolução total</label>
        <label htmlFor="fiscal-return-partial"><input id="fiscal-return-partial" type="radio" name="fiscal-return-mode" checked={mode === 'partial'} onChange={() => setMode('partial')} /> Devolução parcial</label></div>
    </div>
    {findError && <p className="real-alert" role="alert">{findError}</p>}
    {error && <p className="real-alert" role="alert">{error}</p>}
    {returned && returned.returns.length > 0 && <p className="real-notice">A nota fiscal já possui devolução efetuada: {returned.returns.map(r => `${r.number ? String(r.number).padStart(6, '0') : 'nota sem número'} de ${brDay(r.issue_date)}`).join(', ')}.</p>}
    {!lines && !error && <p role="status">Conferindo as devoluções da nota…</p>}
    {lines && <div className="table-scroll" tabIndex={0}><table className="data-table"><thead><tr><th>#</th><th>Produto</th><th className="numeric">Total {direction === '1' ? 'saída' : 'entrada'}</th><th className="numeric">Total devolvidos</th><th className="numeric">Devolver</th></tr></thead>
      <tbody>{lines.map((line, index) => <tr key={index}><td>{index + 1}</td><td>{line.description}{line.code ? ` · ${line.code}` : ''}</td><td className="numeric">{shown(line.quantity)}</td><td className="numeric">{shown(line.returned)}</td>
        <td className="numeric"><input aria-label={`Devolver do item ${index + 1}`} inputMode="decimal" disabled={mode === 'total'} value={mode === 'total' ? shown(line.remaining) : values[index] ?? shown(line.remaining)} onChange={event => { const value = event.target.value; setValues(v => ({ ...v, [index]: value })); setProblem(''); }} /></td></tr>)}</tbody></table></div>}
    {problem && <p className="real-alert" role="alert">{problem}</p>}
    <p className="real-help">A nota de devolução abre no formulário, para conferir e salvar (homologação, sem envio). O retorno ao estoque e o estorno ou crédito das contas continuam desligados enquanto o Origin é o sistema principal. As devoluções feitas no Origin não entram nesta conta.</p>
  </Modal>;
}
