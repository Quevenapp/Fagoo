import { configuredEndpoint, requireOriginEnabled } from './endpoints.mjs';
import { Repository } from './repository.mjs';
import { randomToken, sha256 } from './crypto.mjs';
import { authorizationUrl, exchangeCode } from './oauth.mjs';
import { saveTokens } from './tokens.mjs';
import { runSync, safeError } from './sync.mjs';

const headers = {
  'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
};
const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), {
  status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', ...extra },
});
const cookie = value => `__Host-brufap_oauth=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${value ? 600 : 0}`;

function callbackUrl(env) {
  const url = new URL(env.PUBLIC_BASE_URL);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('PUBLIC_URL_NOT_CONFIGURED');
  }
  return `${url.origin}/oauth/callback`;
}

async function authorized(request, env) {
  if (!env.INTEGRATION_ADMIN_TOKEN || env.INTEGRATION_ADMIN_TOKEN.length < 32) return false;
  const value = request.headers.get('Authorization') || '';
  // Compare fixed-size digests without a secret-dependent early return.
  const actual = await sha256(value);
  const expected = await sha256(`Bearer ${env.INTEGRATION_ADMIN_TOKEN}`);
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return difference === 0;
}

function setupPage() {
  const nonce = randomToken();
  return new Response(`<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FAGOO · Integração Origin</title>
<style nonce="${nonce}">*{box-sizing:border-box}body{font:16px/1.6 system-ui;margin:0;background:#f5f7fa;color:#17324d}main{max-width:780px;margin:7vh auto;padding:32px;background:white;border:1px solid #dce4ed;border-radius:18px}h1{line-height:1.2}label{display:block;margin:24px 0 6px}input,button{font:inherit;padding:12px;border-radius:7px;border:1px solid #b8c8d8}input{width:100%}button{cursor:pointer;background:#1255a0;color:white;margin:16px 8px 0 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f6fa;padding:16px}small{color:#53677c}</style>
<main><small>FAGOO · CONEXÃO DE DADOS</small><h1>Acompanhar os dados do Origin</h1><p>Enquanto a empresa opera no Origin, esta integração coleta os dados para a migração. Ela não emite notas nem cria cobranças.</p><label for="key">Chave de administração da integração</label><input id="key" type="password" autocomplete="off" spellcheck="false"><small>A chave não é salva neste navegador.</small><div><button id="status">Consultar situação</button><button id="connect">Autorizar acesso ao Origin</button></div><pre id="result" role="status">Consulte a situação para verificar a conexão e a última coleta.</pre><p><small>A coleta automática só opera quando a conexão e a sincronização estão habilitadas. Os registros ficam em uma área de preparação; sua coleta não significa migração concluída para os módulos do ERP.</small></p></main>
<script nonce="${nonce}">const output=document.getElementById('result');async function call(path){const response=await fetch(path,{method:'POST',redirect:'manual',headers:{Authorization:'Bearer '+document.getElementById('key').value}});if(response.redirected||response.type==='opaqueredirect'||(response.status>=300&&response.status<400))throw new Error('Redirecionamento inesperado na integração');const data=await response.json();if(!response.ok)throw new Error(data.error||'Falha na consulta');return data}document.getElementById('status').onclick=async()=>{try{output.textContent=JSON.stringify(await call('/admin/status'),null,2)}catch(error){output.textContent=error.message}};document.getElementById('connect').onclick=async()=>{try{const data=await call('/admin/oauth/start');document.getElementById('key').value='';location.assign(data.url)}catch(error){output.textContent=error.message}};</script></html>`, {
    headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` },
  });
}

export async function handleRequest(request, env, { repoFactory = value => new Repository(value), exchange = exchangeCode } = {}) {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/health') {
    return json({ service: 'fagoo-origin-sync', synchronization: env.ORIGIN_ENABLED === 'true' && env.SYNC_ENABLED === 'true' ? 'enabled' : 'disabled' });
  }
  if (request.method === 'GET' && url.pathname === '/') return setupPage();
  try {
    if (url.pathname.startsWith('/admin/')) {
      if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
      if (!await authorized(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
      const repo = repoFactory(env);
      if (url.pathname === '/admin/status') {
        const xml=env.XML_SYNC_ENABLED==='true'?{enabled:true,...(await repo.rpc('origin_sync_xml_status'))}:{enabled:false};
        const finance_refresh = env.FINANCE_REFRESH_ENABLED === 'true'
          ? { enabled: true, ...(await repo.rpc('origin_sync_finance_refresh_status', { p_stale_seconds: Number(env.FINANCE_REFRESH_STALE_SECONDS || 3600) })) }
          : { enabled: false };
        const reference_fetch = env.REFERENCE_FETCH_ENABLED === 'true'
          ? { enabled: true, ...(await repo.rpc('origin_sync_reference_status')) }
          : { enabled: false };
        const price_refresh = env.PRICE_REFRESH_ENABLED === 'true' && env.PRICE_CAPTURE_ENABLED === 'true'
          ? { enabled: true, ...(await repo.rpc('origin_sync_price_status')) }
          : { enabled: false };
        return json({ ...(await repo.rpc('origin_sync_status')), synchronization_enabled: env.ORIGIN_ENABLED === 'true' && env.SYNC_ENABLED === 'true',xml,finance_refresh,reference_fetch,price_refresh,
          extra_resources: { enabled: env.EXTRA_RESOURCES_ENABLED === 'true', coverage_complete: false } });
      }
      if (url.pathname === '/admin/oauth/start') {
        requireOriginEnabled(env);
        configuredEndpoint(env.ORIGIN_TOKEN_ENDPOINT);
        const redirectUri = callbackUrl(env);
        const state = randomToken();
        const browser = randomToken();
        // Validate app settings before creating state or sending the operator away.
        if (!env.ORIGIN_CLIENT_SECRET || !env.TOKEN_ENCRYPTION_KEY) throw new Error('ORIGIN_APP_NOT_CONFIGURED');
        const target = authorizationUrl({ clientId: env.ORIGIN_CLIENT_ID, redirectUri, state, authorizationEndpoint: env.ORIGIN_AUTHORIZATION_ENDPOINT });
        await repo.rpc('origin_sync_create_oauth_state', {
          p_state_hash: await sha256(state), p_browser_hash: await sha256(browser),
          p_expires_at: new Date(Date.now() + 600000).toISOString(),
        });
        return json({ url: target }, 200, { 'Set-Cookie': cookie(browser) });
      }
      return json({ error: 'NOT_FOUND' }, 404);
    }
    if (request.method === 'GET' && url.pathname === '/oauth/callback') {
      requireOriginEnabled(env);
      const tokenEndpoint = configuredEndpoint(env.ORIGIN_TOKEN_ENDPOINT);
      const redirectUri = callbackUrl(env);
      if (url.origin !== new URL(redirectUri).origin) return json({ error: 'INVALID_CALLBACK_ORIGIN' }, 400);
      const state = url.searchParams.get('state') || '';
      const browser = (request.headers.get('Cookie') || '').split(';').map(v => v.trim()).find(v => v.startsWith('__Host-brufap_oauth='))?.slice('__Host-brufap_oauth='.length) || '';
      if (!/^[A-Za-z0-9_-]{43}$/.test(state) || !/^[A-Za-z0-9_-]{43}$/.test(browser)) {
        return json({ error: 'INVALID_OAUTH_STATE' }, 400, { 'Set-Cookie': cookie('') });
      }
      const repo = repoFactory(env);
      const consumed = await repo.rpc('origin_sync_consume_oauth_state', { p_state_hash: await sha256(state), p_browser_hash: await sha256(browser) });
      if (consumed !== true) return json({ error: 'OAUTH_STATE_EXPIRED_OR_USED' }, 400, { 'Set-Cookie': cookie('') });
      if (url.searchParams.has('error')) return json({ error: 'ORIGIN_AUTHORIZATION_DECLINED' }, 400, { 'Set-Cookie': cookie('') });
      const code = url.searchParams.get('code');
      if (!code || code.length > 4096) return json({ error: 'INVALID_OAUTH_CODE' }, 400, { 'Set-Cookie': cookie('') });
      const owner = crypto.randomUUID();
      const lease = await repo.claim('__oauth__', owner, 300);
      if (!lease.acquired) return json({ error: 'ORIGIN_CONNECTION_BUSY_REAUTHORIZE' }, 409, { 'Set-Cookie': cookie('') });
      try {
        const stored = await repo.credentials();
        const tokens = await exchange({ clientId: env.ORIGIN_CLIENT_ID, clientSecret: env.ORIGIN_CLIENT_SECRET, code, redirectUri, tokenEndpoint });
        await saveTokens(repo, env, tokens, owner, lease, stored.revision);
      } finally {
        await repo.release('__oauth__', owner, lease.lease_token);
      }
      return new Response('Conexão autorizada. Você pode fechar esta aba e consultar a situação na integração FAGOO.', {
        headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8', 'Set-Cookie': cookie('') },
      });
    }
    return json({ error: 'NOT_FOUND' }, 404);
  } catch (error) {
    return json({ error: safeError(error) }, 503, url.pathname === '/oauth/callback' ? { 'Set-Cookie': cookie('') } : {});
  }
}

export default {
  fetch: handleRequest,
  async scheduled(_controller, env) {
    if (env.ORIGIN_ENABLED !== 'true' || env.SYNC_ENABLED !== 'true') return;
    const result = await runSync(new Repository(env), env);
    // No records, URLs, credentials or upstream error bodies in logs.
    if (result.status === 'failed') throw new Error('ORIGIN_SYNC_FAILED_CHECK_ADMIN_STATUS');
  },
};
