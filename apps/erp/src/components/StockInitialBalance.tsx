import { useEffect } from 'react';
import type { AccessController } from '../lib/real-access';
import { selectableWarehouses, type InitialBalanceDraft } from '../lib/stock-supply-model';
export { EMPTY_INITIAL_BALANCE, initialBalanceAllowed, initialBalancePayload, type InitialBalanceDraft } from '../lib/stock-supply-model';
import { useStockWarehouseOptions } from './StockSupplierPicker';

/** "Saldo inicial" of Origin (aba Estoque, only when a product is included): Depósito (padrão: o depósito padrão), Quantidade, Preço de
 * compra unitário, Custo de compra Un e Observações do saldo inicial. The product and the entry are saved by one command (183). */
export function StockInitialBalanceFields({ controller, value, onChange, disabled, unit }: { controller: Pick<AccessController, 'stock' | 'getSnapshot'>; value: InitialBalanceDraft;
  onChange: (value: InitialBalanceDraft) => void; disabled?: boolean; unit?: string }) {
  const role = controller.getSnapshot().membership?.role, writer = role === 'admin' || role === 'estoque';
  const warehouses = useStockWarehouseOptions(controller, writer);
  // Origin opens the block on the default warehouse ("Geral").
  useEffect(() => { if (!value.warehouse && warehouses.loaded) { const standard = warehouses.options.find(item => item.is_default && item.active); if (standard) onChange({ ...value, warehouse: standard.id }); } }, [warehouses.loaded]);
  if (!writer) return null;
  const set = (patch: Partial<InitialBalanceDraft>) => onChange({ ...value, ...patch });
  return <fieldset disabled={disabled} className="real-editor-fields"><legend>Saldo inicial</legend>
    <div className="form-field"><label htmlFor="product-initial-warehouse">Depósito</label><select id="product-initial-warehouse" value={value.warehouse} onChange={event => set({ warehouse: event.target.value })}><option value="">Selecione</option>{selectableWarehouses(warehouses.options, value.warehouse).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
    <div className="form-field"><label htmlFor="product-initial-quantity">Quantidade{unit ? ` (${unit})` : ''}</label><input id="product-initial-quantity" inputMode="decimal" maxLength={20} value={value.quantity} onChange={event => set({ quantity: event.target.value })} /></div>
    <div className="form-field"><label htmlFor="product-initial-price">Preço de compra unitário</label><input id="product-initial-price" inputMode="decimal" maxLength={26} value={value.price} onChange={event => set({ price: event.target.value })} /></div>
    <div className="form-field"><label htmlFor="product-initial-cost">Custo de compra Un</label><input id="product-initial-cost" inputMode="decimal" maxLength={26} value={value.cost} onChange={event => set({ cost: event.target.value })} /></div>
    <div className="form-field real-field-wide"><label htmlFor="product-initial-note">Observações do saldo inicial</label><input id="product-initial-note" maxLength={500} value={value.note} onChange={event => set({ note: event.target.value })} /></div>
    {warehouses.error && <p className="real-alert" role="alert">{warehouses.error}</p>}
    <p className="real-help real-field-wide">Só existe na inclusão. Com uma quantidade, o produto e a entrada de estoque são gravados juntos; se a entrada for recusada, o produto também não é criado.</p>
  </fieldset>;
}
