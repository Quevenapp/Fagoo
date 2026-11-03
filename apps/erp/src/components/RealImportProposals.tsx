import {useEffect,useRef,useState,type FormEvent} from 'react';
import {Link} from 'react-router-dom';
import {AccessError,decimalMoney,type AccessState,type NativeRequestOptions} from '../lib/real-access';
import {useUnsavedChanges} from '../hooks/useUnsavedChanges';
import {STATES} from '../lib/real-documents-model';
import {PROPOSAL_IMPORT_BASE as LEGACY_BASE,proposalFieldLabels,proposalDocumentPath,proposalApply,checkedProposalCurrent,type ProposalPage,type ProposalBody,type ProposalApply,type ProposalAck,type ProposalCurrent} from '../lib/origin-proposal-import-model';
import {PROPOSAL_IMPORT_V2_BASE as BASE,PROPOSAL_IMPORT_V2_POLICY,proposalV2IssueLabels as proposalIssueLabels,proposalTransformationLabels,proposalV2ListPath as proposalListPath,checkedProposalV2Page as checkedProposalPage,checkedProposalV2Preview as checkedProposalPreview,checkedProposalV2Ack as checkedProposalAck,checkedProposalV2Current,checkedProposalOriginPolicy,type ProposalV2Preview as ProposalPreview,type ProposalV2Current,type ProposalSourceEvidence,type ProposalTransformation} from '../lib/origin-proposal-import-v2-model';
import {commercialReferenceText,FREIGHT_MODES} from '../lib/document-commercial-model';
import NativeListLayout from './NativeListLayout';
import './import-proposals.css';

export interface ProposalImportController {getSnapshot:()=>AccessState;proposalImport:(path:string,options?:NativeRequestOptions)=>Promise<unknown>;}
type Attempt={base:typeof BASE;policy:typeof PROPOSAL_IMPORT_V2_POLICY;body:ProposalApply;preview:ProposalPreview;ack:ProposalAck|null;uncertain:boolean;retryAllowed:boolean};
const moment=(v:string)=>new Date(v).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'});
const day=(v:string)=>v.split('-').reverse().join('/');
const aborted=(e:unknown)=>e instanceof DOMException&&e.name==='AbortError';
const message=(e:unknown)=>e instanceof AccessError&&[401,403].includes(e.status)?'O acesso de administrador precisa ser confirmado.':e instanceof AccessError&&e.status===409?'A origem ou um cadastro vinculado mudou. Gere outra prévia antes de confirmar.':e instanceof AccessError&&[400,404,422].includes(e.status)?'A origem não pôde ser conferida. Atualize a lista e prepare outra prévia.':'Não foi possível concluir a consulta. Tente novamente.';

function renderEvidence(e:ProposalSourceEvidence,transforms:ProposalTransformation[]){
 return<section className="proposal-import-evidence"><h3>Transformações conferidas</h3><ul>{transforms.map(code=><li key={code}>{proposalTransformationLabels[code]}</li>)}</ul><p>Desconto global observado: <strong>{decimalMoney(e.global_discount_observed)}</strong>. Total observado: <strong>{decimalMoney(e.total)}</strong>.</p><details><summary>Preços e descontos originais dos itens</summary><div className="table-scroll" role="region" tabIndex={0} aria-label="Evidência original dos preços"><table className="data-table"><thead><tr><th>Item</th><th>Quantidade</th><th>Preço unitário já líquido</th><th>Desconto original (unidade não informada)</th></tr></thead><tbody>{e.items.map(row=><tr key={row.position}><td>{row.position}</td><td>{row.quantity}</td><td>{row.unit_price}</td><td>{row.discount_observed}</td></tr>)}</tbody></table></div><p>O desconto do item é evidência, não um novo abatimento em reais ou percentual.</p></details></section>;
}
function renderCommercial(body:ProposalBody){
 const c=body.commercial,t=c?.transport;
 const refs=[['Vendedor',c?.seller_reference],['Loja',c?.store_reference],['Unidade de negócio',c?.business_unit_reference],['Transportador',t?.carrier_reference],['Serviço de transporte',t?.service_reference]] as const;
 return<section className="proposal-import-commercial"><h3>Conteúdo comercial declarado</h3>{c?.introduction&&<><h4>Introdução</h4><p className="proposal-import-text">{c.introduction}</p></>}{c?.attention_to&&<p>Aos cuidados de: {c.attention_to}</p>}<h4>Referências comerciais declaradas</h4><p>IDs do Origin, sem correspondência automática com usuários ou cadastros nativos.</p>{refs.some(([,r])=>r)?<dl>{refs.map(([label,r])=>r?<div key={label}><dt>{label}</dt><dd>{commercialReferenceText(r)}</dd></div>:null)}</dl>:<p>Nenhuma referência comercial informada.</p>}{t&&<><h4>Transporte</h4><dl>{([['Frete por conta',t.freight_mode===null?null:FREIGHT_MODES[t.freight_mode]],['Quantidade de volumes',t.volume_count],['Peso bruto',t.gross_weight],['Prazo de entrega em dias',t.delivery_days],['Código de rastreamento',t.tracking_code]] as const).map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value??'Não informado'}</dd></div>)}</dl></>}</section>;
}

function renderHistoricalContent(body:ProposalBody){
 return<>{renderCommercial(body)}<h3>Conteúdo original do rascunho</h3><p>Data: {day(body.date)} · próximo contato: {body.next_contact?day(body.next_contact):'Não informado'}</p><p>Entrega: {body.delivery_terms??'Não informada'}</p><ol>{body.items.map(item=><li key={item.position}>{item.description} · {item.unit} · {item.quantity} × {item.unit_price}{item.detailed_description&&<p className="proposal-import-text">{item.detailed_description}</p>}</li>)}</ol><h4>Parcelas originais</h4>{body.installments.length?<ul>{body.installments.map(row=><li key={row.position}>{day(row.due_date)} · {decimalMoney(row.amount)}{row.note&&<p className="proposal-import-text">{row.note}</p>}{row.payment_reference&&<small>{commercialReferenceText(row.payment_reference)} · sem vínculo nativo</small>}</li>)}</ul>:<p>Nenhuma parcela informada.</p>}<h4>Observações originais</h4><p className="proposal-import-text">{body.notes??'Não informadas'}</p><h4>Observações internas originais</h4><p className="proposal-import-text">{body.internal_notes??'Não informadas'}</p></>;
}

export default function RealImportProposals({controller}:{controller:ProposalImportController}){
 const snapshot=controller.getSnapshot(),owner=useRef(snapshot.membership?.user_id),alive=useRef(true);
 const [query,setQuery]=useState(''),[filter,setFilter]=useState(''),[cursors,setCursors]=useState<(string|null)[]>([null]),[reload,setReload]=useState(0);
 const [page,setPage]=useState<ProposalPage|null>(null),[loading,setLoading]=useState(false),[listError,setListError]=useState('');
 const [preview,setPreview]=useState<ProposalPreview|null>(null),[confirmed,setConfirmed]=useState(false),[duplicates,setDuplicates]=useState(false),[busy,setBusy]=useState(false),[unresolved,setUnresolved]=useState(false);
 const [error,setError]=useState(''),[result,setResult]=useState<ProposalCurrent|ProposalV2Current|null>(null),[retryAllowed,setRetryAllowed]=useState(false);
 const request=useRef<AbortController|null>(null),listRequest=useRef<AbortController|null>(null),attempt=useRef<Attempt|null>(null),heading=useRef<HTMLHeadingElement>(null);
 const after=cursors.at(-1)??null,path=proposalListPath(filter,after),canUse=snapshot.phase==='ready'&&snapshot.membership?.user_id===owner.current&&snapshot.membership?.role==='admin';
 const live=useRef({preview,confirmed,duplicates,page,loading});live.current={preview,confirmed,duplicates,page,loading};
 const authorized=()=>{const s=controller.getSnapshot();return s.phase==='ready'&&s.membership?.user_id===owner.current&&s.membership?.role==='admin';};
 const valid=(p:AbortController)=>alive.current&&!p.signal.aborted&&authorized();
 const free=()=>authorized()&&!request.current&&!attempt.current;
 const guard=useUnsavedChanges(confirmed||duplicates,busy||unresolved);
 const resetChecks=()=>{live.current.confirmed=false;live.current.duplicates=false;setConfirmed(false);setDuplicates(false);};
 const resetReview=()=>{resetChecks();live.current.preview=null;setPreview(null);setError('');};
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;request.current?.abort();listRequest.current?.abort();attempt.current=null;};},[]);
 useEffect(()=>{
  if(!canUse){request.current?.abort();listRequest.current?.abort();request.current=null;setBusy(false);return;}
  if(attempt.current)return;
  const p=new AbortController();listRequest.current=p;setLoading(true);setPage(null);setListError('');
  void controller.proposalImport(path,{method:'GET',signal:p.signal}).then(value=>{if(valid(p)&&listRequest.current===p)setPage(checkedProposalPage(value,after));}).catch(e=>{if(valid(p)&&!aborted(e))setListError(message(e));}).finally(()=>{if(valid(p)&&listRequest.current===p){listRequest.current=null;setLoading(false);}});
  return()=>p.abort();
 },[controller,path,reload,canUse]);
 useEffect(()=>{if(preview||result)heading.current?.focus();},[preview,result]);
 const changeList=(action:()=>void)=>{if(!free())return;guard.confirmLeave(()=>{if(!free())return;resetReview();setResult(null);action();});};
 const search=(e:FormEvent)=>{e.preventDefault();if(!free())return;try{proposalListPath(query);}catch{setListError('Use até 100 caracteres, sem quebras de linha.');return;}changeList(()=>{setFilter(query.trim());setCursors([null]);setReload(n=>n+1);});};
 const inspect=async(sourceId:string,existing=false)=>{
  if(!free()||live.current.loading||!live.current.page?.items.some(x=>x.source_id===sourceId))return;
  const p=new AbortController();request.current=p;setBusy(true);resetReview();setResult(null);
  try{
   if(existing){
    const documentId=live.current.page?.items.find(x=>x.source_id===sourceId)?.document_id;if(!documentId)throw new Error('Origem ausente.');
    const metadata=await controller.proposalImport(`${LEGACY_BASE}/documents/${documentId}/origin`,{method:'GET',signal:p.signal});if(!valid(p))return;
    const policy=checkedProposalOriginPolicy(metadata,documentId,sourceId),base=policy===PROPOSAL_IMPORT_V2_POLICY?BASE:LEGACY_BASE;
    const value=await controller.proposalImport(`${base}/origins/${sourceId}`,{method:'GET',signal:p.signal});if(valid(p)){const current=policy===PROPOSAL_IMPORT_V2_POLICY?checkedProposalV2Current(value,{sourceId}):checkedProposalCurrent(value,{sourceId});if(current.current_document.id!==documentId)throw new Error('Origem divergente.');setResult(current);}
   }
   else{const value=await controller.proposalImport(`${BASE}/preview`,{method:'POST',body:{source_id:sourceId},signal:p.signal});if(valid(p)){const checked=checkedProposalPreview(value,sourceId);live.current.preview=checked;setPreview(checked);}}
  }catch(e){if(valid(p)&&!aborted(e))setError(message(e));}
  finally{if(request.current===p)request.current=null;if(valid(p))setBusy(false);}
 };
 const execute=async(mode:'post'|'read')=>{
  const a=attempt.current;if(!a||request.current||!authorized()||mode==='post'&&a.uncertain&&!a.retryAllowed)return;
  const p=new AbortController();request.current=p;setBusy(true);setError('');a.retryAllowed=false;setRetryAllowed(false);
  try{
   if(mode==='post'){
    const value=await controller.proposalImport(`${a.base}/apply`,{method:'POST',body:a.body,signal:p.signal});if(!valid(p))return;
    a.ack=checkedProposalAck(value,a.body,a.preview);
   }
   if(!valid(p))return;
   const value=await controller.proposalImport(`${a.base}/commands/${a.body.command_id}`,{method:'GET',signal:p.signal});if(!valid(p))return;
   const current=checkedProposalV2Current(value,{request:a.body,preview:a.preview,ack:a.ack});
   attempt.current=null;setUnresolved(false);resetReview();setResult(current);
   // Do not reload or replace the historical receipt with a list result.
   setPage(old=>old?{...old,items:old.items.map(row=>row.source_id===a.body.source_id?{...row,document_id:current.current_document.id}:row)}:old);
  }catch(e){if(valid(p)&&!aborted(e)){
   const definitive=mode==='post'&&!a.uncertain&&!a.ack&&e instanceof AccessError&&[400,401,403,404,409,422].includes(e.status);
   if(definitive){attempt.current=null;setUnresolved(false);resetReview();setError(message(e));}
   else{
    a.uncertain=true;setUnresolved(true);
    // A missing command is permission to offer an explicit retry, never evidence of rollback.
    if(mode==='read'&&!a.ack&&e instanceof AccessError&&e.status===404){a.retryAllowed=true;setRetryAllowed(true);setError('O comando não foi localizado nesta consulta. Isso não prova que a primeira tentativa deixou de acontecer. Você pode consultar novamente ou reenviar exatamente a mesma confirmação.');}
    else setError(a.ack?'A importação foi registrada, mas a consulta do documento atual falhou. Consulte o mesmo comando; ele não será reenviado.':'O resultado ainda não foi confirmado. O comando e a confirmação permanecem preservados. Consulte o resultado antes de continuar.');
   }
  }}finally{if(request.current===p)request.current=null;if(valid(p))setBusy(false);}
 };
 const apply=()=>{if(!free()||!live.current.preview||!live.current.confirmed||!live.current.duplicates)return;
  try{const p=structuredClone(live.current.preview),body=proposalApply(p,crypto.randomUUID(),true,true);attempt.current={base:BASE,policy:PROPOSAL_IMPORT_V2_POLICY,body,preview:p,ack:null,uncertain:false,retryAllowed:false};setUnresolved(true);setResult(null);void execute('post');}catch{setError('Confira a prévia e as duas confirmações antes de importar.');}
 };
 const back=()=>{if(!free())return;guard.confirmLeave(()=>{if(!free())return;resetReview();setResult(null);});};
 const locked=busy||unresolved||!canUse;
 if(!canUse)return<section className="proposal-import"><h1>Importar orçamentos</h1><p role="alert">Somente administradores ativos podem conferir e importar orçamentos.</p></section>;
 return<section className="proposal-import" aria-labelledby="proposal-import-title" aria-busy={busy||loading}>
  <header className="real-heading"><div><h1 id="proposal-import-title">Importar orçamentos</h1><p>Confira um orçamento do Origin antes de criar um rascunho no FAGOO. Novas importações usam o perfil revisado v2.</p></div><span className="real-mode">Administrador</span></header>
  <p className="real-notice">A importação cria apenas um orçamento em rascunho. Não lança estoque, contas a pagar ou receber, nem documentos fiscais. A origem permanece vinculada para impedir nova importação do mesmo registro.</p>
  {error&&<p className="real-error" role="alert">{error}</p>}
  {unresolved&&<section className="proposal-import-pending" aria-label="Importação com resultado pendente"><h2>Conferência do resultado pendente</h2><p>As escolhas estão congeladas. Sair da tela não desfaz uma gravação já aceita. Comando: <code>{attempt.current?.body.command_id}</code>.</p>{attempt.current?.ack&&<p>Recibo confirmado: orçamento {attempt.current.ack.receipt.document.number}, criado em {moment(attempt.current.ack.receipt.imported_at)}. A situação atual ainda precisa ser consultada.</p>}<div className="button-group"><button type="button" className="primary-button" disabled={busy} onClick={()=>void execute('read')}>Consultar resultado</button>{retryAllowed&&<button type="button" className="secondary-button" disabled={busy} onClick={()=>void execute('post')}>Reenviar a mesma confirmação</button>}</div></section>}
  {result?<section className="proposal-import-result"><h2 ref={heading} tabIndex={-1}>Importação registrada</h2><div className="proposal-import-columns"><article><h3>Recibo original</h3><p>Política da importação: {result.receipt.policy===PROPOSAL_IMPORT_V2_POLICY?'v2 — conteúdo comercial e evidência original':'v1 — perfil inicial'}.</p><p>Origem Origin {result.receipt.source_number} · ID {result.receipt.source_id}</p><p>Orçamento FAGOO {result.receipt.document.number} · rascunho, versão 1</p><p>Contato: {result.receipt.document.contact_name}</p><p>Total original: <strong>{decimalMoney(result.receipt.document.total)}</strong></p><p>Importado em {moment(result.receipt.imported_at)}.</p></article><article><h3>Documento consultado agora</h3><p>{STATES.sales_proposals[result.current_document.status]} · versão {result.current_document.version}</p><p>Contato: {result.current_document.contact_name}</p><p>Total atual: <strong>{decimalMoney(result.current_document.total)}</strong></p><p>Última alteração: {moment(result.current_document.updated_at)}.</p><Link to={proposalDocumentPath(result.current_document.id)}>Abrir orçamento no FAGOO</Link></article></div>{'historical_evidence' in result?<details className="proposal-import-history"><summary>Evidência imutável da importação v2</summary><p>Este conteúdo foi conservado no momento da importação. Não acompanha edições posteriores do orçamento.</p>{renderEvidence(result.historical_evidence.source_evidence,result.historical_evidence.transformations)}{renderHistoricalContent(result.historical_evidence.normalized_body)}</details>:<p className="real-help">Esta importação v1 conserva o recibo do perfil inicial. As transformações e a evidência comercial v2 não são atribuídas retroativamente.</p>}<button type="button" className="secondary-button" disabled={locked} onClick={back}>Voltar à lista</button></section>:preview?<section className="proposal-import-preview"><header><div><h2 ref={heading} tabIndex={-1}>Conferir orçamento {preview.source_number??'sem número'}</h2><p>ID Origin {preview.source_id} · situação observada: {preview.source_status??'não informada'}</p></div><button type="button" className="secondary-button" disabled={locked} onClick={back}>Voltar à lista</button></header><p className="real-help">Observado em {moment(preview.source_seen_at)}. Isso não certifica a atualidade do Origin nem uma data de corte. O servidor confere novamente a origem e os cadastros ao importar.</p>
   {preview.issues.length>0&&<section className="proposal-import-issues"><h3>Pendências que impedem a importação</h3><ul>{preview.issues.map((item,i)=><li key={i}>{item.position!==null?`${item.code.startsWith('INSTALLMENT')?'Parcela':'Item'} ${item.position}: `:''}{item.field?`${proposalFieldLabels[item.field]}: `:''}{proposalIssueLabels[item.code]}</li>)}</ul><p>Nenhum rascunho será criado enquanto estas pendências permanecerem. Não há substituição automática de valores ou cadastros.</p></section>}
   {preview.existing&&<p>Esta origem já foi importada em {moment(preview.existing.imported_at)}. <Link to={proposalDocumentPath(preview.existing.document_id)}>Abrir orçamento existente</Link></p>}
   <section><h3>Correspondências dos cadastros</h3><ul className="proposal-import-bindings">{preview.bindings.map((b,i)=><li key={i}><strong>{i===0?'Contato':`Produto do item ${b.position}`}</strong>: {b.name??'Correspondência não estabelecida'} {b.valid?`· versão ${b.record_version}`:'· requer conferência'}{b.source_id&&<small>ID Origin {b.source_id}</small>}</li>)}</ul></section>
   {preview.source_evidence&&renderEvidence(preview.source_evidence,preview.transformations)}
   {preview.proposed&&<><div className="proposal-import-columns"><div><h3>Conteúdo do rascunho</h3><p>Data: {day(preview.proposed.date)}</p><p>Próximo contato: {preview.proposed.next_contact?day(preview.proposed.next_contact):'Não informado'}</p><p>Entrega: {preview.proposed.delivery_terms??'Não informada'}</p></div><dl className="proposal-import-totals"><div><dt>Produtos</dt><dd>{decimalMoney(preview.proposed.totals.gross)}</dd></div><div><dt>Descontos</dt><dd>{decimalMoney(preview.proposed.totals.discount)}</dd></div><div><dt>Frete</dt><dd>{decimalMoney(preview.proposed.freight)}</dd></div><div><dt>Outras despesas</dt><dd>{decimalMoney(preview.proposed.other_expenses)}</dd></div><div><dt>Total</dt><dd>{decimalMoney(preview.proposed.totals.total)}</dd></div></dl></div>
    <div className="table-scroll" role="region" tabIndex={0} aria-label="Itens do rascunho"><table className="data-table"><thead><tr><th>Item</th><th>Descrição</th><th>Quantidade</th><th>Unidade</th><th>Preço unitário</th><th>Total</th></tr></thead><tbody>{preview.proposed.items.map(item=><tr key={item.position}><td>{item.position}</td><td>{item.description}<small>{item.code??'Sem código'}</small>{item.detailed_description&&<p className="proposal-import-text">{item.detailed_description}</p>}</td><td>{item.quantity}</td><td>{item.unit}</td><td>{item.unit_price}</td><td>{decimalMoney(item.total)}</td></tr>)}</tbody></table></div>
    <section><h3>Parcelas do orçamento</h3>{preview.proposed.installments.length?<ul>{preview.proposed.installments.map(p=><li key={p.position}>{p.position} · {day(p.due_date)} · {decimalMoney(p.amount)} · forma de pagamento sem vínculo nativo{p.payment_reference&&<small>{commercialReferenceText(p.payment_reference)}</small>}{p.note&&<p className="proposal-import-text">{p.note}</p>}</li>)}</ul>:<p>Nenhuma parcela informada. Não será criado um plano automático.</p>}<p>Parcelas permanecem no orçamento e não criam títulos financeiros nesta importação.</p></section>
    {renderCommercial(preview.proposed)}<details><summary>Observações conservadas</summary><h4>Observações</h4><p className="proposal-import-text">{preview.proposed.notes??'Não informadas'}</p><h4>Observações internas</h4><p className="proposal-import-text">{preview.proposed.internal_notes??'Não informadas'}</p></details>
   </>}
   {preview.can_apply&&<section className="proposal-import-confirm"><p>Um novo número será atribuído pelo FAGOO. O vínculo da origem não identifica orçamentos equivalentes criados manualmente.</p><label><input id="proposal-import-duplicates" type="checkbox" checked={duplicates} disabled={locked} onChange={e=>{if(free()){live.current.duplicates=e.target.checked;setDuplicates(e.target.checked);}}}/>Revisei os orçamentos já existentes no FAGOO, inclusive os cadastrados manualmente, para evitar duplicidade.</label><label><input id="proposal-import-confirm" type="checkbox" checked={confirmed} disabled={locked} onChange={e=>{if(free()){live.current.confirmed=e.target.checked;setConfirmed(e.target.checked);}}}/>Conferi contato, produtos, datas, valores e parcelas e confirmo a criação deste rascunho.</label><button type="button" className="primary-button" disabled={locked||!confirmed||!duplicates} onClick={apply}>Criar rascunho revisado</button></section>}
  </section>:<NativeListLayout filters={<form onSubmit={search}><label htmlFor="proposal-import-query">Número ou ID no Origin</label><input id="proposal-import-query" type="search" maxLength={100} value={query} disabled={locked} onChange={e=>{if(free())setQuery(e.target.value);}}/><button type="submit" className="secondary-button" disabled={locked}>Pesquisar</button></form>} actions={<><button type="button" className="secondary-button" disabled={locked} onClick={()=>changeList(()=>setReload(n=>n+1))}>Atualizar lista</button><p>A lista mostra observações coletadas. Abrir a prévia não grava nenhum orçamento.</p></>}>
   <p className="real-help">Somente situações Rascunho, Pendente ou Aguardando podem entrar neste perfil; campos e correspondências também precisam estar válidos. Registros concluídos continuam visíveis para conferência.</p>
   {listError&&<p role="alert" className="real-error">{listError}</p>}<p role="status">{loading?'Consultando orçamentos…':page?`${page.items.length} orçamento(s) nesta página`:'Lista indisponível'}</p>
   {page&&<><div className="table-scroll" role="region" tabIndex={0} aria-label="Orçamentos coletados do Origin"><table className="data-table"><thead><tr><th>Número / ID Origin</th><th>Situação na coleta</th><th>Última observação</th><th>Conferência</th></tr></thead><tbody>{page.items.map(row=><tr key={row.source_id}><td><strong>{row.source_number??'Sem número'}</strong><small>{row.source_id}</small></td><td>{row.source_status??'Não informada'}</td><td>{moment(row.source_seen_at)}</td><td><button type="button" className="text-button" disabled={locked||loading} onClick={()=>void inspect(row.source_id,Boolean(row.document_id))}>{row.document_id?'Consultar importação':'Conferir prévia'} <span className="sr-only">{row.source_id}</span></button></td></tr>)}</tbody></table></div><footer className="proposal-import-pagination"><span>Página {cursors.length}</span><div className="button-group"><button type="button" className="secondary-button" disabled={locked||loading||cursors.length===1} onClick={()=>changeList(()=>setCursors(x=>x.slice(0,-1)))}>Anterior</button><button type="button" className="secondary-button" disabled={locked||loading||!page.has_more} onClick={()=>changeList(()=>{if(page.next_cursor)setCursors(x=>[...x,page.next_cursor]);})}>Próxima</button></div></footer></>}
  </NativeListLayout>}
 </section>;
}
