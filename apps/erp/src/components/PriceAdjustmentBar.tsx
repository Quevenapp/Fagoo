import { useEffect, useRef, useState } from 'react';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { AccessError, decimalMoney, type AccessController } from '../lib/real-access';
import { Icon } from './Icon';
import { Modal } from './Modal';
import { aborted, errorText, knownFailure } from './catalog-shared';
import './product-registry.css';

// "Reajuste e sincronização de preços" da listagem de produtos (Origin): barra fixa no rodapé com Ação (Acrescer | Descontar |
// Fixar), Valor com a unidade R$/% e "Aplicar para" Produtos filtrados | Produtos selecionados; a coluna "Novo Preço" mostra a
// prévia calculada no banco (migração 155) e "Atualizar produtos" grava num comando com "Conferir resultado". "Copiar" (preço
// de canal) e "Sincronizar com loja virtual" dependem de lojas e não fazem parte do Brufap.
export type AdjustRule = { action: 'increase' | 'discount' | 'fix'; unit: 'amount' | 'percent'; value: string };
export type PreviewEntry = { price: string | null; status: 'ok' | 'unchanged' | 'no_price' | 'negative' | 'too_large' | 'deleted'; new_price: string | null };
type Item = { id: string; version: number; name: string };
type Operation = { command: string; body: Record<string, unknown>; label: string; uncertain: boolean; busy: boolean };
const VALUE = /^(0|[1-9]\d{0,12})(?:[.,]\d{1,4})?$/;
export const ruleValue = (rule: AdjustRule) => VALUE.test(rule.value.trim()) ? rule.value.trim().replace(',', '.') : null;
const REASON: Record<string, string> = { negative: 'ficaria negativo', no_price: 'sem preço de venda', too_large: 'acima do limite de preço', deleted: 'excluído', conflict: 'alterado por outra operação', not_found: 'não encontrado' };
export const STATUS_TEXT: Record<PreviewEntry['status'], string> = { ok: '', unchanged: 'Sem alteração', no_price: 'Sem preço', negative: 'Ficaria negativo', too_large: 'Acima do limite', deleted: 'Excluído' };

export function usePriceAdjustment(controller: AccessController, items: readonly Item[], enabled: boolean) {
  const [open, setOpen] = useState(false), [rule, setRule] = useState<AdjustRule>({ action: 'increase', unit: 'percent', value: '' }), [target, setTarget] = useState<'filtered' | 'selected'>('filtered');
  const [preview, setPreview] = useState<{ key: string; items: Map<string, PreviewEntry> } | null>(null), [previewError, setPreviewError] = useState('');
  const [operation, setOperation] = useState<Operation | null>(null), [confirm, setConfirm] = useState<{ body: Record<string, unknown>; label: string } | null>(null), [error, setError] = useState('');
  const send = useRef<AbortController | null>(null), actor = useRef<string | undefined>(undefined);
  useUnsavedChanges(Boolean(operation?.uncertain), Boolean(operation?.busy || operation?.uncertain));
  useEffect(() => () => send.current?.abort(), []);
  const value = ruleValue(rule), ids = items.map(item => item.id), key = JSON.stringify([rule.action, rule.action === 'fix' ? 'amount' : rule.unit, value, ids]);
  // "Novo Preço": the visible page, calculated by the database (same rounding as the apply); a late answer of another rule is ignored.
  useEffect(() => {
    if (!enabled || !open || value === null || !ids.length) return;
    const request = new AbortController();
    const timer = setTimeout(() => void Promise.resolve().then(() => controller.catalog('/v1/cadastros/products/reajuste/previa', { method: 'POST', body: { rule: { action: rule.action, unit: rule.action === 'fix' ? 'amount' : rule.unit, value }, ids }, signal: request.signal })).then(result => {
      const rows = (result as { items?: (PreviewEntry & { id: string })[] }).items;
      if (request.signal.aborted) return;
      if (!Array.isArray(rows)) throw new AccessError(502);
      setPreview({ key, items: new Map(rows.map(row => [row.id, { price: row.price, status: row.status, new_price: row.new_price }])) }); setPreviewError('');
    }).catch(failure => { if (!request.signal.aborted && !aborted(failure)) setPreviewError('Não foi possível calcular a prévia do novo preço.'); }), 300);
    return () => { clearTimeout(timer); request.abort(); };
  }, [controller, enabled, open, key]);
  const run = async (current: Operation, onDone: (text: string) => void) => {
    if (send.current) return;
    const request = new AbortController(); send.current = request; setOperation({ ...current, busy: true }); setError('');
    try {
      const result = await controller.catalog('/v1/cadastros/products/reajuste', { method: 'POST', body: { command_id: current.command, ...current.body }, signal: request.signal }) as { applied?: number; unchanged?: number; skipped_total?: number; skipped?: { name: string | null; reason: string }[]; replayed?: boolean };
      if (request.signal.aborted || controller.getSnapshot().membership?.user_id !== actor.current) return;
      if (!Number.isInteger(result.applied)) throw new AccessError(502);
      const skipped = result.skipped ?? [];
      const reasons = [...new Set(skipped.map(item => REASON[item.reason] ?? item.reason))].join(', ');
      setOperation(null); setOpen(false); setPreview(null); setRule(previous => ({ ...previous, value: '' }));
      onDone(`Reajuste de preços${result.replayed ? ' (comando já registrado)' : ''}: ${result.applied} produto(s) atualizado(s)${result.unchanged ? `, ${result.unchanged} sem alteração` : ''}${result.skipped_total ? `, ${result.skipped_total} não alterado(s) (${reasons})` : ''}.`);
    } catch (failure) {
      if (request.signal.aborted) return;
      const known = !current.uncertain && !aborted(failure) && knownFailure(failure);
      setOperation(known ? null : { ...current, uncertain: true, busy: false });
      setError(known ? failure instanceof AccessError && failure.status === 400 ? 'Confira a regra e os filtros (até 5.000 produtos filtrados por reajuste).' : errorText(failure)
        : 'Não foi possível confirmar o reajuste. Use “Conferir resultado” para repetir a mesma operação sem duplicar.');
    } finally { if (send.current === request) send.current = null; }
  };
  /** Opens the confirmation; `filters` are the v2 list filters (Produtos filtrados), `selected` the chosen rows. */
  const prepare = (selected: readonly Item[], filters: AdjustFilters, total: number) => {
    if (value === null) { setError('Informe o valor do reajuste com até quatro casas decimais, sem separador de milhares.'); return; }
    const body = { rule: { action: rule.action, unit: rule.action === 'fix' ? 'amount' : rule.unit, value }, ...(target === 'selected' ? { items: selected.map(item => ({ id: item.id, expected_version: item.version })) } : { filters }) };
    const count = target === 'selected' ? selected.length : total;
    if (!count) { setError(target === 'selected' ? 'Selecione os produtos na listagem.' : 'Nenhum produto nos filtros aplicados.'); return; }
    if (target === 'filtered' && total > 5000) { setError('O reajuste vale para até 5.000 produtos filtrados. Refine os filtros.'); return; }
    setError(''); setConfirm({ body, label: `${count} produto(s) ${target === 'selected' ? 'selecionado(s)' : 'filtrado(s)'}` });
  };
  const start = (onDone: (text: string) => void) => { if (!confirm) return; actor.current = controller.getSnapshot().membership?.user_id; const current = { command: crypto.randomUUID(), body: confirm.body, label: confirm.label, uncertain: false, busy: false }; setConfirm(null); void run(current, onDone); };
  const close = () => { if (operation) return; setOpen(false); setPreview(null); setError(''); setConfirm(null); };
  const entries = preview && preview.key === key ? preview.items : null;
  return { open, setOpen, rule, setRule, target, setTarget, entries, previewError, operation, confirm, setConfirm, error, prepare, start, close, retry: (onDone: (text: string) => void) => operation && void run(operation, onDone), value };
}
export type PriceAdjustment = ReturnType<typeof usePriceAdjustment>;

/** "Novo Preço" cell of a row while the bar is open. */
export function NewPriceCell({ entry }: { entry: PreviewEntry | undefined }) {
  if (!entry) return <span className="real-help">—</span>;
  return entry.status === 'ok' ? <strong>{decimalMoney(entry.new_price)}</strong> : <span className="real-help" title={STATUS_TEXT[entry.status]}>{entry.status === 'unchanged' ? decimalMoney(entry.new_price) : STATUS_TEXT[entry.status]}</span>;
}

/** The v2 list filters as text, plus the "Campos customizados" list (migration 191). */
export type AdjustFilters = Record<string, string | readonly { field_id: string; value?: string; from?: string; to?: string }[]>;
export function PriceAdjustmentBar({ adjust, selected, filters, total, onDone }: { adjust: PriceAdjustment; selected: readonly Item[]; filters: AdjustFilters; total: number; onDone: (text: string) => void }) {
  const { rule, setRule, target, setTarget, operation } = adjust;
  const locked = Boolean(operation);
  return <>
    <section className="price-adjust-bar" role="region" aria-label="Reajuste de preços">
      <strong>Reajuste de preços</strong>
      <div className="form-field"><label htmlFor="price-adjust-action">Ação</label><select id="price-adjust-action" value={rule.action} disabled={locked} onChange={event => setRule({ ...rule, action: event.target.value as AdjustRule['action'] })}>
        <option value="increase">Acrescer</option><option value="discount">Descontar</option><option value="fix">Fixar</option></select></div>
      <div className="form-field"><label htmlFor="price-adjust-value">Valor</label><span className="product-inline"><input id="price-adjust-value" value={rule.value} inputMode="decimal" maxLength={18} disabled={locked} aria-invalid={Boolean(rule.value) && adjust.value === null || undefined} onChange={event => setRule({ ...rule, value: event.target.value })} />
        <button type="button" className="secondary-button" title="Clique aqui para trocar a unidade do valor" aria-label={`Unidade do valor: ${rule.action === 'fix' || rule.unit === 'amount' ? 'R$' : '%'}`} disabled={locked || rule.action === 'fix'}
          onClick={() => setRule({ ...rule, unit: rule.unit === 'percent' ? 'amount' : 'percent' })}>{rule.action === 'fix' || rule.unit === 'amount' ? 'R$' : '%'}</button></span></div>
      <fieldset className="form-field" disabled={locked}><legend>Aplicar para</legend>
        <label className="product-check"><input type="radio" name="price-adjust-target" checked={target === 'filtered'} onChange={() => setTarget('filtered')} />Produtos filtrados({total})</label>
        <label className="product-check"><input type="radio" name="price-adjust-target" checked={target === 'selected'} onChange={() => setTarget('selected')} />Produtos selecionados({selected.length})</label></fieldset>
      {operation?.uncertain ? <button type="button" className="primary-button" disabled={operation.busy} onClick={() => adjust.retry(onDone)}>{operation.busy ? 'Conferindo…' : 'Conferir resultado'}</button>
        : <button type="button" className="primary-button" disabled={locked || adjust.value === null} onClick={() => adjust.prepare(selected, filters, total)}>{operation?.busy ? 'Atualizando…' : 'Atualizar produtos'}</button>}
      <button type="button" className="icon-button" title="Fechar" aria-label="Fechar o reajuste de preços" disabled={locked} onClick={adjust.close}><Icon name="xmark" size={12} /></button>
      {(adjust.error || adjust.previewError) && <p className="real-alert" role="alert">{adjust.error || adjust.previewError}</p>}
      <small className="real-help">Percentual arredonda o novo preço a duas casas; R$ e Fixar são exatos. A coluna Novo Preço mostra a prévia desta página.</small>
    </section>
    {adjust.confirm && <Modal title="Reajuste de preços" onClose={() => adjust.setConfirm(null)} actions={<><button type="button" className="secondary-button" onClick={() => adjust.setConfirm(null)}>Cancelar</button><button type="button" className="primary-button" onClick={() => adjust.start(onDone)}>Atualizar produtos</button></>}>
      <p>{({ increase: 'Acrescer', discount: 'Descontar', fix: 'Fixar' } as const)[rule.action]} {rule.action === 'fix' || rule.unit === 'amount' ? `R$ ${rule.value}` : `${rule.value}%`} no preço de venda de {adjust.confirm.label}.</p>
      <p className="real-help">Cada produto alterado ganha nova versão e fica na auditoria. Produtos excluídos, sem preço (para acrescer ou descontar) ou que ficariam com preço negativo não são alterados.</p>
    </Modal>}
  </>;
}
