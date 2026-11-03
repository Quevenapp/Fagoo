import { useEffect, useRef, useState } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import type { ContactRecord } from '../lib/contact-form-model';
import { CONFLICT_TEXT, aborted, errorText } from './catalog-shared';
import { contactRefusalText, refusalField } from './contact-errors';

// Save flow of the contact form and of the "Adicionar cadastro" drawer (/v1/cadastros/contatos): the read-only check
// (CPF/CNPJ, duplicidade, CPF dos pais) with "Salvar mesmo assim", one command_id per save with "Conferir resultado"
// after an unknown outcome, expected_version, and a fresh read of the saved contact before reporting it.
export type ContactWarning = { code: 'invalid_document' | 'duplicate_document' | 'invalid_father_cpf' | 'invalid_mother_cpf'; field: string; expected?: string; total?: number; blocked?: boolean; matches?: { id: string; name: string; code: string | null; active: boolean }[] };
type Operation = { path: string; method: 'POST' | 'PATCH'; body: Record<string, unknown> };
const WARNING_KEYS = ['document', 'father_cpf', 'mother_cpf'];

export function warningMessage(warning: ContactWarning) {
  if (warning.code === 'duplicate_document') {
    const shown = (warning.matches ?? []).slice(0, 3).map(match => `${match.name}${match.code ? ` (${match.code})` : ''}${match.active ? '' : ' — inativo'}`), total = warning.total ?? shown.length;
    return `Este CPF/CNPJ já está em ${total === 1 ? '1 outro contato' : `${total} outros contatos`}: ${shown.join('; ')}${total > shown.length ? '…' : ''}.${warning.blocked ? ' As Preferências não permitem CPF / CNPJ duplicado.' : ''}`;
  }
  if (warning.code === 'invalid_father_cpf') return 'O CPF do Pai não confere com os dígitos verificadores.';
  if (warning.code === 'invalid_mother_cpf') return 'O CPF da Mãe não confere com os dígitos verificadores.';
  return warning.expected === 'cpf' ? 'O CPF informado não confere com os dígitos verificadores.' : warning.expected === 'cnpj' ? 'O CNPJ informado não confere com os dígitos verificadores.'
    : 'O documento não tem formato de CPF nem de CNPJ. Para estrangeiro, selecione “Estrangeiro” em Tipo da Pessoa.';
}
// Only a CPF/CNPJ (or a parent CPF) that is new or changed, or a CPF/CNPJ whose person type changed, can warn (as in SQL).
// Shared with the Vendedor form, which saves the same contact fields.
export const contactNeedsCheck = (data: Record<string, unknown>, record: ContactRecord | null) => WARNING_KEYS.some(key => Boolean(data[key]) && data[key] !== (record?.[key] ?? null))
  || (Boolean(data.document) && (data.person_type ?? null) !== (record?.person_type ?? null) && Boolean(record));

export function useContactSave(controller: AccessController, record: ContactRecord | null, onSaved: (record: ContactRecord) => void) {
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [error, setErrorText] = useState(''), [errorField, setErrorField] = useState<string | null>(null);
  // A specific refusal (onda C) names the field: the form highlights it. Any new message clears the highlight.
  const setError = (message: string, field: string | null = null) => { setErrorText(message); setErrorField(field); };
  const [warnings, setWarnings] = useState<(Operation & { items: ContactWarning[] }) | null>(null);
  const pending = useRef<AbortController | null>(null), actor = useRef(controller.getSnapshot().membership?.user_id);
  const command = useRef<{ id: string; operation: Operation; savedId: string | null; uncertain: boolean } | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const sameUser = () => controller.getSnapshot().membership?.user_id === actor.current;
  const execute = async () => {
    if (!command.current || pending.current) return;
    const current = command.current, request = new AbortController(); pending.current = request; setBusy(true); setError('');
    let recheck: string[] | null = null;
    try {
      if (!current.savedId) {
        const result = await controller.catalog(current.operation.path, { method: current.operation.method, body: { ...current.operation.body, command_id: current.id }, signal: request.signal }) as { record?: ContactRecord };
        if (request.signal.aborted) return;
        if (!result.record?.id || (record && result.record.id !== record.id)) throw new AccessError(502);
        current.savedId = result.record.id;
      }
      const latest = await controller.catalog(`/v1/cadastros/contatos/${current.savedId}`, { signal: request.signal }) as { record?: ContactRecord };
      if (request.signal.aborted || !sameUser()) return;
      if (latest.record?.id !== current.savedId) throw new AccessError(502);
      command.current = null; setUncertain(false); onSaved(latest.record);
    } catch (failure) {
      if (request.signal.aborted || aborted(failure)) return;
      const known = !current.uncertain && !current.savedId && failure instanceof AccessError && [400, 403, 404, 409].includes(failure.status);
      if (!known) current.uncertain = true;
      setUncertain(!known);
      setError(known ? contactRefusalText(failure) ?? ((failure as AccessError).status === 409 && !record ? 'Este CPF/CNPJ já está cadastrado e as Preferências não permitem CPF / CNPJ duplicado.' : errorText(failure))
        : current.savedId ? 'O cadastro foi salvo, mas a versão atual não pôde ser consultada. Use “Conferir resultado” antes de editar novamente.' : 'Não foi possível confirmar o resultado. Use “Conferir resultado” para repetir a mesma operação sem duplicar o cadastro.',
        known ? refusalField(failure) : null);
      if (known) {
        command.current = null;
        if ((failure as AccessError).status === 409 && Array.isArray(current.operation.body.acknowledged_warnings)) recheck = current.operation.body.acknowledged_warnings as string[];
      }
    } finally { if (!request.signal.aborted) { pending.current = null; setBusy(false); } }
    if (recheck && !request.signal.aborted) { const body = { ...current.operation.body }; delete body.acknowledged_warnings; void verify({ ...current.operation, body }, recheck); }
  };
  const start = (operation: Operation) => { if (pending.current) return; command.current = { id: crypto.randomUUID(), operation, savedId: null, uncertain: false }; void execute(); };
  const verify = async (operation: Operation, acknowledged: string[] | null = null) => {
    if (pending.current) return;
    const request = new AbortController(); pending.current = request; setBusy(true); setWarnings(null); if (!acknowledged) setError('');
    let found: ContactWarning[] | null = null;
    try {
      const result = await controller.catalog('/v1/cadastros/contatos/conferir', { method: 'POST', body: { id: record?.id ?? null, data: operation.body.data }, signal: request.signal }) as { warnings?: ContactWarning[] };
      if (!Array.isArray(result.warnings)) throw new AccessError(502);
      found = result.warnings;
    } catch (failure) {
      if (!request.signal.aborted && !aborted(failure)) setError(failure instanceof AccessError && [400, 403, 404].includes(failure.status) ? contactRefusalText(failure) ?? errorText(failure) : 'Não foi possível conferir os avisos do cadastro. Nada foi gravado; tente novamente.', refusalField(failure));
    } finally { if (!request.signal.aborted) { pending.current = null; setBusy(false); } }
    if (request.signal.aborted || !found || !sameUser()) return;
    if (acknowledged) {
      if (found.every(item => acknowledged.includes(item.code))) { setError(CONFLICT_TEXT); return; }
      setError('Surgiu um novo aviso desde a conferência. Revise-o antes de salvar.');
    }
    if (found.length) { setWarnings({ ...operation, items: found }); return; }
    start({ ...operation, body: { ...operation.body, acknowledged_warnings: [] } });
  };
  /** Saves `data` (the whole form). The check runs only when a CPF/CNPJ or a parent CPF is new or changed. */
  const save = (data: Record<string, unknown>) => {
    if (busy || uncertain || pending.current) return;
    const operation: Operation = { path: `/v1/cadastros/contatos${record ? `/${record.id}` : ''}`, method: record ? 'PATCH' : 'POST', body: { data, ...(record ? { expected_version: record.version } : {}) } };
    setWarnings(null);
    if (contactNeedsCheck(data, record)) void verify(operation); else start(operation);
  };
  const confirm = () => {
    if (!warnings || busy || uncertain || warnings.items.some(item => item.blocked)) return;
    const { items, ...operation } = warnings; setWarnings(null); start({ ...operation, body: { ...operation.body, acknowledged_warnings: items.map(item => item.code) } });
  };
  return { busy, uncertain, error, errorField, setError, warnings, setWarnings, save, confirm, execute };
}
