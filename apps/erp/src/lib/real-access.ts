import {captureStockObservationsRequest,STOCK_OBSERVATIONS_BASE,STOCK_OBSERVATIONS_MAX_BYTES} from './origin-stock-observations-request.ts';
import {captureBackupRequest,fetchBackupRequest,BackupImportHttpError} from './backup-import-client.ts';
import type {BackupRequestOptions} from './backup-import.ts';
import {captureWarehouseRequest,WAREHOUSE_IMPORT_BASE,WAREHOUSE_IMPORT_RESPONSE_BYTES} from './origin-warehouse-import-request.ts';
import {captureStockOpeningRequest,STOCK_OPENING_RESPONSE_BYTES} from './stock-opening-request.ts';
import {captureItauLegacyRequest,ITAU_LEGACY_BASE,ITAU_LEGACY_RESPONSE_BYTES} from './itau-legacy-readiness-request.ts';
import {captureFiscalDraftStatusRequest,FISCAL_DRAFT_STATUS_RESPONSE_BYTES} from './fiscal-draft-status-request.ts';
import {captureSalesReadinessRequest,SALES_READINESS_RESPONSE_BYTES} from './origin-sales-readiness-request.ts';
import {captureSalesHistoryRequest,SALES_HISTORY_BASE,SALES_HISTORY_RESPONSE_BYTES} from './origin-sales-history-request.ts';
import {capturePurchaseReadinessRequest,PURCHASE_READINESS_RESPONSE_BYTES} from './origin-purchase-readiness-request.ts';
import {captureStockReservationsRequest} from './stock-reservations-request.ts';
import {capturePurchaseReceiptsRequest,type PurchaseReceiptsRequestOptions} from './purchase-receipts-request.ts';
import {captureCnabV2Request,CNAB_V2_RESPONSE_BYTES,CNAB_V2_FILE_BYTES} from './cnab-operational-v2-request.ts';
import {captureBoletoRead,BOLETO_RESPONSE_BYTES} from './boleto-preview-model.ts';
import {captureProposalImportRequest} from './proposal-import-request.ts';
import {captureFinancialImportRequest} from './financial-import-request.ts';
import {captureNetCreditRequest,NET_CREDIT_RESPONSE_BYTES} from './itau-net-credit-client.ts';
import {createFiscalUnsignedClient} from './fiscal-unsigned-client.ts';
import {importBeforeDispatch} from './import-failure.ts';
import {captureAuthorizationRequest} from './fiscal-authorization-model.ts';
import {captureFiscalReceiptQueryRequest} from './fiscal-receipt-query-request.ts';
import {captureHomeRequest} from './home-request.ts';
import {capturePreferencesRequest,PREFERENCES_BASE,PREFERENCES_RESPONSE_BYTES} from './preferences-request.ts';
import {captureListPreferencesRequest,LIST_PREFERENCES_BASE,LIST_PREFERENCES_RESPONSE_BYTES} from './list-preferences-request.ts';
import {captureAccessUsersRequest,USERS_BASE,USERS_RESPONSE_BYTES} from './access-users-request.ts';
import {captureSystemRequest,ACTIVITY_RESPONSE_BYTES} from './activity-request.ts';
import {captureSystemPortRequest,SYSTEM_RESPONSE_BYTES} from './system-request.ts';
import {captureReviewedAuthorizationRequest} from './fiscal-reviewed-authorization-model.ts';
import {captureSubsetReviewRequest} from './fiscal-subset-review-model.ts';
import {captureReconciliationRequest} from './fiscal-reconciliation-model.ts';

export const RESOURCE_LABELS = {
  contacts: 'Clientes e fornecedores', products: 'Produtos', sales_orders: 'Pedidos de venda',
  purchase_orders: 'Pedidos de compra', sales_proposals: 'Propostas comerciais',
  receivables: 'Contas a receber', payables: 'Contas a pagar', nfe: 'NF-e · modelo 55', nfce: 'NFC-e · modelo 65',
} as const;
export type Entity = keyof typeof RESOURCE_LABELS;
export type AccessRole = 'admin' | 'consulta' | 'vendas' | 'financeiro' | 'estoque' | 'fiscal';
export const ROLE_LABELS: Record<AccessRole, string> = { admin: 'Administrador', consulta: 'Consulta', vendas: 'Vendas', financeiro: 'Financeiro', estoque: 'Estoque', fiscal: 'Fiscal' };
export interface Membership { user_id: string; role: AccessRole; resources: Entity[]; data_mode: 'staging_readonly' }
export interface Summary {
  id: string; entity: Entity; name: string | null; code: string | null; number: string | null;
  date: string | null; due_date: string | null; status: string | null; amount: string | null;
  balance: string | null; counterparty_id: string | null; counterparty_name: string | null;
  model: string | null; series: string | null; direction: string | null; last_seen_at: string | null;
}
export interface RecordPage { entity: Entity; items: Summary[]; limit: number; offset: number; total: number; has_more: boolean; next_offset: number | null; data_mode: 'staging_readonly' }
export interface ListQuery { entity: Entity; q?: string; status?: string; from?: string; to?: string; limit: number; offset: number }
export interface AccessState {
  phase: 'loading' | 'signed_out' | 'checking' | 'pending' | 'mfa' | 'ready' | 'error';
  membership: Membership | null; records: RecordPage | null; listPending: boolean;
  loginPending: boolean; message: string | null; logoutFailed: boolean;
  permissionMessage?: string | null;
}
interface SessionLike { access_token: string; user: { id: string } }
interface AuthResult { data: { session: SessionLike | null }; error: unknown }
export interface AuthPort {
  getSession(): Promise<AuthResult>;
  onAuthStateChange(callback: (event: string, session: SessionLike | null) => void): { data: { subscription: { unsubscribe(): void } } };
  signInWithPassword(credentials: { email: string; password: string }): Promise<AuthResult>;
  signOut(options: { scope: 'local' }): Promise<{ error: unknown }>;
}
const initial: AccessState = { phase: 'loading', membership: null, records: null, listPending: false, loginPending: false, message: null, logoutFailed: false, permissionMessage: null };
export class AccessError extends Error {
  status: number;
  code?: string;
  /** Field named by a specific refusal of the API (contatos, onda C), e.g. the required field of Preferências. */
  field?: string;
  constructor(status: number, code?: string, field?: string) { super('access_request_failed'); this.status = status; this.code = code; if (field) this.field = field; }
}
export type NativeRequestOptions = { method?: 'GET' | 'POST' | 'PATCH'; body?: unknown; signal?: AbortSignal };
export type A1RequestOptions = { method?: 'GET' | 'POST'; body?: Uint8Array | Record<string, unknown>; signal?: AbortSignal };
export type AttachmentRequestOptions = { method?: 'GET' | 'POST' | 'PUT'; body?: unknown; contentType?: string; download?: boolean; signal?: AbortSignal };
async function limitedBytes(response: Response, limit: number) {
  if (!response.body || Number(response.headers.get('content-length')) > limit) {
    try { await response.body?.cancel(); } catch { /* Never log response data. */ }
    throw new AccessError(502);
  }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > limit) throw new AccessError(502); chunks.push(value); }
  } finally { try { await reader.cancel(); } catch { /* Never log response data. */ } reader.releaseLock(); }
  const bytes = new Uint8Array(size); let position = 0;
  chunks.forEach(chunk => { bytes.set(chunk, position); position += chunk.byteLength; });
  return bytes;
}
/** Code and field of an API refusal ({ error: { code, field } }), read from at most 4 KiB; anything else stays unread. */
async function refusalDetail(response: Response): Promise<{ code?: string; field?: string }> {
  try {
    const value = (JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await limitedBytes(response, 4096))) as { error?: { code?: unknown; field?: unknown } } | null)?.error;
    return { ...(typeof value?.code === 'string' && /^ERP_[A-Z0-9_]{1,64}$/.test(value.code) ? { code: value.code } : {}),
      ...(typeof value?.field === 'string' && /^[a-z_]{1,40}$/.test(value.field) ? { field: value.field } : {}) };
  } catch { return {}; }
}
const entities = Object.keys(RESOURCE_LABELS);
const summaryKeys = ['id', 'entity', 'name', 'code', 'number', 'date', 'due_date', 'status', 'amount', 'balance', 'counterparty_id', 'counterparty_name', 'model', 'series', 'direction', 'last_seen_at'] as const;
function membership(value: unknown): Membership {
  const item = value as Membership;
  if (!item || typeof item.user_id !== 'string' || !Object.hasOwn(ROLE_LABELS, item.role) || item.data_mode !== 'staging_readonly'
    || !Array.isArray(item.resources) || item.resources.some(entity => !entities.includes(entity))) throw new AccessError(502);
  return { user_id: item.user_id, role: item.role, resources: [...new Set(item.resources)], data_mode: 'staging_readonly' };
}
function recordPage(value: unknown, query: ListQuery): RecordPage {
  const page = value as RecordPage;
  if (!page || page.entity !== query.entity || page.data_mode !== 'staging_readonly' || page.limit !== query.limit || page.offset !== query.offset
    || !Number.isSafeInteger(page.total) || page.total < 0 || typeof page.has_more !== 'boolean'
    || page.next_offset !== (page.has_more ? page.offset + page.limit : null) || !Array.isArray(page.items) || page.items.length > query.limit) throw new AccessError(502);
  const items = page.items.map(row => {
    if (!row || typeof row.id !== 'string' || !row.id || row.entity !== query.entity) throw new AccessError(502);
    const safe = {} as Summary;
    for (const key of summaryKeys) {
      const field = row[key] ?? null;
      if (field !== null && (typeof field !== 'string' || field.length > 200)) throw new AccessError(502);
      (safe as unknown as Record<string, string | null>)[key] = field;
    }
    return safe;
  });
  return { entity: page.entity, items, limit: page.limit, offset: page.offset, total: page.total, has_more: page.has_more, next_offset: page.next_offset, data_mode: 'staging_readonly' };
}

/** One in-memory store per authenticated screen. No records, searches or tokens are persisted here. */
export function createAccessController(auth: AuthPort, apiUrl: string, fetcher: typeof fetch = fetch, services: {a1ApiUrl?: string;storageOrigin?: string} = {}) {
  let state: AccessState = { ...initial };
  let token: string | null = null;
  let sessionActor: string | null = null;
  let credentialEpoch = 0;
  let verifiedCredentialEpoch = -1;
  let generation = 0;
  let listGeneration = 0;
  let stopped = true;
  let signingOut = false;
  let subscription: { unsubscribe(): void } | null = null;
  const listeners = new Set<() => void>();
  const requests = new Set<AbortController>();
  let listRequest: AbortController | null = null;
  let permissionRecheck: AbortController | null = null;
  let permissionPromise: Promise<void> | null = null;
  const update = (patch: Partial<AccessState>) => { state = { ...state, ...patch }; listeners.forEach(listener => listener()); };
  const cancel = () => { generation++; listGeneration++; requests.forEach(request => request.abort()); requests.clear(); listRequest = null; permissionRecheck = null; permissionPromise = null; };
  const request = async (path: string, bearer: string, controller: AbortController, options: { method?: 'GET' | 'POST' | 'PATCH'; body?: unknown; responseLimit?: number; timeoutMs?: number } = {}): Promise<unknown> => {
    requests.add(controller);
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), options.timeoutMs ?? 12000);
    try {
      const response = await fetcher(`${apiUrl}${path}`, { method: options.method || 'GET', headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) }, body: options.body ? JSON.stringify(options.body) : undefined,
        cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.any([controller.signal, timeout.signal]) });
      // Only the allow-listed code and field of the API refusal are kept (contatos, onda C); the rest of the body is dropped.
      if (!response.ok) { const detail = await refusalDetail(response); throw new AccessError(response.status, detail.code, detail.field); }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await limitedBytes(response, options.responseLimit ?? 1024 * 1024)));
    } catch (error) {
      if (controller.signal.aborted) throw new DOMException('Request cancelled', 'AbortError');
      throw error instanceof AccessError ? error : new AccessError(503);
    } finally { clearTimeout(timer); requests.delete(controller); }
  };
  // Preferências lane (229): outside the access windows of Sistema › Usuários the session ends with its own message.
  const denyAccess = (status: 401 | 403, code?: string) => {
    cancel();verifiedCredentialEpoch=-1;
    if(status===401){token=null;sessionActor=null;}
    // Leva H (310): the company requires a second factor of this user; the session stays and the screen asks for the code.
    if(status===403&&code==='ERP_MFA_REQUIRED'){update({membership:null,records:null,listPending:false,phase:'mfa',message:null,permissionMessage:null});return;}
    update({membership:null,records:null,listPending:false,phase:status===401?'signed_out':'pending',message:status===401?'Sua sessão expirou. Entre novamente.'
      :code==='ERP_ACCESS_OUTSIDE_SCHEDULE'?'Seu usuário não pode acessar o FAGOO neste horário. Os horários de acesso são definidos pelo administrador da empresa.':null,permissionMessage:null});
  };
  // An operation-level403 is not proof that company membership was revoked.
  // Keep this actor's mounted editor and command while /me checks membership.
  // The server continues to authorize every individual request independently.
  const revalidateMembership = () => {
    if(permissionRecheck)return permissionPromise;
    if(stopped||signingOut||!token||state.phase!=='ready'||!state.membership)return null;
    const current=generation,credential=credentialEpoch,bearer=token,actor=state.membership.user_id,controller=new AbortController();
    if(actor!==sessionActor){denyAccess(401);return null;}
    permissionRecheck=controller;
    const active=()=>!stopped&&!signingOut&&!controller.signal.aborted&&current===generation&&credential===credentialEpoch&&bearer===token&&actor===sessionActor&&state.phase==='ready'&&state.membership?.user_id===actor;
    update({permissionMessage:'Conferindo suas permissões. A tentativa em andamento permanece nesta tela.'});
    permissionPromise=(async()=>{
      try{
        const me=membership(await request('/v1/me',bearer,controller));
        if(!active())return;
        if(me.user_id!==actor){denyAccess(401);return;}
        verifiedCredentialEpoch=credential;
        const changed=me.role!==state.membership!.role||JSON.stringify(me.resources)!==JSON.stringify(state.membership!.resources);
        if(changed){listGeneration++;listRequest?.abort();listRequest=null;}
        update({membership:me,permissionMessage:null,...(changed?{records:null,listPending:false}:{})});
      }catch(error){
        if(!active())return;
        if(error instanceof AccessError&&(error.status===401||error.status===403))denyAccess(error.status,error.code);
        else update({permissionMessage:'Não foi possível reconfirmar seu acesso. Sua tentativa foi preservada; tente verificar as permissões novamente.'});
      }finally{if(permissionRecheck===controller){permissionRecheck=null;permissionPromise=null;}}
    })();
    return permissionPromise;
  };
  const authorizedBearer = (signal?: AbortSignal): string | Promise<string> => {
    const current = generation, actor = sessionActor;
    if (stopped || signingOut || !token || state.phase !== 'ready' || !actor || state.membership?.user_id !== actor) throw new AccessError(401);
    if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
    // Preserve synchronous dispatch for an already verified credential. Only a
    // renewed, unverified credential introduces a wait before sending a request.
    if (verifiedCredentialEpoch === credentialEpoch) return token;
    return (async () => {
      const check = revalidateMembership(); let onAbort: () => void = () => {};
      try {
        await Promise.race([check, new Promise<never>((_, reject) => {
          onAbort = () => reject(new DOMException('Request cancelled', 'AbortError'));
          signal?.addEventListener('abort', onAbort, {once:true});
          if (signal?.aborted) onAbort();
        })]);
      } finally { signal?.removeEventListener('abort', onAbort); }
      if (stopped || signingOut || signal?.aborted || current !== generation || actor !== sessionActor) throw new DOMException('Session changed', 'AbortError');
      if (!token || state.phase !== 'ready' || state.membership?.user_id !== actor) throw new AccessError(401);
      if (verifiedCredentialEpoch !== credentialEpoch) throw new AccessError(503);
      return token;
    })();
  };
  const assertDispatch = (current:number,controller:AbortController,bearer:string) => {
    if(stopped||signingOut||current!==generation||controller.signal.aborted)throw new DOMException('Session changed','AbortError');
    if(state.phase!=='ready'||!sessionActor||state.membership?.user_id!==sessionActor)throw new AccessError(401);
    if(bearer!==token||verifiedCredentialEpoch!==credentialEpoch)throw new AccessError(503);
  };
  const handleAccessFailure = (error: unknown,bearer:string|null,credential:number) => {
    // A response to an older credential cannot log out a verified renewal of
    // the same actor. The component still receives an uncertain/retryable error.
    if(error instanceof AccessError&&error.status===401&&(bearer!==token||credential!==credentialEpoch)&&state.phase==='ready')return new AccessError(503);
    if(error instanceof AccessError&&error.status===401)denyAccess(401);
    else if(error instanceof AccessError&&error.status===403)revalidateMembership();
    return error;
  };
  const checkMembership = async (bearer: string) => {
    const current = generation,credential=credentialEpoch,actor=sessionActor;
    const controller = new AbortController();
    try {
      const me = membership(await request('/v1/me', bearer, controller));
      if (stopped || current !== generation || credential!==credentialEpoch || bearer!==token || actor!==sessionActor) return;
      if(!actor||me.user_id!==actor){denyAccess(401);return;}
      verifiedCredentialEpoch=credential;
      update({ phase: 'ready', membership: me, message: null, permissionMessage:null });
    } catch (error) {
      if (stopped || current !== generation) return;
      const status = error instanceof AccessError ? error.status : 503;
      if (status === 401 || status === 403) denyAccess(status, error instanceof AccessError ? error.code : undefined);
      else update({ phase: 'error', message: 'Não foi possível verificar seu acesso. Tente novamente.' });
    }
  };
  const acceptSession = (session: SessionLike | null,event?:string) => {
    if (stopped || signingOut) return;
    const nextToken = session?.access_token || null;
    const nextActor = session?.user.id || null;
    if (nextToken === token && nextActor===sessionActor && state.phase !== 'loading') return;
    if(event==='TOKEN_REFRESHED'&&token&&nextToken&&nextActor===sessionActor&&state.phase==='ready'&&state.membership?.user_id===nextActor){
      token=nextToken;credentialEpoch++;
      permissionRecheck?.abort();permissionRecheck=null;permissionPromise=null;
      void revalidateMembership();return;
    }
    cancel(); token = nextToken; sessionActor=nextActor;credentialEpoch++;verifiedCredentialEpoch=-1;
    update({ ...initial, phase: token ? 'checking' : 'signed_out' });
    if (token) void checkMembership(token);
  };
  const historyRequest = async (path: string, signal?: AbortSignal, download = false, archive: boolean | 'synced-xml' | 'operational-cnab' | 'operational-cnab-v2' | 'operational-return' | 'received-dfe' = false): Promise<unknown> => {
    const operationalV2=archive==='operational-cnab-v2',receivedDfe=archive==='received-dfe', operationalReturn=archive==='operational-return', operationalCnab=archive==='operational-cnab', cnab=archive===true||operationalCnab||operationalReturn||operationalV2, syncedXml=archive==='synced-xml';
    if (!token || state.phase !== 'ready' || stopped) throw new AccessError(401);
    if (operationalV2 ? !/^\/v1\/cobranca-operacional-v2\/files\/remittance\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(path) : receivedDfe ? !/^\/v1\/notas-recebidas\/documents\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/download$/.test(path) : operationalReturn ? !/^\/v1\/retornos-operacionais\/files\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/download$/.test(path) : operationalCnab ? !/^\/v1\/cobranca-operacional\/files\/remittance\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(path) : syncedXml ? !/^\/v1\/xmls-sincronizados\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/download$/.test(path) : cnab ? !/^\/v1\/cnab\/files\/(remittance|return)\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(path) : !path.startsWith('/v1/history/')) throw new AccessError(400);
    const current = generation; const controller = new AbortController(); const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), operationalV2 ? 65000 : cnab ? 60000 : (syncedXml || receivedDfe) ? 45000 : 25000); const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) controller.abort(); requests.add(controller);
    let bearer=token,credential=credentialEpoch;
    try {
      const authorized=authorizedBearer(controller.signal);bearer=typeof authorized==='string'?authorized:await authorized;assertDispatch(current,controller,bearer);credential=credentialEpoch;
      const response = await fetcher(`${apiUrl}${path}`, { method: 'GET', cache: 'no-store', credentials: 'omit', redirect: 'error',
        headers: { Authorization: `Bearer ${bearer}`, Accept: download ? 'application/octet-stream' : 'application/json' }, signal: AbortSignal.any([controller.signal, timeout.signal]) });
      if (!response.ok) { try { await response.body?.cancel(); } catch { /* No error body is exposed. */ } throw new AccessError(response.status); }
      if (receivedDfe && response.headers.get('Content-Type') !== 'application/octet-stream') { void response.body?.cancel(); throw new AccessError(502); }
      const limit = download ? (operationalV2 ? CNAB_V2_FILE_BYTES : cnab ? 4020000 : 8 * 1024 * 1024) : 1024 * 1024;
      const bytes = await limitedBytes(response, limit);
      if (stopped || current !== generation || controller.signal.aborted) throw new DOMException('Request cancelled', 'AbortError');
      return download ? new Blob([bytes], { type: 'application/octet-stream' }) : JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch (error) {
      if (stopped || current !== generation || controller.signal.aborted) throw new DOMException('Request cancelled', 'AbortError');
      const failure=handleAccessFailure(error,bearer,credential);
      throw failure instanceof AccessError ? failure : new AccessError(503);
    } finally { clearTimeout(timer); requests.delete(controller); signal?.removeEventListener('abort', abort); }
  };
  const nativeRequest = async (prefix: string, path: string, options: NativeRequestOptions = {}, responseLimit = 1024 * 1024, timeoutMs = 12000, beforeDispatch?:()=>void): Promise<unknown> => {
    if (!token || state.phase !== 'ready' || stopped) throw new AccessError(401);
    if (path !== prefix && !path.startsWith(`${prefix}/`) && !path.startsWith(`${prefix}?`)) throw new AccessError(400);
    const pathname=path.split('?')[0];
    if (path.includes('#') || pathname.includes('\\') || /%(?:2e|2f|5c)/i.test(pathname) || pathname.split('/').some(part => part === '.' || part === '..')) throw new AccessError(400);
    const current = generation; const controller = new AbortController(); const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) controller.abort();requests.add(controller);
    let bearer=token,credential=credentialEpoch;
    try {
      const authorized=authorizedBearer(controller.signal);bearer=typeof authorized==='string'?authorized:await authorized;assertDispatch(current,controller,bearer);credential=credentialEpoch;
      beforeDispatch?.();
      const result = await request(path, bearer, controller, { ...options, responseLimit, timeoutMs });
      if (stopped || current !== generation || controller.signal.aborted) throw new DOMException('Request cancelled', 'AbortError');
      return result;
    } catch (error) {
      if (stopped || current !== generation || controller.signal.aborted) throw new DOMException('Request cancelled', 'AbortError');
      throw handleAccessFailure(error,bearer,credential);
    } finally { requests.delete(controller);options.signal?.removeEventListener('abort', abort); }
  };
  const a1Request = async (path: string, options: A1RequestOptions = {}): Promise<unknown> => {
    if (!token || state.phase !== 'ready' || stopped) throw new AccessError(401);
    let base: URL;
    try { base = new URL(services.a1ApiUrl || ''); } catch { throw new AccessError(503); }
    if (base.protocol !== 'https:' || base.origin !== services.a1ApiUrl || base.username || base.password) throw new AccessError(503);
    const method = options.method || 'GET', configure = path === '/v1/a1/configure';
    const read = path === '/v1/a1' || /^\/v1\/a1\/commands\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(path);
    if (read ? method !== 'GET' || options.body !== undefined : !['/v1/a1/configure','/v1/a1/disable','/v1/a1/rewrap'].includes(path) || method !== 'POST') throw new AccessError(400);
    let body: Uint8Array<ArrayBuffer> | undefined;
    if (method === 'POST') {
      if (configure) {
        if (!(options.body instanceof Uint8Array) || options.body.length < 16 || options.body.length > 1053712) throw new AccessError(400);
        body = new Uint8Array(options.body);
      } else {
        if (!options.body || typeof options.body !== 'object' || Array.isArray(options.body) || options.body instanceof Uint8Array) throw new AccessError(400);
        body = new TextEncoder().encode(JSON.stringify(options.body));
        if (body.length > 4096) { body.fill(0); throw new AccessError(400); }
      }
    }
    const current = generation, controller = new AbortController(), timeout = new AbortController();
    const abort = () => controller.abort(), timer = setTimeout(() => timeout.abort(), 65000);
    options.signal?.addEventListener('abort', abort, {once:true}); if(options.signal?.aborted) controller.abort(); requests.add(controller);
    let bearer=token,credential=credentialEpoch;
    try {
      const authorized=authorizedBearer(controller.signal);bearer=typeof authorized==='string'?authorized:await authorized;assertDispatch(current,controller,bearer);credential=credentialEpoch;
      const response = await fetcher(`${base.origin}${path}`, {method, cache:'no-store', credentials:'omit', redirect:'error',
        headers:{Authorization:`Bearer ${bearer}`, Accept:'application/json', ...(method === 'POST' ? {'Content-Type':configure ? 'application/vnd.brufap.a1+octet-stream' : 'application/json'} : {})},
        body, signal:AbortSignal.any([controller.signal,timeout.signal])});
      if (!response.ok) {
        let code: string | undefined;
        try {
          const raw=await limitedBytes(response,8192);
          try { const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
            const codes=['A1_RUNTIME_UNAUTHORIZED','A1_BODY_AUTHENTICATION_FAILED','A1_FORBIDDEN','A1_NOT_FOUND','A1_CONFLICT','A1_INVALID_REQUEST','A1_RUNTIME_BUSY','A1_UPSTREAM_UNAVAILABLE','A1_COMPANY_CHANGED','A1_KEY_ROTATION_UNAVAILABLE','A1_LEASE_EXPIRED','A1_CREDENTIAL_REJECTED','A1_RUNTIME_FAILED','A1_RESPONSE_INVALID','A1_STORAGE_VALIDATION_FAILED','A1_BODY_TOO_LARGE','A1_BODY_TIMEOUT','A1_BODY_INVALID','A1_ENCODING_UNSUPPORTED','A1_CONTENT_TYPE_UNSUPPORTED','A1_GATEWAY_UNAVAILABLE','A1_AUTH_SERVICE_UNAVAILABLE','A1_REQUEST_SIGNING_FAILED','A1_RUNTIME_BINDING_UNAVAILABLE','A1_ORIGIN_FORBIDDEN','A1_UNAUTHENTICATED'];
            if(codes.includes(value?.error))code=value.error;
          } finally { raw.fill(0); }
        } catch { /* Never expose unknown server errors, diagnostics or body fields. */ }
        throw new AccessError(response.status,code);
      }
      const raw = await limitedBytes(response,65536);
      try {
        if (stopped || current !== generation || controller.signal.aborted) throw new DOMException('Request cancelled','AbortError');
        return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
      } finally { raw.fill(0); }
    } catch(error) {
      if(stopped || current !== generation || controller.signal.aborted) throw new DOMException('Request cancelled','AbortError');
      const failure=handleAccessFailure(error,bearer,credential);
      throw failure instanceof AccessError ? failure : new AccessError(503);
    } finally { body?.fill(0); clearTimeout(timer); requests.delete(controller); options.signal?.removeEventListener('abort',abort); }
  };
  const attachmentRequest = async (path: string, options: AttachmentRequestOptions = {}): Promise<unknown> => {
    if (!token || state.phase !== 'ready' || stopped) throw new AccessError(401);
    const match = /^\/v1\/documentos\/(sales_proposals|sales_orders|purchase_orders|service_orders)\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\/anexos(?:\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\/(upload|download|abort|exclusao))?$/.exec(path);
    // 202610200170: Foto e Anexos of Clientes e fornecedores use the same proxy (plus the logical deletion, "exclusao").
    // 202610200193 (produtos lane): Imagens armazenadas of the product, plus their order ("ordem").
    const contact = /^\/v1\/anexos-cadastros\/(?:contatos\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?:\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/(upload|download|abort|exclusao))?|produtos\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?:\/(ordem)|\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/(upload|download|abort|exclusao))?)$/.exec(path);
    // 202610200211: Anexos of contas and of lançamentos de caixa (financeiro) use the same proxy.
    const finance = /^\/v1\/anexos-financeiro\/(?:contas|lancamentos)\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?:\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/(upload|download|abort|exclusao))?$/.exec(path);
    // 202610200262: the logo of the company (Empresa › Sua marca) uses the same proxy.
    const logo = /^\/v1\/anexos-empresa\/logo(?:\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/(upload|download|abort|exclusao))?$/.exec(path);
    // 202610200301: the company files of the Gerenciador de arquivos (Inserir Arquivo); the base only reserves (POST).
    const companyFile = /^\/v1\/anexos-empresa\/arquivos(?:\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/(upload|download|abort|exclusao))?$/.exec(path);
    if (!match && !contact && !finance && !logo && !companyFile) throw new AccessError(400);
    if (companyFile && !companyFile[1] && options.method !== 'POST') throw new AccessError(400);
    const action = match ? match[4] : contact ? contact[1] ?? contact[2] ?? contact[3] : finance ? finance[1] : logo ? logo[1] : companyFile![1], method = options.method || 'GET';
    if (action === 'upload' ? method !== 'PUT' : action === 'abort' || action === 'exclusao' || action === 'ordem' ? method !== 'POST' : action === 'download' ? method !== 'GET' || !options.download : !['GET', 'POST'].includes(method)) throw new AccessError(400);
    if (options.download && action !== 'download') throw new AccessError(400);
    if (action !== 'upload' && action !== 'download') return nativeRequest(contact ? '/v1/anexos-cadastros' : finance ? '/v1/anexos-financeiro' : logo ? '/v1/anexos-empresa/logo' : companyFile ? '/v1/anexos-empresa/arquivos' : '/v1/documentos', path, { method: method as 'GET' | 'POST', body: options.body, signal: options.signal });
    const upload = action === 'upload';
    if (upload && (!(options.body instanceof Blob) || options.body.size < 1 || options.body.size > 10 * 1024 * 1024 || !['application/pdf', 'image/png', 'image/jpeg', 'application/xml', 'text/plain'].includes(options.contentType || ''))) throw new AccessError(400);
    const current = generation, controller = new AbortController(), timeout = new AbortController();
    const abort = () => controller.abort(), timer = setTimeout(() => timeout.abort(), upload ? 120000 : 45000);
    options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) controller.abort(); requests.add(controller);
    let bearer=token,credential=credentialEpoch;
    try {
      const authorized=authorizedBearer(controller.signal);bearer=typeof authorized==='string'?authorized:await authorized;assertDispatch(current,controller,bearer);credential=credentialEpoch;
      const response = await fetcher(`${apiUrl}${path}`, { method, cache: 'no-store', credentials: 'omit', redirect: 'error',
        headers: { Authorization: `Bearer ${bearer}`, Accept: upload ? 'application/json' : 'application/octet-stream', ...(upload ? { 'Content-Type': options.contentType! } : {}) },
        ...(upload ? { body: options.body as Blob } : {}), signal: AbortSignal.any([controller.signal, timeout.signal]) });
      if (!response.ok) { try { await response.body?.cancel(); } catch { /* Never expose error data. */ } throw new AccessError(response.status); }
      if (!upload && response.headers.get('Content-Type') !== 'application/octet-stream') { void response.body?.cancel(); throw new AccessError(502); }
      const bytes = await limitedBytes(response, upload ? 1024 * 1024 : 10 * 1024 * 1024);
      if (stopped || current !== generation || controller.signal.aborted) throw new DOMException('Request cancelled', 'AbortError');
      return upload ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) : new Blob([bytes], { type: 'application/octet-stream' });
    } catch (error) {
      if (stopped || current !== generation || controller.signal.aborted) throw new DOMException('Request cancelled', 'AbortError');
      const failure=handleAccessFailure(error,bearer,credential);
      throw failure instanceof AccessError ? failure : new AccessError(503);
    } finally { clearTimeout(timer); requests.delete(controller); options.signal?.removeEventListener('abort', abort); }
  };
  const unsignedRequest = async (path: string, options: NativeRequestOptions = {}): Promise<unknown> => {
    if (stopped || !token) throw new AccessError(401);
    const current=generation,controller=new AbortController(),abort=()=>controller.abort();
    requests.add(controller);options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
    let bearer=token,credential=credentialEpoch;
    try { const client=createFiscalUnsignedClient({origin:services.a1ApiUrl || '',getToken:async()=>{const authorized=authorizedBearer(controller.signal);bearer=typeof authorized==='string'?authorized:await authorized;assertDispatch(current,controller,bearer);credential=credentialEpoch;return bearer;},getSnapshot:()=>state,getEpoch:()=>generation,fetchImpl:fetcher});return await client(path,{...options,signal:controller.signal}); }
    catch(error) {
      if(stopped||current!==generation||controller.signal.aborted)throw new DOMException('Request cancelled','AbortError');
      throw handleAccessFailure(error,bearer,credential);
    } finally {requests.delete(controller);options.signal?.removeEventListener('abort',abort);}
  };
  const signedRequest = async (path: string, options: NativeRequestOptions = {}): Promise<unknown> => {
    if (stopped || !token) throw new AccessError(401);
    // Capture the flat protocol body and cancellation signal before dynamic import/token refresh can yield.
    let captured:NativeRequestOptions;
    try {
      const data=(value:unknown):Record<string,unknown>=>{
        if(value===null||typeof value!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new AccessError(400);
        const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(value),out:Record<string,unknown>=Object.create(null);
        for(const key of keys){if(typeof key!=='string'||!descriptors[key]?.enumerable||!Object.hasOwn(descriptors[key],'value'))throw new AccessError(400);out[key]=descriptors[key].value;}return out;
      };
      const own=data(options);if(Object.keys(own).some(k=>!['method','body','signal'].includes(k))||own.signal!==undefined&&!(own.signal instanceof AbortSignal))throw new AccessError(400);
      captured={...(own.method===undefined?{}:{method:own.method as NativeRequestOptions['method']}),...(own.signal===undefined?{}:{signal:own.signal as AbortSignal})};
      if(own.body!==undefined){const body=data(own.body);if(Object.values(body).some(v=>v!==null&&!['string','number','boolean'].includes(typeof v)))throw new AccessError(400);captured.body=Object.freeze(body);}
      Object.freeze(captured);
    }catch{throw new AccessError(400);}
    const current=generation,controller=new AbortController(),abort=()=>controller.abort();
    requests.add(controller);captured.signal?.addEventListener('abort',abort,{once:true});if(captured.signal?.aborted)abort();
    let bearer=token,credential=credentialEpoch,SignedFailure:typeof import('./fiscal-signed-client.ts')['SignedClientError']|undefined;
    try {
      // The error class extends AccessError; defer this module until the controller has initialized.
      const {createFiscalSignedClient,SignedClientError}=await import('./fiscal-signed-client.ts');SignedFailure=SignedClientError;
      if(stopped||current!==generation||controller.signal.aborted)throw new DOMException('Request cancelled','AbortError');
      const client=createFiscalSignedClient({origin:services.a1ApiUrl || '',getToken:async()=>{const authorized=authorizedBearer(controller.signal);bearer=typeof authorized==='string'?authorized:await authorized;assertDispatch(current,controller,bearer);credential=credentialEpoch;return bearer;},getSnapshot:()=>state,getEpoch:()=>generation,fetchImpl:fetcher});
      return await client(path,{...captured,signal:controller.signal});
    } catch(error) {
      if(stopped||current!==generation||controller.signal.aborted)throw new DOMException('Request cancelled','AbortError');
      if(SignedFailure&&error instanceof SignedFailure&&error.recovery_required){
        if(error.upstream_status===401||error.upstream_status===403)handleAccessFailure(new AccessError(error.upstream_status),bearer,credential);
        throw error;
      }
      throw handleAccessFailure(error,bearer,credential);
    } finally {requests.delete(controller);captured.signal?.removeEventListener('abort',abort);}
  };
  const wsdlRequest = async (path: string, options: NativeRequestOptions = {}): Promise<unknown> => {
    if (stopped || !token) throw new AccessError(401);
    // Capture the flat protocol body and cancellation signal before dynamic import/token refresh can yield.
    let captured:NativeRequestOptions;
    try {
      const data=(value:unknown):Record<string,unknown>=>{
        if(value===null||typeof value!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new AccessError(400);
        const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(value),out:Record<string,unknown>=Object.create(null);
        for(const key of keys){if(typeof key!=='string'||!descriptors[key]?.enumerable||!Object.hasOwn(descriptors[key],'value'))throw new AccessError(400);out[key]=descriptors[key].value;}return out;
      };
      const own=data(options);if(Object.keys(own).some(k=>!['method','body','signal'].includes(k))||own.signal!==undefined&&!(own.signal instanceof AbortSignal))throw new AccessError(400);
      captured={...(own.method===undefined?{}:{method:own.method as NativeRequestOptions['method']}),...(own.signal===undefined?{}:{signal:own.signal as AbortSignal})};
      if(own.body!==undefined){const body=data(own.body);if(Object.values(body).some(v=>v!==null&&!['string','number','boolean'].includes(typeof v)))throw new AccessError(400);captured.body=Object.freeze(body);}
      Object.freeze(captured);
    }catch{throw new AccessError(400);}
    const current=generation,controller=new AbortController(),abort=()=>controller.abort();
    requests.add(controller);captured.signal?.addEventListener('abort',abort,{once:true});if(captured.signal?.aborted)abort();
    let bearer=token,credential=credentialEpoch,WsdlFailure:typeof import('./wsdl-client.ts')['WsdlClientError']|undefined;
    try {
      // The error class extends AccessError; defer this module until the controller has initialized.
      const {createWsdlClient,WsdlClientError}=await importBeforeDispatch(()=>import('./wsdl-client.ts'));WsdlFailure=WsdlClientError;
      if(stopped||current!==generation||controller.signal.aborted)throw new DOMException('Request cancelled','AbortError');
      const client=createWsdlClient({origin:services.a1ApiUrl || '',getToken:async()=>{const authorized=authorizedBearer(controller.signal);bearer=typeof authorized==='string'?authorized:await authorized;assertDispatch(current,controller,bearer);credential=credentialEpoch;return bearer;},getSnapshot:()=>state,getEpoch:()=>generation,fetchImpl:fetcher});
      return await client(path,{...captured,signal:controller.signal});
    } catch(error) {
      if(stopped||current!==generation||controller.signal.aborted)throw new DOMException('Request cancelled','AbortError');
      if(WsdlFailure&&error instanceof WsdlFailure&&error.recovery_required){
        if(error.upstream_status===401||error.upstream_status===403)handleAccessFailure(new AccessError(error.upstream_status),bearer,credential);
        throw error;
      }
      throw handleAccessFailure(error,bearer,credential);
    } finally {requests.delete(controller);captured.signal?.removeEventListener('abort',abort);}
  };
  const reconciliationRequest = async (path:string,options:NativeRequestOptions={}):Promise<unknown> => {
    if(stopped||!token)throw new AccessError(401);
    let selected:ReturnType<typeof captureReconciliationRequest>;
    try{selected=captureReconciliationRequest(path,options);}catch{throw new AccessError(400);}
    const current=generation,controller=new AbortController(),abort=()=>controller.abort();requests.add(controller);
    selected.signal?.addEventListener('abort',abort,{once:true});if(selected.signal?.aborted)abort();
    let bearer=token,credential=credentialEpoch,ReconciliationFailure:typeof import('./fiscal-reconciliation-client.ts')['ReconciliationClientError']|undefined;
    try{
      const {createFiscalReconciliationClient,ReconciliationClientError}=await importBeforeDispatch(()=>import('./fiscal-reconciliation-client.ts'));ReconciliationFailure=ReconciliationClientError;
      if(stopped||current!==generation||controller.signal.aborted)throw new DOMException('Request cancelled','AbortError');
      const client=createFiscalReconciliationClient({origin:services.a1ApiUrl||'',getToken:async()=>{const authorized=authorizedBearer(controller.signal);bearer=typeof authorized==='string'?authorized:await authorized;assertDispatch(current,controller,bearer);credential=credentialEpoch;return bearer;},getSnapshot:()=>state,getEpoch:()=>generation,fetchImpl:fetcher});
      return await client(path,{method:selected.method,...(selected.action==='command'?{}:{body:selected.payload}),signal:controller.signal});
    }catch(error){
      if(stopped||current!==generation||controller.signal.aborted)throw new DOMException('Request cancelled','AbortError');
      if(ReconciliationFailure&&error instanceof ReconciliationFailure&&error.recovery_required){
        if(error.upstream_status===401||error.upstream_status===403)handleAccessFailure(new AccessError(error.upstream_status),bearer,credential);
        throw error;
      }
      throw handleAccessFailure(error,bearer,credential);
    }finally{requests.delete(controller);selected.signal?.removeEventListener('abort',abort);}
  };
  const subsetReviewRequest = async (path:string,options:NativeRequestOptions={}):Promise<unknown> => {
    if(stopped||!token)throw new AccessError(401);
    let selected:ReturnType<typeof captureSubsetReviewRequest>;
    try{selected=captureSubsetReviewRequest(path,options);}catch{throw new AccessError(400);}
    const current=generation,controller=new AbortController(),abort=()=>controller.abort();requests.add(controller);
    selected.signal?.addEventListener('abort',abort,{once:true});if(selected.signal?.aborted)abort();
    let bearer=token,credential=credentialEpoch,SubsetReviewFailure:typeof import('./fiscal-subset-review-client.ts')['SubsetReviewClientError']|undefined;
    try{
      const {createFiscalSubsetReviewClient,SubsetReviewClientError}=await importBeforeDispatch(()=>import('./fiscal-subset-review-client.ts'));SubsetReviewFailure=SubsetReviewClientError;
      if(stopped||current!==generation||controller.signal.aborted)throw new DOMException('Request cancelled','AbortError');
      const client=createFiscalSubsetReviewClient({origin:services.a1ApiUrl||'',getToken:async()=>{const authorized=authorizedBearer(controller.signal);bearer=typeof authorized==='string'?authorized:await authorized;assertDispatch(current,controller,bearer);credential=credentialEpoch;return bearer;},getSnapshot:()=>state,getEpoch:()=>generation,fetchImpl:fetcher});
      return await client(path,{method:selected.method,...(selected.action==='reviewSave'?{body:selected.payload}:{}),signal:controller.signal});
    }catch(error){
      if(stopped||current!==generation||controller.signal.aborted)throw new DOMException('Request cancelled','AbortError');
      if(SubsetReviewFailure&&error instanceof SubsetReviewFailure&&error.recovery_required){
        if(error.upstream_status===401||error.upstream_status===403)handleAccessFailure(new AccessError(error.upstream_status),bearer,credential);
        throw error;
      }
      throw handleAccessFailure(error,bearer,credential);
    }finally{requests.delete(controller);selected.signal?.removeEventListener('abort',abort);}
  };
  const reviewedAuthorizationRequest = async (path:string,options:NativeRequestOptions={}):Promise<unknown> => {
    if(stopped||!token)throw new AccessError(401);
    let selected:ReturnType<typeof captureReviewedAuthorizationRequest>;
    try{selected=captureReviewedAuthorizationRequest(path,options);}catch{throw new AccessError(400);}
    const current=generation,controller=new AbortController(),abort=()=>controller.abort();requests.add(controller);
    selected.signal?.addEventListener('abort',abort,{once:true});if(selected.signal?.aborted)abort();
    let bearer=token,credential=credentialEpoch,ReviewedAuthorizationFailure:typeof import('./fiscal-reviewed-authorization-client.ts')['ReviewedAuthorizationClientError']|undefined;
    try{
      const {createFiscalReviewedAuthorizationClient,ReviewedAuthorizationClientError}=await importBeforeDispatch(()=>import('./fiscal-reviewed-authorization-client.ts'));ReviewedAuthorizationFailure=ReviewedAuthorizationClientError;
      if(stopped||current!==generation||controller.signal.aborted)throw new DOMException('Request cancelled','AbortError');
      const client=createFiscalReviewedAuthorizationClient({origin:services.a1ApiUrl||'',getToken:async()=>{const authorized=authorizedBearer(controller.signal);bearer=typeof authorized==='string'?authorized:await authorized;assertDispatch(current,controller,bearer);credential=credentialEpoch;return bearer;},getSnapshot:()=>state,getEpoch:()=>generation,fetchImpl:fetcher});
      return await client(path,{method:selected.route.method,...(selected.route.method==='POST'?{body:selected.payload}:{}),signal:controller.signal});
    }catch(error){
      if(stopped||current!==generation||controller.signal.aborted)throw new DOMException('Request cancelled','AbortError');
      if(ReviewedAuthorizationFailure&&error instanceof ReviewedAuthorizationFailure&&error.recovery_required){
        if(error.upstream_status===401||error.upstream_status===403)handleAccessFailure(new AccessError(error.upstream_status),bearer,credential);
        throw error;
      }
      throw handleAccessFailure(error,bearer,credential);
    }finally{requests.delete(controller);selected.signal?.removeEventListener('abort',abort);}
  };
  const receiptQueryRequest = async (path:string,options:NativeRequestOptions={}):Promise<unknown> => {
    if(stopped||!token)throw new AccessError(401);
    let selected:ReturnType<typeof captureFiscalReceiptQueryRequest>;
    try{selected=captureFiscalReceiptQueryRequest(path,options);}catch{throw new AccessError(400);}
    const current=generation,controller=new AbortController(),abort=()=>controller.abort();requests.add(controller);
    selected.options.signal?.addEventListener('abort',abort,{once:true});if(selected.options.signal?.aborted)abort();
    let bearer=token,credential=credentialEpoch,ReceiptQueryFailure:typeof import('./fiscal-receipt-query-client.ts')['ReceiptQueryClientError']|undefined;
    try{
      const {createFiscalReceiptQueryClient,ReceiptQueryClientError}=await importBeforeDispatch(()=>import('./fiscal-receipt-query-client.ts'));ReceiptQueryFailure=ReceiptQueryClientError;
      if(stopped||current!==generation||controller.signal.aborted)throw new DOMException('Request cancelled','AbortError');
      const client=createFiscalReceiptQueryClient({origin:services.a1ApiUrl||'',getToken:async()=>{const authorized=authorizedBearer(controller.signal);bearer=typeof authorized==='string'?authorized:await authorized;assertDispatch(current,controller,bearer);credential=credentialEpoch;return bearer;},getSnapshot:()=>state,getEpoch:()=>generation,fetchImpl:fetcher});
      return await client(path,{...selected.options,signal:controller.signal});
    }catch(error){
      if(stopped||current!==generation||controller.signal.aborted)throw new DOMException('Request cancelled','AbortError');
      if(ReceiptQueryFailure&&error instanceof ReceiptQueryFailure&&error.recovery_required){
        if(error.upstream_status===401||error.upstream_status===403)handleAccessFailure(new AccessError(error.upstream_status),bearer,credential);
        throw error;
      }
      throw handleAccessFailure(error,bearer,credential);
    }finally{requests.delete(controller);selected.options.signal?.removeEventListener('abort',abort);}
  };
  const danfeRequest = async (path:string,options:NativeRequestOptions={}):Promise<unknown> => {
    if(stopped||!token)throw new AccessError(401);
    // Capture a read-only request before token refresh or module loading can yield.
    if(options===null||typeof options!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(options)))throw new AccessError(400);
    const descriptors=Object.getOwnPropertyDescriptors(options),keys=Reflect.ownKeys(descriptors);
    if(keys.some(k=>typeof k!=='string'||!['method','signal'].includes(k)||!Object.hasOwn(descriptors[k],'value')||!descriptors[k].enumerable))throw new AccessError(400);
    const method=descriptors.method?.value,signal=descriptors.signal?.value;
    if(method!==undefined&&method!=='GET'||signal!==undefined&&!(signal instanceof AbortSignal))throw new AccessError(400);
    const current=generation,controller=new AbortController(),abort=()=>controller.abort();requests.add(controller);
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    let bearer=token,credential=credentialEpoch;
    try{
      const {createFiscalDanfeClient}=await importBeforeDispatch(()=>import('./fiscal-danfe-client.ts'));
      if(stopped||current!==generation||controller.signal.aborted)throw new DOMException('Request cancelled','AbortError');
      const client=createFiscalDanfeClient({origin:services.a1ApiUrl||'',getToken:async()=>{const authorized=authorizedBearer(controller.signal);bearer=typeof authorized==='string'?authorized:await authorized;assertDispatch(current,controller,bearer);credential=credentialEpoch;return bearer;},getSnapshot:()=>state,getEpoch:()=>generation,fetchImpl:fetcher});
      return await client(path,{method:'GET',signal:controller.signal});
    }catch(error){if(stopped||current!==generation||controller.signal.aborted)throw new DOMException('Request cancelled','AbortError');throw handleAccessFailure(error,bearer,credential);}
    finally{requests.delete(controller);signal?.removeEventListener('abort',abort);}
  };
  const processedDocumentRequest = async (path:string,options:NativeRequestOptions={}):Promise<unknown> => {
    if(stopped||!token)throw new AccessError(401);
    // Capture a read-only request before token refresh or module loading can yield.
    if(options===null||typeof options!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(options)))throw new AccessError(400);
    const descriptors=Object.getOwnPropertyDescriptors(options),keys=Reflect.ownKeys(descriptors);
    if(keys.some(k=>typeof k!=='string'||!['method','signal'].includes(k)||!Object.hasOwn(descriptors[k],'value')||!descriptors[k].enumerable))throw new AccessError(400);
    const method=descriptors.method?.value,signal=descriptors.signal?.value;
    if(method!==undefined&&method!=='GET'||signal!==undefined&&!(signal instanceof AbortSignal))throw new AccessError(400);
    const current=generation,controller=new AbortController(),abort=()=>controller.abort();requests.add(controller);
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    let bearer=token,credential=credentialEpoch;
    try{
      const {createFiscalProcessedDocumentClient}=await importBeforeDispatch(()=>import('./fiscal-processed-document-client.ts'));
      if(stopped||current!==generation||controller.signal.aborted)throw new DOMException('Request cancelled','AbortError');
      const client=createFiscalProcessedDocumentClient({origin:services.a1ApiUrl||'',getToken:async()=>{const authorized=authorizedBearer(controller.signal);bearer=typeof authorized==='string'?authorized:await authorized;assertDispatch(current,controller,bearer);credential=credentialEpoch;return bearer;},getSnapshot:()=>state,getEpoch:()=>generation,fetchImpl:fetcher});
      return await client(path,{method:'GET',signal:controller.signal});
    }catch(error){if(stopped||current!==generation||controller.signal.aborted)throw new DOMException('Request cancelled','AbortError');throw handleAccessFailure(error,bearer,credential);}
    finally{requests.delete(controller);signal?.removeEventListener('abort',abort);}
  };
  const authorizationRequest = async (path:string,options:NativeRequestOptions={}):Promise<unknown> => {
    if(stopped||!token)throw new AccessError(401);
    let selected:ReturnType<typeof captureAuthorizationRequest>;try{selected=captureAuthorizationRequest(path,options);}catch{throw new AccessError(400);}
    const signal=selected.signal;
    const current=generation,controller=new AbortController(),abort=()=>controller.abort();requests.add(controller);
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    let bearer=token,credential=credentialEpoch;
    try{
      const {createFiscalAuthorizationClient}=await importBeforeDispatch(()=>import('./fiscal-authorization-client.ts'));
      if(stopped||current!==generation||controller.signal.aborted)throw new DOMException('Request cancelled','AbortError');
      const client=createFiscalAuthorizationClient({origin:services.a1ApiUrl||'',getToken:async()=>{const authorized=authorizedBearer(controller.signal);bearer=typeof authorized==='string'?authorized:await authorized;assertDispatch(current,controller,bearer);credential=credentialEpoch;return bearer;},getSnapshot:()=>state,getEpoch:()=>generation,fetchImpl:fetcher});
      return await client(path,{method:selected.method,...(selected.action==='command'?{}:{body:selected.payload}),signal:controller.signal});
    }catch(error){if(stopped||current!==generation||controller.signal.aborted)throw new DOMException('Request cancelled','AbortError');throw handleAccessFailure(error,bearer,credential);}
    finally{requests.delete(controller);signal?.removeEventListener('abort',abort);}
  };
  const backupImportRequest=async(path:string,options:BackupRequestOptions={})=>{
    const selected=captureBackupRequest(path,options),current=generation,controller=new AbortController();
    const requireAdmin=()=>{if(stopped||signingOut||state.phase!=='ready'||state.membership?.role!=='admin')throw new AccessError(state.phase==='ready'?403:401);};
    requireAdmin();requests.add(controller);const abort=()=>controller.abort();selected.signal?.addEventListener('abort',abort,{once:true});if(selected.signal?.aborted)abort();
    const timer=setTimeout(abort,selected.finish?900000:120000);let bearer=token,credential=credentialEpoch;
    try{
      const authorized=authorizedBearer(controller.signal);bearer=typeof authorized==='string'?authorized:await authorized;credential=credentialEpoch;
      const check=()=>{assertDispatch(current,controller,bearer!);requireAdmin();};check();
      return await fetchBackupRequest(apiUrl,{...selected,signal:controller.signal},bearer,fetcher,check);
    }catch(error){if(stopped||current!==generation||controller.signal.aborted)throw new DOMException('Request cancelled','AbortError');
      throw handleAccessFailure(error instanceof BackupImportHttpError?new AccessError(error.status):error,bearer,credential);
    }finally{clearTimeout(timer);requests.delete(controller);selected.signal?.removeEventListener('abort',abort);controller.abort();}
  };
  return {
    storageOrigin: services.storageOrigin,
    getSnapshot: () => state,
    backupImport: backupImportRequest,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start() {
      stopped = false;
      const current = generation;
      subscription = auth.onAuthStateChange((event, session) => acceptSession(session,event)).data.subscription;
      void auth.getSession().then(result => {
        if (stopped || current !== generation) return;
        if (result.error) update({ phase: 'signed_out', message: 'Não foi possível recuperar sua sessão. Entre novamente.' });
        else acceptSession(result.data.session);
      }).catch(() => { if (!stopped && current === generation) update({ phase: 'signed_out', message: 'Não foi possível recuperar sua sessão.' }); });
      return () => { stopped = true; subscription?.unsubscribe(); subscription = null; cancel(); token = null; sessionActor=null; state = { ...initial }; };
    },
    async login(email: string, password: string) {
      if (state.loginPending || signingOut) return;
      update({ loginPending: true, message: null });
      try {
        const result = await auth.signInWithPassword({ email: email.trim(), password });
        if (stopped) return;
        if (result.error || !result.data.session) update({ phase: 'signed_out', message: 'Não foi possível entrar. Confira seu e-mail e senha e tente novamente.' });
        else acceptSession(result.data.session);
      } catch { if (!stopped) update({ phase: 'signed_out', message: 'Não foi possível entrar. Verifique sua conexão e tente novamente.' }); }
      finally { if (!stopped) update({ loginPending: false }); }
    },
    async logout() {
      signingOut = true; cancel(); token = null; sessionActor=null;
      update({ ...initial, phase: 'signed_out' });
      try {
        const result = await auth.signOut({ scope: 'local' });
        if (!stopped && result.error) update({ logoutFailed: true, message: 'Não foi possível confirmar a saída. Tente encerrar a sessão novamente.' });
      } catch { if (!stopped) update({ logoutFailed: true, message: 'Não foi possível confirmar a saída. Tente encerrar a sessão novamente.' }); }
      finally { signingOut = false; }
    },
    retry() {
      if (!token || stopped) return;
      if(state.phase==='ready'){revalidateMembership();return;}
      cancel(); update({ membership: null, records: null, phase: 'checking', listPending: false, message: null });
      void checkMembership(token);
    },
    catalog: (path: string, options: NativeRequestOptions = {}) => nativeRequest('/v1/cadastros', path, options),
    /** Leva H (310): Preferências › Segurança (MFA policy, factor reset), JSON only. */
    security: (path: string, options: NativeRequestOptions = {}) => nativeRequest('/v1/seguranca', path, options),
    /** Leva H (330-334): tarefas, exportação, tabelas oficiais, CEP e Novas NF-es; the server rechecks every profile. */
    platform: (path: string, options: NativeRequestOptions = {}) => nativeRequest('/v1/plataforma', path, options),
    /** Leva H, lane espelho (350-352): Dados do Origin, categorias, exclusões e o complemento Transportador, JSON only. */
    originMirror: (path: string, options: NativeRequestOptions = {}) => nativeRequest('/v1/espelho-origin', path, options),
    home: (path: string, options: NativeRequestOptions = {}) => {
      let captured;
      try { captured=captureHomeRequest(path,options); } catch { return Promise.reject(new AccessError(400)); }
      return nativeRequest('/v1/inicio',captured.path,captured.options);
    },
    /** 202610220009: botão Sincronizar (mão dupla com o Origin): GET situação, POST pede uma rodada; sem corpo. */
    originSync: (path: string, options: NativeRequestOptions = {}) => {
      if(path!=='/v1/sincronizacao-origin'||(options.method!==undefined&&!['GET','POST'].includes(options.method))||options.body!==undefined)return Promise.reject(new AccessError(400));
      return nativeRequest('/v1/sincronizacao-origin',path,options);
    },
    integrationProgress: (path: string, options: NativeRequestOptions = {}) => {
      if(path!=='/v1/integracao-origin'||(options.method!==undefined&&options.method!=='GET')||options.body!==undefined)return Promise.reject(new AccessError(400));
      if(state.phase==='ready'&&state.membership?.role!=='admin')return Promise.reject(new AccessError(403));
      return nativeRequest('/v1/integracao-origin',path,options);
    },
    // 101: one fixed read-only path; the server revalidates the active administrator.
    integrationFreshness: (path: string, options: NativeRequestOptions = {}) => {
      if(path!=='/v1/integracao-origin/frescor'||(options.method!==undefined&&options.method!=='GET')||options.body!==undefined)return Promise.reject(new AccessError(400));
      if(state.phase==='ready'&&state.membership?.role!=='admin')return Promise.reject(new AccessError(403));
      return nativeRequest('/v1/integracao-origin/frescor',path,options,256*1024);
    },
    cutover: (path: string, options: NativeRequestOptions = {}) => {
      if(!/^\/v1\/preparacao-virada(?:$|\/[a-f0-9]{64}\/(?:contacts|products|receivables|payables|stock_snapshot)(?:\?|$))/.test(path)||(options.method!==undefined&&options.method!=='GET')||options.body!==undefined)return Promise.reject(new AccessError(400));
      return nativeRequest('/v1/preparacao-virada',path,options);
    },
    financialCutover: (path: string, options: NativeRequestOptions = {}) => {
      if(!/^\/v1\/conferencia-financeira-origin(?:\?[^#]*|\/(?:receivables|payables)\/[^/?#]+)?$/.test(path)||(options.method!==undefined&&options.method!=='GET')||options.body!==undefined)return Promise.reject(new AccessError(400));
      if(state.phase==='ready'&&state.membership?.role!=='admin')return Promise.reject(new AccessError(403));
      return nativeRequest('/v1/conferencia-financeira-origin',path,options);
    },
    financialImport: (path: string, options: NativeRequestOptions = {}) => {
      let captured;try{captured=captureFinancialImportRequest(path,options);}catch{return Promise.reject(new AccessError(400));}
      if(state.phase!=='ready'||state.membership?.role!=='admin')return Promise.reject(new AccessError(403));
      return nativeRequest(captured.base,captured.path,captured.options,1024*1024,12000,()=>{if(state.membership?.role!=='admin')throw new AccessError(403);});
    },
    purchaseReadiness: (path:string, options:NativeRequestOptions={}) => {
      let captured;
      try { captured=capturePurchaseReadinessRequest(path,options); } catch { return Promise.reject(new AccessError(400)); }
      const requireAdmin=()=>{if(state.phase!=='ready'||state.membership?.role!=='admin')throw new AccessError(state.phase==='ready'?403:401);};
      try { requireAdmin(); } catch(error) { return Promise.reject(error); }
      return nativeRequest(captured.base,captured.path,captured.options,PURCHASE_READINESS_RESPONSE_BYTES,15000,requireAdmin);
    },
    salesReadiness: (path:string, options:NativeRequestOptions={}) => {
      let captured;
      try { captured=captureSalesReadinessRequest(path,options); } catch { return Promise.reject(new AccessError(400)); }
      const requireAdmin=()=>{if(state.phase!=='ready'||state.membership?.role!=='admin')throw new AccessError(state.phase==='ready'?403:401);};
      try { requireAdmin(); } catch(error) { return Promise.reject(error); }
      return nativeRequest(captured.base,captured.path,captured.options,SALES_READINESS_RESPONSE_BYTES,15000,requireAdmin);
    },
    salesHistory: (path:string, options:NativeRequestOptions={}) => {
      let captured;
      try { captured=captureSalesHistoryRequest(path,options); } catch { return Promise.reject(new AccessError(400)); }
      const requireAdmin=()=>{if(state.phase!=='ready'||state.membership?.role!=='admin')throw new AccessError(state.phase==='ready'?403:401);};
      try { requireAdmin(); } catch(error) { return Promise.reject(error); }
      return nativeRequest(SALES_HISTORY_BASE,captured.path,captured.options,SALES_HISTORY_RESPONSE_BYTES,15000,requireAdmin).then(value=>{requireAdmin();return value;});
    },
    stockObservations: (path:string,options:NativeRequestOptions={}) => {
      let captured;try{captured=captureStockObservationsRequest(path,options);}catch{return Promise.reject(new AccessError(400));}
      const requireAdmin=()=>{if(state.phase!=='ready'||state.membership?.role!=='admin')throw new AccessError(state.phase==='ready'?403:401);};
      try{requireAdmin();}catch(error){return Promise.reject(error);}
      return nativeRequest(STOCK_OBSERVATIONS_BASE,captured.path,captured.options,STOCK_OBSERVATIONS_MAX_BYTES,25000,requireAdmin).then(value=>{requireAdmin();return value;});
    },
    warehouseImport: (path:string, options:NativeRequestOptions={}) => {
      let captured;try{captured=captureWarehouseRequest(path,options);}catch{return Promise.reject(new AccessError(400));}
      const requireAdmin=()=>{if(state.phase!=='ready'||state.membership?.role!=='admin')throw new AccessError(state.phase==='ready'?403:401);};
      try{requireAdmin();}catch(error){return Promise.reject(error);}
      return nativeRequest(WAREHOUSE_IMPORT_BASE,captured.path,captured.options,WAREHOUSE_IMPORT_RESPONSE_BYTES,25000,requireAdmin).then(value=>{requireAdmin();return value;});
    },
    // Opening adoption and policy changes are administrador-only; reading the policy is open to stock readers.
    stockOpening: (path:string, options:NativeRequestOptions={}) => {
      let captured;try{captured=captureStockOpeningRequest(path,options);}catch{return Promise.reject(new AccessError(400));}
      const admin=captured.admin,permitted=()=>{if(state.phase!=='ready')throw new AccessError(401);const role=state.membership?.role??'';if(admin?role!=='admin':!['admin','consulta','estoque','vendas','fiscal'].includes(role))throw new AccessError(403);};
      try{permitted();}catch(error){return Promise.reject(error);}
      return nativeRequest(captured.base,captured.path,captured.options,STOCK_OPENING_RESPONSE_BYTES,25000,permitted).then(value=>{permitted();return value;});
    },
    itauLegacyReadiness: (path:string, options:NativeRequestOptions={}) => {
      let captured;
      try { captured=captureItauLegacyRequest(path,options); } catch { return Promise.reject(new AccessError(400)); }
      const requireAdmin=()=>{if(state.phase!=='ready'||state.membership?.role!=='admin')throw new AccessError(state.phase==='ready'?403:401);};
      try { requireAdmin(); } catch(error) { return Promise.reject(error); }
      return nativeRequest(ITAU_LEGACY_BASE,captured.path,captured.options,ITAU_LEGACY_RESPONSE_BYTES,15000,requireAdmin).then(value=>{requireAdmin();return value;});
    },
    proposalImport: (path: string, options: NativeRequestOptions = {}) => {
      let captured;try{captured=captureProposalImportRequest(path,options);}catch{return Promise.reject(new AccessError(400));}
      if(state.phase!=='ready'||state.membership?.role!=='admin')return Promise.reject(new AccessError(403));
      return nativeRequest(captured.base,captured.path,captured.options,1024*1024);
    },
    financialImportOrigin: (path: string, options: NativeRequestOptions = {}) => {
      if(!/^\/v1\/importacao-financeira-origin\/titles\/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\/origin$/.test(path)||(options.method!==undefined&&options.method!=='GET')||options.body!==undefined)return Promise.reject(new AccessError(400));
      if(state.phase!=='ready'||!['admin','financeiro','consulta'].includes(state.membership?.role??''))return Promise.reject(new AccessError(403));
      return nativeRequest('/v1/importacao-financeira-origin',path,options);
    },
    company: (path: string, options: NativeRequestOptions = {}) => nativeRequest('/v1/empresa', path, options),
    preferences: (path: string, options: NativeRequestOptions = {}) => {
      let captured;try{captured=capturePreferencesRequest(path,options);}catch{return Promise.reject(new AccessError(400));}
      return nativeRequest(PREFERENCES_BASE,captured.path,captured.options,PREFERENCES_RESPONSE_BYTES,15000);
    },
    listPreferences: (path: string, options: NativeRequestOptions = {}) => {
      let captured;try{captured=captureListPreferencesRequest(path,options);}catch{return Promise.reject(new AccessError(400));}
      return nativeRequest(LIST_PREFERENCES_BASE,captured.path,captured.options,LIST_PREFERENCES_RESPONSE_BYTES,12000);
    },
    accessUsers: (path: string, options: NativeRequestOptions = {}) => {
      let captured;try{captured=captureAccessUsersRequest(path,options);}catch{return Promise.reject(new AccessError(400));}
      const requireAdmin=()=>{if(state.membership?.role!=='admin')throw new AccessError(403);};try{requireAdmin();}catch(error){return Promise.reject(error);}
      return nativeRequest(USERS_BASE,captured.path,captured.options,USERS_RESPONSE_BYTES,25000,requireAdmin);
    },
    systemLog: (path: string, options: NativeRequestOptions = {}) => {
      let captured;try{captured=captureSystemRequest(path,options);}catch{return Promise.reject(new AccessError(400));}
      const requireAdmin=()=>{if(state.membership?.role!=='admin')throw new AccessError(403);};try{requireAdmin();}catch(error){return Promise.reject(error);}
      return nativeRequest(captured.base,captured.path,captured.options,ACTIVITY_RESPONSE_BYTES,25000,requireAdmin);
    },
    // Preferências and Sistema, wave B (148-152): Meu Negócio and the Sistema frameworks; the server checks every role again.
    system: (path: string, options: NativeRequestOptions = {}) => {
      let captured;try{captured=captureSystemPortRequest(path,options);}catch{return Promise.reject(new AccessError(400));}
      return nativeRequest(captured.base,captured.path,captured.options,SYSTEM_RESPONSE_BYTES,25000);
    },
    fiscalDraftStatus: (path:string, options:NativeRequestOptions={}) => {
      let captured;
      try { captured=captureFiscalDraftStatusRequest(path,options); } catch { return Promise.reject(new AccessError(400)); }
      const requireFiscal=()=>{if(state.phase!=='ready'||!['admin','fiscal'].includes(state.membership?.role??''))throw new AccessError(state.phase==='ready'?403:401);};
      try { requireFiscal(); } catch(error) { return Promise.reject(error); }
      return nativeRequest(captured.base,captured.path,captured.options,FISCAL_DRAFT_STATUS_RESPONSE_BYTES,15000,requireFiscal).then(value=>{requireFiscal();return value;});
    },
    fiscalDraft: (path: string, options: NativeRequestOptions = {}) => nativeRequest('/v1/rascunhos-fiscais',path,options,4 * 1024 * 1024),
    // Notas fiscais no padrão Origin (202610200111-114): listas, notas próprias, naturezas, impostos e eventos de homologação.
    fiscalInvoices: (path: string, options: NativeRequestOptions = {}) => nativeRequest('/v1/notas-fiscais',path,options,4 * 1024 * 1024,15000),
    fiscalItem: (path: string, options: NativeRequestOptions = {}) => nativeRequest('/v1/preparacao-itens-fiscais',path,options,8 * 1024 * 1024),
    a1: a1Request,
    fiscalUnsigned: unsignedRequest,
    fiscalSigned: signedRequest,
    fiscalDanfe: danfeRequest,
    fiscalProcessedDocument: processedDocumentRequest,
    fiscalAuthorization: authorizationRequest,
    fiscalReviewedAuthorization: reviewedAuthorizationRequest,
    fiscalReceiptQuery: receiptQueryRequest,
    fiscalSubsetReview: subsetReviewRequest,
    fiscalReconciliation: reconciliationRequest,
    wsdl: wsdlRequest,
    fiscalTax: (path: string, options: NativeRequestOptions = {}) => nativeRequest('/v1/preparacao-tributaria',path,options,2 * 1024 * 1024),
    fiscalCompletion: (path: string, options: NativeRequestOptions = {}) => {
      const base='/v1/complemento-fiscal',method=options.method??'GET';
      const match=/^\/v1\/complemento-fiscal\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?:\/(history|preview|save))?(?:\?([^#]*))?$/.exec(path);
      if(!match)return Promise.reject(new AccessError(400));
      const operation=match[1]??'get',write=operation==='preview'||operation==='save';
      if(write?method!=='POST'||options.body===undefined||match[2]!==undefined:method!=='GET'||options.body!==undefined)return Promise.reject(new AccessError(400));
      if(!write){
        const query=new URLSearchParams(match[2]??''),allowed=operation==='history'?['limit','before']:['version'];
        for(const key of query.keys()){
          const text=query.get(key)!;
          if(!allowed.includes(key)||query.getAll(key).length!==1||!/^[1-9][0-9]{0,9}$/.test(text)||Number(text)>2147483647||key==='limit'&&Number(text)>25)return Promise.reject(new AccessError(400));
        }
      }
      if(state.phase==='ready'&&!['admin','fiscal'].includes(state.membership?.role??''))return Promise.reject(new AccessError(403));
      return nativeRequest(base,path,options,2 * 1024 * 1024);
    },
    fiscalNumbering: (path: string, options: NativeRequestOptions = {}) => {
      const base='/v1/numeracao-fiscal', method=options.method??'GET';
      const write=method==='POST'&&(path===`${base}/series`||path===`${base}/reservations`);
      const read=method==='GET'&&(new RegExp(`^${base}/series(?:\\?[^#]*)?$`).test(path)||new RegExp(`^${base}/(?:reservations|drafts|commands)/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$`).test(path));
      if(write ? options.body===undefined : !read||options.body!==undefined)return Promise.reject(new AccessError(400));
      if(read&&path.startsWith(`${base}/series?`)){
        const query=new URLSearchParams(path.slice(path.indexOf('?')+1));
        for(const key of query.keys())if(!['model','limit','after'].includes(key)||query.getAll(key).length!==1)return Promise.reject(new AccessError(400));
        const model=query.get('model'),limit=query.get('limit'),after=query.get('after');
        if(model!==null&&!['55','65'].includes(model)||limit!==null&&(!/^[1-9][0-9]?$/.test(limit)||Number(limit)>25)||after!==null&&!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(after))return Promise.reject(new AccessError(400));
      }
      return nativeRequest(base,path,options,128 * 1024);
    },
    catalogImport: (path: string, options: NativeRequestOptions = {}) => nativeRequest('/v1/importacao-cadastros', path, options, 4 * 1024 * 1024),
    documents: (path: string, options: NativeRequestOptions = {}) => nativeRequest('/v1/documentos', path, options, 8 * 1024 * 1024),
    documentCopy: (path: string, options: NativeRequestOptions = {}) => nativeRequest('/v1/duplicacao-documentos', path, options, 8 * 1024 * 1024),
    documentFinance: (path: string, options: NativeRequestOptions = {}) => {
      if (!/^\/v1\/documentos\/(sales_orders|purchase_orders|service_orders)\/[a-f0-9-]+\/financeiro(?:[/?]|$)/i.test(path)) return Promise.reject(new AccessError(400));
      return nativeRequest('/v1/documentos',path,options);
    },
    serviceJournal: (path: string, options: NativeRequestOptions = {}) => nativeRequest('/v1/ordens-servico',path,options),
    serviceEvents: (path: string, options: NativeRequestOptions = {}) => {
      const base='/v1/ordens-servico',uuid='[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',method=options.method??'GET';
      const match=new RegExp(`^${base}/${uuid}/eventos(?:/(${uuid}))?(?:\\?([^#]*))?$`).exec(path);
      if(!match||path.includes('#')||!['GET','POST'].includes(method)||method==='POST'&&(match[1]!==undefined||match[2]!==undefined||options.body===undefined)||method==='GET'&&options.body!==undefined||match[1]!==undefined&&match[2]!==undefined)return Promise.reject(new AccessError(400));
      if(match[2]!==undefined){
        const query=new URLSearchParams(match[2]);
        for(const key of query.keys())if(!['limit','before'].includes(key)||query.getAll(key).length!==1)return Promise.reject(new AccessError(400));
        const limit=query.get('limit'),before=query.get('before');
        if(limit!==null&&(!/^[1-9][0-9]?$/.test(limit)||Number(limit)>25)||before!==null&&!/^[1-9][0-9]{0,9}$/.test(before))return Promise.reject(new AccessError(400));
      }
      if(method==='POST'){try{if(new TextEncoder().encode(JSON.stringify(options.body)).byteLength>64 * 1024)return Promise.reject(new AccessError(413));}catch{return Promise.reject(new AccessError(400));}}
      if(state.phase==='ready'&&!(method==='POST'?['admin','vendas']:['admin','vendas','financeiro','consulta']).includes(state.membership?.role??''))return Promise.reject(new AccessError(403));
      return nativeRequest(base,path,options,1024 * 1024);
    },
    documentStock: (path: string, options: NativeRequestOptions = {}) => nativeRequest('/v1/documentos-estoque',path,options),
    purchaseReceipts: (path:string, options:PurchaseReceiptsRequestOptions={}) => {
      let captured;try{captured=capturePurchaseReceiptsRequest(path,options);}catch{return Promise.reject(new AccessError(400));}
      const actor=state.membership?.user_id,epoch=generation;
      const check=()=>{if(state.phase!=='ready'||!actor||state.membership?.user_id!==actor||epoch!==generation)throw new AccessError(401);if(!['admin','estoque'].includes(state.membership.role))throw new AccessError(403);};
      try{check();}catch(error){return Promise.reject(error);}
      return nativeRequest(captured.base,captured.path,captured.options,1024*1024,20000,check).then(async value=>{
        check();const authorized=authorizedBearer(captured.options.signal);if(typeof authorized!=='string')await authorized;
        check();if(verifiedCredentialEpoch!==credentialEpoch)throw new AccessError(503);return value;
      });
    },
    stockReservations: (path:string, options:NativeRequestOptions={}) => {
      let captured;try{captured=captureStockReservationsRequest(path,options);}catch{return Promise.reject(new AccessError(400));}
      const check=()=>{if(!state.membership||!(captured.write?['admin','estoque']:['admin','estoque','vendas','fiscal','consulta']).includes(state.membership.role))throw new AccessError(403);};
      try{check();}catch(error){return Promise.reject(error);}
      return nativeRequest(captured.base,captured.path,captured.options,1024*1024,12000,check);
    },
    stockPositions: (path: string, options: NativeRequestOptions = {}) => {
      if((options.method!==undefined&&options.method!=='GET')||options.body!==undefined)return Promise.reject(new AccessError(400));
      return nativeRequest('/v1/posicoes-estoque',path,options);
    },
    dueReport: (path: string, options: NativeRequestOptions = {}) => {
      if((options.method!==undefined&&options.method!=='GET')||options.body!==undefined)return Promise.reject(new AccessError(400));
      return nativeRequest('/v1/relatorios/vencimentos',path,options);
    },
    syncedXml: (path: string, options: NativeRequestOptions = {}) => {
      if((options.method!==undefined&&options.method!=='GET')||options.body!==undefined)return Promise.reject(new AccessError(400));
      return nativeRequest('/v1/xmls-sincronizados',path,options);
    },
    dfeDistribution: (path: string, options: NativeRequestOptions = {}) => {
      // Leva H (NFE-212): POST documents/{id}/summary reads one kept document from its checked bytes (body {}).
      const write=(path==='/v1/notas-recebidas/settings'||/^\/v1\/notas-recebidas\/documents\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/summary$/.test(path))&&options.method==='POST';
      const read=/^\/v1\/notas-recebidas\/(?:settings\?[^#]*|documents\?[^#]*|summaries\?[^#]*|commands\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.test(path);
      if(write ? options.body===undefined : !read || (options.method!==undefined&&options.method!=='GET') || options.body!==undefined)return Promise.reject(new AccessError(400));
      return nativeRequest('/v1/notas-recebidas',path,options);
    },
    dfeDistributionDownload: (path: string, signal?: AbortSignal) => historyRequest(path,signal,true,'received-dfe') as Promise<Blob>,
    syncedXmlDownload: (path: string, signal?: AbortSignal) => historyRequest(path,signal,true,'synced-xml') as Promise<Blob>,
    cnabReview: (path: string, options: NativeRequestOptions = {}) => nativeRequest('/v1/conferencia-retornos',path,options,1024*1024,60000),
    stock: (path: string, options: NativeRequestOptions = {}) => nativeRequest('/v1/estoque', path, options),
    financeTransfers: (path: string, options: NativeRequestOptions = {}) => {
      const base='/v1/transferencias-internas',method=options.method??'GET';
      const readable=/^\/v1\/transferencias-internas(?:\?[^#]*|\/(?:commands\/)?[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})?$/.test(path);
      if(method==='POST'?path!==base:method!=='GET'||!readable||options.body!==undefined)return Promise.reject(new AccessError(400));
      if(state.phase!=='ready'||!(method==='POST'?['admin','financeiro']:['admin','financeiro','consulta']).includes(state.membership?.role??''))return Promise.reject(new AccessError(403));
      return nativeRequest(base,path,options,256*1024);
    },
    finance: (path: string, options: NativeRequestOptions = {}) => nativeRequest('/v1/financeiro', path, options),
    // Frente de caixa (202610200204-206): admin and vendas operate; consulta and financeiro read. The server and the database decide again.
    pos: (path: string, options: NativeRequestOptions = {}) => {
      const method=options.method??'GET',action=/^\/v1\/frente-caixa\/actions\/[a-z_]{1,40}$/.test(path);
      if(method==='POST'?!action||options.body===undefined:method!=='GET'||action||options.body!==undefined)return Promise.reject(new AccessError(400));
      if(state.phase!=='ready'||!(method==='POST'?['admin','vendas']:['admin','vendas','consulta','financeiro']).includes(state.membership?.role??''))return Promise.reject(new AccessError(403));
      return nativeRequest('/v1/frente-caixa',path,options,1024*1024,20000);
    },
    boletoPreview: async (path:string,options:NativeRequestOptions={}) => {
      let captured;try{captured=captureBoletoRead(path,options);}catch{throw new AccessError(400);}
      if(state.phase!=='ready'||!state.membership)throw new AccessError(401);
      if(!['admin','financeiro','consulta'].includes(state.membership.role))throw new AccessError(403);
      const actor=state.membership.user_id;
      const result=await nativeRequest('/v1/boletos-itau',path,captured,BOLETO_RESPONSE_BYTES,25000);
      if(state.phase!=='ready'||state.membership?.user_id!==actor||!['admin','financeiro','consulta'].includes(state.membership.role))throw new DOMException('Request cancelled','AbortError');
      return result;
    },
    cnab: (path: string, options: NativeRequestOptions = {}) => nativeRequest('/v1/cnab', path, options, 1024 * 1024, 60000),
    cnabDownload: (path: string, signal?: AbortSignal) => historyRequest(path, signal, true, true) as Promise<Blob>,
    cnabReturns: (path: string, options: NativeRequestOptions = {}) => nativeRequest('/v1/retornos-operacionais', path, options, 1024 * 1024, 60000),
    itauNetCredit: (path:string,options:NativeRequestOptions={}) => {
      let captured:ReturnType<typeof captureNetCreditRequest>;
      try{captured=captureNetCreditRequest(path,options);}catch{return Promise.reject(new AccessError(400));}
      const roles=captured.options.method==='POST'?['admin','financeiro']:['admin','financeiro','consulta'];
      if(state.phase!=='ready'||!roles.includes(state.membership?.role??''))return Promise.reject(new AccessError(403));
      return nativeRequest('/v1/retornos-itau109',captured.path,captured.options,NET_CREDIT_RESPONSE_BYTES,60000);
    },
    cnabReturnsDownload: (path: string, signal?: AbortSignal) => historyRequest(path, signal, true, 'operational-return') as Promise<Blob>,
    cnabOperational: (path: string, options: NativeRequestOptions = {}) => nativeRequest('/v1/cobranca-operacional', path, options, 1024 * 1024, 60000),
    cnabOperationalDownload: (path: string, signal?: AbortSignal) => historyRequest(path, signal, true, 'operational-cnab') as Promise<Blob>,
    cnabOperationalV2: async (path:string,options:NativeRequestOptions={}) => {
      let captured;try{captured=captureCnabV2Request(path,options);}catch{throw new AccessError(400);}
      if(state.phase!=='ready'||!state.membership)throw new AccessError(401);
      const roles=captured.approval?['admin']:captured.options.method==='POST'?['admin','financeiro']:['admin','financeiro','consulta'];
      if(!roles.includes(state.membership.role))throw new AccessError(403);
      const actor=state.membership.user_id;
      const result=await nativeRequest('/v1/cobranca-operacional-v2',captured.path,captured.options,CNAB_V2_RESPONSE_BYTES,65000);
      if(state.phase!=='ready'||state.membership?.user_id!==actor||!['admin','financeiro','consulta'].includes(state.membership.role))throw new DOMException('Request cancelled','AbortError');
      return result;
    },
    cnabOperationalV2Download: async (path:string,signal?:AbortSignal) => {
      let captured;try{captured=captureCnabV2Request(path,{signal},true);}catch{throw new AccessError(400);}
      if(state.phase!=='ready'||!state.membership)throw new AccessError(401);
      if(!['admin','financeiro','consulta'].includes(state.membership.role))throw new AccessError(403);
      const actor=state.membership.user_id,result=await historyRequest(captured.path,captured.options.signal,true,'operational-cnab-v2') as Blob;
      if(state.phase!=='ready'||state.membership?.user_id!==actor||!['admin','financeiro','consulta'].includes(state.membership.role))throw new DOMException('Request cancelled','AbortError');
      return result;
    },
    attachments: attachmentRequest,
    history: (path: string, signal?: AbortSignal) => historyRequest(path, signal),
    historyDownload: (path: string, signal?: AbortSignal) => historyRequest(path, signal, true) as Promise<Blob>,
    clearRecords() { listGeneration++; listRequest?.abort(); listRequest = null; update({ records: null, listPending: false }); },
    async loadRecords(query: ListQuery) {
      if (!token || !state.membership?.resources.includes(query.entity) || stopped) return;
      listRequest?.abort(); const current = generation; const currentList = ++listGeneration;
      const controller = new AbortController(); listRequest = controller;
      update({ records: null, listPending: true, message: null });
      const params = new URLSearchParams({ limit: String(query.limit), offset: String(query.offset) });
      for (const key of ['q', 'status', 'from', 'to'] as const) if (query[key]) params.set(key, query[key]);
      let bearer=token,credential=credentialEpoch;
      try {
        const authorized=authorizedBearer(controller.signal);bearer=typeof authorized==='string'?authorized:await authorized;assertDispatch(current,controller,bearer);credential=credentialEpoch;
        const page = recordPage(await request(`/v1/records/${query.entity}?${params}`, bearer, controller), query);
        if (stopped || current !== generation || currentList !== listGeneration) return;
        update({ records: page, listPending: false });
      } catch (error) {
        if (stopped || current !== generation || currentList !== listGeneration) return;
        const status = error instanceof AccessError ? error.status : 503;
        if (status === 401 || status === 403) {
          update({records:null,listPending:false});handleAccessFailure(error,bearer,credential);
        } else update({ listPending: false, message: status === 400 ? 'Confira os filtros informados.' : 'Não foi possível carregar os registros. Tente novamente.' });
      }
    },
  };
}
export type AccessController = ReturnType<typeof createAccessController>;

/** Decimal display without Number conversion or loss of large monetary values. */
export function decimalMoney(value: string | null) {
  if (value === null || !/^-?\d+(?:\.\d+)?$/.test(value)) return '—';
  const [integer, fraction = ''] = value.split('.');
  return `R$ ${integer.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${fraction.padEnd(2, '0')}`;
}
