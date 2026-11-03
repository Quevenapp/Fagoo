/** Internal bounded JSON grammar shared by fixed, versioned capture policies. */
const numbers = new WeakSet();
const fail = code => { throw Object.assign(new Error(code), { code }); };
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
export function canonicalPriceToken(token) {
  if (typeof token !== 'string' || token.length > 128 || !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]{1,3})?$/.test(token)) fail('ORIGIN_PRICE_TOKEN_LIMIT');
  const match = /^(-?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(token);
  const fraction = match[3] || '', exponent = Number(match[4] || '0');
  let digits = match[2] + fraction, point = match[2].length + exponent;
  if (Math.abs(exponent) > 128 || Math.max(digits.length, point, digits.length - point) > 256) fail('ORIGIN_PRICE_TOKEN_LIMIT');
  let value = point <= 0 ? '0.' + '0'.repeat(-point) + digits : point >= digits.length ? digits + '0'.repeat(point - digits.length) : digits.slice(0, point) + '.' + digits.slice(point);
  let [whole, decimal = ''] = value.split('.');
  whole = whole.replace(/^0+(?=[0-9])/, ''); decimal = decimal.replace(/0+$/, '');
  value = whole + (decimal ? '.' + decimal : '');
  if (value.length > 256) fail('ORIGIN_PRICE_TOKEN_LIMIT');
  return (match[1] && value !== '0' ? '-' : '') + value;
}

export const isCapturedPriceNumber = value => value !== null && typeof value === 'object' && numbers.has(value);
export async function parseSelectedPriceJson(text, bytes, selected) {
  if (typeof text !== 'string' || text.length > 8388608 || !(bytes instanceof Uint8Array) || bytes.byteLength > 8388608) fail('ORIGIN_RESPONSE_SIZE_LIMIT');
  if (typeof selected !== 'function' || typeof JSON.rawJSON !== 'function') fail('ORIGIN_PRICE_CAPTURE_UNAVAILABLE');
  const snapshot = Uint8Array.from(bytes);
  try { if (new TextDecoder('utf-8', {fatal:true}).decode(snapshot) !== text) fail('ORIGIN_INVALID_JSON'); }
  catch { fail('ORIGIN_INVALID_JSON'); }
  let at = 0, count = 0, tokenCount = 0, tokenBytes = 0;
  const tokens = new Map();
  const ws = () => { while (at < text.length && /[\x20\t\r\n]/.test(text[at])) at++; };
  const string = () => {
    const start = at++;
    while (at < text.length) {
      const ch = text[at++];
      if (ch === '"') { try { return JSON.parse(text.slice(start, at)); } catch { fail('ORIGIN_INVALID_JSON'); } }
      if (ch.charCodeAt(0) < 32) fail('ORIGIN_INVALID_JSON');
      if (ch === '\\') { if (at >= text.length) fail('ORIGIN_INVALID_JSON'); at++; }
    }
    fail('ORIGIN_INVALID_JSON');
  };
  const value = (path, depth) => {
    if (++count > 200000 || depth > 64) fail('ORIGIN_RESPONSE_COMPLEXITY_LIMIT');
    ws(); const ch = text[at];
    if (ch === '"') return string();
    if (ch === '{') {
      at++; const result = {}, keys = new Set(); ws();
      if (text[at] === '}') { at++; return result; }
      for (;;) {
        ws(); if (text[at] !== '"') fail('ORIGIN_INVALID_JSON'); const key = string();
        if (keys.has(key)) fail('ORIGIN_DUPLICATE_JSON_KEY'); keys.add(key);
        ws(); if (text[at++] !== ':') fail('ORIGIN_INVALID_JSON');
        Object.defineProperty(result, key, { value: value([...path, key], depth + 1), enumerable: true, writable: true, configurable: true });
        ws(); const sep = text[at++]; if (sep === '}') return result; if (sep !== ',') fail('ORIGIN_INVALID_JSON');
      }
    }
    if (ch === '[') {
      at++; const result = []; ws(); if (text[at] === ']') { at++; return result; }
      for (;;) { result.push(value([...path, result.length], depth + 1)); ws(); const sep = text[at++]; if (sep === ']') return result; if (sep !== ',') fail('ORIGIN_INVALID_JSON'); }
    }
    for (const [literal, primitive] of [['true', true], ['false', false], ['null', null]]) if (text.startsWith(literal, at)) { at += literal.length; return primitive; }
    NUMBER.lastIndex = at; const match = NUMBER.exec(text);
    if (!match) fail('ORIGIN_INVALID_JSON'); at = NUMBER.lastIndex;
    const location = selected(path);
    if (!location) return Number(match[0]);
    const raw = JSON.rawJSON(canonicalPriceToken(match[0])); numbers.add(raw);
    const [index, pointer] = location, found = tokens.get(index) || [];
    if (++tokenCount > 4096 || (tokenBytes += pointer.length + match[0].length + 32) > 130000) fail('ORIGIN_PRICE_TOKEN_LIMIT');
    found.push(Object.freeze({ path: pointer, lexeme: match[0] })); tokens.set(index, found);
    return raw;
  };
  const result = value([], 0); ws(); if (at !== text.length) fail('ORIGIN_INVALID_JSON');
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', snapshot))].map(b => b.toString(16).padStart(2, '0')).join('');
  // Freeze only captured endpoint data; callers cannot change a price after its evidence was captured.
  const pending = [result]; while (pending.length) { const item = pending.pop(); if (item !== null && typeof item === 'object') { for (const child of Object.values(item)) pending.push(child); Object.freeze(item); } }
  return { result, hash, tokens };
}
