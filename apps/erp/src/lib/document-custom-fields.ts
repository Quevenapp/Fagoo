// 202610200287/288 Campos customizados da OS (Origin: Preferências › Sistema › Campos customizados › Ordem de Serviço, aba "Campos
// Customizados" da OS e a pergunta "Imprimir campos customizados na ordem de serviço?"). The same types and value rules as the campos
// customizados of the produtos (custom-fields.ts, migration 156), so a value is canonical text before it is saved.
import { customDisplay, customInputValue, customValue, type CustomField, type CustomFieldOption, type CustomFieldType, type CustomFieldWidth } from './custom-fields.ts';

export const DOCUMENT_CUSTOM_FIELDS_PATH = '/v1/documentos/service_orders/campos-customizados';
export interface DocumentCustomField {
  id: string; kind: 'service_orders'; field_type: CustomFieldType; name: string; hint: string | null; info: string | null; required: boolean;
  min_length: number | null; max_length: number | null; width: CustomFieldWidth; options: CustomFieldOption[]; active: boolean; version: number;
  created_at: string; updated_at: string; documents: number | null;
}
export interface DocumentCustomFieldsPage { kind: 'service_orders'; can_manage: boolean; items: DocumentCustomField[] }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TYPES: readonly CustomFieldType[] = ['integer', 'decimal', 'list', 'text', 'long_text', 'boolean', 'date'];
export function readDocumentCustomFields(value: unknown): DocumentCustomFieldsPage {
  const page = value as DocumentCustomFieldsPage | null;
  if (!page || page.kind !== 'service_orders' || typeof page.can_manage !== 'boolean' || !Array.isArray(page.items) || page.items.some(item => !item || !UUID.test(item.id)
    || !TYPES.includes(item.field_type) || typeof item.name !== 'string' || !Array.isArray(item.options) || typeof item.active !== 'boolean' || !Number.isInteger(item.version))) throw new Error('Resposta inválida dos campos customizados.');
  return page;
}
/** The product field shape the shared value rules read (no Agrupador in the OS). */
const asField = (field: DocumentCustomField): CustomField => ({ ...field, module: 'products', grouped: false, category_ids: [], products: 0, hint: field.hint, info: field.info });
/** The canonical value of a field (null clears) or the message of its first problem. */
export const documentCustomValue = (field: DocumentCustomField, raw: string | undefined) => customValue(asField(field), raw);
export const documentCustomInput = (field: DocumentCustomField, value: string | undefined) => customInputValue(asField(field), value);
export const documentCustomDisplay = (field: DocumentCustomField, value: unknown) => customDisplay(asField(field), value);
/** Fields of the OS form: the active ones, and an inactive one only while the OS keeps a value of it (read-only). */
export const formCustomFields = (fields: readonly DocumentCustomField[], values: Readonly<Record<string, string>> | null | undefined) =>
  fields.filter(field => field.active || Boolean(values?.[field.id]));
/** The custom_fields of the save (canonical values; an empty field leaves no key) or the first problem with the field id. */
export function customFieldsPayload(fields: readonly DocumentCustomField[], drafts: Readonly<Record<string, string>>, saved: Readonly<Record<string, string>> | null | undefined):
  { value: Record<string, string> } | { error: string; field: string } {
  const out: Record<string, string> = {};
  for (const field of fields) {
    if (!field.active) { const kept = saved?.[field.id]; if (kept) out[field.id] = kept; continue; }
    const result = documentCustomValue(field, drafts[field.id]);
    if ('error' in result) return { error: result.error, field: field.id };
    if (result.value !== null) out[field.id] = result.value;
  }
  return { value: out };
}
/** "Imprimir campos customizados": label and printable text of every field with a value. */
export function printableCustomFields(fields: readonly DocumentCustomField[], values: Readonly<Record<string, string>> | null | undefined): { label: string; value: string }[] {
  return fields.filter(field => values?.[field.id]).map(field => ({ label: field.name, value: documentCustomDisplay(field, values![field.id]) || values![field.id]! }));
}
export const hasCustomValues = (values: Readonly<Record<string, string>> | null | undefined) => Boolean(values && Object.values(values).some(Boolean));
