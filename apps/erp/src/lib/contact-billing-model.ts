// Leva H (SQL 373: CTT-050, PRF-299): Cobrança of the contact, read from /v1/cadastros/contatos/{id}/cobranca.
export interface ContactBillingAddress { source: 'geral' | 'cobranca'; postal_code: string | null; state: string | null; city: string | null; district: string | null; street: string | null; number: string | null; complement: string | null; foreign_state: string | null }
export interface ContactBillingItem { contact_id: string; same_as_general: boolean; billing_email: string | null; email_verified: boolean; billing_email_verified: boolean; verification_available: boolean; address: ContactBillingAddress; version: number }

export const contactBillingPath = (contactId: string) => `/v1/cadastros/contatos/${contactId}/cobranca`;
export function contactBilling(value: unknown, contactId: string): ContactBillingItem {
  const item = (value as { entity?: unknown; item?: ContactBillingItem } | null)?.item;
  if ((value as { entity?: unknown } | null)?.entity !== 'contact_billing' || !item || item.contact_id !== contactId || typeof item.same_as_general !== 'boolean' || typeof item.email_verified !== 'boolean'
    || typeof item.billing_email_verified !== 'boolean' || !item.address || !['geral', 'cobranca'].includes(item.address.source) || !Number.isInteger(item.version)) throw new Error('Resposta inválida dos dados de cobrança.');
  return item;
}
/** "Rua X, 10 - Bairro, Cidade/UF, CEP" with what exists. */
export function billingAddressText(address: ContactBillingAddress) {
  const street = [address.street, address.number].filter(Boolean).join(', '), place = [address.city, address.state ?? address.foreign_state].filter(Boolean).join('/');
  const text = [[street, address.complement].filter(Boolean).join(' '), address.district, place, address.postal_code].filter(Boolean).join(' - ');
  return text || 'não informado';
}
