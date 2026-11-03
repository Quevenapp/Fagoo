/** Isolated GET-only adapter. No reservation, counter, command or Storage write port. */
import { generateRemittance, generateOperationalRemittance, generateOperationalRemittanceV2, CnabError } from '../../../packages/cnab-core/src/index.mjs';
import { createItau109PrintPreview, createItau109OperationalPrintPreviewV2, BoletoPreviewError } from '../../../packages/boleto-preview/src/index.mjs';

const PREFIX = '/v1/boletos-itau', RPC = 'erp_cnab_itau_boleto_context';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/, HASH = /^[a-f0-9]{64}$/;
const MAX_CONTEXT = 262144, MAX_FILE = 4020000;
export const BOLETO_PREVIEW_RESPONSE_BYTES = 196608;
const routes = new WeakSet();
export class BoletoPreviewRouteError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const fail = (status, code) => { throw new BoletoPreviewRouteError(status, code); };
const invalid = () => fail(400, 'ERP_BOLETO_PREVIEW_INVALID_INPUT');
const upstream = () => fail(502, 'ERP_BOLETO_PREVIEW_INVALID_RESPONSE');
const uuid = value => typeof value === 'string' && UUID.test(value);
const hash = value => typeof value === 'string' && HASH.test(value);
const version = value => Number.isInteger(value) && value > 0 && value <= 2147483647;
const exact = (value, fields) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length || fields.some(k => !Object.hasOwn(value, k))) upstream();
};
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
    : '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
const same = (a, b) => canonical(a) === canonical(b);
const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');

// Ports return decoded JSON, but never retain port-owned objects across awaits.
function capture(value) {
  let nodes = 0, chars = 0;
  function copy(v, depth) {
    if (++nodes > 10000 || depth > 12) upstream();
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'number') { if (!Number.isSafeInteger(v)) upstream(); return v; }
    if (typeof v === 'string') { chars += v.length; if (chars > MAX_CONTEXT) upstream(); return v; }
    if (!v || typeof v !== 'object' || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(v))) upstream();
    const ds = Object.getOwnPropertyDescriptors(v), keys = Reflect.ownKeys(ds);
    if (Array.isArray(v)) {
      if (v.length > 100 || keys.length !== v.length + 1 || !keys.includes('length')) upstream();
      return Array.from({ length: v.length }, (_, i) => { const d = ds[String(i)]; if (!d || !('value' in d) || !d.enumerable) upstream(); return copy(d.value, depth + 1); });
    }
    const out = {};
    for (const key of keys) {
      const d = ds[key];
      if (typeof key !== 'string' || key.length > 100 || key === '__proto__' || !('value' in d) || !d.enumerable) upstream();
      out[key] = copy(d.value, depth + 1);
    }
    return out;
  }
  try { const result = copy(value, 0); if (new TextEncoder().encode(JSON.stringify(result)).length > MAX_CONTEXT) upstream(); return result; }
  catch (error) { if (error instanceof BoletoPreviewRouteError) throw error; upstream(); }
}

export function boletoPreviewMethods() { return ['GET']; }
export function parseBoletoPreviewRoute(request) {
  const url = new URL(request.url);
  if (url.pathname !== PREFIX && !url.pathname.startsWith(PREFIX + '/')) return null;
  if (request.method !== 'GET') fail(405, 'ERP_METHOD_NOT_ALLOWED');
  const list = /^\/v1\/boletos-itau\/remittances\/([a-f0-9-]+)\/items$/i.exec(url.pathname);
  const match = list || /^\/v1\/boletos-itau\/([a-f0-9-]+)\/preview$/i.exec(url.pathname);
  if (!match || !uuid(match[1].toLowerCase()) || url.search || url.hash || request.body !== null
    || ![null, '0'].includes(request.headers.get('content-length')) || ![null, 'identity'].includes(request.headers.get('content-encoding'))) invalid();
  const route = Object.freeze({ kind: list ? 'items' : 'preview', id: match[1].toLowerCase() }); routes.add(route); return route;
}

function checkedItems(raw, id) {
  const x = capture(raw);
  exact(x, ['data_mode','read_only','can_pay','remittance_id','profile_id','source_purpose','state','remittance_hash','items']);
  if (x.data_mode !== 'itau_boleto_items_readonly' || x.read_only !== true || x.can_pay !== false || x.remittance_id !== id
    || !uuid(x.profile_id) || !['homologation','operational'].includes(x.source_purpose) || x.state !== 'ready'
    || !hash(x.remittance_hash) || !Array.isArray(x.items) || x.items.length < 1 || x.items.length > 30) upstream();
  let prior = ''; const titles = new Set();
  for (const row of x.items) {
    exact(row, ['billing_title_id','finance_title_id','document_number','amount_cents','due_on']);
    if (!uuid(row.billing_title_id) || row.billing_title_id <= prior || !uuid(row.finance_title_id) || titles.has(row.finance_title_id)
      || typeof row.document_number !== 'string' || !/^[A-Z0-9 .&/-]{1,10}$/.test(row.document_number)
      || typeof row.amount_cents !== 'string' || !/^[1-9][0-9]{0,12}$/.test(row.amount_cents)
      || typeof row.due_on !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(row.due_on) || !Number.isFinite(Date.parse(row.due_on + 'T00:00:00Z'))
      || new Date(row.due_on + 'T00:00:00Z').toISOString().slice(0,10) !== row.due_on) upstream();
    prior = row.billing_title_id; titles.add(row.finance_title_id);
  }
  return x;
}

const PROFILE = ['bank', 'wallet', 'layout', 'accountId', 'agency', 'account', 'accountDigit', 'cnpj', 'companyName', 'contractVerified', 'agreementReference', 'simpleCollectionPolicyVerified'];
function checkedContext(raw, id) {
  const x = capture(raw);
  exact(x, ['profile', 'private_context', 'billing_title_id', 'remittance_id', 'profile_id', 'finance_title_id', 'source_purpose', 'state',
    'snapshot', 'billing_snapshot', 'manifest', 'our_number', 'snapshot_hash', 'file', 'beneficiary', 'current',
    'read_only', 'can_pay', 'can_issue', 'can_transmit', 'financial_mutation_performed', 'context_hash']);
  const v2 = x.profile === 'itau109-persisted-print-preview-v2';
  if ((!v2 && x.profile !== 'itau109-persisted-print-preview-v1') || (v2 && x.source_purpose !== 'operational') || x.private_context !== true || x.billing_title_id !== id
    || !uuid(x.remittance_id) || !uuid(x.profile_id) || !uuid(x.finance_title_id) || !['homologation', 'operational'].includes(x.source_purpose)
    || x.state !== 'ready' || !hash(x.snapshot_hash) || !hash(x.context_hash) || typeof x.our_number !== 'string' || !/^[0-9]{9}$/.test(x.our_number)
    || x.read_only !== true || [x.can_pay, x.can_issue, x.can_transmit, x.financial_mutation_performed].some(v => v !== false)) upstream();
  exact(x.file, ['bucket', 'path', 'hash', 'size']);
  if (x.file.bucket !== 'brufap-cnab' || !hash(x.file.hash) || x.file.path !== `profiles/${x.profile_id}/remittances/${x.file.hash}.rem`
    || !Number.isInteger(x.file.size) || x.file.size < 1 || x.file.size > MAX_FILE) upstream();
  exact(x.current, ['title_version', 'contact_version', 'profile_version', 'approval_version', 'company_identity_version', 'title_status', 'title_cancelled', 'settled_cents']);
  if (!['title_version', 'contact_version', 'profile_version', 'company_identity_version'].every(k => version(x.current[k]))
    || (x.source_purpose === 'operational' ? !version(x.current.approval_version) : x.current.approval_version !== null)
    || x.current.title_status !== 'open' || x.current.title_cancelled !== false || x.current.settled_cents !== '0') upstream();
  exact(x.beneficiary, ['identity_version', 'cnpj', 'address_source', 'address']);
  exact(x.beneficiary.address, ['address', 'neighborhood', 'city', 'state', 'postalCode']);
  if (x.beneficiary.identity_version !== x.current.company_identity_version || x.beneficiary.address_source !== 'company_identity_current') upstream();
  const s = x.snapshot;
  exact(s, ['profile', 'titles', 'generatedOn', 'remittanceSequence', 'purpose', ...(x.source_purpose === 'operational' ? ['operational_authorization', 'preview_hash'] : []), ...(v2 ? ['encoding_profile','encoding_authorization'] : [])]);
  exact(s.profile, [...PROFILE, 'ourNumberStart', 'remittanceSequenceStart']);
  if (s.purpose !== x.source_purpose || s.profile.bank !== '341' || s.profile.wallet !== '109' || s.profile.layout !== 'itau-cnab400-2017-01'
    || !uuid(s.profile.accountId) || x.beneficiary.cnpj !== s.profile.cnpj
    || typeof s.remittanceSequence !== 'string' || !/^[1-9][0-9]{0,6}$/.test(s.remittanceSequence)
    || !Array.isArray(s.titles) || s.titles.length < 1 || s.titles.length > 30) upstream();
  if (x.source_purpose === 'operational') {
    exact(s.operational_authorization, ['approval_version', 'profile_config_hash', 'identity_version']);
    if (!version(s.operational_authorization.approval_version) || s.operational_authorization.approval_version > x.current.approval_version
      || !hash(s.operational_authorization.profile_config_hash) || s.operational_authorization.identity_version !== x.current.company_identity_version || !hash(s.preview_hash)) upstream();
  }
  if (v2) {
    if (!['itau109-no-charges-v1','itau109-origin-observed-v1'].includes(s.encoding_profile)) upstream();
    exact(s.encoding_authorization,['approval_version','policy_hash','reference','confirmed_on','compatibility_confirmed','permanent_instructions_acknowledged']);
    if (s.encoding_authorization.approval_version !== s.operational_authorization.approval_version || !hash(s.encoding_authorization.policy_hash)) upstream();
  }
  const hasTerms = v2 && s.encoding_profile === 'itau109-origin-observed-v1';
  for (const t of s.titles) { exact(t, ['id', 'control', 'documentNumber', 'amountCents', 'issuedOn', 'dueOn', 'payer', 'ourNumber', ...(hasTerms ? ['encodingTerms'] : [])]); exact(t.payer, ['type', 'document', 'name', 'address', 'neighborhood', 'city', 'state', 'postalCode']); }
  if (new Set(s.titles.map(t => t.id)).size !== s.titles.length || s.titles.some(t => !uuid(t.id))) upstream();
  const title = s.titles.find(t => t.id === id);
  exact(x.billing_snapshot, ['title', 'finance_title_version', 'contact_version', 'finance_title_id']);
  if (!title || !same(x.billing_snapshot.title, title) || x.billing_snapshot.finance_title_id !== x.finance_title_id
    || x.billing_snapshot.finance_title_version !== x.current.title_version || x.billing_snapshot.contact_version !== x.current.contact_version
    || x.our_number.slice(0, 8) !== title.ourNumber || typeof title.amountCents !== 'string' || !/^[1-9][0-9]{0,9}$/.test(title.amountCents)) upstream();
  if (!Array.isArray(x.manifest) || x.manifest.length !== s.titles.length) upstream();
  for (const row of x.manifest) exact(row, ['titleId', 'control', 'documentNumber', 'amountCents', 'dueDate', 'ourNumber', ...(hasTerms ? ['encodingTerms'] : [])]);
  const manifest = x.manifest.find(m => m.titleId === id);
  if (!manifest || manifest.ourNumber !== x.our_number) upstream();
  return { context: x, title };
}

function scope(signal, deadline) {
  if (deadline !== undefined && (typeof deadline !== 'number' || !Number.isSafeInteger(deadline))) invalid();
  const controller = new AbortController(), end = Math.min(Date.now() + 20000, deadline ?? Infinity);
  if ((signal !== undefined && !(signal instanceof AbortSignal)) || !Number.isFinite(end) || end <= Date.now()) invalid();
  const aborted = () => controller.abort(); signal?.addEventListener('abort', aborted, { once: true });
  if (signal?.aborted) aborted();
  const timer = setTimeout(() => controller.abort(), Math.max(1, end - Date.now()));
  const check = () => { if (controller.signal.aborted || Date.now() >= end) fail(504, 'ERP_BOLETO_PREVIEW_INTERRUPTED'); };
  const bounded = async action => {
    check(); let onAbort;
    const wait = new Promise((_, reject) => { onAbort = () => reject(new BoletoPreviewRouteError(504, 'ERP_BOLETO_PREVIEW_INTERRUPTED')); controller.signal.addEventListener('abort', onAbort, { once: true }); });
    try { const result = await Promise.race([Promise.resolve().then(() => { check(); return action(); }), wait]); check(); return result; }
    finally { controller.signal.removeEventListener('abort', onAbort); }
  };
  return { signal: controller.signal, deadline: end, check, bounded, close() { clearTimeout(timer); signal?.removeEventListener('abort', aborted); controller.abort(); } };
}
async function fileBytes(value, expected, s) {
  if (value instanceof Uint8Array) {
    if (!(value.buffer instanceof ArrayBuffer) || value.byteLength !== expected.size) upstream();
    return new Uint8Array(value);
  }
  if (!(value instanceof Response)) upstream();
  if (value.status !== 200 || value.redirected || !value.body
    || ![null, 'identity'].includes(value.headers.get('content-encoding')) || value.headers.get('content-type')?.split(';')[0].trim() !== 'application/octet-stream') {
    void value.body?.cancel().catch(() => {}); upstream();
  }
  const size = value.headers.get('content-length');
  if (size !== null && (!/^(?:0|[1-9][0-9]*)$/.test(size) || Number(size) !== expected.size)) { void value.body.cancel().catch(() => {}); upstream(); }
  const reader = value.body.getReader(), chunks = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await s.bounded(() => reader.read()); if (done) break;
      if (!(value instanceof Uint8Array) || !(value.buffer instanceof ArrayBuffer) || value.byteLength === 0) upstream();
      total += value.byteLength; if (total > expected.size || total > MAX_FILE) upstream(); chunks.push(new Uint8Array(value));
    }
    if (total !== expected.size) upstream();
    const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; } return bytes;
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); for (const chunk of chunks) chunk.fill(0); }
}

export async function executeBoletoPreviewRoute(route, { userId, rpc, getFile, signal, deadline } = {}) {
  if (!routes.has(route) || typeof rpc !== 'function' || typeof getFile !== 'function') invalid();
  if (typeof userId !== 'string' || !uuid(userId.toLowerCase())) fail(401, 'ERP_UNAUTHENTICATED');
  const actor = userId.toLowerCase(), id = route.id, s = scope(signal, deadline);
  const call = () => s.bounded(() => rpc(RPC, { p_user_id: actor, p_billing_title_id: id }, { signal: s.signal, deadline: s.deadline }));
  let bytes;
  try {
    if (route.kind === 'items') return { type: 'json', body: checkedItems(await s.bounded(() => rpc('erp_cnab_itau_boleto_items',
      { p_user_id: actor, p_remittance_id: id }, { signal: s.signal, deadline: s.deadline })), id) };
    const { context: context, title } = checkedContext(await call(), id);
    const v2 = context.profile === 'itau109-persisted-print-preview-v2';
    const generated = await s.bounded(() => (v2 ? generateOperationalRemittanceV2 : context.source_purpose === 'operational' ? generateOperationalRemittance : generateRemittance)(context.snapshot));
    if (generated.fileHash !== context.file.hash || generated.bytes.byteLength !== context.file.size || !same(generated.manifest, context.manifest)) fail(409, 'ERP_BOLETO_PREVIEW_SOURCE_MISMATCH');
    bytes = await fileBytes(await s.bounded(() => getFile({ bucket: context.file.bucket, path: context.file.path, signal: s.signal }, { signal: s.signal, deadline: s.deadline })), context.file, s);
    if (await s.bounded(() => digest(bytes)) !== context.file.hash) fail(409, 'ERP_BOLETO_PREVIEW_SOURCE_MISMATCH');
    const preview = await s.bounded(() => v2
      ? createItau109OperationalPrintPreviewV2({snapshot:context.snapshot,billingTitleId:id,beneficiaryAddress:context.beneficiary.address})
      : createItau109PrintPreview({ purpose: 'offline-print-preview',
      boleto: { purpose: 'offline-validation', profile: Object.fromEntries(PROFILE.map(k => [k, context.snapshot.profile[k]])),
        title: { amountCents: title.amountCents, dueOn: title.dueOn, referenceOn: context.snapshot.generatedOn },
        allocation: { ourNumber: title.ourNumber, confirmed: true, reference: 'PERSISTED CNAB RESERVATION ' + id } },
      document: { number: title.documentNumber, issuedOn: title.issuedOn, processedOn: context.snapshot.generatedOn },
      beneficiaryAddress: context.beneficiary.address, payer: title.payer }));
    if (preview.binding.ourNumberWithDigit !== context.our_number) fail(409, 'ERP_BOLETO_PREVIEW_SOURCE_MISMATCH');
    const current = checkedContext(await call(), id).context;
    if (!same(context, current)) fail(409, 'ERP_BOLETO_PREVIEW_CONTEXT_CHANGED');
    s.check();
    const body = { ...preview, data_mode: 'itau_boleto_preview_readonly', source_purpose: context.source_purpose,
      persisted: false, counters_changed: false, persisted_number_binding_checked: true,
      pending: preview.pending.filter(code => code !== 'PERSISTED_NUMBER_ALLOCATION_NOT_CHECKED'),
      beneficiary_address_source: 'company_identity_current',
      source: { billing_title_id: id, remittance_id: context.remittance_id, profile_id: context.profile_id,
        finance_title_id: context.finance_title_id, remittance_hash: context.file.hash, snapshot_hash: context.snapshot_hash,
        context_hash: context.context_hash, company_identity_version: context.beneficiary.identity_version },
      current: { ...context.current } };
    if (new TextEncoder().encode(JSON.stringify(body)).length > BOLETO_PREVIEW_RESPONSE_BYTES) upstream();
    return { type: 'json', body };
  } catch (error) {
    if (error instanceof BoletoPreviewRouteError) throw error;
    if (error instanceof CnabError || error instanceof BoletoPreviewError) fail(422, 'ERP_BOLETO_PREVIEW_PRINT_PROFILE_UNSUPPORTED');
    const status = { '42501': 403, 'P0002': 404, '22023': 422, '0A000': 422, '40001': 409 }[error?.code];
    fail(status ?? 502, { 403: 'ERP_FORBIDDEN', 404: 'ERP_NOT_FOUND', 422: 'ERP_BOLETO_PREVIEW_UNAVAILABLE', 409: 'ERP_BOLETO_PREVIEW_CONTEXT_CHANGED' }[status] ?? 'ERP_BOLETO_PREVIEW_UPSTREAM_UNAVAILABLE');
  } finally { bytes?.fill(0); s.close(); }
}
