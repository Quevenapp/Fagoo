import {useEffect,useRef,useState,type ReactNode} from 'react';
import {useReferenceOptions} from '../hooks/useReferenceOptions';
import type {PlatformPort} from '../lib/platform-model';
import {useUnsavedChanges} from '../hooks/useUnsavedChanges';
import {EXTRA_PATH,STORAGE_PATH,STORAGE_LABELS,storageSummary,parseCompanyExtra,parseCompanyExtraResult,captureCompanyExtraSave,normalizeCompanyExtra,parseStorage,bytesText,PERSON_TYPES,COMPANY_SIZES,SEGMENTS,REVENUES,EMPLOYEES,SUBSTITUTE_UFS,
 type CompanyExtraData,type CompanyExtraView,type CompanyExtraSaveInput,type StorageUsage,type SystemController} from '../lib/system-model';
import {Icon} from './Icon';
import PreferenceSettingsPage from './PreferenceSettingsPage';
import {preferencePage} from '../../../../packages/erp-domain/src/preferences/catalog.mjs';
import type {PreferencesController} from '../lib/preferences-model';

const aborted=(e:unknown)=>e instanceof DOMException&&e.name==='AbortError';
const statusOf=(e:unknown)=>e&&typeof e==='object'&&Number.isInteger((e as {status?:unknown}).status)?(e as {status:number}).status:null;
type Draft={[K in keyof CompanyExtraData]:K extends 'segments'?string[]:K extends 'substitute_ies'?{uf:string;ie:string}[]:K extends 'ie_exempt'?boolean:string};
const EMPTY:CompanyExtraData={person_type:'juridica',ie_exempt:false,municipal_registration:null,suframa:null,cnae:null,company_size:null,segments:[],revenue:null,employees:null,contacts:null,mobile:null,billing_email:null,site:null,substitute_ies:[]};
const draftOf=(d:CompanyExtraData):Draft=>({person_type:d.person_type,ie_exempt:d.ie_exempt,municipal_registration:d.municipal_registration??'',suframa:d.suframa??'',cnae:d.cnae??'',company_size:d.company_size??'',segments:[...d.segments],
 revenue:d.revenue??'',employees:d.employees??'',contacts:d.contacts??'',mobile:d.mobile??'',billing_email:d.billing_email??'',site:d.site??'',substitute_ies:d.substitute_ies.map(e=>({...e}))});
const dataOf=(d:Draft):CompanyExtraData=>{const t=(v:string)=>v.trim()||null;return{person_type:d.person_type as CompanyExtraData['person_type'],ie_exempt:d.ie_exempt,municipal_registration:t(d.municipal_registration),suframa:t(d.suframa),
 cnae:t(d.cnae),company_size:(d.company_size||null) as CompanyExtraData['company_size'],segments:d.segments as CompanyExtraData['segments'],revenue:(d.revenue||null) as CompanyExtraData['revenue'],employees:(d.employees||null) as CompanyExtraData['employees'],
 contacts:t(d.contacts),mobile:t(d.mobile),billing_email:t(d.billing_email)?.toLowerCase()??null,site:t(d.site),substitute_ies:d.substitute_ies.map(e=>({uf:e.uf,ie:e.ie.trim()}))};};
type Attempt={body:CompanyExtraSaveInput;uncertain:boolean};

/** Empresa > Alterar dados da empresa: the Origin fields the fiscal identity does not keep (migration 151), saved by their own
 * audited command (Salvar | Cancelar). Every member reads them; only the administrador saves. */
/** 302: `onPersonType` receives the saved Tipo da Pessoa (Pessoa Jurídica without a record), so the identity checks a CPF or a CNPJ. */
export function CompanyExtraSection({controller,onPersonType}:{controller:Pick<SystemController,'system'>;onPersonType?:(person:'juridica'|'fisica')=>void}){
 const [view,setView]=useState<CompanyExtraView|null>(null),[draft,setDraft]=useState<Draft>(draftOf(EMPTY)),[baseline,setBaseline]=useState(JSON.stringify(draftOf(EMPTY)));
 const [error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[pending,setPending]=useState(false),[reload,setReload]=useState(0);
 const attempt=useRef<Attempt|null>(null),alive=useRef(true);
 const dirty=JSON.stringify(draft)!==baseline;
 useUnsavedChanges(dirty,busy||pending);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 useEffect(()=>{const p=new AbortController();setError('');void(async()=>{try{
  const v=parseCompanyExtra(await controller.system(EXTRA_PATH,{method:'GET',signal:p.signal}));if(p.signal.aborted)return;const d=draftOf(v.record?.data??EMPTY);setView(v);setDraft(d);setBaseline(JSON.stringify(d));
  onPersonType?.(v.record?.data.person_type??'juridica');
 }catch(e){if(!p.signal.aborted&&!aborted(e))setError('Não foi possível carregar os dados complementares da empresa.');}})();return()=>p.abort();},[controller,reload]);
 const run=async(a:Attempt)=>{if(busy||attempt.current!==a)return;setBusy(true);setError('');setNotice('');try{
  const r=parseCompanyExtraResult(await controller.system(EXTRA_PATH,{method:'POST',body:a.body}),a.body);if(!alive.current||attempt.current!==a)return;
  attempt.current=null;setPending(false);const d=draftOf(r.record.data);setView(v=>v&&{...v,record:r.record});setDraft(d);setBaseline(JSON.stringify(d));onPersonType?.(r.record.data.person_type);setNotice(r.replayed?'Dados conferidos: a alteração já estava salva.':'Dados da empresa salvos.');
 }catch(e){if(!alive.current||attempt.current!==a||aborted(e))return;const s=statusOf(e);
  // erp_company_extra_save replays a recorded command before checking the version and "nothing changed", so a 400 or 409
  // to the same command proves it was never recorded, also on Conferir resultado. A 403 comes before the replay: it stays
  // uncertain.
  if(s!==null&&(a.uncertain?[400,409]:[400,403,409]).includes(s)){attempt.current=null;setPending(false);setError(s===409?'Os dados mudaram desde a consulta. Nada foi salvo; recarregue para conferir.':s===403?'Nada foi salvo. Somente administradores alteram os dados da empresa.':'Nada foi salvo. Confira os campos (ou nada mudou).');}
  else{a.uncertain=true;setPending(true);setError('Não foi possível confirmar se os dados foram salvos. Confira o resultado do mesmo comando antes de editar de novo.');}
 }finally{if(alive.current)setBusy(false);}};
 const save=()=>{if(!view?.can_manage||busy||attempt.current)return;let data:CompanyExtraData;
  try{data=normalizeCompanyExtra(dataOf(draft));}catch{setError(!draft.segments.length?'Escolha ao menos um segmento em “Seu segmento”.':'Confira os campos: CNAE da tabela oficial (7 dígitos), celular, e-mail de cobrança, site e inscrições dos substitutos.');return;}
  const a:Attempt={body:captureCompanyExtraSave({command_id:crypto.randomUUID(),expected_version:view.record?.version??0,data}),uncertain:false};attempt.current=a;void run(a);};
 const set=(patch:Partial<Draft>)=>{if(!busy&&!pending)setDraft(d=>({...d,...patch}));};
 const locked=!view?.can_manage||busy||pending;
 const cnae=useReferenceOptions(controller as unknown as Partial<PlatformPort>,'cnae',draft.cnae,{enabled:!locked,minLength:2});
 const select=(id:string,label:string,key:'person_type'|'company_size'|'revenue'|'employees',options:readonly(readonly[string,string])[],blank=true)=><label className="form-field">{label}
  <select id={id} value={draft[key]} onChange={e=>set({[key]:e.target.value} as Partial<Draft>)}>{blank&&<option value="">Selecione</option>}{options.map(([v,t])=><option key={v} value={v}>{t}</option>)}</select></label>;
 const input=(id:string,label:string,key:'municipal_registration'|'suframa'|'cnae'|'contacts'|'mobile'|'billing_email'|'site',max:number,extra?:ReactNode)=><label className="form-field">{label}{extra}
  <input id={id} maxLength={max} value={draft[key]} onChange={e=>set({[key]:e.target.value} as Partial<Draft>)}/></label>;
 return <section className="real-editor company-settings-section company-extra" aria-labelledby="company-extra-title">
  <header className="real-editor-heading"><div><h2 id="company-extra-title">Dados complementares da empresa</h2><p>{view?.record?`Versão ${view.record.version}`:'Ainda não informados'}. Informações da empresa que complementam a identidade fiscal.</p></div></header>
  {error&&<p className="real-alert" role="alert">{error}{!view&&<button type="button" className="text-button" onClick={()=>setReload(n=>n+1)}>Tentar novamente</button>}</p>}{notice&&<p className="real-success" role="status">{notice}</p>}
  {pending&&attempt.current&&<section className="real-notice" aria-label="Confirmação pendente"><p>O resultado precisa ser confirmado. Os campos ficam preservados.</p><button type="button" className="primary-button" disabled={busy} onClick={()=>void run(attempt.current!)}>Conferir resultado</button></section>}
  {view&&<form onSubmit={e=>{e.preventDefault();save();}}><fieldset className="company-extra-fields" disabled={locked}><legend className="real-sr-only">Dados complementares</legend>
   <div className="company-settings-grid">{select('company-extra-person','Tipo da Pessoa','person_type',PERSON_TYPES,false)}
    <label className="company-confirmation"><input type="checkbox" id="company-extra-ie-exempt" checked={draft.ie_exempt} onChange={e=>set({ie_exempt:e.target.checked})}/>Inscrição Estadual: Isento</label>
    {input('company-extra-im','Inscrição Municipal','municipal_registration',30,!draft.municipal_registration&&<span className="company-alert" title="Inscrição Municipal não informada"><Icon name="triangle-exclamation" size={11}/><span className="sr-only">Inscrição Municipal não informada</span></span>)}
    {input('company-extra-suframa','Inscrição Suframa','suframa',12)}{/* Leva H (PRF-296): suggestions from the official CNAE 2.3 table (IBGE/CONCLA); the server accepts only an official subclass. */}
    <label className="form-field">CNAE<input id="company-extra-cnae" maxLength={9} list="company-extra-cnae-options" autoComplete="off" value={draft.cnae} onChange={e=>set({cnae:e.target.value})}/>
     <datalist id="company-extra-cnae-options">{cnae.items.map(item=><option key={item.code} value={item.code}>{item.label}</option>)}</datalist>
     {cnae.dataset&&<small className="company-hint">Tabela oficial: {cnae.dataset.version}, {cnae.dataset.source.split(',')[0]}.</small>}</label>
    {select('company-extra-size','Tamanho da empresa','company_size',COMPANY_SIZES)}{select('company-extra-revenue','Faturamento do último ano','revenue',REVENUES)}{select('company-extra-employees','Quantidade de funcionários','employees',EMPLOYEES)}</div>
   <fieldset className="company-segments"><legend>Seu segmento *</legend>{SEGMENTS.map(([v,t])=><label key={v}><input type="checkbox" id={`company-extra-segment-${v}`} checked={draft.segments.includes(v)} onChange={e=>set({segments:SEGMENTS.map(o=>o[0]).filter(s=>s===v?e.target.checked:draft.segments.includes(s))})}/>{t}</label>)}</fieldset>
   <h3>Contato</h3><div className="company-settings-grid">{input('company-extra-contacts','Pessoas de contato','contacts',120)}{input('company-extra-mobile','Celular','mobile',20)}{input('company-extra-billing','E-mail de Cobrança','billing_email',254)}{input('company-extra-site','Site','site',200)}</div>
   <h3>Inscrições Estaduais dos substitutos tributários</h3>
   <table className="data-table company-substitutes"><thead><tr><th scope="col">UF</th><th scope="col">Inscrição Estadual</th><th scope="col"><span className="sr-only">Ações</span></th></tr></thead><tbody>{draft.substitute_ies.map((row,i)=><tr key={i}>
    <td><select id={`company-extra-ie-uf-${i}`} aria-label="UF" value={row.uf} onChange={e=>set({substitute_ies:draft.substitute_ies.map((r,j)=>j===i?{...r,uf:e.target.value}:r)})}><option value="">UF</option>{SUBSTITUTE_UFS.map(uf=><option key={uf} value={uf}>{uf}</option>)}</select></td>
    <td><input id={`company-extra-ie-${i}`} aria-label="Inscrição Estadual" maxLength={20} value={row.ie} onChange={e=>set({substitute_ies:draft.substitute_ies.map((r,j)=>j===i?{...r,ie:e.target.value}:r)})}/></td>
    <td><button type="button" className="text-button" onClick={()=>set({substitute_ies:draft.substitute_ies.filter((_,j)=>j!==i)})}>Remover</button></td></tr>)}</tbody></table>
   <button type="button" className="text-button" disabled={draft.substitute_ies.length>=27} onClick={()=>set({substitute_ies:[...draft.substitute_ies,{uf:'',ie:''}]})}><Icon name="plus" size={10}/>Adicionar inscrição</button>
   {/* Sua marca (the logo) is its own section since 262 (CompanyLogo); no disabled stand-in here. */}
   <h3>Sua marca</h3><p className="real-help">O logo da empresa é enviado na seção Sua marca desta página (PNG ou JPEG de até 2 MB, pelo administrador).</p>
  </fieldset>
  {view.can_manage?<div className="real-editor-actions"><button type="submit" className="primary-button" disabled={locked||!dirty}>Salvar</button><button type="button" className="secondary-button" disabled={busy||pending||!dirty} onClick={()=>setDraft(JSON.parse(baseline) as Draft)}>Cancelar</button><span className="real-help">(*) Campos obrigatórios</span></div>
   :<p className="real-help">Somente administradores alteram os dados da empresa.</p>}</form>}
 </section>;
}

/** Empresa > Gerenciamento > Espaço e armazenamento. */
export function CompanyStorage({controller}:{controller:Pick<SystemController,'system'>&Partial<PreferencesController>}){
 const [value,setValue]=useState<StorageUsage|null>(null),[error,setError]=useState(''),[reload,setReload]=useState(0);
 useEffect(()=>{const p=new AbortController();setError('');void controller.system(STORAGE_PATH,{method:'GET',signal:p.signal}).then(raw=>{if(!p.signal.aborted)setValue(parseStorage(raw));}).catch(e=>{if(!p.signal.aborted&&!aborted(e))setError('Não foi possível consultar o armazenamento.');});return()=>p.abort();},[controller,reload]);
 return <section className="real-editor company-settings-section" aria-labelledby="company-storage-title"><h2 id="company-storage-title">Espaço e armazenamento</h2>
  {error&&<p className="real-alert" role="alert">{error}</p>}{!value&&!error&&<p role="status">Consultando armazenamento…</p>}
  {value&&<><p>Armazenamento usado: <strong title={`${value.total_bytes} bytes`}>{bytesText(value.total_bytes)}</strong> em {value.objects.toLocaleString('pt-BR')} arquivo(s){value.limit_bytes?<> de <strong>{bytesText(value.limit_bytes)}</strong> ({storageSummary(value).percent!.toLocaleString('pt-BR')}%)</>:''}.</p>
   {value.groups?<table className="data-table"><thead><tr><th scope="col">Tipo de arquivo</th><th scope="col" className="numeric">Arquivos</th><th scope="col" className="numeric">Espaço</th></tr></thead>
    <tbody>{value.groups.map(g=><tr key={g.group}><td>{STORAGE_LABELS[g.group]}</td><td className="numeric">{g.objects.toLocaleString('pt-BR')}</td><td className="numeric">{bytesText(g.bytes)}</td></tr>)}</tbody></table>
    :<p className="real-help">O detalhe por tipo de arquivo fica disponível para administradores.</p>}
   <p className="real-help">O limite de armazenamento desta instalação é informado pelo administrador conforme a capacidade reservada no servidor.</p></>}
  {typeof controller.preferences==='function'&&typeof controller.getSnapshot==='function'&&typeof controller.subscribe==='function'&&<PreferenceSettingsPage key={reload} controller={controller as PreferencesController} page={preferencePage('empresa-armazenamento')!} categoryLabel="Dados da empresa" categoryTo="/empresa-configuracoes?secao=armazenamento" embedded onClose={()=>setReload(n=>n+1)}/>}
 </section>;
}
