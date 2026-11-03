import { isConfiguredBackendOrigin } from '../../../../packages/backend-config/src/origin.mjs';

export interface AccessConfig { supabaseUrl: string; publicKey: string; apiUrl: string; a1ApiUrl?: string }

/** Validation prevents privileged keys from entering a public build; it does not authenticate users. */
export function accessConfig(env: Record<string, unknown>): AccessConfig | null {
  const supabaseUrl = String(env.VITE_SUPABASE_URL || '').trim();
  const publicKey = String(env.VITE_SUPABASE_ANON_KEY || env.VITE_SUPABASE_PUBLISHABLE_KEY || '').trim();
  const apiUrl = String(env.VITE_ERP_API_URL || '').trim();
  const a1ApiUrl = String(env.VITE_A1_API_URL || '').trim();
  const deployment = String(env.VITE_SUPABASE_DEPLOYMENT || 'hosted').trim();
  if (!supabaseUrl && !publicKey && !apiUrl && !a1ApiUrl && !env.VITE_SUPABASE_DEPLOYMENT) return null;
  const invalid = () => { throw new Error('Configuração pública de acesso inválida. Verifique as URLs e use somente uma chave Supabase publishable ou anon.'); };
  let supabase: URL, api: URL;
  try { supabase = new URL(supabaseUrl); api = new URL(apiUrl); } catch { return invalid(); }
  if (!['hosted', 'self-hosted'].includes(deployment)
    || supabase.protocol !== 'https:' || supabase.username || supabase.password
    || (deployment === 'hosted' && !/^[a-z0-9]+\.supabase\.co$/.test(supabase.hostname))
    || (deployment === 'self-hosted' && !isConfiguredBackendOrigin(supabaseUrl, deployment))
    || supabase.origin !== supabaseUrl || api.origin !== apiUrl || api.username || api.password
    || !(api.protocol === 'https:' || (api.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(api.hostname)))) return invalid();
  if (a1ApiUrl) {
    let a1: URL; try { a1 = new URL(a1ApiUrl); } catch { return invalid(); }
    if (a1.protocol !== 'https:' || a1.origin !== a1ApiUrl || a1.username || a1.password) return invalid();
  }
  const configured = {supabaseUrl, publicKey, apiUrl, ...(a1ApiUrl ? {a1ApiUrl} : {})};
  if (/^sb_publishable_[a-zA-Z0-9_-]{16,}$/.test(publicKey)) return configured;
  try {
    const parts = publicKey.split('.');
    if (parts.length !== 3 || parts.some(part => !/^[a-zA-Z0-9_-]+$/.test(part))) return invalid();
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (payload.role !== 'anon' || (deployment === 'hosted' && payload.ref !== supabase.hostname.split('.')[0])) return invalid();
  } catch { return invalid(); }
  return configured;
}
