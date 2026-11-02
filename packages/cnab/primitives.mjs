import { isValidCnpj } from '../fiscal-core/identity.mjs';

export class CnabError extends Error {
  constructor(code, { line, field } = {}) { super(code); this.name = 'CnabError'; this.code = code; this.line = line; this.field = field; }
}
export function requireCnab(condition, code, context) { if (!condition) throw new CnabError(code, context); }
export const digits = (value, size) => typeof value === 'string' && new RegExp(`^[0-9]{${size}}$`).test(value);
export function cents(value, width = 13) {
  requireCnab(typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value) && value.length <= width, 'CNAB_AMOUNT_INVALID');
  return BigInt(value);
}
export function mod10(value) {
  requireCnab(typeof value === 'string' && /^[0-9]+$/.test(value), 'CNAB_DIGIT_BASE_INVALID');
  let total = 0, weight = 2;
  for (let index = value.length - 1; index >= 0; index--) {
    const product = Number(value[index]) * weight;
    total += Math.floor(product / 10) + product % 10;
    weight = weight === 2 ? 1 : 2;
  }
  return String((10 - total % 10) % 10);
}
export function validDocument(type, value) {
  if (type === '02') return digits(value, 14) && isValidCnpj(value);
  if (type !== '01' || !digits(value, 11) || /^([0-9])\1{10}$/.test(value)) return false;
  const digit = (base, weight) => { const remainder = [...base].reduce((sum, number) => sum + Number(number) * weight--, 0) % 11; return String(remainder < 2 ? 0 : 11 - remainder); };
  return value[9] === digit(value.slice(0, 9), 10) && value[10] === digit(value.slice(0, 10), 11);
}
export function cnabDate(value, { century = 2000, optional = false, line, field } = {}) {
  requireCnab(Number.isInteger(century) && century >= 1900 && century <= 2100 && century % 100 === 0, 'CNAB_CENTURY_REQUIRED');
  if (optional && (value === '000000' || value === '      ')) return null;
  requireCnab(digits(value, 6), 'CNAB_DATE_INVALID', { line, field });
  const day = Number(value.slice(0, 2)), month = Number(value.slice(2, 4)), year = century + Number(value.slice(4));
  requireCnab(month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate(), 'CNAB_DATE_INVALID', { line, field });
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
export function dateField(value) {
  requireCnab(typeof value === 'string' && /^20[0-9]{2}-[0-9]{2}-[0-9]{2}$/.test(value), 'CNAB_DATE_INVALID');
  const encoded = value.slice(8, 10) + value.slice(5, 7) + value.slice(2, 4);
  requireCnab(cnabDate(encoded) === value, 'CNAB_DATE_INVALID');
  return encoded;
}
export function alpha(value, size, required = false) {
  requireCnab(typeof value === 'string' && /^[\x20-\x7E]*$/.test(value) && value === value.toUpperCase()
    && value.length <= size && (!required || value.trim().length > 0), 'CNAB_TEXT_INVALID');
  return value.padEnd(size, ' ');
}
export function numeric(value, size) {
  requireCnab(typeof value === 'string' && /^[0-9]+$/.test(value) && value.length <= size, 'CNAB_NUMERIC_INVALID');
  return value.padStart(size, '0');
}
export function encodeRecords(records) {
  requireCnab(records.every(row => row.length === 400 && /^[\x20-\x7E]+$/.test(row)), 'CNAB_RECORD_INVALID');
  return new TextEncoder().encode(records.join('\r\n') + '\r\n');
}
export function readRecords(bytes) {
  requireCnab(bytes instanceof Uint8Array && bytes.byteLength > 0 && bytes.byteLength <= 4_020_000, 'CNAB_FILE_SIZE_INVALID');
  requireCnab(bytes.every(value => (value >= 32 && value <= 126) || value === 10 || value === 13), 'CNAB_ENCODING_UNSUPPORTED');
  const text = new TextDecoder('ascii', { fatal: true }).decode(bytes);
  const separator = text.includes('\r') ? '\r\n' : '\n';
  const cleaned = text.endsWith(separator) ? text.slice(0, -separator.length) : text;
  const records = cleaned.split(separator);
  requireCnab(records.length >= 2 && records.length <= 10000, 'CNAB_RECORD_COUNT_INVALID');
  records.forEach((row, index) => {
    requireCnab(row.length === 400 && !/[\r\n]/.test(row), 'CNAB_RECORD_LENGTH_INVALID', { line: index + 1 });
    requireCnab(row.slice(394) === String(index + 1).padStart(6, '0'), 'CNAB_SEQUENCE_INVALID', { line: index + 1 });
  });
  return records;
}
export async function sha256(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export function makeRecord(fields) {
  const record = Array(400).fill(' '), occupied = new Set();
  for (const [from, to, value] of fields) {
    requireCnab(typeof value === 'string' && value.length === to - from + 1 && from >= 1 && to <= 400, 'CNAB_FIELD_SIZE_INVALID');
    for (let position = from; position <= to; position++) {
      requireCnab(!occupied.has(position), 'CNAB_FIELD_OVERLAP'); occupied.add(position); record[position - 1] = value[position - from];
    }
  }
  return record.join('');
}

export function parseLayout(row, layout, line) {
  const result = {};
  for (const [field, from, to, type, literal] of layout) {
    const value = row.slice(from - 1, to);
    if (type === 'N') requireCnab(/^[0-9]+$/.test(value), 'CNAB_NUMERIC_INVALID', { line, field });
    if (type === 'B') requireCnab(/^ +$/.test(value), 'CNAB_RESERVED_FIELD_INVALID', { line, field });
    if (literal !== undefined) requireCnab(value === literal.padEnd(to - from + 1, type === 'N' ? '0' : ' '), 'CNAB_LITERAL_INVALID', { line, field });
    result[field] = type === 'A' ? value.trimEnd() : value;
  }
  return result;
}
