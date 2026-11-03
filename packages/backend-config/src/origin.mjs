/** Validate a backend destination supplied by the installation, never by an HTTP request.
 * Self-hosted is an explicit opt-in; the hosted default preserves existing project checks.
 * The caller must keep fixed API paths and reject redirects when sending credentials.
 */
export function isConfiguredBackendOrigin(value, deployment = 'hosted', { allowTrailingSlash = false, legacyHosted = false } = {}) {
  if (typeof value !== 'string' || !['hosted', 'self-hosted'].includes(deployment)) return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
    || url.pathname !== '/' || !(value === url.origin || allowTrailingSlash && value === `${url.origin}/`)) return false;
  if (deployment === 'hosted') return (legacyHosted ? /^[a-z0-9-]+\.supabase\.co$/ : /^[a-z0-9]{20}\.supabase\.co$/).test(url.hostname);
  // A canonical public DNS hostname is required. HTTPS termination belongs to the installation.
  const labels = url.hostname.split('.');
  return url.hostname.length <= 253 && labels.length >= 2 && /[a-z]/.test(labels.at(-1))
    && labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}
