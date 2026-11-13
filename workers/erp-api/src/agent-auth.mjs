/** Agent access (202611130001): an installation may let an external agent call the API with a token of its own instead of
 * a browser session. The agent is an ordinary member (a technical Auth user), so every RPC keeps applying its role,
 * permissions, access windows and audit. Only the SHA-256 of the token leaves the Worker; the token is never sent to Auth. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const AGENT_TOKEN_PREFIX = 'fagoo_agt_';
/** The prefix plus 32 random bytes in unpadded base64url. */
export const AGENT_TOKEN = /^fagoo_agt_[A-Za-z0-9_-]{43}$/;
/** Anything carrying the prefix is an agent credential, well formed or not: it must never reach the session path. */
export const isAgentToken = token => typeof token === 'string' && token.startsWith(AGENT_TOKEN_PREFIX);
export async function agentTokenHash(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
/** The answer of erp_access_agent_resolve: { status: 'ok', userId } | { status: 'unknown' } | { status: 'denied' }; null when
 * the answer is not one the database gives. */
export function agentResolution(answer) {
  if (!answer || typeof answer !== 'object' || answer.scope !== 'agent_access') return null;
  if (answer.status === 'unknown' || answer.status === 'denied') return { status: answer.status };
  if (answer.status !== 'ok' || typeof answer.user_id !== 'string' || !UUID.test(answer.user_id)) return null;
  return { status: 'ok', userId: answer.user_id.toLowerCase() };
}
