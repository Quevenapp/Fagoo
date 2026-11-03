// "Enviar por WhatsApp" (pedidos, propostas e OS): opens wa.me with the saved version of the document.
// No API, no message is sent by the Brufap; the user reviews and sends it in WhatsApp.
import { printDecimal, printMoney } from './document-print-model.ts';
import type { DocumentKind, DocumentRecord } from './real-documents-model';

const TITLE: Record<DocumentKind, string> = { sales_orders: 'Pedido de venda', sales_proposals: 'Proposta comercial', service_orders: 'Ordem de serviço', purchase_orders: 'Pedido de compra' };
export const WHATSAPP_LABEL: Partial<Record<DocumentKind, string>> = { sales_orders: 'Enviar por WhatsApp', sales_proposals: 'Enviar por whatsapp', service_orders: 'Enviar por whatsapp' };
export const WHATSAPP_ITEM_LIMIT = 20;

/** Brazilian mobile/phone of the contact snapshot as wa.me digits (55 + DDD + number), or null. */
export function whatsappPhone(snapshot: Record<string, unknown>): string | null {
  for (const key of ['mobile', 'phone']) {
    const raw = snapshot[key];
    if (typeof raw !== 'string') continue;
    let digits = raw.replace(/\D/g, '');
    if (digits.startsWith('0')) digits = digits.replace(/^0+/, '');
    if (/^[1-9]{2}9?\d{8}$/.test(digits)) return `55${digits}`;
    if (/^55[1-9]{2}9?\d{8}$/.test(digits)) return digits;
  }
  return null;
}

export function whatsappMessage(record: Pick<DocumentRecord, 'kind' | 'number' | 'date' | 'contact_snapshot' | 'items' | 'totals'>): string {
  // The pedido de compra goes to the supplier (Origin ⋮ "Enviar por whatsapp" of the compras).
  const lines = [`${TITLE[record.kind]} nº ${record.number}`, `Data: ${record.date.split('-').reverse().join('/')}`, `${record.kind === 'purchase_orders' ? 'Fornecedor' : 'Cliente'}: ${record.contact_snapshot.name}`];
  if (record.items.length) {
    lines.push('Itens:');
    for (const item of record.items.slice(0, WHATSAPP_ITEM_LIMIT)) lines.push(`- ${item.description} · ${printDecimal(item.quantity)} ${item.unit} · ${printMoney(item.total)}`);
    if (record.items.length > WHATSAPP_ITEM_LIMIT) lines.push(`… e mais ${record.items.length - WHATSAPP_ITEM_LIMIT} itens`);
  }
  lines.push(`Total: ${printMoney(record.totals.total)}`);
  return lines.join('\n');
}

/** Variables of Preferências › Serviços "Mensagem padrão para envio de OS por Whatsapp". */
export const WHATSAPP_VARIABLES = ['{nome_cliente}', '{numero_os}', '{data_os}', '{data_prevista}', '{equipamento}', '{numero_serie}', '{valor_total}'] as const;
type TemplateRecord = Parameters<typeof whatsappMessage>[0] & { expected_date?: string | null; equipment?: string | null; serial_number?: string | null };
/** The OS message of the Preferências template; unknown variables stay as typed. */
export function whatsappTemplateMessage(record: TemplateRecord, template: string): string {
  const day = (value: string | null | undefined) => value ? value.split('-').reverse().join('/') : '';
  const values: Record<string, string> = { '{nome_cliente}': record.contact_snapshot.name, '{numero_os}': record.number, '{data_os}': day(record.date), '{data_prevista}': day(record.expected_date),
    '{equipamento}': record.equipment ?? '', '{numero_serie}': record.serial_number ?? '', '{valor_total}': printMoney(record.totals.total) };
  return template.replace(/\{[a-z_]+\}/g, variable => values[variable] ?? variable);
}
export function whatsappUrl(record: TemplateRecord, template: string | null = null): string | null {
  const phone = whatsappPhone(record.contact_snapshot);
  const text = template && record.kind === 'service_orders' ? whatsappTemplateMessage(record, template) : whatsappMessage(record);
  return phone ? `https://wa.me/${phone}?text=${encodeURIComponent(text)}` : null;
}
