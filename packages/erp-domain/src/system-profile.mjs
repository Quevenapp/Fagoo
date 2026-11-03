/** Closed151 contract: Meu perfil, Armazenamento, Notificações (sino), Dados da empresa (extra) and the Usuários security
 * view, shared by the API boundary and the browser. Routes live under /v1/sistema. */
import { documentNativeCoverage } from './document-mirror.mjs';
export const SYSTEM_BASE='/v1/sistema';
export const SYSTEM_BODY_BYTES=16384;
// 187 adds Cliente a ser visitado and Produto com data de validade próxima (Origin) and Certificado A1 próximo do vencimento; 283 (mixed
// lane, wave F) Lote próximo ao vencimento, from the lots of the stock (258).
export const NOTIFICATION_TYPES=Object.freeze(['contas_pagar_atrasadas','contas_receber_atrasadas','estoque_abaixo_minimo','estoque_maximo','estoque_zerado','pagamento_efetuado','pagamento_recebido','proximo_contato','cliente_visitado','validade','certificado_a1','lote_vencimento']);
export const NOTIFICATION_LABELS=Object.freeze({contas_pagar_atrasadas:'Contas a pagar atrasadas',contas_receber_atrasadas:'Contas a receber atrasadas',estoque_abaixo_minimo:'Estoque disponível abaixo do mínimo',
 estoque_maximo:'Estoque disponível chegou ao máximo',estoque_zerado:'Estoque disponível zerado ou negativo',pagamento_efetuado:'Pagamento efetuado',pagamento_recebido:'Pagamento recebido',proximo_contato:'Próximo contato proposta comercial',
 cliente_visitado:'Cliente a ser visitado',validade:'Produto com data de validade próxima',certificado_a1:'Certificado A1 próximo do vencimento',lote_vencimento:'Lote próximo ao vencimento'});
export const NOTIFICATION_ROLES=Object.freeze({contas_pagar_atrasadas:['admin','consulta','financeiro'],contas_receber_atrasadas:['admin','consulta','financeiro'],pagamento_efetuado:['admin','consulta','financeiro'],
 pagamento_recebido:['admin','consulta','financeiro'],estoque_abaixo_minimo:['admin','consulta','vendas','estoque','fiscal'],estoque_maximo:['admin','consulta','vendas','estoque','fiscal'],
 estoque_zerado:['admin','consulta','vendas','estoque','fiscal'],proximo_contato:['admin','consulta','financeiro','vendas'],
 cliente_visitado:['admin','consulta','vendas','financeiro','estoque','fiscal'],validade:['admin','consulta','vendas','estoque','fiscal'],certificado_a1:['admin','fiscal'],
 lote_vencimento:['admin','consulta','vendas','estoque','fiscal']});
export const STORAGE_GROUPS=Object.freeze(['anexos','fiscal','cobranca','backup','certificado','outros']);
export const ROLES=Object.freeze(['admin','consulta','vendas','financeiro','estoque','fiscal']);
export class SystemContractError extends Error{constructor(status,code){super(code);this.status=status;this.code=code;}}
const fail=(status=502,code='ERP_UPSTREAM_INVALID_RESPONSE')=>{throw new SystemContractError(status,code);};
const need=(v,...e)=>{if(!v)fail(...e);};
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const exact=(v,keys,...e)=>need(plain(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)),...e);
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,CONTROL=/[\u0000-\u001f\u007f]/;
export const systemUuid=v=>typeof v==='string'&&UUID.test(v);
const text=(v,max)=>typeof v==='string'&&[...v].length>=1&&[...v].length<=max&&!CONTROL.test(v);
const ntext=(v,max)=>v===null||text(v,max);
const int=v=>Number.isSafeInteger(v)&&v>=0&&v<=2147483647;
const bytes=v=>typeof v==='string'&&/^(0|[1-9][0-9]{0,17})$/.test(v);
const money=v=>typeof v==='string'&&/^(0|[1-9][0-9]{0,15})\.[0-9]{2}$/.test(v);
const day=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(`${v}T00:00:00Z`));
const stamp=v=>typeof v==='string'&&v.length<=40&&/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::\d{2})?)$/.test(v)&&Number.isFinite(Date.parse(v.replace(' ','T')));
const snapshot=raw=>{try{return JSON.parse(JSON.stringify(raw));}catch{return fail();}};

export function parseProfile(raw){
 const v=snapshot(raw);exact(v,['scope','data_mode','user_id','role','name','email','company']);
 need(v.scope==='access_profile'&&v.data_mode==='erp_native'&&systemUuid(v.user_id)&&ROLES.includes(v.role)&&ntext(v.name,120)&&ntext(v.email,254)&&(v.email===null||/^[^@ ]+@[^@ ]+\.[^@ ]+$/.test(v.email)));
 if(v.company!==null){exact(v.company,['legal_name','trade_name']);need(ntext(v.company.legal_name,200)&&ntext(v.company.trade_name,200));}
 return v;
}
export function parseStorage(raw){
 const v=snapshot(raw);exact(v,['scope','data_mode','total_bytes','objects','limit_bytes','groups','as_of']);
 // 188: limit_bytes is the limit the administrador set in Espaço e armazenamento (null: no limit).
 need(v.scope==='storage_usage'&&v.data_mode==='erp_native'&&bytes(v.total_bytes)&&int(v.objects)&&(v.limit_bytes===null||bytes(v.limit_bytes)&&v.limit_bytes!=='0')&&stamp(v.as_of));
 if(v.groups!==null){need(Array.isArray(v.groups)&&v.groups.length===STORAGE_GROUPS.length);let total=0n,objects=0;
  v.groups.forEach((g,i)=>{exact(g,['group','bytes','objects']);need(g.group===STORAGE_GROUPS[i]&&bytes(g.bytes)&&int(g.objects));total+=BigInt(g.bytes);objects+=g.objects;});
  need(total===BigInt(v.total_bytes)&&objects===v.objects);}
 return v;
}
export const NOTIFICATION_TABS=Object.freeze(['nao_lidas','todas']);
export function captureNotificationsQuery(input={}){need(plain(input)&&Object.keys(input).every(k=>k==='aba'),400,'ERP_INVALID_QUERY');const tab=input.aba??'nao_lidas';need(NOTIFICATION_TABS.includes(tab),400,'ERP_INVALID_QUERY');return Object.freeze({tab});}
function notification(n,role){exact(n,['id','type','day','quantity','amount','created_at','read']);
 need(/^[1-9][0-9]{0,17}$/.test(n.id)&&NOTIFICATION_TYPES.includes(n.type)&&NOTIFICATION_ROLES[n.type].includes(role)&&day(n.day)&&Number.isSafeInteger(n.quantity)&&n.quantity>0&&(n.amount===null||money(n.amount))&&stamp(n.created_at)&&typeof n.read==='boolean');
 need(['estoque_abaixo_minimo','estoque_maximo','estoque_zerado','proximo_contato','cliente_visitado','validade','certificado_a1'].includes(n.type)===(n.amount===null));}
export function parseNotifications(raw,q){
 const v=snapshot(raw);exact(v,['scope','data_mode','tab','role','business_date','unread','items']);
 need(v.scope==='notifications'&&v.data_mode==='erp_native'&&v.tab===q.tab&&ROLES.includes(v.role)&&day(v.business_date)&&int(v.unread)&&Array.isArray(v.items)&&v.items.length<=100);
 const ids=new Set();for(const n of v.items){notification(n,v.role);need(!ids.has(n.id)&&(q.tab==='todas'||!n.read));ids.add(n.id);}
 if(q.tab==='nao_lidas')need(v.items.length===Math.min(v.unread,100));
 return v;
}
/** POST /v1/sistema/notificacoes/lidas: {command_id, ids} (ids null = Marcar todas como lida). */
export function captureNotificationsRead(raw){
 const v=snapshot(raw);exact(v,['command_id','ids'],400,'ERP_INVALID_INPUT');
 need(systemUuid(v.command_id)&&(v.ids===null||Array.isArray(v.ids)&&v.ids.length>=1&&v.ids.length<=100&&v.ids.every(i=>typeof i==='string'&&/^[1-9][0-9]{0,17}$/.test(i))&&new Set(v.ids).size===v.ids.length),400,'ERP_INVALID_INPUT');
 return Object.freeze({command_id:v.command_id,ids:v.ids===null?null:Object.freeze([...v.ids])});
}
export function parseNotificationsRead(raw,input){
 const v=snapshot(raw);exact(v,['scope','data_mode','receipt','view','replayed']);
 need(v.scope==='notifications_command'&&v.data_mode==='erp_native'&&typeof v.replayed==='boolean');
 exact(v.receipt,['command_id','all','marked','changed_at']);need(v.receipt.command_id===input.command_id&&v.receipt.all===(input.ids===null)&&int(v.receipt.marked)&&stamp(v.receipt.changed_at));
 if(input.ids)need(v.receipt.marked<=input.ids.length);
 parseNotifications(v.view,{tab:'nao_lidas'});if(input.ids)need(v.view.items.every(n=>!input.ids.includes(n.id)));if(input.ids===null)need(v.view.unread===0||v.replayed);
 return v;
}

// Página inicial: "Produtos próximos da validade" (migration 187). Products whose Data de validade is up to N days ahead
// (Preferências › Cadastros › Configurações de produtos), already expired included, earliest first; at most 20 listed.
export const EXPIRY_LIMIT=20;
export function parseExpiring(raw){
 const v=snapshot(raw);exact(v,['scope','data_mode','business_date','days','total','items']);
 need(v.scope==='product_expiry'&&v.data_mode==='erp_native'&&day(v.business_date)&&Number.isSafeInteger(v.days)&&v.days>=0&&v.days<=9999&&int(v.total)&&Array.isArray(v.items)&&v.items.length===Math.min(v.total,EXPIRY_LIMIT));
 const limit=new Date(Date.parse(`${v.business_date}T00:00:00Z`)+v.days*86400000).toISOString().slice(0,10),ids=new Set();let prior='';
 for(const p of v.items){exact(p,['product_id','code','name','expiry_date','expired']);
  need(systemUuid(p.product_id)&&!ids.has(p.product_id)&&ntext(p.code,60)&&text(p.name,200)&&day(p.expiry_date)&&p.expiry_date<=limit&&p.expiry_date>=prior&&p.expired===(p.expiry_date<v.business_date));ids.add(p.product_id);prior=p.expiry_date;}
 return v;
}

// Página inicial: gráficos escolhidos por usuário (migration 189). Keys in Origin order of "Incluir gráficos" (Valores por dia is
// the chart Brufap already had).
export const HOME_CHARTS=Object.freeze(['resumo','ticket_medio','valor_faturado','quantidade_pedidos','top_skus']);
export const HOME_CHART_LABELS=Object.freeze({resumo:'Valores por dia',ticket_medio:'Ticket Médio',valor_faturado:'Valor Faturado',quantidade_pedidos:'Quantidade de pedidos de venda',top_skus:"Top 5 SKU's mais vendidos"});
/** Roles that read sales orders and products (erp_home.top_products_allowed): every role but financeiro. */
export const TOP_PRODUCT_ROLES=Object.freeze(['admin','consulta','vendas','estoque','fiscal']);
const availableCharts=role=>HOME_CHARTS.filter(k=>k!=='top_skus'||TOP_PRODUCT_ROLES.includes(role));
function chartsView(v){
 need(v.scope==='home_charts'&&v.data_mode==='erp_native'&&ROLES.includes(v.role)&&int(v.version)&&typeof v.customized==='boolean'&&v.customized===(v.version>0));
 const available=availableCharts(v.role);need(Array.isArray(v.available)&&v.available.length===available.length&&v.available.every((k,i)=>k===available[i]));
 need(Array.isArray(v.charts)&&v.charts.every(k=>available.includes(k))&&new Set(v.charts).size===v.charts.length);
}
export function parseHomeCharts(raw){const v=snapshot(raw);exact(v,['scope','data_mode','role','version','customized','charts','available']);chartsView(v);return v;}
/** POST /v1/sistema/graficos-inicio: {command_id, expected_version, charts} (the whole ordered list). */
export function captureHomeChartsSave(raw){
 const v=snapshot(raw);exact(v,['command_id','expected_version','charts'],400,'ERP_INVALID_INPUT');
 need(systemUuid(v.command_id)&&int(v.expected_version)&&v.expected_version<=2147483646&&Array.isArray(v.charts)&&v.charts.length<=HOME_CHARTS.length&&v.charts.every(k=>HOME_CHARTS.includes(k))&&new Set(v.charts).size===v.charts.length,400,'ERP_INVALID_INPUT');
 return Object.freeze({command_id:v.command_id,expected_version:v.expected_version,charts:Object.freeze([...v.charts])});
}
export function parseHomeChartsResult(raw,input){
 const v=snapshot(raw);exact(v,['scope','data_mode','role','version','customized','charts','available','receipt','replayed']);chartsView(v);need(typeof v.replayed==='boolean');
 exact(v.receipt,['command_id','version','charts','changed_at']);need(v.receipt.command_id===input.command_id&&v.receipt.version===input.expected_version+1&&stamp(v.receipt.changed_at));
 need(Array.isArray(v.receipt.charts)&&v.receipt.charts.length===input.charts.length&&v.receipt.charts.every((k,i)=>k===input.charts[i])&&v.version>=v.receipt.version);
 return v;
}
export const HOME_PERIOD_KEYS=Object.freeze(['hoje','7d','30d','3m','6m','12m','customizado']);
/** GET /v1/sistema/top-produtos?periodo=&de=&ate= (Top 5 SKU's of a home period). */
export function captureTopProductsQuery(input={}){
 need(plain(input)&&Object.keys(input).every(k=>['periodo','de','ate'].includes(k)),400,'ERP_INVALID_QUERY');
 const key=input.periodo,from=input.de??null,to=input.ate??null;need(HOME_PERIOD_KEYS.includes(key),400,'ERP_INVALID_QUERY');
 if(key==='customizado')need(day(from)&&day(to)&&from>='1900-01-01'&&to<='2100-12-31'&&from<=to&&(Date.parse(to)-Date.parse(from))/86400000<=365,400,'ERP_INVALID_QUERY');
 else need(from===null&&to===null,400,'ERP_INVALID_QUERY');
 return Object.freeze({key,from,to});
}
const qty=v=>typeof v==='string'&&/^(0|[1-9][0-9]{0,17})\.[0-9]{6}$/.test(v),centsText=v=>typeof v==='string'&&/^-?(0|[1-9][0-9]{0,29})$/.test(v);
export function parseTopProducts(raw,q){
 const v=snapshot(raw);let coverage;try{coverage=documentNativeCoverage(v);}catch{need(false);}
 if(coverage.origin)for(const key of ['origin','mirror_excluded_count','coverage'])delete v[key];
 exact(v,['scope','data_mode','key','from','to','items']);
 need(v.scope==='home_top_products'&&v.data_mode==='erp_native'&&v.key===q.key&&day(v.from)&&day(v.to)&&v.from<=v.to&&(q.key!=='customizado'||v.from===q.from&&v.to===q.to)&&Array.isArray(v.items)&&v.items.length<=5);
 const ids=new Set();let prior=null;
 for(const p of v.items){exact(p,['product_id','code','name','units','total_cents']);need(systemUuid(p.product_id)&&!ids.has(p.product_id)&&ntext(p.code,60)&&text(p.name,200)&&qty(p.units)&&centsText(p.total_cents));
  const units=BigInt(p.units.replace('.',''));need(prior===null||units<=prior);prior=units;ids.add(p.product_id);}
 return {...v,...coverage};
}

// Empresa › Dados do sócio(s) (migration 189): administrador only; CPF valid and once; participações up to 100,00% in total.
export const PARTNER_LIMIT=20;
const PARTNER_KEYS=['cpf','email','name','phone','role','share'];
const validCpfText=value=>{if(!/^[0-9]{11}$/.test(value)||/^([0-9])\1{10}$/.test(value))return false;for(const n of[9,10]){let sum=0;for(let i=1;i<=n;i++)sum+=Number(value[i-1])*(n+2-i);let d=(sum*10)%11;if(d===10)d=0;if(d!==Number(value[n]))return false;}return true;};
/** Same rules as erp_company.partners_normalize; returns the canonical list (CPF digits, share with 2 places, e-mail lower case). */
export function normalizeCompanyPartners(raw,status=400,code='ERP_INVALID_INPUT'){
 const list=snapshot(raw),ok=c=>need(c,status,code);ok(Array.isArray(list)&&list.length<=PARTNER_LIMIT);
 const t=(x,max,re)=>{if(x===null||x==='')return null;ok(typeof x==='string'&&[...x].length<=max&&x===x.trim()&&!CONTROL.test(x)&&(!re||re.test(x)));return x;};
 const cpfs=new Set();let total=0n;
 const out=list.map(p=>{exact(p,PARTNER_KEYS,status,code);ok(typeof p.cpf==='string');const cpf=p.cpf.replace(/[.-]/g,'');ok(validCpfText(cpf)&&!cpfs.has(cpf));cpfs.add(cpf);
  const name=t(p.name,120);ok(name!==null);const share=t(p.share,6,/^(0|[1-9][0-9]?|100)(\.[0-9]{1,2})?$/);
  let shareText=null;if(share!==null){const [w,f='']=share.split('.');shareText=`${w}.${f.padEnd(2,'0')}`;const cents=BigInt(shareText.replace('.',''));ok(cents<=10000n);total+=cents;}
  const email=t(p.email,254,/^[^@ ]+@[^@ ]+\.[^@ ]+$/);
  return{name,cpf,share:shareText,role:t(p.role,60),email:email?.toLowerCase()??null,phone:t(p.phone,20,/^\+?[0-9() -]{8,20}$/)};});
 ok(total<=10000n);return out;
}
function partnersRecord(r){if(r===null)return;exact(r,['version','partners','updated_at']);need(int(r.version)&&r.version>=1&&stamp(r.updated_at));
 const n=normalizeCompanyPartners(r.partners,502,'ERP_UPSTREAM_INVALID_RESPONSE');need(sameJson(r.partners.map(p=>Object.fromEntries(PARTNER_KEYS.map(k=>[k,p[k]]))),n.map(p=>Object.fromEntries(PARTNER_KEYS.map(k=>[k,p[k]])))));}
export function parseCompanyPartners(raw){const v=snapshot(raw);exact(v,['scope','data_mode','record']);need(v.scope==='company_partners'&&v.data_mode==='erp_native');partnersRecord(v.record);return v;}
/** POST /v1/sistema/empresa-socios: {command_id, expected_version, partners}. */
export function captureCompanyPartnersSave(raw){
 const v=snapshot(raw);exact(v,['command_id','expected_version','partners'],400,'ERP_INVALID_INPUT');
 need(systemUuid(v.command_id)&&int(v.expected_version)&&v.expected_version<=2147483646,400,'ERP_INVALID_INPUT');normalizeCompanyPartners(v.partners);
 return Object.freeze({command_id:v.command_id,expected_version:v.expected_version,partners:v.partners});
}
export function parseCompanyPartnersResult(raw,input){
 const v=snapshot(raw);exact(v,['scope','data_mode','receipt','record','replayed']);need(v.scope==='company_partners_command'&&v.data_mode==='erp_native'&&typeof v.replayed==='boolean');
 exact(v.receipt,['command_id','from_version','to_version','changed_at']);need(v.receipt.command_id===input.command_id&&v.receipt.from_version===input.expected_version&&v.receipt.to_version===input.expected_version+1&&stamp(v.receipt.changed_at));
 need(v.record!==null);partnersRecord(v.record);need(v.record.version>=v.receipt.to_version);
 if(v.record.version===v.receipt.to_version)need(sameJson(v.record.partners,normalizeCompanyPartners(input.partners)));
 return v;
}

// Dados da empresa (extra of migration 151).
export const PERSON_TYPES=Object.freeze([['juridica','Pessoa Jurídica'],['fisica','Pessoa Física']]);
export const COMPANY_SIZES=Object.freeze([['mei','MEI'],['micro','Micro'],['pequena','Pequena'],['media','Média'],['grande','Grande']]);
export const SEGMENTS=Object.freeze([['comercio','Comércio'],['ecommerce','E-commerce'],['industria','Indústria'],['servicos','Serviços']]);
export const REVENUES=Object.freeze([['ate_60k','Até R$ 60.000,00'],['de_60k_360k','De R$ 60.000,00 a R$ 360.000,00'],['acima_360k','Maior que R$ 360.000,00']]);
export const EMPLOYEES=Object.freeze([['ate_5','Até 5 funcionários'],['de_5_10','De 5 a 10 funcionários'],['mais_10','Mais de 10 funcionários']]);
export const SUBSTITUTE_UFS=Object.freeze(['AC','AL','AM','AP','BA','CE','DF','ES','GO','MA','MG','MS','MT','PA','PB','PE','PI','PR','RJ','RN','RO','RR','RS','SC','SE','SP','TO']);
const EXTRA_KEYS=['billing_email','cnae','company_size','contacts','employees','ie_exempt','mobile','municipal_registration','person_type','revenue','segments','site','substitute_ies','suframa'];
const opt=(list,v)=>v===null||list.some(o=>o[0]===v);
/** Same rules as erp_company.extra_normalize; returns the canonical data (CNAE as NNNN-N/NN, segments in Origin order). */
export function normalizeCompanyExtra(raw,status=400,code='ERP_INVALID_INPUT'){
 const v=snapshot(raw);exact(v,EXTRA_KEYS,status,code);const ok=c=>need(c,status,code);
 const t=(x,max,re)=>{if(x===null||x==='')return null;ok(typeof x==='string'&&x.length<=max&&x===x.trim()&&!CONTROL.test(x)&&(!re||re.test(x)));return x;};
 ok(['juridica','fisica',null].includes(v.person_type)&&typeof v.ie_exempt==='boolean'&&opt(COMPANY_SIZES,v.company_size)&&opt(REVENUES,v.revenue)&&opt(EMPLOYEES,v.employees));
 ok(Array.isArray(v.segments)&&v.segments.length>=1&&v.segments.every(s=>SEGMENTS.some(o=>o[0]===s))&&new Set(v.segments).size===v.segments.length);
 ok(Array.isArray(v.substitute_ies)&&v.substitute_ies.length<=27);const ufs=new Set();
 const ies=v.substitute_ies.map(e=>{exact(e,['ie','uf'],status,code);ok(SUBSTITUTE_UFS.includes(e.uf)&&!ufs.has(e.uf)&&typeof e.ie==='string'&&/^[0-9A-Za-z./-]{2,20}$/.test(e.ie));ufs.add(e.uf);return{uf:e.uf,ie:e.ie};});
 let cnae=t(v.cnae,9,/^[0-9]{4}-?[0-9]\/?[0-9]{2}$/);if(cnae){const d=cnae.replace(/[-/]/g,'');cnae=`${d.slice(0,4)}-${d.slice(4,5)}/${d.slice(5)}`;}
 return{person_type:v.person_type??'juridica',ie_exempt:v.ie_exempt,municipal_registration:t(v.municipal_registration,30,/^[0-9A-Za-z./-]+$/),suframa:t(v.suframa,12,/^[0-9]{8,12}$/),cnae,
  company_size:v.company_size,segments:SEGMENTS.map(o=>o[0]).filter(s=>v.segments.includes(s)),revenue:v.revenue,employees:v.employees,contacts:t(v.contacts,120),
  mobile:t(v.mobile,20,/^\+?[0-9() -]{8,20}$/),billing_email:t(v.billing_email,254,/^[^@ ]+@[^@ ]+\.[^@ ]+$/),site:t(v.site,200,/^[^ ]+\.[^ ]+$/),substitute_ies:ies};
}
// Structural equality: jsonb returns object keys in its own order.
const sameJson=(a,b)=>Array.isArray(a)?Array.isArray(b)&&a.length===b.length&&a.every((x,i)=>sameJson(x,b[i])):plain(a)?plain(b)&&Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>Object.hasOwn(b,k)&&sameJson(a[k],b[k])):Object.is(a,b);
const canonical=d=>Object.fromEntries(EXTRA_KEYS.map(k=>[k,d[k]]));
function extraRecord(r){if(r===null)return;exact(r,['version','data','updated_at']);need(int(r.version)&&r.version>=1&&stamp(r.updated_at));
 const n=normalizeCompanyExtra(r.data,502,'ERP_UPSTREAM_INVALID_RESPONSE');need(sameJson(canonical(r.data),canonical(n)));}
export function parseCompanyExtra(raw){const v=snapshot(raw);exact(v,['scope','data_mode','can_manage','record']);need(v.scope==='company_extra'&&v.data_mode==='erp_native'&&typeof v.can_manage==='boolean');extraRecord(v.record);return v;}
export function captureCompanyExtraSave(raw){
 const v=snapshot(raw);exact(v,['command_id','expected_version','data'],400,'ERP_INVALID_INPUT');
 need(systemUuid(v.command_id)&&int(v.expected_version)&&v.expected_version<=2147483646,400,'ERP_INVALID_INPUT');normalizeCompanyExtra(v.data);
 return Object.freeze({command_id:v.command_id,expected_version:v.expected_version,data:v.data});
}
export function parseCompanyExtraResult(raw,input){
 const v=snapshot(raw);exact(v,['scope','data_mode','receipt','record','replayed']);need(v.scope==='company_extra_command'&&v.data_mode==='erp_native'&&typeof v.replayed==='boolean');
 exact(v.receipt,['command_id','from_version','to_version','changed_at']);need(v.receipt.command_id===input.command_id&&v.receipt.from_version===input.expected_version&&v.receipt.to_version===input.expected_version+1&&stamp(v.receipt.changed_at));
 need(v.record!==null);extraRecord(v.record);need(v.record.version>=v.receipt.to_version);
 if(v.record.version===v.receipt.to_version)need(sameJson(canonical(v.record.data),canonical(normalizeCompanyExtra(input.data))));
 return v;
}

// Sistema > Usuários: Dispositivos utilizados and Histórico do segundo fator.
export function parseUserSecurity(raw,target){
 const v=snapshot(raw);exact(v,['scope','data_mode','user_id','mfa','sessions','factors','challenges']);
 need(v.scope==='access_user_security'&&v.data_mode==='erp_native'&&v.user_id===target&&typeof v.mfa==='boolean'&&Array.isArray(v.sessions)&&v.sessions.length<=50&&Array.isArray(v.factors)&&v.factors.length<=20&&Array.isArray(v.challenges)&&v.challenges.length<=50);
 for(const s of v.sessions){exact(s,['last_access','created_at','ip','device','aal']);need((s.last_access===null||stamp(s.last_access))&&(s.created_at===null||stamp(s.created_at))&&ntext(s.ip,45)&&(s.device===null||s.device===''||text(s.device,300))&&ntext(s.aal,10));}
 for(const f of v.factors){exact(f,['type','status','created_at']);need(text(f.type,20)&&text(f.status,20)&&(f.created_at===null||stamp(f.created_at)));}
 for(const c of v.challenges){exact(c,['created_at','ip','type','valid']);need((c.created_at===null||stamp(c.created_at))&&ntext(c.ip,45)&&ntext(c.type,20)&&typeof c.valid==='boolean');}
 need(v.mfa===v.factors.some(f=>f.status==='verified'));
 return v;
}
