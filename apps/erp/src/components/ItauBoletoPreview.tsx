import {useEffect,useId,useRef,useState} from 'react';
import {AccessError,type AccessState,type NativeRequestOptions} from '../lib/real-access';
import {useUnsavedChanges} from '../hooks/useUnsavedChanges';
import {financeDate,financeMoney} from '../lib/real-finance-model';
import {BOLETO_BASE,boletoItems,boletoPreview,type BoletoSource,type BoletoPurpose,type BoletoItems,type BoletoItem,type BoletoPreview} from '../lib/boleto-preview-model';
import './itau-boleto-preview.css';
export interface BoletoPreviewController {getSnapshot:()=>AccessState;subscribe:(listener:()=>void)=>()=>void;boletoPreview:(path:string,options?:NativeRequestOptions)=>Promise<unknown>;}
type Props={controller:BoletoPreviewController;file:BoletoSource;purpose:BoletoPurpose;onClose:()=>void};
const actorFor=(c:BoletoPreviewController)=>{const s=c.getSnapshot();return s.phase==='ready'&&['admin','financeiro','consulta'].includes(s.membership?.role??'')?s.membership!.user_id:null;};
const sourceKey=(f:BoletoSource,p:BoletoPurpose)=>[f.id,f.profile_id,f.file_hash,f.state,f.kind,p].join('|');
const message=(e:unknown)=>e instanceof AccessError&&e.status===403?'Seu perfil não permite consultar esta prévia.':e instanceof AccessError&&[404,409].includes(e.status)?'A reserva, o título ou os dados da empresa mudaram. Atualize a remessa antes de consultar novamente.':e instanceof AccessError&&e.status===422?'Este título não atende ao perfil desta prévia. Confira valor, referência, dados cadastrais e encargos; nada foi alterado.':'Não foi possível conferir a prévia. Tente consultar novamente.';

/** GET-only view. The frame has no script capability; print is fenced to the exact loaded instance. */
export default function ItauBoletoPreview({controller,file,purpose,onClose}:Props){
 const uid=useId(),frame=useRef<HTMLIFrameElement>(null),request=useRef<AbortController|null>(null),alive=useRef(true);
 const [list,setList]=useState<{actor:string;value:BoletoItems}|null>(null),[loaded,setLoaded]=useState<{actor:string;key:string;value:BoletoPreview}|null>(null);
 const [busy,setBusy]=useState(false),[ready,setReady]=useState(false),[error,setError]=useState(''),[,changed]=useState(0);
 const listRef=useRef<typeof list>(null),loadedRef=useRef<typeof loaded>(null),live=useRef({file,purpose});live.current={file,purpose};
 useUnsavedChanges(false,busy);
 const clear=()=>{request.current?.abort();request.current=null;loadedRef.current=null;setLoaded(null);setReady(false);setBusy(false);setError('');};
 const clearAll=()=>{clear();listRef.current=null;setList(null);};
 const close=()=>{clearAll();onClose();};
 const key=sourceKey(file,purpose),actor=actorFor(controller);
 const valid=(p:AbortController,owner:string,k:string)=>alive.current&&!p.signal.aborted&&request.current===p&&actorFor(controller)===owner&&sourceKey(live.current.file,live.current.purpose)===k;
 const loadItems=async()=>{
  const owner=actorFor(controller),f={...live.current.file},purpose=live.current.purpose,k=sourceKey(f,purpose);
  if(!owner||request.current||f.kind!=='remittance'||f.state!=='ready'||!f.file_hash)return;
  clearAll();const p=new AbortController();request.current=p;setBusy(true);
  try{const raw=await controller.boletoPreview(`${BOLETO_BASE}/remittances/${f.id}/items`,{signal:p.signal});if(!valid(p,owner,k))return;
   const value=boletoItems(raw,f,purpose),shown={actor:owner,value};listRef.current=shown;setList(shown);
  }catch(e){if(valid(p,owner,k))setError(message(e));}finally{if(valid(p,owner,k)){request.current=null;setBusy(false);}}
 };
 useEffect(()=>{alive.current=true;let prior=actorFor(controller);const unsubscribe=controller.subscribe(()=>{const next=actorFor(controller);if(!next||next!==prior)clearAll();prior=next;changed(n=>n+1);});return()=>{alive.current=false;request.current?.abort();unsubscribe();};},[controller]);
 useEffect(()=>{clearAll();void loadItems();return()=>request.current?.abort();},[controller,key]);
 const open=async(item:BoletoItem)=>{
  const owner=actorFor(controller),current=listRef.current,k=sourceKey(live.current.file,live.current.purpose);
  if(!owner||request.current||!current||current!==list||current.actor!==owner||!current.value.items.includes(item))return;
  clear();const p=new AbortController();request.current=p;setBusy(true);
  try{const raw=await controller.boletoPreview(`${BOLETO_BASE}/${item.billing_title_id}/preview`,{signal:p.signal});if(!valid(p,owner,k))return;
   const value=await boletoPreview(raw,current.value,item);if(!valid(p,owner,k))return;
   const shown={actor:owner,key:k,value};loadedRef.current=shown;setLoaded(shown);
  }catch(e){if(valid(p,owner,k))setError(message(e));}finally{if(valid(p,owner,k)){request.current=null;setBusy(false);}}
 };
 const shown=loaded&&loaded.actor===actor&&loaded.key===key?loaded.value:null;
 const print=()=>{
  if(!shown||!ready||busy||request.current||loadedRef.current!==loaded||actorFor(controller)!==loaded?.actor||sourceKey(live.current.file,live.current.purpose)!==loaded.key)return;
  try{const w=frame.current?.contentWindow;if(!w)throw Error();w.focus();w.print();}catch{setError('Não foi possível abrir a impressão. Reabra a prévia e tente novamente.');}
 };
 return <section className="itau-boleto-preview" aria-labelledby={`${uid}-title`} aria-busy={busy}>
  <header className="real-editor-heading"><div><h2 id={`${uid}-title`}>Prévia de boleto Itaú 109</h2><p>Conferência da reserva local · NÃO PAGAR</p></div><button type="button" className="secondary-button" onClick={close}>Voltar às remessas</button></header>
  <p className="real-notice">Esta tela apenas lê uma remessa já guardada. Não emite, registra, envia ou baixa cobranças e não reserva outro número. A homologação visual bancária permanece pendente.</p>
  <p>Origem: remessa {purpose==='operational'?'operacional':'de homologação'}. A finalidade desta prévia continua sendo conferência sem validade para pagamento.</p>
  <button type="button" className="secondary-button" disabled={busy||!actor} onClick={()=>void loadItems()}>Atualizar títulos</button>
  {busy&&<p role="status">Conferindo reserva e arquivo…</p>}{error&&<p role="alert" className="real-alert">{error}</p>}
  {list?.actor===actor&&<><p>Escolha um título. Estar nesta lista não comprova elegibilidade: a abertura revalida o arquivo, o perfil, a empresa e o título.</p>
   <div className="table-scroll"><table className="data-table"><thead><tr><th>Documento</th><th>Vencimento</th><th>Valor nominal</th><th>Ação</th></tr></thead><tbody>{list.value.items.map(item=><tr key={item.billing_title_id}><td>{item.document_number}</td><td>{financeDate(item.due_on)}</td><td>{financeMoney(item.amount_cents)}</td><td><button type="button" className="text-button" disabled={busy||!actor} onClick={()=>void open(item)}>Visualizar {item.document_number}</button></td></tr>)}</tbody></table></div></>}
  {shown&&<><p role="status">Reserva local e arquivo conferidos. Endereço do beneficiário: cadastro atual da empresa, versão {shown.source.company_identity_version}. Isso não comprova registro ou aceitação pelo banco.</p>
   <div className="button-group"><button type="button" className="secondary-button" onClick={clear}>Fechar prévia</button><button type="button" className="primary-button" disabled={!ready||busy||!actor} onClick={print}>Imprimir prévia NÃO PAGAR</button></div>
   <p>Imprima em A4, escala 100%, sem cabeçalho ou rodapé do navegador. Não use esta impressão para pagamento.</p>
   <iframe ref={frame} title="Boleto Itaú 109 — NÃO PAGAR" srcDoc={shown.html} sandbox="allow-same-origin allow-modals" referrerPolicy="no-referrer" onLoad={e=>{if(e.currentTarget===frame.current&&loadedRef.current===loaded&&actorFor(controller)===loaded?.actor&&sourceKey(live.current.file,live.current.purpose)===loaded?.key)setReady(true);}}/>
  </>}
 </section>;
}
