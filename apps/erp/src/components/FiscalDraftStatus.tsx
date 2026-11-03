import {useEffect,useId,useRef,useState,useSyncExternalStore} from 'react';
import {AccessError} from '../lib/real-access';
import type {FiscalFilters,FiscalModel} from '../lib/fiscal-drafts-model';
import type {FiscalDraftStatusSummary} from '../../../../packages/erp-domain/src/fiscal-draft-status-dto.mjs';
import {
 parseFiscalDraftStatusPage,fiscalDraftStatusPath,fiscalDraftStatusCanRead,fiscalNumberingLabel,fiscalAuthorizationLabel,fiscalAuthorizationPresentation,
 fiscalAuthorizationLabels,fiscalBasisDifferenceLabels,fiscalResultCodes,fiscalStatusMoment,fiscalStatusMoney,
 type FiscalDraftStatusController,type FiscalDraftStatusPage,type FiscalDraftStatusRow,type FiscalRecordedResult,
} from '../lib/fiscal-draft-status-model';
import NativeListLayout from './NativeListLayout';
import './fiscal-draft-status.css';

type Props={controller:FiscalDraftStatusController;initialModel?:FiscalModel;sourceDocumentId?:string|null;refreshKey?:number;blocked?:boolean;onOpenDraft?:(draft:FiscalDraftStatusSummary)=>void;onCreateDraft?:(model:FiscalFilters['model'])=>void;onModelChange?:(model:FiscalFilters['model'])=>void};
const aborted=(e:unknown)=>e instanceof DOMException&&e.name==='AbortError';
const failure=(e:unknown)=>e instanceof AccessError&&e.status===403?'Seu acesso à consulta fiscal mudou. Verifique suas permissões.'
 :e instanceof AccessError&&e.status===401?'A sessão precisa ser confirmada para consultar os documentos.'
 :e instanceof AccessError&&e.status===404?'O resumo fiscal não está disponível nesta consulta.'
 :'Não foi possível conferir o resumo fiscal. Tente consultar novamente.';

function RecordedResult({result,model}:{result:FiscalRecordedResult;model:FiscalModel}){
 const code=result.protocol_cstat??result.cstat;
 return <div className="fiscal-status-result"><p>{fiscalResultCodes(result)}</p>
  {result.protocol_number&&<p>Protocolo <span className="fiscal-status-identifier">{result.protocol_number}</span></p>}
  {result.received_at&&<small>Recebido em {fiscalStatusMoment(result.received_at)}</small>}
  <small>Registrado em {fiscalStatusMoment(result.recorded_at)}</small>
  {!result.rejection_code&&code==='245'&&<p>Emitente não cadastrado para {model==='65'?'NFC-e':'NF-e'} neste ambiente de homologação.</p>}
 </div>;
}

function AuthorizationSummary({row}:{row:FiscalDraftStatusRow}){
 const a=row.authorization,original=a.visibility==='available'?a.original:null;
 if(!original)return <p>{fiscalAuthorizationLabel(row)}</p>;
 const revalidation=a.revalidation.visibility==='available'?a.revalidation.result:null,basis=a.basis,summary=fiscalAuthorizationPresentation(row);
 return <div className="fiscal-status-authorization">
  <div className="fiscal-status-main-result" aria-label="Resumo do resultado registrado">
   <p className="fiscal-status-outcome">{summary.label} · {summary.source}</p>
   {summary.result&&<><p>{fiscalResultCodes(summary.result)}</p>{summary.result.protocol_number&&<p>Protocolo <span className="fiscal-status-identifier">{summary.result.protocol_number}</span></p>}</>}
  </div>
  {basis&&!basis.matches_current_preparation&&<p className="fiscal-status-warning">Resultado vinculado a uma preparação anterior. Ele não confirma a versão atual do rascunho.</p>}
  <details className="fiscal-status-records"><summary>Ver respostas registradas</summary>
  <section aria-label="Resultado original"><strong>{original.result?'Resposta original':'Tentativa original'}</strong><p className="fiscal-status-outcome">{fiscalAuthorizationLabel(row)}</p>{original.result&&<RecordedResult result={original.result} model={row.draft.model}/>}</section>
  {revalidation&&<section className="fiscal-status-revalidation" aria-label="Conferência posterior"><strong>Conferência posterior da mesma resposta</strong><p className="fiscal-status-outcome">{fiscalAuthorizationLabels[revalidation.state]}</p><RecordedResult result={revalidation} model={row.draft.model}/><small>O resultado original acima foi preservado.</small></section>}
  {a.revalidation.visibility==='restricted'&&<p className="real-help">A consulta de conferências posteriores depende do acesso do ator original.</p>}
  {a.revalidation.visibility==='inconsistent'&&<p className="fiscal-status-warning">O vínculo de uma conferência posterior não pôde ser confirmado.</p>}
  {a.revalidation.visibility==='unsupported'&&<p className="real-help">Conferência posterior fora do escopo deste resumo.</p>}
  <dl className="fiscal-status-details">
   <div><dt>Comando original</dt><dd>{original.command_id}</dd></div><div><dt>Candidata assinada</dt><dd>{original.candidate_id} · versão {original.candidate_version}</dd></div>
   {basis&&<><div><dt>Preparação usada</dt><dd>Rascunho v{basis.draft_version} · pedido v{basis.source_document_version}</dd></div><div><dt>Comparação com a preparação atual</dt><dd>{basis.matches_current_preparation?'Corresponde à preparação consultada':'Há diferenças na preparação'}; {basis.is_latest_candidate?'candidata mais recente':'existe candidata posterior'}.</dd></div></>}
   <div><dt>Política registrada</dt><dd>Versão {original.policy_version}</dd></div>
  </dl>{basis?.differences.length?<ul>{basis.differences.map(code=><li key={code}>{fiscalBasisDifferenceLabels[code]}</li>)}</ul>:null}
   {original.result&&<p>Registro histórico: mudanças posteriores do certificado ou da política não apagam este resultado. Sua validade não é deduzida da configuração atual.</p>}
   {original.result&&<p>Estes são os resultados registrados da resposta. O resumo não consulta a situação atual na SEFAZ, como cancelamentos posteriores.</p>}
   <p>Consultar este resumo não inicia nem repete um envio.</p>
  </details>
 </div>;
}

function StatusList({controller,actor,initialModel,sourceDocumentId=null,refreshKey=0,blocked=false,onOpenDraft,onCreateDraft,onModelChange}:Props&{actor:string}){
 const uid=useId(),[filters,setFilters]=useState<FiscalFilters>({model:initialModel??'',status:''}),[cursors,setCursors]=useState<(string|null)[]>([null]);
 const [value,setValue]=useState<{actor:string;page:FiscalDraftStatusPage}|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState(''),[reload,setReload]=useState(0);
 const request=useRef<AbortController|null>(null),alive=useRef(true),after=cursors.at(-1)??null;
 const live=useRef({controller,actor,blocked,onOpenDraft,onCreateDraft,onModelChange,page:value?.page??null,filters,cursors});live.current={controller,actor,blocked,onOpenDraft,onCreateDraft,onModelChange,page:value?.page??null,filters,cursors};
 const allowed=()=>{const s=controller.getSnapshot();return alive.current&&live.current.controller===controller&&live.current.actor===actor&&!live.current.blocked&&fiscalDraftStatusCanRead(s)&&s.membership?.user_id===actor;};
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;request.current?.abort();};},[]);
 useEffect(()=>{
  if(!allowed())return;
  const pending=new AbortController();request.current=pending;setLoading(true);setError('');setValue(null);
  void(async()=>{
   const raw=await controller.fiscalDraftStatus(fiscalDraftStatusPath(filters,after,sourceDocumentId),{signal:pending.signal});
   if(pending.signal.aborted||request.current!==pending||!allowed())return;
   const page=parseFiscalDraftStatusPage(raw,{model:filters.model||null,status:filters.status||null,sourceDocumentId,limit:25,after});
   if(!pending.signal.aborted&&request.current===pending&&allowed())setValue({actor,page});
  })().catch(e=>{if(!pending.signal.aborted&&request.current===pending&&allowed()&&!aborted(e))setError(failure(e));}).finally(()=>{if(request.current===pending){request.current=null;if(alive.current)setLoading(false);}});
  return()=>{pending.abort();if(request.current===pending)request.current=null;};
 },[controller,actor,filters,after,sourceDocumentId,refreshKey,reload,blocked]);
 const page=value?.actor===actor?value.page:null,free=()=>allowed()&&!request.current;
 const changeFilters=(next:FiscalFilters)=>{if(!free())return;const changed=next.model!==live.current.filters.model;live.current.filters=next;live.current.page=null;setValue(null);setFilters(next);setCursors([null]);if(changed)live.current.onModelChange?.(next.model);};
 const changePage=(next:boolean)=>{if(!free())return;const p=live.current.page;if(next&&p?.has_more&&p.next_cursor){live.current.page=null;setValue(null);setCursors(c=>[...c,p.next_cursor]);}else if(!next&&live.current.cursors.length>1){live.current.page=null;setValue(null);setCursors(c=>c.slice(0,-1));}};
 const open=(row:FiscalDraftStatusRow,selectedPage:FiscalDraftStatusPage)=>{if(!free()||live.current.page!==selectedPage||!selectedPage.items.some(current=>current===row))return;live.current.onOpenDraft?.(row.draft);};
 return <section className="fiscal-draft-status" aria-labelledby={`${uid}-title`} aria-busy={loading}>
  <header className="real-heading"><div><h2 id={`${uid}-title`}>Preparação e resultados fiscais</h2><p>A cópia do pedido, o número fiscal e o resultado da autorização são registros distintos.</p></div><span className="real-mode">Homologação · somente consulta</span></header>
  <NativeListLayout filters={<>
   <div className="form-field"><label htmlFor={`${uid}-model`}>Modelo</label><select id={`${uid}-model`} value={filters.model} disabled={blocked||loading} onChange={e=>changeFilters({...live.current.filters,model:e.target.value as FiscalFilters['model']})}><option value="">NF-e e NFC-e</option><option value="55">NF-e · modelo 55</option><option value="65">NFC-e · modelo 65</option></select></div>
   <div className="form-field"><label htmlFor={`${uid}-status`}>Situação da preparação</label><select id={`${uid}-status`} value={filters.status} disabled={blocked||loading} onChange={e=>changeFilters({...live.current.filters,status:e.target.value as FiscalFilters['status']})}><option value="">Todas</option><option value="draft">Em preparação</option><option value="archived">Arquivada</option></select></div>
   <button type="button" className="text-button" disabled={blocked||loading} onClick={()=>changeFilters({model:'',status:''})}>Limpar filtros</button>
  </>} actions={<>{onCreateDraft&&<button type="button" className="primary-button" disabled={blocked||loading||!page} onClick={()=>{if(free()&&live.current.page)live.current.onCreateDraft?.(live.current.filters.model);}}>Incluir rascunho</button>}<button type="button" className="secondary-button" disabled={blocked||loading} onClick={()=>{if(free()){live.current.page=null;setValue(null);setReload(x=>x+1);}}}>Atualizar resumo</button><p>A situação “Em preparação” descreve a cópia do pedido. Uma autorização ou rejeição registrada aparece separadamente.</p></>}>
   {error&&<p className="real-alert" role="alert">{error}</p>}<p role="status">{loading?'Consultando preparação e resultados…':page?`${page.items.length} registro(s) nesta página`:'Resumo indisponível'}</p>
   {page&&<>{!page.items.length?<p>Nenhum rascunho encontrado com estes filtros.</p>:<div className="table-scroll" role="region" tabIndex={0} aria-label="Resumo de preparação e resultados fiscais"><table className="data-table"><thead><tr><th>Modelo / pedido</th><th>Preparação</th><th>Número fiscal</th><th>Autorização</th>{onOpenDraft&&<th>Consultar</th>}</tr></thead><tbody>{page.items.map(row=><tr key={row.draft.id}>
    <th scope="row">{row.draft.model==='55'?'NF-e':'NFC-e'}<small>Pedido {row.draft.order_number}</small><small>{row.draft.contact_name}</small><small>{fiscalStatusMoney(row.draft.total)}</small></th>
    <td><strong>{row.draft.status==='draft'?'Em preparação':'Arquivada'}</strong><small>Revisão {row.draft.version} · pedido v{row.draft.source_document_version}</small><small>Atualizada em {fiscalStatusMoment(row.draft.updated_at)}</small></td>
    <td><strong>{fiscalNumberingLabel(row)}</strong>{row.numbering.reservation&&<small>Reservado para a revisão {row.numbering.reservation.draft_version}</small>}</td>
    <td><AuthorizationSummary row={row}/></td>{onOpenDraft&&<td><button type="button" className="text-button" disabled={blocked||loading} onClick={()=>open(row,page)} aria-label={`Abrir preparação do pedido ${row.draft.order_number}`}>Abrir preparação</button></td>}
   </tr>)}</tbody></table></div>}
   <footer className="fiscal-status-pagination"><span>Página {cursors.length} · horários de São Paulo</span><div><button type="button" className="secondary-button" disabled={blocked||loading||cursors.length===1} onClick={()=>changePage(false)}>Página anterior</button><button type="button" className="secondary-button" disabled={blocked||loading||!page.has_more} onClick={()=>changePage(true)}>Próxima página</button></div></footer></>}
  </NativeListLayout>
 </section>;
}

export default function FiscalDraftStatus(props:Props){
 const state=useSyncExternalStore(props.controller.subscribe,props.controller.getSnapshot);
 if(!fiscalDraftStatusCanRead(state))return<section className="fiscal-draft-status"><h2>Preparação e resultados fiscais</h2><p role="alert">A consulta requer acesso ativo de administrador ou fiscal.</p></section>;
 return <StatusList key={`${state.membership!.user_id}:${props.initialModel??''}:${props.sourceDocumentId??''}`} {...props} actor={state.membership!.user_id}/>;
}
