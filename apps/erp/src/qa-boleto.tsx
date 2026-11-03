/** Separate DEV-only entry; it never opens a real session or accesses a financial database. */
import {useEffect,useMemo,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {createHashRouter,RouterProvider} from 'react-router-dom';
import {UnsavedChangesProvider} from './hooks/useUnsavedChanges';
import ItauBoletoPreview from './components/ItauBoletoPreview';
import {AccessError,type AccessState,type NativeRequestOptions} from './lib/real-access';
import {captureBoletoRead,type BoletoSource,type BoletoPurpose} from './lib/boleto-preview-model';
import './styles.css';
import './components/real-access.css';
if(!import.meta.env.DEV||location.hostname!=='127.0.0.1')throw Error('LOCAL_QA_ONLY');
const API='http://127.0.0.1:9016',ACTOR='a0000000-0000-4000-8000-000000000001';
async function local(path:string,signal:AbortSignal){
 const abort=new AbortController(),onAbort=()=>abort.abort(),timer=setTimeout(onAbort,10000);signal.addEventListener('abort',onAbort,{once:true});if(signal.aborted)onAbort();
 let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
 try{
  const url=API+path,r=await fetch(url,{method:'GET',headers:{Accept:'application/json'},credentials:'omit',cache:'no-store',redirect:'manual',referrerPolicy:'no-referrer',signal:abort.signal});
  if(r.redirected||r.url!==url||!r.body||r.headers.get('content-type')!=='application/json')throw Error('LOCAL_QA_UNAVAILABLE');
  reader=r.body.getReader();const decoder=new TextDecoder('utf-8',{fatal:true});let text='',size=0;
  for(;;){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>196608)throw Error('LOCAL_QA_LIMIT');text+=decoder.decode(item.value,{stream:true});}
  const value=JSON.parse(text+decoder.decode());if(!r.ok)throw new AccessError(r.status);return value;
 }finally{clearTimeout(timer);signal.removeEventListener('abort',onAbort);abort.abort();void reader?.cancel().catch(()=>{});}
}
function Qa(){
 const [fixtures,setFixtures]=useState<{purpose:BoletoPurpose;file:BoletoSource}[]>([]),[purpose,setPurpose]=useState<BoletoPurpose>('homologation'),[opened,setOpened]=useState(true),[active,setActive]=useState(true),[error,setError]=useState(''),[slow,setSlow]=useState(false),[failure,setFailure]=useState(false),[calls,setCalls]=useState(0);
 const scenario=useRef({purpose,slow,failure});scenario.current={purpose,slow,failure};
 const port=useMemo(()=>{
  let state:AccessState={phase:'ready',membership:{user_id:ACTOR,role:'consulta',resources:[],data_mode:'staging_readonly'},records:null,listPending:false,loginPending:false,message:null,logoutFailed:false};
  const listeners=new Set<()=>void>();
  return{controller:{getSnapshot:()=>state,subscribe(fn:()=>void){listeners.add(fn);return()=>{listeners.delete(fn);};},async boletoPreview(path:string,options:NativeRequestOptions={}){
   const captured=captureBoletoRead(path,options),s={...scenario.current};setCalls(n=>n+1);if(s.failure)throw new AccessError(503);
   const value=await local('/'+s.purpose+path,captured.signal??new AbortController().signal);
   if(s.slow)await new Promise(r=>setTimeout(r,2500));return value;
  }},setActor(id:string|null){state=id?{...state,phase:'ready',membership:{user_id:id,role:'consulta',resources:[],data_mode:'staging_readonly'}}:{...state,phase:'signed_out',membership:null};for(const fn of listeners)fn();}};
 },[]);
 useEffect(()=>{const p=new AbortController();void local('/fixtures',p.signal).then(v=>{if(v.profile!=='synthetic-itau-boleto-qa-v1'||!Array.isArray(v.fixtures)||v.fixtures.length!==2)throw Error('QA_FIXTURE_INVALID');setFixtures(v.fixtures);}).catch(()=>{if(!p.signal.aborted)setError('Inicie tools/qa/boleto-preview-server.mjs na porta 9016 e recarregue esta página.');});return()=>p.abort();},[]);
 const selected=fixtures.find(f=>f.purpose===purpose);
 return <main style={{maxWidth:1200,margin:'0 auto',padding:'2rem'}}><h1>QA local · boleto inteiramente fictício · NÃO PAGAR</h1>
  <p>Prévia produzida pelos encoders reais sobre dados sintéticos. Sem cadastro, título, remessa ou acesso bancário real; a fixture não executa POST.</p>
  <div className="button-group"><label>Origem fictícia <select value={purpose} onChange={e=>{setPurpose(e.target.value as BoletoPurpose);setOpened(true);}}><option value="homologation">Remessa de homologação</option><option value="operational">Remessa operacional fictícia</option></select></label>
   <label><input type="checkbox" checked={slow} onChange={e=>setSlow(e.target.checked)}/> Entregar resposta com 2,5 segundos de atraso</label><label><input type="checkbox" checked={failure} onChange={e=>setFailure(e.target.checked)}/> Simular leitura indisponível</label>
   <button type="button" onClick={()=>{port.setActor(active?null:ACTOR);setActive(!active);}}>{active?'Simular logout':'Restaurar sessão fictícia'}</button><button type="button" onClick={()=>{port.setActor(crypto.randomUUID());setActive(true);}}>Trocar ator fictício</button>
  </div><p>Consultas GET: {calls}. Operações financeiras: 0. Escritas remotas: 0.</p>{error&&<p role="alert">{error}</p>}
  {selected&&(opened?<ItauBoletoPreview controller={port.controller} file={selected.file} purpose={purpose} onClose={()=>setOpened(false)}/>:<button className="primary-button" onClick={()=>setOpened(true)}>Reabrir prévia fictícia</button>)}
 </main>;
}
const router=createHashRouter([{path:'*',element:<UnsavedChangesProvider><Qa/></UnsavedChangesProvider>}]);
createRoot(document.getElementById('root')!).render(<RouterProvider router={router}/>);
