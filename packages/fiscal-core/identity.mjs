const UF_CODES = new Set(['11','12','13','14','15','16','17','21','22','23','24','25','26','27','28','29','31','32','33','35','41','42','43','50','51','52','53']);
const KEY_PATTERN = /^[0-9]{6}[A-Z0-9]{12}[0-9]{26}$/;
const KEY_BASE_PATTERN = /^[0-9]{6}[A-Z0-9]{12}[0-9]{25}$/;
const text = value => typeof value === 'string' ? value : Number.isSafeInteger(value) ? String(value) : '';
const integerIn = (value, min, max, width) => new RegExp(`^[0-9]{1,${width}}$`).test(text(value)) && Number(value) >= min && Number(value) <= max;
const issue = (path, code) => ({ path, code });

// ASCII - 48 preserves numeric CNPJs and supports the ENCAT 2025.001 format.
function mod11(value) {
  let sum = 0, weight = 2;
  for (let i = value.length - 1; i >= 0; i--) {
    sum += (value.charCodeAt(i) - 48) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const remainder = sum % 11;
  return String(remainder < 2 ? 0 : 11 - remainder);
}

export function cnpjCheckDigits(base) {
  if (typeof base !== 'string' || !/^[A-Z0-9]{12}$/.test(base)) throw new Error('CNPJ_BASE_INVALID');
  const first = mod11(base);
  return first + mod11(base + first);
}

export function isValidCnpj(cnpj) {
  return typeof cnpj === 'string' && /^[A-Z0-9]{12}[0-9]{2}$/.test(cnpj)
    && !/^([0-9])\1{13}$/.test(cnpj) && cnpj.slice(12) === cnpjCheckDigits(cnpj.slice(0, 12));
}

export function accessKeyCheckDigit(base) {
  if (typeof base !== 'string' || !KEY_BASE_PATTERN.test(base)) throw new Error('ACCESS_KEY_BASE_INVALID');
  return mod11(base);
}

export function validFiscalTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  const [year, month, day, hour, minute, second] = value.slice(0, 19).split(/[-T:]/).map(Number);
  if (year < 2000 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return false;
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const offset = value.endsWith('Z') ? [0, 0] : value.slice(-5).split(':').map(Number);
  return day <= days && offset[0] <= 14 && offset[1] <= 59 && (offset[0] !== 14 || offset[1] === 0) && Number.isFinite(Date.parse(value));
}

export function validateFiscalIdentity(input) {
  const value = input && typeof input === 'object' ? input : {};
  const errors = [];
  if (!UF_CODES.has(text(value.cUF))) errors.push(issue('cUF', 'UF_INVALID'));
  if (!isValidCnpj(value.cnpj)) errors.push(issue('cnpj', 'CNPJ_INVALID'));
  if (!['55', '65'].includes(text(value.model))) errors.push(issue('model', 'MODEL_UNSUPPORTED'));
  if (!['1', '2'].includes(text(value.environment))) errors.push(issue('environment', 'ENVIRONMENT_INVALID'));
  if (!integerIn(value.series, 0, 999, 3)) errors.push(issue('series', 'SERIES_INVALID'));
  if (!integerIn(value.number, 1, 999999999, 9)) errors.push(issue('number', 'NUMBER_INVALID'));
  if (!validFiscalTimestamp(value.issuedAt)) errors.push(issue('issuedAt', 'ISSUE_TIMESTAMP_INVALID'));
  if (typeof value.cNF !== 'string' || !/^[0-9]{8}$/.test(value.cNF)) errors.push(issue('cNF', 'NUMERIC_CODE_INVALID'));
  const types = text(value.model) === '65' ? ['1', '9'] : ['1', '2', '4', '5', '6', '7'];
  if (!types.includes(text(value.tpEmis))) errors.push(issue('tpEmis', 'EMISSION_TYPE_INVALID'));
  return { valid: errors.length === 0, errors };
}

export function normalizeFiscalIdentity(input) {
  if (!validateFiscalIdentity(input).valid) throw new Error('FISCAL_IDENTITY_INVALID');
  return Object.freeze({ cUF: text(input.cUF), cnpj: input.cnpj, model: text(input.model), environment: text(input.environment),
    series: text(input.series).padStart(3, '0'), number: text(input.number).padStart(9, '0'),
    issuedAt: input.issuedAt, cNF: input.cNF, tpEmis: text(input.tpEmis) });
}

export function buildAccessKey(input) {
  const value = normalizeFiscalIdentity(input);
  const base = value.cUF + value.issuedAt.slice(2, 4) + value.issuedAt.slice(5, 7) + value.cnpj + value.model
    + value.series + value.number + value.tpEmis + value.cNF;
  return base + accessKeyCheckDigit(base);
}

export function inspectAccessKey(key) {
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) return { valid: false, errors: [issue('accessKey', 'ACCESS_KEY_FORMAT_INVALID')] };
  const parts = { cUF: key.slice(0, 2), yearMonth: key.slice(2, 6), cnpj: key.slice(6, 20), model: key.slice(20, 22),
    series: key.slice(22, 25), number: key.slice(25, 34), tpEmis: key.slice(34, 35), cNF: key.slice(35, 43), checkDigit: key.slice(43) };
  const errors = [];
  if (accessKeyCheckDigit(key.slice(0, 43)) !== parts.checkDigit) errors.push(issue('accessKey', 'ACCESS_KEY_CHECK_DIGIT_INVALID'));
  if (!UF_CODES.has(parts.cUF)) errors.push(issue('cUF', 'UF_INVALID'));
  if (!integerIn(parts.yearMonth.slice(2), 1, 12, 2)) errors.push(issue('yearMonth', 'MONTH_INVALID'));
  if (!isValidCnpj(parts.cnpj)) errors.push(issue('cnpj', 'CNPJ_INVALID'));
  if (!['55', '65'].includes(parts.model)) errors.push(issue('model', 'MODEL_UNSUPPORTED'));
  if (!integerIn(parts.number, 1, 999999999, 9)) errors.push(issue('number', 'NUMBER_INVALID'));
  if (!(parts.model === '65' ? ['1', '9'] : ['1', '2', '4', '5', '6', '7']).includes(parts.tpEmis)) errors.push(issue('tpEmis', 'EMISSION_TYPE_INVALID'));
  return { valid: errors.length === 0, errors, parts };
}

// Conservative application uniqueness: a changed cNF/date/tpEmis must not create a second invoice.
// The database must enforce this key atomically; the access key alone omits the environment.
export function emissionIdentityKey(input) {
  const value = normalizeFiscalIdentity(input);
  return [value.environment, value.cUF, value.cnpj, value.model, value.series, value.number].join(':');
}

export function randomNumericCode(cryptoImpl = globalThis.crypto) {
  const values = new Uint32Array(1);
  const upper = Math.floor(0x100000000 / 100000000) * 100000000;
  do { cryptoImpl.getRandomValues(values); } while (values[0] >= upper);
  return String(values[0] % 100000000).padStart(8, '0');
}
