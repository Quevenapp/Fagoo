import {stockObservationsHref,stockObservationsRouteSource,STOCK_OBSERVATIONS_ROUTE} from '../lib/origin-stock-observations-request';
import { useEffect, useMemo, useState, useSyncExternalStore, type FormEvent } from 'react';
import { createClient } from '@supabase/supabase-js';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { accessConfig } from '../lib/access-config';
import { registerAuthClient } from '../lib/auth-client';
import { createAccessController, decimalMoney, RESOURCE_LABELS, ROLE_LABELS, type AccessController, type AccessState, type Entity, type ListQuery, type Summary } from '../lib/real-access';
import './real-access.css';
import { ProductTaxonomy, ProductExport, PriceLists, CustomFields } from './native-modules';
import { CompanyPreferences, Catalog, HistoryView, RealDocuments, RealStock, RealFinance, FinanceBorderos, FinanceScreens, RealCnab, RealCnabOperational, RealCnabOperationalReturns, RealReceivedDfe, RealFiscalNumbering, CertificateA1, SefazConnection, CompanySettings, RealImportCatalog, RealImportProposals, OriginPurchaseReadiness, OriginSalesReadiness, OriginSalesHistory, ItauLegacyReadiness, OriginWarehouseImport, OriginStockObservations, RealStockOpening, RealHome, CutoverReadiness, RealFiscalDrafts, DueDateReport, SyncedXmlHistory, IntegrationProgress, StockWarehouses, StockCount, StockDashboards, ReceiptCheckin, StockReports } from './native-modules';
import { contactModuleRoute } from '../lib/contact-routes';
import { financeScreen, type FinanceScreen } from '../lib/finance-screens';
import { RealFiscalInvoices, RealOperationNatures, FiscalEventList, RealPdv } from './native-modules';
import NativeModuleBoundary from './NativeModuleBoundary';
import HelpCenter from './HelpCenter';
import { isHelpPath } from '../lib/help-content';
import CompanyNavigation from './CompanyNavigation';
import { isPreferencesPath, preferencesResetKey } from '../lib/preferences-route';
import type { CatalogEntity } from '../lib/catalog-model';
import type { DocumentKind } from '../lib/real-documents-model';
import { useUnsavedChangesGuard } from '../hooks/useUnsavedChanges';

const configuration = accessConfig({
  VITE_SUPABASE_DEPLOYMENT: import.meta.env.VITE_SUPABASE_DEPLOYMENT,
  VITE_SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL,
  VITE_SUPABASE_ANON_KEY: import.meta.env.VITE_SUPABASE_ANON_KEY,
  VITE_SUPABASE_PUBLISHABLE_KEY: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  VITE_ERP_API_URL: import.meta.env.VITE_ERP_API_URL,
  VITE_A1_API_URL: import.meta.env.VITE_A1_API_URL,
});
const supabase = configuration ? createClient(configuration.supabaseUrl, configuration.publicKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'brufap.erp.auth' },
}) : null;
// Leva H: Minha conta › Segurança uses this same client (second factor, password change).
registerAuthClient(supabase?.auth ?? null);
import { MfaSetup } from './MfaSetup';
import type { MfaPort } from '../lib/account-security';

/** Leva H (PRF-291): the recovery e-mail of Supabase Auth, whose link opens /ativar-acesso as a recovery. The answer is the same
 * whether the e-mail has an account or not. */
function ForgotPassword({ email }: { email: string }) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');
  const send = async () => {
    const address = email.trim();
    if (!supabase || state === 'sending' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) { setState('failed'); return; }
    setState('sending');
    try { const result = await supabase.auth.resetPasswordForEmail(address, { redirectTo: `${window.location.origin}/ativar-acesso` }); setState(result.error && result.error.status !== 400 ? 'failed' : 'sent'); }
    catch { setState('failed'); }
  };
  return <p className="real-help">
    <button type="button" className="text-button" disabled={state === 'sending'} onClick={() => void send()}>{state === 'sending' ? 'Enviando…' : 'Esqueci minha senha'}</button>
    {state === 'sent' && <span role="status"> Se houver uma conta com este e-mail, enviamos um link para definir uma nova senha.</span>}
    {state === 'failed' && <span role="alert"> Informe o e-mail no campo acima e tente novamente.</span>}
  </p>;
}

function Login({ controller, state }: { controller: AccessController; state: AccessState }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try { await controller.login(email, password); } finally { setPassword(''); }
  };
  return <section className="real-login-panel" aria-labelledby="login-title">
    <h1 id="login-title">Acessar dados da empresa</h1>
    <p>Entre com sua conta autorizada para acessar os dados e documentos da empresa.</p>
    {state.message && <p className="real-alert" role="alert">{state.message}</p>}
    {state.logoutFailed ? <button className="primary-button" onClick={() => void controller.logout()}>Tentar encerrar sessão</button> : <form onSubmit={submit} aria-busy={state.loginPending}>
      <div className="form-field"><label htmlFor="access-email">E-mail</label><input id="access-email" name="email" type="email" autoComplete="username" required maxLength={254} value={email} onChange={event => setEmail(event.target.value)} disabled={state.loginPending} /></div>
      <div className="form-field"><label htmlFor="access-password">Senha</label><input id="access-password" name="password" type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} disabled={state.loginPending} /></div>
      <button className="primary-button" type="submit" disabled={state.loginPending}>{state.loginPending ? 'Entrando…' : 'Entrar'}</button>
    </form>}
    <ForgotPassword email={email} />
    <p className="real-help">O acesso é liberado pelo administrador da empresa.</p>
    <Link className="text-button" to="/inicio">Conhecer a prévia com dados fictícios</Link>
  </section>;
}

type Column = { key: keyof Summary; label: string; kind?: 'date' | 'money' | 'seen' };
function columnsFor(entity: Entity): Column[] {
  if (entity === 'contacts' || entity === 'products') return [
    { key: 'name', label: entity === 'products' ? 'Produto' : 'Nome' }, { key: 'code', label: 'Código' },
    ...(entity === 'products' ? [{ key: 'amount', label: 'Preço', kind: 'money' } as Column] : []),
    { key: 'status', label: 'Situação (código Origin)' }, { key: 'id', label: 'ID no Origin' }, { key: 'last_seen_at', label: 'Observado em', kind: 'seen' },
  ];
  return [
    { key: 'number', label: 'Número' }, { key: 'counterparty_name', label: entity === 'purchase_orders' || entity === 'payables' ? 'Fornecedor / contato' : 'Cliente / contato' },
    { key: 'date', label: ['nfe', 'nfce', 'receivables', 'payables'].includes(entity) ? 'Emissão' : 'Data', kind: 'date' },
    ...(['receivables', 'payables'].includes(entity) ? [{ key: 'due_date', label: 'Vencimento', kind: 'date' } as Column] : []),
    ...(['nfe', 'nfce'].includes(entity) ? [{ key: 'series', label: 'Série' } as Column] : []),
    { key: 'amount', label: 'Valor na origem', kind: 'money' },
    ...(['receivables', 'payables'].includes(entity) ? [{ key: 'balance', label: 'Saldo informado na origem', kind: 'money' } as Column] : []),
    { key: 'status', label: 'Situação (código Origin)' }, { key: 'id', label: 'ID no Origin' }, { key: 'last_seen_at', label: 'Observado em', kind: 'seen' },
  ];
}
function cell(value: string | null, kind?: Column['kind']) {
  if (kind === 'money') return decimalMoney(value);
  if (!value) return '—';
  if (kind === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value.split('-').reverse().join('/');
  if (kind === 'seen') {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(timestamp) : '—';
  }
  return value;
}

function Records({ controller, state }: { controller: AccessController; state: AccessState }) {
  const resources = state.membership!.resources;
  const [query, setQuery] = useState<ListQuery>(() => ({ entity: resources[0] || 'contacts', limit: 25, offset: 0 }));
  const [draft, setDraft] = useState({ q: '', status: '', from: '', to: '' });
  const [validation, setValidation] = useState('');
  const columns = useMemo(() => columnsFor(query.entity), [query.entity]);
  const dated = !['contacts', 'products'].includes(query.entity);
  useEffect(() => {
    if (resources.includes(query.entity)) void controller.loadRecords(query);
    return () => controller.clearRecords();
  }, [controller, query, resources]);
  const apply = (event: FormEvent) => {
    event.preventDefault();
    if (draft.from && draft.to && draft.from > draft.to) { setValidation('A data inicial deve ser anterior ou igual à final.'); return; }
    setValidation(''); setQuery(previous => ({ ...previous, ...draft, offset: 0 }));
  };
  const changeEntity = (entity: Entity) => {
    controller.clearRecords(); setDraft({ q: '', status: '', from: '', to: '' }); setValidation('');
    setQuery(previous => ({ entity, limit: previous.limit, offset: 0 }));
  };
  const page = state.records?.entity === query.entity ? state.records : null;
  return <>
    <header className="real-heading"><div><h1>Dados sincronizados do Origin</h1><p>Perfil de acesso: <strong>{ROLE_LABELS[state.membership!.role]}</strong></p></div><span className="real-mode">Somente consulta</span></header>
    <div className="real-notice"><strong>Cópia em sincronização.</strong> O histórico pode estar incompleto. Estes valores não representam saldo de corte ou fechamento. As situações mantêm os códigos originais do Origin.</div>
    {resources.length === 0 ? <div className="empty-state"><h2>Nenhum módulo liberado</h2><p>Solicite a revisão das permissões ao administrador.</p></div> : <section className="real-records" aria-label="Consulta de registros">
      <div className="real-resource"><label htmlFor="real-resource">Módulo</label><select id="real-resource" value={query.entity} onChange={event => changeEntity(event.target.value as Entity)}>{resources.map(entity => <option value={entity} key={entity}>{RESOURCE_LABELS[entity]}</option>)}</select></div>
      <form className="real-query" onSubmit={apply}>
        <div className="form-field real-query-search"><label htmlFor="real-search">Pesquisar</label><input id="real-search" type="search" maxLength={120} placeholder="Nome, código ou número" value={draft.q} onChange={event => setDraft({ ...draft, q: event.target.value })} /></div>
        <div className="form-field"><label htmlFor="real-status">Situação · código Origin</label><input id="real-status" maxLength={80} placeholder="Todos" value={draft.status} onChange={event => setDraft({ ...draft, status: event.target.value })} /></div>
        {dated && <><div className="form-field"><label htmlFor="real-from">Data inicial</label><input id="real-from" type="date" min="1900-01-01" max="2100-12-31" value={draft.from} onChange={event => setDraft({ ...draft, from: event.target.value })} /></div><div className="form-field"><label htmlFor="real-to">Data final</label><input id="real-to" type="date" min={draft.from || '1900-01-01'} max="2100-12-31" value={draft.to} onChange={event => setDraft({ ...draft, to: event.target.value })} /></div></>}
        <div className="real-query-actions"><button className="primary-button" type="submit" disabled={state.listPending}>Consultar</button><button className="secondary-button" type="button" onClick={() => changeEntity(query.entity)}>Limpar</button></div>
      </form>
      {dated && <p className="real-help real-date-help">O período considera a data de emissão ou do documento, conforme o módulo.</p>}
      {(validation || state.message) && <div className="real-alert" role="alert">{validation || state.message}{state.message && <button className="text-button" onClick={() => void controller.loadRecords(query)}>Tentar novamente</button>}</div>}
      <div aria-live="polite" className="real-result-status">{state.listPending ? 'Carregando registros…' : page ? `${page.total.toLocaleString('pt-BR')} registro(s) encontrados` : 'Consulta ainda sem resultado.'}</div>
      <div className="table-scroll" tabIndex={0} role="region" aria-label="Tabela de registros; role horizontalmente para ver todas as colunas" aria-busy={state.listPending}>
        <table className="data-table real-table"><caption className="real-sr-only">{RESOURCE_LABELS[query.entity]} · dados reais em sincronização, somente consulta</caption><thead><tr>{columns.map(column => <th key={column.key} scope="col" className={column.kind === 'money' ? 'numeric' : ''}>{column.label}</th>)}</tr></thead><tbody>{page?.items.map(row => <tr key={row.id}>{columns.map(column => <td key={column.key} className={column.kind === 'money' ? 'numeric' : column.key === 'id' ? 'real-source-id' : ''}>{cell(row[column.key], column.kind)}</td>)}</tr>)}</tbody></table>
      </div>
      {page?.items.length === 0 && <div className="empty-state"><h2>Nenhum registro encontrado</h2><p>Ajuste os filtros ou aguarde a sincronização deste módulo.</p></div>}
      <footer className="table-footer real-pagination"><span>{page && page.total ? `${page.offset + 1}–${page.offset + page.items.length} de ${page.total}` : '0 registros nesta página'}</span><div className="pagination"><label className="page-size">Por página<select value={query.limit} onChange={event => setQuery(previous => ({ ...previous, limit: Number(event.target.value), offset: 0 }))}>{[25, 50, 100].map(limit => <option key={limit}>{limit}</option>)}</select></label><button className="secondary-button" disabled={state.listPending || query.offset === 0} onClick={() => setQuery(previous => ({ ...previous, offset: Math.max(0, previous.offset - previous.limit) }))}>Anterior</button><button className="secondary-button" disabled={state.listPending || !page?.has_more || (page.next_offset ?? 100001) > 100000} onClick={() => setQuery(previous => ({ ...previous, offset: page?.next_offset ?? previous.offset }))}>Próxima</button></div></footer>
      <p className="real-help">“Observado em” usa o horário de São Paulo. A consulta mantém a ordem dos IDs do Origin; não executa alterações nem exporta arquivos.</p>
    </section>}
  </>;
}

/** Preserve a same-actor pending command through a temporary role reduction.
 * The actor key and the outer session gate still unmount on logout or replacement.
 */
function FiscalDraftAccess({controller,state,initialModel}:{controller:AccessController;state:AccessState;initialModel?:'55'|'65'}) {
  const allowed=state.phase==='ready'&&['admin','fiscal'].includes(state.membership?.role??'');
  const [opened,setOpened]=useState(allowed);
  useEffect(()=>{if(allowed)setOpened(true);},[allowed]);
  return <>
    {!allowed&&<section className="real-state-panel"><h1>Preparação fiscal não liberada</h1><p>Seu perfil atual não permite acessar os rascunhos fiscais. Uma confirmação pendente permanece preservada para consulta quando seu acesso for restabelecido.</p></section>}
    {opened&&<div hidden={!allowed} inert={!allowed} aria-hidden={!allowed}><RealFiscalDrafts key={initialModel} controller={controller} initialModel={initialModel}/></div>}
  </>;
}

/** Produtos (202610200119-120): telas de taxonomia por endereço; cada uma lê as próprias permissões de produtos. */
const PRODUCT_TAXONOMY_PATHS: Record<string, 'categories' | 'product_groups' | 'tags' | 'tag_groups'> = { '/categorias-produtos': 'categories', '/grupos-produtos': 'product_groups', '/tags': 'tags', '/grupos-tags': 'tag_groups' };

/** Notas fiscais no padrão Origin: saída, NFC-e, entrada, naturezas e consultas de eventos (202610200111-114). */
const FISCAL_INVOICE_PATHS = ['/historico-fiscal', '/notas-entrada', '/naturezas-operacao', '/inutilizacoes-nfe', '/cartas-correcao'];
const fiscalInvoiceRoute = (pathname: string) => FISCAL_INVOICE_PATHS.includes(pathname);
function FiscalInvoiceRoutes({ controller, pathname, model, role }: { controller: AccessController; pathname: string; model: '' | '55' | '65'; role: string }) {
  const reader = ['admin', 'consulta', 'fiscal'].includes(role), writer = ['admin', 'fiscal'].includes(role);
  if (pathname === '/inutilizacoes-nfe' || pathname === '/cartas-correcao') return writer ? <FiscalEventList key={pathname} controller={controller} kind={pathname === '/cartas-correcao' ? 'correction' : 'inutilization'} />
    : <section className="real-state-panel"><h1>Consulta não liberada</h1><p>Somente administrador e fiscal consultam os eventos fiscais do FAGOO.</p></section>;
  if (!reader) return <section className="real-state-panel"><h1>Notas fiscais não liberadas</h1><p>Seu perfil não possui acesso às notas fiscais.</p></section>;
  if (pathname === '/naturezas-operacao') return <RealOperationNatures controller={controller} />;
  const screen = pathname === '/notas-entrada' ? 'entrada' : model === '65' ? 'nfce' : 'nfe';
  // /historico-fiscal keeps the menu and home-shortcut address of "Notas fiscais de saída" and NFC-e; the backup archive is a tab there.
  return <RealFiscalInvoices key={screen} controller={controller} screen={screen} backup={screen !== 'entrada' ? <HistoryView key={model} controller={controller} initialModel={model} canIssue={writer} /> : undefined} />;
}

/** Keep an uncertain financial import only for the same actor who opened it. */
function CutoverAccess({controller,state}:{controller:AccessController;state:AccessState}) {
  const allowed=state.phase==='ready'&&state.membership?.role==='admin';
  const [opened,setOpened]=useState(allowed);
  useEffect(()=>{if(allowed)setOpened(true);},[allowed]);
  return <>
    {!allowed&&<section className="real-state-panel"><h1>Preparação não liberada</h1><p>Somente administradores podem conferir os dados para a virada. Uma confirmação pendente permanece preservada para consulta quando seu acesso for restabelecido.</p></section>}
    {opened&&<div hidden={!allowed} inert={!allowed} aria-hidden={!allowed}><CutoverReadiness controller={controller}/></div>}
  </>;
}

function ConnectedArea() {
  const location = useLocation();
  const navigate = useNavigate();
  const guard = useUnsavedChangesGuard();
  const controller = useMemo(() => createAccessController(supabase!.auth, configuration!.apiUrl, fetch, {a1ApiUrl:configuration!.a1ApiUrl,storageOrigin:configuration!.supabaseUrl}), []);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => controller.start(), [controller]);
  const params = new URLSearchParams(location.search);
  const selected = <T extends string>(name: string, values: readonly T[], fallback: T): T => values.includes(params.get(name) as T) ? params.get(name) as T : fallback;
  const catalogEntity = selected<CatalogEntity>('cadastro', ['contacts', 'products', 'warehouses'], 'contacts');
  const documentKind = selected<DocumentKind>('tipo', ['sales_proposals', 'sales_orders', 'purchase_orders', 'service_orders'], 'sales_proposals');
  const financeTab = selected('area', ['receivable', 'payable', 'accounts', 'categories'] as const, 'receivable');
  const fiscalModel = selected('modelo', ['', '55', '65'] as const, '');
  const navigationActor=state.membership?.user_id;
  const draftModel = selected('modelo', ['', '55', '65'] as const, '') || undefined;
  // Vendas › Frente de caixa: tela cheia, sem o menu do topo (o hambúrguer da própria tela abre o menu plano).
  const pdv = location.pathname === '/frente-caixa-empresa' && state.phase === 'ready';
  return <div className="real-shell"><a className="skip-link" href="#real-main">Ir para o conteúdo</a>{!pdv && <CompanyNavigation state={state} controller={controller} onLogout={() => guard.confirmLeave(() => void controller.logout())} />}
    <main id="real-main" className={pdv ? 'real-main real-main-pdv' : 'real-main'}>
      {state.phase==='ready'&&state.permissionMessage&&<p className="real-notice" role="status">{state.permissionMessage} <button type="button" className="text-button" onClick={()=>controller.retry()}>Verificar permissões</button></p>}
      {state.phase === 'loading' || state.phase === 'checking' ? <div className="real-state-panel" role="status"><h1>{state.phase === 'loading' ? 'Recuperando sessão…' : 'Verificando permissões…'}</h1><p>Aguarde a confirmação do acesso.</p></div> : state.phase === 'signed_out' ? <Login controller={controller} state={state} /> : state.phase === 'mfa' ? <section className="real-state-panel" aria-labelledby="mfa-title"><h1 id="mfa-title">Confirme o segundo fator</h1><MfaSetup port={supabase!.auth as unknown as MfaPort} onVerified={() => controller.retry()} intro="A empresa exige o aplicativo autenticador para o seu perfil. Confirme o código para continuar." /><p className="real-help">Perdeu o celular? Peça ao administrador para redefinir o seu segundo fator em Preferências › Sistema › Usuários.</p><button type="button" className="text-button" onClick={() => void controller.logout()}>Sair</button></section> : state.phase === 'pending' ? state.message ? <section className="real-state-panel" aria-labelledby="pending-title"><h1 id="pending-title">Acesso fora do horário permitido</h1><p role="alert">{state.message}</p><button className="primary-button" onClick={() => controller.retry()}>Verificar liberação</button></section> : <section className="real-state-panel" aria-labelledby="pending-title"><h1 id="pending-title">Acesso aguardando liberação</h1><p>Sua conta foi autenticada, mas ainda não possui uma permissão ativa para esta empresa. Solicite a liberação ao administrador.</p><button className="primary-button" onClick={() => controller.retry()}>Verificar liberação</button></section> : state.phase === 'error' ? <section className="real-state-panel"><h1>Consulta indisponível</h1><p role="alert">{state.message}</p><button className="primary-button" onClick={() => controller.retry()}>Tentar novamente</button></section> : <NativeModuleBoundary resetKey={preferencesResetKey(location.pathname)}>{pdv ? ['admin','vendas','consulta','financeiro'].includes(state.membership!.role) ? <RealPdv key={state.membership!.user_id} controller={controller} /> : <section className="real-state-panel"><h1>Frente de caixa não liberada</h1><p>Seu perfil não possui acesso à frente de caixa.</p></section> : isPreferencesPath(location.pathname) ? <CompanyPreferences key={state.membership!.user_id} controller={controller} state={state} /> : location.pathname === '/numeracao-fiscal' ? ['admin','fiscal'].includes(state.membership!.role) ? <RealFiscalNumbering controller={controller} canManage={state.membership!.role === 'admin'} /> : <section className="real-state-panel"><h1>Numeração fiscal não liberada</h1><p>Seu perfil não possui acesso à numeração fiscal.</p></section> : location.pathname === '/notas-recebidas' ? ['admin','fiscal','consulta'].includes(state.membership!.role) ? <RealReceivedDfe controller={controller} canConfigure={state.membership!.role === 'admin'} /> : <section className="real-state-panel"><h1>NF-e recebidas não liberadas</h1><p>Seu perfil não possui acesso aos documentos fiscais recebidos.</p></section> : location.pathname === '/conexao-sefaz' ? ['admin','fiscal'].includes(state.membership!.role) ? <SefazConnection controller={controller} /> : <section className="real-state-panel"><h1>Conexão fiscal não liberada</h1><p>Seu perfil não possui acesso à verificação fiscal.</p></section> : location.pathname === '/certificado-a1' ? ['admin','fiscal'].includes(state.membership!.role) ? <CertificateA1 controller={controller} canManage={state.membership!.role === 'admin'} /> : <section className="real-state-panel"><h1>Certificado não liberado</h1><p>Seu perfil não possui acesso à configuração fiscal.</p></section> : location.pathname === '/retornos-operacionais' ? ['admin','financeiro','consulta'].includes(state.membership!.role) ? <RealCnabOperationalReturns controller={controller} onBack={() => navigate('/cobranca-operacional')} /> : <section className="real-state-panel"><h1>Retornos não liberados</h1><p>Seu perfil não possui acesso aos retornos bancários.</p></section> : location.pathname === '/cobranca-operacional' ? <RealCnabOperational controller={controller} onBack={() => navigate('/cobranca-empresa')} /> : location.pathname === '/integracao-origin' ? state.membership!.role === 'admin' ? <IntegrationProgress controller={controller} /> : <section className="real-state-panel"><h1>Integração não liberada</h1><p>Somente administradores podem acompanhar a integração com o Origin.</p></section> : location.pathname === '/relatorio-vencimentos' ? ['admin','financeiro','consulta'].includes(state.membership!.role) ? <DueDateReport controller={controller} onOpenTitles={({from,to,kind}) => navigate(`/financeiro-empresa?${new URLSearchParams({area:kind,from,to})}`)} /> : <section className="real-state-panel"><h1>Relatório não liberado</h1><p>Seu perfil não possui acesso aos vencimentos financeiros.</p></section> : location.pathname === '/xmls-sincronizados' ? ['admin','fiscal','consulta'].includes(state.membership!.role) ? <SyncedXmlHistory key={fiscalModel} controller={controller} initialModel={fiscalModel} /> : <section className="real-state-panel"><h1>XMLs não liberados</h1><p>Seu perfil não possui acesso aos documentos fiscais sincronizados.</p></section> : location.pathname === '/emissor-fiscal' ? <FiscalDraftAccess key={state.membership!.user_id} controller={controller} state={state} initialModel={draftModel} /> : location.pathname === '/acesso' ? <RealHome controller={controller} />
 : isHelpPath(location.pathname) ? <HelpCenter /> : location.pathname === '/estoque-abertura' ? <RealStockOpening key={state.membership!.user_id} controller={controller} /> : location.pathname === STOCK_OBSERVATIONS_ROUTE ? <OriginStockObservations key={state.membership!.user_id} controller={controller} warehouseSourceId={stockObservationsRouteSource(location.search)??''}/> : location.pathname === '/preparacao-virada/depositos' ? <OriginWarehouseImport key={state.membership!.user_id} controller={controller} onStockObservations={sourceId=>guard.confirmLeave(()=>{const s=controller.getSnapshot();if(s.phase==='ready'&&s.membership?.role==='admin'&&s.membership.user_id===navigationActor)navigate(stockObservationsHref(sourceId));})}/> : location.pathname === '/preparacao-virada' ? <CutoverAccess key={state.membership!.user_id} controller={controller} state={state}/>  : location.pathname === '/empresa-configuracoes' ? <CompanySettings controller={controller} /> : location.pathname === '/cobranca-empresa' ? ['admin','financeiro','consulta'].includes(state.membership!.role) ? <RealCnab controller={controller} /> : <section className="real-state-panel"><h1>Cobrança não liberada</h1><p>Seu perfil não possui acesso à cobrança bancária.</p></section> : location.pathname === '/cobrancas-legadas-itau' ? state.membership!.role === 'admin' ? <ItauLegacyReadiness key={state.membership!.user_id} controller={controller} /> : <section className="real-state-panel"><h1>Conferência não liberada</h1><p>Somente administradores podem conferir as cobranças antigas do Itaú.</p></section> : location.pathname === '/historico-vendas-origin' ? state.membership!.role === 'admin' ? <OriginSalesHistory key={state.membership!.user_id} controller={controller} /> : <section className="real-state-panel"><h1>Histórico não liberado</h1><p>Somente administradores podem consultar o histórico comercial do Origin.</p></section> : location.pathname === '/conferir-vendas-origin' ? state.membership!.role === 'admin' ? <OriginSalesReadiness key={state.membership!.user_id} controller={controller} /> : <section className="real-state-panel"><h1>Conferência não liberada</h1><p>Somente administradores podem conferir as vendas do Origin.</p></section> : location.pathname === '/conferir-compras-origin' ? state.membership!.role === 'admin' ? <OriginPurchaseReadiness key={state.membership!.user_id} controller={controller} /> : <section className="real-state-panel"><h1>Conferência não liberada</h1><p>Somente administradores podem conferir as compras do Origin.</p></section> : location.pathname === '/importar-orcamentos' ? state.membership!.role === 'admin' ? <RealImportProposals key={state.membership!.user_id} controller={controller} /> : <section className="real-state-panel"><h1>Importação não liberada</h1><p>Somente administradores podem importar orçamentos da empresa.</p></section> : location.pathname === '/importar-cadastros' ? state.membership!.role === 'admin' ? <RealImportCatalog controller={controller} /> : <section className="real-state-panel"><h1>Importação não liberada</h1><p>Somente administradores podem importar os cadastros da empresa.</p></section> : location.pathname === '/documentos-empresa' ? <RealDocuments key={documentKind} controller={controller} initialKind={documentKind} /> : location.pathname === '/cadastros-reais' && catalogEntity === 'warehouses' ? ['admin','consulta','estoque'].includes(state.membership!.role) ? <StockWarehouses key={state.membership!.user_id} controller={controller} onPrepareWarehouses={()=>guard.confirmLeave(()=>{if(controller.getSnapshot().phase==='ready'&&controller.getSnapshot().membership?.role==='admin')navigate('/preparacao-virada/depositos');})} /> : <section className="real-state-panel"><h1>Depósitos não liberados</h1><p>Seu perfil não possui acesso aos depósitos.</p></section> : location.pathname === '/conferencia-estoque-empresa' ? <StockCount key={state.membership!.user_id} controller={controller} /> : location.pathname === '/relatorios-estoque' ? <StockReports key={state.membership!.user_id} controller={controller} /> : location.pathname === '/checkin-recebimentos' ? ['admin','estoque','fiscal'].includes(state.membership!.role) ? <ReceiptCheckin key={state.membership!.user_id} controller={controller} /> : <section className="real-state-panel"><h1>Check-in não liberado</h1><p>Seu perfil não possui acesso ao check-in de recebimentos.</p></section> : location.pathname === '/painel-produtos-empresa' ? ['admin','consulta','vendas','fiscal','estoque'].includes(state.membership!.role) ? <StockDashboards key={state.membership!.user_id} controller={controller} /> : <section className="real-state-panel"><h1>Dashboards de produtos não liberados</h1><p>Seu perfil não possui acesso aos dashboards de estoque.</p></section> : location.pathname === '/estoque-empresa' ? ['admin','consulta','vendas','fiscal','estoque'].includes(state.membership!.role) ? <RealStock controller={controller} onPrepareWarehouses={()=>guard.confirmLeave(()=>{if(controller.getSnapshot().phase==='ready'&&controller.getSnapshot().membership?.role==='admin')navigate('/preparacao-virada/depositos');})} /> : <section className="real-state-panel"><h1>Estoque não liberado</h1><p>Seu perfil não possui acesso ao controle de estoque.</p></section> : location.pathname === '/financeiro-empresa' ? ['admin','financeiro','consulta'].includes(state.membership!.role) ? params.get('area') === 'borderos' ? <FinanceBorderos key={`borderos:${state.membership!.user_id}`} controller={controller} /> : financeScreen(params.get('area')) ? <FinanceScreens key={`${params.get('area')}:${state.membership!.user_id}`} controller={controller} area={params.get('area') as FinanceScreen} /> : <RealFinance key={financeTab} controller={controller} initialTab={financeTab} /> : <section className="real-state-panel"><h1>Financeiro não liberado</h1><p>Seu perfil não possui acesso ao financeiro.</p></section> : Object.hasOwn(PRODUCT_TAXONOMY_PATHS, location.pathname) ? <ProductTaxonomy key={`${state.membership!.user_id}:${state.membership!.role}:${location.pathname}`} controller={controller} kind={PRODUCT_TAXONOMY_PATHS[location.pathname]} /> : location.pathname === '/exportacao-produtos' ? <ProductExport key={`${state.membership!.user_id}:${state.membership!.role}`} controller={controller} /> : location.pathname === '/listas-precos' ? <PriceLists key={`${state.membership!.user_id}:${state.membership!.role}`} controller={controller} /> : location.pathname === '/campos-customizados' ? <CustomFields key={`${state.membership!.user_id}:${state.membership!.role}`} controller={controller} /> : location.pathname === '/cadastros-reais' ? <Catalog key={catalogEntity} controller={controller} initialEntity={catalogEntity} onPrepareWarehouses={()=>guard.confirmLeave(()=>{if(controller.getSnapshot().phase==='ready'&&controller.getSnapshot().membership?.role==='admin')navigate('/preparacao-virada/depositos');})} /> : contactModuleRoute(location.pathname) ? <Catalog key={`${location.pathname}:${state.membership!.user_id}`} controller={controller} module={location.pathname} role={state.membership!.role} /> : fiscalInvoiceRoute(location.pathname) ? <FiscalInvoiceRoutes key={state.membership!.user_id} controller={controller} pathname={location.pathname} model={fiscalModel} role={state.membership!.role} /> : <Records controller={controller} state={state} />}</NativeModuleBoundary>}
    </main></div>;
}

export default function RealAccess() {
  if (!configuration || !supabase) return <main id="main-content" className="real-main"><section className="real-state-panel"><h1>Acesso da empresa em preparação</h1><p>A configuração de autenticação e consulta ainda não foi disponibilizada neste ambiente.</p><Link className="primary-button" to="/inicio">Voltar à prévia fictícia</Link></section></main>;
  return <ConnectedArea />;
}
