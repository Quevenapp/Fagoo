import { useEffect, useRef, useState } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';

type Controller = Pick<AccessController, 'documents' | 'getSnapshot'>;
export interface UserSignature { greeting: string | null; department: string | null; name: string | null; version: number }
export const SIGNATURE_PATH = '/v1/documentos/sales_proposals/assinatura';
const PATH = SIGNATURE_PATH;
const actorOf = (controller: Controller) => controller.getSnapshot()?.membership?.user_id ?? null;
export function readSignature(value: unknown): UserSignature {
  const page = (value ?? {}) as Partial<UserSignature> & { replayed?: unknown };
  const line = (v: unknown, max: number) => v === null || (typeof v === 'string' && v.length <= max);
  if (!line(page.greeting, 200) || !line(page.department, 100) || !line(page.name ?? null, 200) || !Number.isInteger(page.version)) throw new Error('SIGNATURE_INVALID');
  return { greeting: page.greeting ?? null, department: page.department ?? null, name: page.name ?? null, version: page.version as number };
}

/**
 * Proposta comercial › Assinatura (202610200199): Saudação and Departamento "Definido por usuário", printed at the end of the
 * proposta with the name of the user. The signature is the user's own, saved with its own command (not with the proposta).
 */
export default function DocumentSignature({ controller, writable, onLoaded }: { controller: Controller; writable: boolean; onLoaded: (value: UserSignature | null) => void }) {
  const [saved, setSaved] = useState<UserSignature | null>(null), [greeting, setGreeting] = useState(''), [department, setDepartment] = useState('');
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const actor = actorOf(controller), attempt = useRef<{ command_id: string; expected_version: number; greeting: string | null; department: string | null; actor: string | null } | null>(null), alive = useRef(true);
  const loaded = useRef(onLoaded); loaded.current = onLoaded;
  useEffect(() => {
    alive.current = true; const request = new AbortController();
    void Promise.resolve().then(() => controller.documents(PATH, { signal: request.signal })).then(value => {
      if (request.signal.aborted || actorOf(controller) !== actor) return; const signature = readSignature(value);
      setSaved(signature); setGreeting(signature.greeting ?? ''); setDepartment(signature.department ?? ''); loaded.current(signature);
    }).catch(() => { if (!request.signal.aborted) loaded.current(null); });
    return () => { alive.current = false; request.abort(); };
  }, [controller, actor]);
  const run = async () => {
    const body = attempt.current; if (!body || busy) return;
    if (actorOf(controller) !== body.actor) { attempt.current = null; setUncertain(false); setError('A sessão mudou. Confira a assinatura antes de repetir.'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      const { actor: _actor, ...request } = body;
      const signature = readSignature(await controller.documents(PATH, { method: 'POST', body: request }));
      if (!alive.current || actorOf(controller) !== body.actor) return;
      attempt.current = null; setUncertain(false); setSaved(signature); setGreeting(signature.greeting ?? ''); setDepartment(signature.department ?? ''); loaded.current(signature); setNotice('Assinatura salva.');
    } catch (problem) {
      if (!alive.current) return;
      if (!uncertain && problem instanceof AccessError && [400, 403, 409].includes(problem.status)) { attempt.current = null; setError(problem.status === 409 ? 'A assinatura mudou em outra sessão. Feche e abra o documento para conferir.' : problem.status === 403 ? 'Seu perfil não grava propostas.' : 'Confira a saudação (até 200) e o departamento (até 100 caracteres), em uma linha.'); }
      else { setUncertain(true); setError('Não foi possível confirmar a gravação da assinatura. Use “Conferir resultado”.'); }
    } finally { if (alive.current) setBusy(false); }
  };
  const changed = saved !== null && ((greeting.trim() || null) !== saved.greeting || (department.trim() || null) !== saved.department);
  const save = () => { if (!saved || busy || uncertain || !changed) return; attempt.current = { command_id: crypto.randomUUID(), expected_version: saved.version, greeting: greeting.trim() || null, department: department.trim() || null, actor: actorOf(controller) }; void run(); };
  if (!saved) return null;
  return <fieldset className="document-section document-signature" disabled={!writable || busy}>
    <legend>Assinatura</legend>
    <div className="document-grid">
      <div className="form-field"><label htmlFor="doc-signature-greeting">Saudação</label><input id="doc-signature-greeting" maxLength={200} value={greeting} disabled={uncertain} onChange={event => setGreeting(event.target.value)} /><small className="real-help">Definido por usuário</small></div>
      <div className="form-field"><label htmlFor="doc-signature-department">Departamento</label><input id="doc-signature-department" maxLength={100} value={department} disabled={uncertain} onChange={event => setDepartment(event.target.value)} /><small className="real-help">Definido por usuário</small></div>
    </div>
    <p className="real-help">{saved.name ? `Impressa ao fim da proposta com o seu nome (${saved.name}).` : 'Impressa ao fim da proposta; o seu nome entra quando estiver cadastrado em Sistema › Usuários.'} Vale para todas as suas propostas.</p>
    {writable && (uncertain ? <button type="button" className="secondary-button" disabled={busy} onClick={() => void run()}>{busy ? 'Conferindo…' : 'Conferir resultado'}</button>
      : <button type="button" className="secondary-button" disabled={busy || !changed} onClick={save}>{busy ? 'Salvando…' : 'Salvar assinatura'}</button>)}
    {notice && <p className="real-success" role="status">{notice}</p>}{error && <p className="real-alert" role="alert">{error}</p>}
  </fieldset>;
}
