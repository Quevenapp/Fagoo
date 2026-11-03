import { useEffect, useRef, useState, type FormEvent } from 'react';
import { accountSecurityMessage, mfaFactors, startEnrollment, verifyCode, type MfaPort } from '../lib/account-security';

type Enrollment = { factorId: string; qr: string; secret: string };
/** Leva H (PRF-208): registers an authenticator app (QR code or key) or asks for its current code. A verified code upgrades the
 * session to aal2; `onVerified` runs after that (the access controller sees the new session on its own). */
export function MfaSetup({ port, onVerified, intro }: { port: MfaPort; onVerified: () => void; intro?: string }) {
  const [factorId, setFactorId] = useState<string | null>(null), [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [code, setCode] = useState(''), [busy, setBusy] = useState(true), [error, setError] = useState(''), [reload, setReload] = useState(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    setBusy(true); setError('');
    void mfaFactors(port).then(found => { if (mounted.current) { setFactorId(found.verified?.id ?? null); setBusy(false); } })
      .catch(failure => { if (mounted.current) { setError(accountSecurityMessage(failure)); setBusy(false); } });
  }, [port, reload]);
  const enroll = async () => {
    setBusy(true); setError('');
    try { const started = await startEnrollment(port); if (mounted.current) { setEnrollment(started); setFactorId(started.factorId); } }
    catch (failure) { if (mounted.current) setError(accountSecurityMessage(failure)); }
    finally { if (mounted.current) setBusy(false); }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!factorId || busy) return;
    setBusy(true); setError('');
    try { await verifyCode(port, factorId, code); if (mounted.current) { setCode(''); setEnrollment(null); } onVerified(); }
    catch (failure) { if (mounted.current) setError(accountSecurityMessage(failure)); }
    finally { if (mounted.current) setBusy(false); }
  };
  const codeForm = <form onSubmit={submit} aria-busy={busy} className="mfa-code">
    <div className="form-field"><label htmlFor="mfa-code">Código de 6 dígitos do aplicativo</label>
      <input id="mfa-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required autoFocus value={code} disabled={busy} onChange={event => setCode(event.target.value)} /></div>
    <button className="primary-button" type="submit" disabled={busy}>{busy ? 'Conferindo…' : 'Confirmar código'}</button>
  </form>;
  return <div className="mfa-setup">
    {intro && <p>{intro}</p>}
    {error && <p className="real-alert" role="alert">{error} <button type="button" className="text-button" onClick={() => setReload(value => value + 1)}>Tentar novamente</button></p>}
    {busy && !factorId && !enrollment && <p role="status">Consultando o segundo fator…</p>}
    {enrollment ? <>
      <ol className="real-help">
        <li>Abra um aplicativo autenticador (Google Authenticator, Microsoft Authenticator, 1Password ou similar).</li>
        <li>Leia o QR code abaixo ou digite a chave manualmente.</li>
        <li>Digite o código de 6 dígitos que o aplicativo mostrar.</li>
      </ol>
      <img className="mfa-qr" src={enrollment.qr} alt="QR code para cadastrar o FAGOO no aplicativo autenticador" width={180} height={180} />
      <p className="real-help">Chave: <code className="mfa-secret">{enrollment.secret}</code></p>
      {codeForm}
    </> : factorId ? codeForm : !busy && <button type="button" className="primary-button" onClick={() => void enroll()}>Cadastrar aplicativo autenticador</button>}
  </div>;
}
