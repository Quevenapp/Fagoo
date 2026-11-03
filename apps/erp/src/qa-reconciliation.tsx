/** Separate DEV-only fixture entry. It never reads a real session or calls an external endpoint. */
import {useEffect,useMemo,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {createHashRouter,RouterProvider} from 'react-router-dom';
import {UnsavedChangesProvider} from './hooks/useUnsavedChanges';
import FiscalReconciliation from './components/FiscalReconciliation';
import {AccessError,type AccessState,type NativeRequestOptions} from './lib/real-access';
import {signedCandidate,type SignedCandidate} from './lib/fiscal-signed-model';
import {captureReconciliationRequest} from './lib/fiscal-reconciliation-model';
import './styles.css';
import './components/real-access.css';
if(!import.meta.env.DEV||location.hostname!=='127.0.0.1')throw new Error('LOCAL_QA_ONLY');
const API='http://127.0.0.1:9015',ACTOR='a6200000-0000-4000-8000-000000000001',OTHER='a6200000-0000-4000-8000-000000000002';
async function local(path:string,actor:string|null,options:NativeRequestOptions={}){
 const abort=new AbortController(),onAbort=()=>abort.abort(),timer=setTimeout(onAbort,10000);options.signal?.addEventListener('abort',onAbort,{once:true});if(options.signal?.aborted)onAbort();
 let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
 try{
  const url=API+path,response=await fetch(url,{method:options.method??'GET',headers:{Accept:'application/json',...(actor?{'x-qa-actor':actor}:{}),...(options.body===undefined?{}:{'content-type':'application/json'})},body:options.body===undefined?undefined:JSON.stringify(options.body),credentials:'omit',cache:'no-store',redirect:'manual',referrerPolicy:'no-referrer',signal:abort.signal});
  if(response.redirected||response.url!==url||!response.body||response.headers.get('content-type')!=='application/json')throw new Error('LOCAL_QA_UNAVAILABLE');
  reader=response.body.getReader();const decoder=new TextDecoder('utf-8',{fatal:true});let size=0,text='';for(;;){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>131072)throw new Error('LOCAL_QA_LIMIT');text+=decoder.decode(item.value,{stream:true});}
  const value=JSON.parse(text+decoder.decode());if(!response.ok)throw new AccessError(response.status);return value;
 }finally{clearTimeout(timer);options.signal?.removeEventListener('abort',onAbort);abort.abort();void reader?.cancel().catch(()=>{});}
}
function Qa(){
 const [candidates,setCandidates]=useState<SignedCandidate[]>([]),[model,setModel]=useState('55'),[error,setError]=useState(''),[active,setActive]=useState(true),[other,setOther]=useState(false),[blocked,setBlocked]=useState(false),[fault,setFault]=useState(false),[slow,setSlow]=useState(false),[counts,setCounts]=useState({reads:0,recover:0,run:0}),[guard,setGuard]=useState(false),[dirty,setDirty]=useState(false);
 const options=useRef({fault:false,slow:false});options.current={fault,slow};
 const port=useMemo(()=>{
  let actor:string|null=ACTOR,snapshot={phase:'ready',membership:{user_id:ACTOR,role:'fiscal',resources:['nfe','nfce'],data_mode:'staging_readonly'}} as AccessState;
  const listeners=new Set<()=>void>(),failures=new Set<string>();let failNextCommand=false;
  const controller={getSnapshot:()=>snapshot,subscribe(fn:()=>void){listeners.add(fn);return()=>{listeners.delete(fn);};},a1:(path:string,o:NativeRequestOptions={})=>local(path,actor,o),company:(path:string,o:NativeRequestOptions={})=>local(path,actor,o),
   async fiscalReconciliation(path:string,o:NativeRequestOptions={}){
    const selected=captureReconciliationRequest(path,o);setCounts(v=>({...v,[selected.action==='run'?'run':selected.action==='recover'?'recover':'reads']:v[selected.action==='run'?'run':selected.action==='recover'?'recover':'reads']+1}));
    if(selected.action==='command'&&failNextCommand){failNextCommand=false;throw new AccessError(503);}
    const value=await local(path,actor,{method:selected.method,...(selected.action==='command'?{}:{body:selected.payload}),signal:selected.signal});
    if(options.current.slow)await new Promise(r=>setTimeout(r,2500));
    if(selected.action==='recover'&&options.current.fault&&!failures.has(selected.payload.command_id)){failures.add(selected.payload.command_id);failNextCommand=true;throw new AccessError(503);}
    return value;
   }};
  return{controller,setActor(value:string|null){actor=value;snapshot=value?{...snapshot,phase:'ready',membership:{user_id:value,role:'fiscal',resources:['nfe','nfce'],data_mode:'staging_readonly'}}:{...snapshot,phase:'signed_out',membership:null};for(const fn of listeners)fn();}};
 },[]);
 useEffect(()=>{const p=new AbortController();void local('/fixtures',null,{signal:p.signal}).then(v=>{if(v.profile!=='synthetic-reconciliation-qa-v1'||v.enabled!==false||!Array.isArray(v.candidates)||v.candidates.length!==2)throw Error('QA_FIXTURE_INVALID');setCandidates(v.candidates.map((c:unknown)=>signedCandidate(c)));}).catch(()=>{if(!p.signal.aborted)setError('Inicie tools/qa/reconciliation-server.mjs na porta 9015 e recarregue esta página.');});return()=>p.abort();},[]);
 const candidate=candidates.find(c=>c.model===model);
 return <main style={{maxWidth:1100,margin:'0 auto',padding:'2rem'}}><h1>QA local · consulta de protocolo fictícia</h1><p>Recurso de novas consultas desativado. Somente histórico e recuperação de dados sintéticos em memória; nenhum A1, banco de dados ou acesso à SEFAZ.</p>
  <div className="button-group"><label>Modelo <select disabled={guard||dirty} value={model} onChange={e=>setModel(e.target.value)}><option value="55">55 · NF-e</option><option value="65">65 · NFC-e</option></select></label>
   <label><input type="checkbox" checked={fault} onChange={e=>setFault(e.target.checked)}/> Perder ACK de recuperação e falhar primeiro GET</label><label><input type="checkbox" checked={slow} onChange={e=>setSlow(e.target.checked)}/> Entregar resposta com 2,5 segundos de atraso</label><label><input type="checkbox" checked={blocked} onChange={e=>setBlocked(e.target.checked)}/> Bloquear ações pelo pai</label>
   <button type="button" onClick={()=>{const next=!active;port.setActor(next?other?OTHER:ACTOR:null);setActive(next);}}>{active?'Simular logout':'Restaurar sessão fictícia'}</button><button type="button" onClick={()=>{const next=!other;port.setActor(next?OTHER:ACTOR);setOther(next);setActive(true);}}>{other?'Voltar ao ator da consulta':'Trocar para outro ator fictício'}</button>
  </div><p>Leituras: {counts.reads}. Recuperações locais: {counts.recover}. Runs: {counts.run}. Envios externos: 0. Guard do pai: {guard?'bloqueado':'livre'}.</p>
  {error&&<p role="alert">{error}</p>}{candidate&&<FiscalReconciliation controller={port.controller} candidate={candidate} enabled={false} blocked={blocked} onBusy={setGuard} onDraft={setDirty}/>}
 </main>;
}
const router=createHashRouter([{path:'*',element:<UnsavedChangesProvider><Qa/></UnsavedChangesProvider>}]);
createRoot(document.getElementById('root')!).render(<RouterProvider router={router}/>);
