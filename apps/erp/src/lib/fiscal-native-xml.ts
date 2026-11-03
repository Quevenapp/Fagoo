// "Validar" (Outras opções de NF-e) and "Gerar XML (suporte)" (⋮ da NFC-e) of a note of the Brufap (notas fiscais lane, wave F,
// migration 202610200273): the Worker builds the native XML from the saved note and checks it against the official layout (PL 010f) and
// the offline rules. Nothing is reserved, signed, transmitted or stored; the answer is checked here before anything is shown or saved.
import { FISCAL_BASE } from './fiscal-invoice-list-model.ts';
export { nativeXmlBlock } from './fiscal-invoice-list-model.ts';

export interface NativeXmlProblem { message: string; path?: string; field?: string | null; severity?: 'error' | 'warning' }
export interface NativeXmlResult {
  invoice_id: string; invoice_version: number; model: '55' | '65'; series: number; number: number; access_key: string; issued_at: string; xml: string; xml_bytes: number; xml_sha256: string;
  schema: { profile: string; valid: boolean; truncated: boolean; errors: NativeXmlProblem[] }; rules: NativeXmlProblem[]; valid: boolean;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number) => typeof value === 'string' && value.length > 0 && value.length <= max;
const hex = async (value: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(v => v.toString(16).padStart(2, '0')).join('');
export const nativeXmlPath = (id: string) => `${FISCAL_BASE}/${id}/xml-nativo`;
/** The answer of GET /v1/notas-fiscais/{id}/xml-nativo, checked field by field (the XML by size and SHA-256). */
export async function nativeXmlResult(value: unknown, id: string): Promise<NativeXmlResult> {
  const v = value as Record<string, unknown>;
  const schema = plain(v?.schema) ? v.schema : null;
  if (!plain(v) || v.invoice_id !== id || !Number.isInteger(v.invoice_version) || !['55', '65'].includes(String(v.model)) || !Number.isInteger(v.series) || !Number.isInteger(v.number) || (v.number as number) < 1
    || typeof v.access_key !== 'string' || !/^\d{44}$/.test(v.access_key) || !text(v.issued_at, 40) || typeof v.xml !== 'string' || !Number.isInteger(v.xml_bytes) || typeof v.xml_sha256 !== 'string'
    || v.signed !== false || v.transmitted !== false || v.numbering_reserved !== false || v.environment !== '2' || v.number_provisional !== true || v.data_mode !== 'erp_native_homologation'
    || typeof v.valid !== 'boolean' || !schema || typeof schema.valid !== 'boolean' || typeof schema.truncated !== 'boolean' || !text(schema.profile, 40) || !Array.isArray(schema.errors) || schema.errors.length > 100
    || !Array.isArray(v.rules) || v.rules.length > 200 || !UUID.test(id)) throw new Error('NATIVE_XML_RESPONSE_INVALID');
  const bytes = new TextEncoder().encode(v.xml).byteLength;
  if (bytes !== v.xml_bytes || bytes > 512000 || await hex(v.xml) !== v.xml_sha256 || !v.xml.includes(`Id="NFe${v.access_key}"`) || !v.xml.includes('<tpAmb>2</tpAmb>')) throw new Error('NATIVE_XML_RESPONSE_INVALID');
  const errors = (schema.errors as unknown[]).map(e => { if (!plain(e) || !text(e.message, 500) || !text(e.path, 300)) throw new Error('NATIVE_XML_RESPONSE_INVALID'); return { message: e.message as string, path: e.path as string }; });
  const rules = (v.rules as unknown[]).map(r => {
    if (!plain(r) || !text(r.message, 500) || !['error', 'warning'].includes(String(r.severity)) || !(r.field === null || text(r.field, 120))) throw new Error('NATIVE_XML_RESPONSE_INVALID');
    return { message: r.message as string, severity: r.severity as 'error' | 'warning', field: r.field as string | null };
  });
  if (v.valid !== (schema.valid && errors.length === 0 && !rules.some(r => r.severity === 'error'))) throw new Error('NATIVE_XML_RESPONSE_INVALID');
  return { invoice_id: id, invoice_version: v.invoice_version as number, model: v.model as '55' | '65', series: v.series as number, number: v.number as number, access_key: v.access_key, issued_at: v.issued_at as string,
    xml: v.xml, xml_bytes: bytes, xml_sha256: v.xml_sha256, schema: { profile: schema.profile as string, valid: schema.valid, truncated: schema.truncated, errors }, rules, valid: v.valid };
}
/** File name of the support XML: the access key of the prediction, marked as generated (never confused with an authorized XML). */
export const nativeXmlFileName = (result: Pick<NativeXmlResult, 'access_key'>) => `NFe${result.access_key}-gerado-sem-assinatura.xml`;
export function nativeXmlSummary(result: NativeXmlResult): string {
  if (result.valid) return `Nota validada: o XML segue o leiaute da NF-e 4.00 (${result.schema.profile}) e passou nas regras conferidas pelo FAGOO.`;
  const count = result.schema.errors.length + result.rules.filter(r => r.severity === 'error').length;
  return `Foram encontrados ${count}${result.schema.truncated ? '+' : ''} erro(s) na nota. Corrija e valide de novo.`;
}
export const nativeXmlNote = (result: NativeXmlResult) => `XML gerado sem assinatura, com o número previsto ${result.number} da série ${result.series} (não reservado) e a chave ${result.access_key}. Ambiente de homologação, sem valor fiscal: nada foi transmitido nem guardado.`;
