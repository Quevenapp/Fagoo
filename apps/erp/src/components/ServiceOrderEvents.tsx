import {useEffect,useLayoutEffect,useRef,useState,type FormEvent} from 'react';
import {AccessError,decimalMoney} from '../lib/real-access';
import {attachmentPath,attachmentSize} from '../lib/attachment-model';
import {useUnsavedChanges} from '../hooks/useUnsavedChanges';
import {EVENT_LABELS,EVENT_TYPES,DECLARANT_LABELS,CHANNEL_LABELS,emptyEventForm,eventFormData,correctionForm,serviceEventAttachments,serviceEventEnvelope,serviceEventPage,serviceEventsPath,sameServiceEvent,serviceEventTime,serviceEventDay,serviceEventToday,type ServiceEventsController,type ServiceEventCommand,type ServiceEventForm,type ServiceEventAttachment,type ServiceEventPage,type ServiceEventRecord,type ServiceEventRow,type EventFormErrors} from '../lib/service-events-model';
import './service-order-events.css';

export interface ServiceOrderEventsProps {controller:ServiceEventsController;document:{id:string;version:number};blocked?:boolean;onBusy?:(value:boolean)=>void;onDraft?:(value:boolean)=>void;onChanged?:()=>void}
interface Attempt {documentId:string;actorId:string;command:ServiceEventCommand;saved:ServiceEventRecord|null;uncertain:boolean}
const READ_ROLES=['admin','vendas','financeiro','consulta'],WRITE_ROLES=['admin','vendas'];
const EMPTY=JSON.stringify(emptyEventForm());
const message=(e:unknown)=>e instanceof AccessError&&e.status===409?'A OS ou o registro mudou. Atualize a consulta e confira a versão antes de registrar.':e instanceof AccessError&&e.status===403?'Seu perfil não permite registrar ou consultar estes eventos.':e instanceof AccessError&&e.status===404?'A OS, o evento ou o anexo não está disponível. Atualize a consulta.':e instanceof AccessError&&e.status===400?'Confira os campos e a data antes de registrar.':'Não foi possível concluir a consulta. Tente novamente.';
export default function ServiceOrderEvents({controller,document:documentProp,blocked=false,onBusy,onDraft,onChanged}:ServiceOrderEventsProps){
 const [page,setPage]=useState<ServiceEventPage|null>(null),[form,setForm]=useState(emptyEventForm),[correction,setCorrection]=useState<ServiceEventRecord|null>(null);
 const [attachments,setAttachments]=useState<ServiceEventAttachment[]>([]),[attachmentLoading,setAttachmentLoading]=useState(true),[attachmentError,setAttachmentError]=useState(''),[attachmentTick,setAttachmentTick]=useState(0);
 const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[unresolved,setUnresolved]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[errors,setErrors]=useState<EventFormErrors>({});
 const [before,setBefore]=useState<string|null>(null),[history,setHistory]=useState<(string|null)[]>([]),[tick,setTick]=useState(0);
 const pending=useRef<AbortController|null>(null),listRequest=useRef<AbortController|null>(null),attachmentRequest=useRef<AbortController|null>(null),attempt=useRef<Attempt|null>(null),generation=useRef(0),scope=useRef('');
 const formNode=useRef<HTMLFormElement>(null),callbacks=useRef({onBusy,onDraft,onChanged}),live=useRef({id:documentProp.id,version:documentProp.version,blocked});
 callbacks.current={onBusy,onDraft,onChanged};live.current={id:documentProp.id,version:documentProp.version,blocked};
 const auth=controller.getSnapshot(),membership=auth.phase==='ready'?auth.membership:null,actor=membership?.user_id??'',role=membership?.role??'';
 const readable=Boolean(actor&&READ_ROLES.includes(role)),writable=Boolean(actor&&WRITE_ROLES.includes(role)),scopeKey=`${documentProp.id}:${actor}`;
 const dirty=correction!==null||JSON.stringify(form)!==EMPTY,locked=busy||unresolved;
 useUnsavedChanges(dirty,locked);
 useLayoutEffect(()=>{callbacks.current.onDraft?.(dirty);callbacks.current.onBusy?.(locked);},[dirty,locked]);
 useLayoutEffect(()=>()=>{callbacks.current.onDraft?.(false);callbacks.current.onBusy?.(false);},[]);
 useEffect(()=>()=>{pending.current?.abort();listRequest.current?.abort();attachmentRequest.current?.abort();generation.current++;},[]);
 const session=(expectedActor=actor,write=false)=>{const s=controller.getSnapshot();return s.phase==='ready'&&s.membership?.user_id===expectedActor&&(write?WRITE_ROLES:READ_ROLES).includes(s.membership.role);};
 const active=(request:AbortController,id=documentProp.id,expectedActor=actor)=>!request.signal.aborted&&live.current.id===id&&session(expectedActor);
 const readPage=async(id:string,signal:AbortSignal,cursor:string|null)=>serviceEventPage(await controller.serviceEvents(`${serviceEventsPath(id)}?limit=25${cursor?`&before=${cursor}`:''}`,{signal}),id,cursor);
 useEffect(()=>{
  const changed=scope.current!==scopeKey;
  if(changed){pending.current?.abort();pending.current=null;attempt.current=null;scope.current=scopeKey;setForm(emptyEventForm());setCorrection(null);setUnresolved(false);setBusy(false);setBefore(null);setHistory([]);setError('');setNotice('');setErrors({});setAttachments([]);}
  const request=new AbortController(),current=++generation.current;listRequest.current?.abort();listRequest.current=request;setPage(null);setLoading(readable);
  if(!readable)return()=>request.abort();
  void readPage(documentProp.id,request.signal,changed?null:before).then(value=>{if(active(request)&&generation.current===current){setPage(value);setLoading(false);}}).catch(failure=>{if(active(request)&&generation.current===current){setError(message(failure));setLoading(false);}});
  return()=>request.abort();
 },[controller,scopeKey,role,documentProp.version,before,tick]);
 useEffect(()=>{
  const request=new AbortController();attachmentRequest.current?.abort();attachmentRequest.current=request;setAttachments([]);setAttachmentError('');setAttachmentLoading(readable);
  if(!readable)return()=>request.abort();
  void controller.attachments(attachmentPath('service_orders',documentProp.id),{signal:request.signal}).then(value=>{if(active(request)){setAttachments(serviceEventAttachments(value,documentProp.id));setAttachmentLoading(false);}}).catch(()=>{if(active(request)){setAttachmentError('Não foi possível consultar os anexos. Você pode atualizar a lista ou escolher explicitamente registrar sem anexo.');setAttachmentLoading(false);}});
  return()=>request.abort();
 },[controller,scopeKey,role,attachmentTick]);
 useEffect(()=>{if(!attempt.current){setForm(value=>({...value,confirmed:false}));setErrors({});}},[documentProp.version]);
 const current=page?.document.id===documentProp.id?page:null,stale=Boolean(current&&current.document.version!==documentProp.version);
 const canWrite=writable&&current?.can_record===true&&!stale&&!loading;
 const formEnabled=canWrite&&!blocked&&!locked;
 const latest=useRef({canWrite,dirty,loading,attachmentLoading,form,correction,attachments,current});latest.current={canWrite,dirty,loading,attachmentLoading,form,correction,attachments,current};
 const mayEdit=()=>!attempt.current&&!pending.current&&!live.current.blocked&&session(actor,true)&&live.current.id===documentProp.id&&live.current.version===documentProp.version&&latest.current.canWrite;
 const update=<K extends keyof ServiceEventForm>(key:K,value:ServiceEventForm[K])=>{
  if(!mayEdit())return;setForm(previous=>key==='type'?{...previous,type:value as ServiceEventForm['type'],accessories:'',apparent_condition:'',decision:'',channel:'',delivered_condition:'',tests_summary:'',confirmed:false}:{...previous,[key]:value,...(key==='confirmed'?{}:{confirmed:false})});setErrors(previous=>({...previous,[key]:undefined,confirmed:undefined}));setNotice('');
 };
 const clear=()=>{if(attempt.current||pending.current||live.current.blocked)return;setForm(emptyEventForm());setCorrection(null);setErrors({});setError('');setNotice('');};
 const recover=async()=>{
  const operation=attempt.current;if(!operation||pending.current||live.current.blocked||live.current.id!==operation.documentId||!session(operation.actorId,operation.saved===null))return;
  const request=new AbortController();pending.current=request;listRequest.current?.abort();generation.current++;setBusy(true);setError('');setNotice('');
  try{
   if(!operation.saved){const value=await controller.serviceEvents(serviceEventsPath(operation.documentId),{method:'POST',body:operation.command,signal:request.signal});if(!active(request,operation.documentId,operation.actorId))return;
    operation.saved=serviceEventEnvelope(value,operation.documentId,{command:operation.command,actorId:operation.actorId}).record;operation.uncertain=false;}
   const value=await controller.serviceEvents(serviceEventsPath(operation.documentId,operation.saved.id),{signal:request.signal});if(!active(request,operation.documentId,operation.actorId))return;
   const latest=serviceEventEnvelope(value,operation.documentId,{eventId:operation.saved.id});if(!sameServiceEvent(latest.record,operation.saved))throw new AccessError(502);
   const list=await readPage(operation.documentId,request.signal,null);if(!active(request,operation.documentId,operation.actorId))return;
   listRequest.current?.abort();generation.current++;attempt.current=null;setUnresolved(false);setPage(list);setBefore(null);setHistory([]);setLoading(false);setForm(emptyEventForm());setCorrection(null);setErrors({});
   setNotice(`Registro ${latest.record.sequence} confirmado e consultado. A situação da OS, o financeiro e o estoque permanecem sem alteração por este registro.`);callbacks.current.onChanged?.();
  }catch(failure){if(active(request,operation.documentId,operation.actorId)){
   const definitive=!operation.saved&&!operation.uncertain&&failure instanceof AccessError&&[400,401,403,404,409].includes(failure.status);
   if(definitive){attempt.current=null;setUnresolved(false);setError(message(failure));setForm(value=>({...value,confirmed:false}));setTick(value=>value+1);}
   else{operation.uncertain=true;setError(operation.saved?'O registro foi confirmado, mas a consulta atual não terminou. Consulte novamente; nenhum novo registro será enviado.':'O registro pode ter sido salvo. Mantenha os dados e repita a mesma confirmação para recuperar o resultado.');}
  }}finally{if(!request.signal.aborted){pending.current=null;setBusy(false);}}
 };
 const submit=(event:FormEvent)=>{
  event.preventDefault();const state=latest.current;if(!mayEdit()||!state.current||!state.form.type||!state.current.allowed_event_types.includes(state.form.type))return;
  const result=eventFormData(state.form,state.correction,state.attachments);setErrors(result.errors);
  if(!result.data){const first=Object.keys(result.errors)[0];formNode.current?.querySelector<HTMLElement>(`#service-event-${first}`)?.focus();return;}
  attempt.current={documentId:documentProp.id,actorId:actor,command:{command_id:crypto.randomUUID(),expected_document_version:documentProp.version,data:result.data},saved:null,uncertain:false};setUnresolved(true);void recover();
 };
 const prepareCorrection=async(row:ServiceEventRow)=>{
  if(!mayEdit()||latest.current.dirty||row.current.corrected_by_event_id||!latest.current.current?.allowed_event_types.includes(row.record.type))return;
  const request=new AbortController();pending.current=request;setBusy(true);setError('');setNotice('');
  try{const result=serviceEventEnvelope(await controller.serviceEvents(serviceEventsPath(documentProp.id,row.record.id),{signal:request.signal}),documentProp.id,{eventId:row.record.id});if(!active(request))return;
   if(!sameServiceEvent(result.record,row.record)||result.current.corrected_by_event_id||!result.can_record||result.document.version!==live.current.version||!result.allowed_event_types.includes(result.record.type))throw new AccessError(409);
   setCorrection(result.record);setForm(correctionForm(result.record,attachments));setErrors({});setNotice(`Preparando um novo registro que corrige o registro ${result.record.sequence}. Confira todos os dados e informe o motivo; o original será preservado.`);
  }catch(failure){if(active(request))setError(message(failure));}finally{if(!request.signal.aborted){pending.current=null;setBusy(false);}}
 };
 const refresh=()=>{if(attempt.current||pending.current||latest.current.loading)return;setBefore(null);setHistory([]);setError('');setTick(value=>value+1);};
 const changePage=(older:boolean)=>{if(attempt.current||pending.current||latest.current.loading)return;if(older&&current?.has_more){setHistory(value=>[...value,before]);setBefore(current.next_before);}else if(!older&&history.length){setBefore(history.at(-1)??null);setHistory(value=>value.slice(0,-1));}};
 const refreshAttachments=()=>{if(attempt.current||pending.current||latest.current.attachmentLoading||live.current.blocked)return;setForm(value=>({...value,confirmed:false}));setAttachmentTick(value=>value+1);};
 const errorFor=(key:keyof ServiceEventForm)=>errors[key]?<small id={`service-event-${key}-error`} className="service-event-field-error">{errors[key]}</small>:null;
 const fieldProps=(key:keyof ServiceEventForm)=>({id:`service-event-${key}`,'aria-invalid':Boolean(errors[key]),'aria-describedby':errors[key]?`service-event-${key}-error`:undefined});
 const textarea=(key:'accessories'|'apparent_condition'|'delivered_condition'|'tests_summary'|'notes'|'correction_reason',label:string,help?:string)=><div className="form-field service-event-wide"><label htmlFor={`service-event-${key}`}>{label}</label><textarea {...fieldProps(key)} rows={3} maxLength={key==='notes'?4000:2000} value={form[key]} onChange={e=>update(key,e.target.value)}/>{help&&<small>{help}</small>}{errorFor(key)}</div>;
 const display=(row:ServiceEventRow)=>{
  const r=row.record,c=row.current,d=r.details;
  return <li key={r.id}><header><strong>{EVENT_LABELS[r.type]} · registro {r.sequence}</strong><time dateTime={r.recorded_at}>Registrado em {serviceEventTime(r.recorded_at)}</time></header>
   <p><strong>{r.declarant_name}</strong> · {DECLARANT_LABELS[r.declarant_role]} · fato declarado em {serviceEventDay(r.occurred_on)}</p>
   <dl className="service-event-facts"><div><dt>OS capturada</dt><dd>{r.snapshot.number} · versão {r.document_version}</dd></div><div><dt>Total capturado</dt><dd>{decimalMoney(r.total)}</dd></div><div><dt>Cliente na OS</dt><dd>{r.snapshot.contact.name}</dd></div><div><dt>Equipamento</dt><dd>{r.snapshot.equipment??'Não informado'}</dd></div></dl>
   {'apparent_condition'in d&&<><p><strong>Condição aparente:</strong> {d.apparent_condition}</p><p><strong>Acessórios:</strong> {d.accessories??'Não informado'}</p></>}
   {'decision'in d&&<p><strong>Decisão declarada:</strong> {d.decision==='approved'?'Aprovação do valor integral':'Recusa'} · {CHANNEL_LABELS[d.channel]}</p>}
   {'delivered_condition'in d&&<><p><strong>Condição na entrega:</strong> {d.delivered_condition}</p><p><strong>Testes relatados:</strong> {d.tests_summary??'Não informado'}</p></>}
   {r.notes&&<p><strong>Observações:</strong> {r.notes}</p>}
   {r.corrects_event_id&&<p className="real-notice">Correção de registro anterior. Motivo: {r.correction_reason}</p>}
   {c.corrected_by_event_id&&<p className="real-notice">Este registro tem uma correção posterior. O conteúdo original permanece no histórico.</p>}
   {c.document_version_changed&&<p className="real-help">Captura histórica: a OS está na versão {c.document_version}.{c.commercial_content_changed?' O conteúdo comercial mudou.':''}{c.total_changed?' O total atual é diferente do capturado.':''}</p>}
   {'decision'in d&&d.decision==='approved'&&<p className="real-help">{c.approval_basis_matches_current?'Esta declaração corresponde à versão e ao valor atuais da OS.':'Esta declaração não representa uma aprovação corrente da versão atual.'} O registro não comprova assinatura ou consentimento.</p>}
   {r.attachment&&<details><summary>Anexo registrado: {r.attachment.filename}</summary><p>{r.attachment.mime_type} · {attachmentSize(r.attachment.size_bytes)}</p><p className="service-event-hash">SHA-256: {r.attachment.sha256}</p><small>Metadados capturados no registro. Consulte os arquivos na seção Anexos da OS.</small></details>}
   <details><summary>Dados da captura</summary><dl className="service-event-facts"><div><dt>Série do equipamento</dt><dd>{r.snapshot.serial_number??'Não informado'}</dd></div><div><dt>Técnico na OS</dt><dd>{r.snapshot.technician??'Não informado'}</dd></div><div><dt>Registrado por</dt><dd>{r.actor_id===actor?'Você':'Outro usuário da empresa'}</dd></div></dl><small>O usuário que registra e a pessoa que declarou são informações distintas.</small></details>
   {canWrite&&current?.allowed_event_types.includes(r.type)&&!c.corrected_by_event_id&&<button type="button" className="text-button" disabled={locked||blocked||dirty} onClick={()=>void prepareCorrection(row)}>Preparar correção do registro {r.sequence}</button>}
  </li>;
 };
 if(!readable)return <section className="service-events document-section"><h3>Recepção, decisão e entrega</h3><p>Seu acesso a estes registros não está disponível.</p></section>;
 return <section className="service-events document-section" aria-labelledby="service-events-title"><h3 id="service-events-title">Recepção, decisão e entrega</h3>
  <p className="real-help">Registre o que foi declarado sobre a OS. Cada registro guarda a versão e o valor conferidos, sem alterar situação, financeiro ou estoque. Não substitui assinatura ou comprovação de consentimento.</p>
  {error&&<p className="real-alert" role="alert">{error}</p>}{notice&&<p className="real-success" role="status">{notice}</p>}
  {stale&&<p className="real-notice">A versão aberta da OS está desatualizada. Preserve ou descarte seu rascunho e recarregue o documento antes de registrar.</p>}
  {writable&&current?.document.status==='cancelled'&&<p className="real-notice">OS cancelada: os registros permanecem somente para consulta.</p>}
  {writable&&<form ref={formNode} onSubmit={submit} noValidate>
   {current&&<div className="service-event-basis"><strong>OS {current.document.number} · versão {current.document.version}</strong><span>Total integral: {decimalMoney(current.document.total)}</span><small>Esta é a base que será capturada pelo servidor.</small></div>}
   {correction&&<p className="real-notice">Novo registro para corrigir o registro {correction.sequence} ({EVENT_LABELS[correction.type]}). A versão atual da OS será conferida novamente.</p>}
   <fieldset disabled={!formEnabled}><legend>{correction?'Conferir correção':'Nova declaração'}</legend><div className="service-event-grid">
    <div className="form-field"><label htmlFor="service-event-type">Tipo de registro</label><select {...fieldProps('type')} value={form.type} disabled={Boolean(correction)||!formEnabled} onChange={e=>update('type',e.target.value as ServiceEventForm['type'])}><option value="">Selecione</option>{EVENT_TYPES.map(type=><option key={type} value={type} disabled={!current?.allowed_event_types.includes(type)}>{EVENT_LABELS[type]}</option>)}</select>{errorFor('type')}<small>Os tipos disponíveis dependem da situação atual da OS.</small></div>
    <div className="form-field"><label htmlFor="service-event-occurred_on">Data do fato declarado</label><input {...fieldProps('occurred_on')} type="date" min="1900-01-01" max={serviceEventToday()} value={form.occurred_on} onChange={e=>update('occurred_on',e.target.value)}/>{errorFor('occurred_on')}<small>O horário do registro é gravado separadamente.</small></div>
    <div className="form-field"><label htmlFor="service-event-declarant_name">Nome de quem declarou</label><input {...fieldProps('declarant_name')} maxLength={400} value={form.declarant_name} onChange={e=>update('declarant_name',e.target.value)}/>{errorFor('declarant_name')}</div>
    <div className="form-field"><label htmlFor="service-event-declarant_role">Vínculo da pessoa</label><select {...fieldProps('declarant_role')} value={form.declarant_role} onChange={e=>update('declarant_role',e.target.value as ServiceEventForm['declarant_role'])}><option value="">Selecione</option>{Object.entries(DECLARANT_LABELS).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select>{errorFor('declarant_role')}</div>
    {form.type==='reception'&&<>{textarea('apparent_condition','Condição aparente do equipamento','Relate a condição observada, até 1.000 caracteres.')}{textarea('accessories','Acessórios informados (opcional)','Em branco significa não informado.')}</>}
    {form.type==='customer_decision'&&<><div className="form-field"><label htmlFor="service-event-decision">Decisão comunicada</label><select {...fieldProps('decision')} value={form.decision} onChange={e=>update('decision',e.target.value as ServiceEventForm['decision'])}><option value="">Selecione</option><option value="approved">Aprovação do valor integral</option><option value="rejected">Recusa</option></select>{errorFor('decision')}<small>Para negociar valor ou escopo, revise a OS primeiro.</small></div><div className="form-field"><label htmlFor="service-event-channel">Meio da comunicação</label><select {...fieldProps('channel')} value={form.channel} onChange={e=>update('channel',e.target.value as ServiceEventForm['channel'])}><option value="">Selecione</option>{Object.entries(CHANNEL_LABELS).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select>{errorFor('channel')}</div></>}
    {form.type==='delivery'&&<>{textarea('delivered_condition','Condição declarada na entrega')}{textarea('tests_summary','Testes relatados (opcional)','Em branco não atesta execução ou aprovação de testes.')}</>}
    {textarea('notes','Observações (opcional)','Até 2.000 caracteres.')}
    <div className="form-field service-event-wide"><label htmlFor="service-event-attachment_choice">Anexo deste registro</label><select {...fieldProps('attachment_choice')} value={form.attachment_choice} onChange={e=>update('attachment_choice',e.target.value)}><option value="">Selecione</option><option value="none">Registrar sem anexo</option>{attachments.map(a=><option key={a.id} value={a.id}>{a.filename} · {attachmentSize(a.size_bytes)}</option>)}</select>{errorFor('attachment_choice')}<small>Somente arquivos já disponíveis nos anexos desta OS. Nenhum arquivo é enviado por este formulário.</small>{attachmentLoading&&<small role="status">Consultando anexos…</small>}{attachmentError&&<small role="status">{attachmentError}</small>}<button type="button" className="text-button" disabled={attachmentLoading||locked||blocked} onClick={refreshAttachments}>Atualizar anexos disponíveis</button></div>
    {correction&&textarea('correction_reason','Motivo da correção','De 3 a 1.000 caracteres. O registro original permanecerá consultável.')}
    <div className="service-event-confirm service-event-wide"><label htmlFor="service-event-confirmed"><input {...fieldProps('confirmed')} type="checkbox" checked={form.confirmed} onChange={e=>update('confirmed',e.target.checked)}/>Conferi os dados declarados e a versão {current?.document.version??'—'} da OS, no valor integral de {current?decimalMoney(current.document.total):'—'}. Entendo que o registro não comprova assinatura ou consentimento.</label>{errorFor('confirmed')}</div>
   </div></fieldset>
   <div className="real-editor-actions"><button type="submit" className="primary-button" disabled={!formEnabled||!form.type||!current?.allowed_event_types.includes(form.type)}>Registrar declaração</button><button type="button" className="secondary-button" disabled={locked||blocked||!dirty} onClick={clear}>{correction?'Descartar correção local':'Limpar formulário'}</button></div>
  </form>}
  {unresolved&&<div className="service-event-recovery" role="status"><p>{busy?'Conferindo o registro. Aguarde a confirmação e a consulta do resultado.':attempt.current?.saved?'O registro já foi confirmado. A recuperação consultará o resultado atual, sem novo POST.':'Os campos e o identificador da confirmação foram preservados. A recuperação repetirá exatamente o mesmo registro.'}</p>{!busy&&<button type="button" className="primary-button" disabled={blocked||!session(attempt.current?.actorId,attempt.current?.saved===null)} onClick={()=>void recover()}>{attempt.current?.saved?'Consultar registro confirmado':'Repetir a mesma confirmação'}</button>}</div>}
  <div className="service-event-toolbar"><strong>Histórico · mais recentes primeiro</strong><button type="button" className="text-button" disabled={loading||locked} onClick={refresh}>Atualizar eventos</button></div>
  {loading?<p role="status">Consultando registros da OS…</p>:current?<>{current.items.length?<ol className="service-event-list">{current.items.map(display)}</ol>:<p>Nenhum registro nesta página.</p>}<div className="real-pagination"><span>Página {history.length+1}</span><button type="button" className="text-button" disabled={locked||!history.length} onClick={()=>changePage(false)}>Mais recentes</button><button type="button" className="text-button" disabled={locked||!current.has_more} onClick={()=>changePage(true)}>Mais antigos</button></div></>:<p>Atualize a consulta para ver os registros.</p>}
 </section>;
}
