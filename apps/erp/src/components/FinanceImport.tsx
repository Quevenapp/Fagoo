import { Link, useLocation } from 'react-router-dom';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import { financeLinkActor } from '../lib/document-finance-link';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { financeDate, financeMoney, type FinanceAccess, financePermitted, titlePermission } from '../lib/real-finance-model';
import { IMPORT_ERROR_LABEL, IMPORT_HEADERS, IMPORT_KINDS, PREVIEW_LABEL, TEMPLATE_ZIP, importPreview, importResult, importRows, importTemplates, type ImportKind, type ImportRow, type PreviewRow } from '../lib/finance-records-import';
import { readSheet } from '../lib/finance-sheet-import';
import { downloadFile } from '../lib/spreadsheet-export';
import { useFinanceCommand } from '../lib/finance-command';
import { badgeClass } from '../lib/origin-list';
import { Icon } from './Icon';
import './real-finance.css';
import './finance-registry.css';

const noSubscription = () => () => {}, noSnapshot = () => null;
const message = (error: unknown) => error instanceof AccessError ? error.status === 400 ? 'A importação não foi aceita: confira a planilha e envie o arquivo novamente.' : error.status === 403 ? 'Seu acesso a esta operação foi alterado.'
  : error.status === 409 ? 'Esta importação já foi usada com outro arquivo. Envie o arquivo novamente.' : 'Não foi possível concluir a operação. Tente novamente.' : error instanceof Error ? error.message : 'Não foi possível concluir a operação.';
function BusyGuard() { useUnsavedChanges(false, true); return null; }
const KIND_PARAM: Readonly<Record<string, ImportKind>> = { receivable: 'receivable', payable: 'payable', caixa: 'cash' };
type Loaded = { kind: ImportKind; name: string; rows: ImportRow[]; preview: PreviewRow[] | null; error: string };
const errorsText = (row: PreviewRow) => row.errors.map(code => IMPORT_ERROR_LABEL[code] ?? code).join(', ');
const shownDate = (value: string | undefined) => value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? financeDate(value) : value || '—';

/**
 * Importação de registros financeiros do Origin (SQL 138): Tipo de registro (Conta a Receber | Conta a Pagar | Registros de
 * caixa), PROCURAR ARQUIVO (CSV conforme a tabela modelo) e a prévia de cada linha. Só insere registros novos: uma linha
 * já importada é ignorada e nada é atualizado. A planilha é lida no navegador; o servidor confere contato, categoria e conta.
 */
export default function FinanceImport({ controller }: { controller: AccessController }) {
  const location = useLocation(), initial = KIND_PARAM[new URLSearchParams(location.search).get('tipo') ?? ''] ?? 'receivable';
  const tracked = typeof controller.getSnapshot === 'function', session = useSyncExternalStore(controller.subscribe ?? noSubscription, controller.getSnapshot ?? noSnapshot);
  const actor = financeLinkActor(session), allowed = !tracked || actor !== null, scope = tracked ? `${actor ?? ''}:${session?.phase ?? ''}:${session?.membership?.role ?? ''}` : 'isolated';
  const current = useRef(scope); current.current = scope;
  const mayRead = () => allowed && current.current === scope && (!tracked || financeLinkActor(controller.getSnapshot()) === actor);
  const [permissions, setPermissions] = useState<{ scope: string; value: FinanceAccess } | null>(null), access = permissions?.scope === scope ? permissions.value : null;
  const mayWrite = () => mayRead() && Boolean(access?.write) && (!tracked || ['admin', 'financeiro'].includes(controller.getSnapshot()?.membership?.role ?? ''));
  const [kind, setKind] = useState<ImportKind>(initial), [loaded, setLoaded] = useState<Loaded | null>(null), [reading, setReading] = useState(false), [notice, setNotice] = useState(''), [error, setError] = useState('');
  const attempt = useRef(0);
  const command = useFinanceCommand(next => controller.finance(next.path, { method: 'POST', body: { command_id: next.id, data: structuredClone(next.data) } } as never), mayWrite, message);
  useEffect(() => {
    if (!allowed) return; const request = new AbortController();
    void controller.finance('/v1/financeiro', { signal: request.signal }).then(value => { const result = value as FinanceAccess; if (!request.signal.aborted && mayRead() && result.data_mode === 'erp_native' && result.read === true && typeof result.write === 'boolean') setPermissions({ scope, value: result }); })
      .catch(failure => { if (!request.signal.aborted && !(failure instanceof DOMException && failure.name === 'AbortError')) setError(message(failure)); });
    return () => request.abort();
  }, [controller, scope]);
  // Sistema › Usuários › Permissões › Finanças (SQL 246): incluir of Contas a receber / a pagar, or of Caixas e bancos for the lançamentos.
  const writable = Boolean(access?.write) && financePermitted(access, kind === 'cash' ? 'financas.caixas_bancos.ie' : titlePermission(kind, 'ie'));
  // PROCURAR ARQUIVO: the sheet is read here and each line is checked by the server (prévia, read-only).
  const attach = async (file: File | undefined) => {
    if (!file || command.locked || reading || !mayWrite()) return;
    const ticket = ++attempt.current, chosen = kind; setNotice(''); setError(''); setLoaded(null); setReading(true);
    try {
      if (!/\.(csv|txt)$/i.test(file.name)) throw new Error('Selecione um arquivo .CSV conforme a tabela modelo.');
      const rows = importRows(chosen, await readSheet(file.name, new Uint8Array(await file.arrayBuffer())));
      if (ticket !== attempt.current) return;
      setLoaded({ kind: chosen, name: file.name, rows, preview: null, error: '' });
      const value = await controller.finance('/v1/financeiro/actions/records_import_preview', { method: 'POST', body: { command_id: crypto.randomUUID(), data: { kind: chosen, file_name: file.name, rows } } } as never);
      if (ticket !== attempt.current || !mayRead()) return;
      setLoaded({ kind: chosen, name: file.name, rows, preview: importPreview(value, chosen, rows), error: '' });
    } catch (failure) {
      if (ticket !== attempt.current) return;
      setLoaded(previous => previous && previous.name === file.name ? { ...previous, error: message(failure) } : null);
      if (!(failure instanceof AccessError)) setError(message(failure)); else setError('');
    } finally { if (ticket === attempt.current) setReading(false); }
  };
  const fresh = loaded?.preview ? loaded.rows.filter((_, index) => loaded.preview![index].status === 'new') : [];
  const counts = loaded?.preview ? { new: fresh.length, duplicate: loaded.preview.filter(row => row.status === 'duplicate').length, error: loaded.preview.filter(row => row.status === 'error').length } : null;
  const runImport = () => {
    if (!loaded || !fresh.length) return; const state = loaded, rows = fresh;
    void command.run(() => ({ id: crypto.randomUUID(), path: '/v1/financeiro/actions/records_import', data: { kind: state.kind, file_name: state.name, rows } }), value => {
      if (!mayRead()) return; const result = importResult(value, state.kind, rows.length);
      setLoaded(null); setNotice(`Importação concluída: ${result.created === 1 ? '1 registro incluído' : `${result.created.toLocaleString('pt-BR')} registros incluídos`}${result.skipped ? `, ${result.skipped === 1 ? '1 já importado ignorado' : `${result.skipped.toLocaleString('pt-BR')} já importados ignorados`}` : ''}.`);
    });
  };
  const changeKind = (next: ImportKind) => { if (command.locked || reading) return; attempt.current++; setKind(next); setLoaded(null); setNotice(''); setError(''); };
  const back = kind === 'cash' ? { to: '/financeiro-empresa?area=accounts', label: 'Caixas e bancos' } : { to: `/financeiro-empresa?area=${kind}`, label: kind === 'receivable' ? 'Contas a receber' : 'Contas a pagar' };
  if (!allowed) return <section className="real-state-panel"><h1>Consulta financeira indisponível</h1><p>Confirme sua sessão e seu acesso ao financeiro para continuar.</p></section>;
  return <>{command.uncertain && <BusyGuard />}
    <header className="real-heading"><h1>Importação de registros financeiros</h1>{access && !access.write && <span className="real-mode">Somente consulta</span>}</header>
    {notice && <p className="real-success" role="status">{notice}</p>}{error && <p className="real-alert" role="alert">{error}</p>}
    <section className="finance-import">
      <div className="form-field"><label htmlFor="records-import-kind">Tipo de registro para importar</label><select id="records-import-kind" value={kind} disabled={command.locked || reading} onChange={event => changeKind(event.target.value as ImportKind)}>{IMPORT_KINDS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select></div>
      <p className="real-notice">Importe um arquivo CSV conforme a <button type="button" className="text-button" onClick={() => downloadFile(TEMPLATE_ZIP, importTemplates() as unknown as BlobPart, 'application/zip')}>tabela modelo</button>. A importação só insere registros novos: as linhas já importadas são ignoradas e nenhum registro existente é atualizado.
        Colunas de {IMPORT_KINDS.find(option => option.id === kind)!.label}: {IMPORT_HEADERS[kind].join(', ')}. O contato é encontrado pelo CPF/CNPJ ou pelo nome, e a categoria e a conta financeira pelo nome.</p>
      {writable ? <label className={`primary-button finance-import-file${command.locked || reading ? ' is-disabled' : ''}`} htmlFor="records-import-file"><Icon name="upload" size={14} />PROCURAR ARQUIVO
        <input id="records-import-file" type="file" accept=".csv,text/csv" className="real-sr-only" disabled={command.locked || reading} onChange={event => { void attach(event.target.files?.[0]); event.target.value = ''; }} /></label>
        : access && <p className="real-help">Seu perfil consulta o financeiro, sem importar registros.</p>}
      {reading && <p className="real-help" role="status">Conferindo as linhas do arquivo…</p>}
      {loaded?.error && <p className="real-alert" role="alert">{loaded.error}</p>}
      {loaded?.preview && counts && <>
        <h2 className="finance-import-title">{loaded.name}</h2>
        <p className="real-help" role="status">{counts.new} {counts.new === 1 ? 'registro novo' : 'registros novos'} · {counts.duplicate} já {counts.duplicate === 1 ? 'importado' : 'importados'} · {counts.error} com erro</p>
        {counts.error > 0 && <p className="real-alert" role="note">As linhas com erro não são importadas. Corrija a planilha e envie o arquivo de novo; as linhas já importadas serão ignoradas.</p>}
        <div className="table-scroll" tabIndex={0} role="region" aria-label="Prévia da importação"><table className="data-table finance-table"><thead><tr><th>Linha</th><th>{kind === 'cash' ? 'Data' : 'Vencimento'}</th><th>Histórico</th><th className="numeric">Valor</th><th>Situação</th></tr></thead>
          <tbody>{loaded.preview.map((row, index) => { const source = loaded.rows[index]; return <tr key={row.line}><td>{row.line}</td><td>{shownDate(kind === 'cash' ? source.issued_on : source.due_on)}</td><td>{source.description || '—'}</td><td className="numeric">{/^\d{1,15}$/.test(source.amount_cents) ? financeMoney(source.amount_cents) : source.amount_cents || '—'}</td>
            <td><span className={badgeClass(row.status === 'new' ? 'Ativo' : row.status === 'duplicate' ? 'Inativo' : 'Cancelado')}>{PREVIEW_LABEL[row.status]}</span>{row.errors.length > 0 && <small className="real-help finance-recurrence-detail">{errorsText(row)}</small>}</td></tr>; })}</tbody></table></div>
        <div className="finance-import-actions">
          <button type="button" className="secondary-button" disabled={command.locked} onClick={() => { setLoaded(null); attempt.current++; }}>Cancelar</button>
          <button type="button" className="primary-button" disabled={!fresh.length || command.busy || !writable} onClick={runImport}>{command.busy ? 'Importando…' : command.uncertain ? 'Conferir resultado' : `Importar ${fresh.length === 1 ? '1 registro novo' : `${fresh.length} registros novos`}`}</button>
        </div>
        {command.error && <p className="real-alert" role="alert">{command.error}</p>}
      </>}
      <div className="finance-support"><h3>Ferramentas de apoio</h3><Link to={back.to}>{back.label}</Link></div>
    </section>
  </>;
}
