import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {useNavigate} from 'react-router-dom';
import {numberingListPath} from '../lib/fiscal-numbering-model';
import {preparationActor,guideCompany,guideFiscal,guideA1,guideSeries,guideOrders,guideRows,type FiscalPreparationController,type GuideData,type GuideRead} from '../lib/fiscal-preparation-guide-model';
import type {FiscalModel} from '../lib/fiscal-drafts-model';
import './fiscal-preparation-guide.css';

export default function FiscalPreparationGuide({controller,model}:{controller:FiscalPreparationController;model:FiscalModel|''}){
 const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot),actor=preparationActor(state),navigate=useNavigate();
 const [data,setData]=useState<{actor:string;model:FiscalModel;value:GuideData}|null>(null),[busy,setBusy]=useState(false);
 const current=useRef({actor,model}),mounted=useRef(true),request=useRef<AbortController|null>(null);current.current={actor,model};
 useEffect(()=>{request.current?.abort();request.current=null;setData(null);setBusy(false);},[actor,model,state.phase,state.membership?.role]);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;request.current?.abort();};},[]);
 const authorized=()=>mounted.current&&actor!==null&&current.current.actor===actor&&current.current.model===model&&preparationActor(controller.getSnapshot())===actor;
 const check=()=>{
  if(!authorized()||!model||request.current)return;
  const pending=new AbortController();request.current=pending;setData(null);setBusy(true);
  const read=async<T,>(task:()=>Promise<unknown>,parse:(value:unknown)=>T):Promise<GuideRead<T>>=>{try{return{ok:true,value:parse(await task())};}catch{return{ok:false};}};
  void Promise.all([
   read(()=>controller.company('/v1/empresa/identidade',{signal:pending.signal}),guideCompany),
   read(()=>controller.company('/v1/empresa/fiscal',{signal:pending.signal}),guideFiscal),
   read(()=>controller.a1('/v1/a1',{signal:pending.signal}),guideA1),
   read(()=>controller.fiscalNumbering(numberingListPath(model),{signal:pending.signal}),raw=>guideSeries(raw,model)),
   read(()=>controller.documents('/v1/documentos/sales_orders?limit=25&origin=brufap',{signal:pending.signal}),guideOrders),
  ]).then(([company,fiscal,a1,series,orders])=>{if(!pending.signal.aborted&&request.current===pending&&authorized())setData({actor:actor!,model,value:{company,fiscal,a1,series,orders}});})
   .finally(()=>{if(request.current===pending){request.current=null;if(mounted.current)setBusy(false);}});
 };
 if(!actor)return <section className="fiscal-preparation-guide"><h2>Preparar a primeira nota</h2><p>Confirme o acesso de administrador ou fiscal para consultar a preparação.</p></section>;
 return <section className="fiscal-preparation-guide" aria-label="Preparação guiada da nota" aria-busy={busy}>
  <header><div><h2>Preparar {model==='55'?'NF-e':model==='65'?'NFC-e':'a primeira nota'}</h2><p>Confira os cadastros necessários e continue nas telas existentes. Cada etapa exige sua própria conferência.</p></div><button type="button" className="secondary-button" disabled={busy||!model} onClick={check}>{busy?'Consultando preparação…':'Conferir preparação'}</button></header>
  {!model&&<p className="real-help">Escolha NF-e ou NFC-e no filtro de modelo para conferir a preparação correspondente.</p>}
  {data&&data.actor===actor&&data.model===model&&<ol className="fiscal-preparation-guide-grid">{guideRows(data.value,data.model).map(row=><li key={row.id}><h3>{row.title}</h3><strong className={`fiscal-guide-${row.state}`}>{row.summary}</strong><p>{row.detail}</p><button type="button" className="text-button" onClick={()=>{if(authorized()&&!request.current)navigate(row.path);}}>{row.action}</button></li>)}</ol>}
  <p className="real-help">Esta consulta não seleciona pedido, série ou regras tributárias e não reserva número. Ter os cadastros informados não significa que a nota está pronta para emissão.</p>
 </section>;
}
