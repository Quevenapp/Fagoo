/** Closed 148 contract, shared by the API boundary and the browser (routes under /v1/sistema):
 * Gerenciador de transições: situações (default and custom) and transitions of Pedidos de Venda, Pedidos de Compra and
 * Ordem de Serviço, with the commands Criar/Editar situação, Editar/Criar transição and Excluir selecionados.
 * The tag groups and tags of 148 were retired by migration 185: Suprimentos > Gerenciar grupos de tags and Gerenciar tags
 * open the product tag screens (/grupos-tags and /tags, migration 119). */
export const SITUATION_KINDS=Object.freeze(['sales_orders','purchase_orders','service_orders']);
export const SITUATION_KIND_LABELS=Object.freeze({sales_orders:'Pedidos de Venda',purchase_orders:'Pedidos de Compra',service_orders:'Ordem de Serviço'});
export const TRANSITION_ACTIONS=Object.freeze(['reverse_stock','reverse_finance','post_stock','post_finance']);
export const TRANSITION_ACTION_LABELS=Object.freeze({reverse_stock:'Estornar estoque',reverse_finance:'Estornar contas',post_stock:'Lançar estoque',post_finance:'Lançar contas'});
export const SITUATION_LIMIT=30;
export const FRAMEWORK_BODY_BYTES=16384;
export class FrameworkContractError extends Error{constructor(status,code){super(code);this.status=status;this.code=code;}}
const fail=(status=502,code='ERP_UPSTREAM_INVALID_RESPONSE')=>{throw new FrameworkContractError(status,code);};
const need=(v,...e)=>{if(!v)fail(...e);};
const input=v=>need(v,400,'ERP_INVALID_INPUT'),query=v=>need(v,400,'ERP_INVALID_QUERY');
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const keys=(v,list)=>plain(v)&&Object.keys(v).length===list.length&&list.every(k=>Object.hasOwn(v,k));
const exact=(v,list,...e)=>need(keys(v,list),...e);
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,BASE=/^[a-z_]{2,40}$/,COLOR=/^#[0-9a-f]{6}$/,CONTROL=/[\u0000-\u001f\u007f]/;
export const frameworkUuid=v=>typeof v==='string'&&UUID.test(v);
const name=(v,max)=>typeof v==='string'&&[...v].length>=1&&[...v].length<=max&&v===v.trim()&&!CONTROL.test(v);
const version=v=>Number.isSafeInteger(v)&&v>=0&&v<=2147483647;
const stamp=v=>typeof v==='string'&&v.length<=40&&/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::\d{2})?)$/.test(v)&&Number.isFinite(Date.parse(v.replace(' ','T')));
const snapshot=raw=>{try{return JSON.parse(JSON.stringify(raw));}catch{return fail();}};
const situationKey=v=>typeof v==='string'&&(BASE.test(v)||UUID.test(v));
const sortedActions=a=>Array.isArray(a)&&a.length<=2&&a.every(x=>TRANSITION_ACTIONS.includes(x))&&new Set(a).size===a.length&&[...a].sort().every((x,i)=>x===a[i])
 &&!(a.includes('post_stock')&&a.includes('reverse_stock'))&&!(a.includes('post_finance')&&a.includes('reverse_finance'));

export function captureSituationsQuery(raw={}){query(plain(raw)&&Object.keys(raw).every(k=>k==='tipo'));const kind=raw.tipo??'sales_orders';query(SITUATION_KINDS.includes(kind));return Object.freeze({kind});}
/** Same base, or the document rule of the bases allows it (rules lists the destinations of each default situação). */
export function transitionAllowed(page,from,to){
 const a=page.situations.find(s=>s.key===from),b=page.situations.find(s=>s.key===to);
 return Boolean(a&&b&&a.key!==b.key&&(a.base_status===b.base_status||page.rules[a.base_status]?.includes(b.base_status)));
}
export function parseSituationsPage(raw,q){
 const v=snapshot(raw);exact(v,['scope','data_mode','kind','adopted','situations','rules','transitions']);
 need(v.scope==='situations_page'&&v.data_mode==='erp_native'&&v.kind===q.kind&&typeof v.adopted==='boolean'&&Array.isArray(v.situations)&&v.situations.length<=60&&plain(v.rules)&&Array.isArray(v.transitions)&&v.transitions.length<=600);
 const seen=new Set(),names=new Set(),defaults=new Set();
 for(const s of v.situations){exact(s,['key','base_status','name','color','default','active','version']);
  need(situationKey(s.key)&&!seen.has(s.key)&&BASE.test(s.base_status)&&name(s.name,40)&&!names.has(s.name.toLowerCase())&&COLOR.test(s.color)&&typeof s.default==='boolean'&&typeof s.active==='boolean'&&version(s.version));
  if(s.default){need(s.key===s.base_status&&s.active&&s.version===0&&!defaults.has(s.key));defaults.add(s.key);}else need(UUID.test(s.key)&&s.version>=1);
  seen.add(s.key);names.add(s.name.toLowerCase());}
 need(defaults.size>=1&&v.situations.filter(s=>!s.default).length<=SITUATION_LIMIT&&v.situations.every(s=>defaults.has(s.base_status)));
 need(Object.keys(v.rules).length===defaults.size);
 for(const [base,targets] of Object.entries(v.rules))need(defaults.has(base)&&Array.isArray(targets)&&targets.every(t=>defaults.has(t)&&t!==base)&&new Set(targets).size===targets.length);
 const pairs=new Set();
 for(const t of v.transitions){exact(t,['from','to','default','active','actions','version']);const pair=`${t.from}>${t.to}`;
  need(typeof t.from==='string'&&typeof t.to==='string'&&!pairs.has(pair)&&transitionAllowed(v,t.from,t.to)&&typeof t.default==='boolean'&&typeof t.active==='boolean'&&sortedActions(t.actions)&&version(t.version));
  need(t.default===(defaults.has(t.from)&&defaults.has(t.to)));
  if(t.default&&t.version===0)need(t.active&&t.actions.length===0);if(!t.default)need(t.version>=1);if(!v.adopted)need(t.actions.length===0);
  pairs.add(pair);}
 for(const [base,targets] of Object.entries(v.rules))for(const t of targets)need(pairs.has(`${base}>${t}`));
 return v;
}
/** POST /v1/sistema/situacoes: {command_id, kind, id (null = Criar nova situação), expected_version, data:{base_status,name,color,active}}. */
export function captureSituationSave(raw){
 const v=snapshot(raw);input(keys(v,['command_id','kind','id','expected_version','data'])&&frameworkUuid(v.command_id)&&SITUATION_KINDS.includes(v.kind)&&(v.id===null||frameworkUuid(v.id))
  &&version(v.expected_version)&&v.expected_version<=2147483646&&(v.id===null)===(v.expected_version===0));
 input(keys(v.data,['base_status','name','color','active'])&&BASE.test(v.data.base_status)&&name(v.data.name,40)&&COLOR.test(v.data.color)&&typeof v.data.active==='boolean'&&(v.id!==null||v.data.active));
 return Object.freeze({command_id:v.command_id,kind:v.kind,id:v.id,expected_version:v.expected_version,data:Object.freeze({...v.data})});
}
/** POST /v1/sistema/transicoes: {command_id, kind, from, to, expected_version, data:{active, actions}} (actions sorted alphabetically, as the SQL keeps them). */
export function captureTransitionSave(raw){
 const v=snapshot(raw);input(keys(v,['command_id','kind','from','to','expected_version','data'])&&frameworkUuid(v.command_id)&&SITUATION_KINDS.includes(v.kind)&&situationKey(v.from)&&situationKey(v.to)&&v.from!==v.to&&version(v.expected_version));
 input(keys(v.data,['active','actions'])&&typeof v.data.active==='boolean'&&sortedActions(v.data.actions));
 return Object.freeze({command_id:v.command_id,kind:v.kind,from:v.from,to:v.to,expected_version:v.expected_version,data:Object.freeze({active:v.data.active,actions:Object.freeze([...v.data.actions])})});
}
/** POST /v1/sistema/transicoes/exclusao: {command_id, kind, items:[{from,to,expected_version}]} — custom transitions only. */
export function captureTransitionsDelete(raw){
 const v=snapshot(raw);input(keys(v,['command_id','kind','items'])&&frameworkUuid(v.command_id)&&SITUATION_KINDS.includes(v.kind)&&Array.isArray(v.items)&&v.items.length>=1&&v.items.length<=100);
 const pairs=new Set();for(const i of v.items){input(keys(i,['from','to','expected_version'])&&situationKey(i.from)&&situationKey(i.to)&&i.from!==i.to&&version(i.expected_version)&&i.expected_version>=1&&!pairs.has(`${i.from}>${i.to}`));pairs.add(`${i.from}>${i.to}`);}
 return Object.freeze({command_id:v.command_id,kind:v.kind,items:Object.freeze(v.items.map(i=>Object.freeze({from:i.from,to:i.to,expected_version:i.expected_version})))});
}
const RECEIPT=['command_id','action','kind','target','count','changed_at'];
/** Receipt of a situations command; `action` is the operation the input implies. */
export function parseSituationsResult(raw,sent,action){
 const v=snapshot(raw);exact(v,['scope','data_mode','receipt','replayed']);need(v.scope==='situations_command'&&v.data_mode==='erp_native'&&typeof v.replayed==='boolean');
 const r=v.receipt;exact(r,RECEIPT);need(r.command_id===sent.command_id&&r.kind===sent.kind&&stamp(r.changed_at));
 if(action==='situation'){need(r.action===(sent.id===null?'situation_create':'situation_update')&&frameworkUuid(r.target)&&(sent.id===null||r.target===sent.id)&&r.count===1);}
 else if(action==='transition')need(r.action==='transition_save'&&r.target===`${sent.from}>${sent.to}`&&r.count===1);
 else need(r.action==='transitions_delete'&&r.target===null&&r.count===sent.items.length);
 return v;
}

