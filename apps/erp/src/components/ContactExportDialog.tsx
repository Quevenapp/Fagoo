import { useEffect, useRef, useState } from 'react';
import type { AccessController } from '../lib/real-access';
import { CSV_TYPE, XLSX_TYPE, downloadFile, toCsv, toXlsx } from '../lib/spreadsheet-export';
import { EXPORT_LIMIT, longCells, sheetRows, type ContactListState, type ContactTypeItem } from '../lib/contact-list-model';
import { ExportTooLarge, fetchContactRows } from '../lib/contact-export-request';
import { saoPauloToday } from '../lib/contact-form-model';
import { Modal } from './Modal';
import { aborted, errorText } from './catalog-shared';

// Painel "Exportar para a planilha" (Origin CL-18): Formato CSV | XLS, Tipo dos campos Padrão | Customizado | Ambos e os
// avisos do Origin. Os campos customizados ainda não existem no Brufap, então só "Padrão" fica disponível. A planilha
// usa o mesmo cabeçalho do modelo de importação e é montada no navegador; nada é enviado.
export function ContactExportDialog({ controller, state, types, total, onClose }: { controller: AccessController; state: Omit<ContactListState, 'page'>; types: readonly ContactTypeItem[]; total: number; onClose: () => void }) {
  const [format, setFormat] = useState<'csv' | 'xls'>('csv'), [busy, setBusy] = useState(false), [progress, setProgress] = useState(''), [error, setError] = useState(''), [done, setDone] = useState('');
  const request = useRef<AbortController | null>(null), actor = useRef(controller.getSnapshot().membership?.user_id);
  useEffect(() => () => request.current?.abort(), []);
  const tooMany = total > EXPORT_LIMIT;
  const run = async () => {
    if (busy || tooMany) return;
    const current = new AbortController(); request.current = current; setBusy(true); setError(''); setDone(''); setProgress('Lendo os contatos…');
    try {
      const rows = await fetchContactRows(controller, 'contacts', state, { signal: current.signal, onProgress: (count, all) => setProgress(`Lendo os contatos: ${count} de ${all}`) });
      if (current.signal.aborted || controller.getSnapshot().membership?.user_id !== actor.current) return;
      const sheet = sheetRows(rows, types), stamp = saoPauloToday();
      if (format === 'csv') downloadFile(`contatos-${stamp}.csv`, toCsv(sheet), CSV_TYPE);
      else {
        const long = longCells(sheet);
        if (long) { setError(`${long} ${long === 1 ? 'célula passa' : 'células passam'} de 30 mil caracteres, o limite do XLS. Exporte em CSV para não perder texto.`); return; }
        downloadFile(`contatos-${stamp}.xlsx`, toXlsx('Contatos', sheet) as BlobPart, XLSX_TYPE);
      }
      setDone(`${rows.length} ${rows.length === 1 ? 'contato exportado' : 'contatos exportados'}.`);
    } catch (failure) {
      if (current.signal.aborted || aborted(failure)) return;
      setError(failure instanceof ExportTooLarge ? 'A exportação é limitada a 10.000 contatos. Refine os filtros e tente de novo.'
        : failure instanceof Error && failure.message === 'EXPORT_CHANGED' ? 'Os contatos mudaram durante a exportação. Nada foi baixado; tente de novo.' : errorText(failure));
    } finally { if (request.current === current) { request.current = null; setBusy(false); setProgress(''); } }
  };
  return <Modal title="Exportar para a planilha" onClose={() => { request.current?.abort(); onClose(); }} actions={<><button type="button" className="secondary-button" onClick={() => { request.current?.abort(); onClose(); }}>{done ? 'Fechar' : 'Cancelar'}</button>
    <button type="button" className="primary-button" disabled={busy || tooMany || !total} onClick={() => void run()}>{busy ? 'Exportando…' : 'Exportar'}</button></>}>
    <div className="contact-export">
      <fieldset disabled={busy}><legend>Formato de arquivo</legend>
        <label><input type="radio" name="contact-export-format" checked={format === 'csv'} onChange={() => setFormat('csv')} />CSV</label>
        <label><input type="radio" name="contact-export-format" checked={format === 'xls'} onChange={() => setFormat('xls')} />XLS</label></fieldset>
      <fieldset disabled={busy}><legend>Tipo dos campos</legend>
        <label><input type="radio" name="contact-export-fields" checked readOnly />Padrão</label>
        <label title="Os campos customizados ainda não existem no FAGOO."><input type="radio" name="contact-export-fields" disabled />Customizado</label>
        <label title="Os campos customizados ainda não existem no FAGOO."><input type="radio" name="contact-export-fields" disabled />Ambos</label></fieldset>
      <p className="real-help">O formato XLS tem limite de 30 mil caracteres por célula. Para textos longos, recomendamos o CSV.</p>
      <p className="real-help">Para reimportar a planilha, exporte os campos Padrão e Customizado separadamente.</p>
      <p className="real-help">Serão exportados {total} {total === 1 ? 'contato' : 'contatos'} com os filtros atuais (limite de 10.000).</p>
      {tooMany && <p className="real-alert" role="alert">A listagem tem mais de 10.000 contatos. Refine os filtros para exportar.</p>}
      {progress && <p role="status">{progress}</p>}{done && <p className="real-success" role="status">{done}</p>}{error && <p className="real-alert" role="alert">{error}</p>}
    </div>
  </Modal>;
}
