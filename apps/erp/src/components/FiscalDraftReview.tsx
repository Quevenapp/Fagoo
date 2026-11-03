import { useEffect, useId, useState } from 'react';
import { AccessError } from '../lib/real-access';
import { fiscalMoment, fiscalDecimal } from '../lib/fiscal-drafts-model';
import { fiscalReviewPath, fiscalReviewView, FISCAL_REVIEW_LABELS, REVIEW_SCOPE_LABELS, type FiscalReviewController, type FiscalReviewView, type ReviewFinding } from '../lib/fiscal-review-model';
import './fiscal-review.css';

const plain = (value: string | null | undefined) => value ?? 'Não informado';
const PAGE = 25;
const sources: Record<ReviewFinding['source'], string> = { snapshot: 'Cópia inicial da revisão selecionada', current_catalog: 'Cadastro atual consultado para comparação', comparison: 'Comparação de versões', pipeline: 'Não avaliado por este relatório' };
const errorMessage = (error: unknown) => error instanceof AccessError
  ? error.status === 403 ? 'Seu acesso à conferência fiscal não está disponível.'
    : error.status === 404 ? 'Esta revisão não está disponível para conferência.' : 'Não foi possível consultar a conferência fiscal. Tente novamente.'
  : 'Não foi possível conferir o relatório desta revisão. Consulte novamente o rascunho.';

/** Read-only helper: parent supplies the exact displayed draft revision/hash. */
export default function FiscalDraftReview({ controller, draftId, revision, snapshotHash }: {
  controller: FiscalReviewController; draftId: string; revision: number; snapshotHash: string;
}) {
  const uid = useId(), key = draftId + ':' + revision + ':' + snapshotHash;
  const [entry, setEntry] = useState<{ key: string; value: FiscalReviewView } | null>(null);
  const [requestState, setRequestState] = useState<{ key: string; loading: boolean; error: string }>({ key, loading: true, error: '' });
  const [reload, setReload] = useState(0), [page, setPage] = useState(0);
  const value = entry?.key === key ? entry.value : null;
  const loading = requestState.key !== key || requestState.loading;
  const error = requestState.key === key ? requestState.error : '';
  const refresh = () => { setEntry(null); setPage(0); setRequestState({ key, loading: true, error: '' }); setReload(n => n + 1); };
  useEffect(() => {
    const request = new AbortController(); setEntry(null); setPage(0); setRequestState({ key, loading: true, error: '' });
    void (async () => {
      try {
        const raw = await controller.fiscalDraft(fiscalReviewPath(draftId, revision), { signal: request.signal });
        if (request.signal.aborted) return;
        const checked = fiscalReviewView(raw, draftId, revision, snapshotHash);
        setEntry({ key, value: checked }); setRequestState({ key, loading: false, error: '' });
      } catch (cause) {
        if (!request.signal.aborted) { setEntry(null); setRequestState({ key, loading: false, error: errorMessage(cause) }); }
      }
    })();
    return () => request.abort();
  }, [controller, draftId, revision, snapshotHash, key, reload]);
  const findings = value?.report.findings ?? [], globalFindings = findings.filter(f => f.item_id === null);
  const observedFindings = findings.filter(f => f.source !== 'pipeline'), outsideScope = globalFindings.filter(f => f.source === 'pipeline');
  const items = value?.basis.draft.record.snapshot.items ?? [], productMap = new Map(value?.basis.catalog.map(p => [p.product_id, p.record]) ?? []);
  const visible = items.slice(page * PAGE, (page + 1) * PAGE);
  return <section className="fiscal-review" aria-labelledby={uid + '-title'} aria-busy={loading}>
    <header className="fiscal-review-heading"><div><h3 id={uid + '-title'}>Conferência fiscal da cópia inicial</h3><p>Revisão {revision} · Cópia do pedido e comparação de cadastro</p></div>
      <button type="button" className="secondary-button" disabled={loading} onClick={refresh}>Repetir conferência</button></header>
    <p className="real-notice">Este relatório examina a cópia inicial do pedido nesta revisão e compara os produtos com o cadastro consultado. Não consulta as preparações de itens, tributária ou complemento fiscal, nem o XML gerado ou o certificado. Seus apontamentos não representam a situação atual dessas etapas.</p>
    <p className="real-help">A conferência aponta dados e limites do perfil XML nessa cópia. Não calcula tributos, não valida o enquadramento fiscal e não habilita emissão.</p>
    {loading && <p role="status">Conferindo a revisão selecionada…</p>}
    {error && <div role="alert" className="real-alert"><p>{error}</p><button type="button" className="secondary-button" onClick={refresh}>Tentar novamente</button></div>}
    {value && !loading && <>
      <p className="real-help">Cadastro atual consultado em {fiscalMoment(value.basis.observed_at)}. A conferência dos dados não substitui a revisão tributária da operação.</p>
      {(value.basis.draft.current.version !== revision || value.basis.draft.current.status === 'archived') && <p className="real-notice">Relatório da revisão {revision}. O rascunho atual está na revisão {value.basis.draft.current.version}, {value.basis.draft.current.status === 'archived' ? 'arquivado' : 'em preparação'}. Esta consulta não modifica o histórico.</p>}
      <div className="fiscal-review-counts" aria-label="Apontamentos da cópia inicial e da comparação"><span><strong>{observedFindings.filter(f => f.severity === 'blocking').length}</strong> limites ou ausências na cópia inicial</span><span><strong>{observedFindings.filter(f => f.severity === 'review').length}</strong> comparações e verificações desta cópia</span><span><strong>{items.length}</strong> itens</span></div>
      <div className="fiscal-review-groups">
        {(['document', 'issuer', 'recipient', 'payments', 'dependencies'] as const).map(scope => {
          const rows = globalFindings.filter(f => f.scope === scope && f.source !== 'pipeline');
          return rows.length > 0 && <section key={scope}><h4>{REVIEW_SCOPE_LABELS[scope]}</h4><ul>{rows.map((finding, index) => <li key={finding.code + ':' + index}><span className={finding.severity === 'blocking' ? 'fiscal-review-blocker' : ''}>{FISCAL_REVIEW_LABELS[finding.code]}</span><small>{sources[finding.source]}</small></li>)}</ul></section>;
        })}
      </div>
      {outsideScope.length > 0 && <details className="fiscal-review-outside"><summary>Preparações e etapas fora do escopo deste relatório</summary><p className="real-help">Consulte os painéis correspondentes para saber o que foi preenchido, gerado ou configurado. Estes lembretes não são pendências atuais desses módulos.</p><ul>{outsideScope.map((finding,index)=><li key={finding.code+':'+index}>{FISCAL_REVIEW_LABELS[finding.code]}<small>{sources.pipeline}</small></li>)}</ul></details>}
      <h4>Itens da cópia inicial</h4>
      <p className="real-help">Dados atuais servem apenas para comparação. A cópia inicial utilizada por este relatório não inclui as decisões de origem, CEST ou GTIN tributário registradas nas preparações fiscais. Corrigir o cadastro não substitui a cópia histórica nem define os tributos do item.</p>
      <div className="table-scroll"><table className="data-table fiscal-review-table"><caption>Comparação da revisão com o cadastro atual dos produtos</caption><thead><tr><th>Item</th><th>Quantidade / unidade</th><th>NCM da revisão</th><th>Cadastro atual</th><th>Apontamentos</th></tr></thead>
        <tbody>{visible.map(item => {
          const current = item.product_id ? productMap.get(item.product_id) : null;
          const notes = findings.filter(f => f.item_id === item.id);
          const capturedNotes = notes.filter(f => f.source !== 'pipeline'), otherChecks = notes.filter(f => f.source === 'pipeline');
          const exact = value.report.items.find(i => i.item_id === item.id)!;
          return <tr key={item.id}><th scope="row">{item.position}. {item.description}<small>{plain(item.code)} · {item.product ? 'Produto v' + item.product.version : 'Item livre'}</small></th>
            <td>{fiscalDecimal(exact.quantity_lexical ?? item.quantity)} {item.unit}{exact.quantity_lexical === null && <small>Quantidade exige conferência: o formato fiscal aceita até quatro casas decimais.</small>}</td>
            <td>{plain(item.product?.ncm)}<small>Classificação não verificada</small></td>
            <td>{current ? 'Versão ' + current.version + (current.active ? '' : ' · inativo') : item.product_id ? 'Não disponível' : 'Sem vínculo'}<small>{exact.catalog_state === 'changed' ? 'Alterado desde a cópia' : exact.catalog_state === 'same_version' ? 'Mesma versão; não equivale a validação fiscal' : ''}</small></td>
            <td><details><summary>{capturedNotes.length} apontamentos da cópia ou comparação · item {item.position}</summary><ul>{capturedNotes.map((finding, index) => <li key={finding.code + ':' + index}>{FISCAL_REVIEW_LABELS[finding.code]}<small>{sources[finding.source]}</small></li>)}</ul>
              {otherChecks.length > 0 && <><h5>Definições de outros painéis não consultadas aqui</h5><ul>{otherChecks.map((finding,index)=><li key={finding.code+':'+index}>{FISCAL_REVIEW_LABELS[finding.code]}<small>{sources.pipeline}</small></li>)}</ul></>}
              <dl className="fiscal-review-comparison"><dt>NCM atual</dt><dd>{plain(current?.ncm)}</dd><dt>Origem atual</dt><dd>{plain(current?.origin)}</dd><dt>CEST atual</dt><dd>{plain(current?.cest)}</dd><dt>GTIN na revisão</dt><dd>{plain(item.product?.gtin)}</dd><dt>GTIN tributário atual</dt><dd>{plain(current?.gtin_tax)}</dd></dl>
              <p className="real-help">Valores do cadastro atual não foram aplicados à revisão. A ausência de CEST não afirma que ele seja obrigatório.</p>
            </details></td></tr>;
        })}</tbody></table></div>
      <div className="table-footer"><span>Página {page + 1} · {items.length} itens</span><div className="button-group"><button type="button" className="secondary-button" disabled={page === 0} onClick={() => setPage(p => p - 1)}>Itens anteriores</button><button type="button" className="secondary-button" disabled={(page + 1) * PAGE >= items.length} onClick={() => setPage(p => p + 1)}>Próximos itens</button></div></div>
    </>}
  </section>;
}
