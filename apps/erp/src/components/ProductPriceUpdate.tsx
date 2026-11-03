import { useEffect, useRef, useState } from 'react';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { AccessError, type AccessController } from '../lib/real-access';
import { normalizeUnitPrice } from '../../../../packages/erp-domain/src/unit-price.mjs';
import { Modal } from './Modal';
import { aborted, errorText, knownFailure } from './catalog-shared';

// "Atualizar preços" da Formação de preços (nota de entrada): grava no cadastro de produtos (migração 155) o preço de venda
// sugerido e o preço de custo da nota no fornecedor da nota, com a versão de cada produto lida antes, num único comando com
// "Conferir resultado". Só para quem grava produtos; itens sem produto do cadastro ficam de fora.
export type PriceLine = { product_id: string | null; description: string; cost: string; sale: string | null };
type Info = { product_id: string; version: number; name: string; deleted: boolean };
type Operation = { command: string; body: Record<string, unknown>; count: number; uncertain: boolean; busy: boolean };
const canonical = (value: string) => { try { return normalizeUnitPrice(value, 14); } catch { return null; } };

// Notas lane (wave E): onPendingChange lets the Formação de preços stay open while the update waits ('busy') or needs "Conferir
// resultado" ('uncertain'); onUpdated hands the confirmed command to the note so it records the "P" Preços atualizados.
export function UpdatePricesButton({ controller, supplierId, lines, onPendingChange, onUpdated }: { controller: AccessController; supplierId: string | null; lines: readonly PriceLine[];
  onPendingChange?: (state: 'busy' | 'uncertain' | null) => void; onUpdated?: (commandId: string, count: number) => void }) {
  const [writable, setWritable] = useState<boolean | null>(null), [confirm, setConfirm] = useState(false), [operation, setOperation] = useState<Operation | null>(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const request = useRef<AbortController | null>(null), actor = useRef(controller.getSnapshot().membership?.user_id);
  useUnsavedChanges(Boolean(operation?.uncertain), Boolean(operation?.busy || operation?.uncertain));
  const pending = operation?.busy ? 'busy' : operation?.uncertain ? 'uncertain' : null, pendingRef = useRef(onPendingChange);
  pendingRef.current = onPendingChange;
  useEffect(() => { pendingRef.current?.(pending); }, [pending]);
  useEffect(() => {
    const signal = new AbortController();
    void Promise.resolve().then(() => controller.catalog('/v1/cadastros', { signal: signal.signal })).then(value => { if (!signal.signal.aborted) setWritable(Array.isArray((value as { write?: unknown }).write) && ((value as { write: string[] }).write).includes('products')); })
      .catch(() => { if (!signal.signal.aborted) setWritable(false); });
    return () => { signal.abort(); request.current?.abort(); };
  }, [controller]);
  // One line per product (the first one); a line without a product of the cadastro or without a sale price is left out.
  const eligible = lines.filter((line, index) => line.product_id && line.sale !== null && canonical(line.sale) && canonical(line.cost) && lines.findIndex(other => other.product_id === line.product_id) === index);
  const repeated = lines.filter((line, index) => line.product_id && lines.findIndex(other => other.product_id === line.product_id) !== index).length;
  const send = async (current: Operation) => {
    if (request.current) return;
    const signal = new AbortController(); request.current = signal; setOperation({ ...current, busy: true }); setError(''); setNotice('');
    try {
      const result = await controller.catalog('/v1/cadastros/products/precos', { method: 'POST', body: { command_id: current.command, ...current.body }, signal: signal.signal }) as { items?: unknown[]; replayed?: boolean };
      if (signal.signal.aborted || controller.getSnapshot().membership?.user_id !== actor.current) return;
      if (!Array.isArray(result.items) || result.items.length !== current.count) throw new AccessError(502);
      setOperation(null); setNotice(`Preços atualizados em ${current.count} produto(s)${result.replayed ? ' (comando já registrado)' : ''}.`);
      onUpdated?.(current.command, current.count);
    } catch (failure) {
      if (signal.signal.aborted) return;
      const known = !current.uncertain && !aborted(failure) && knownFailure(failure);
      setOperation(known ? null : { ...current, uncertain: true, busy: false });
      setError(known ? failure instanceof AccessError && failure.status === 409 ? 'Algum produto foi alterado por outra operação ou está excluído; nada foi gravado. Tente de novo.' : errorText(failure)
        : 'Não foi possível confirmar a atualização. Use “Conferir resultado” para repetir a mesma operação sem duplicar.');
    } finally { if (request.current === signal) request.current = null; }
  };
  const start = async () => {
    setConfirm(false); if (!eligible.length || request.current) return;
    const signal = new AbortController(); request.current = signal; setError(''); setNotice('');
    let infos: Info[];
    try {
      const params = new URLSearchParams({ ids: eligible.map(line => line.product_id!).join(','), ...(supplierId ? { fornecedor: supplierId } : {}) });
      const value = await controller.catalog(`/v1/cadastros/products/compras?${params}`, { signal: signal.signal }) as { items?: Info[] };
      if (signal.signal.aborted) return;
      if (!Array.isArray(value.items)) throw new AccessError(502);
      infos = value.items;
    } catch (failure) { if (!signal.signal.aborted && !aborted(failure)) setError(errorText(failure)); return; }
    finally { if (request.current === signal) request.current = null; }
    const items = eligible.map(line => ({ line, info: infos.find(info => info.product_id === line.product_id) })).filter(entry => entry.info && !entry.info.deleted)
      .map(({ line, info }) => ({ product_id: info!.product_id, expected_version: info!.version, price: canonical(line.sale!)!, ...(supplierId ? { cost_price: canonical(line.cost)! } : {}) }));
    if (!items.length) { setError('Nenhum produto da nota pode ser atualizado (produtos excluídos ou fora do cadastro).'); return; }
    actor.current = controller.getSnapshot().membership?.user_id;
    void send({ command: crypto.randomUUID(), body: { supplier_id: supplierId, items }, count: items.length, uncertain: false, busy: false });
  };
  const reason = writable === null ? 'Conferindo a permissão…' : !writable ? 'Seu perfil não altera o cadastro de produtos.' : !eligible.length ? 'Nenhum item da nota tem produto do cadastro com preço de venda calculado.' : undefined;
  return <>
    {operation?.uncertain ? <button type="button" className="primary-button" disabled={operation.busy} onClick={() => void send(operation)}>{operation.busy ? 'Conferindo…' : 'Conferir resultado'}</button>
      : <button type="button" className="primary-button" disabled={Boolean(reason) || Boolean(operation?.busy)} title={reason} onClick={() => setConfirm(true)}>{operation?.busy ? 'Atualizando…' : 'Atualizar preços'}</button>}
    {(error || notice) && <p className={error ? 'real-alert' : 'real-success'} role={error ? 'alert' : 'status'}>{error || notice}</p>}
    {confirm && <Modal title="Atualizar preços" onClose={() => setConfirm(false)} actions={<><button type="button" className="secondary-button" onClick={() => setConfirm(false)}>Cancelar</button><button type="button" className="primary-button" onClick={() => void start()}>Atualizar preços</button></>}>
      <p>Gravar no cadastro o preço de venda de {eligible.length} produto(s){supplierId ? ' e o preço de custo no fornecedor da nota' : ''}.</p>
      {repeated > 0 && <p className="real-help">Produtos repetidos na nota usam a primeira linha ({repeated} linha(s) a mais ignorada(s)).</p>}
      <p className="real-help">Cada produto ganha nova versão e fica na auditoria. Se algum produto for alterado por outra operação no meio, nada é gravado.</p>
    </Modal>}
  </>;
}
