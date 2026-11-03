import { configuredEndpoint, requireOriginEnabled } from './endpoints.mjs';
import { decryptTokens, encryptTokens } from './crypto.mjs';
import { refreshTokens } from './oauth.mjs';

export async function saveTokens(repo, env, tokens, owner, lease, revision, now = Date.now()) {
  const ciphertext = await encryptTokens(tokens, env.TOKEN_ENCRYPTION_KEY);
  const params = {
    p_ciphertext: ciphertext,
    p_expires_at: new Date(now + tokens.expires_in * 1000).toISOString(),
    p_expected_revision: revision, p_owner: owner, p_lease_token: lease.lease_token,
  };
  try {
    return await repo.rpc('origin_sync_put_credentials', params);
  } catch (error) {
    // Recover a lost database response without refreshing a second time.
    const stored = await repo.credentials();
    if (stored.revision === revision + 1 && stored.ciphertext?.version === ciphertext.version
        && stored.ciphertext?.iv === ciphertext.iv && stored.ciphertext?.ciphertext === ciphertext.ciphertext) {
      return { revision: stored.revision, expires_at: stored.expires_at, recovered: true };
    }
    throw error;
  }
}

export async function accessToken(repo, env, { now = Date.now, refresh = refreshTokens } = {}) {
  requireOriginEnabled(env);
  const tokenEndpoint = configuredEndpoint(env.ORIGIN_TOKEN_ENDPOINT);
  let stored = await repo.credentials();
  if (!stored.ciphertext) throw new Error('ORIGIN_AUTHORIZATION_REQUIRED');
  if (Date.parse(stored.expires_at) > now() + 300000) {
    return (await decryptTokens(stored.ciphertext, env.TOKEN_ENCRYPTION_KEY)).access_token;
  }
  const owner = crypto.randomUUID();
  const lease = await repo.claim('__oauth__', owner, 300);
  if (!lease.acquired) throw new Error('ORIGIN_REFRESH_IN_PROGRESS');
  try {
    stored = await repo.credentials();
    const tokens = await decryptTokens(stored.ciphertext, env.TOKEN_ENCRYPTION_KEY);
    if (Date.parse(stored.expires_at) > now() + 300000) return tokens.access_token;
    const fresh = await refresh({ clientId: env.ORIGIN_CLIENT_ID, clientSecret: env.ORIGIN_CLIENT_SECRET, refreshToken: tokens.refresh_token, tokenEndpoint });
    await saveTokens(repo, env, fresh, owner, lease, stored.revision, now());
    return fresh.access_token;
  } finally {
    await repo.release('__oauth__', owner, lease.lease_token);
  }
}
