import {useEffect,useRef,useState,type FormEvent} from 'react';
import {AccessError} from '../lib/real-access';
import {useUnsavedChanges,useUnsavedChangesGuard} from '../hooks/useUnsavedChanges';
import {NUMBERING_BASE,NUMBERING_MODELS,numberingCompany,numberingPage,numberingMatchesCompany,numberingListPath,numberingLookup,numberingInitialForm,numberingConfigBody,numberingConfigCommand,type FiscalNumberingController,type NumberingCompany,type NumberingSeries,type NumberingModel,type NumberingForm,type NumberingPage,type NumberingConfigBody} from '../lib/fiscal-numbering-model';
import './fiscal-numbering.css';

const aborted=(e:unknown)=>e instanceof DOMException&&e.name==='AbortError';
const failure=(e:unknown)=>e instanceof AccessError&&e.status===403?'Seu perfil não permite esta operação.':e instanceof AccessError&&e.status===409?'A empresa ou a série mudou, ou esta série já existe. Recarregue e confira antes de continuar.':e instanceof AccessError&&e.status===404?'A série não está disponível para esta empresa.':'Não foi possível confirmar os dados. Tente novamente.';
const moment=(v:string)=>new Intl.DateTimeFormat('pt-BR',{dateStyle:'short',timeStyle:'short',timeZone:'America/Sao_Paulo'}).format(new Date(v));
const stateLabel=(row:NumberingSeries)=>row.exhausted?'Numeração esgotada':row.company_changed?'Revisão da empresa pendente':row.enabled?'Habilitada':'Desativada';
type Selection=Pick<NumberingSeries,'id'|'model'>;

export default function RealFiscalNumbering({controller,canManage=false,onBack}:{controller:FiscalNumberingController;canManage?:boolean;onBack?:()=>void}){
 const guard=useUnsavedChangesGuard(),[model,setModel]=useState<''|NumberingModel>(''),[after,setAfter]=useState<string|null>(null),[history,setHistory]=useState<(string|null)[]>([]);
 const [company,setCompany]=useState<NumberingCompany|null>(null),[page,setPage]=useState<NumberingPage|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[reload,setReload]=useState(0),[notice,setNotice]=useState('');
 const [editor,setEditor]=useState<Selection|null|undefined>(undefined);
 useEffect(()=>{
  const request=new AbortController();setPage(null);setCompany(null);setError('');setLoading(editor===undefined);
  if(editor===undefined)void(async()=>{
   const identity=numberingCompany(await controller.company('/v1/empresa/identidade',{signal:request.signal}));if(request.signal.aborted)return;
   if(!identity||identity.state!=='SP'){setCompany(identity);return;}
   const value=numberingPage(await controller.fiscalNumbering(numberingListPath(model,after),{signal:request.signal}),model,after);if(request.signal.aborted)return;
   for(const row of value.items)numberingMatchesCompany(row,identity);setCompany(identity);setPage(value);
  })().catch(e=>{if(!request.signal.aborted&&!aborted(e))setError(failure(e));}).finally(()=>{if(!request.signal.aborted)setLoading(false);});
  return()=>request.abort();
 },[controller,model,after,editor,reload]);
 const close=()=>{setEditor(undefined);setReload(v=>v+1);};
 return<section className="fiscal-numbering-page">
  <header className="real-heading"><div><h1>Numeração fiscal</h1><p>Séries da empresa para preparação de NF-e e NFC-e.</p></div><span className="real-mode">Somente homologação</span></header>
  <p className="real-notice">Configure cada série após conferir seu uso com os demais emissores. Esta tela não reserva números nem emite notas.</p>
  {editor!==undefined?<NumberingSeriesEditor controller={controller} selected={editor} canManage={canManage} onClose={close} onSaved={()=>{setNotice('Configuração salva e dados atuais conferidos.');close();}}/>:<>
   <div className="numbering-toolbar"><div className="form-field"><label htmlFor="numbering-filter-model">Modelo</label><select id="numbering-filter-model" value={model} onChange={e=>{setModel(e.target.value as ''|NumberingModel);setAfter(null);setHistory([]);setNotice('');}}><option value="">NF-e e NFC-e</option>{Object.entries(NUMBERING_MODELS).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></div><div className="button-group">
    <button type="button" className="secondary-button" disabled={loading} onClick={()=>setReload(v=>v+1)}>Atualizar consulta</button>
    {canManage&&<button type="button" className="primary-button" disabled={loading||Boolean(error)||!company||company.state!=='SP'} onClick={()=>{setNotice('');setEditor(null);}}>Incluir série</button>}
    {onBack&&<button type="button" className="secondary-button" onClick={()=>guard.confirmLeave(onBack)}>Voltar</button>}
   </div></div>
   {notice&&<p role="status" className="real-notice">{notice}</p>}{loading&&<p role="status">Consultando empresa e séries…</p>}{error&&<p className="real-alert" role="alert">{error}</p>}
   {!loading&&!error&&!company&&<p className="empty-state">Cadastre a identidade da empresa em Dados da empresa para configurar a numeração.</p>}
   {company&&<p className="numbering-company"><strong>{company.legal_name}</strong><span>CNPJ {company.cnpj} · {company.state}</span></p>}
   {!loading&&company&&company.state!=='SP'&&<p className="real-notice">Esta preparação está disponível apenas para empresa de São Paulo.</p>}
   {page&&<section className="real-records" aria-label="Séries de homologação"><div className="table-toolbar"><h2>Séries de homologação</h2><span role="status">{page.items.length} nesta página</span></div>
    <div className="table-scroll numbering-table" role="region" tabIndex={0} aria-label="Tabela de séries de homologação; role horizontalmente quando necessário"><table className="data-table"><caption>Numeração registrada no FAGOO. A conferência com outros emissores é necessária.</caption><thead><tr><th>Modelo</th><th>Série</th><th>Primeiro número</th><th>Próximo número</th><th>Situação</th><th>Conferência</th><th>{canManage?'Revisar':'Detalhes'}</th></tr></thead><tbody>{page.items.map(row=><tr key={row.id}><td>{row.model==='55'?'NF-e':'NFC-e'}</td><th scope="row">{row.series}</th><td className="numeric">{row.first_number}</td><td className="numeric">{row.next_number??'Esgotada'}</td><td><span className={`status-badge ${row.company_changed||row.exhausted?'status-warning':row.enabled?'status-success':'status-neutral'}`}>{stateLabel(row)}</span></td><td><span>{row.exclusive_use_confirmed?'Uso exclusivo registrado':'Uso exclusivo não confirmado'}</span><small>{moment(row.updated_at)}</small></td><td>{canManage?<button type="button" className="text-button" onClick={()=>{setNotice('');setEditor({id:row.id,model:row.model});}} aria-label={`Revisar série ${row.series} de ${row.model==='55'?'NF-e':'NFC-e'}`}>Revisar</button>:<SeriesDetails row={row}/>}</td></tr>)}</tbody></table></div>
    {!page.items.length&&<p className="empty-state">Nenhuma série cadastrada para este filtro.</p>}
    <div className="table-footer"><span>Página {history.length+1} · até 25 séries</span><div className="button-group"><button type="button" className="secondary-button" disabled={loading||!history.length} onClick={()=>{setAfter(history.at(-1)??null);setHistory(v=>v.slice(0,-1));}}>Anterior</button><button type="button" className="secondary-button" disabled={loading||!page.has_more} onClick={()=>{setHistory(v=>[...v,after]);setAfter(page.next_cursor);}}>Próxima</button></div></div>
   </section>}
   {!canManage&&<p className="real-help">Seu perfil permite consultar as séries. A configuração é exclusiva do administrador.</p>}
  </>}
 </section>;
}
function SeriesDetails({row}:{row:NumberingSeries}){return<details className="numbering-details"><summary>Detalhes da conferência</summary><p>{row.reference}</p><dl><div><dt>Versão da série</dt><dd>{row.version}</dd></div><div><dt>Identidade conferida</dt><dd>Versão {row.identity_version}</dd></div><div><dt>Criada em</dt><dd>{moment(row.created_at)}</dd></div><div><dt>Ambiente</dt><dd>Homologação</dd></div></dl></details>;}

function NumberingSeriesEditor({controller,selected,canManage,onClose,onSaved}:{controller:FiscalNumberingController;selected:Selection|null;canManage:boolean;onClose:()=>void;onSaved:()=>void}){
 const guard=useUnsavedChangesGuard(),[current,setCurrent]=useState<NumberingSeries|null>(null),[company,setCompany]=useState<NumberingCompany|null>(null),[form,setForm]=useState<NumberingForm>(()=>numberingInitialForm(null)),[baseline,setBaseline]=useState(()=>JSON.stringify(numberingInitialForm(null)));
 const [loading,setLoading]=useState(true),[ready,setReady]=useState(false),[reload,setReload]=useState(0),[busy,setBusy]=useState(false),[unresolved,setUnresolved]=useState(false),[conflict,setConflict]=useState(false),[error,setError]=useState('');
 const pending=useRef<AbortController|null>(null),attempt=useRef<{body:NumberingConfigBody;ack:boolean;uncertain:boolean}|null>(null);
 const read=async(signal:AbortSignal,selection=selected)=>{
  const identity=numberingCompany(await controller.company('/v1/empresa/identidade',{signal}));if(signal.aborted)throw new DOMException('Aborted','AbortError');let row:NumberingSeries|null=null;
  if(selection){const q=numberingLookup(selection.id,selection.model),p=numberingPage(await controller.fiscalNumbering(q.path,{signal}),selection.model,q.after,1);if(signal.aborted)throw new DOMException('Aborted','AbortError');if(p.items[0]?.id!==selection.id)throw new AccessError(404);row=p.items[0];numberingMatchesCompany(row,identity);}
  return{company:identity,current:row};
 };
 useEffect(()=>{
  const request=new AbortController();setLoading(true);setReady(false);setError('');setConflict(false);setCurrent(null);setCompany(null);
  void read(request.signal).then(value=>{if(request.signal.aborted)return;setCurrent(value.current);setCompany(value.company);const fields=numberingInitialForm(value.current);setForm(fields);setBaseline(JSON.stringify(fields));setReady(true);}).catch(e=>{if(!request.signal.aborted&&!aborted(e))setError(failure(e));}).finally(()=>{if(!request.signal.aborted)setLoading(false);});
  return()=>{request.abort();pending.current?.abort();};
 },[controller,selected,reload]);
 useUnsavedChanges(JSON.stringify(form)!==baseline,busy||unresolved);
 const locked=!canManage||!ready||loading||busy||unresolved||conflict||!company||company.state!=='SP';
 const edit=(patch:Partial<NumberingForm>)=>{if(canManage&&!pending.current&&!attempt.current&&ready&&!loading&&!conflict)setForm(v=>({...v,...patch}));};
 const recover=async()=>{
  if(pending.current||!attempt.current)return;const operation=attempt.current,request=new AbortController();pending.current=request;setBusy(true);setError('');
  try{
   if(!operation.ack){const result=await controller.fiscalNumbering(`${NUMBERING_BASE}/series`,{method:'POST',body:operation.body,signal:request.signal});if(request.signal.aborted)return;numberingConfigCommand(result,operation.body.command_id,operation.body);operation.ack=true;}
   const saved=numberingConfigCommand(await controller.fiscalNumbering(`${NUMBERING_BASE}/commands/${operation.body.command_id}`,{signal:request.signal}),operation.body.command_id,operation.body);if(request.signal.aborted)return;
   const fresh=await read(request.signal,{id:saved.current.id,model:saved.current.model});if(request.signal.aborted)return;
   if(!fresh.current||fresh.current.id!==saved.current.id||fresh.current.version<saved.current.version)throw new AccessError(502);
   attempt.current=null;pending.current=null;setUnresolved(false);setBusy(false);onSaved();
  }catch(e){if(!request.signal.aborted&&!aborted(e)){const definitive=!operation.ack&&!operation.uncertain&&e instanceof AccessError&&[400,403,404,409].includes(e.status);if(definitive){attempt.current=null;setUnresolved(false);setConflict(e.status===409||e.status===404);}else operation.uncertain=true;setError(operation.ack?'A configuração foi registrada. Consulte o resultado e os dados atuais antes de continuar. Nenhum novo salvamento será enviado.':failure(e));}}
  finally{if(!request.signal.aborted&&pending.current===request){pending.current=null;setBusy(false);}}
 };
 const save=(event:FormEvent)=>{event.preventDefault();if(locked||pending.current||attempt.current)return;try{const body=numberingConfigBody(form,current,company,crypto.randomUUID());attempt.current={body:Object.freeze(body),ack:false,uncertain:false};setUnresolved(true);void recover();}catch(e){setError(e instanceof Error?e.message:'Confira os campos antes de salvar.');}};
 const close=()=>{if(pending.current)return;guard.confirmLeave(()=>{if(!pending.current)onClose();});};
 return<section className="real-editor numbering-editor" aria-label={selected?'Revisar série de homologação':'Incluir série de homologação'}><header className="real-editor-heading"><div><h2>{selected?'Revisar série':'Incluir série'}</h2><p>Homologação · configuração vinculada à empresa atual.</p></div><button type="button" className="secondary-button" disabled={busy} onClick={close}>{unresolved?'Sair e conferir depois':'Voltar às séries'}</button></header>
  {loading&&<p role="status">Consultando configuração atual…</p>}{error&&<p role="alert" className="real-alert">{error}</p>}
  {company&&<p className="numbering-company"><strong>{company.legal_name}</strong><span>CNPJ {company.cnpj} · {company.state}</span></p>}
  {!loading&&!company&&<p className="real-notice">Cadastre os dados da empresa antes de configurar uma série.</p>}
  {company&&company.state!=='SP'&&<p className="real-notice">Esta preparação está disponível apenas para empresa de São Paulo.</p>}
  {current&&<><p className="real-notice">Próximo número registrado: <strong>{current.next_number??'numeração esgotada'}</strong>. Revisar ou desativar a série preserva a sequência.</p>{current.company_changed&&<p className="real-alert">Os dados da empresa mudaram. Confira novamente o vínculo e o uso exclusivo antes de habilitar a série.</p>}<SeriesDetails row={current}/></>}
  {unresolved&&<section className="real-notice" aria-label="Resultado pendente"><p>A decisão está preservada. Sair não desfaz uma gravação que já tenha ocorrido.</p><button type="button" className="primary-button" disabled={busy} onClick={()=>void recover()}>{attempt.current?.ack?'Consultar resultado e dados atuais':'Conferir a mesma operação'}</button></section>}
  <form onSubmit={save} aria-busy={busy}><fieldset disabled={locked}><legend>Configuração da série</legend><div className="numbering-form-grid">
   <div className="form-field"><label htmlFor="numbering-model">Modelo *</label><select id="numbering-model" value={form.model} disabled={Boolean(current)} onChange={e=>edit({model:e.target.value as NumberingForm['model'],exclusive_use_confirmed:false})}><option value="">Selecione o modelo</option>{Object.entries(NUMBERING_MODELS).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></div>
   <div className="form-field"><label htmlFor="numbering-series">Série *</label><input id="numbering-series" type="text" inputMode="numeric" maxLength={3} value={form.series} readOnly={Boolean(current)} autoComplete="off" onChange={e=>edit({series:e.target.value,exclusive_use_confirmed:false})} aria-describedby="numbering-series-help"/><small id="numbering-series-help">De 0 a 889, sem zeros à esquerda. Escolha explicitamente uma série de homologação.</small></div>
   <div className="form-field"><label htmlFor="numbering-first">Primeiro número *</label><input id="numbering-first" type="text" inputMode="numeric" maxLength={9} value={form.initial_number} readOnly={Boolean(current)} autoComplete="off" onChange={e=>edit({initial_number:e.target.value,exclusive_use_confirmed:false})} aria-describedby="numbering-first-help"/><small id="numbering-first-help">De 1 a 999999999. Não inferimos o próximo número a partir do backup ou de outro sistema.</small></div>
   <div className="form-field"><label htmlFor="numbering-enabled">Situação *</label><select id="numbering-enabled" value={form.enabled} onChange={e=>edit({enabled:e.target.value as NumberingForm['enabled'],exclusive_use_confirmed:false})}><option value="">Escolha a situação</option><option value="enabled">Habilitada para preparação</option><option value="disabled">Desativada</option></select></div>
  </div>
   <p className="real-help">Modelo, série e primeiro número ficam fixos depois do cadastro. Esta tela não permite reiniciar ou saltar a sequência.</p>
   <label className="numbering-check"><input id="numbering-exclusive" type="checkbox" checked={form.exclusive_use_confirmed} onChange={e=>edit({exclusive_use_confirmed:e.target.checked})}/><span>Conferi que esta série de {form.model==='55'?'NF-e':form.model==='65'?'NFC-e':'nota fiscal'} será usada exclusivamente pelo FAGOO para este CNPJ em homologação, sem conflito com outros emissores.</span></label>
   <div className="form-field"><label htmlFor="numbering-reference">Referência da conferência ou motivo da alteração *</label><input id="numbering-reference" type="text" value={form.reference} maxLength={240} minLength={3} autoComplete="off" onChange={e=>edit({reference:e.target.value})}/><small>Registre o que foi conferido. Não inclua senhas, certificados ou credenciais.</small></div>
   <button type="submit" className="primary-button">Salvar configuração de homologação</button>
  </fieldset></form>
  {!unresolved&&<button type="button" className="text-button" disabled={loading||busy} onClick={()=>{if(!pending.current&&!attempt.current)guard.confirmLeave(()=>{if(!pending.current&&!attempt.current)setReload(v=>v+1);});}}>Descartar alterações e recarregar</button>}
 </section>;
}
