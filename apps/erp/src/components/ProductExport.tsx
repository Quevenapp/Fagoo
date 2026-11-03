import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import type { AccessController } from '../lib/real-access';
import { EXPORT_BATCH, EXPORT_FILE_ROWS, exportColumns, exportCsv, exportSheet } from '../lib/product-form-model';
import { customExportColumns, customFieldItems, type CustomField } from '../lib/custom-fields';
import { XLSX_TYPE, toXlsx } from '../lib/spreadsheet-export';
import { stockDate } from '../lib/stock-model';
import { aborted, errorText } from './catalog-shared';
import StructureExport from './StructureExport';
import './product-registry.css';

// Exportação de produtos (Origin "Exportar dados para planilha"): os filtros e a ordem da listagem chegam pelo endereço, as faixas
// têm até 1000 produtos e cada "Download" lê a faixa em lotes de 50 pela API (descrições longas cabem no limite de cada resposta)
// e monta a planilha neste navegador: CSV (UTF-8, ";") ou XLS (.xlsx, com os números exatos). Tipo dos campos: Padrão, Customizado
// (ID, Código, Descrição e os campos customizados, migração 156) ou Ambos. Onda E (migração 234): o Componente da listagem e o
// estoque do depósito padrão, como no Origin (sem depósito padrão, a soma dos depósitos considerados).
const FILTERS = ['situation', 'q', 'sort', 'type', 'ncm_presence', 'ncm', 'brand', 'stock', 'warehouse_id', 'images', 'tag', 'category', 'item_type', 'supplier_id', 'supplier_code', 'period', 'from', 'to', 'component_id'];
type StockScope = null | 'default_warehouse' | 'considered_warehouses' | 'all_warehouses';
type ExportPage = { items: Record<string, unknown>[]; total: number; offset: number; limit: number; stock_scope?: StockScope; stock_warehouse?: { id: string; name: string } | null; origin_stock?: { status: string } | null };
const page = (value: unknown, offset: number, limit: number): ExportPage => {
  const result = value as ExportPage;
  if (!result || !Array.isArray(result.items) || !Number.isSafeInteger(result.total) || result.offset !== offset || result.limit !== limit) throw new Error('Invalid export page');
  return result;
};

export default function ProductExport({ controller }: { controller: AccessController }) {
  const location = useLocation();
  const source = new URLSearchParams(location.search);
  // Estoque lane (222): "Exportar dados de estrutura para planilha" is this screen and route with tipo=estrutura (Origin: same export,
  // structures in files of 500). The hooks below always run in the same order; their reads are skipped for the structures.
  const structures = source.get('tipo') === 'estrutura';
  const filters = new URLSearchParams(FILTERS.flatMap(key => source.get(key) ? [[key, source.get(key)!]] : []));
  const [includeDeleted, setIncludeDeleted] = useState(false), [total, setTotal] = useState<number | null>(null), [error, setError] = useState('');
  const [stock, setStock] = useState<{ scope: StockScope; warehouse: string | null } | null>(null);
  const [busy, setBusy] = useState<number | null>(null), [done, setDone] = useState<number[]>([]), [format, setFormat] = useState<'csv' | 'xls'>('csv');
  const request = useRef<AbortController | null>(null);
  const key = `${filters}:${includeDeleted}`;
  const [fields, setFields] = useState<CustomField[] | null | 'error'>(null), [kind, setKind] = useState<'standard' | 'custom' | 'both'>('standard');
  useEffect(() => {
    if (structures) return;
    const signal = new AbortController();
    void Promise.resolve().then(() => controller.catalog('/v1/cadastros/campos-customizados', { signal: signal.signal })).then(value => { if (!signal.signal.aborted) setFields(customFieldItems(value)); })
      .catch(failure => { if (!signal.signal.aborted && !aborted(failure)) setFields('error'); });
    return () => signal.abort();
  }, [controller, structures]);
  const customReady = Array.isArray(fields) && fields.length > 0;
  useEffect(() => {
    if (structures) return;
    const signal = new AbortController(); request.current?.abort(); request.current = signal; setTotal(null); setError(''); setDone([]);
    const params = new URLSearchParams(filters); params.set('limit', '1'); params.set('include_deleted', String(includeDeleted));
    void controller.catalog(`/v1/cadastros/products/exportacao?${params}`, { signal: signal.signal }).then(value => {
      if (signal.signal.aborted) return;
      const first = page(value, 0, 1); setTotal(first.total); setStock({ scope: first.stock_scope ?? null, warehouse: first.stock_warehouse?.name ?? null });
    })
      .catch(failure => { if (!signal.signal.aborted && !aborted(failure)) setError(errorText(failure)); });
    return () => signal.abort();
  }, [controller, key, structures]);
  useEffect(() => () => request.current?.abort(), []);
  const download = async (start: number) => {
    if (busy !== null || total === null) return;
    const signal = new AbortController(); request.current = signal; setBusy(start); setError('');
    try {
      const rows: Record<string, unknown>[] = [];
      for (let offset = start; offset < Math.min(start + EXPORT_FILE_ROWS, total); offset += EXPORT_BATCH) {
        const params = new URLSearchParams(filters); params.set('offset', String(offset)); params.set('limit', String(EXPORT_BATCH)); params.set('include_deleted', String(includeDeleted));
        const result = page(await controller.catalog(`/v1/cadastros/products/exportacao?${params}`, { signal: signal.signal }), offset, EXPORT_BATCH);
        if (signal.signal.aborted) return;
        // 202610220008: the Origin columns say why a balance was not read (profile or failure); absence is never zero.
        rows.push(...result.items.map(item => ({ ...item, origin_stock_status: result.origin_stock?.status ?? null })));
      }
      const columns = exportColumns(kind, kind !== 'standard' && Array.isArray(fields) ? customExportColumns(fields) : []);
      const data = format === 'csv' ? exportCsv(rows, columns) : toXlsx('Produtos', exportSheet(rows, columns)) as unknown as BlobPart;
      if (typeof document !== 'undefined' && typeof URL.createObjectURL === 'function') {
        const url = URL.createObjectURL(new Blob([data], { type: format === 'csv' ? 'text/csv;charset=utf-8' : XLSX_TYPE }));
        const link = document.createElement('a'); link.href = url; link.download = `produtos-${stockDate()}-${start + 1}-${start + rows.length}.${format === 'csv' ? 'csv' : 'xlsx'}`; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      setDone(current => [...current, start]);
    } catch (failure) { if (!signal.signal.aborted && !aborted(failure)) setError(errorText(failure)); }
    finally { if (request.current === signal) setBusy(null); }
  };
  const ranges = total === null ? [] : Array.from({ length: Math.ceil(total / EXPORT_FILE_ROWS) }, (_, index) => index * EXPORT_FILE_ROWS);
  if (structures) return <StructureExport controller={controller} />;
  return <section className="real-section" aria-labelledby="export-title">
    <header className="real-heading catalog-heading"><div className="catalog-title"><h1 id="export-title">Exportação de produtos</h1></div><div className="catalog-heading-actions"><Link className="secondary-button" to="/cadastros-reais?cadastro=products">Voltar</Link></div></header>
    {error && <p className="real-alert" role="alert">{error}</p>}
    <div className="real-editor-fields">
      <label className="product-check"><input type="checkbox" checked={includeDeleted} disabled={busy !== null} onChange={event => setIncludeDeleted(event.target.checked)} />Incluir produtos marcados como excluídos</label>
      <div className="form-field"><label htmlFor="export-format">Formato de arquivo</label><select id="export-format" value={format} disabled={busy !== null} onChange={event => { setFormat(event.target.value as 'csv' | 'xls'); setDone([]); }}><option value="csv">CSV</option><option value="xls">XLS</option></select><small>{format === 'xls' ? 'XLS gera uma planilha do Excel (.xlsx), com os números exatos.' : 'CSV com ponto e vírgula e acentos em UTF-8, que o Excel abre diretamente.'}</small></div>
      <div className="form-field"><label htmlFor="export-fields">Tipo dos campos</label><select id="export-fields" value={kind} disabled={busy !== null} onChange={event => { setKind(event.target.value as 'standard' | 'custom' | 'both'); setDone([]); }}>
        <option value="standard">Padrão</option><option value="custom" disabled={!customReady}>Customizado</option><option value="both" disabled={!customReady}>Ambos</option></select>
        <small>{fields === null ? 'Carregando os campos customizados…' : fields === 'error' ? 'Não foi possível carregar os campos customizados; a exportação Padrão continua disponível.' : !fields.length ? 'Nenhum campo customizado cadastrado (Preferências > Sistema > Campos customizados).' : kind === 'custom' ? 'ID, Código, Descrição e uma coluna por campo customizado.' : kind === 'both' ? 'Os campos padrão seguidos de uma coluna por campo customizado.' : 'Os campos padrão da planilha de produtos.'}</small></div>
    </div>
    <p className="real-help" role="status">{total === null ? 'Calculando o total de produtos…' : total === 1 ? '1 produto com os filtros da listagem.' : `${total} produtos com os filtros da listagem.`}</p>
    {total !== null && total > 0 && <table className="data-table export-ranges"><thead><tr><th scope="col">Início a Fim</th><th scope="col">Download</th></tr></thead>
      <tbody>{ranges.map(start => <tr key={start}><td>{start + 1} a {Math.min(start + EXPORT_FILE_ROWS, total)}</td><td><button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void download(start)}>{busy === start ? 'Gerando…' : done.includes(start) ? 'Baixar de novo' : 'Download'}</button></td></tr>)}</tbody></table>}
    <aside className="taxonomy-tip"><h2>Instruções</h2><ul><li>Cada arquivo tem no máximo 1000 registros.</li><li>O filtro de campos customizados não é considerado.</li><li>{stock?.scope === 'default_warehouse' ? `O estoque exportado é o do depósito padrão (${stock.warehouse}), como no Origin.`
        : stock?.scope === 'considered_warehouses' ? 'Sem depósito padrão definido (Preferências › Depósitos): o estoque exportado é a soma dos depósitos, sem os que têm “Desconsiderar saldo deste depósito”.'
        : stock?.scope === 'all_warehouses' ? 'O estoque exportado é a soma de todos os depósitos.' : 'O estoque exportado é o do depósito padrão, como no Origin.'} A coluna Estoque é o saldo nativo do FAGOO; as colunas “Estoque Origin” trazem o físico e o virtual observados no Origin, com o horário, para o mesmo depósito e sem somar com o nativo. Posição não observada ou valor não informado fica em branco, com a situação, e nunca vira zero. O estoque só aparece para quem pode consultar o estoque.</li><li>O CSV usa ponto e vírgula e acentos em UTF-8; o XLS é uma planilha do Excel (.xlsx).</li></ul></aside>
  </section>;
}
