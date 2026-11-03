import { Icon } from './Icon';
import type { DemoLineItem } from '../types';
import { newDemoId } from '../hooks/useDemoStore';
import { itemTotal, itemsTotal, netUnitPrice } from '../lib/document-model';

export const money = (value: unknown) => Number.isFinite(Number(value)) ? new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(value)) : '—';

export function LineItemsEditor({ items, onChange, products }: { items: DemoLineItem[]; onChange: (items: DemoLineItem[]) => void; products: string[] }) {
  const update = (id: string, key: string, value: string | number) => onChange(items.map(item => {
    if (item.id !== id) return item;
    const next = { ...item, listPrice: item.listPrice ?? item.unitPrice, [key]: value };
    return { ...next, unitPrice: netUnitPrice(next) };
  }));
  return <section className="form-section item-editor">
    <div className="section-heading"><h2>Itens</h2><span className="muted">Preço unitário calculado a partir do preço de lista e desconto.</span></div>
    <datalist id="demo-product-options">{products.map(product => <option key={product} value={product} />)}</datalist>
    <div className="table-scroll"><table className="data-table"><thead><tr><th>Item</th><th>Código</th><th>Un.</th><th>Qtde.</th><th>Preço lista</th><th>Desc. (%)</th><th>Preço un.</th><th>Preço total</th><th aria-label="Remover item" /></tr></thead>
      <tbody>{items.map((item, index) => <tr key={item.id}>
        <td><input aria-label={`Descrição do item ${index + 1}`} list="demo-product-options" value={item.description} onChange={event => update(item.id, 'description', event.target.value)} required /></td>
        <td><input aria-label={`Código do item ${index + 1}`} value={item.sku || ''} onChange={event => update(item.id, 'sku', event.target.value)} /></td>
        <td><input aria-label={`Unidade do item ${index + 1}`} value={item.unit} onChange={event => update(item.id, 'unit', event.target.value)} required /></td>
        <td><input aria-label={`Quantidade do item ${index + 1}`} type="number" min="0.001" step="any" value={item.quantity} onChange={event => update(item.id, 'quantity', Number(event.target.value))} required /></td>
        <td><input aria-label={`Preço de lista do item ${index + 1}`} type="number" min="0" step="0.01" value={item.listPrice ?? item.unitPrice} onChange={event => update(item.id, 'listPrice', Number(event.target.value))} /></td>
        <td><input aria-label={`Desconto percentual do item ${index + 1}`} type="number" min="0" max="100" step="0.01" value={item.discount} onChange={event => update(item.id, 'discount', Number(event.target.value))} /></td>
        <td><input aria-label={`Preço unitário líquido do item ${index + 1}`} value={money(netUnitPrice(item))} readOnly /></td>
        <td className="numeric">{money(itemTotal(item))}</td>
        <td><button type="button" className="icon-button" aria-label={`Remover item ${index + 1}`} onClick={() => onChange(items.filter(row => row.id !== item.id))}><Icon name="close" size={16} /></button></td>
      </tr>)}</tbody></table></div>
    <div className="table-footer"><button className="secondary-button" type="button" onClick={() => onChange([...items, { id: newDemoId(), description: '', quantity: 1, unit: 'UN', listPrice: 0, unitPrice: 0, discount: 0 }])}><Icon name="plus" size={16} /> Adicionar item</button><div className="document-total"><span>Total dos itens</span><strong>{money(itemsTotal(items))}</strong></div></div>
  </section>;
}
