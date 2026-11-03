import { configuredEndpoint } from './endpoints.mjs';
const requestTimeoutMs = 15_000;
const oauthErrorCodes = new Set([
  'invalid_client', 'invalid_grant', 'invalid_request', 'unauthorized_client',
  'unsupported_grant_type', 'invalid_scope',
]);

function requireText(value) {
  if (typeof value !== 'string' || value.length === 0) throw new Error('ORIGIN_OAUTH_INVALID_CONFIG');
  return value;
}

function requireRedirectUri(value) {
  try {
    const url = new URL(requireText(value));
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error();
    return url.href;
  } catch {
    throw new Error('ORIGIN_OAUTH_INVALID_REDIRECT');
  }
}

function basicCredentials(clientId, clientSecret) {
  const bytes = new TextEncoder().encode(`${requireText(clientId)}:${requireText(clientSecret)}`);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function authorizationUrl({ clientId, redirectUri, state, authorizationEndpoint }) {
  const url = new URL(configuredEndpoint(authorizationEndpoint));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', requireText(clientId));
  url.searchParams.set('state', requireText(state));
  // Origin uses the callback registered on the app, even when this is supplied.
  url.searchParams.set('redirect_uri', requireRedirectUri(redirectUri));
  return url.href;
}

function validatedTokens(data) {
  if (!data || typeof data.access_token !== 'string' || !data.access_token
      || typeof data.refresh_token !== 'string' || !data.refresh_token
      || !Number.isSafeInteger(data.expires_in) || data.expires_in <= 0
      || typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer') {
    throw new Error('ORIGIN_OAUTH_INVALID_RESPONSE');
  }
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
    token_type: 'Bearer',
  };
}

async function classifiedErrorSuffix(response) {
  try {
    const data = await response.json();
    // Origin documents error.type; the string form is the OAuth standard envelope.
    // Only these constant codes may leave this function, never descriptions or tokens.
    const code = typeof data?.error === 'string' ? data.error : data?.error?.type;
    return oauthErrorCodes.has(code) ? `_${code.toUpperCase()}` : '';
  } catch {
    return '';
  }
}

async function requestTokens({ clientId, clientSecret, body, tokenEndpoint, fetchImpl = globalThis.fetch.bind(globalThis) }) {
  tokenEndpoint = configuredEndpoint(tokenEndpoint);
  const authorization = `Basic ${basicCredentials(clientId, clientSecret)}`;
  if (typeof fetchImpl !== 'function') throw new Error('ORIGIN_OAUTH_INVALID_CONFIG');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(tokenEndpoint, {
        method: 'POST',
        headers: {
          Authorization: authorization,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          'enable-jwt': '1',
        },
        body: body.toString(),
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch {
      throw new Error(controller.signal.aborted ? 'ORIGIN_OAUTH_TIMEOUT' : 'ORIGIN_OAUTH_REQUEST_FAILED');
    }
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      throw new Error('ORIGIN_OAUTH_REDIRECT_BLOCKED');
    }
    if (!response.ok) {
      const status = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
        ? response.status : 'ERROR';
      throw new Error(`ORIGIN_OAUTH_HTTP_${status}${await classifiedErrorSuffix(response)}`);
    }
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error(controller.signal.aborted ? 'ORIGIN_OAUTH_TIMEOUT' : 'ORIGIN_OAUTH_INVALID_RESPONSE');
    }
    return validatedTokens(data);
  } finally {
    clearTimeout(timer);
  }
}

export async function exchangeCode({ clientId, clientSecret, code, redirectUri, tokenEndpoint, fetchImpl }) {
  requireRedirectUri(redirectUri);
  const body = new URLSearchParams({ grant_type: 'authorization_code', code: requireText(code) });
  return requestTokens({ clientId, clientSecret, body, tokenEndpoint, fetchImpl });
}

export async function refreshTokens({ clientId, clientSecret, refreshToken, tokenEndpoint, fetchImpl }) {
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: requireText(refreshToken) });
  return requestTokens({ clientId, clientSecret, body, tokenEndpoint, fetchImpl });
}
