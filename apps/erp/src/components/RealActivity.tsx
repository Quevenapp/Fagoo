import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {AccessError,type AccessState} from '../lib/real-access';
import {activityPath,activityDetailPath} from '../lib/activity-request';
import {ACTIVITY_DETAIL_SOURCES,parseActivityDetail,captureActivityDetailQuery,type ActivityDetail,type ActivityEntry} from '../../../../packages/erp-domain/src/activity.mjs';
import {Modal} from './Modal';
import {usersListPath} from '../lib/access-users-request';
import {parseUsersList,captureUsersQuery,type AccessUser} from '../lib/access-users-model';
import {parseActivity,captureActivityQuery,ACTIVITY_MODULES,ACTIVITY_OPERATIONS,MODULE_TEXT,OPERATION_TEXT,PERIOD_TEXT,periodRange,todaySP,moment,
 type SystemLogController,type ActivityPage,type ActivityQuery,type ActivityModule,type ActivityOperation,type PeriodKind} from '../lib/activity-model';
import {OriginListHeader,OriginToolbar} from './OriginList';
import {Icon} from './Icon';
import './real-activity.css';

const aborted=(e:unknown)=>e instanceof DOMException&&e.name==='AbortError';
const admin=(s:AccessState)=>s.phase==='ready'&&s.membership?.role==='admin';
/** Antes e depois by top-level field; nested values are shown as compact JSON. */
export function detailRows(detail:ActivityDetail){
 const plain=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v),before=plain(detail.before)?detail.before:{},after=plain(detail.after)?detail.after:{};
 const show=(v:unknown)=>v===undefined?'—':v===null?'vazio':typeof v==='string'?v:JSON.stringify(v);
 return [...new Set([...Object.keys(before),...Object.keys(after)])].sort().map(field=>({field,before:show(before[field]).slice(0,400),after:show(after[field]).slice(0,400),changed:JSON.stringify(before[field])!==JSON.stringify(after[field])}));
}
/** "Detalhes do registro": the audit before and after of one entry, read when opened. */
function ActivityDetailModal({controller,entry,onClose}:{controller:SystemLogController;entry:ActivityEntry;onClose:()=>void}){
 const [detail,setDetail]=useState<ActivityDetail|null>(null),[error,setError]=useState('');
 useEffect(()=>{const p=new AbortController(),q=captureActivityDetailQuery({source:entry.source,id:entry.id});void controller.systemLog(activityDetailPath(entry.source,entry.id),{method:'GET',signal:p.signal})
  .then(raw=>{if(!p.signal.aborted)setDetail(parseActivityDetail(raw,q));}).catch(e=>{if(!p.signal.aborted&&!aborted(e))setError('Não foi possível carregar o detalhe deste registro.');});return()=>p.abort();},[controller,entry]);
 const rows=detail?detailRows(detail):[];
 return <Modal title="Detalhes do registro" onClose={onClose} actions={<button type="button" className="secondary-button" onClick={onClose}>Fechar</button>}>
  <p className="real-help">{moment(entry.created_at)} · {entry.actor.label} · {MODULE_TEXT[entry.module]} · {OPERATION_TEXT[entry.operation]}{entry.code?` · ${entry.code}`:''}</p>
  {error&&<p className="real-alert" role="alert">{error}</p>}{!detail&&!error&&<p role="status">Carregando detalhe…</p>}
  {detail&&detail.truncated&&<p className="real-help">O detalhe deste registro é grande demais para exibir aqui.</p>}
  {detail&&!detail.truncated&&(rows.length?<div className="table-scroll" role="region" aria-label="Antes e depois" tabIndex={0}><table className="data-table activity-detail"><thead><tr><th scope="col">Campo</th><th scope="col">Antes</th><th scope="col">Depois</th></tr></thead>
   <tbody>{rows.map(r=><tr key={r.field} className={r.changed?'is-changed':undefined}><th scope="row">{r.field}</th><td>{r.before}</td><td>{r.after}</td></tr>)}</tbody></table></div>
   :<p className="empty-state">Este registro não guarda dados de antes e depois.</p>)}
 </Modal>;
}
type Filters={period:PeriodKind;from:string;to:string;module:ActivityModule|'';operation:ActivityOperation|'';actor:string;q:string};

/**
 * Sistema > Registro de atividades (mode "activity") and Consulta de exclusões realizadas (mode "deletions"), Origin layout.
 * Read-only and administrador-only; dates are São Paulo calendar days.
 */
export default function RealActivity({controller,mode='activity'}:{controller:SystemLogController;mode?:'activity'|'deletions'}){
 const snapshot=useSyncExternalStore(controller.subscribe,controller.getSnapshot);
 const actor=useRef(snapshot.membership?.user_id??null);
 const allowed=admin(snapshot)&&snapshot.membership?.user_id===actor.current;
 const today=todaySP(),deletions=mode==='deletions';
 const alive=useRef(true),request=useRef<AbortController|null>(null);
 const initial=():Filters=>({period:deletions?'mes':'ultimos',from:deletions?periodRange('mes',today)!.from:today,to:today,module:'',operation:'',actor:'',q:''});
 const [filters,setFilters]=useState<Filters>(initial);
 const [query,setQuery]=useState<ActivityQuery|null>(()=>deletions?captureActivityQuery({...periodRange('mes',today)!,operation:'exclusao'}):null);
 const [detail,setDetailEntry]=useState<ActivityEntry|null>(null);
 const [page,setPage]=useState<ActivityPage|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState(''),[users,setUsers]=useState<AccessUser[]>([]),[reload,setReload]=useState(0);
 const may=()=>{const s=controller.getSnapshot();return alive.current&&admin(s)&&s.membership?.user_id===actor.current;};
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;request.current?.abort();};},[controller]);
 useEffect(()=>{if(allowed)return;request.current?.abort();request.current=null;setLoading(false);setPage(null);},[allowed]);
 // The user filter lists the company accounts (Sistema > Usuários); without it the filter stays on "Todos".
 useEffect(()=>{if(deletions||!allowed||!controller.accessUsers||!may())return;const p=new AbortController();void(async()=>{try{
  const q=captureUsersQuery({limit:100});const raw=await controller.accessUsers!(usersListPath(q),{method:'GET',signal:p.signal});if(may()&&!p.signal.aborted)setUsers(parseUsersList(raw,q).items);
 }catch{/* Optional list. */}})();return()=>p.abort();},[controller,allowed,deletions]);
 useEffect(()=>{if(!query||!allowed||!may())return;request.current?.abort();const p=new AbortController();request.current=p;setLoading(true);setError('');void(async()=>{try{
  const raw=await controller.systemLog(activityPath(query),{method:'GET',signal:p.signal});if(!may()||p.signal.aborted||request.current!==p)return;setPage(parseActivity(raw,query));
 }catch(e){if(may()&&!p.signal.aborted&&request.current===p&&!aborted(e))setError(e instanceof AccessError&&e.status===403?'Somente administradores consultam o registro de atividades.':'Não foi possível carregar os registros. Tente novamente.');}
 finally{if(request.current===p){request.current=null;setLoading(false);}}})();return()=>{p.abort();if(request.current===p)request.current=null;};},[controller,query,reload,allowed]);
 const search=(offset=0)=>{const range=periodRange(filters.period,today,filters.from,filters.to);if(!range){setError('Informe um período válido de até 366 dias.');return;}
  try{setQuery(captureActivityQuery({...range,module:filters.module||null,operation:deletions?'exclusao':filters.operation||null,actor:filters.actor||null,q:filters.q||null,offset}));setError('');}
  catch{setError('A pesquisa aceita até 120 caracteres.');}};
 const clear=()=>{setFilters(initial());if(!deletions){setQuery(null);setPage(null);}};
 if(!allowed)return <section className="real-state-panel"><h1>{deletions?'Consulta de exclusões não liberada':'Registro de atividades não liberado'}</h1><p>Somente administradores consultam esta tela.</p></section>;
 const items=page?.items??[];
 return <div className="real-activity">
  <OriginListHeader title={deletions?'Consulta de exclusões realizadas':'Registro de atividades'}/>
  {deletions?<>
   <OriginToolbar searchValue={filters.q} searchPlaceholder="Pesquisar" onSearchChange={q=>setFilters({...filters,q})} onSearch={()=>search()}
    period={<span className="real-activity-period"><label>Início<input type="date" id="deletions-from" value={filters.from} max={today} onChange={e=>setFilters({...filters,period:'periodo',from:e.target.value})}/></label><label>Fim<input type="date" id="deletions-to" value={filters.to} max={today} onChange={e=>setFilters({...filters,period:'periodo',to:e.target.value})}/></label></span>}
    tools={<button type="button" className="origin-refresh" title="Recarregar" aria-label="Recarregar" onClick={()=>setReload(n=>n+1)}><Icon name="rotate-right" size={12}/></button>}/>
   <p className="real-help">No FAGOO nada é apagado: esta consulta mostra arquivamentos de cadastros, rascunhos fiscais arquivados, anexos descartados e usuários desativados, com quem fez e quando.</p>
  </>:<section className="real-activity-filters" aria-label="Filtrar resultados"><h2>Filtrar resultados</h2>
   <div className="real-activity-grid">
    <label className="form-field">Período<select id="activity-period" value={filters.period} onChange={e=>setFilters({...filters,period:e.target.value as PeriodKind})}>{(Object.keys(PERIOD_TEXT) as PeriodKind[]).map(k=><option key={k} value={k}>{PERIOD_TEXT[k]}</option>)}</select></label>
    {filters.period==='periodo'&&<><label className="form-field">Início<input type="date" id="activity-from" value={filters.from} max={today} onChange={e=>setFilters({...filters,from:e.target.value})}/></label><label className="form-field">Fim<input type="date" id="activity-to" value={filters.to} max={today} onChange={e=>setFilters({...filters,to:e.target.value})}/></label></>}
    <label className="form-field">Módulo<select id="activity-module" value={filters.module} onChange={e=>setFilters({...filters,module:e.target.value as ActivityModule|''})}><option value="">Todos</option>{ACTIVITY_MODULES.map(m=><option key={m} value={m}>{MODULE_TEXT[m]}</option>)}</select></label>
    <label className="form-field">Operação<select id="activity-operation" value={filters.operation} onChange={e=>setFilters({...filters,operation:e.target.value as ActivityOperation|''})}><option value="">Todos</option>{ACTIVITY_OPERATIONS.map(o=><option key={o} value={o}>{OPERATION_TEXT[o]}</option>)}</select></label>
    <label className="form-field">Usuário<select id="activity-actor" value={filters.actor} onChange={e=>setFilters({...filters,actor:e.target.value})}><option value="">Todos</option>{users.map(u=><option key={u.user_id} value={u.user_id}>{u.name??u.email??u.user_id.slice(0,8)}</option>)}</select></label>
    <label className="form-field">Código ou descrição<input id="activity-q" maxLength={120} value={filters.q} onChange={e=>setFilters({...filters,q:e.target.value})}/></label>
   </div>
   <div className="real-editor-actions"><button type="button" className="secondary-button" onClick={clear}>Limpar filtros</button><button type="button" className="primary-button" disabled={loading} onClick={()=>search()}>Pesquisar</button></div>
  </section>}
  {error&&<p className="real-alert" role="alert">{error}</p>}
  {loading?<p role="status" className="real-help">Carregando registros, aguarde...</p>:!query?<div className="empty-state"><h2>Nenhuma pesquisa realizada</h2><p>Selecione os filtros e clique em Pesquisar.</p></div>:page&&!items.length?<div className="empty-state"><h2>Nenhum registro encontrado</h2><p>Ajuste o período ou os filtros.</p></div>:null}
  {page&&items.length>0&&<><div className="table-scroll" role="region" aria-label={deletions?'Exclusões realizadas':'Atividades'} tabIndex={0}><table className="data-table"><thead><tr><th scope="col">Data/Hora</th>{deletions?<><th scope="col">Tipo</th><th scope="col">Descrição</th></>:<><th scope="col">Usuário</th><th scope="col">Módulo</th><th scope="col">Operação</th><th scope="col">Código</th><th scope="col">Descrição</th><th scope="col">Detalhe</th></>}</tr></thead>
   <tbody>{items.map(e=><tr key={`${e.source}:${e.id}`}><td>{moment(e.created_at)}</td>{deletions?<><td>{MODULE_TEXT[e.module]}</td><td>{e.description??'—'}{e.code?` (${e.code})`:''} excluído pelo usuário {e.actor.label}</td></>
    :<><td>{e.actor.label}</td><td>{MODULE_TEXT[e.module]}</td><td>{OPERATION_TEXT[e.operation]}</td><td>{e.code??'—'}</td><td>{e.description??'—'}</td>
     <td>{ACTIVITY_DETAIL_SOURCES.includes(e.source)?<button type="button" className="text-button" aria-label={`Ver detalhe de ${OPERATION_TEXT[e.operation]} em ${moment(e.created_at)}`} onClick={()=>setDetailEntry(e)}>Ver detalhe</button>:<span className="real-help" title="Este módulo não guarda antes e depois na auditoria.">—</span>}</td></>}</tr>)}</tbody></table></div>
   <p className="real-help">{page.total.toLocaleString('pt-BR')} registro(s) de {page.from.split('-').reverse().join('/')} a {page.to.split('-').reverse().join('/')} (horário de São Paulo).
    {page.offset>0&&<button type="button" className="text-button" onClick={()=>setQuery(q=>q&&{...q,offset:Math.max(0,q.offset-q.limit)})}>Página anterior</button>}
    {page.has_more&&<button type="button" className="text-button" onClick={()=>setQuery(q=>q&&{...q,offset:q.offset+q.limit})}>Próxima página</button>}</p></>}
  {detail&&allowed&&<ActivityDetailModal controller={controller} entry={detail} onClose={()=>setDetailEntry(null)}/>}
 </div>;
}
