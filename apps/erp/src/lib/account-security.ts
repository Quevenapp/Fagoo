/** Leva H, lane acesso (PRF-208, PRF-209, PRF-291): the user's own second factor (TOTP of Supabase Auth) and password change.
 * Everything here talks to Supabase Auth with the user's own session; the ERP never sees the TOTP secret beyond the enrollment
 * screen and never stores a password. The company policy and the reset of another user's factor go through /v1/seguranca. */
export const PASSWORD_MIN = 12;
type Result<T> = { data: T; error: { message?: string; code?: string; status?: number } | null };
export interface Factor { id: string; factor_type: string; status: string; friendly_name?: string | null }
export interface MfaPort {
  mfa: {
    listFactors(): Promise<Result<{ all: Factor[] } | null>>;
    enroll(params: { factorType: 'totp'; friendlyName?: string }): Promise<Result<{ id: string; totp: { qr_code: string; secret: string; uri: string } } | null>>;
    challengeAndVerify(params: { factorId: string; code: string }): Promise<Result<unknown>>;
    unenroll(params: { factorId: string }): Promise<Result<unknown>>;
  };
  updateUser(attributes: { password: string; nonce?: string }): Promise<Result<unknown>>;
  reauthenticate(): Promise<Result<unknown>>;
}
export class AccountSecurityError extends Error { reason: string; constructor(reason: string) { super(reason); this.reason = reason; } }
const fail = (reason: string): never => { throw new AccountSecurityError(reason); };

export const totpCode = (value: string) => /^\d{6}$/.test(value.replace(/\s/g, ''));
/** The verified TOTP factor of the user, if any (only one is used by the ERP). */
export async function mfaFactors(port: MfaPort) {
  const result = await port.mfa.listFactors();
  if (result.error || !result.data || !Array.isArray(result.data.all)) fail('unavailable');
  const all = result.data!.all.filter(f => f.factor_type === 'totp');
  return { verified: all.find(f => f.status === 'verified') ?? null, pending: all.filter(f => f.status !== 'verified') };
}
/** Starts a new enrollment, removing unfinished ones first (an abandoned QR code never becomes a second factor). */
export async function startEnrollment(port: MfaPort) {
  const { verified, pending } = await mfaFactors(port);
  if (verified) fail('already_enrolled');
  for (const factor of pending) { const removed = await port.mfa.unenroll({ factorId: factor.id }); if (removed.error) fail('unavailable'); }
  const result = await port.mfa.enroll({ factorType: 'totp', friendlyName: `FAGOO ${new Date().toISOString().slice(0, 19)}` });
  if (result.error || !result.data?.id || !result.data.totp?.qr_code?.startsWith('data:image/svg+xml')) fail('unavailable');
  return { factorId: result.data!.id, qr: result.data!.totp.qr_code, secret: result.data!.totp.secret };
}
/** Confirms a code of the authenticator; on success Auth upgrades this session to aal2. */
export async function verifyCode(port: MfaPort, factorId: string, code: string) {
  const clean = code.replace(/\s/g, '');
  if (!totpCode(clean)) fail('invalid_code');
  const result = await port.mfa.challengeAndVerify({ factorId, code: clean });
  if (result.error) fail(result.error.status === 422 || result.error.status === 400 || /invalid|expired/i.test(result.error.code ?? result.error.message ?? '') ? 'invalid_code' : 'unavailable');
}
export async function removeFactor(port: MfaPort, factorId: string) {
  const result = await port.mfa.unenroll({ factorId });
  if (result.error) fail(result.error.code === 'insufficient_aal' || result.error.status === 403 || /aal/i.test(result.error.message ?? '') ? 'needs_aal2' : 'unavailable');
}
/** Own password change. With "Secure password change" on, Auth may ask for the code it e-mails (reauthenticate) first. */
export function passwordProblem(password: string, confirmation: string) {
  if (password.length < PASSWORD_MIN) return `A senha precisa de ao menos ${PASSWORD_MIN} caracteres.`;
  if (password.length > 72) return 'Use no máximo 72 caracteres.';
  if (password !== confirmation) return 'A confirmação não é igual à nova senha.';
  return null;
}
export async function changePassword(port: MfaPort, password: string, nonce?: string): Promise<'done' | 'needs_nonce'> {
  const result = await port.updateUser(nonce ? { password, nonce: nonce.trim() } : { password });
  if (!result.error) return 'done';
  const code = result.error.code ?? '';
  if (code === 'reauthentication_needed' || code === 'reauthentication_not_valid' && !nonce) {
    const sent = await port.reauthenticate(); if (sent.error) fail('unavailable'); return 'needs_nonce';
  }
  if (code === 'reauthentication_not_valid') fail('invalid_nonce');
  if (code === 'same_password') fail('same_password');
  if (code === 'weak_password') fail('weak_password');
  if (code === 'insufficient_aal') fail('needs_aal2');
  return fail('unavailable');
}
export const ACCOUNT_SECURITY_MESSAGES: Record<string, string> = {
  unavailable: 'Não foi possível concluir agora. Tente novamente.',
  already_enrolled: 'Você já tem um aplicativo autenticador cadastrado.',
  invalid_code: 'Código inválido ou expirado. Confira o horário do celular e digite o código atual.',
  needs_aal2: 'Confirme o código do aplicativo autenticador nesta sessão antes de fazer essa alteração.',
  invalid_nonce: 'O código enviado por e-mail não confere ou expirou. Peça um novo.',
  same_password: 'A nova senha precisa ser diferente da atual.',
  weak_password: 'Senha fraca: use uma frase longa, com letras, números e símbolos.',
};
export const accountSecurityMessage = (error: unknown) => ACCOUNT_SECURITY_MESSAGES[error instanceof AccountSecurityError ? error.reason : 'unavailable'] ?? ACCOUNT_SECURITY_MESSAGES.unavailable;
