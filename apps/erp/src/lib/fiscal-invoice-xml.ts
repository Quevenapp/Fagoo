// XML files of the invoice screens: the XML stored with an imported note (migration 202610200143), checked again in the
// browser (size, SHA-256 and access key) before it is shown or saved, and the file download itself.
// Imported through ../lib so the component tests resolve the same AccessError as the screens.
import { AccessError, type AccessController } from '../lib/real-access';
import { FISCAL_BASE } from './fiscal-invoice-list-model.ts';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
}
export interface ImportedXml { invoice_id: string; access_key: string; sha256: string; size: number; xml: string }
/** GET /v1/notas-fiscais/{id}/xml with the same checks the Worker made; a divergent answer is refused. */
export async function importedXml(controller: Pick<AccessController, 'fiscalInvoices'>, id: string, signal?: AbortSignal): Promise<ImportedXml> {
  const value = await controller.fiscalInvoices(`${FISCAL_BASE}/${id}/xml`, { signal }) as Partial<ImportedXml> | null;
  if (!value || value.invoice_id !== id || !UUID.test(id) || typeof value.xml !== 'string' || !/^\d{44}$/.test(value.access_key ?? '') || !/^[0-9a-f]{64}$/.test(value.sha256 ?? '') || !Number.isInteger(value.size)) throw new AccessError(502);
  const bytes = new TextEncoder().encode(value.xml);
  if (bytes.byteLength !== value.size || await sha256Hex(bytes) !== value.sha256 || !value.xml.includes(`NFe${value.access_key}`)) throw new AccessError(502);
  return { invoice_id: id, access_key: value.access_key!, sha256: value.sha256!, size: value.size!, xml: value.xml };
}
/** Saves a file in this browser (object URL released right after). */
export function saveFile(name: string, data: BlobPart, type: string) {
  const address = URL.createObjectURL(new Blob([data], { type })), link = document.createElement('a');
  try { link.href = address; link.download = name; document.body.appendChild(link); link.click(); }
  finally { link.remove(); setTimeout(() => URL.revokeObjectURL(address), 1000); }
}
export const xmlFileName = (key: string) => `nfe-${key}.xml`;
