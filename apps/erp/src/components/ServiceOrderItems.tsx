import { useState, type ReactNode } from 'react';
import type { DocumentItemInput, DocumentTotals } from '../lib/real-documents-model';
import type { OsLabel } from '../lib/document-preferences';
import { groupTotals, itemGroup, serviceItemLabel, type ServiceItemGroup } from '../lib/service-order-items';
import { decimalMoney } from '../lib/real-access';
import { compactDocumentDecimal, documentDecimalDisplay, documentDecimalInput, limitedDecimal } from '../lib/document-decimals';
import { Icon } from './Icon';

/**
 * 202610200268 Origin ordem de serviço: "Peças" (Descrição, Código, Qtd, UN, Preço lista, Desc %, Preço unitário, Preço total) and
 * "Serviços executados" (Descrição, Código, Horas, Preço lista, Desc %, Preço, Preço total, Orçar, OK), each with its own search and
 * "Adicionar outro item" / "Adicionar serviço", and Total peças / Total serviços. Every field keeps the id of the generic grid
 * (doc-item-*-<index of the item in the OS>), so the required-field highlights and messages are the same.
 * 202610200287/288: Garantia (dias) of each item, the casas decimais of the quantity (Preferências › Empresa) and the tabs
 * "Itens | Comissões" of each grid (Origin), the Comissões read-only.
 */
export function ServiceOrderItems({ items, totals, editable, labels, listPrice, discount, listPriceOf, priceTitle, priceMaxLength, invalidProps, onChange, onRemove, onSwap, onAddFree,
  freeItems, full, picker, lineTools, quantityPlaces = 6, commissions, warrantyEnd }: {
  items: DocumentItemInput[]; totals: DocumentTotals | null; editable: boolean; labels: Partial<Record<OsLabel, string>>;
  /** Preferências › Serviços "Exibir desconto e preço de lista dos itens" (an OS already carrying a discount keeps Desc %). */
  listPrice: boolean; discount: boolean; listPriceOf: (item: DocumentItemInput) => string | null; priceTitle: string; priceMaxLength: number;
  invalidProps: (id: string) => Record<string, unknown>;
  onChange: (index: number, change: Partial<DocumentItemInput>) => void; onRemove: (index: number) => void;
  /** Moves the item before / after the previous / next item of the same grid (indexes of the OS). */
  onSwap: (index: number, other: number) => void;
  onAddFree: (group: ServiceItemGroup) => void; freeItems: boolean; full: boolean;
  /** The product search of the grid (Peças: produtos; Serviços: serviços); null when the user does not read products. */
  picker: (group: ServiceItemGroup) => ReactNode;
  /** Read-only consultations of a line (histórico, Todos os depósitos), available while the form is locked. */
  lineTools: (item: DocumentItemInput, index: number) => ReactNode;
  /** Preferências › Empresa "Número de casas decimais na quantidade" (at most 6). */
  quantityPlaces?: number;
  /** The aba Comissões of a grid (its items: index in the OS, position and description). */
  commissions?: (rows: { index: number; position: number; description: string }[], group: ServiceItemGroup) => ReactNode;
  /** Review fix (202610200287): the end of the Garantia of an item (AAAA-MM-DD) by Preferências › Serviços "Data base da garantia". */
  warrantyEnd?: (days: string) => string | null;
}) {
  const sums = groupTotals(items, totals);
  const [tabs, setTabs] = useState<Record<ServiceItemGroup, 'items' | 'commissions'>>({ part: 'items', service: 'items' });
  const grid = (group: ServiceItemGroup) => {
    const service = group === 'service', rows = items.map((item, index) => ({ item, index })).filter(row => itemGroup(row.item) === group);
    const title = service ? 'Serviços executados' : 'Peças';
    const tab = commissions ? tabs[group] : 'items';
    return <section className="document-service-items" aria-label={title} key={group}>
      <h3>{title}</h3>
      {commissions && <div className="document-conditions-tabs" role="tablist" aria-label={`Abas de ${title}`}>{([['items', 'Itens'], ['commissions', 'Comissões']] as const).map(([key, label]) =>
        <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'is-active' : undefined} onClick={() => setTabs(current => ({ ...current, [group]: key }))}>{label}</button>)}</div>}
      {tab === 'commissions' && commissions?.(rows.map(({ item, index }, position) => ({ index, position: position + 1, description: item.description })), group)}
      {tab === 'items' && <>
      {editable && <div className="document-add-item">{!full && picker(group)}
        {freeItems ? <button type="button" className="text-button document-add-line" disabled={full} title={service ? 'Inclui uma linha vazia para um serviço não cadastrado' : 'Inclui uma linha vazia para uma peça não cadastrada (Alt+Z)'} onClick={() => onAddFree(group)}>{service ? '+ Adicionar serviço' : '+ Adicionar outro item'}</button>
          : <small className="real-help">Não é permitido incluir itens não cadastrados (Preferências).</small>}</div>}
      <div className="table-scroll" tabIndex={0} aria-label={`Itens: ${title}`}><table className="data-table document-items"><thead><tr><th>#</th>
        <th>{service ? serviceItemLabel(labels, 'servico_descricao') : serviceItemLabel(labels, 'peca_descricao')}</th><th>{service ? serviceItemLabel(labels, 'servico_codigo') : 'Código'}</th>
        <th>{service ? serviceItemLabel(labels, 'servico_quantidade') : 'Qtd'}</th>{!service && <th>UN</th>}{listPrice && <th>Preço lista</th>}{discount && <th>Desc %</th>}
        <th>{service ? serviceItemLabel(labels, 'servico_valor') : 'Preço unitário'}</th><th>Preço total</th><th>Garantia (dias)</th>{service && <><th>{serviceItemLabel(labels, 'servico_orcar')}</th><th>OK</th></>}{editable && <th>Ações</th>}</tr></thead>
        <tbody>{rows.map(({ item, index }, position) => {
          const reference = listPriceOf(item), what = service ? 'serviço' : 'peça', of = service ? 'do serviço' : 'da peça';
          return <tr key={item.id || index}><td className="document-item-position">{position + 1}</td>
            <td><input id={`doc-item-description-${index}`} aria-label={`Descrição ${of} ${position + 1}`} maxLength={200} required value={item.description} {...invalidProps(`doc-item-description-${index}`)} onChange={event => onChange(index, { description: event.target.value })} />
              <small>{item.product_id ? 'Vinculado ao cadastro' : service ? 'Serviço livre' : 'Item livre'}</small>{lineTools(item, index)}</td>
            <td><input aria-label={`Código ${of} ${position + 1}`} maxLength={100} readOnly={Boolean(item.product_id)} title={item.product_id ? 'Código do cadastro (somente leitura)' : undefined} value={item.code || ''} onChange={event => { if (!item.product_id) onChange(index, { code: event.target.value || null }); }} /></td>
            <td><input id={`doc-item-qty-${index}`} aria-label={`${service ? serviceItemLabel(labels, 'servico_quantidade') : 'Quantidade'} ${of} ${position + 1}`} type="text" inputMode="decimal" required value={documentDecimalDisplay(item.quantity)} {...invalidProps(`doc-item-qty-${index}`)} onChange={event => onChange(index, { quantity: documentDecimalInput(limitedDecimal(event.target.value, quantityPlaces)) })} /></td>
            {!service && <td><input id={`doc-item-unit-${index}`} aria-label={`Unidade da peça ${position + 1}`} maxLength={16} placeholder="UN" required value={item.unit} {...invalidProps(`doc-item-unit-${index}`)} onChange={event => onChange(index, { unit: event.target.value })} /></td>}
            {listPrice && <td className="numeric">{reference !== null ? 'R$ ' + documentDecimalDisplay(compactDocumentDecimal(reference)) : '—'}</td>}
            {discount && <td><input id={`doc-item-discount-${index}`} aria-label={`Desconto ${of} ${position + 1}`} type="text" inputMode="decimal" {...invalidProps(`doc-item-discount-${index}`)} value={documentDecimalDisplay(item.discount_percent)} onChange={event => onChange(index, { discount_percent: documentDecimalInput(event.target.value) })} /></td>}
            <td><input id={`doc-item-price-${index}`} aria-label={`Preço ${of} ${position + 1}`} type="text" inputMode="decimal" maxLength={priceMaxLength} title={priceTitle} required value={documentDecimalDisplay(item.unit_price)} {...invalidProps(`doc-item-price-${index}`)} onChange={event => onChange(index, { unit_price: documentDecimalInput(event.target.value) })} /></td>
            <td className="numeric">{decimalMoney(totals?.items[index]?.total ?? null)}</td>
            <td><input id={`doc-item-warranty-${index}`} aria-label={`Garantia em dias ${of} ${position + 1}`} inputMode="numeric" maxLength={4} placeholder="Ex: 90" title="Garantia do item, em dias (Ex: 30, 60 ou 90)" value={item.warranty_days ?? ''} onChange={event => onChange(index, { warranty_days: event.target.value.trim() || null })} />
              {(end => end ? <small className="real-help" id={`doc-item-warranty-until-${index}`}>até {end.split('-').reverse().join('/')}</small> : null)(item.warranty_days ? warrantyEnd?.(item.warranty_days) ?? null : null)}</td>
            {service && <><td><input type="checkbox" aria-label={`${serviceItemLabel(labels, 'servico_orcar')} o serviço ${position + 1}`} checked={item.quote === true} onChange={event => onChange(index, { quote: event.target.checked })} /></td>
              <td><input type="checkbox" aria-label={`Serviço ${position + 1} OK`} checked={item.done === true} onChange={event => onChange(index, { done: event.target.checked })} /></td></>}
            {editable && <td><div className="document-line-actions"><button type="button" aria-label={`Mover ${what} ${position + 1} para cima`} disabled={position === 0} onClick={() => onSwap(index, rows[position - 1]!.index)}>↑</button>
              <button type="button" aria-label={`Mover ${what} ${position + 1} para baixo`} disabled={position === rows.length - 1} onClick={() => onSwap(index, rows[position + 1]!.index)}>↓</button>
              <button type="button" aria-label={`Remover ${what} ${position + 1}`} title={service ? 'Remover serviço' : 'Remover item do pedido'} onClick={() => onRemove(index)}><Icon name="trash-can" size={12} /></button></div></td>}</tr>;
        })}</tbody></table></div>
      {!rows.length && <p className="real-help">{service ? 'Nenhum serviço informado.' : 'Nenhuma peça informada.'}</p>}</>}
      <p className="document-service-total"><span>{service ? 'Total serviços' : 'Total peças'}</span> <strong>{decimalMoney(sums ? sums[group] : null)}</strong></p>
    </section>;
  };
  return <>{grid('part')}{grid('service')}</>;
}
