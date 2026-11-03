import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { AccessError } from '../lib/real-access';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { bankName, type CnabAccess, type CnabFile, type CnabPage } from '../lib/real-cnab-model';
import { HUMAN_REVIEW_LABELS, RETURN_KIND_LABELS, returnReason, reviewMoney, reviewDate, reviewMoment, humanDetail, humanPage, humanHistory, humanReviewInput, humanSaveResult,
  type CnabReviewController, type HumanDetail, type HumanPage, type HumanHistory, type HumanEventRow, type HumanRevision, type HumanSaveInput, type ReturnContext } from '../lib/cnab-review-model';
import NativeListLayout from './NativeListLayout';
import CnabReturnAmounts from './CnabReturnAmounts';
import './cnab-human-review.css';

const BASE = '/v1/conferencia-retornos';
const uuid = (s: string) => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(s);
const aborted = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';
const errorText = (e: unknown) => e instanceof AccessError ? e.status === 409 ? 'O contexto ou a revisão mudou. Atualize a consulta e confira novamente antes de registrar.'
  : e.status === 403 ? 'Seu perfil não permite esta operação.' : e.status === 404 ? 'O retorno ou evento não está disponível.' : e.status === 400 ? 'Confira os campos e a ocorrência selecionada.'
    : 'Não foi possível confirmar a operação. Confira o resultado antes de tentar outra alteração.' : e instanceof Error ? e.message : 'Não foi possível concluir a consulta.';
const plain = (value: string | null) => value || 'Não informado';
const statusClass = (status: string) => status === 'confirmed' ? 'status-neutral' : 'status-warning';
const query = (fileId: string, line: number) => new URLSearchParams({ file_id: fileId, line: String(line) });
function Notice() { return <p className="real-notice">Conferência para homologação. Registrar uma revisão não baixa títulos, não altera saldos e não vincula nosso número. A procedência declarada do arquivo não comprova autenticidade bancária.</p>; }
function Status({ status }: { status: 'pending' | 'confirmed' | 'pending_issue' }) { return <span className={`status-badge ${statusClass(status)}`}>{HUMAN_REVIEW_LABELS[status]}</span>; }
function Data({ children }: { children: ReactNode }) { return <dl className="human-review-data">{children}</dl>; }
function Row({ label, children }: { label: string; children: ReactNode }) { return <div><dt>{label}</dt><dd>{children}</dd></div>; }
function Check({ value }: { value: boolean | null }) { return <span className={value === false ? 'human-review-difference' : ''}>{value === null ? 'Sem vínculo para comparar' : value ? 'Coincide' : 'Diverge / requer conferência'}</span>; }

/** Original occurrence, current linked title and immutable past contexts use the same explicit labels. */
function ContextView({ value, historical = false }: { value: ReturnContext; historical?: boolean }) {
  const { event: e, occurrence: o, profile: p, title: t, billing: b, comparison: c } = value;
  return <div className="human-review-context">
    <div className="human-review-context-title"><h3>{historical ? 'Contexto preservado nesta revisão' : 'Contexto atual da ocorrência'}</h3><span>{bankName(e.bank)} · carteira {e.wallet} · {p.account_name} · conta {p.account_mask}</span></div>
    <div className="human-review-columns"><section><h4>Informações do arquivo</h4><Data>
      <Row label="Ocorrência">{e.occurrence} · {RETURN_KIND_LABELS[e.kind] || e.kind}</Row><Row label="Documento / controle">{plain(e.document_number)} / {plain(e.control)}</Row>
      <Row label="Nosso número">{plain(e.our_number)}</Row>
      <Row label="Vencimento">{reviewDate(e.due_on)}</Row><Row label="Ocorrência / crédito">{reviewDate(e.occurred_on)} / {reviewDate(e.credited_on)}</Row>
      <Row label="Arquivo / linha">{reviewDate(o.generated_on)} · linha {o.line}{o.duplicate ? ' · evento recebido novamente' : ''}</Row>
      <Row label="Procedência declarada">{o.declared_bank_origin ? `Obtido do banco · referência ${o.reference_id}` : 'Não declarada como bancária'}</Row>
    </Data></section><section><h4>{historical ? 'Título no momento da revisão' : 'Título financeiro atual'}</h4>{t && b ? <Data>
      <Row label="Descrição">{t.description}</Row><Row label="Documento / controle">{plain(b.document_number)} / {plain(b.control)}</Row><Row label="Nosso número vinculado">{plain(b.our_number)}</Row>
      <Row label="Principal">{reviewMoney(t.amount_cents)}</Row><Row label="Principal baixado">{reviewMoney(t.settled_cents)}</Row><Row label="Principal em aberto">{reviewMoney(t.balance_cents)}</Row>
      <Row label="Vencimento">{reviewDate(t.due_on)}</Row><Row label="Situação / versão">{t.cancelled ? 'Cancelado' : t.settled_cents === '0' ? 'Sem baixas' : t.balance_cents === '0' ? 'Baixado' : 'Baixa parcial'} · versão {t.version}</Row>
      <Row label="Remessa">{b.remittance_state === 'ready' ? 'Arquivo disponível' : 'Reserva preservada'}</Row>
    </Data> : <p className="real-help">Não há vínculo exato com um título. Esta tela não permite escolher ou associar outro título.</p>}
    <p className="real-help">Conta {p.account_active ? 'ativa' : 'inativa'} · versão {p.account_version}. Contrato {p.contract_verified ? 'conferido' : 'pendente'}; regras {p.policy_verified ? 'conferidas' : 'pendentes'}. Essas declarações não habilitam produção bancária.</p></section></div>
    <section><h4>Comparação das referências</h4><Data><Row label="Documento e controle"><Check value={c.reference_matches} /></Row><Row label="Nosso número"><Check value={c.bank_number_matches} /></Row>
      <Row label="Valor nominal"><Check value={c.amount_matches} /></Row><Row label="Vencimento"><Check value={c.due_matches} /></Row><Row label="Título totalmente em aberto"><Check value={c.fully_open} /></Row>
      <Row label="Recebido igual ao principal em aberto"><Check value={c.paid_matches_balance} /></Row><Row label="Ajustes no retorno">{c.has_adjustments ? 'Há valores que precisam de conferência' : 'Sem ajustes informados'}</Row></Data>
      <p className="real-notice">{returnReason(c.reason)}</p><p className="real-help">Análise técnica original: {returnReason(value.proposal.reason)} Nenhuma proposta é aplicada ao financeiro.</p>
    </section>
    <CnabReturnAmounts event={e} historical={historical} />
    {(e.warnings.length > 0 || o.warnings.length > 0) && <section><h4>Alertas do arquivo</h4><ul className="human-review-warnings">{Array.from(new Set([...e.warnings, ...o.warnings])).map(item => <li key={item}>{returnReason(item)}</li>)}</ul></section>}
    <details className="human-review-identifiers"><summary>Identificadores da conferência</summary><Data><Row label="Arquivo SHA-256">{o.file_hash}</Row><Row label="Evento SHA-256">{e.hash}</Row><Row label="Linha SHA-256">{o.line_hash}</Row></Data></details>
  </div>;
}

function History({ controller, eventId }: { controller: CnabReviewController; eventId: string }) {
  const [cursors, setCursors] = useState<(number | null)[]>([null]), [page, setPage] = useState<HumanHistory | null>(null), [selected, setSelected] = useState<HumanRevision | null>(null), [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  const before = cursors.at(-1) ?? null;
  useEffect(() => { const request = new AbortController(); setPage(null); setSelected(null); setError('');
    void controller.cnabReview(`${BASE}/events/${eventId}/history?limit=25${before === null ? '' : `&before=${before}`}`, { signal: request.signal }).then(value => { const result = humanHistory(value, eventId, before); if (!request.signal.aborted) setPage(result); }).catch(e => { if (!request.signal.aborted && !aborted(e)) setError(errorText(e)); }); return () => request.abort();
  }, [controller, eventId, before, refresh]);
  return <section className="human-review-history" aria-label="Histórico de conferências"><h3>Histórico imutável de conferências</h3><p className="real-help">Uma revisão preserva o arquivo, a ocorrência e os valores vistos naquele momento. A revisão mais recente não altera as anteriores.</p>
    {error && <p className="real-alert" role="alert">{error} <button className="text-button" onClick={() => setRefresh(n => n + 1)}>Tentar novamente</button></p>}
    <div className="table-scroll"><table className="data-table"><thead><tr><th>Revisão / data</th><th>Decisão</th><th>Motivo</th><th>Contexto</th></tr></thead><tbody>{page?.items.map(item => <tr key={item.version}><td>Revisão {item.version}<small>{reviewMoment(item.reviewed_at)}</small></td><td><Status status={item.status} /></td><td>{item.reason}</td><td><button type="button" className="text-button" onClick={() => setSelected(item)}>Ver revisão {item.version}</button></td></tr>)}{!page?.items.length && <tr><td colSpan={4}>{page ? 'Nenhuma conferência registrada.' : error ? 'Histórico indisponível.' : 'Carregando histórico…'}</td></tr>}</tbody></table></div>
    {page && <footer className="table-footer"><span>Página {cursors.length}</span><div className="pagination"><button type="button" className="secondary-button" disabled={cursors.length === 1} onClick={() => setCursors(v => v.slice(0, -1))}>Anterior</button><button type="button" className="secondary-button" disabled={!page.has_more} onClick={() => setCursors(v => [...v, page.next_cursor])}>Mais antigas</button></div></footer>}
    {selected && <section className="human-review-historical"><h3>Revisão {selected.version} · {HUMAN_REVIEW_LABELS[selected.status]}</h3><p>{selected.reason}</p><p className="real-notice">Consulta histórica. Estes valores não representam necessariamente o contexto atual.</p><ContextView value={selected.context} historical /><button type="button" className="secondary-button" onClick={() => setSelected(null)}>Fechar contexto histórico</button></section>}
  </section>;
}

function EventEditor({ controller, row, fileId, canWrite, onBack }: { controller: CnabReviewController; row: HumanEventRow; fileId: string; canWrite: boolean; onBack: () => void }) {
  const uid = useId(), titleRef = useRef<HTMLHeadingElement>(null), [detail, setDetail] = useState<HumanDetail | null>(null), [preview, setPreview] = useState<HumanDetail | null>(null);
  const [status, setStatus] = useState(''), [reason, setReason] = useState(''), [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [retry, setRetry] = useState(false), [conflict, setConflict] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState(''), [history, setHistory] = useState(false);
  const request = useRef<AbortController | null>(null), command = useRef<HumanSaveInput | null>(null), saved = useRef<number | null>(null), uncertain = useRef(false);
  const dirty = Boolean(status || reason || confirmed || preview), guard = useUnsavedChanges(dirty || retry, busy || retry);
  const path = `${BASE}/events/${row.event_id}`, detailPath = `${path}?${query(fileId, row.line)}`;
  const getCurrent = async (signal: AbortSignal) => humanDetail(await controller.cnabReview(detailPath, { signal }), row.event_id, fileId, row.line);
  const canReset = () => !request.current && !command.current && saved.current === null && !uncertain.current;
  useEffect(() => { const current = new AbortController(); request.current = current; setBusy(true); titleRef.current?.focus();
    void getCurrent(current.signal).then(value => { if (!current.signal.aborted) setDetail(value); }).catch(e => { if (!current.signal.aborted && !aborted(e)) setError(errorText(e)); }).finally(() => { if (!current.signal.aborted) { request.current = null; setBusy(false); } }); return () => { current.abort(); request.current?.abort(); };
  // Each occurrence is a separate editor and preserves its own command identity.
  }, [controller, fileId, row.event_id, row.line]);
  const load = async () => {
    if (!canReset()) return; const current = new AbortController(); request.current = current; setBusy(true); setError(''); setPreview(null); setConfirmed(false);
    try { const value = await getCurrent(current.signal); if (!current.signal.aborted) { setDetail(value); setConflict(false); } } catch (e) { if (!current.signal.aborted && !aborted(e)) setError(errorText(e)); }
    finally { if (!current.signal.aborted) { request.current = null; setBusy(false); } }
  };
  const verify = async () => {
    if (!canReset() || retry || conflict) return; const current = new AbortController(); request.current = current; setBusy(true); setError(''); setPreview(null); setConfirmed(false); setMessage('');
    try { const value = humanDetail(await controller.cnabReview(`${path}/preview`, { method: 'POST', body: { file_id: fileId, line: row.line }, signal: current.signal }), row.event_id, fileId, row.line, true);
      if (!current.signal.aborted) { setDetail(value); setPreview(value); } }
    catch (e) { if (!current.signal.aborted && !aborted(e)) { setError(errorText(e)); setConflict(e instanceof AccessError && e.status === 409); } }
    finally { if (!current.signal.aborted) { request.current = null; setBusy(false); } }
  };
  const execute = async () => {
    if (request.current || !command.current) return; const current = new AbortController(); request.current = current; setBusy(true); setError(''); setMessage('');
    const priorUncertain = uncertain.current;
    try {
      if (saved.current === null) { const result = humanSaveResult(await controller.cnabReview(`${path}/review`, { method: 'POST', body: command.current, signal: current.signal }), row.event_id, command.current); if (current.signal.aborted) return; saved.current = result.record.version; }
      const value = await getCurrent(current.signal); if (current.signal.aborted) return;
      if (value.review_version < saved.current) throw new Error('A consulta ainda não contém a revisão registrada. Consulte novamente o resultado.');
      setDetail(value); setPreview(null); setConfirmed(false); setStatus(''); setReason(''); setRetry(false); setConflict(false); command.current = null; saved.current = null; uncertain.current = false;
      setHistory(false); setMessage('Conferência registrada. O contexto atual foi consultado; nenhum título ou saldo foi alterado.'); titleRef.current?.focus();
    } catch (e) { if (!current.signal.aborted && !aborted(e)) { const known = e instanceof AccessError && [400, 403, 404, 409].includes(e.status) && saved.current === null && !priorUncertain;
      uncertain.current = !known;
      setRetry(!known); setConflict(known && e.status === 409); setError(saved.current !== null ? 'A revisão foi registrada, mas a consulta atual não pôde ser concluída. Confira o resultado antes de continuar.' : known ? errorText(e) : 'O resultado desta tentativa permanece incerto. Os campos foram preservados; repita a mesma confirmação para conferir o resultado.');
      if (known) { command.current = null; setPreview(null); setConfirmed(false); } } }
    finally { if (!current.signal.aborted) { request.current = null; setBusy(false); } }
  };
  const save = () => { if (!canReset() || busy || retry || conflict) return; try { command.current = humanReviewInput(preview, status, reason, confirmed, crypto.randomUUID()); saved.current = null; void execute(); } catch (e) { setError(errorText(e)); } };
  const locked = busy || retry || conflict;
  return <section className="human-review-editor" aria-labelledby={`${uid}-title`}>
    <header className="real-editor-heading"><div><h2 ref={titleRef} tabIndex={-1} id={`${uid}-title`}>Conferir evento · linha {row.line}</h2><p>Documento {plain(row.document_number)} · {RETURN_KIND_LABELS[row.kind] || row.kind}</p></div><button type="button" className="secondary-button" disabled={busy || retry} onClick={() => { if (canReset()) guard.confirmLeave(() => { if (canReset()) onBack(); }); }}>Voltar aos eventos</button></header><Notice />
    {error && <p className="real-alert" role="alert">{error}</p>}{message && <p className="real-notice" role="status">{message}</p>}
    {retry && <p><button type="button" className="primary-button" disabled={busy} onClick={() => void execute()}>{saved.current ? 'Consultar revisão registrada' : 'Repetir a mesma confirmação'}</button><small className="human-review-help">Os campos permanecem bloqueados até conferir o resultado desta operação.</small></p>}
    {(conflict || !detail && !busy) && !retry && <button type="button" className="secondary-button" disabled={busy} onClick={() => void load()}>Atualizar contexto</button>}
    {detail && <>
      <section className="human-review-current"><h3>Conferência humana atual</h3><Status status={detail.review?.status || 'pending'} />{detail.review ? <><p>Revisão {detail.review.version} · {reviewMoment(detail.review.reviewed_at)}</p><p>{detail.review.reason}</p>{detail.review.context_changed && <p className="real-alert" role="status">Contexto mudou desde esta revisão. A decisão anterior permanece preservada; confira novamente os dados atuais.</p>}</> : <p>Nenhuma revisão humana registrada para este evento.</p>}</section>
      <ContextView value={detail.context} />
      <section className="human-review-decision" aria-labelledby={`${uid}-decision`}><h3 id={`${uid}-decision`}>Registrar conferência humana</h3>{canWrite ? <>
        <p>Primeiro confira os bytes do arquivo original e compare os dados acima. Uma nova revisão preserva as decisões anteriores.</p>
        <button type="button" className="secondary-button" disabled={locked} onClick={() => void verify()}>{preview ? 'Conferir arquivo novamente' : 'Conferir arquivo original'}</button>
        {preview && <p className="real-notice" role="status">Arquivo original conferido por conteúdo e ocorrência. Revise o contexto exibido antes da confirmação.</p>}
        <fieldset disabled={locked}><legend>Decisão desta revisão</legend><div className="form-field"><label htmlFor={`${uid}-status`}>Situação da conferência</label><select id={`${uid}-status`} value={status} onChange={e => { setStatus(e.target.value); setConfirmed(false); }}><option value="">Selecione uma decisão</option><option value="confirmed">Conferido para homologação</option><option value="pending_issue">Pendência mantida</option></select></div>
          <div className="form-field"><label htmlFor={`${uid}-reason`}>Motivo da conferência</label><textarea id={`${uid}-reason`} rows={3} maxLength={1000} value={reason} onChange={e => { setReason(e.target.value); setConfirmed(false); }} aria-describedby={`${uid}-reason-help`} /><small id={`${uid}-reason-help`}>De 3 a 1.000 caracteres, em uma única linha. Descreva o que foi conferido ou o que permanece pendente.</small></div>
          <label className="human-review-check"><input type="checkbox" disabled={!preview} checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />Conferi o arquivo e o contexto exibidos. Esta decisão é apenas de homologação e não autoriza baixa financeira nem vínculo de nosso número.</label>
        </fieldset><button type="button" className="primary-button" disabled={locked || !preview || !confirmed || !status || reason.trim().length < 3} onClick={save}>Registrar conferência</button>
      </> : <p>Seu perfil permite consultar as conferências. O registro de uma decisão é reservado aos perfis financeiro e administrador.</p>}</section>
      <section className="human-review-history-toggle"><button type="button" className="secondary-button" disabled={busy || retry} aria-expanded={history} onClick={() => setHistory(v => !v)}>{history ? 'Ocultar histórico' : 'Consultar histórico de conferências'}</button>{history && <History key={detail.review_version} controller={controller} eventId={row.event_id} />}</section>
    </>}{busy && <p role="status">{detail ? 'Conferindo a operação…' : 'Carregando contexto…'}</p>}
  </section>;
}

function Events({ controller, fileId, canWrite, onBack }: { controller: CnabReviewController; fileId: string; canWrite: boolean; onBack: () => void }) {
  const [cursors, setCursors] = useState([1]), [page, setPage] = useState<HumanPage | null>(null), [selected, setSelected] = useState<HumanEventRow | null>(null), [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  const after = cursors.at(-1)!;
  useEffect(() => { if (selected) return; const request = new AbortController(); setPage(null); setError('');
    void controller.cnabReview(`${BASE}/files/${fileId}?limit=25&after=${after}`, { signal: request.signal }).then(value => { const result = humanPage(value, fileId, after); if (!request.signal.aborted) setPage(result); }).catch(e => { if (!request.signal.aborted && !aborted(e)) setError(errorText(e)); }); return () => request.abort();
  }, [controller, fileId, after, refresh, selected]);
  if (selected) return <EventEditor controller={controller} fileId={fileId} row={selected} canWrite={canWrite} onBack={() => { setSelected(null); setRefresh(n => n + 1); }} />;
  return <section><header className="real-editor-heading"><div><h2>Eventos do retorno</h2><p>Uma conferência canônica por evento, com cada recebimento preservado.</p></div><button type="button" className="secondary-button" onClick={onBack}>Selecionar outro arquivo</button></header><Notice />
    <NativeListLayout filters={<><p className="real-help">Eventos deste arquivo, em ordem de linha. A paginação não altera a decisão de conferência.</p><p className="human-review-help">Uma ocorrência repetida pode exibir uma revisão já feita em outro recebimento.</p></>} actions={<><button type="button" className="secondary-button" onClick={() => setRefresh(n => n + 1)}>Atualizar eventos</button><p className="real-help">Selecione o documento para comparar o retorno, o vínculo salvo e o título.</p></>}>
      {error && <p className="real-alert" role="alert">{error}</p>}<div className="table-scroll"><table className="data-table human-review-table"><thead><tr><th>Linha / documento</th><th>Evento do arquivo</th><th>Nominal</th><th>Recebido</th><th>Conferência humana</th></tr></thead><tbody>{page?.items.map(row => <tr key={row.line}><td><button type="button" className="text-button" onClick={() => setSelected(row)}>{plain(row.document_number)}</button><small>Linha {row.line} · {plain(row.control)}</small></td><td>{RETURN_KIND_LABELS[row.kind] || row.kind}{row.duplicate && <small>Recebido novamente</small>}</td><td>{reviewMoney(row.amount_cents)}</td><td>{reviewMoney(row.paid_cents)}</td><td><Status status={row.review_status} />{row.context_changed && <small className="human-review-difference">Contexto mudou</small>}</td></tr>)}{!page?.items.length && <tr><td colSpan={5}>{page ? 'Nenhum evento nesta página.' : error ? 'Eventos indisponíveis.' : 'Carregando eventos…'}</td></tr>}</tbody></table></div>
      {page && <footer className="table-footer"><span>Página {cursors.length} · {page.items.length} evento(s)</span><div className="pagination"><button type="button" className="secondary-button" disabled={cursors.length === 1} onClick={() => setCursors(v => v.slice(0, -1))}>Anterior</button><button type="button" className="secondary-button" disabled={!page.has_more} onClick={() => setCursors(v => [...v, page.next_cursor!])}>Próxima</button></div></footer>}
    </NativeListLayout></section>;
}

export default function RealCnabReview({ controller, initialFileId }: { controller: CnabReviewController; initialFileId?: string }) {
  const [access, setAccess] = useState<CnabAccess | null>(null), [selected, setSelected] = useState<string | null>(initialFileId && uuid(initialFileId) ? initialFileId : null), [page, setPage] = useState<CnabPage<CnabFile> | null>(null), [cursors, setCursors] = useState<(string | null)[]>([null]), [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  const after = cursors.at(-1) ?? null;
  useEffect(() => { const request = new AbortController(); setError(''); setAccess(null);
    void controller.cnab('/v1/cnab', { signal: request.signal }).then(value => { const result = value as CnabAccess; if (!result || result.read !== true || typeof result.write !== 'boolean' || result.purpose !== 'homologation' || result.productionReady !== false || result.financialMutationPerformed !== false) throw new Error('Não foi possível conferir as permissões da cobrança.'); if (!request.signal.aborted) setAccess(result); }).catch(e => { if (!request.signal.aborted && !aborted(e)) setError(errorText(e)); }); return () => request.abort();
  }, [controller, refresh]);
  useEffect(() => { if (!access || selected) return; const request = new AbortController(); setPage(null); setError(''); const params = new URLSearchParams({ limit: '25' }); if (after) params.set('after', after);
    void controller.cnab(`/v1/cnab/returns?${params}`, { signal: request.signal }).then(value => { const result = value as CnabPage<CnabFile>;
      if (!result || result.limit !== 25 || !Array.isArray(result.items) || result.items.length > 25 || typeof result.has_more !== 'boolean' || (result.has_more ? !uuid(result.next_cursor || '') : result.next_cursor !== null)
        || result.items.some(file => !uuid(file.id) || file.kind !== 'return' || file.state !== 'ready' || typeof file.filename !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(file.generated_on) || !/^[a-f0-9]{64}$/.test(file.file_hash || ''))) throw new Error('Não foi possível conferir a lista de retornos.');
      if (!request.signal.aborted) setPage(result); }).catch(e => { if (!request.signal.aborted && !aborted(e)) setError(errorText(e)); }); return () => request.abort();
  }, [controller, access, selected, after, refresh]);
  if (!access) return <section className="real-human-review"><h2>Conferência de retornos</h2>{error ? <p role="alert" className="real-alert">{error} <button type="button" className="text-button" onClick={() => setRefresh(n => n + 1)}>Tentar novamente</button></p> : <p role="status">Verificando acesso…</p>}</section>;
  if (selected) return <div className="real-human-review"><Events key={selected} controller={controller} fileId={selected} canWrite={access.write} onBack={() => setSelected(null)} /></div>;
  return <section className="real-human-review"><header className="real-editor-heading"><div><h2>Conferência de retornos</h2><p>CNAB 400 · conferência bancária</p></div><span className="status-badge status-warning">Somente homologação</span></header><Notice />
    <NativeListLayout filters={<p className="real-help">Selecione um retorno já importado. Cada arquivo conserva suas ocorrências; eventos repetidos compartilham o histórico de revisão.</p>} actions={<><button type="button" className="secondary-button" onClick={() => setRefresh(n => n + 1)}>Atualizar retornos</button><p className="real-help">Novos arquivos são incluídos em Cobrança bancária → Retornos.</p></>}>
      {error && <p className="real-alert" role="alert">{error}</p>}<div className="table-scroll"><table className="data-table human-review-table"><thead><tr><th>Arquivo de retorno</th><th>Data do arquivo</th><th>Referência de conteúdo</th><th>Ação</th></tr></thead><tbody>{page?.items.map(file => <tr key={file.id}><td>{file.filename}</td><td>{reviewDate(file.generated_on)}</td><td>{file.file_hash?.slice(0, 16)}…</td><td><button type="button" className="text-button" onClick={() => setSelected(file.id)}>Conferir eventos</button></td></tr>)}{!page?.items.length && <tr><td colSpan={4}>{page ? 'Nenhum retorno importado nesta página.' : error ? 'Lista indisponível.' : 'Carregando retornos…'}</td></tr>}</tbody></table></div>
      {page && <footer className="table-footer"><span>Página {cursors.length} · {page.items.length} arquivo(s)</span><div className="pagination"><button type="button" className="secondary-button" disabled={cursors.length === 1} onClick={() => setCursors(v => v.slice(0, -1))}>Anterior</button><button type="button" className="secondary-button" disabled={!page.has_more} onClick={() => setCursors(v => [...v, page.next_cursor])}>Próxima</button></div></footer>}
    </NativeListLayout></section>;
}
