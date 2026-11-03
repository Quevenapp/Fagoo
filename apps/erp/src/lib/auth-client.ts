import type { MfaPort } from './account-security';
/** Leva H: the Supabase Auth of the company area, registered by RealAccess (which creates the one client) so that Minha conta ›
 * Alterar senha e segundo fator uses the same session. Null outside the company area or without configuration. */
let current: MfaPort | null = null;
export function registerAuthClient(auth: unknown) { current = auth ? auth as MfaPort : null; }
export const authClient = () => current;
