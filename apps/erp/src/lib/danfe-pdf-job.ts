// "Gerar PDF DANFE" of the panel (Selecionadas | Período) as a background task of the list (notas fiscais lane, wave F): every note of
// the choice, up to 1.000, is read from its checked XML one at a time while the list stays usable, and the result is one PDF with every
// DANFE or a ZIP with one PDF per note. Nothing is sent to or kept on a server; the file only exists in this browser tab.
import { danfePdf, danfePdfPages, type DanfePdfDocument } from './danfe-pdf.ts';
import { pdfDocument } from './pdf-writer.ts';
import { zipStore } from './spreadsheet-export.ts';
import type { DanfeSettings } from './danfe.ts';

export const DANFE_JOB_MAX = 1000;
export type DanfeFileFormat = 'single' | 'zip';
export interface DanfeJobFile { name: string; bytes: Uint8Array; type: 'application/pdf' | 'application/zip'; documents: number }
export interface DanfeJobState {
  /** Notes of the choice that have an XML to read (at most DANFE_JOB_MAX). */
  total: number; done: number; documents: number; problems: string[]; running: boolean; cancelled: boolean;
  /** Notes beyond the limit of one task, left for another one (never dropped silently). */
  beyond: number; format: DanfeFileFormat; file: DanfeJobFile | null; error: string;
}
export const newDanfeJob = (format: DanfeFileFormat): DanfeJobState => ({ total: 0, done: 0, documents: 0, problems: [], running: true, cancelled: false, beyond: 0, format, file: null, error: '' });

/** File name of one DANFE: the access key, like the XML files. */
const pdfName = (doc: DanfePdfDocument) => `DANFE-${doc.data.key}.pdf`;
/** The file of the task: one PDF with every DANFE in the order of the list, or a ZIP with one PDF per note. */
export function danfeJobFile(docs: readonly DanfePdfDocument[], settings: Pick<DanfeSettings, 'firstPage' | 'otherPages'>, format: DanfeFileFormat): DanfeJobFile {
  if (!docs.length) throw new Error('DANFE_JOB_EMPTY');
  if (format === 'single' || docs.length === 1) {
    return { name: docs.length === 1 ? pdfName(docs[0]!) : `DANFE-${docs.length}-notas.pdf`, bytes: danfePdf(docs, settings), type: 'application/pdf', documents: docs.length };
  }
  const used = new Set<string>();
  const files = docs.map(doc => {
    let name = pdfName(doc), n = 2;
    while (used.has(name)) name = `DANFE-${doc.data.key}-${n++}.pdf`;
    used.add(name);
    return { name, data: pdfDocument(danfePdfPages(doc, settings), { title: `DANFE ${doc.data.number}` }) };
  });
  return { name: `DANFE-${docs.length}-notas.zip`, bytes: zipStore(files), type: 'application/zip', documents: docs.length };
}
/** Progress line of the banner. */
export function danfeJobText(state: DanfeJobState): string {
  if (state.error) return state.error;
  if (state.running) return state.total ? `Gerando PDF DANFE em segundo plano: ${state.done} de ${state.total} notas lidas…` : 'Reunindo as notas para o PDF DANFE…';
  if (state.cancelled) return `Geração do PDF DANFE cancelada (${state.done} de ${state.total} notas lidas). Nenhum arquivo foi gerado.`;
  if (state.file) return state.file.type === 'application/zip' ? `ZIP pronto com ${state.file.documents} PDF(s) de DANFE.` : `PDF pronto com ${state.file.documents} DANFE(s).`;
  return 'Nenhum DANFE foi gerado.';
}
