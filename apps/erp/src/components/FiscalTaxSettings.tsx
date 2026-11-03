import { useEffect, useRef, useState } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { normalizeTaxSettings, type TaxSettingsValues } from '../../../../packages/erp-domain/src/fiscal-invoice-contract.mjs';
import { DIFAL_STATE_MODES, UFS } from '../../../../packages/erp-domain/src/fiscal-invoice-dto.mjs';
import { DIFAL_MODE, DIFAL_STATE_MODE } from '../../../../packages/fiscal-core/src/tax-tables.mjs';
import { FISCAL_BASE } from '../lib/fiscal-invoice-list-model';

const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const actorOf = (controller: AccessController) => controller.getSnapshot?.()?.membership?.user_id ?? null;
const roleOf = (controller: AccessController) => controller.getSnapshot?.()?.membership?.role ?? '';
type Saved = { settings: TaxSettingsValues; difal_by_state: Record<string, string>; version: number; writable: boolean };
const TOGGLES: readonly [keyof TaxSettingsValues, string][] = [['exclude_icms_pis_cofins', 'Excluir ICMS da base de cálculo do PIS/COFINS'], ['exclude_icms_st_pis_cofins', 'Excluir ICMS ST da base de cálculo do PIS/COFINS'],
  ['st_contributor_differentiated', 'Utilizar cálculo diferenciado de Substituição Tributária de consumidores contribuintes'], ['st_retained_from_sale', 'Calcular a base de cálculo do ICMS ST retido de acordo com os dados da venda'],
  ['ipi_in_icms_import', 'Somar IPI na base de cálculo do ICMS nas notas de importação']];
// packages/fiscal-core/src/tax-engine.mjs reads only the two PIS/COFINS exclusions; the others are stored for a later engine.
// What the automatic calculation follows (packages/fiscal-core/src/tax-engine.mjs); the differentiated ST for contributors is only kept.
const NOT_APPLIED: readonly (keyof TaxSettingsValues)[] = ['st_contributor_differentiated'];
const APPLIED_NOTES: Partial<Record<keyof TaxSettingsValues, string>> = {
  st_retained_from_sale: 'Aplicada no cálculo automático: nas situações 60 e 500, a base e o valor do ICMS ST retido saem dos dados da venda e da regra da natureza.',
  ipi_in_icms_import: 'Aplicada no cálculo automático das notas de importação: o IPI entra na base do ICMS.',
};

/** Configurações globais de impostos, com versão: duas telas abertas não sobrescrevem uma à outra. */
export default function FiscalTaxSettings({ controller, onBack }: { controller: AccessController; onBack: () => void }) {
  const [saved, setSaved] = useState<Saved | null>(null), [draft, setDraft] = useState<Pick<Saved, 'settings' | 'difal_by_state'> | null>(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [reload, setReload] = useState(0);
  const command = useRef<{ id: string; actor: string | null; body: Record<string, unknown>; uncertain: boolean } | null>(null), inflight = useRef<AbortController | null>(null);
  const dirty = Boolean(saved && draft && JSON.stringify(draft) !== JSON.stringify({ settings: saved.settings, difal_by_state: saved.difal_by_state }));
  const guard = useUnsavedChanges(dirty || uncertain, busy);
  const writable = Boolean(saved?.writable) && ['admin', 'fiscal'].includes(roleOf(controller));
  useEffect(() => {
    const request = new AbortController();
    void Promise.resolve().then(() => controller.fiscalInvoices(`${FISCAL_BASE}/impostos`, { signal: request.signal })).then(value => {
      if (request.signal.aborted) return;
      const v = value as Saved; const normalized = normalizeTaxSettings(v?.settings, v?.difal_by_state);
      if (!Number.isInteger(v?.version) || typeof v.writable !== 'boolean') throw new AccessError(502);
      const next = { ...normalized, version: v.version, writable: v.writable }; setSaved(next); setDraft({ settings: next.settings, difal_by_state: next.difal_by_state });
    }).catch(problem => { if (!request.signal.aborted && !aborted(problem)) setError('Não foi possível carregar as configurações de impostos.'); });
    return () => { request.abort(); inflight.current?.abort(); };
  }, [controller, reload]);
  if (!saved || !draft) return <section className="real-state-panel" role="status"><h1>Configurações globais de impostos</h1><p>{error || 'Carregando…'}</p><button type="button" className="secondary-button" onClick={onBack}>Voltar</button></section>;
  const send = async () => {
    const op = command.current; if (!op || inflight.current) return;
    if (actorOf(controller) !== op.actor || !['admin', 'fiscal'].includes(roleOf(controller))) { command.current = null; setUncertain(false); setError('A sessão ou o perfil mudou. Recarregue antes de salvar.'); return; }
    const request = new AbortController(); inflight.current = request; setBusy(true); setError('');
    try {
      const value = await controller.fiscalInvoices(`${FISCAL_BASE}/impostos`, { method: 'POST', body: { ...op.body, command_id: op.id }, signal: request.signal }) as Saved;
      if (request.signal.aborted) return;
      const normalized = normalizeTaxSettings(value?.settings, value?.difal_by_state);
      if (value?.version !== saved.version + 1) throw new AccessError(502);
      command.current = null; setUncertain(false);
      const next = { ...normalized, version: value.version, writable: true }; setSaved(next); setDraft({ settings: next.settings, difal_by_state: next.difal_by_state }); setNotice('Configurações salvas.');
    } catch (problem) {
      if (request.signal.aborted || aborted(problem)) return;
      if (!op.uncertain && problem instanceof AccessError && [400, 403, 409].includes(problem.status)) { command.current = null; setError(problem.status === 409 ? 'As configurações mudaram em outra tela. Recarregue e confira.' : problem.status === 403 ? 'Seu perfil não altera as configurações de impostos.' : 'O servidor recusou as configurações.'); }
      else { op.uncertain = true; setUncertain(true); setError('Não foi possível confirmar se as configurações foram salvas. Use "Conferir resultado".'); }
    } finally { if (inflight.current === request) inflight.current = null; if (!request.signal.aborted) setBusy(false); }
  };
  const save = () => { if (command.current || !writable) return; command.current = { id: crypto.randomUUID(), actor: actorOf(controller), body: { expected_version: saved.version, settings: draft.settings, difal_by_state: draft.difal_by_state }, uncertain: false }; setNotice(''); void send(); };
  const locked = !writable || busy || uncertain;
  return <section className="fiscal-tax-settings">
    <header className="real-heading"><div><h1>Configurações globais de impostos</h1><p>Usadas pelo cálculo automático das notas fiscais. Versão {saved.version}.</p></div>
      <div className="real-editor-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => guard.confirmLeave(onBack)}>Voltar</button>
        {uncertain ? <button type="button" className="primary-button" disabled={busy} onClick={() => void send()}>Conferir resultado</button> : <button type="button" className="primary-button" disabled={locked || !dirty} onClick={save}>{busy ? 'Salvando…' : 'Salvar'}</button>}</div></header>
    {!writable && <p className="real-notice">Seu perfil permite apenas consultar estas configurações.</p>}
    {error && <p className="real-alert" role="alert">{error}{!uncertain && <button type="button" className="text-button" onClick={() => setReload(n => n + 1)}>Recarregar</button>}</p>}{notice && <p className="real-success" role="status">{notice}</p>}
    {TOGGLES.map(([key, label]) => <div className="form-field" key={key}><label htmlFor={`tax-${key}`}><input id={`tax-${key}`} type="checkbox" disabled={locked} checked={draft.settings[key] === true} onChange={event => setDraft(d => d && ({ ...d, settings: { ...d.settings, [key]: event.target.checked } }))} /> {label} · {draft.settings[key] ? 'Ativado' : 'Desativado'}</label>
      {NOT_APPLIED.includes(key) && <small className="real-help">O cálculo automático do FAGOO ainda não aplica esta configuração; ela fica registrada para ele.</small>}
      {APPLIED_NOTES[key] && <small className="real-help">{APPLIED_NOTES[key]}</small>}</div>)}
    <div className="form-field"><label htmlFor="tax-difal-default">Cálculo do ICMS DIFAL - Configuração padrão</label><select id="tax-difal-default" disabled={locked} value={draft.settings.difal_default} onChange={event => setDraft(d => d && ({ ...d, settings: { ...d.settings, difal_default: event.target.value } }))}>{DIFAL_MODE.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      <small className="real-help">Aplicada no cálculo automático para consumidor final não contribuinte de outra UF: "Com ICMS por dentro" (base dupla), "Somente valor da mercadoria" (base única), "Não calcular" e "Calcular apenas campos validados". As bases com exclusão do ICMS da tabela por UF (MT, PA, PB) ficam como digitadas no item.</small></div>
    <table className="data-table fiscal-difal"><thead><tr><th>UF</th><th>Forma de cálculo</th></tr></thead><tbody>{UFS.map(uf => <tr key={uf}><td>{uf}</td><td>
      <select aria-label={`Forma de cálculo do DIFAL em ${uf}`} disabled={locked} value={draft.difal_by_state[uf] ?? 'default'} onChange={event => setDraft(d => { if (!d) return d; const states = { ...d.difal_by_state }; if (event.target.value === 'default') delete states[uf]; else states[uf] = event.target.value; return { ...d, difal_by_state: states }; })}>
        {DIFAL_STATE_MODE.filter(([mode]) => DIFAL_STATE_MODES[mode]?.includes(uf)).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></td></tr>)}</tbody></table>
  </section>;
}
