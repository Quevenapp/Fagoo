import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import {useEffect,useRef,useState,type FormEvent} from 'react';
import {AccessError,type AccessController} from '../lib/real-access';
import {IDENTITY_FIELDS,STATE_CODES,CRT_LABELS,identityValues,companyData,fiscalInput,companyDocumentLabel,identityDocumentKind,type CompanyController,type CompanyAccess,type CompanyRecord,type CompanyFiscal,type CompanyEnvelope,type CompanyPersonType} from '../lib/company-model';
import CompanySetupGuide from './CompanySetupGuide';
import {Link,useLocation} from 'react-router-dom';
import {CompanyExtraSection,CompanyStorage} from './CompanyExtra';
import {CompanyPartners} from './CompanyPartners';
import CompanyLogo from './CompanyLogo';
import type {SystemController} from '../lib/system-model';
import {Icon} from './Icon';
import './company-settings.css';
import AccountSecurity from './AccountSecurity';
import {authClient} from '../lib/auth-client';
const identityGroups=[
 {title:'Identificação',description:'Confira os dados no cadastro atual da empresa.',keys:['legal_name','trade_name','cnpj','ie']},
 {title:'Endereço da empresa',description:'Informe o endereço completo. Município e código IBGE devem representar o mesmo local.',keys:['postal_code','street','number','complement','district','city','state','municipality_code']},
 {title:'Contato',description:'Telefone e e-mail comerciais são opcionais.',keys:['phone','email']}
];
const fieldHelp:Record<string,string>={cnpj:'Aceita CNPJ com ou sem pontuação. Os dígitos verificadores não comprovam a situação cadastral.',ie:'Confira a inscrição estadual vigente. Deixar em branco significa não informado; não significa isento.',municipality_code:'Código de sete dígitos do município no IBGE. Não é o CEP; confira o código junto com município e UF.',number:'Informe o número conforme o cadastro do endereço.',email:'E-mail comercial exibido na identificação dos documentos; não altera o e-mail de acesso.'};
const aborted=(error:unknown)=>error instanceof DOMException&&error.name==='AbortError';
const errorText=(error:unknown)=>error instanceof AccessError?(error.status===409?'Os dados mudaram desde a consulta. Suas alterações continuam no formulário. Recarregue para conferir a versão atual.':error.status===403?'Seu perfil não permite esta operação.':error.status===400?'Confira os campos e a confirmação antes de salvar.':'Não foi possível confirmar a operação. Tente novamente; o mesmo comando não duplica alterações.'):'Não foi possível concluir a operação.';
type CompanySnapshot={access:CompanyAccess;identity:CompanyRecord|null;fiscal:CompanyFiscal|null};
async function readCurrent(controller:CompanyController,signal:AbortSignal):Promise<CompanySnapshot>{
 const access=await controller.company('/v1/empresa',{signal})as CompanyAccess;
 if(access.data_mode!=='erp_native'||access.emission_enabled!==false||access.read_identity!==true||typeof access.read_fiscal!=='boolean'||typeof access.write_identity!=='boolean'||typeof access.write_fiscal!=='boolean')throw new AccessError(502);
 const [identity,fiscal]=await Promise.all([controller.company('/v1/empresa/identidade',{signal})as Promise<CompanyEnvelope<CompanyRecord>>,access.read_fiscal?controller.company('/v1/empresa/fiscal',{signal})as Promise<CompanyEnvelope<CompanyFiscal>>:Promise.resolve(null)]);
 if(identity.section!=='identity'||identity.data_mode!=='erp_native'||identity.emission_enabled!==false||identity.record===undefined
  ||identity.record!==null&&(!Number.isInteger(identity.record.version)||identity.record.version<1||!identity.record.data)
  ||fiscal&&(fiscal.section!=='fiscal'||fiscal.data_mode!=='erp_native'||fiscal.emission_enabled!==false||fiscal.record===undefined
   ||fiscal.record!==null&&(!Number.isInteger(fiscal.record.version)||fiscal.record.version<1)))throw new AccessError(502);
 // Publish one coherent pair, never a new identity beside the previous CNPJ's regime.
 if(fiscal&&((identity.record===null)!==(fiscal.record===null)||identity.record&&fiscal.record?.identity_version!==identity.record.version))throw new AccessError(502);
 return {access,identity:identity.record,fiscal:fiscal?.record??null};
}
// Origin empresa.php: Nome, Nome Fantasia and CNPJ are locked once registered (Corrigir unlocks them, with the CRT warning).
const LOCKED=['legal_name','trade_name','cnpj'];
type Section='dados'|'socios'|'armazenamento'|'seguranca';
export default function CompanySettings({controller}:{controller:CompanyController&Partial<Pick<SystemController,'system'>>&Partial<Pick<AccessController,'attachments'|'getSnapshot'|'security'>>}){
 const {search}=useLocation(),system=typeof controller.system==='function'?controller as Pick<SystemController,'system'>:null;
 // 262: Sua marca (the logo) through the attachment proxy.
 const logoPort=typeof controller.attachments==='function'&&typeof controller.getSnapshot==='function'?controller as Pick<AccessController,'attachments'|'getSnapshot'>:null;
 // Leva H (PRF-291, PRF-208): Alterar senha and the second factor, with the session of the company area.
 const securityPort=typeof controller.security==='function'&&typeof controller.getSnapshot==='function'&&authClient()?controller as Pick<AccessController,'security'|'getSnapshot'>:null;
 const [section,setSection]=useState<Section>(()=>{const s=new URLSearchParams(search).get('secao');return system&&(s==='armazenamento'||s==='socios')?s:s==='seguranca'&&securityPort?s:'dados';}),[unlock,setUnlock]=useState(false);
 // 189: correcting Nome, Nome Fantasia or CNPJ asks for a reason, recorded in the audit.
 const [lockedReason,setLockedReason]=useState('');
 const [access,setAccess]=useState<CompanyAccess|null>(null);const [identity,setIdentity]=useState<CompanyRecord|null>(null);const [fiscal,setFiscal]=useState<CompanyFiscal|null>(null);const [values,setValues]=useState(()=>identityValues(null));
 const [crt,setCrt]=useState('');const [confirmed,setConfirmed]=useState(false);const [reason,setReason]=useState('');const [loading,setLoading]=useState(true);const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [notice,setNotice]=useState('');const [reload,setReload]=useState(0);
 const [discardReview,setDiscardReview]=useState(false),[unresolved,setUnresolved]=useState(false);
 // 302: Tipo da Pessoa of the Dados complementares: Pessoa Física keeps a CPF in the identity (null while not read).
 const [personType,setPersonType]=useState<CompanyPersonType|null>(null);
 const pending=useRef<AbortController|null>(null);const command=useRef<{section:'identidade'|'fiscal';body:Record<string,unknown>;id:string;committed:boolean;uncertain:boolean}|null>(null);
 const accept=(snapshot:CompanySnapshot)=>{setUnlock(false);setLockedReason('');setAccess(snapshot.access);setIdentity(snapshot.identity);setValues(identityValues(snapshot.identity));setFiscal(snapshot.fiscal);setCrt(snapshot.fiscal?.crt||'');setConfirmed(false);setReason('');setDiscardReview(false);};
 useEffect(()=>{const request=new AbortController();setLoading(true);setError('');
  void readCurrent(controller,request.signal).then(snapshot=>{if(!request.signal.aborted){accept(snapshot);setLoading(false);}})
   .catch(failure=>{if(!request.signal.aborted&&!aborted(failure)){setError(failure instanceof AccessError&&failure.status===403?'Seu usuário não tem a permissão Acesso aos dados da empresa (Sistema › Usuários › Permissões › Outros).':errorText(failure));setLoading(false);}});
  return()=>{request.abort();pending.current?.abort();};
 },[controller,reload]);
 const recover=async()=>{
  if(busy||pending.current&&!pending.current.signal.aborted||!command.current)return;
  const attempt=command.current;
  const request=new AbortController();pending.current=request;setBusy(true);setError('');setNotice('');
  try{
   if(!attempt.committed){await controller.company(`/v1/empresa/${attempt.section}`,{method:'POST',body:{...attempt.body,command_id:attempt.id},signal:request.signal});if(request.signal.aborted)return;attempt.committed=true;}
   const current=await readCurrent(controller,request.signal);if(request.signal.aborted)return;
   accept(current);command.current=null;setUnresolved(false);setNotice('Operação confirmada. Os dados atuais da empresa estão exibidos. A emissão fiscal continua indisponível nesta configuração.');
  }catch(failure){if(!request.signal.aborted&&!aborted(failure)){
    const definitive=!attempt.committed&&!attempt.uncertain&&failure instanceof AccessError&&[400,403,404,409].includes(failure.status);
    if(definitive){command.current=null;setUnresolved(false);}
    else attempt.uncertain=true;
    setError(attempt.committed?'A operação foi registrada. Consulte os dados atuais para continuar; nenhum novo comando será enviado.':errorText(failure));
   }}finally{if(!request.signal.aborted){pending.current=null;setBusy(false);}}
 };
 const run=(section:'identidade'|'fiscal',body:Record<string,unknown>)=>{if(busy||command.current)return;command.current={section,body:structuredClone(body),id:crypto.randomUUID(),committed:false,uncertain:false};setUnresolved(true);void recover();};
 const lockedChanged=Boolean(identity)&&LOCKED.some(key=>(values as Record<string,string>)[key]!==(identityValues(identity) as Record<string,string>)[key]);
 const saveIdentity=(event:FormEvent)=>{event.preventDefault();if(!access?.write_identity||busy||unresolved)return;
  if(lockedChanged&&lockedReason.trim().length<3){setError(`Informe o motivo da correção de Nome, Nome Fantasia ou ${docLabel} (ao menos 3 caracteres).`);return;}
  try{const data=companyData(values,identityDocumentKind(personType,values.cnpj,identity?.data.cnpj??null));run('identidade',{expected_version:identity?.version??0,data,...(lockedChanged?{reason:lockedReason.trim()}:{})});}catch(failure){setError((failure as Error).message);}};
 const saveFiscal=(event:FormEvent)=>{event.preventDefault();if(!access?.write_fiscal||busy||unresolved)return;try{run('fiscal',fiscalInput(fiscal,crt,confirmed,reason));}catch(failure){setError((failure as Error).message);}};
 const identityDirty=JSON.stringify(values)!==JSON.stringify(identityValues(identity));
 const dirty=identityDirty||crt!==(fiscal?.crt||'')||confirmed||Boolean(reason);
 useUnsavedChanges(dirty,busy||unresolved);
 const refresh=()=>{setNotice('');setDiscardReview(false);setReload(value=>value+1);};
 // Origin "Cancelar" of the identity form: the fields return to the saved data (the regime keeps its own confirmation).
 const cancelIdentity=()=>{if(busy||unresolved)return;setValues(identityValues(identity));setUnlock(false);setLockedReason('');setError('');setNotice('');};
 const locked=Boolean(identity)&&!unlock;
 // 302: CPF with Pessoa Física; the saved document says which one while the Tipo da Pessoa is not known.
 const docLabel=personType==='fisica'?'CPF':personType===null&&identity?companyDocumentLabel(identity.data.cnpj):'CNPJ';
 const docMismatch=Boolean(identity&&personType&&companyDocumentLabel(identity.data.cnpj)!==docLabel);
 const nav=<nav className="company-account-nav" aria-label="Minha conta"><h2>Minha conta</h2><ul><li><button type="button" aria-current={section==='dados'?'page':undefined} onClick={()=>setSection('dados')}>Dados da empresa</button></li>
  <li>{system&&access?.write_identity?<button type="button" aria-current={section==='socios'?'page':undefined} onClick={()=>setSection('socios')}>Dados do sócio(s)</button>:<span className="company-account-disabled" aria-disabled="true" title="Somente administradores consultam os dados dos sócios.">Dados do sócio(s)</span>}</li>
  <li>{securityPort?<button type="button" aria-current={section==='seguranca'?'page':undefined} onClick={()=>setSection('seguranca')}>Alterar senha e segundo fator</button>:<span className="company-account-disabled" aria-disabled="true">Alterar senha</span>}</li>
  <li>{access?.write_identity?<Link to="/preferencias/sistema/usuarios" title="Sistema › Usuários: abra o usuário e use Tipo, horários e permissões para restringir os horários de acesso.">Controle de horários <Icon name="up-right-from-square" size={9}/></Link>
   :<span className="company-account-disabled" aria-disabled="true" title="Somente administradores definem os horários de acesso dos usuários (Sistema › Usuários).">Controle de horários <Icon name="up-right-from-square" size={9}/></span>}</li></ul>
  <h2>Gerenciamento</h2><ul><li>{system?<button type="button" aria-current={section==='armazenamento'?'page':undefined} onClick={()=>setSection('armazenamento')}>Espaço e armazenamento</button>:<span className="company-account-disabled" aria-disabled="true">Espaço e armazenamento</span>}</li></ul></nav>;
 return <div className="company-account">{nav}<div className="company-account-main">{section==='seguranca'&&securityPort?<AccountSecurity port={authClient()!} controller={securityPort}/>:section==='armazenamento'&&system?<CompanyStorage controller={system}/>:section==='socios'&&system&&access?.write_identity?<CompanyPartners controller={system}/>:<><header className="real-heading"><div><h1>Dados da empresa</h1><p>Cadastro de uma única empresa para identificação nos documentos comerciais.</p></div><span className="real-mode">{access?.write_identity?'Administrador':access?.write_fiscal?'Configuração fiscal':'Consulta'}</span></header>
  <p className="real-notice">Confira o CNPJ e o endereço da empresa antes de usar esses dados nos documentos.</p>
  {loading&&<p role="status">Carregando dados da empresa…</p>}{error&&<p className="real-alert" role="alert">{error}{!access&&<button className="text-button" onClick={refresh}>Tentar novamente</button>}</p>}{notice&&<p className="real-success" role="status">{notice}</p>}
  {unresolved&&busy&&<p role="status" className="real-help">Salvando e conferindo os dados da empresa…</p>}
  {unresolved&&!busy&&<section className="real-notice" aria-label="Confirmação pendente"><p>O resultado desta operação precisa ser confirmado. Os campos ficam preservados até a consulta; sair da tela não desfaz uma gravação já realizada.</p><button type="button" className="primary-button" disabled={busy} onClick={()=>void recover()}>{command.current?.committed?'Consultar dados atuais':'Confirmar resultado da mesma operação'}</button></section>}
  {!loading&&access&&<><CompanySetupGuide access={access} identity={identity} fiscal={fiscal} pending={unresolved} dirty={dirty}/><section className="real-editor company-settings-section"><header className="real-editor-heading"><div><h2>Identidade comercial</h2><p>{identity?`Versão ${identity.version}`:'Cadastro ainda não informado'}. Disponível aos membros ativos para identificação da empresa.</p></div></header>
   <form onSubmit={saveIdentity} aria-busy={busy}><fieldset className="company-identity-fields" disabled={!access.write_identity||busy||unresolved}><legend className="real-sr-only">Identificação e endereço</legend>
    {identityGroups.map(group=><section className="company-identity-group" key={group.title}><h3>{group.title}</h3><p className="real-help">{group.description}</p><div className="company-settings-grid">{group.keys.map(key=>IDENTITY_FIELDS.find(field=>field.key===key)!).map(field=><div className="form-field" key={field.key}><label htmlFor={`company-${field.key}`}>{field.key==='cnpj'?docLabel:field.label}{field.required?' *':''}</label>{field.key==='state'?<select id={`company-${field.key}`} required value={values.state} onChange={event=>setValues({...values,state:event.target.value})}><option value="">Selecione a UF</option>{Object.keys(STATE_CODES).sort().map(state=><option key={state} value={state}>{state}</option>)}</select>:<input id={`company-${field.key}`} disabled={locked&&LOCKED.includes(field.key)} type={field.key==='email'?'email':'text'} inputMode={['postal_code','municipality_code'].includes(field.key)?'numeric':field.key==='phone'?'tel':undefined} required={field.required} autoComplete="off" maxLength={field.max} value={values[field.key]} aria-describedby={fieldHelp[field.key]?`company-help-${field.key}`:undefined} onChange={event=>setValues({...values,[field.key]:event.target.value})}/>} {fieldHelp[field.key]&&<small className="company-field-help" id={`company-help-${field.key}`}>{field.key==='cnpj'&&docLabel==='CPF'?'Tipo da Pessoa: Pessoa Física (Dados complementares). Aceita CPF com ou sem pontuação; os dígitos verificadores não comprovam a situação cadastral.':fieldHelp[field.key]}</small>}</div>)}</div></section>)}
   </fieldset>{docMismatch&&<p className="real-notice" role="status">O Tipo da Pessoa é {personType==='fisica'?'Pessoa Física':'Pessoa Jurídica'}, mas a identidade traz um {companyDocumentLabel(identity!.data.cnpj)}. Use “Corrigir dados bloqueados” para informar o {docLabel}; a NF-e não é gerada enquanto o documento não conferir.</p>}<p className="real-help company-required-note">(*) Campos obrigatórios</p>
   {access.write_identity&&<div className="real-editor-actions"><button className="primary-button" disabled={busy||unresolved}>Salvar</button>
    <button type="button" className="secondary-button" disabled={busy||unresolved||!identityDirty&&!unlock} title={identityDirty||unlock?'Descarta as alterações da identidade e volta aos dados salvos.':'Nada a cancelar: a identidade está igual aos dados salvos.'} onClick={cancelIdentity}>Cancelar</button>
    {identity&&!unlock&&<button type="button" className="secondary-button" disabled={busy||unresolved} onClick={()=>setUnlock(true)}>Corrigir dados bloqueados</button>}</div>}
    {unlock&&<p className="real-help">Nome, Nome Fantasia e {docLabel} ficam bloqueados como no Origin. Corrija-os só com o cadastro oficial em mãos: alterar o {docLabel} retira a confirmação do regime tributário.</p>}
    {unlock&&lockedChanged&&<div className="form-field"><label htmlFor="company-locked-reason">Motivo da correção *</label><input id="company-locked-reason" maxLength={1000} autoComplete="off" value={lockedReason} disabled={busy||unresolved} onChange={event=>setLockedReason(event.target.value)}/>
     <small className="company-field-help">Fica registrado no Registro de atividades com a alteração.</small></div>}</form>
   <details className="real-help"><summary>Como os dados são conferidos</summary><p>O CNPJ é conferido pelo formato e dígitos verificadores, incluindo o formato alfanumérico; com Tipo da Pessoa = Pessoa Física, o CPF é conferido da mesma forma. CEP, endereço e código IBGE recebem validação estrutural e de coerência com a UF. Isso não consulta a situação cadastral nem confirma a existência do endereço. A inscrição estadual é preservada como informada, sem validação estadual do dígito verificador. Alterar o CNPJ retira a confirmação anterior do regime.</p></details>
  </section>
  {system&&<CompanyExtraSection controller={system} onPersonType={setPersonType}/>}
  {logoPort&&<CompanyLogo controller={logoPort}/>}
  {access.read_fiscal&&<section className="real-editor company-settings-section"><h2>Configuração fiscal</h2><p>{unresolved?'Regime: consulta atual pendente.':<>Regime atual: <strong>{fiscal?.confirmed?CRT_LABELS[fiscal.crt!]:'A confirmar'}</strong>{fiscal?` · versão ${fiscal.version}`:''}.</>}</p><p className="real-notice">Escolher um regime exige conferência explícita. Não há certificado, senha, CSC ou habilitação de emissão nesta tela.</p>
   {identityDirty&&<p className="real-help">Salve ou descarte as alterações da identidade antes de confirmar o regime.</p>}
   <form onSubmit={saveFiscal} aria-busy={busy}><fieldset className="company-fiscal-fields" disabled={!access.write_fiscal||!fiscal||busy||unresolved||identityDirty}><legend className="real-sr-only">Confirmação de regime tributário</legend><div className="form-field"><label htmlFor="company-crt">Regime tributário (CRT)</label><select id="company-crt" aria-describedby="company-crt-help" value={unresolved?'':crt} onChange={event=>{setCrt(event.target.value);setConfirmed(false);}}><option value="">{unresolved?'Consulta atual pendente':'A confirmar / retirar confirmação'}</option>{Object.entries(CRT_LABELS).map(([value,label])=><option key={value} value={value}>{value} · {label}</option>)}</select><small className="company-field-help" id="company-crt-help">Confirme a opção específica com o responsável fiscal. O cadastro não escolhe automaticamente entre Simples Nacional, excesso de sublimite ou MEI.</small></div>
   {!unresolved&&crt&&<label className="company-confirmation"><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/>Conferi o enquadramento desta empresa e confirmo o regime selecionado.</label>}
   <div className="form-field"><label htmlFor="company-fiscal-reason">Motivo ou referência da conferência *</label><input id="company-fiscal-reason" required minLength={3} maxLength={1000} autoComplete="off" aria-describedby="company-fiscal-reason-help" value={reason} onChange={event=>setReason(event.target.value)}/><small className="company-field-help" id="company-fiscal-reason-help">Registre qual cadastro ou orientação foi conferido e a data da conferência. Não inclua senha, certificado ou outra credencial.</small></div>
   <button className="primary-button" disabled={Boolean(crt)&&!confirmed}>{crt?'Confirmar regime tributário':'Retirar confirmação do regime'}</button></fieldset></form>{!fiscal&&<p className="real-help">Cadastre a identidade da empresa antes de confirmar o regime.</p>}
  </section>}
  {discardReview?<section className="real-alert" aria-label="Descartar alterações"><p>Descartar as alterações não salvas e recarregar os dados da empresa?</p><div className="real-editor-actions"><button type="button" className="secondary-button" disabled={busy||unresolved} onClick={()=>setDiscardReview(false)}>Continuar editando</button><button type="button" className="primary-button" disabled={busy||unresolved} onClick={refresh}>Descartar e recarregar</button></div></section>:<button type="button" className="secondary-button" disabled={busy||unresolved} onClick={()=>dirty?setDiscardReview(true):refresh()}>Recarregar dados</button>}</>}
 </>}</div></div>;
}
