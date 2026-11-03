/** Only operator-controlled deployment configuration may select an upstream host. */
export function configuredEndpoint(value, { originOnly = false, code = 'ORIGIN_ENDPOINT_NOT_CONFIGURED' } = {}) {
  try {
    if (typeof value !== 'string' || !value || value !== value.trim() || /[\\\s]/.test(value)) throw new Error();
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash || value.includes('?') || value.includes('#') || (originOnly && url.pathname !== '/')) throw new Error();
    return originOnly ? url.origin : url.href;
  } catch { throw new Error(code); }
}
export function requireOriginEnabled(env) {
  if (env.ORIGIN_ENABLED !== 'true') throw new Error('ORIGIN_DISABLED');
}
