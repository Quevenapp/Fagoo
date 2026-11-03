import { DOMParser } from '@xmldom/xmldom';

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MIME_EXT = Object.freeze({ 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'application/xml': 'xml', 'text/plain': 'txt' });
export class AttachmentError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
export const failAttachment = (status = 400, code = 'ERP_ATTACHMENT_INVALID') => { throw new AttachmentError(status, code); };
export function attachmentFilename(name, mime) {
  if (typeof name !== 'string' || name.length < 1 || name.length > 255 || !Object.hasOwn(MIME_EXT, mime) || /[\x00-\x1f\x7f]/.test(name)) failAttachment();
  const basename = name.replaceAll('\\', '/').split('/').at(-1);
  const match = /^(.*)\.([a-zA-Z]+)$/.exec(basename);
  const extension = match?.[2].toLowerCase();
  if (!match || (extension !== MIME_EXT[mime] && !(mime === 'image/jpeg' && extension === 'jpeg'))) failAttachment();
  const stem = match[1].normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 80) || 'arquivo';
  return `anexo-${stem}.${MIME_EXT[mime]}`;
}
export async function attachmentHash(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
}
export async function boundedAttachmentBytes(response, expected, { max = MAX_ATTACHMENT_BYTES, timeoutMs = 30000, status = 400 } = {}) {
  const bad = () => failAttachment(status, 'ERP_ATTACHMENT_SIZE_INVALID');
  if (!response.body || !Number.isSafeInteger(expected) || expected < 1 || expected > max) bad();
  const length = response.headers.get('Content-Length');
  if (length !== null && (!/^\d{1,10}$/.test(length) || Number(length) !== expected)) { void response.body.cancel().catch(() => {}); bad(); }
  const bytes = new Uint8Array(expected), reader = response.body.getReader(); let position = 0, timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new AttachmentError(408, 'ERP_ATTACHMENT_TIMEOUT')), timeoutMs); });
  try {
    while (true) {
      const { value, done } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      if (!(value instanceof Uint8Array) || position + value.byteLength > expected) bad();
      bytes.set(value, position); position += value.byteLength;
    }
    if (position !== expected) bad();
    return bytes;
  } finally { clearTimeout(timer); void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function utf8(bytes) {
  let value; try { value = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { failAttachment(415, 'ERP_ATTACHMENT_CONTENT_INVALID'); }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\uFFFE\uFFFF]/.test(value)) failAttachment(415, 'ERP_ATTACHMENT_CONTENT_INVALID');
  return value;
}
function xml(bytes) {
  const text = utf8(bytes);
  if (/<!/i.test(text) || /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/.test(text)) failAttachment(415, 'ERP_ATTACHMENT_XML_PROFILE');
  const declaration = text.match(/^<\?xml\s+version\s*=\s*['"]1\.0['"](?:\s+encoding\s*=\s*['"]UTF-8['"])?(?:\s+standalone\s*=\s*['"](?:yes|no)['"])?\s*\?>/i);
  if ((declaration ? text.slice(declaration[0].length) : text).includes('<?') || (text.match(/</g) || []).length > 40000) failAttachment(415, 'ERP_ATTACHMENT_XML_PROFILE');
  let doc;
  try { doc = new DOMParser({ onError: () => { throw new Error('invalid'); } }).parseFromString(text, 'application/xml'); }
  catch { failAttachment(415, 'ERP_ATTACHMENT_CONTENT_INVALID'); }
  const stack = [[doc, 0]]; let count = 0, roots = 0;
  while (stack.length) {
    const [node, depth] = stack.pop();
    if (++count > 25000 || depth > 80 || ![1, 3, 7, 9].includes(node.nodeType)) failAttachment(415, 'ERP_ATTACHMENT_XML_PROFILE');
    if (node.nodeType === 1) {
      if (node.parentNode === doc) roots++;
      if (node.attributes.length > 40 || ['http://www.w3.org/1999/xhtml', 'http://www.w3.org/2000/svg'].includes(node.namespaceURI) || /^(html|svg|script)$/i.test(node.localName)) failAttachment(415, 'ERP_ATTACHMENT_XML_PROFILE');
    }
    if (node.nodeType === 3 && node.parentNode === doc && node.data.trim()) failAttachment(415, 'ERP_ATTACHMENT_CONTENT_INVALID');
    if (node.nodeType === 7 && (node.target !== 'xml' || node.parentNode !== doc || node !== doc.firstChild)) failAttachment(415, 'ERP_ATTACHMENT_XML_PROFILE');
    for (const child of Array.from(node.childNodes || [])) stack.push([child, depth + 1]);
  }
  if (roots !== 1 || doc.doctype) failAttachment(415, 'ERP_ATTACHMENT_CONTENT_INVALID');
}
function png(bytes) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 45 || signature.some((v, i) => bytes[i] !== v)) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8, chunks = 0, data = false, end = false;
  while (offset + 12 <= bytes.length && ++chunks <= 20000) {
    const length = view.getUint32(offset), type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (length > bytes.length - offset - 12 || !/^[A-Za-z]{4}$/.test(type)) return false;
    if (chunks === 1 && (type !== 'IHDR' || length !== 13 || view.getUint32(offset + 8) === 0 || view.getUint32(offset + 12) === 0)) return false;
    if (chunks > 1 && type === 'IHDR') return false;
    if (type === 'IDAT') data = true;
    offset += 12 + length;
    if (type === 'IEND') { end = length === 0 && offset === bytes.length; break; }
  }
  return data && end;
}
/** Identification/envelope checks only. Does not render, decompress, disinfect or prove absence of malware. */
export function validateAttachmentContent(bytes, mime) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > MAX_ATTACHMENT_BYTES || !Object.hasOwn(MIME_EXT, mime)) failAttachment();
  const bad = () => failAttachment(415, 'ERP_ATTACHMENT_CONTENT_INVALID');
  if (mime === 'application/xml') { xml(bytes); return; }
  if (mime === 'text/plain') { const text = utf8(bytes); if (!text.trim() || /^\s*(?:<!doctype\s+html|<html\b|<script\b|<svg\b|<\?xml\b)/i.test(text)) bad(); return; }
  if (mime === 'image/png') { if (!png(bytes)) bad(); return; }
  if (mime === 'image/jpeg') { if (bytes.length < 12 || bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) bad(); return; }
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 16));
  const tail = new TextDecoder('latin1').decode(bytes.subarray(Math.max(0, bytes.length - 1024)));
  if (!/^%PDF-(?:1\.[0-7]|2\.0)(?:\r|\n)/.test(head) || !/%%EOF[\t\r\n ]*$/.test(tail)) bad();
}
