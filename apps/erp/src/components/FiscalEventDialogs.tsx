import { useEffect, useRef, useState } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { eventRecord, type InvoiceRecord } from '../../../../packages/erp-domain/src/fiscal-invoice-contract.mjs';
import { FISCAL_BASE } from '../lib/fiscal-invoice-list-model';
import { Modal } from './Modal';

const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const known = (error: unknown) => error instanceof AccessError && [400, 403, 404, 409].includes(error.status);
const actorOf = (controller: AccessController) => controller.getSnapshot?.()?.membership?.user_id ?? null;
const roleOf = (controller: AccessController) => controller.getSnapshot?.()?.membership?.role ?? '';
const failure = (error: unknown) => error instanceof AccessError ? error.status === 409 ? 'A nota ou a faixa mudou, já tem esse pedido ou usa números já emitidos. Confira e tente de novo.'
  : error.status === 403 ? 'Seu perfil não registra eventos fiscais.' : error.status === 400 ? 'O servidor recusou os dados. Confira o texto e os números.' : 'Não foi possível registrar o pedido.' : 'Não foi possível registrar o pedido.';
type Command = { id: string; actor: string | null; body: Record<string, unknown>; uncertain: boolean };
const HOMOLOGATION = 'Somente homologação. O pedido fica registrado como "Aguardando transmissão": a transmissão à SEFAZ ainda não está disponível no FAGOO e a nota não muda de situação.';

/** Shared send/recovery loop: one command id per request, repeated as is after an unknown outcome. */
function useEventCommand(controller: AccessController, action: string, verify: (event: ReturnType<typeof eventRecord>) => boolean, onDone: () => void) {
  const command = useRef<Command | null>(null), inflight = useRef<AbortController | null>(null), life = useRef(new AbortController());
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [error, setError] = useState('');
  useEffect(() => { const current = life.current; return () => { current.abort(); inflight.current?.abort(); }; }, []);
  const send = async () => {
    const op = command.current; if (!op || inflight.current) return;
    if (actorOf(controller) !== op.actor || !['admin', 'fiscal'].includes(roleOf(controller))) { command.current = null; setUncertain(false); setError('A sessão ou o perfil mudou. Confira as consultas de eventos antes de repetir.'); return; }
    const request = new AbortController(); inflight.current = request; setBusy(true); setError('');
    try {
      const value = await controller.fiscalInvoices(`${FISCAL_BASE}/eventos`, { method: 'POST', body: { ...op.body, command_id: op.id, action }, signal: AbortSignal.any([request.signal, life.current.signal]) }) as { event: unknown };
      if (request.signal.aborted) return;
      const event = eventRecord(value?.event);
      if (!verify(event)) throw new AccessError(502);
      command.current = null; setUncertain(false); onDone();
    } catch (problem) {
      if (request.signal.aborted || aborted(problem)) return;
      if (!op.uncertain && known(problem)) { command.current = null; setError(failure(problem)); }
      else { op.uncertain = true; setUncertain(true); setError('Não foi possível confirmar o registro. Use "Conferir resultado" para repetir o mesmo pedido sem duplicar.'); }
    } finally { if (inflight.current === request) inflight.current = null; if (!request.signal.aborted) setBusy(false); }
  };
  const start = (body: Record<string, unknown>) => { if (command.current || inflight.current) return; command.current = { id: crypto.randomUUID(), actor: actorOf(controller), body, uncertain: false }; void send(); };
  return { busy, uncertain, error, start, retry: () => void send() };
}
// A render helper, not a component: the field stays part of the dialog tree.
function counter({ id, label, value, min, max, multiline, disabled, onChange }: { id: string; label: string; value: string; min: number; max: number; multiline?: boolean; disabled?: boolean; onChange: (v: string) => void }) {
  const length = [...value.trim()].length;
  return <div className="form-field"><label htmlFor={id}>{label}</label>
    {multiline ? <textarea id={id} rows={5} maxLength={max} value={value} disabled={disabled} onChange={event => onChange(event.target.value)} /> : <input id={id} maxLength={max} value={value} disabled={disabled} onChange={event => onChange(event.target.value)} />}
    <small className={length < min ? 'fiscal-counter is-short' : 'fiscal-counter'}>{length} de no mínimo {min} caracteres (máximo {max})</small></div>;
}

export function CancelDialog({ controller, record, onClose }: { controller: AccessController; record: InvoiceRecord; onClose: (done: boolean) => void }) {
  const [text, setText] = useState('');
  const cmd = useEventCommand(controller, 'cancel', event => event.kind === 'cancel' && event.invoice_id === record.id, () => onClose(true));
  const guard = useUnsavedChanges(Boolean(text.trim()) || cmd.uncertain, cmd.busy);
  const late = record.authorized_at ? Date.now() - Date.parse(record.authorized_at) > 24 * 3600 * 1000 : false;
  const valid = [...text.trim()].length >= 15 && !/[\r\n\t]/.test(text);
  const close = () => { if (!cmd.busy) guard.confirmLeave(() => onClose(false)); };
  return <Modal title="Cancelar nota" onClose={close} actions={<><button type="button" className="secondary-button" disabled={cmd.busy} onClick={close}>Voltar</button>
    {cmd.uncertain ? <button type="button" className="primary-button" disabled={cmd.busy} onClick={cmd.retry}>{cmd.busy ? 'Conferindo…' : 'Conferir resultado'}</button>
      : <button type="button" className="primary-button" disabled={!valid || cmd.busy} onClick={() => cmd.start({ invoice_id: record.id, expected_version: record.version, justification: text.trim() })}>{cmd.busy ? 'Registrando…' : 'Cancelar nota'}</button>}</>}>
    {late && <p className="real-alert">Essa nota ultrapassou o prazo de 24 horas para cancelamento.</p>}
    {counter({ id: 'fiscal-cancel-text', label: 'Digite a justificativa do cancelamento', value: text, min: 15, max: 255, disabled: cmd.busy || cmd.uncertain, onChange: setText })}
    <p className="real-help">{HOMOLOGATION}</p>
    {cmd.error && <p className="real-alert" role="alert">{cmd.error}</p>}
  </Modal>;
}

export function CorrectionDialog({ controller, record, onClose }: { controller: AccessController; record: InvoiceRecord; onClose: (done: boolean) => void }) {
  const [text, setText] = useState('');
  const cmd = useEventCommand(controller, 'correction', event => event.kind === 'correction' && event.invoice_id === record.id, () => onClose(true));
  const guard = useUnsavedChanges(Boolean(text.trim()) || cmd.uncertain, cmd.busy);
  const close = () => { if (!cmd.busy) guard.confirmLeave(() => onClose(false)); };
  return <Modal title="Carta de correção" onClose={close} actions={<><button type="button" className="secondary-button" disabled={cmd.busy} onClick={close}>Voltar</button>
    <button type="button" className="secondary-button" disabled title="A impressão da carta de correção depende do evento autorizado pela SEFAZ.">Imprimir carta de correção</button>
    {cmd.uncertain ? <button type="button" className="primary-button" disabled={cmd.busy} onClick={cmd.retry}>{cmd.busy ? 'Conferindo…' : 'Conferir resultado'}</button>
      : <button type="button" className="primary-button" disabled={[...text.trim()].length < 15 || cmd.busy} onClick={() => cmd.start({ invoice_id: record.id, expected_version: record.version, correction: text.trim() })}>{cmd.busy ? 'Registrando…' : 'Registrar carta de correção'}</button>}</>}>
    {counter({ id: 'fiscal-correction-text', label: 'Correção', value: text, min: 15, max: 1000, multiline: true, disabled: cmd.busy || cmd.uncertain, onChange: setText })}
    <p className="real-help">A carta de correção não corrige valores, impostos, dados cadastrais que mudem o remetente ou o destinatário, nem a data de emissão ou de saída.</p>
    <p className="real-help">{HOMOLOGATION}</p>
    {cmd.error && <p className="real-alert" role="alert">{cmd.error}</p>}
  </Modal>;
}

export function InutilizationDialog({ controller, model, onClose }: { controller: AccessController; model: '55' | '65'; onClose: (done: boolean) => void }) {
  const [series, setSeries] = useState(''), [from, setFrom] = useState(''), [to, setTo] = useState(''), [text, setText] = useState('');
  const cmd = useEventCommand(controller, 'inutilization', event => event.kind === 'inutilization' && event.model === model && event.number_from === Number(from) && event.number_to === Number(to), () => onClose(true));
  const dirty = Boolean(series || from || to || text.trim());
  const guard = useUnsavedChanges(dirty || cmd.uncertain, cmd.busy);
  const numbers = /^(0|[1-9]\d{0,2})$/.test(series) && /^[1-9]\d{0,8}$/.test(from) && /^[1-9]\d{0,8}$/.test(to) && Number(from) <= Number(to) && Number(to) - Number(from) < 10000;
  const valid = numbers && [...text.trim()].length >= 15 && !/[\r\n\t]/.test(text);
  const locked = cmd.busy || cmd.uncertain;
  const close = () => { if (!cmd.busy) guard.confirmLeave(() => onClose(false)); };
  return <Modal title="Inutilizar numeração" onClose={close} actions={<><button type="button" className="secondary-button" disabled={cmd.busy} onClick={close}>Cancelar</button>
    {cmd.uncertain ? <button type="button" className="primary-button" disabled={cmd.busy} onClick={cmd.retry}>{cmd.busy ? 'Conferindo…' : 'Conferir resultado'}</button>
      : <button type="button" className="primary-button" disabled={!valid || cmd.busy} onClick={() => cmd.start({ model, series, number_from: from, number_to: to, justification: text.trim() })}>{cmd.busy ? 'Registrando…' : 'Inutilizar números'}</button>}</>}>
    <div className="document-grid">
      <div className="form-field"><label htmlFor="fiscal-inut-series">Série*</label><input id="fiscal-inut-series" inputMode="numeric" maxLength={3} value={series} disabled={locked} onChange={event => setSeries(event.target.value.replace(/\D/g, ''))} /></div>
      <div className="form-field"><label htmlFor="fiscal-inut-from">Número inicial*</label><input id="fiscal-inut-from" inputMode="numeric" maxLength={9} value={from} disabled={locked} onChange={event => setFrom(event.target.value.replace(/\D/g, ''))} /></div>
      <div className="form-field"><label htmlFor="fiscal-inut-to">Número final*</label><input id="fiscal-inut-to" inputMode="numeric" maxLength={9} value={to} disabled={locked} onChange={event => setTo(event.target.value.replace(/\D/g, ''))} /></div>
    </div>
    {!numbers && (from || to) && <p className="real-help">O número inicial deve ser menor ou igual ao final, em uma faixa de até 10.000 números.</p>}
    {counter({ id: 'fiscal-inut-text', label: 'Justificativa*', value: text, min: 15, max: 255, disabled: locked, onChange: setText })}
    <p className="real-help">Só a numeração de homologação do FAGOO ({model === '55' ? 'NF-e' : 'NFC-e'}). Números já reservados ou usados por notas são recusados. {HOMOLOGATION}</p>
    {cmd.error && <p className="real-alert" role="alert">{cmd.error}</p>}
  </Modal>;
}
