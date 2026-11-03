import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';

const ROLE_LABELS: Record<string, string> = { admin: 'Administrador', consulta: 'Consulta', vendas: 'Vendas', financeiro: 'Financeiro', estoque: 'Estoque', fiscal: 'Fiscal' };
import { accountSecurityMessage, changePassword, mfaFactors, passwordProblem, removeFactor, PASSWORD_MIN, type MfaPort } from '../lib/account-security';
import { parseSecurityPolicy, parseSecurityPolicyAnswer } from '../../../../packages/erp-domain/src/access-security.mjs';
import { MfaSetup } from './MfaSetup';

type Policy = ReturnType<typeof parseSecurityPolicy>;
const policyError = (error: unknown) => error instanceof AccessError ? (error.code === 'ERP_MFA_REQUIRED' ? 'Confirme o código do seu aplicativo autenticador nesta sessão (acima) antes de mudar a exigência.'
  : error.status === 409 ? 'A política mudou desde a consulta. Recarregue e tente novamente.' : error.status === 403 ? 'Somente administradores alteram a exigência do segundo fator.'
  : error.status === 503 ? 'A exigência foi registrada, mas a confirmação nos usuários ficou pendente. Clique em salvar de novo para concluir.' : 'Não foi possível concluir. Tente novamente.') : 'Não foi possível concluir. Tente novamente.';

/** Minha conta › Segurança (leva H: PRF-291 Alterar senha, PRF-208 segundo fator e a exigência da empresa para o administrador). */
export default function AccountSecurity({ port, controller }: { port: MfaPort; controller: Pick<AccessController, 'security' | 'getSnapshot'> }) {
  const admin = controller.getSnapshot().membership?.role === 'admin';
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // Senha
  const [password, setPassword] = useState(''), [confirmation, setConfirmation] = useState(''), [nonce, setNonce] = useState(''), [askNonce, setAskNonce] = useState(false);
  const [passwordBusy, setPasswordBusy] = useState(false), [passwordMessage, setPasswordMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const savePassword = async (event: FormEvent) => {
    event.preventDefault(); if (passwordBusy) return;
    const problem = passwordProblem(password, confirmation); if (problem) { setPasswordMessage({ ok: false, text: problem }); return; }
    setPasswordBusy(true); setPasswordMessage(null);
    try {
      const outcome = await changePassword(port, password, askNonce ? nonce : undefined);
      if (!mounted.current) return;
      if (outcome === 'needs_nonce') { setAskNonce(true); setPasswordMessage({ ok: true, text: 'Enviamos um código para o seu e-mail. Digite-o abaixo e salve de novo.' }); }
      else { setPassword(''); setConfirmation(''); setNonce(''); setAskNonce(false); setPasswordMessage({ ok: true, text: 'Senha alterada. Use a nova senha no próximo acesso.' }); }
    } catch (failure) { if (mounted.current) setPasswordMessage({ ok: false, text: accountSecurityMessage(failure) }); }
    finally { if (mounted.current) setPasswordBusy(false); }
  };
  // Segundo fator próprio
  const [factor, setFactor] = useState<string | null | undefined>(undefined), [factorReload, setFactorReload] = useState(0), [factorMessage, setFactorMessage] = useState('');
  useEffect(() => { void mfaFactors(port).then(found => { if (mounted.current) setFactor(found.verified?.id ?? null); }).catch(failure => { if (mounted.current) { setFactor(null); setFactorMessage(accountSecurityMessage(failure)); } }); }, [port, factorReload]);
  const [removing, setRemoving] = useState(false), [confirmRemove, setConfirmRemove] = useState(false);
  const remove = async () => {
    if (!factor || removing) return; setRemoving(true); setFactorMessage('');
    try { await removeFactor(port, factor); if (mounted.current) { setConfirmRemove(false); setFactorReload(value => value + 1); setFactorMessage('Aplicativo autenticador removido.'); } }
    catch (failure) { if (mounted.current) setFactorMessage(accountSecurityMessage(failure)); }
    finally { if (mounted.current) setRemoving(false); }
  };
  // Exigência da empresa (administrador)
  const [policy, setPolicy] = useState<Policy | null>(null), [policyReload, setPolicyReload] = useState(0), [policyMessage, setPolicyMessage] = useState('');
  const [policyBusy, setPolicyBusy] = useState(false); const command = useRef<{ id: string; expected: number; on: boolean } | null>(null);
  useEffect(() => {
    if (!admin) return; const request = new AbortController();
    void controller.security('/v1/seguranca/politica', { signal: request.signal }).then(raw => { if (!request.signal.aborted) setPolicy(parseSecurityPolicy(raw)); })
      .catch(failure => { if (!request.signal.aborted && !(failure instanceof DOMException)) setPolicyMessage(policyError(failure)); });
    return () => request.abort();
  }, [admin, controller, policyReload, factorReload]);
  const togglePolicy = async () => {
    if (!policy || policyBusy) return;
    const attempt = command.current ?? { id: crypto.randomUUID(), expected: policy.policy.version, on: !policy.policy.mfa_required };
    command.current = attempt; setPolicyBusy(true); setPolicyMessage('');
    const body = { command_id: attempt.id, expected_version: attempt.expected, mfa_required: attempt.on };
    try {
      parseSecurityPolicyAnswer(await controller.security('/v1/seguranca/politica', { method: 'POST', body }), body);
      command.current = null; if (mounted.current) { setPolicyMessage(attempt.on ? 'Exigência ligada. Quem está na lista confirma o código no próximo acesso.' : 'Exigência desligada.'); setPolicyReload(value => value + 1); }
    } catch (failure) {
      // Only an unconfirmed answer keeps the same command for the next click; a refusal starts over.
      if (!(failure instanceof AccessError && failure.status === 503)) command.current = null;
      if (mounted.current) setPolicyMessage(policyError(failure));
    } finally { if (mounted.current) setPolicyBusy(false); }
  };
  return <div className="account-security">
    <header className="real-heading"><div><h1>Segurança da conta</h1><p>Senha de acesso e aplicativo autenticador (segundo fator).</p></div></header>
    <section className="real-editor company-settings-section" aria-labelledby="password-title">
      <h2 id="password-title">Alterar senha</h2>
      <p className="real-help">Escolha uma senha com ao menos {PASSWORD_MIN} caracteres. Se você esqueceu a senha atual, saia e use “Esqueci minha senha” na tela de acesso.</p>
      <form onSubmit={savePassword} aria-busy={passwordBusy}>
        <div className="company-settings-grid">
          <div className="form-field"><label htmlFor="new-password">Nova senha *</label><input id="new-password" type="password" autoComplete="new-password" minLength={PASSWORD_MIN} maxLength={72} required value={password} disabled={passwordBusy} onChange={event => setPassword(event.target.value)} /></div>
          <div className="form-field"><label htmlFor="new-password-confirmation">Confirmar nova senha *</label><input id="new-password-confirmation" type="password" autoComplete="new-password" maxLength={72} required value={confirmation} disabled={passwordBusy} onChange={event => setConfirmation(event.target.value)} /></div>
          {askNonce && <div className="form-field"><label htmlFor="password-nonce">Código recebido por e-mail *</label><input id="password-nonce" inputMode="numeric" autoComplete="one-time-code" maxLength={10} required value={nonce} disabled={passwordBusy} onChange={event => setNonce(event.target.value)} /></div>}
        </div>
        {passwordMessage && <p className={passwordMessage.ok ? 'real-success' : 'real-alert'} role={passwordMessage.ok ? 'status' : 'alert'}>{passwordMessage.text}</p>}
        <div className="real-editor-actions"><button className="primary-button" disabled={passwordBusy}>{passwordBusy ? 'Salvando…' : 'Salvar nova senha'}</button></div>
      </form>
    </section>
    <section className="real-editor company-settings-section" aria-labelledby="mfa-own-title">
      <h2 id="mfa-own-title">Aplicativo autenticador (segundo fator)</h2>
      {factorMessage && <p className="real-notice" role="status">{factorMessage}</p>}
      {factor === undefined ? <p role="status">Consultando…</p> : factor ? <>
        <p><span className="badge badge-success">Ativo</span> Seu acesso pede o código do aplicativo quando a empresa exige o segundo fator.</p>
        {confirmRemove ? <div className="real-alert"><p>Remover o aplicativo autenticador? Se a empresa exige o segundo fator para o seu perfil, você precisará cadastrar outro no próximo acesso.</p>
          <div className="real-editor-actions"><button type="button" className="secondary-button" disabled={removing} onClick={() => setConfirmRemove(false)}>Manter</button><button type="button" className="primary-button" disabled={removing} onClick={() => void remove()}>Remover</button></div></div>
          : <button type="button" className="secondary-button" onClick={() => setConfirmRemove(true)}>Remover aplicativo autenticador</button>}
      </> : <MfaSetup port={port} onVerified={() => { setFactorMessage('Aplicativo autenticador cadastrado e confirmado nesta sessão.'); setFactorReload(value => value + 1); }} intro="Cadastre um aplicativo autenticador para proteger o seu acesso. Depois de cadastrado, o código também é pedido quando a empresa exigir." />}
    </section>
    {admin && <section className="real-editor company-settings-section" aria-labelledby="mfa-policy-title">
      <h2 id="mfa-policy-title">Exigir segundo fator na empresa</h2>
      <p className="real-help">Com a exigência ligada, administradores, o perfil Financeiro e quem pode baixar, cancelar ou transferir valores, gerar remessas, ler retornos ou emitir boletos só usam o FAGOO depois de confirmar o código do aplicativo. Para ligar ou desligar, confirme antes o seu próprio código nesta sessão.</p>
      {policyMessage && <p className="real-notice" role="status">{policyMessage}</p>}
      {!policy ? <p role="status">Consultando…</p> : <>
        <p>Situação: <strong>{policy.policy.mfa_required ? 'exigido' : 'não exigido'}</strong>{policy.policy.updated_at ? ` · alterado em ${new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date(policy.policy.updated_at))}` : ''}.</p>
        <table className="data-table"><caption className="real-help">Usuários que precisam do segundo fator</caption><thead><tr><th scope="col">Usuário</th><th scope="col">Perfil</th><th scope="col">Aplicativo cadastrado</th></tr></thead>
          <tbody>{policy.policy.members.map(member => <tr key={member.user_id}><td>{member.name}</td><td>{ROLE_LABELS[member.role] ?? member.role}</td><td>{member.factor ? 'Sim' : 'Ainda não'}</td></tr>)}</tbody></table>
        {!policy.policy.mfa_required && policy.policy.members.some(member => !member.factor) && <p className="real-help">Quem ainda não cadastrou o aplicativo será levado ao cadastro no próximo acesso.</p>}
        <div className="real-editor-actions"><button type="button" className="primary-button" disabled={policyBusy || !policy.self.aal2} title={policy.self.aal2 ? undefined : 'Cadastre e confirme o seu aplicativo autenticador nesta sessão primeiro.'} onClick={() => void togglePolicy()}>
          {policyBusy ? 'Salvando…' : policy.policy.mfa_required ? 'Desligar exigência' : 'Ligar exigência'}</button></div>
        {!policy.self.aal2 && <p className="real-help">Para mudar a exigência, cadastre e confirme o seu aplicativo autenticador acima.</p>}
      </>}
    </section>}
  </div>;
}
