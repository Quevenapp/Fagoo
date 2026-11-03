import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AccessError, type AccessController } from '../lib/real-access';
import { CSV_TYPE, XLSX_TYPE, downloadFile } from '../lib/spreadsheet-export';
import { API_FIELD_LABEL, IMPORT_BATCH, IMPORT_LIMIT, decodeText, importRows, modelCsv, modelXlsx, parseCsv, parseXlsx, type ImportRow } from '../lib/contact-import-model';
import { XlsError, parseXls } from '../lib/xls-reader';
import type { ContactTypes } from '../lib/contact-list-model';
import { useUnsavedForm } from '../hooks/useUnsavedChanges';
import { Icon } from './Icon';
import { aborted, errorText } from './catalog-shared';
import { contactRefusalText } from './contact-errors';
import './contacts.css';

// Importar contatos (Origin IC-01 e IC-02): "Selecione o arquivo de contatos", "Limite de 10.000 contatos por planilha.",
// Procurar arquivo > Validar > conferir registros > Importar. O servidor valida cada linha com as regras do formulário e
// importa em lotes de 50, um comando por lote; um resultado incerto oferece "Conferir resultado" com o mesmo comando.
type Result = { row: number; status: 'valid' | 'invalid' | 'created'; code?: string; field?: string };
type Batch = { id: string; rows: ImportRow[]; uncertain: boolean };
const reason = (result: Result) => result.code === 'required' ? `Obrigatório pelas Preferências: ${API_FIELD_LABEL[result.field ?? ''] ?? result.field}` : result.code === 'duplicate_document' ? 'CPF/CNPJ duplicado não permitido'
  : result.code === 'not_visible' ? 'Fora da carteira do seu vendedor' : result.field ? `Confira ${API_FIELD_LABEL[result.field] ?? result.field}` : 'Linha recusada';

export default function RealImportContacts({ controller }: { controller: AccessController }) {
  const [file, setFile] = useState<string>(''), [rows, setRows] = useState<ImportRow[] | null>(null), [unknown, setUnknown] = useState<string[]>([]), [error, setError] = useState('');
  const [results, setResults] = useState<Map<number, Result>>(new Map()), [step, setStep] = useState<'file' | 'validated' | 'imported'>('file'), [busy, setBusy] = useState(false), [progress, setProgress] = useState('');
  const [pending, setPending] = useState<Batch | null>(null), [types, setTypes] = useState<ContactTypes | null>(null);
  const request = useRef<AbortController | null>(null), actor = useRef(controller.getSnapshot().membership?.user_id), remaining = useRef<Batch[]>([]);
  const guard = useUnsavedForm(step === 'validated' ? file : '', busy || Boolean(pending?.uncertain));
  useEffect(() => {
    const current = new AbortController();
    void controller.catalog('/v1/cadastros/tipos-contato', { signal: current.signal }).then(value => { if (!current.signal.aborted) setTypes(value as ContactTypes); }).catch(() => undefined);
    return () => { current.abort(); request.current?.abort(); };
  }, [controller]);
  const same = () => controller.getSnapshot().membership?.user_id === actor.current;
  const read = async (selected: File) => {
    setError(''); setRows(null); setResults(new Map()); setStep('file'); setFile(selected.name);
    const name = selected.name.toLowerCase();
    if (!/\.(xlsx|xls|csv)$/.test(name)) { setError('Selecione uma planilha .XLSX, .XLS ou .CSV conforme o modelo.'); return; }
    if (selected.size > 20 * 1024 * 1024) { setError('A planilha passa de 20 MB. Divida o arquivo e tente de novo.'); return; }
    try {
      const bytes = new Uint8Array(await selected.arrayBuffer()), cells = name.endsWith('.csv') ? parseCsv(decodeText(bytes)) : name.endsWith('.xls') ? parseXls(bytes, decodeText) : await parseXlsx(bytes);
      const parsed = importRows(cells, types?.items ?? []);
      if (parsed.missingName) { setError('A planilha não tem a coluna "Nome" do modelo. Baixe a planilha modelo e confira o cabeçalho.'); return; }
      if (!parsed.rows.length) { setError('A planilha não tem contatos.'); return; }
      if (parsed.rows.length > IMPORT_LIMIT) { setError('Limite de 10.000 contatos por planilha.'); return; }
      setRows(parsed.rows); setUnknown(parsed.unknown);
    } catch (failure) {
      setError(failure instanceof XlsError && failure.reason === 'old_version' ? 'Esta planilha .XLS é de uma versão anterior ao Excel 97. Salve-a como .XLSX ou .CSV e tente de novo.'
        : 'Não foi possível ler a planilha. Confira se o arquivo é um .XLSX, .XLS ou .CSV válido.');
    }
  };
  const call = async (body: Record<string, unknown>, signal: AbortSignal) => {
    const value = await controller.catalog('/v1/cadastros/contatos/importar', { method: 'POST', body, signal }) as { items?: Result[] };
    if (!Array.isArray(value.items)) throw new AccessError(502); return value.items;
  };
  const validate = async () => {
    if (!rows || busy) return;
    const current = new AbortController(); request.current = current; setBusy(true); setError('');
    // Rows an earlier batch already imported keep their result: validating again (after a refused batch) never sends them twice.
    const found = new Map<number, Result>([...results].filter(([, result]) => result.status === 'created'));
    try {
      const ready = rows.filter(row => !row.problems.length && !found.has(row.row));
      for (let index = 0; index < ready.length; index += IMPORT_BATCH) {
        setProgress(`Validando: ${Math.min(index + IMPORT_BATCH, ready.length)} de ${ready.length}`);
        for (const result of await call({ dry_run: true, rows: ready.slice(index, index + IMPORT_BATCH).map(row => ({ row: row.row, data: row.data })) }, current.signal)) found.set(result.row, result);
        if (current.signal.aborted || !same()) return;
      }
      setResults(found); setStep('validated');
    } catch (failure) { if (!current.signal.aborted && !aborted(failure)) setError(`Não foi possível validar a planilha. ${errorText(failure)}`); }
    finally { if (request.current === current) { request.current = null; setBusy(false); setProgress(''); } }
  };
  const send = async (batches: Batch[]) => {
    const current = new AbortController(); request.current = current; setBusy(true); setError('');
    try {
      for (let index = 0; index < batches.length; index++) {
        const batch = batches[index]!; setPending(batch); setProgress(`Importando lote ${index + 1} de ${batches.length}`);
        let items: Result[];
        try { items = await call({ command_id: batch.id, dry_run: false, rows: batch.rows.map(row => ({ row: row.row, data: row.data })) }, current.signal); }
        catch (failure) {
          if (current.signal.aborted || aborted(failure)) return;
          if (!batch.uncertain && failure instanceof AccessError && [400, 403, 409].includes(failure.status)) { setPending(null); setError(`O lote ${index + 1} foi recusado e nada dele foi gravado: ${contactRefusalText(failure) ?? errorText(failure)} Valide a planilha de novo.`); setStep('file'); return; }
          setPending({ ...batch, uncertain: true }); setError('Não foi possível confirmar a importação deste lote. Use “Conferir resultado” para repetir o mesmo lote sem duplicar contatos.');
          remaining.current = batches.slice(index + 1); return;
        }
        if (!same()) return;
        setResults(previous => { const next = new Map(previous); for (const item of items) next.set(item.row, item); return next; });
      }
      setPending(null); remaining.current = []; setStep('imported');
    } finally { if (request.current === current) { request.current = null; setBusy(false); setProgress(''); } }
  };
  const importValid = () => {
    if (!rows || busy || step !== 'validated') return;
    const valid = rows.filter(row => results.get(row.row)?.status === 'valid'), batches: Batch[] = [];
    for (let index = 0; index < valid.length; index += IMPORT_BATCH) batches.push({ id: crypto.randomUUID(), rows: valid.slice(index, index + IMPORT_BATCH), uncertain: false });
    void send(batches);
  };
  const shown = rows ?? [], invalid = shown.filter(row => row.problems.length || results.get(row.row)?.status === 'invalid'), validCount = shown.filter(row => results.get(row.row)?.status === 'valid').length;
  const created = shown.filter(row => results.get(row.row)?.status === 'created').length;
  return <section className="contact-aux">
    <header className="real-heading catalog-heading"><div className="catalog-title"><h1>Importar contatos</h1></div></header>
    <ol className="contact-import-steps">{['Procurar Arquivo', 'Validar', 'Conferir registros', 'Importar'].map((label, index) => <li key={label} className={index === (step === 'file' ? (rows ? 1 : 0) : step === 'validated' ? 2 : 3) ? 'is-current' : undefined}>{label}</li>)}</ol>
    <div className="contact-grid">
      <section className="contact-section"><h2>Selecione o arquivo de contatos</h2><p>Limite de 10.000 contatos por planilha.</p>
        <label className="secondary-button"><Icon name="file-upload" size={12} />Procurar arquivo<input type="file" id="contact-import-file" className="real-sr-only" accept=".xlsx,.xls,.csv" disabled={busy || Boolean(pending?.uncertain)} onChange={event => { const selected = event.target.files?.[0]; if (selected) void guard.confirmLeave(() => void read(selected)); }} /></label>
        {file && <p className="real-help">{file}{rows ? ` · ${rows.length} ${rows.length === 1 ? 'linha' : 'linhas'}` : ''}</p>}
        {unknown.length > 0 && <p className="real-help">Colunas ignoradas (fora do modelo): {unknown.join(', ')}.</p>}</section>
      <aside className="contact-section"><h2>Instruções</h2>
        <p>Use uma planilha .XLSX, .XLS ou .CSV com as colunas da tabela modelo (as mesmas de “Exportar para a planilha” da listagem). Procure o arquivo, valide, confira os registros e importe.</p>
        <p><button type="button" className="text-button" onClick={() => downloadFile('modelo-contatos.xlsx', modelXlsx() as BlobPart, XLSX_TYPE)}>Baixar planilha modelo (.XLSX)</button> · <button type="button" className="text-button" onClick={() => downloadFile('modelo-contatos.csv', modelCsv(), CSV_TYPE)}>(.CSV)</button></p>
        <p className="real-help">Vendedor, Categoria e Natureza de Operação são exportados para consulta e não são importados: vincule-os depois pela listagem ou pelo formulário.</p>
        <p className="real-help">Os contatos importados são cadastrados no FAGOO conforme a prévia conferida.</p>
        <p className="real-help">Ajuda: <Link to="/cadastros-reais?cadastro=contacts">Clientes e fornecedores</Link> mostra os contatos importados.</p></aside>
    </div>
    {error && <p className="real-alert" role="alert">{error}</p>}
    {progress && <p role="status">{progress}</p>}
    {pending?.uncertain && <p><button type="button" className="primary-button" disabled={busy} onClick={() => void send([pending, ...remaining.current])}>Conferir resultado</button></p>}
    {rows && <>
      <div className="real-editor-actions">
        <button type="button" className="secondary-button" disabled={busy || step !== 'file'} onClick={() => void validate()}>Validar</button>
        <button type="button" className="primary-button" disabled={busy || step !== 'validated' || !validCount || Boolean(pending?.uncertain)} onClick={importValid}>Importar {validCount ? `${validCount} ${validCount === 1 ? 'contato' : 'contatos'}` : ''}</button></div>
      {step === 'imported' && <p className="real-success" role="status">{created} {created === 1 ? 'contato importado' : 'contatos importados'}.{invalid.length ? ` ${invalid.length} ${invalid.length === 1 ? 'linha ficou' : 'linhas ficaram'} de fora.` : ''}</p>}
      <div className="table-scroll"><table className="data-table real-table contact-import-table"><thead><tr><th scope="col">Linha</th><th scope="col">Nome</th><th scope="col">CPF/CNPJ</th><th scope="col">Situação</th></tr></thead>
        <tbody>{shown.slice(0, 500).map(row => { const result = results.get(row.row), bad = row.problems.length > 0 || result?.status === 'invalid';
          return <tr key={row.row} className={bad ? 'is-invalid' : undefined}><td>{row.row}</td><td>{String(row.data.name ?? '—')}</td><td>{String(row.data.document ?? '—')}</td>
            <td>{row.problems.length ? row.problems.join('; ') : result ? result.status === 'created' ? 'Importado' : result.status === 'valid' ? `Válido${row.ignored.length ? ` (ignorado: ${row.ignored.join(', ')})` : ''}` : reason(result) : 'Aguardando validação'}</td></tr>; })}</tbody></table></div>
      {shown.length > 500 && <p className="real-help">Mostrando as 500 primeiras linhas de {shown.length}. {invalid.length} com problema no total.</p>}
    </>}
  </section>;
}
