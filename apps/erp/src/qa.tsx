import StockReservationsQA from './qa/StockReservationsQA';
import FiscalReviewedAuthorizationQA from './qa/FiscalReviewedAuthorizationQA';
import {createSubsetReviewQaFixture} from './qa/subset-review-fixture';
import FiscalSubsetReviewQA from './qa/FiscalSubsetReviewQA';
import {createCnabOperationalV2QaFixture} from './qa/cnab-operational-v2-fixture';
import {createAuthorizationQaFixture} from './qa/authorization-fixture';
import FiscalAuthorizationQA from './qa/FiscalAuthorizationQA';
import {createWsdlQaFixture} from './qa/wsdl-fixture';
import SefazConnectionQA from './qa/SefazConnectionQA';
import {createA1QaController} from './qa/a1-controller';
import UnsavedChangesQA from './components/UnsavedChangesQA';
/** Developer-only entry; absent from the Vite production build inputs. */
import { lazy,useEffect,useMemo,useState,useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { createHashRouter, RouterProvider, useLocation, useNavigate } from 'react-router-dom';
import { UnsavedChangesProvider, useUnsavedChangesGuard } from './hooks/useUnsavedChanges';
import { createAccessController,type AuthPort } from './lib/real-access';
import {Catalog,HistoryView as History,RealDocuments as Documents,RealStock as Stock,RealFinance as Finance,RealCnab as Cnab,RealCnabOperational,RealCnabOperationalReturns,RealReceivedDfe,RealFiscalNumbering,CertificateA1,CompanySettings,RealImportCatalog as ImportCatalog,RealImportProposals,RealHome,CutoverReadiness,RealFiscalDrafts,DueDateReport,SyncedXmlHistory,IntegrationProgress} from './components/native-modules';
import NativeModuleBoundary from './components/NativeModuleBoundary';
import CompanyNavigation from './components/CompanyNavigation';
import type { AccessController, AccessState } from './lib/real-access';
import type { CatalogEntity } from './lib/catalog-model';
import type { DocumentKind } from './lib/real-documents-model';
import './styles.css';
import './components/real-access.css';
if(!import.meta.env.DEV||location.hostname!=='127.0.0.1')throw new Error('LOCAL_QA_ONLY');
const subsetReviewMode=new URLSearchParams(location.search).get('subset_review')==='1';
const qaSubsetReview=subsetReviewMode?createSubsetReviewQaFixture():null;
const cnabV2Mode=new URLSearchParams(location.search).get('cnab_v2');
const qaCnabV2=cnabV2Mode?createCnabOperationalV2QaFixture({empty:cnabV2Mode==='empty',readonly:cnabV2Mode==='readonly'}):null;
const qaA1=createA1QaController();
const qaWsdl=createWsdlQaFixture();
const qaAuthorization=createAuthorizationQaFixture();
const FailedModule=lazy(()=>Promise.reject(new Error('SYNTHETIC_QA_MODULE_LOAD_FAILURE')));
const session={access_token:'qa-synthetic-token-unsigned-safe',user:{id:'e0000000-0000-4000-8000-000000000001'}};
const auth:AuthPort={getSession:async()=>({data:{session},error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signInWithPassword:async()=>({data:{session:null},error:'QA_LOGIN_DISABLED'}),signOut:async()=>({error:null})};
// Explicit synthetic SKU markers exercise an ambiguous result after the server committed.
// This entry is DEV + loopback only and is absent from production build inputs.
const qaFailures=new Set<string>(),qaGetFailures=new Set<string>(),qaBridgeReadback=new Set<string>();
const qaSlowDetails=new Set<string>(),qaDelayDetails=new URLSearchParams(location.search).get('slow_detail')==='1';
const qaProposalRetry=new URLSearchParams(location.search).get('proposal_retry')==='1';
const qaFetch:typeof fetch=async(input,init)=>{
  const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
  if(qaSubsetReview)return qaSubsetReview.fetch(url,init);
  if(qaCnabV2)return qaCnabV2.fetch(url,init);
  if(new URL(url).origin==='https://unsigned.qa.invalid'&&new URL(url).pathname.startsWith('/v1/fiscal-wsdl/'))return qaWsdl.fetch(url,init);
  if(new URL(url).origin==='https://unsigned.qa.invalid'&&new URL(url).pathname.startsWith('/v1/fiscal-authorization/'))return qaAuthorization.fetch(url,init);
  const fiscalQa=new URL(url).origin==='https://unsigned.qa.invalid',target='http://127.0.0.1:9011'+new URL(url).pathname;
  const received=await fetch(fiscalQa?target:input,init);
  if(fiscalQa&&(received.redirected||received.url!==target)){void received.body?.cancel();throw new TypeError('QA_SYNTHETIC_TRANSPORT_MISMATCH');}
  // A simulated transport has no remote URL. Keep the production client's exact-origin check intact.
  const response=fiscalQa?new Response(received.body,{status:received.status,statusText:received.statusText,headers:received.headers}):received;
  if(qaDelayDetails&&(!init?.method||init.method==='GET')&&/^\/v1\/(?:financeiro\/accounts|documentos\/sales_proposals)\/[a-f0-9-]+$/.test(new URL(url).pathname)&&!qaSlowDetails.has(url)){qaSlowDetails.add(url);await new Promise(resolve=>setTimeout(resolve,4000));}
  if(init?.method==='POST'&&url.endsWith('/v1/cadastros/products')&&typeof init.body==='string'&&response.ok){
    const body=JSON.parse(init.body);
    if(body.data?.code==='QA-POST-RETRY'&&!qaFailures.has(body.command_id)){qaFailures.add(body.command_id);throw new TypeError('QA_SYNTHETIC_COMMITTED_RESPONSE_LOST');}
    if(body.data?.code==='QA-GET-RETRY'&&!qaFailures.has(body.command_id)){qaFailures.add(body.command_id);const value=await response.clone().json();qaGetFailures.add(`${url}/${value.record.id}`);}
  }
  if(init?.method==='POST'&&typeof init.body==='string'&&response.ok){
    const body=JSON.parse(init.body);
    if(qaProposalRetry&&['/v1/importacao-orcamentos-origin/apply','/v1/importacao-orcamentos-origin-v2/apply'].includes(new URL(url).pathname)&&!qaFailures.has(body.command_id)){
      qaFailures.add(body.command_id);qaGetFailures.add(`${new URL(url).origin}${new URL(url).pathname.replace(/\/apply$/,'')}/commands/${body.command_id}`);
      throw new TypeError('QA_SYNTHETIC_PROPOSAL_RESPONSE_LOST');
    }
    if(/^\/v1\/ordens-servico\/[a-f0-9-]+\/eventos$/.test(new URL(url).pathname)&&body.data?.notes==='QA-SERVICE-EVENT-RETRY'){
      if(!qaFailures.has(body.command_id)){qaFailures.add(body.command_id);throw new TypeError('QA_SYNTHETIC_SERVICE_EVENT_RESPONSE_LOST');}
      if(!qaBridgeReadback.has(body.command_id)){qaBridgeReadback.add(body.command_id);const value=await response.clone().json();qaGetFailures.add(`${url}/${value.record.id}`);}
    }
    const marked=(url.includes('/v1/ordens-servico/')&&url.endsWith('/diario')&&body.text==='QA-JOURNAL-RETRY')||(url.includes('/v1/documentos/')&&body.data?.notes==='QA-DOCUMENT-RETRY')||(url.includes('/v1/financeiro/actions/')&&body.data?.name==='QA-FINANCE-RETRY')||(url.endsWith('/v1/estoque/movimentos')&&body.reference==='QA-STOCK-RETRY');
    if(marked&&!qaFailures.has(body.command_id)){qaFailures.add(body.command_id);throw new TypeError('QA_SYNTHETIC_COMMITTED_RESPONSE_LOST');}
  }
  if(init?.method==='POST'&&typeof init.body==='string'&&response.ok){
    if(new URL(url).pathname.startsWith('/v1/duplicacao-documentos/')){
      const body=JSON.parse(init.body);
      if(body.data?.notes==='QA-COPY-RETRY'){
        if(!qaFailures.has(body.command_id)){qaFailures.add(body.command_id);throw new TypeError('QA_SYNTHETIC_COPY_RESPONSE_LOST');}
        if(!qaBridgeReadback.has(body.command_id)){qaBridgeReadback.add(body.command_id);const value=await response.clone().json();qaGetFailures.add(`${new URL(url).origin}/v1/documentos/${value.document.kind}/${value.document.id}`);}
      }
    }
    // This all-zero CEST is a synthetic fault marker, never a production default.
    if(new URL(url).pathname.startsWith('/v1/preparacao-itens-fiscais/')&&!url.endsWith('/preview')){
      const body=JSON.parse(init.body);
      if(body.decisions?.some((entry:{fields?:{cest?:{source?:string;value?:string}}})=>entry.fields?.cest?.source==='manual'&&entry.fields.cest.value==='0000000')){
        if(!qaFailures.has(body.command_id)){qaFailures.add(body.command_id);throw new TypeError('QA_SYNTHETIC_FISCAL_ITEM_RESPONSE_LOST');}
        if(!qaBridgeReadback.has(body.command_id)){qaBridgeReadback.add(body.command_id);qaGetFailures.add(url);}
      }
    }
    if(url.endsWith('/convert-service')){
      const body=JSON.parse(init.body),value=await response.clone().json();
      if(value.proposal?.notes==='QA-CONVERSION-RETRY'&&!qaFailures.has(body.command_id)){
        qaFailures.add(body.command_id);throw new TypeError('QA_SYNTHETIC_COMMITTED_RESPONSE_LOST');
      }
    }
    const body=JSON.parse(init.body),parsed=new URL(url),bridge=/^\/v1\/(documentos|documentos-estoque)\/(sales_orders|purchase_orders|service_orders)\/([a-f0-9-]+)\//.exec(parsed.pathname);
    if(bridge&&/\/(post|reverse)$/.test(parsed.pathname)&&body.command_id){
      if(!qaFailures.has(body.command_id)){qaFailures.add(body.command_id);throw new TypeError('QA_SYNTHETIC_BRIDGE_RESPONSE_LOST');}
      if(!qaBridgeReadback.has(body.command_id)){qaBridgeReadback.add(body.command_id);qaGetFailures.add(`${parsed.origin}/v1/documentos/${bridge[2]}/${bridge[3]}`);}
    }
  }
  if((!init?.method||init.method==='GET')&&qaGetFailures.delete(url))throw new TypeError('QA_SYNTHETIC_READBACK_LOST');
  return response;
};
function NavigationQA({controller,state}:{controller:AccessController;state:AccessState}){
  const location=useLocation();const navigate=useNavigate();const params=new URLSearchParams(location.search);const guard=useUnsavedChangesGuard();
  const entity=(params.get('cadastro')||'contacts') as CatalogEntity;
  const kind=(params.get('tipo')||'sales_proposals') as DocumentKind;
  const area=(params.get('area')||'receivable') as 'receivable'|'payable'|'accounts'|'categories';
  const model=(params.get('modelo')||'') as ''|'55'|'65';
  return <><CompanyNavigation state={state} onLogout={()=>guard.confirmLeave(()=>void controller.logout())}/><main className="real-main"><NativeModuleBoundary resetKey={location.pathname}>{location.pathname==='/conexao-sefaz'?<SefazConnectionQA controller={controller} fixture={qaWsdl}/>:location.pathname==='/numeracao-fiscal'?<RealFiscalNumbering controller={controller} canManage={state.membership?.role==='admin'}/>:location.pathname==='/notas-recebidas'?['admin','fiscal','consulta'].includes(state.membership!.role)?<RealReceivedDfe controller={controller} canConfigure={state.membership!.role==='admin'}/>:<p>NF-e recebidas não liberadas</p>:location.pathname==='/certificado-a1'?<CertificateA1 controller={qaA1} canManage={state.membership?.role==='admin'}/>:location.pathname==='/retornos-operacionais'?['admin','financeiro','consulta'].includes(state.membership!.role)?<RealCnabOperationalReturns controller={controller} onBack={()=>navigate('/cobranca-operacional')}/>:<p>Retornos não liberados</p>:location.pathname==='/cobranca-operacional'?<RealCnabOperational controller={controller}/>:location.pathname==='/integracao-origin'?state.membership?.role==='admin'?<IntegrationProgress controller={controller}/>:<p>Integração não liberada</p>:location.pathname==='/relatorio-vencimentos'?<DueDateReport controller={controller} onOpenTitles={({from,to,kind})=>navigate(`/financeiro-empresa?${new URLSearchParams({area:kind,from,to})}`)}/>:location.pathname==='/xmls-sincronizados'?<SyncedXmlHistory key={model} controller={controller} initialModel={model}/>:location.pathname==='/emissor-fiscal'?['admin','fiscal'].includes(state.membership!.role)?<RealFiscalDrafts key={model||'all'} controller={controller} initialModel={model||undefined}/>:<p>Preparação fiscal não liberada</p>:location.pathname==='/empresa-configuracoes'?<CompanySettings controller={controller}/>:location.pathname==='/cobranca-empresa'?<Cnab controller={controller}/>:location.pathname==='/cadastros-reais'?<Catalog key={entity} controller={controller} initialEntity={entity}/>:location.pathname==='/documentos-empresa'?<Documents key={kind} controller={controller} initialKind={kind}/>:location.pathname==='/financeiro-empresa'?<Finance key={area} controller={controller} initialTab={area}/>:location.pathname==='/historico-fiscal'?<History key={model} controller={controller} initialModel={model}/>:location.pathname==='/estoque-empresa'?<Stock controller={controller}/>:location.pathname==='/importar-orcamentos'?state.membership?.role==='admin'?<RealImportProposals key={state.membership.user_id} controller={controller}/>:<p>Importação não liberada</p>:location.pathname==='/importar-cadastros'?<ImportCatalog controller={controller}/>:location.pathname==='/preparacao-virada'?state.membership?.role==='admin'?<CutoverReadiness controller={controller}/>:<p>Preparação não liberada</p>:<RealHome controller={controller}/>}</NativeModuleBoundary></main></>;
}
function QA(){
  const [view,setView]=useState(qaSubsetReview?'subset-review':qaCnabV2?'cnab-operational':'catalog');const navigate=useNavigate();const guard=useUnsavedChangesGuard();
  const location=useLocation();const documentKind=(new URLSearchParams(location.search).get('tipo')||'sales_proposals') as DocumentKind;
  const controller=useMemo(()=>createAccessController(auth,'http://127.0.0.1:9011',qaFetch,{a1ApiUrl:'https://unsigned.qa.invalid'}),[]);
  const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot);
  useEffect(()=>controller.start(),[controller]);
  return <div className="real-shell"><header className="real-topbar"><strong>FAGOO · QA local · somente dados fictícios</strong>{qaCnabV2&&<span role="note">Cobrança fictícia: prévia local, sem rede nem gravação. Não confirme geração, aprovação ou retomada.</span>}<span role="note">Assinatura de teste: A1 fictício e XSD simulado. Sem valor fiscal.</span><nav>{(qaSubsetReview?[['subset-review','Revisão fiscal isolada']]:[['catalog','Cadastros'],['history','Histórico'],['documents','Documentos'],['stock','Estoque'],['finance','Financeiro'],['import','Importação'],['proposal-import','Importar orçamentos'],['cnab','Cobrança'],['cnab-operational','Remessa operacional'],['cnab-returns','Retornos operacionais'],['received-dfe','NF-e recebidas'],['fiscal-numbering','Numeração fiscal'],['authorization','Autorização fiscal'],['wsdl','Conexão SEFAZ'],['a1','Certificado A1'],['company','Empresa'],['home','Visão geral'],['cutover','Virada'],['fiscal','Rascunhos fiscais'],['due-report','Vencimentos'],['synced-xml','XMLs sincronizados'],['integration','Integração Origin'],['navigation','Navegação'],['guard','Proteção'],['load-failure','Falha de módulo']]).map(([key,label])=><button key={key} className="secondary-button" onClick={()=>guard.confirmLeave(()=>{setView(key);if(key==='navigation')navigate('/acesso');})}>{label} de teste</button>)}</nav></header>{view==='navigation'&&state.phase==='ready'?<NavigationQA controller={controller} state={state}/>:<main className="real-main">{state.phase==='ready'?<NativeModuleBoundary resetKey={view}>{view==='subset-review'&&qaSubsetReview?<FiscalSubsetReviewQA controller={controller} fixture={qaSubsetReview}/>:view==='authorization'?<FiscalAuthorizationQA controller={controller} fixture={qaAuthorization}/>:view==='wsdl'?<SefazConnectionQA controller={controller} fixture={qaWsdl}/>:view==='fiscal-numbering'?<RealFiscalNumbering controller={controller} canManage={state.membership?.role==='admin'}/>:view==='received-dfe'?['admin','fiscal','consulta'].includes(state.membership!.role)?<RealReceivedDfe controller={controller} canConfigure={state.membership!.role==='admin'}/>:<p>NF-e recebidas não liberadas</p>:view==='a1'?<CertificateA1 controller={qaA1} canManage={state.membership?.role==='admin'}/>:view==='cnab-returns'?['admin','financeiro','consulta'].includes(state.membership!.role)?<RealCnabOperationalReturns controller={controller} onBack={()=>setView('cnab-operational')}/>:<p>Retornos não liberados</p>:view==='cnab-operational'?<RealCnabOperational controller={controller}/>:view==='integration'?state.membership?.role==='admin'?<IntegrationProgress controller={controller}/>:<p>Integração não liberada</p>:view==='due-report'?<DueDateReport controller={controller} onOpenTitles={({from,to,kind})=>{setView('navigation');navigate(`/financeiro-empresa?${new URLSearchParams({area:kind,from,to})}`);}}/>:view==='synced-xml'?<SyncedXmlHistory controller={controller}/>:view==='fiscal'?<RealFiscalDrafts controller={controller}/>:view==='load-failure'?<FailedModule/>:view==='guard'?<UnsavedChangesQA/>:view==='home'?<RealHome controller={controller}/>:view==='cutover'?<CutoverReadiness controller={controller}/>:view==='company'?<CompanySettings controller={controller}/>:view==='cnab'?<Cnab controller={controller}/>:view==='catalog'?<Catalog controller={controller}/>:view==='history'?<History controller={controller}/>:view==='documents'?<Documents key={documentKind} controller={controller} initialKind={documentKind}/>:view==='stock'?<Stock controller={controller}/>:view==='proposal-import'?state.membership?.role==='admin'?<RealImportProposals key={state.membership.user_id} controller={controller}/>:<p>Importação não liberada</p>:view==='import'?<ImportCatalog controller={controller}/>:<Finance controller={controller}/>}</NativeModuleBoundary>:<p role="status">QA: {state.phase}</p>}</main>}</div>;
}
const router=createHashRouter([{path:'*',element:<UnsavedChangesProvider>{new URLSearchParams(location.search).get('reviewed_authorization')==='1'?<FiscalReviewedAuthorizationQA/>:new URLSearchParams(location.search).has('stock_reservations')?<StockReservationsQA/>:<QA/>}</UnsavedChangesProvider>}]);
createRoot(document.getElementById('root')!).render(<RouterProvider router={router}/>);
