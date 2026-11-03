// Origin required-field messages ("O campo {{field}} é obrigatório") for the document editor, checked before saving.
import type { DocumentInput, DocumentKind } from './real-documents-model';

export interface MissingField { id: string; label: string }
export const requiredMessage = (field: MissingField) => `O campo ${field.label} é obrigatório`;

/** `nextContact`: Preferências › Propostas "Tornar campo data do próximo contato obrigatório" (models are exempt, as on the server). */
export function missingRequired(kind: DocumentKind, values: DocumentInput, { nextContact = false, contactLabel = null }: { nextContact?: boolean; contactLabel?: string | null } = {}): MissingField[] {
  const out: MissingField[] = [];
  if (!values.date) out.push({ id: 'doc-date', label: kind === 'sales_orders' ? 'Data da venda' : 'Data' });
  if (!values.contact_id) out.push({ id: 'doc-contact', label: contactLabel ?? (kind === 'purchase_orders' ? 'Fornecedor' : 'Cliente') });
  if (nextContact && kind === 'sales_proposals' && !values.template && !values.next_contact) out.push({ id: 'doc-next', label: 'Próximo contato' });
  values.items.forEach((item, index) => {
    const suffix = values.items.length > 1 ? ` (item ${index + 1})` : '';
    if (!item.description.trim()) out.push({ id: `doc-item-description-${index}`, label: `Descrição${suffix}` });
    if (!item.unit.trim()) out.push({ id: `doc-item-unit-${index}`, label: `Un${suffix}` });
    if (!item.quantity.trim()) out.push({ id: `doc-item-qty-${index}`, label: `Quantidade${suffix}` });
    if (!item.unit_price.trim()) out.push({ id: `doc-item-price-${index}`, label: `Preço un${suffix}` });
  });
  if (values.delivery_address) {
    if (!values.delivery_address.street?.trim()) out.push({ id: 'doc-delivery-street', label: 'Endereço (entrega)' });
    if (!values.delivery_address.city?.trim()) out.push({ id: 'doc-delivery-city', label: 'Cidade (entrega)' });
  }
  (values.installments ?? []).forEach((row, index) => {
    if (!row.due_date) out.push({ id: `doc-installment-date-${index}`, label: `Data (parcela ${index + 1})` });
    if (!row.amount.trim()) out.push({ id: `doc-installment-amount-${index}`, label: `Valor (parcela ${index + 1})` });
  });
  return out;
}
