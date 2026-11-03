/** Lexical evidence for observed service orders, without introducing business writes. */
import { parseSelectedPriceJson } from './price-json-parser.mjs';
export const SERVICE_CAPTURE_PROFILE = 'origin-service-json-v1';
const serviceTotals = new Set(['total', 'totalPecas', 'totalServicos', 'valorFrete']);
const serviceAmounts = new Set(['quantidade', 'horas', 'valorUnitario', 'valor', 'precoLista', 'desconto', 'total', 'valorTotal']);
export const serviceEndpoint = path => typeof path === 'string' && /^\/ordens\/servico\/[0-9]{1,40}$/.test(path) ? 'service_detail' : null;
export async function parseServiceJson(text, bytes) {
  const { result, tokens } = await parseSelectedPriceJson(text, bytes, path => {
    if (path[0] !== 'data') return null;
    if (path.length === 2 && serviceTotals.has(path[1])) return [0, `/${path[1]}`];
    if (path.length === 3 && path[1] === 'desconto' && path[2] === 'valor') return [0, '/desconto/valor'];
    if (path.length === 4 && ['pecas', 'servicos', 'itens'].includes(path[1]) && typeof path[2] === 'number' && serviceAmounts.has(path[3])) return [0, `/${path[1]}/${path[2]}/${path[3]}`];
    return null;
  });
  const data = result?.data;
  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    if (Object.hasOwn(data, '_brufap_service_capture')) throw Object.assign(new Error('ORIGIN_SERVICE_RESPONSE_CONFLICT'), { code: 'ORIGIN_SERVICE_RESPONSE_CONFLICT' });
    const evidence = Object.freeze({ profile: SERVICE_CAPTURE_PROFILE, tokens: Object.freeze(tokens.get(0) ?? []) });
    return Object.freeze({ ...result, data: Object.freeze({ ...data, _brufap_service_capture: evidence }) });
  }
  return result;
}
