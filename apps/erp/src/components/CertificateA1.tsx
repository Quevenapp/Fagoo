import {useEffect,useRef,useState,type FormEvent} from 'react';
import {useUnsavedChanges} from '../hooks/useUnsavedChanges';
import {a1Company,a1Metadata,a1Command,configureBytes,checkedReason,wipeAttempt,A1_REJECTION_LABELS,type A1Controller,type A1Current,type A1Company,type A1Attempt} from '../lib/a1-model';
import './certificate-a1.css';

const aborted=(error:unknown)=>error instanceof DOMException&&error.name==='AbortError';
const status=(error:unknown)=>error&&typeof error==='object'&&'status'in error?Number(error.status):0;
const failureText=(error:unknown)=>status(error)===403?'Seu acesso a esta operação não está disponível. Você pode sair da tela; uma solicitação anterior pode já ter sido registrada.':status(error)===401?'Sua sessão precisa ser renovada. Saia e entre novamente para consultar o resultado.':'Não foi possível confirmar o resultado. Consulte o mesmo comando antes de repetir.';
const readFailureText=(error:unknown)=>{const code=error&&typeof error==='object'&&'code'in error&&typeof error.code==='string'?error.code:null;return [401,403].includes(status(error))?failureText(error):`Não foi possível consultar a configuração do certificado. Tente novamente.${code?` Código: ${code}.`:''}`;};
const date=(value:string)=>new Date(value).toLocaleString('pt-BR');
async function snapshot(controller:A1Controller,signal:AbortSignal){
 const company=a1Company(await controller.company('/v1/empresa/identidade',{signal}));
 const current=a1Metadata(await controller.a1('/v1/a1',{signal}));
 return{company,current};
}
export default function CertificateA1({controller,canManage}:{controller:A1Controller;canManage:boolean}){
 const [current,setCurrent]=useState<A1Current|null>(null),[company,setCompany]=useState<A1Company|null>(null),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false);
 const [file,setFile]=useState<File|null>(null),[password,setPassword]=useState(''),[reason,setReason]=useState(''),[confirmed,setConfirmed]=useState(false);
 const [disableReason,setDisableReason]=useState(''),[disableConfirmed,setDisableConfirmed]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [unresolved,setUnresolved]=useState(false),[attemptState,setAttemptState]=useState<A1Attempt['state']>('unknown'),[retryReady,setRetryReady]=useState(false),[discard,setDiscard]=useState(false),[reload,setReload]=useState(0);
 const attempt=useRef<A1Attempt|null>(null),request=useRef<AbortController|null>(null),fileInput=useRef<HTMLInputElement|null>(null),live=useRef(false),inFlight=useRef(false),allowed=useRef(canManage);
 allowed.current=canManage;
 const accept=(value:{company:A1Company|null;current:A1Current})=>{setCurrent(value.current);setCompany(value.company);};
 const clearForm=()=>{setFile(null);setPassword('');setReason('');setConfirmed(false);setDisableReason('');setDisableConfirmed(false);if(fileInput.current)fileInput.current.value='';};
 const publishAttempt=(value:A1Attempt)=>{setUnresolved(true);setAttemptState(value.state);setRetryReady(Date.now()>=value.retryAt);};
 useEffect(()=>{live.current=true;const pending=new AbortController();request.current=pending;setLoading(true);setError('');setCurrent(null);setCompany(null);
  void snapshot(controller,pending.signal).then(value=>{if(!pending.signal.aborted&&live.current){accept(value);setLoading(false);}}).catch(error=>{if(!pending.signal.aborted&&live.current&&!aborted(error)){setError(readFailureText(error));setLoading(false);}}).finally(()=>{if(request.current===pending)request.current=null;});
  return()=>{live.current=false;pending.abort();request.current?.abort();wipeAttempt(attempt.current);attempt.current=null;inFlight.current=false;};
 },[controller,reload]);
 useEffect(()=>{if(!unresolved||!attempt.current||retryReady)return;const timer=setTimeout(()=>setRetryReady(true),Math.max(0,attempt.current.retryAt-Date.now()));return()=>clearTimeout(timer);},[unresolved,attemptState,retryReady]);
 const dirty=Boolean(file||password||reason||confirmed||disableReason||disableConfirmed||unresolved);
 useUnsavedChanges(dirty,busy||unresolved);
 const finish=async(pending:AbortController,value:A1Attempt)=>{
  const latest=await snapshot(controller,pending.signal);if(pending.signal.aborted||!live.current||attempt.current!==value)return;
  accept(latest);const rejected=value.state==='rejected';wipeAttempt(value);attempt.current=null;setUnresolved(false);setRetryReady(false);clearForm();
  if(rejected){setError(A1_REJECTION_LABELS[value.errorCode||'']||'O arquivo foi rejeitado. Confira os dados antes de iniciar outra configuração.');setNotice('');}
  else{setError('');setNotice('Operação confirmada. O estado atual da custódia está exibido abaixo. A emissão de notas continua indisponível.');}
 };
 const run=async(send:boolean)=>{
  const value=attempt.current;if(!value||inFlight.current||!allowed.current)return;
  if(send&&(!value.body||value.state==='committed'||value.state==='rejected'||Date.now()<value.retryAt))return;
  const pending=new AbortController();request.current=pending;inFlight.current=true;setBusy(true);setError('');setNotice('');
  try{
   if(send){
    value.retryAt=Date.now()+65000;setRetryReady(false);
    const response=await controller.a1(`/v1/a1/${value.action}`,{method:'POST',body:value.body!,signal:pending.signal});
    if(pending.signal.aborted||!live.current||attempt.current!==value)return;
    const result=a1Command(response,value,true);value.state=result.state!;value.errorCode=result.error_code??null;wipeAttempt(value);publishAttempt(value);
   }else if(value.state!=='committed'&&value.state!=='rejected'){
    const result=a1Command(await controller.a1(`/v1/a1/commands/${value.id}`,{signal:pending.signal}),value);
    if(pending.signal.aborted||!live.current||attempt.current!==value)return;
    value.state=result.state!;value.errorCode=result.error_code??null;publishAttempt(value);
    if(value.state==='committed'||value.state==='rejected')wipeAttempt(value);
   }
   if(value.state==='committed'||value.state==='rejected')await finish(pending,value);
   else setNotice('O comando ainda está pendente. Consulte novamente; uma repetição usará somente a mesma solicitação.');
  }catch(error){if(!pending.signal.aborted&&live.current&&!aborted(error)){publishAttempt(value);setError(status(error)===404?'Este comando ainda não foi confirmado pelo serviço. A solicitação continua preservada; consulte novamente antes de repetir.':failureText(error));}}
  finally{if(request.current===pending)request.current=null;if(!pending.signal.aborted&&live.current){inFlight.current=false;setBusy(false);}}
 };
 const configure=async(event:FormEvent)=>{
  event.preventDefault();if(!canManage||inFlight.current||attempt.current||!current||!company||!file||!confirmed)return;
  if(file.size<=0||file.size>1048576){setError('Escolha um arquivo PFX ou P12 com até 1 MiB.');return;}
  const picked=file,secret=password,pending=new AbortController();request.current=pending;inFlight.current=true;setBusy(true);setError('');setNotice('');let bytes:Uint8Array|undefined,body:Uint8Array|undefined;
  try{
   checkedReason(reason);bytes=new Uint8Array(await picked.arrayBuffer());if(pending.signal.aborted||!live.current||!allowed.current)return;
   const id=crypto.randomUUID();body=configureBytes({id,current,company,why:reason,pfx:bytes,password:secret});
   attempt.current={id,action:'configure',expectedVersion:current.version,expectedIdentityVersion:company.version,holder:company.cnpj,body,state:'unknown',errorCode:null,retryAt:0};body=undefined;
   setFile(null);setPassword('');if(fileInput.current)fileInput.current.value='';publishAttempt(attempt.current);
  }catch{if(!pending.signal.aborted&&live.current)setError('Confira o arquivo, a senha e o motivo. A senha deve ter entre 1 e 1024 bytes e não pode conter quebra de linha.');}
  finally{bytes?.fill(0);body?.fill(0);if(request.current===pending)request.current=null;if(live.current&&!pending.signal.aborted){inFlight.current=false;setBusy(false);}}
  if(live.current&&!pending.signal.aborted&&attempt.current)void run(true);
 };
 const disable=(event:FormEvent)=>{
  event.preventDefault();if(!canManage||inFlight.current||attempt.current||!current?.credential_id||!disableConfirmed||file||password||reason||confirmed)return;
  try{const why=checkedReason(disableReason),id=crypto.randomUUID();attempt.current={id,action:'disable',expectedVersion:current.version,expectedIdentityVersion:null,holder:null,
   body:Object.freeze({command_id:id,expected_version:current.version,reason:why}),state:'unknown',errorCode:null,retryAt:0};publishAttempt(attempt.current);void run(true);}catch{setError('Informe o motivo da desativação, entre 3 e 240 caracteres.');}
 };
 const reset=()=>{if(inFlight.current||unresolved)return;clearForm();setDiscard(false);setNotice('');setReload(value=>value+1);};
 const resetPendingSecrets=()=>{if(busy||!attempt.current)return;wipeAttempt(attempt.current);clearForm();setDiscard(false);setNotice('Os dados secretos locais foram descartados. O comando continua consultável; sair da tela não desfaz uma gravação já realizada.');};
 const credentialsChanged=Boolean(current?.credential_id&&(current.company_changed||company&&current.company_identity_version!==company.version||company&&current.metadata?.holder_cnpj!==company.cnpj));
 const formBlocked=!canManage||busy||unresolved||!company||!current||Boolean(disableReason||disableConfirmed);
 return <section className="certificate-a1"><header className="real-heading"><div><h1>Certificado A1</h1><p>Configuração privada do certificado da empresa.</p></div><span className="real-mode">{canManage?'Administrador':'Consulta fiscal'}</span></header>
  <p className="real-notice">Esta etapa guarda e confere a credencial. Ela ainda não habilita a emissão ou o envio de notas fiscais.</p>
  {loading&&<p role="status">Consultando a empresa e a custódia…</p>}{error&&<p role="alert" className="real-alert">{error}</p>}{notice&&<p role="status" className="real-success">{notice}</p>}
  {!loading&&!current&&!unresolved&&<button className="secondary-button" type="button" onClick={()=>setReload(value=>value+1)}>Tentar consultar novamente</button>}
  {unresolved&&<section className="a1-recovery real-notice" aria-label="Resultado pendente"><h2>Confirmação da solicitação</h2><p>{busy?'Enviando ou consultando a mesma solicitação…':attemptState==='committed'?'A gravação foi confirmada. Falta consultar o estado atual.':attemptState==='rejected'?'A rejeição foi confirmada. Falta consultar o estado atual.':'O resultado ainda precisa ser confirmado. Os campos ficam congelados para evitar uma nova solicitação diferente.'}</p><p>Comando: <code>{attempt.current?.id}</code>. Sair não desfaz uma gravação já realizada.</p>
   <div className="real-editor-actions"><button type="button" className="primary-button" disabled={busy||!canManage} onClick={()=>void run(false)}>Consultar resultado</button>
    {attempt.current?.body&&['unknown','pending'].includes(attemptState)&&<button type="button" className="secondary-button" disabled={busy||!retryReady||!canManage} onClick={()=>void run(true)}>Reenviar a mesma solicitação</button>}
    {attempt.current?.body&&<button type="button" className="text-button" disabled={busy} onClick={()=>setDiscard(true)}>Descartar segredo local</button>}</div>
   {!retryReady&&attempt.current?.body&&<p className="real-help">A repetição é liberada após o intervalo de segurança da reserva. Você pode consultar o resultado agora.</p>}
  </section>}
  {!loading&&current&&!unresolved&&<section className="real-editor a1-current" aria-label="Estado atual da custódia"><h2>Estado atual</h2><p><strong>{current.state==='unconfigured'?'Ainda não configurado':current.state==='disabled'?'Credencial desativada':'Credencial armazenada para preparação offline'}</strong> · versão {current.version}</p>
   {company?<p>{company.legal_name}<br/>CNPJ: {company.cnpj} · cadastro versão {company.version}</p>:<p className="real-alert">Cadastre a identidade da empresa antes de configurar o certificado.</p>}
   {current.metadata&&<dl><div><dt>Titular conferido no certificado</dt><dd>{current.metadata.holder_cnpj}</dd></div><div><dt>Validade apresentada</dt><dd>{date(current.metadata.not_before)} a {date(current.metadata.not_after)}</dd></div><div><dt>Conferência do arquivo</dt><dd>{date(current.metadata.validated_at)}</dd></div><div><dt>Identificação SHA-256</dt><dd className="a1-fingerprint">{current.metadata.fingerprint_sha256}</dd></div></dl>}
   {credentialsChanged&&<p className="real-alert">O cadastro da empresa mudou desde a configuração desta credencial. É necessária uma nova conferência.</p>}
   {current.metadata&&!current.time_valid_now&&<p className="real-alert">A credencial armazenada está fora da validade apresentada.</p>}
   {current.metadata&&<p className="real-help">Titular, chave e período foram conferidos. A confiança ICP-Brasil, revogação e aceitação pela SEFAZ ainda não estão validadas.</p>}
  </section>}
  {canManage&&current&&!loading&&<><form className="real-editor a1-form" onSubmit={event=>void configure(event)} aria-busy={busy}><h2>{current.credential_id?'Substituir certificado':'Configurar certificado'}</h2><fieldset disabled={formBlocked}><legend className="real-sr-only">Arquivo e senha privados</legend>
   <div className="form-field"><label htmlFor="a1-file">Arquivo do certificado (.pfx ou .p12) *</label><input id="a1-file" ref={fileInput} type="file" accept=".pfx,.p12,application/x-pkcs12" onChange={event=>{setFile(event.target.files?.[0]??null);setConfirmed(false);setError('');}} required/></div>
   <div className="form-field"><label htmlFor="a1-password">Senha do certificado *</label><input id="a1-password" type="password" autoComplete="off" spellCheck={false} value={password} onChange={event=>{setPassword(event.target.value);setConfirmed(false);}} required maxLength={1024}/></div>
   <div className="form-field"><label htmlFor="a1-reason">Motivo da configuração *</label><input id="a1-reason" autoComplete="off" value={reason} onChange={event=>setReason(event.target.value)} required minLength={3} maxLength={240}/><small>Não inclua a senha neste campo.</small></div>
   <label className="a1-confirm"><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/>Conferi a empresa e autorizo a guarda cifrada deste certificado. Esta etapa não emite notas.</label>
   <button className="primary-button" disabled={!file||!password||!confirmed}>Guardar e conferir certificado</button>
  </fieldset><p className="real-help">O arquivo e a senha são enviados pelo canal seguro e guardados de forma cifrada no servidor. Dados locais são descartados ao sair da tela; acompanhe a confirmação antes de sair. Não envie a senha por mensagens.</p></form>
  {current.credential_id&&<form className="real-editor a1-form" onSubmit={disable}><h2>Desativar credencial</h2><p>A desativação retira a seleção no FAGOO; não revoga o certificado na autoridade certificadora.</p><fieldset disabled={busy||unresolved||Boolean(file||password||reason||confirmed)}><legend className="real-sr-only">Desativação</legend>
   <div className="form-field"><label htmlFor="a1-disable-reason">Motivo da desativação *</label><input id="a1-disable-reason" value={disableReason} onChange={event=>setDisableReason(event.target.value)} required minLength={3} maxLength={240}/></div>
   <label className="a1-confirm"><input type="checkbox" checked={disableConfirmed} onChange={event=>setDisableConfirmed(event.target.checked)}/>Confirmo a desativação da credencial selecionada.</label><button className="secondary-button" disabled={!disableConfirmed}>Desativar credencial</button>
  </fieldset></form>}</>}
  {discard?<section className="real-alert" aria-label="Descartar dados locais"><p>{unresolved?'Descartar arquivo e senha locais? O comando continuará pendente de consulta; não será possível reenviar seus bytes sem uma nova entrada do titular.':'Descartar os dados não enviados e consultar novamente?'}</p><div className="real-editor-actions"><button type="button" className="secondary-button" disabled={busy} onClick={()=>setDiscard(false)}>Continuar na tela</button><button type="button" className="primary-button" disabled={busy} onClick={unresolved?resetPendingSecrets:reset}>Confirmar descarte local</button></div></section>:!unresolved&&<button className="secondary-button" type="button" disabled={busy||loading} onClick={()=>dirty?setDiscard(true):reset()}>Recarregar e conferir</button>}
 </section>;
}
