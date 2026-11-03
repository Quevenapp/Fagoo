import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AccessController } from '../lib/real-access';
import { exportCsv, exportSheet, type ExportColumn } from '../lib/product-form-model';
import { XLSX_TYPE, toXlsx } from '../lib/spreadsheet-export';
import { stockDate } from '../lib/stock-model';
import { POST_MODE_LABELS, STOCK_TYPE_LABELS, type CompositionPostMode, type CompositionStockType } from '../lib/stock-composition-model';
import { aborted, errorText } from './catalog-shared';
import './product-registry.css';

// Estoque lane (222): "Exportar dados de estrutura para planilha" (Origin exportacao.produtos.estrutura.php), the same screen and
// route as the product export with tipo=estrutura. One row per component of the current structures, in files of up to 500 rows,
// each read in one request and assembled in this browser (CSV with ";" in UTF-8, or XLS with exact numbers).
const FILE_ROWS = 500;
type Row = { product_id: string; product_code: string | null; product_name: string; product_deleted: boolean; stock_type: CompositionStockType; post_mode: CompositionPostMode;
  position: number; component_code: string | null; component_name: string; component_unit: string | null; quantity: string };
type Page = { items: Row[]; total: number; offset: number; limit: number };
const page = (value: unknown, offset: number, limit: number): Page => {
  const result = value as Page;
  if (!result || !Array.isArray(result.items) || !Number.isSafeInteger(result.total) || result.offset !== offset || result.limit !== limit) throw new Error('Invalid structure export page');
  return result;
};
const text = (value: unknown) => typeof value === 'string' ? value : '';
const quantity = (value: unknown) => typeof value === 'string' ? value.replace(/\.?0+$/, '').replace('.', ',') : '';
// The Origin download was not captured: the columns follow the Estrutura tab of the product.
export const STRUCTURE_COLUMNS: ExportColumn[] = [
  ['Código (SKU) do produto', row => text(row.product_code)], ['Descrição do produto', row => text(row.product_name)],
  ['Tipo de estoque', row => STOCK_TYPE_LABELS[row.stock_type as CompositionStockType] ?? ''], ['Lançar estoque', row => POST_MODE_LABELS[row.post_mode as CompositionPostMode] ?? ''],
  ['nº', row => String(row.position ?? '')], ['Código (SKU) do componente', row => text(row.component_code)], ['Descrição do componente', row => text(row.component_name)],
  ['Unidade', row => text(row.component_unit)], ['Qtde', row => quantity(row.quantity), true], ['Situação do produto', row => row.product_deleted ? 'Excluído' : ''],
];
const exportPath = (offset: number, limit: number, deleted: boolean) => `/v1/estoque/composicoes/exportacao?${new URLSearchParams({ offset: String(offset), limit: String(limit), incluir_excluidos: String(deleted) })}`;

export default function StructureExport({ controller }: { controller: AccessController }) {
  const [includeDeleted, setIncludeDeleted] = useState(false), [total, setTotal] = useState<number | null>(null), [error, setError] = useState('');
  const [busy, setBusy] = useState<number | null>(null), [done, setDone] = useState<number[]>([]), [format, setFormat] = useState<'csv' | 'xls'>('csv');
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    const signal = new AbortController(); request.current?.abort(); request.current = signal; setTotal(null); setError(''); setDone([]);
    void Promise.resolve().then(() => controller.stock(exportPath(0, 1, includeDeleted), { signal: signal.signal })).then(value => { if (!signal.signal.aborted) setTotal(page(value, 0, 1).total); })
      .catch(failure => { if (!signal.signal.aborted && !aborted(failure)) setError(errorText(failure)); });
    return () => signal.abort();
  }, [controller, includeDeleted]);
  useEffect(() => () => request.current?.abort(), []);
  const download = async (start: number) => {
    if (busy !== null || total === null) return;
    const signal = new AbortController(); request.current = signal; setBusy(start); setError('');
    try {
      const rows = page(await controller.stock(exportPath(start, FILE_ROWS, includeDeleted), { signal: signal.signal }), start, FILE_ROWS).items;
      if (signal.signal.aborted) return;
      const data = format === 'csv' ? exportCsv(rows, STRUCTURE_COLUMNS) : toXlsx('Estruturas', exportSheet(rows, STRUCTURE_COLUMNS)) as unknown as BlobPart;
      if (typeof document !== 'undefined' && typeof URL.createObjectURL === 'function') {
        const url = URL.createObjectURL(new Blob([data], { type: format === 'csv' ? 'text/csv;charset=utf-8' : XLSX_TYPE }));
        const link = document.createElement('a'); link.href = url; link.download = `estruturas-${stockDate()}-${start + 1}-${start + rows.length}.${format === 'csv' ? 'csv' : 'xlsx'}`; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      setDone(current => [...current, start]);
    } catch (failure) { if (!signal.signal.aborted && !aborted(failure)) setError(errorText(failure)); }
    finally { if (request.current === signal) setBusy(null); }
  };
  const ranges = total === null ? [] : Array.from({ length: Math.ceil(total / FILE_ROWS) }, (_, index) => index * FILE_ROWS);
  return <section className="real-section" aria-labelledby="structure-export-title">
    <header className="real-heading catalog-heading"><div className="catalog-title"><h1 id="structure-export-title">Exportação de estruturas</h1></div><div className="catalog-heading-actions"><Link className="secondary-button" to="/cadastros-reais?cadastro=products">Voltar</Link></div></header>
    {error && <p className="real-alert" role="alert">{error}</p>}
    <div className="real-editor-fields">
      <label className="product-check"><input type="checkbox" checked={includeDeleted} disabled={busy !== null} onChange={event => setIncludeDeleted(event.target.checked)} />Incluir produtos marcados como excluídos</label>
      <div className="form-field"><label htmlFor="structure-export-format">Formato de arquivo</label><select id="structure-export-format" value={format} disabled={busy !== null} onChange={event => { setFormat(event.target.value as 'csv' | 'xls'); setDone([]); }}><option value="csv">CSV</option><option value="xls">XLS</option></select></div>
    </div>
    <p className="real-help" role="status">{total === null ? 'Calculando o total de componentes…' : total === 1 ? '1 componente nas estruturas das composições.' : `${total} componentes nas estruturas das composições.`}</p>
    {total === 0 && <p className="real-help">Nenhuma composição tem estrutura. As composições espelhadas do Origin chegam sem a estrutura: informe os componentes na aba Estrutura do produto.</p>}
    {total !== null && total > 0 && <table className="data-table export-ranges"><thead><tr><th scope="col">Início a Fim</th><th scope="col">Download</th></tr></thead>
      <tbody>{ranges.map(start => <tr key={start}><td>{start + 1} a {Math.min(start + FILE_ROWS, total)}</td><td><button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void download(start)}>{busy === start ? 'Gerando…' : done.includes(start) ? 'Baixar de novo' : 'Download'}</button></td></tr>)}</tbody></table>}
    <aside className="taxonomy-tip"><h2>Instruções</h2><ul><li>Cada arquivo tem no máximo 500 registros, um por componente da estrutura.</li><li>Só entram as composições (formato Com composição) com a estrutura salva no FAGOO.</li><li>As colunas seguem a aba Estrutura do produto. O CSV usa ponto e vírgula e acentos em UTF-8; o XLS é uma planilha do Excel (.xlsx) com as quantidades exatas.</li></ul></aside>
  </section>;
}
