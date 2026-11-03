import type {AccessController,AccessState} from './real-access';
import {numberingCompany,numberingPage,type NumberingCompany,type NumberingPage} from './fiscal-numbering-model.ts';
import {a1Metadata,type A1Current} from './a1-model.ts';
import {CRT_LABELS} from './company-model.ts';
import {STATES} from './real-documents-model.ts';
import type {FiscalModel} from './fiscal-drafts-model';

export type FiscalPreparationController=Pick<AccessController,'subscribe'|'getSnapshot'|'company'|'a1'|'fiscalNumbering'|'documents'>;
export function hasFiscalPreparationPorts(value:object):value is FiscalPreparationController {
 return ['subscribe','getSnapshot','company','a1','fiscalNumbering','documents'].every(key=>typeof (value as Record<string,unknown>)[key]==='function');
}
export const preparationActor=(s:AccessState)=>s.phase==='ready'&&s.membership&&['admin','fiscal'].includes(s.membership.role)?s.membership.user_id:null;
export type GuideRead<T>={ok:true;value:T}|{ok:false};
export type GuideCompany=(NumberingCompany&{ie:string|null})|null;
export interface GuideFiscal {version:number;identity_version:number;crt:string|null;confirmed:boolean;}
export interface GuideOrders {count:number;notCancelled:number;hasMore:boolean;}
export interface GuideData {company:GuideRead<GuideCompany>;fiscal:GuideRead<GuideFiscal|null>;a1:GuideRead<A1Current>;series:GuideRead<NumberingPage>;orders:GuideRead<GuideOrders>;}
export interface GuideRow {id:string;title:string;state:'recorded'|'missing'|'attention'|'unknown';summary:string;detail:string;path:string;action:string;}
const object=(v:unknown):v is Record<string,unknown>=>Boolean(v)&&typeof v==='object'&&!Array.isArray(v);
const version=(v:unknown):v is number=>Number.isInteger(v)&&Number(v)>=1&&Number(v)<=2147483647;
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
function invalid():never{throw new Error('FISCAL_GUIDE_RESPONSE_INVALID');}
export function guideCompany(raw:unknown):GuideCompany {
 const base=numberingCompany(raw);if(!base)return null;
 const ie=((raw as {record:{data:{ie:unknown}}}).record.data.ie);
 if(ie!==null&&(typeof ie!=='string'||ie.length>200||/[\x00-\x1f\x7f]/.test(ie)))invalid();
 return {...base,ie:ie as string|null};
}
export function guideFiscal(raw:unknown):GuideFiscal|null {
 if(!object(raw)||raw.section!=='fiscal'||raw.data_mode!=='erp_native'||raw.emission_enabled!==false)invalid();
 if(raw.record===null)return null;const r=raw.record;
 if(!object(r)||!version(r.version)||!version(r.identity_version)||typeof r.confirmed!=='boolean'||r.crt!==null&&(typeof r.crt!=='string'||!Object.hasOwn(CRT_LABELS,r.crt))||r.confirmed!==(r.crt!==null))invalid();
 return {version:r.version,identity_version:r.identity_version,crt:r.crt as string|null,confirmed:r.confirmed};
}
export function guideOrders(raw:unknown):GuideOrders {
 if(!object(raw)||raw.kind!=='sales_orders'||raw.data_mode!=='erp_native'||raw.operational_effects!==false||raw.limit!==25||!Array.isArray(raw.items)||raw.items.length>25||typeof raw.has_more!=='boolean'||raw.has_more&&raw.items.length!==25)invalid();
 const ids=new Set<string>();let notCancelled=0;
 for(const item of raw.items){if(!object(item)||!uuid(item.id)||ids.has(item.id)||item.kind!=='sales_orders'||!version(item.version)||typeof item.status!=='string'||!Object.hasOwn(STATES.sales_orders,item.status))invalid();ids.add(item.id);if(item.status!=='cancelled')notCancelled++;}
 if(raw.next_cursor!==(raw.has_more?(raw.items.at(-1) as {id:string}).id:null))invalid();
 return {count:raw.items.length,notCancelled,hasMore:raw.has_more};
}
export const guideA1=a1Metadata;
export const guideSeries=(raw:unknown,model:FiscalModel)=>numberingPage(raw,model);
export function guideRows(data:GuideData,model:FiscalModel):GuideRow[] {
 const company=data.company.ok?data.company.value:null,fiscal=data.fiscal.ok?data.fiscal.value:null;
 const rows:GuideRow[]=[];
 const row=(id:string,title:string,path:string,action:string):GuideRow=>({id,title,path,action,state:'unknown',summary:'Consulta indisponível',detail:'Confira novamente ou abra a tela para consultar os dados atuais.'});
 const identity=row('company','Empresa e regime tributário','/empresa-configuracoes','Ver dados da empresa');
 if(data.company.ok){
  if(!company){identity.state='missing';identity.summary='Falta cadastrar a empresa';identity.detail='Registre a identificação e o endereço; depois confirme o regime tributário.';}
  else if(!data.fiscal.ok){identity.state='attention';identity.summary='Empresa cadastrada; regime não consultado';}
  else if(!fiscal?.confirmed||fiscal.identity_version!==company.version){identity.state='attention';identity.summary='Regime tributário precisa de conferência';identity.detail='Confira o regime para a versão atual dos dados da empresa. Nenhum regime é escolhido automaticamente.';}
  else{identity.state=company.state==='SP'&&Boolean(company.ie?.trim())?'recorded':'attention';identity.summary=`Regime registrado: ${CRT_LABELS[fiscal.crt!]}`;identity.detail=company.state!=='SP'?'A empresa está fora do perfil de São Paulo desta preparação.':!company.ie?.trim()?'Inscrição estadual não informada; ausência não significa isenção.':'Cadastro e confirmação encontrados. Isso não valida os tributos da nota.';}
 }rows.push(identity);
 const certificate=row('a1','Certificado A1','/certificado-a1','Ver certificado A1');
 if(data.a1.ok){const a=data.a1.value;
  if(a.state==='unconfigured'||a.state==='disabled'){certificate.state='missing';certificate.summary=a.state==='disabled'?'Certificado desativado':'Certificado ainda não configurado';certificate.detail='A configuração é uma etapa separada, feita pelo administrador.';}
  else if(!data.company.ok||!company){certificate.state='attention';certificate.summary='Certificado registrado; vínculo da empresa não conferido';certificate.detail='Consulte os dados atuais da empresa antes de usar o certificado.';}
  else if(a.company_changed||a.company_identity_version!==company.version||a.metadata?.holder_cnpj!==company.cnpj||!a.time_valid_now){certificate.state='attention';certificate.summary='Certificado precisa de conferência';certificate.detail='Confira a validade e o vínculo com a empresa na tela do certificado.';}
  else{certificate.state='recorded';certificate.summary='Metadados do certificado disponíveis';certificate.detail='Esta consulta não abre o certificado, não assina documentos e não comprova autorização de envio.';}
 }rows.push(certificate);
 const series=row('series',`Série de ${model==='55'?'NF-e':'NFC-e'} em homologação`,'/numeracao-fiscal','Ver séries fiscais');
 if(data.series.ok){const p=data.series.value;
  if(!data.company.ok||!company){series.state='attention';series.summary='Vínculo da série depende da empresa';series.detail='Confira a empresa antes de escolher uma série. Nenhum número será reservado aqui.';}
  else{const available=p.items.filter(s=>s.issuer_cnpj===company.cnpj&&company.state==='SP'&&s.identity_version===company.version&&!s.company_changed&&s.enabled&&s.exclusive_use_confirmed&&!s.exhausted);
   series.state=available.length?'recorded':p.has_more||p.items.length?'attention':'missing';
   series.summary=available.length?`${available.length} série(s) habilitada(s) na página consultada`:p.has_more?'Nenhuma série utilizável nesta página':p.items.length?'Séries cadastradas precisam de conferência':'Falta configurar uma série para este modelo';
   series.detail=p.has_more?'Há outras páginas. Abra as séries para conferir o conjunto e escolher explicitamente a série.':'O administrador define a série e o uso exclusivo. A escolha e a reserva do número são feitas em etapa separada.';
  }
 }rows.push(series);
 const orders=row('orders','Pedido de venda de origem','/documentos-empresa?tipo=sales_orders','Ver pedidos de venda');
 if(data.orders.ok){const p=data.orders.value;orders.state=p.notCancelled?'recorded':p.hasMore||p.count?'attention':'missing';orders.summary=p.notCancelled?`${p.notCancelled} pedido(s) não cancelado(s) na página consultada`:p.hasMore?'Nenhum pedido não cancelado nesta página':p.count?'Os pedidos consultados estão cancelados':'Nenhum pedido de venda cadastrado';orders.detail=p.hasMore?'Há outras páginas de pedidos. Escolha a origem e confira destinatário, itens e valores antes de criar a cópia fiscal.':'Salve um pedido de venda para usá-lo como origem. O rascunho fiscal não é criado a partir de uma proposta diretamente.';}
 rows.push(orders);return rows;
}
/** 022 describes the commercial copy, not the state of later048/050 artifacts. */
const LATER=new Set(['FISCAL_XML_NOT_BUILT','XSD_NOT_VALIDATED','SIGNATURE_NOT_CREATED','TRANSPORT_UNAVAILABLE','HOMOLOGATION_NOT_PERFORMED']);
export const fiscalCopyPending=(pending:readonly string[])=>pending.filter(code=>!LATER.has(code));
