import {useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import FiscalReviewedAuthorization from '../components/FiscalReviewedAuthorization';
import {createAccessController,type AuthPort} from '../lib/real-access';
import {createReviewedAuthorizationQaFixture,REVIEWED_QA_ORIGIN,REVIEWED_QA_API,REVIEWED_QA_ACTOR} from './reviewed-authorization-fixture';
export default function FiscalReviewedAuthorizationQA(){
 const [scenario,setScenario]=useState('disabled'),fixture=useMemo(()=>createReviewedAuthorizationQaFixture({allowRun:scenario==='ready',allowClosure:scenario==='closure',lookupOnly:scenario==='closure_lookup',allowRevalidation:scenario==='revalidation',revalidationLookupOnly:scenario==='revalidation_lookup'}),[scenario]),[model,setModel]=useState<'55'|'65'>('55'),[busy,setBusy]=useState(false),busyRef=useRef(false),[,update]=useState(0);
 const controller=useMemo(()=>{
  const session={access_token:'synthetic-reviewed-qa-token',user:{id:REVIEWED_QA_ACTOR}},auth:AuthPort={getSession:async()=>({data:{session},error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signInWithPassword:async()=>({data:{session:null},error:'QA_LOGIN_DISABLED'}),signOut:async()=>({error:null})};
  const real=createAccessController(auth,REVIEWED_QA_API,fixture.fetch,{a1ApiUrl:REVIEWED_QA_ORIGIN});
  return {...real,fiscalReviewedAuthorization:async(...args:Parameters<typeof real.fiscalReviewedAuthorization>)=>{try{return await real.fiscalReviewedAuthorization(...args);}finally{update(n=>n+1);}}};
 },[fixture]);
 const snapshot=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);useEffect(()=>controller.start(),[controller]);
 return <div className="real-shell"><header className="real-topbar"><strong>FAGOO · QA local de autorização revisada</strong></header><main className="real-main">
  <p role="note" className="real-notice">Dados e respostas fictícios. Sem rede externa, A1, certificado ou SEFAZ; não comprova autorização real. NF-e55 simula perda da resposta de envio/recuperação/encerramento/revalidação e da primeira consulta. NFC-e65 conclui normalmente.</p>
  <label>Cenário de teste <select aria-label="Cenário de teste" value={scenario} disabled={busy} onChange={e=>{if(!busyRef.current)setScenario(e.target.value);}}><option value="disabled">Envio desativado e histórico</option><option value="ready">Conferência e envio fictícios</option><option value="closure">Preparação expirada antes do envio</option><option value="closure_lookup">Recibo de encerramento já registrado</option><option value="revalidation">Conferir resposta armazenada</option><option value="revalidation_lookup">Revalidação já registrada</option></select></label>
  <label>Modelo de teste <select aria-label="Modelo de teste" value={model} disabled={busy} onChange={e=>{if(!busyRef.current)setModel(e.target.value as '55'|'65');}}><option value="55">NF-e55</option><option value="65">NFC-e65</option></select></label>
  <p>Disponibilidade: {fixture.counts.status} · Conferência: {fixture.counts.preflight} · Envio fictício: {fixture.counts.run} · Histórico: {fixture.counts.history} · Recuperação: {fixture.counts.recover} · Consulta de comando: {fixture.counts.command} · Ações proibidas: {fixture.counts.forbidden}</p>
  {scenario==='closure'&&<p>Encerramento fictício: {fixture.counts.close} · Consulta de encerramento: {fixture.counts.closureCommand}</p>}
  {scenario==='closure_lookup'&&<p>Consulta por tentativa original: {fixture.counts.closureLookup} · Encerramentos novos: {fixture.counts.close}</p>}
  {scenario.startsWith('revalidation')&&<p>Contexto da resposta: {fixture.counts.revalidationContext} · Revalidação fictícia: {fixture.counts.revalidationRun} · Consulta da revalidação: {fixture.counts.revalidationCommand}</p>}
  {snapshot.phase==='ready'?<FiscalReviewedAuthorization key={`${model}:${scenario}`} controller={controller} candidate={fixture.candidate(model)} onBusy={value=>{busyRef.current=value;setBusy(value);}}/>:<p role="status">Abrindo sessão sintética…</p>}
 </main></div>;
}
