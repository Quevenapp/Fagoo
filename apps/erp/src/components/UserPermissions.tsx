import {useState} from 'react';
import {PERMISSION_TABS,permissionHint,permissionStatus,type PermissionCard,type PermissionTab} from '../../../../packages/erp-domain/src/user-permissions.mjs';

const STATUS_TEXT={applied:'Aplicada',stored:'Guardada',admin:'Perfil Administrador'} as const;
const STATUS_HINT={applied:'O FAGOO já segue esta permissão.',stored:'Guardada: o FAGOO ainda não segue esta permissão; ela passa a valer quando o módulo adotar a chave.',
 admin:'No FAGOO, esta tela é do perfil Administrador; os outros perfis não a abrem.'} as const;
const keysOf=(tabId:string,c:PermissionCard)=>{const base=`${tabId}.${c.key}`;return[base,...(c.ie?[`${base}.ie`]:[]),...(c.ex?[`${base}.ex`]:[]),...c.subs.map(s=>`${base}.${s.key}`)];};
const tabKeys=(t:PermissionTab)=>t.cards.filter(c=>!c.admin).flatMap(c=>keysOf(t.id,c));

/**
 * Permissões in the 9 Origin tabs: "Selecionar todos" per tab; each module is a card with its checkbox, "Inclusão e edição" and
 * "Exclusão" on the same line and the sub-permissions indented, disabled until the module is checked. Each checkbox has the
 * Origin tooltip; each card says whether Brufap already follows it (Aplicada) or only keeps it (Guardada).
 */
export default function UserPermissions({value,onChange,disabled=false}:{value:readonly string[];onChange:(keys:string[])=>void;disabled?:boolean}){
 const [tab,setTab]=useState(PERMISSION_TABS[0]!.id);
 const current=PERMISSION_TABS.find(t=>t.id===tab)!,all=tabKeys(current),set=new Set(value);
 const toggle=(key:string,on:boolean,card:PermissionCard)=>{
  const base=`${current.id}.${card.key}`;let next=value.filter(k=>k!==key);
  if(on)next=[...next,key];else if(key===base)next=next.filter(k=>!k.startsWith(`${base}.`));
  onChange(next);
 };
 const checkAll=(on:boolean)=>onChange(on?[...value.filter(k=>!all.includes(k)),...all]:value.filter(k=>!all.includes(k)));
 const box=(key:string,label:string,card:PermissionCard,parentOn:boolean,className?:string)=>{const status=permissionStatus(key)!,locked=disabled||card.admin||!parentOn;
  return <label key={key} className={className} title={`${permissionHint(key)}. ${STATUS_HINT[status]}`}><input type="checkbox" id={`perm-${key.replaceAll('.','-')}`} checked={!card.admin&&set.has(key)} disabled={locked}
   onChange={e=>toggle(key,e.target.checked,card)}/><span>{label}</span>{className==='perm-module'&&<small className={`perm-status perm-${status}`} title={STATUS_HINT[status]}>{STATUS_TEXT[status]}</small>}</label>;};
 return <section className="user-permissions" aria-label="Permissões">
  <div className="perm-tabs" role="tablist" aria-label="Permissões">{PERMISSION_TABS.map(t=><button key={t.id} type="button" role="tab" aria-selected={t.id===tab} className={t.id===tab?'is-active':undefined}
   onClick={()=>setTab(t.id)}>{t.label}</button>)}</div>
  <div role="tabpanel" aria-label={current.label}>
   <label className="perm-all"><input type="checkbox" id={`perm-all-${current.id}`} disabled={disabled||!all.length} checked={all.length>0&&all.every(k=>set.has(k))} onChange={e=>checkAll(e.target.checked)}/><span>Selecionar todos</span></label>
   <div className="perm-cards">{current.cards.map(card=>{const base=`${current.id}.${card.key}`,on=!card.admin&&set.has(base);
    return <article key={card.key} className={`perm-card${on?' is-on':''}${card.admin?' is-admin':''}`}>
     <div className="perm-line">{box(base,card.label,card,true,'perm-module')}{card.ie&&box(`${base}.ie`,'Inclusão e edição',card,on)}{card.ex&&box(`${base}.ex`,'Exclusão',card,on)}</div>
     {card.subs.length>0&&<div className="perm-subs">{card.subs.map(s=>box(`${base}.${s.key}`,s.label,card,on))}</div>}
     {card.admin&&<p className="real-help">{STATUS_HINT.admin}</p>}
    </article>;})}</div>
  </div>
 </section>;
}
