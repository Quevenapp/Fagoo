import {useEffect,useRef,useState,type FormEvent,type RefObject} from 'react';
import {Link} from 'react-router-dom';
import {AccessError,type NativeRequestOptions,type AccessState} from '../lib/real-access';
import {financialImportBatchPath,type FinancialImportBatch} from '../lib/financial-import-model';
import {checkedStoredFinancialImportBatch} from '../lib/financial-import-read';
import {financialCutoverCents,financialCutoverDay,financialCutoverMoment} from '../lib/financial-cutover-model';

const statuses={open:'Aberto',partial:'Parcial',paid:'Quitado',cancelled:'Cancelado'};
export function FinancialImportBatchDetails({batch,headingRef}:{batch:FinancialImportBatch;headingRef?:RefObject<HTMLHeadingElement|null>}){
 return <section className="financial-import-result" aria-label="Recibo e situação atual do lote financeiro"><h3 ref={headingRef} tabIndex={-1}>Lote registrado e situação atual consultada</h3>
  <p>Identificador <code>{batch.batch.id}</code>. O recibo original reúne {batch.batch.items.length} título(s), no total de {financialCutoverCents(batch.batch.total_cents)}, importados em {financialCutoverMoment(batch.batch.created_at)}. Ele não registra baixas.</p>
  <div className="table-scroll" role="region" tabIndex={0} aria-label="Situação atual dos títulos importados"><table className="data-table"><thead><tr><th>ID Origin / descrição original</th><th>Vencimento original</th><th>Vencimento atual</th><th>Situação atual</th><th className="money">Valor original</th><th className="money">Saldo pendente atual</th></tr></thead><tbody>{batch.batch.items.map(item=>{const title=batch.current_titles.find(t=>t.id===item.title_id)!;return <tr key={item.title_id}><td>{item.source_id}<small>{item.description}</small>{title.description!==item.description&&<small>Descrição atual: {title.description}</small>}</td><td>{financialCutoverDay(item.due_on)}</td><td>{title.due_on.split('-').reverse().join('/')}</td><td>{statuses[title.status]} · versão {title.version}</td><td className="money">{financialCutoverCents(item.amount_cents)}</td><td className="money">{financialCutoverCents(title.balance_cents)}</td></tr>;})}</tbody></table></div>
  <p>A situação atual pode mudar em operações posteriores. <Link to={`/financeiro-empresa?area=${batch.batch.entity==='receivables'?'receivable':'payable'}`}>Abrir títulos da empresa</Link></p>
 </section>;
}

type Controller={getSnapshot?:()=>AccessState;financialImport(path:string,options?:NativeRequestOptions):Promise<unknown>};
export default function FinancialImportBatchLookup({controller}:{controller:Controller}){
 const[draft,setDraft]=useState(''),[batch,setBatch]=useState<FinancialImportBatch|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const pending=useRef<AbortController|null>(null),mounted=useRef(false),live=useRef({controller,draft});live.current={controller,draft};
 const heading=useRef<HTMLHeadingElement>(null);
 const actor=useRef(controller.getSnapshot?.().membership?.user_id);
 const allowed=()=>{if(!controller.getSnapshot)return true;const state=controller.getSnapshot();return state.phase==='ready'&&state.membership?.role==='admin'&&state.membership.user_id===actor.current;};
 useEffect(()=>{mounted.current=true;setBusy(false);setBatch(null);setError('');return()=>{mounted.current=false;pending.current?.abort();pending.current=null;};},[controller]);
 const submit=async(event:FormEvent)=>{
  event.preventDefault();if(!mounted.current||!allowed()||pending.current||live.current.controller!==controller)return;
  const id=live.current.draft.trim().toLowerCase();let path:string;
  try{path=financialImportBatchPath(id);}catch{setError('Informe o identificador completo do lote.');setBatch(null);return;}
  const request=new AbortController();pending.current=request;setBusy(true);setError('');setBatch(null);
  try{const value=await controller.financialImport(path,{method:'GET',signal:request.signal});if(request.signal.aborted||pending.current!==request)return;setBatch(checkedStoredFinancialImportBatch(value,id));heading.current?.focus();}
  catch(failure){if(!request.signal.aborted)setError(failure instanceof AccessError&&failure.status===404?'Lote não encontrado. Esta consulta não envia nem repete uma importação.':failure instanceof AccessError&&failure.status===403?'A consulta do lote exige acesso de administrador ativo.':'Não foi possível consultar o lote. Tente consultar novamente.');}
  finally{if(pending.current===request){pending.current=null;if(!request.signal.aborted)setBusy(false);}}
 };
 return <section aria-labelledby="financial-import-lookup-heading"><h3 id="financial-import-lookup-heading" ref={heading} tabIndex={-1}>Consultar lote já registrado</h3><p className="real-help">Use o identificador guardado ao importar, inclusive após fechar a tela. Esta consulta não cria títulos nem repete a importação.</p>
  <form className="financial-import-filters" onSubmit={submit}><div className="form-field"><label htmlFor="financial-import-batch-id">Identificador do lote</label><input id="financial-import-batch-id" value={draft} maxLength={36} autoComplete="off" spellCheck={false} disabled={busy} onChange={event=>{if(mounted.current&&allowed()&&!pending.current&&live.current.controller===controller){setDraft(event.target.value);setBatch(null);setError('');}}}/></div><button type="submit" className="secondary-button" disabled={busy}>{busy?'Consultando lote…':'Consultar lote'}</button></form>
  {error&&<p className="real-error" role="alert">{error}</p>}{batch&&<FinancialImportBatchDetails batch={batch}/>}
 </section>;
}
