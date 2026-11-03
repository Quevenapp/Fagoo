/** Separate DEV entry. Not a production build input and never authenticates a real user. */
import {useEffect,useMemo,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import FiscalDanfePreview from './components/FiscalDanfePreview';
import type {AccessState,NativeRequestOptions} from './lib/real-access';
import type {SignedCandidate} from './lib/fiscal-signed-model';
import {readBounded,MAX_RESPONSE_BYTES} from '../../../packages/fiscal-danfe-runtime/src/protocol.mjs';
import './styles.css';
import './components/real-access.css';

if(!import.meta.env.DEV||location.hostname!=='127.0.0.1')throw new Error('LOCAL_QA_ONLY');
const API='http://127.0.0.1:9014',ACTOR='a1000000-0000-4000-8000-000000000099';
async function read(path:string,signal:AbortSignal){
 const url=API+path,response=await fetch(url,{method:'GET',headers:{Accept:'application/json'},credentials:'omit',cache:'no-store',redirect:'manual',signal});
 if(!response.ok||response.redirected||response.url!==url)throw new Error('LOCAL_QA_UNAVAILABLE');
 const bytes=await readBounded(response,{signal,deadline:Date.now()+10000,limit:MAX_RESPONSE_BYTES});
 try{return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));}finally{bytes.fill(0);}
}
function Qa(){
 const [candidates,setCandidates]=useState<SignedCandidate[]>([]),[model,setModel]=useState('55'),[error,setError]=useState(''),[active,setActive]=useState(true),[blocked,setBlocked]=useState(false),[slow,setSlow]=useState(false),[calls,setCalls]=useState(0);
 const delay=useRef(false);delay.current=slow;
 const port=useMemo(()=>{
  let snapshot={phase:'ready',membership:{user_id:ACTOR,role:'fiscal',resources:['nfe','nfce'],data_mode:'staging_readonly'}} as AccessState;
  const listeners=new Set<()=>void>();
  const controller={getSnapshot:()=>snapshot,subscribe(fn:()=>void){listeners.add(fn);return()=>{listeners.delete(fn);};},
   async fiscalDanfe(path:string,options:NativeRequestOptions={}){
    if(!/^\/v1\/fiscal-danfe\/candidates\/[a-f0-9-]{36}\/preview$/.test(path)||options.method&&options.method!=='GET'||options.body!==undefined)throw new Error('QA_GET_ONLY');
    const signal=options.signal??new AbortController().signal;setCalls(n=>n+1);const value=await read(path,signal);
    // Deliberately late local delivery tests that the component ignores an aborted callback.
    if(delay.current)await new Promise(r=>setTimeout(r,3000));return value;
   }};
  return{controller,setActor(value:string|null){snapshot=value?{...snapshot,phase:'ready',membership:{user_id:value,role:'fiscal',resources:['nfe','nfce'],data_mode:'staging_readonly'}}:{...snapshot,phase:'signed_out',membership:null};for(const fn of listeners)fn();}};
 },[]);
 useEffect(()=>{const abort=new AbortController();void read('/fixtures',abort.signal).then(v=>{
  if(v.profile!=='synthetic-danfe-qa-v1'||!Array.isArray(v.candidates)||v.candidates.length!==2)throw new Error('QA_FIXTURE_INVALID');setCandidates(v.candidates);
 }).catch(()=>{if(!abort.signal.aborted)setError('Inicie tools/qa/danfe-server.mjs na porta 9014 e recarregue esta página.');});return()=>abort.abort();},[]);
 const selected=candidates.find(c=>c.model===model);
 return <main style={{maxWidth:1280,margin:'0 auto',padding:'2rem'}}>
  <h1>QA local · DANFE inteiramente fictício</h1><p>Somente arquivos sintéticos. Sem sessão real, certificado cadastrado, banco de dados ou conexão à SEFAZ.</p>
  <div className="button-group"><label>Modelo <select value={model} onChange={e=>setModel(e.target.value)}><option value="55">55 · A4</option><option value="65">65 · Bobina 80 mm</option></select></label>
   <label><input type="checkbox" checked={slow} onChange={e=>setSlow(e.target.checked)}/> Entregar resposta com 3 segundos de atraso</label>
   <label><input type="checkbox" checked={blocked} onChange={e=>setBlocked(e.target.checked)}/> Bloquear ações</label>
   <button type="button" onClick={()=>{port.setActor(active?null:ACTOR);setActive(!active);}}>{active?'Simular logout':'Restaurar sessão fictícia'}</button>
   <button type="button" onClick={()=>{port.setActor(crypto.randomUUID());setActive(true);}}>Trocar ator fictício</button>
  </div><p>Consultas de prévia: {calls}. Abrir e imprimir não executa assinatura nem consulta fiscal.</p>
  {error&&<p role="alert">{error}</p>}{selected&&<FiscalDanfePreview controller={port.controller} candidate={selected} blocked={blocked}/>}
 </main>;
}
createRoot(document.getElementById('root')!).render(<Qa/>);
