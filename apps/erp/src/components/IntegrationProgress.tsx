import {useEffect,useState} from 'react';
import {AccessError} from '../lib/real-access';
import {INTEGRATION_LABELS,PROGRESS_VARIANTS,EXTRA_INTEGRATION_LABELS,EXTRA_PROGRESS_VARIANTS,PROGRESS_STATUS,parseIntegrationSummary,progressMoment,progressLocal,type IntegrationProgressController,type IntegrationSummary,type ProgressRun,type ProgressResource,type ProgressExtras} from '../lib/integration-progress-model';
import './integration-progress.css';
import StorageAudit from './StorageAudit';
import type {StorageAuditController} from '../lib/storage-audit-model';
import {FRESHNESS_ENTITIES,FRESHNESS_LANE_LABELS,FRESHNESS_LEVEL_LABELS,FRESHNESS_PATH,FRESHNESS_STATUS,freshnessAge,freshnessResource,freshnessVariant,parseOriginFreshness,type OriginFreshness,type FreshnessCollector,type FreshnessEntityRow,type IntegrationFreshnessController} from '../lib/origin-freshness-model';

type ProgressController=IntegrationProgressController & Partial<StorageAuditController> & Partial<IntegrationFreshnessController>;
function canMeasure(controller:ProgressController):controller is IntegrationProgressController & IntegrationFreshnessController{
 return typeof controller.integrationFreshness==='function';
}
function canAudit(controller:ProgressController):controller is IntegrationProgressController & StorageAuditController{
 return typeof controller.getSnapshot==='function'&&typeof controller.subscribe==='function'&&typeof controller.historyDownload==='function'&&typeof controller.syncedXmlDownload==='function';
}

const amount=(v:number|null)=>v===null?'Não informado':v.toLocaleString('pt-BR');
function Run({title,value}:{title:string;value:ProgressRun|null}){
 return <article className="integration-panel"><h3>{title}</h3>{value?<><p className={`integration-run integration-run-${value.status}`}>{PROGRESS_STATUS[value.status]}</p><dl>
  {value.started_at&&<div><dt>Início</dt><dd>{progressMoment(value.started_at)}</dd></div>}{value.finished_at&&<div><dt>Encerramento</dt><dd>{progressMoment(value.finished_at)}</dd></div>}
  {([['pages','Páginas consultadas'],['records','Registros observados'],['attempted','Títulos consultados'],['stored','Títulos observados novamente'],['files','Arquivos recebidos'],['requests','Consultas HTTP'],['error_count','Falhas registradas']] as const).filter(([key])=>value[key]!==null).map(([key,label])=><div key={key}><dt>{label}</dt><dd>{amount(value[key])}</dd></div>)}
 </dl></>:<p>Sem execução registrada para esta etapa.</p>}</article>;
}
function PassageRow({row,extra=false}:{row:ProgressResource;extra?:boolean}){
 const labels=extra?EXTRA_INTEGRATION_LABELS:INTEGRATION_LABELS,variants=extra?EXTRA_PROGRESS_VARIANTS:PROGRESS_VARIANTS;
 return <tr><th scope="row">{labels[row.entity]}<small>{variants[row.resource][2]}</small></th><td>{row.windowed?progressLocal(row.recent_completed_local):'Não se aplica'}</td><td>{row.windowed?progressLocal(row.history_completed_local):'Não se aplica'}</td><td>{row.windowed?'Não se aplica':progressLocal(row.sweep_completed_local)}</td><td>{[row.recent_open?'Recente':'',row.history_open?'Histórica':'',row.sweep_open?'Sem período':''].filter(Boolean).join(' / ')||'Nenhuma passagem aberta registrada'}</td></tr>;
}
function ExtraProgress({value}:{value:ProgressExtras|null}){
 const observation=value?.stock_last_observation;
 return <section aria-labelledby="integration-extra"><h2 id="integration-extra">Outros dados observados no Origin</h2>{value?<>
  <p className="real-help">Contagens da coleta do Origin. Não são ordens de serviço, categorias ou lançamentos criados no FAGOO, nem saldo de abertura do estoque ou de contas bancárias.</p>
  <div className="integration-table" role="region" aria-labelledby="integration-extra" tabIndex={0}><table><thead><tr><th>Conjunto observado</th><th>Registros</th><th>Observação mais antiga</th><th>Observação mais recente</th></tr></thead><tbody>{value.entities.map(row=><tr key={row.entity}><th scope="row">{EXTRA_INTEGRATION_LABELS[row.entity]}</th><td>{amount(row.records)}</td><td>{progressMoment(row.oldest_observation)}</td><td>{progressMoment(row.newest_observation)}</td></tr>)}</tbody></table></div>
  <p className="real-help">Ordens de serviço são consultadas pela data de entrada; lançamentos de caixas e bancos, pelo período da origem. Depósitos ativos e inativos e lançamentos registrados e excluídos têm passagens separadas. Ausência na coleta não comprova exclusão.</p>
  <article className="integration-panel"><h3>Último lote de observação de estoque</h3>{observation?<><p>Observado em {progressMoment(observation.observed_at)} · horário de São Paulo</p><dl><div><dt>Produtos solicitados no lote</dt><dd>{amount(observation.requested)}</dd></div><div><dt>Produtos com resposta</dt><dd>{amount(observation.returned)}</dd></div><div><dt>Produtos sem resposta neste lote</dt><dd>{amount(observation.unavailable)}</dd></div></dl></>:<p>Sem observação de lote registrada ou válida nesta consulta.</p>}<p className="real-help">Cada lote consulta até 25 produtos conhecidos em três partições de saldo. As contagens acima descrevem somente o último lote, não o estoque total. Produto sem resposta não tem saldo zero presumido; uma observação anterior pode continuar guardada. As consultas não são uma leitura simultânea de todos os depósitos e não certificam cobertura ou conciliação.</p></article>
 </>:<p className="real-help">Os indicadores destes conjuntos ainda não estão disponíveis nesta consulta. Isso não informa se a coleta está ativada, nem significa que não existem registros.</p>}</section>;
}
const FRESHNESS_LABELS=Object.fromEntries(FRESHNESS_ENTITIES.map(x=>[x.entity,x.label]));
function FreshnessRow({row}:{row:FreshnessEntityRow}){
 const status=FRESHNESS_STATUS[row.status],missing=row.lanes_total-row.lanes_measured;
 return <tr><th scope="row">{FRESHNESS_LABELS[row.entity]}</th><td>{amount(row.records)}</td><td>{progressMoment(row.last_changed_at)}</td>
  <td>{progressMoment(row.last_seen_at)}{row.oldest_seen_at&&<small>Leitura mais antiga: {progressMoment(row.oldest_seen_at)}</small>}</td>
  <td>{row.freshness_at&&row.pass_finished_at&&row.pass_resource&&row.pass_lane?<>{progressMoment(row.freshness_at)} a {progressMoment(row.pass_finished_at)}<small>{freshnessVariant(row.pass_resource)} · {FRESHNESS_LANE_LABELS[row.pass_lane]}</small></>
   :<>Sem passagem completa<small>{missing} de {row.lanes_total} {row.lanes_total===1?'consulta':'consultas'} sem passagem completa medida</small></>}</td>
  <td className="integration-nowrap">{row.level} · {FRESHNESS_LEVEL_LABELS[row.level]}</td>
  <td><span className={`status-badge status-${status.tone}`}>{status.label}</span>{row.age_seconds!==null&&<small>Idade do dado: {freshnessAge(row.age_seconds)}</small>}</td></tr>;
}
// The collector renews the access 5 min before it expires: an expiry already past the
// measurement means no renewal happened, and must not read as a valid connection.
function oauthText(value:FreshnessCollector,asOf:string){
 if(!value.oauth_connected||!value.oauth_expires_at)return 'Não autorizada';
 return Date.parse(value.oauth_expires_at)<=Date.parse(asOf)?`Autorizada, mas o acesso venceu em ${progressMoment(value.oauth_expires_at)} sem renovação`:`Autorizada · acesso atual até ${progressMoment(value.oauth_expires_at)}`;
}
function failureText(value:FreshnessCollector){
 if(value.last_error_code)return `${value.last_error_code}${value.last_error_resource?` em ${freshnessResource(value.last_error_resource)}`:''}`;
 if(!value.last_run_status)return 'Sem ciclo registrado';
 return value.last_run_error_count===null?'Não informada':value.last_run_error_count>0?'Falha sem código reconhecido':'Nenhuma no último ciclo';
}
function CollectorState({value,asOf}:{value:FreshnessCollector;asOf:string}){
 return <dl className="integration-collector">
  <div><dt>Conexão com o Origin</dt><dd>{oauthText(value,asOf)}</dd></div>
  <div><dt>Último ciclo do coletor</dt><dd>{value.last_run_status?`${PROGRESS_STATUS[value.last_run_status]} · ${progressMoment(value.last_run_finished_at??value.last_run_started_at)}`:'Sem ciclo registrado'}</dd></div>
  <div><dt>Última falha registrada</dt><dd>{failureText(value)}</dd></div>
 </dl>;
}
function Freshness({controller,reload}:{controller:IntegrationFreshnessController;reload:number}){
 const[value,setValue]=useState<OriginFreshness|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState('');
 useEffect(()=>{
  const request=new AbortController();setValue(null);setError('');setLoading(true);
  void controller.integrationFreshness(FRESHNESS_PATH,{signal:request.signal}).then(raw=>{
   if(request.signal.aborted)return;const parsed=parseOriginFreshness(raw);setValue(parsed);setLoading(false);
  }).catch(failure=>{if(request.signal.aborted)return;setLoading(false);setError(failure instanceof AccessError&&failure.status===403?'Este painel é restrito aos administradores ativos.':'Não foi possível consultar o frescor da cópia. Tente novamente.');});
  return()=>request.abort();
 },[controller,reload]);
 return <section aria-labelledby="integration-freshness" className="integration-freshness"><h2 id="integration-freshness">Frescor da cópia do Origin</h2>
  <p className="real-help">Nível A até 10 min, B até 30 min e C até 24 h: Em dia dentro do nível, Atenção acima dele e Desatualizado acima de três vezes o nível ou sem passagem completa. Horários de São Paulo.</p>
  {loading&&<p role="status">Consultando frescor…</p>}{error&&<p className="real-alert" role="alert">{error}</p>}
  {value&&<>
   <p className="integration-context">Medido em {progressMoment(value.as_of)} · horário de São Paulo</p>
   <div className="integration-table" role="region" aria-labelledby="integration-freshness" tabIndex={0}><table><thead><tr><th>Conjunto</th><th>Registros</th><th>Última alteração</th><th>Última leitura</th><th>Última passagem completa</th><th>Nível</th><th>Situação</th></tr></thead>
    <tbody>{value.entities.map(row=><FreshnessRow key={row.entity} row={row}/>)}</tbody></table></div>
   <p className="real-help">O frescor é o início da passagem completa mais antiga entre as consultas que cobrem o conjunto, nunca o horário do último ciclo ou da última leitura. Em Atenção ou Desatualizado, confira no Origin.</p>
   <CollectorState value={value.collector} asOf={value.as_of}/>
  </>}
 </section>;
}
export default function IntegrationProgress({controller}:{controller:ProgressController}){
 const[summary,setSummary]=useState<IntegrationSummary|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[reload,setReload]=useState(0);
 useEffect(()=>{
  const request=new AbortController();setSummary(null);setError('');setLoading(true);
  void controller.integrationProgress('/v1/integracao-origin',{signal:request.signal}).then(value=>{
   if(request.signal.aborted)return;const parsed=parseIntegrationSummary(value);setSummary(parsed);setLoading(false);
  }).catch(failure=>{if(request.signal.aborted)return;setLoading(false);setError(failure instanceof AccessError&&failure.status===403?'Este painel é restrito aos administradores ativos.':'Não foi possível consultar o andamento. Tente novamente.');});
  return()=>request.abort();
 },[controller,reload]);
 return <div className="integration-progress">
  <header className="real-heading"><div><h1>Integração com o Origin</h1><p>Acompanhe a coleta de dados e a preservação dos arquivos.</p></div><button type="button" className="secondary-button" disabled={loading} onClick={()=>setReload(x=>x+1)}>Atualizar andamento</button></header>
  {loading&&<p role="status">Consultando integração…</p>}{error&&<p className="real-alert" role="alert">{error}</p>}
  {canMeasure(controller)&&<Freshness controller={controller} reload={reload}/>}
  {summary&&<>
   <p className="integration-context">Consulta de {progressMoment(summary.as_of)} · horário de São Paulo</p>
   <p className="integration-notice">A coleta continua por etapas. Estes números não confirmam uma migração concluída e não lançam estoque, contas ou pagamentos no FAGOO.</p>
   <section aria-labelledby="integration-last"><h2 id="integration-last">Última execução registrada</h2><div className="integration-grid"><Run title="Coleta geral" value={summary.last_run}/><Run title="Arquivos XML" value={summary.last_xml_run}/><Run title="Revisão de contas a pagar e receber" value={summary.last_finance_run}/></div><p className="real-help">“Ciclo encerrado” descreve apenas a execução acima. A ativação atual do coletor não é informada por esta consulta.</p></section>
   <section aria-labelledby="integration-data"><h2 id="integration-data">Dados conhecidos no histórico do Origin</h2><p className="real-help">Cada registro conta uma vez por conjunto. A observação mais recente não significa que todos os registros foram revistos nessa data.</p><div className="integration-table" role="region" aria-labelledby="integration-data" tabIndex={0}><table><thead><tr><th>Conjunto</th><th>Registros</th><th>Observação mais antiga</th><th>Observação mais recente</th></tr></thead><tbody>{summary.entities.map(row=><tr key={row.entity}><th scope="row">{INTEGRATION_LABELS[row.entity]}</th><td>{amount(row.records)}</td><td>{progressMoment(row.oldest_observation)}</td><td>{progressMoment(row.newest_observation)}</td></tr>)}</tbody></table></div></section>
   <ExtraProgress value={summary.extra_resources}/>
   <section aria-labelledby="integration-xml"><h2 id="integration-xml">Preservação de XMLs</h2><div className="integration-grid"><article className="integration-panel"><h3>Arquivos guardados</h3><dl><div><dt>Arquivos distintos preservados</dt><dd>{amount(summary.xml.preserved_objects)}</dd></div><div><dt>Revisões preservadas</dt><dd>{amount(summary.xml.preserved_revisions)}</dd></div><div><dt>Último sucesso nas origens atuais</dt><dd>{progressMoment(summary.xml.last_success_at)}</dd></div></dl></article><article className="integration-panel"><h3>Notas conhecidas atualmente</h3><dl>{([['known_origins','Origens conhecidas'],['with_preserved_revision','Com revisão preservada'],['without_preserved_revision','Ainda sem revisão preservada'],['never_attempted','Ainda sem primeira tentativa'],['without_valid_key','Sem chave válida para coleta']] as const).map(([key,label])=><div key={key}><dt>{label}</dt><dd>{amount(summary.xml[key])}</dd></div>)}</dl></article><article className="integration-panel"><h3>Pendências da coleta</h3><dl>{([['retry_origins','Nova tentativa necessária'],['blocked_origins','Com impedimento registrado'],['backing_off','Aguardando intervalo de nova tentativa']] as const).map(([key,label])=><div key={key}><dt>{label}</dt><dd>{amount(summary.xml[key])}</dd></div>)}</dl><p className="real-help">Uma origem pode ter XML guardado e uma nova tentativa pendente. Não some estas contagens como um percentual.</p></article></div><p className="real-help">O arquivo preservado teve verificações estruturais. A assinatura, o esquema fiscal e a autorização da SEFAZ não são certificados por este painel. O backup original é uma fonte separada.</p></section>
   <section aria-labelledby="integration-finance"><h2 id="integration-finance">Revisão dirigida de títulos antigos</h2><p className="real-help">Contas observadas como abertas ou parciais no Origin. Ausência de saldo ou falha de consulta não significa quitação.</p><div className="integration-grid integration-grid-two">{summary.finance_refresh.entities.map(row=><article className="integration-panel" key={row.entity}><h3>{INTEGRATION_LABELS[row.entity]}</h3><dl><div><dt>Abertas ou parciais conhecidas</dt><dd>{amount(row.known_open_partial)}</dd></div><div><dt>Observadas há mais de uma hora</dt><dd>{amount(row.observed_over_hour_ago)}</dd></div><div><dt>Sem saldo utilizável na origem</dt><dd>{amount(row.unavailable_balance)}</dd></div><div><dt>Aguardando intervalo de nova tentativa</dt><dd>{amount(row.backing_off)}</dd></div><div><dt>Observação mais antiga</dt><dd>{progressMoment(row.oldest_observation)}</dd></div><div><dt>Último sucesso da revisão</dt><dd>{progressMoment(row.last_success_at)}</dd></div>{row.retry_after&&<div><dt>Próxima tentativa do conjunto após</dt><dd>{progressMoment(row.retry_after)}</dd></div>}</dl></article>)}</div><p className="integration-notice">Limites de referência por ciclo: até 8 títulos, 40 segundos e 24 tentativas HTTP, dentro do orçamento compartilhado de 120 consultas. A idade de uma hora é a referência deste painel; não confirma a configuração ativa do coletor.</p></section>
   <section aria-labelledby="integration-coverage"><h2 id="integration-coverage">Passagens dos coletores</h2><p className="real-help">As datas abaixo indicam quando cada passagem terminou. O limite de dados consultado não está disponível neste painel. Uma passagem encerrada não comprova conciliação nem cobertura anterior ao início configurado da coleta.</p><div className="integration-table" role="region" aria-labelledby="integration-coverage" tabIndex={0}><table><thead><tr><th>Conjunto e consulta</th><th>Recente encerrada em</th><th>Histórica encerrada em</th><th>Sem período encerrada em</th><th>Passagem em andamento</th></tr></thead><tbody>{summary.resources.map(row=><PassageRow key={row.resource} row={row}/>)}{summary.extra_resources?.resources.map(row=><PassageRow key={row.resource} row={row} extra/>)}</tbody></table></div></section>
  </>}
  {canAudit(controller)&&<StorageAudit controller={controller}/>}
 </div>;
}
