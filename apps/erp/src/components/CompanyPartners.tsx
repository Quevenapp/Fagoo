import {useEffect,useRef,useState} from 'react';
import {useUnsavedChanges} from '../hooks/useUnsavedChanges';
import {PARTNERS_PATH,PARTNER_LIMIT,parseCompanyPartners,parseCompanyPartnersResult,captureCompanyPartnersSave,normalizeCompanyPartners,
 type CompanyPartner,type CompanyPartnersView,type CompanyPartnersSaveInput,type SystemController} from '../lib/system-model';
import {Icon} from './Icon';

type Row={name:string;cpf:string;share:string;role:string;email:string;phone:string};
type Attempt={body:CompanyPartnersSaveInput;uncertain:boolean};
const aborted=(e:unknown)=>e instanceof DOMException&&e.name==='AbortError';
const statusOf=(e:unknown)=>e&&typeof e==='object'&&Number.isInteger((e as {status?:unknown}).status)?(e as {status:number}).status:null;
const rowOf=(p:CompanyPartner):Row=>({name:p.name,cpf:p.cpf,share:p.share?.replace('.',',')??'',role:p.role??'',email:p.email??'',phone:p.phone??''});
const blank=():Row=>({name:'',cpf:'',share:'',role:'',email:'',phone:''});
const dataOf=(rows:Row[])=>rows.map(r=>{const t=(v:string)=>v.trim()||null;return{name:r.name.trim(),cpf:r.cpf.trim(),share:t(r.share.replace(',','.')),role:t(r.role),email:t(r.email),phone:t(r.phone)};});
const cpfText=(v:string)=>/^[0-9]{11}$/.test(v)?`${v.slice(0,3)}.${v.slice(3,6)}.${v.slice(6,9)}-${v.slice(9)}`:v;

/** Empresa › Dados do sócio(s) (migration 189): nome, CPF, participação, cargo, e-mail e telefone. Only the administrador reads
 * and saves them (personal data); one audited command per Salvar, CAS by version, "Conferir resultado" on an uncertain answer. */
export function CompanyPartners({controller}:{controller:Pick<SystemController,'system'>}){
 const [view,setView]=useState<CompanyPartnersView|null>(null),[rows,setRows]=useState<Row[]>([]),[baseline,setBaseline]=useState('[]');
 const [error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[pending,setPending]=useState(false),[reload,setReload]=useState(0);
 const attempt=useRef<Attempt|null>(null),alive=useRef(true);
 const dirty=JSON.stringify(rows)!==baseline;
 useUnsavedChanges(dirty,busy||pending);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const accept=(partners:CompanyPartner[])=>{const r=partners.map(rowOf);setRows(r);setBaseline(JSON.stringify(r));};
 useEffect(()=>{const p=new AbortController();setError('');void(async()=>{try{
  const v=parseCompanyPartners(await controller.system(PARTNERS_PATH,{method:'GET',signal:p.signal}));if(p.signal.aborted)return;setView(v);accept(v.record?.partners??[]);
 }catch(e){if(!p.signal.aborted&&!aborted(e))setError(statusOf(e)===403?'Somente administradores consultam os dados dos sócios.':'Não foi possível carregar os dados dos sócios.');}})();return()=>p.abort();},[controller,reload]);
 const run=async(a:Attempt)=>{if(busy||attempt.current!==a)return;setBusy(true);setError('');setNotice('');try{
  const r=parseCompanyPartnersResult(await controller.system(PARTNERS_PATH,{method:'POST',body:a.body}),a.body);if(!alive.current||attempt.current!==a)return;
  attempt.current=null;setPending(false);setView(v=>v&&{...v,record:r.record});accept(r.record.partners);setNotice(r.replayed?'Dados conferidos: a alteração já estava salva.':'Dados dos sócios salvos.');
 }catch(e){if(!alive.current||attempt.current!==a||aborted(e))return;const s=statusOf(e);
  // The SQL replays a recorded command before checking the version and the data: a 400 or 409 to the same command proves it was
  // never recorded. A 403 comes before the replay, so on Conferir resultado it stays uncertain.
  if(s!==null&&(a.uncertain?[400,409]:[400,403,409]).includes(s)){attempt.current=null;setPending(false);
   setError(s===409?'Os dados mudaram desde a consulta. Nada foi salvo; recarregue para conferir.':s===403?'Nada foi salvo. Somente administradores alteram os dados dos sócios.':'Nada foi salvo. Confira os campos.');}
  else{a.uncertain=true;setPending(true);setError('Não foi possível confirmar se os dados foram salvos. Confira o resultado do mesmo comando antes de editar de novo.');}
 }finally{if(alive.current)setBusy(false);}};
 const save=()=>{if(!view||busy||attempt.current)return;let partners;
  try{partners=normalizeCompanyPartners(dataOf(rows));}catch{setError('Confira os sócios: nome obrigatório, CPF válido e sem repetir, participação de 0 a 100% (no total até 100%), e-mail e telefone.');return;}
  const a:Attempt={body:captureCompanyPartnersSave({command_id:crypto.randomUUID(),expected_version:view.record?.version??0,partners}),uncertain:false};attempt.current=a;void run(a);};
 const set=(i:number,patch:Partial<Row>)=>{if(!busy&&!pending)setRows(list=>list.map((r,j)=>j===i?{...r,...patch}:r));};
 const locked=!view||busy||pending;
 const cell=(i:number,key:keyof Row,label:string,max:number,mode?:'numeric'|'decimal'|'email'|'tel')=><td><input id={`company-partner-${key}-${i}`} aria-label={`${label} do sócio ${i+1}`} maxLength={max}
  inputMode={mode==='numeric'||mode==='decimal'?mode:undefined} type={mode==='email'?'email':mode==='tel'?'tel':'text'} value={rows[i]![key]} onChange={e=>set(i,{[key]:e.target.value})}/></td>;
 return <section className="real-editor company-settings-section company-partners" aria-labelledby="company-partners-title">
  <header className="real-editor-heading"><div><h2 id="company-partners-title">Dados do sócio(s)</h2><p>{view?.record?`Versão ${view.record.version}`:'Nenhum sócio informado'}. Só administradores consultam e alteram.</p></div></header>
  {error&&<p className="real-alert" role="alert">{error}{!view&&<button type="button" className="text-button" onClick={()=>setReload(n=>n+1)}>Tentar novamente</button>}</p>}{notice&&<p className="real-success" role="status">{notice}</p>}
  {pending&&attempt.current&&<section className="real-notice" aria-label="Confirmação pendente"><p>O resultado precisa ser confirmado. Os campos ficam preservados.</p><button type="button" className="primary-button" disabled={busy} onClick={()=>void run(attempt.current!)}>Conferir resultado</button></section>}
  {view&&<form onSubmit={e=>{e.preventDefault();save();}}><fieldset className="company-partners-fields" disabled={locked}><legend className="real-sr-only">Sócios</legend>
   <div className="table-scroll" role="region" aria-label="Sócios" tabIndex={0}><table className="data-table"><thead><tr><th scope="col">Nome *</th><th scope="col">CPF *</th><th scope="col">Participação (%)</th><th scope="col">Cargo</th>
    <th scope="col">E-mail</th><th scope="col">Telefone</th><th scope="col"><span className="sr-only">Ações</span></th></tr></thead>
    <tbody>{rows.map((r,i)=><tr key={i}>{cell(i,'name','Nome',120)}<td><input id={`company-partner-cpf-${i}`} aria-label={`CPF do sócio ${i+1}`} maxLength={14} inputMode="numeric" value={r.cpf} onChange={e=>set(i,{cpf:e.target.value})}/>
      {/^[0-9]{11}$/.test(r.cpf.replace(/[.-]/g,''))&&<small>{cpfText(r.cpf.replace(/[.-]/g,''))}</small>}</td>
     {cell(i,'share','Participação',6,'decimal')}{cell(i,'role','Cargo',60)}{cell(i,'email','E-mail',254,'email')}{cell(i,'phone','Telefone',20,'tel')}
     <td><button type="button" className="text-button" aria-label={`Remover sócio ${i+1}`} onClick={()=>{if(!busy&&!pending)setRows(list=>list.filter((_,j)=>j!==i));}}>Remover</button></td></tr>)}</tbody></table></div>
   {!rows.length&&<p className="real-help">Nenhum sócio informado.</p>}
   <button type="button" className="text-button" disabled={rows.length>=PARTNER_LIMIT} onClick={()=>setRows(list=>[...list,blank()])}><Icon name="plus" size={10}/>Adicionar sócio</button>
  </fieldset>
  <p className="real-help">(*) Campos obrigatórios</p>
  <div className="real-editor-actions"><button type="submit" className="primary-button" disabled={locked||!dirty}>Salvar</button>
   <button type="button" className="secondary-button" disabled={busy||pending||!dirty} onClick={()=>setRows(JSON.parse(baseline) as Row[])}>Cancelar</button></div></form>}
 </section>;
}
