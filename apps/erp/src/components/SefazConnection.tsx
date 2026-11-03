import {useEffect,useId,useRef,useState} from 'react';
import {AccessError,type AccessState,type NativeRequestOptions} from '../lib/real-access';
import {useUnsavedChanges} from '../hooks/useUnsavedChanges';
import {a1Metadata,a1Company,type A1Current,type A1Company,type A1Controller} from '../lib/a1-model';
import {fiscalMoment} from '../lib/fiscal-drafts-model';
import {isAppImportFailure,APP_UPDATE_MESSAGE} from '../lib/import-failure';
import {WSDL_BASE,WSDL_STATE_LABELS,WSDL_OPERATIONS,isWsdlOperation,wsdlReady,wsdlRun,wsdlResult,bindWsdlResult,type WsdlRun,type WsdlResult} from '../lib/wsdl-model';
import './sefaz-connection.css';

export interface WsdlController extends A1Controller {getSnapshot:()=>AccessState;wsdl:(path:string,options?:NativeRequestOptions)=>Promise<unknown>;}
type Props={controller:WsdlController};
type Bases={a1:A1Current;company:A1Company|null};
type Attempt={body:WsdlRun;ack:WsdlResult|null;uncertain:boolean};
const aborted=(e:unknown)=>e instanceof DOMException&&e.name==='AbortError';
const issue=(e:unknown)=>e instanceof AccessError&&e.status===403?'Seu acesso precisa ser conferido. A confirmação existente permanece preservada.':e instanceof AccessError&&e.status===409?'A empresa ou o certificado mudou. Atualize os dados antes de confirmar outra verificação.':'Não foi possível concluir a consulta. Tente conferir o resultado novamente.';

/** A1 is used only after the user confirms. Mount reads metadata; there is no external GET or background retry. */
export default function SefazConnection({controller}:Props){
 const uid=useId(),[bases,setBases]=useState<Bases|null>(null),[model,setModel]=useState(''),[operation,setOperation]=useState(''),[confirmed,setConfirmed]=useState(false),[result,setResult]=useState<WsdlResult|null>(null);
 const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[recovering,setRecovering]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[reload,setReload]=useState(0),[updateRequired,setUpdateRequired]=useState(false);
 const updateBlocked=useRef(false);
 const request=useRef<AbortController|null>(null),attempt=useRef<Attempt|null>(null),knownBody=useRef<WsdlRun|null>(null),alive=useRef(true);
 const snapshot=controller.getSnapshot(),owner=useRef(snapshot.membership?.user_id),canUse=snapshot.phase==='ready'&&snapshot.membership?.user_id===owner.current&&['admin','fiscal'].includes(snapshot.membership?.role??'');
 const live=useRef({canUse,bases,model,operation,confirmed,result});live.current={canUse,bases,model,operation,confirmed,result};
 const guard=useUnsavedChanges(confirmed,loading||busy||recovering);
 const authorized=()=>{const state=controller.getSnapshot();return state.phase==='ready'&&state.membership?.user_id===owner.current&&['admin','fiscal'].includes(state.membership?.role??'');};
 const valid=(p:AbortController)=>alive.current&&!p.signal.aborted&&authorized();
 const free=()=>authorized()&&!request.current&&!attempt.current;
 const clearConfirmation=()=>{live.current.confirmed=false;setConfirmed(false);};
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;request.current?.abort();attempt.current=null;knownBody.current=null;};},[]);
 useEffect(()=>{
  if(attempt.current)return;
  const p=new AbortController();request.current=p;setLoading(true);setBases(null);setError('');
  if(!authorized()){request.current=null;setLoading(false);return()=>p.abort();}
  void Promise.all([controller.a1('/v1/a1',{signal:p.signal}).then(a1Metadata),controller.company('/v1/empresa/identidade',{signal:p.signal}).then(a1Company)]).then(([a1,company])=>{
   if(valid(p)){const next={a1,company};live.current.bases=next;setBases(next);}
  }).catch(e=>{if(valid(p)&&!aborted(e))setError(issue(e));}).finally(()=>{if(alive.current&&!p.signal.aborted){request.current=null;setLoading(false);}});
  return()=>p.abort();
 },[controller,reload]);
 const readback=async(op:Attempt,p:AbortController)=>{
  const current=bindWsdlResult(wsdlResult(await controller.wsdl(`${WSDL_BASE}/commands/${op.body.command_id}`,{signal:p.signal}),{commandId:op.body.command_id}),op.body,op.ack);
  if(!valid(p))return;
  knownBody.current=op.body;attempt.current=null;setResult(current);live.current.result=current;setRecovering(false);clearConfirmation();
  setNotice(current.status==='stored'?'Consulta guardada e resultado conferido. Isso não autoriza emitir notas.':'A tentativa está registrada. Nenhuma consulta será repetida automaticamente.');
 };
 const execute=async(mode:'run'|'read')=>{
  const op=attempt.current;if(!op||request.current||!authorized())return;
  const p=new AbortController(),priorUncertain=op.uncertain;request.current=p;setBusy(true);setError('');
  try{
   if(mode==='run'){
    const received=bindWsdlResult(wsdlResult(await controller.wsdl(`${WSDL_BASE}/run`,{method:'POST',body:op.body,signal:p.signal}),{body:op.body}),op.body);
    if(!valid(p))return;
    if(received.status==='unconfirmed'||received.failure_code!==null){op.uncertain=true;setRecovering(true);setResult(received);setNotice('O resultado ainda não foi confirmado. Consulte a mesma tentativa antes de iniciar outra verificação.');return;}
    op.ack=received;setResult(received);
   }
   if(valid(p))await readback(op,p);
  }catch(e){if(valid(p)&&!aborted(e)){
   if(isAppImportFailure(e)){
    updateBlocked.current=true;setUpdateRequired(true);
    if(mode==='run'&&!priorUncertain&&!op.ack){attempt.current=null;knownBody.current=null;setRecovering(false);clearConfirmation();setError(`${APP_UPDATE_MESSAGE} Nenhuma verificação foi enviada nesta tentativa.`);}
    else{op.uncertain=true;setRecovering(true);setError('A consulta do resultado não carregou. A tentativa anterior continua preservada e pode ter sido registrada. Não inicie outra verificação.');}
    return;
   }
   const definitive=mode==='run'&&!priorUncertain&&!op.ack&&e instanceof AccessError&&[400,403,404,409].includes(e.status);
   if(definitive){attempt.current=null;setRecovering(false);clearConfirmation();setBases(null);live.current.bases=null;setError(issue(e));}
   else{op.uncertain=true;setRecovering(true);setError(op.ack?'A operação foi registrada, mas a consulta do resultado falhou. Consulte novamente; a verificação não será reenviada.':e instanceof AccessError&&e.status===404?'A tentativa não foi localizada nesta consulta. A confirmação foi preservada; consulte novamente antes de iniciar outra verificação.':'O resultado permanece incerto. A confirmação foi preservada para consultar a mesma tentativa.');}
  }}finally{if(alive.current&&!p.signal.aborted){request.current=null;setBusy(false);}}
 };
 const run=()=>{
  const x=live.current;if(updateBlocked.current||!free()||!x.confirmed||x.result||!wsdlReady(x.bases?.a1??null,x.bases?.company??null))return;
  try{const body=wsdlRun(x.model,x.operation,x.bases!.a1,x.bases!.company,true,crypto.randomUUID());attempt.current={body,ack:null,uncertain:false};knownBody.current=body;setResult(null);setNotice('');setRecovering(true);void execute('run');}
  catch{setError('Confira o tipo de nota, o serviço, a empresa e o certificado antes de confirmar.');}
 };
 const refreshBases=()=>{if(!free())return;guard.confirmLeave(()=>{if(!free())return;clearConfirmation();setNotice('');live.current.bases=null;setBases(null);setReload(n=>n+1);});};
 const discard=()=>{if(!free())return;guard.confirmLeave(()=>{if(!free())return;clearConfirmation();});};
 const consult=()=>{if(!free()||!knownBody.current)return;attempt.current={body:knownBody.current,ack:live.current.result,uncertain:true};setRecovering(true);void execute('read');};
 const newAllowed=()=>{const r=live.current.result;return Boolean(r&&(r.status==='stored'||r.status==='failed'||r.status==='uncertain'||r.current?.lease_expired));};
 const prepareNew=()=>{if(!free()||!newAllowed())return;guard.confirmLeave(()=>{if(!free()||!newAllowed())return;clearConfirmation();knownBody.current=null;live.current.result=null;live.current.bases=null;setBases(null);setResult(null);setNotice('Uma nova verificação exige outra confirmação. O registro da tentativa anterior será preservado.');setReload(n=>n+1);});};
 const locked=!canUse||loading||busy||recovering,eligible=wsdlReady(bases?.a1??null,bases?.company??null),choicesLocked=locked||result!==null||updateRequired;
 if(!canUse)return <section className="sefaz-connection"><h1>Conexão com a SEFAZ</h1><p role="alert">Seu perfil não permite acessar esta etapa.</p></section>;
 return <section className="sefaz-connection" aria-labelledby={`${uid}-title`} aria-busy={loading||busy}>
  <header><div><span className="sefaz-environment">Homologação</span><h1 id={`${uid}-title`}>Conexão com a SEFAZ</h1><p>Verifique o acesso seguro ao serviço de São Paulo com o certificado cadastrado.</p></div><button className="secondary-button" type="button" disabled={locked} onClick={refreshBases}>Atualizar empresa e certificado</button></header>
  <p className="real-notice">Esta verificação consulta a descrição do serviço. Não envia notas, não manifesta documentos e não ativa a emissão nem a coleta de NF-e recebidas.</p>
  {loading&&<p role="status">Consultando empresa e certificado…</p>}{error&&<p role="alert" className="real-alert">{error}</p>}{notice&&<p role="status" className="real-success">{notice}</p>}
  {updateRequired&&!recovering&&<button type="button" className="secondary-button" disabled={busy||loading} onClick={()=>{if(!request.current&&!attempt.current)guard.confirmLeave(()=>window.location.reload());}}>Atualizar página</button>}
  {bases&&<div className="sefaz-bases"><section><h2>Empresa</h2><p>{bases.company?.legal_name??'Identidade ainda não cadastrada.'}</p></section><section><h2>Certificado</h2><p>{bases.a1.state==='unconfigured'?'Nenhum certificado cadastrado.':bases.a1.state==='disabled'?'Certificado desativado.':!bases.a1.time_valid_now?'Certificado fora do período de validade.':!eligible?'O certificado e a identidade da empresa precisam ser conferidos.':'Certificado cadastrado e dentro da validade consultada.'}</p>{bases.a1.metadata&&<p>Válido até {fiscalMoment(bases.a1.metadata.not_after)}.</p>}</section></div>}
  <div className="sefaz-form"><label htmlFor={`${uid}-model`}>Tipo de nota</label><select id={`${uid}-model`} value={model} disabled={choicesLocked} onChange={e=>{if(free()&&!live.current.result&&['','55','65'].includes(e.target.value)){setModel(e.target.value);live.current.model=e.target.value;clearConfirmation();}}}><option value="">Selecione</option><option value="55">NF-e de produtos</option><option value="65">NFC-e</option></select>
   <label htmlFor={`${uid}-operation`}>Serviço</label><select id={`${uid}-operation`} value={operation} disabled={choicesLocked} onChange={e=>{if(free()&&!live.current.result&&(e.target.value===''||isWsdlOperation(e.target.value))){setOperation(e.target.value);live.current.operation=e.target.value;clearConfirmation();}}}><option value="">Selecione</option>{Object.entries(WSDL_OPERATIONS).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select>
   <p>Será consultada somente a descrição do serviço selecionado, sem executar sua operação.</p>
   {!recovering&&<><label className="sefaz-check"><input type="checkbox" checked={confirmed} disabled={choicesLocked||!eligible||!model||!isWsdlOperation(operation)} onChange={e=>{if(free()&&!live.current.result&&wsdlReady(live.current.bases?.a1??null,live.current.bases?.company??null)&&live.current.model&&isWsdlOperation(live.current.operation)&&live.current.model===model&&live.current.operation===operation){setConfirmed(e.target.checked);live.current.confirmed=e.target.checked;}}}/>{model&&isWsdlOperation(operation)?`Autorizo usar o certificado cadastrado somente para verificar o acesso a ${WSDL_OPERATIONS[operation]} de ${model==='55'?'NF-e de produtos':'NFC-e'} em homologação, sem emissão de notas.`:'Escolha o tipo de nota e o serviço para confirmar o uso do certificado em homologação.'}</label>
    <div className="button-group"><button className="primary-button" type="button" disabled={choicesLocked||!eligible||!model||!isWsdlOperation(operation)||!confirmed} onClick={run}>Verificar conexão</button><button className="secondary-button" type="button" disabled={locked||!confirmed} onClick={discard}>Descartar confirmação</button></div></>}
  </div>
  {recovering&&<div className="sefaz-recovery"><p>A mesma tentativa permanece preservada. Conferir o resultado não repete a consulta à SEFAZ.</p><button className="primary-button" type="button" disabled={busy||!canUse} onClick={()=>void execute('read')}>Conferir resultado</button></div>}
  {result&&<section className="sefaz-result" aria-live="polite"><h2>{WSDL_STATE_LABELS[result.status]}</h2>
   {result.receipt&&isWsdlOperation(result.receipt.operation)&&<p>{WSDL_OPERATIONS[result.receipt.operation]} · {result.receipt.model==='55'?'NF-e de produtos':'NFC-e'} · Homologação</p>}
   {result.status==='stored'?<><p>A descrição do serviço foi obtida e guardada em {fiscalMoment(result.artifact!.created_at)}.</p><p>{result.artifact!.inspection_status==='supported'?'A estrutura recebida foi reconhecida para análise.':'A estrutura recebida precisa de análise técnica antes de prosseguir.'}</p><p>Consulta obtida não significa homologação concluída, autorização para emitir notas ou integração fiscal validada.</p></>:<p>{result.status==='failed'?'A tentativa foi encerrada sem concluir a verificação.':'Ainda não há confirmação do resultado final. Isso não comprova que a consulta deixou de acontecer.'}</p>}
   {result.current&&(result.current.a1_changed||result.current.company_changed)&&<p className="real-alert">A empresa ou o certificado mudou depois desta tentativa. O resultado anterior permanece no histórico.</p>}
   {!recovering&&<div className="button-group"><button className="secondary-button" type="button" disabled={locked} onClick={consult}>Consultar esta tentativa</button>{newAllowed()&&<button className="secondary-button" type="button" disabled={locked} onClick={prepareNew}>Preparar nova verificação</button>}</div>}
  </section>}
 </section>;
}
