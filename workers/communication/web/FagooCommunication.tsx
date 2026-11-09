import React,{useEffect,useMemo,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {App} from './main';
import {TeamPanel} from './TeamPanel';
import {WhatsAppConversation} from './WhatsAppConversation';
import baseCss from './style.css?inline';
import workspaceCss from './workspace.css?inline';
import setupCss from './setup-wizard.css?inline';
import routerCss from './router-workspace.css?inline';
import pairingCss from './pairing.css?inline';
import {communicationPath,rawCommunicationOptions} from './fagoo-transport';
type Context={user_id:string;role:string;units:{id:string;name:string;capabilities:string[];team_ids:string[]}[]};
type Props={controller:{communication:(path:string,options?:any)=>Promise<any>};context:Context;unitId:string;initialPage?:string};
/** Embedded React, not another browser session. The parent owns every authenticated request. */
export function FagooCommunication(props:Props){
 const host=useRef<HTMLDivElement>(null),[shadow,setShadow]=useState<ShadowRoot|null>(null);
 useEffect(()=>{if(host.current)setShadow(host.current.shadowRoot || host.current.attachShadow({mode:'open'}));},[]);
 return <div ref={host}>{shadow && createPortal(<><style>{(baseCss+workspaceCss+setupCss+routerCss+pairingCss).replaceAll(":root",":host")+`:host{display:block;color:#17362d;font-family:system-ui,sans-serif}.app-shell{min-height:70vh}.fagoo-managed .sidebar-bottom a,.fagoo-managed .sidebar-bottom button,.fagoo-managed button[title="Novo perfil"]{display:none}.fagoo-inbox{padding:20px}.fagoo-inbox nav{display:flex;gap:12px;margin-bottom:18px}.fagoo-inbox .work{display:grid;grid-template-columns:minmax(180px,30%) 1fr;gap:18px}.fagoo-inbox .thread{padding:12px;width:100%;text-align:left}.fagoo-inbox [role=alert]{color:#a22}@media(max-width:700px){.fagoo-inbox .work{display:block}}`}</style><Workspace key={`${props.context.user_id}:${props.unitId}`} {...props}/></>,shadow)}</div>;
}
function Workspace({controller,context,unitId,initialPage}:Props){
 const unit=context.units.find(u=>u.id===unitId);
 const lifetime=useMemo(()=>new AbortController(),[controller,unitId,context.user_id]);
 useEffect(()=>()=>lifetime.abort(),[lifetime]);
 const api=useMemo(()=>{
  const prefix=`/v1/communication/units/${unitId}`;
  const path=(value:string)=>communicationPath(value,unitId);
  const me={id:context.user_id,name:'Usuário Fagoo',role:unit?.capabilities.includes('communication.configure')?'admin':'operator'};
  const call:any=async(value:string,method='GET',body?:unknown,signal?:AbortSignal,idempotencyKey?:string)=>{
   if(value==='v1/me')return me;
   if(value==='v1/profiles')return [{id:unitId,name:unit?.name || 'Unidade'}];
   if(value==='v1/users')return (await controller.communication(`${prefix}/team`,{signal:lifetime.signal})).data.filter((p:any)=>p.kind==='user').map((p:any)=>({...p,role:'operator',profiles:[unitId]}));
   if(/^v1\/(applications|keys)(\/|$)/.test(value))value=prefix+value.slice(2);
   return controller.communication(path(value),{method,body,signal:signal?AbortSignal.any([signal,lifetime.signal]):lifetime.signal,idempotencyKey:method==='GET'?undefined:idempotencyKey || crypto.randomUUID()});
  };
  call.raw=(value:string,options:RequestInit={})=>controller.communication(path(value),{...rawCommunicationOptions(options),signal:options.signal?AbortSignal.any([options.signal,lifetime.signal]):lifetime.signal});
  return call;
 },[controller,context.user_id,unitId,unit,lifetime]);
 if(!unit)return <p role="alert">Unidade indisponível.</p>;
 if(unit.capabilities.includes('communication.configure'))return <><IntegratedSettings api={api} unitId={unitId}/><App managedContext={{api,initialPage:initialPage && !['users','contacts','system'].includes(initialPage)?initialPage:'overview'}}/></>;
 return <Inbox api={api} unit={unit} userId={context.user_id}/>;
}
const resourceLabels:Record<string,string>={contacts:'Contatos',products:'Produtos',sales_orders:'Pedidos de venda',purchase_orders:'Pedidos de compra',sales_proposals:'Propostas',receivables:'Contas a receber',payables:'Contas a pagar',nfe:'Notas fiscais',nfce:'Cupons fiscais'};
function IntegratedSettings({api,unitId}:{api:any;unitId:string}){
 const root=`v1/profiles/${unitId}`;
 const [open,setOpen]=useState(false),[sources,setSources]=useState<any>({numbers:[],pools:[]}),[route,setRoute]=useState(''),[bots,setBots]=useState<any[]>([]),[policies,setPolicies]=useState<any[]>([]),[permissions,setPermissions]=useState<string[]>([]),[bot,setBot]=useState(''),[resources,setResources]=useState<string[]>([]),[required,setRequired]=useState<string[]>([]),[enabled,setEnabled]=useState(true),[error,setError]=useState(''),[notice,setNotice]=useState('');
 useEffect(()=>{if(!open)return;let alive=true;Promise.all([api(root+'/router'),api(root+'/queue-routing'),api(root+'/bots'),api(root+'/bot-policies')]).then(([source,routing,b,policy])=>{if(!alive)return;setSources(source);setRoute(routing.route?`${routing.route.source_type}:${routing.route.source_id}`:'');setBots(b.data || []);setPolicies(policy.data);setPermissions(policy.permission_keys || []);}).catch((e:any)=>{if(alive)setError(e.message);});return()=>{alive=false;};},[api,open]);
 function choose(id:string){const p=policies.find(p=>p.bot_id===id);setBot(id);setResources(p?.required_resources || []);setRequired(p?.required_permissions || []);setEnabled(p?.enabled ?? true);setNotice('');}
 async function saveRoute(){try{const split=route.indexOf(':');await api(root+'/queue-routing','PUT',{source_type:route.slice(0,split),source_id:route.slice(split+1)});setNotice('Rota de avisos salva.');setError('');}catch(e:any){setError(e.message);}}
 async function saveBot(){try{const p=await api(root+'/bot-policies','POST',{bot_id:bot,required_capabilities:['team.chat'],required_resources:resources,required_permissions:required,enabled});setPolicies(old=>[...old.filter(p=>p.bot_id!==bot),p]);setNotice('Permissões do bot salvas.');setError('');}catch(e:any){setError(e.message);}}
 return <details className="card" open={open} onToggle={e=>setOpen(e.currentTarget.open)}><summary>Integração com filas e permissões dos bots</summary>{open&&<div className="fagoo-inbox">{error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}<h3>Avisos da fila por WhatsApp</h3><p>Os avisos usam somente a janela aberta pelo cliente e a franquia gratuita configurada.</p><select aria-label="Linha ou grupo de avisos" value={route} onChange={e=>setRoute(e.target.value)}><option value="">Selecione uma linha ou grupo</option>{sources.pools.map((p:any)=><option key={'pool:'+p.id} value={'pool:'+p.id}>{p.name} · grupo</option>)}{sources.numbers.map((n:any)=><option key={'number:'+n.id} value={'number:'+n.id}>{n.name || n.number} · linha</option>)}</select><button disabled={!route} onClick={()=>void saveRoute()}>Salvar rota</button><h3>Acesso aos bots internos</h3><p>Selecione tudo o que o bot pode consultar ou alterar. Só pessoas autorizadas a todos esses recursos poderão conversar com ele.</p><select aria-label="Bot interno" value={bot} onChange={e=>choose(e.target.value)}><option value="">Selecione um bot</option>{bots.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select>{bot&&<><label><input type="checkbox" checked={enabled} onChange={e=>setEnabled(e.target.checked)}/> Disponível no chat interno</label><fieldset><legend>Recursos do Fagoo exigidos pelo bot</legend>{Object.entries(resourceLabels).map(([key,label])=><label key={key}><input type="checkbox" checked={resources.includes(key)} onChange={e=>setResources(old=>e.target.checked?[...old,key]:old.filter(x=>x!==key))}/>{label}</label>)}</fieldset><details><summary>Permissões específicas</summary><select multiple aria-label="Permissões específicas do bot" value={required} onChange={e=>setRequired(Array.from(e.target.selectedOptions,o=>o.value))}>{permissions.map(p=><option key={p} value={p}>{p.replaceAll('_',' ').replaceAll('.',' › ')}</option>)}</select></details><button onClick={()=>void saveBot()}>Salvar permissões</button></>}</div>}</details>;
}
function Inbox({api,unit,userId}:{api:any;unit:Context['units'][number];userId:string}){
 const [tab,setTab]=useState(unit.capabilities.includes('communication.read')?'whatsapp':'team');
 const [rows,setRows]=useState<any[]>([]),[queue,setQueue]=useState<any[]>([]),[selected,setSelected]=useState<any>(null),[error,setError]=useState('');
 const root=`v1/profiles/${unit.id}`;
 async function load(){try{if(tab==='team')return;const [mine,waiting]=await Promise.all([api(root+'/conversations'),unit.capabilities.includes('communication.claim')?api(root+'/queue'):Promise.resolve({data:[]})]);setRows(mine.data);setQueue(waiting.data);if(selected){try{setSelected(await api(root+'/conversations/'+selected.conversation.id));}catch{setSelected(null);}}setError('');}catch(e:any){setError(e.message || 'Sem conexão.');setSelected(null);}}
 useEffect(()=>{void load();const timer=setInterval(()=>void load(),2000);return()=>clearInterval(timer);},[api,tab,selected?.conversation.id]);
 async function open(id:string){try{setSelected(await api(root+'/conversations/'+id));setError('');}catch(e:any){setError(e.message);setSelected(null);}}
 async function claim(id:string){try{await api(root+'/conversations/'+id+'/actions','POST',{action:'claim'});await open(id);await load();}catch(e:any){setError(e.message);}}
 return <section className="fagoo-inbox"><nav>{unit.capabilities.includes('communication.read')&&<button onClick={()=>setTab('whatsapp')}>WhatsApp</button>}{unit.capabilities.includes('team.chat')&&<button onClick={()=>setTab('team')}>Conversa interna</button>}</nav>{error&&<p role="alert">{error}</p>}{tab==='team'?<TeamPanel api={api} root={root} demo={false} me={{id:userId,role:'operator'}}/>:<div className="work"><aside><h3>Meus atendimentos</h3>{rows.map(row=><button className="thread" key={row.id} onClick={()=>void open(row.id)}>{row.contact_name || row.title || row.phone || 'Atendimento'}</button>)}{queue.length>0&&<><h3>Disponíveis para assumir</h3>{queue.map(row=><button className="thread" key={row.id} onClick={()=>void claim(row.id)}>Assumir · {new Date(row.created).toLocaleTimeString('pt-BR')}</button>)}</>}</aside><div>{selected?<WhatsAppConversation selection={selected} api={api} root={root} me={{id:userId,role:'operator'}} refresh={load} demo={false}/>:<p>Selecione um atendimento.</p>}</div></div>}</section>;
}
export default FagooCommunication;
