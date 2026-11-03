/** Selective HTTP number capture. No native ERP precision policy is applied. */
import {parseSelectedPriceJson} from './price-json-parser.mjs';
export {canonicalPriceToken,isCapturedPriceNumber} from './price-json-parser.mjs';
export const PRICE_CAPTURE_PROFILE = 'origin-price-json-v1';
const captured = new WeakMap();
const fail = code => { throw Object.assign(new Error(code), { code }); };

export function priceEndpoint(path) {
  if (path === '/produtos') return 'product_list';
  if (/^\/produtos\/[0-9]{1,40}$/.test(path)) return 'product_detail';
  if (/^\/propostas-comerciais\/[0-9]{1,40}$/.test(path)) return 'proposal_detail';
  return null;
}

export function priceCapture(value, source = 'detail') {
  const evidence = captured.get(value);
  if (!evidence) return null;
  if (!['detail', 'list_fallback'].includes(source) || (source === 'list_fallback') !== (evidence.endpoint === 'product_list')) fail('ORIGIN_PRICE_CAPTURE_CONTEXT');
  return Object.freeze({ profile: PRICE_CAPTURE_PROFILE, response_sha256: evidence.hash, source, tokens: evidence.tokens });
}

/** Legacy059 policy: endpoint/profile/hash/replay semantics remain unchanged. */
export async function parsePriceJson(text, bytes, endpoint) {
  if (!['product_list', 'product_detail', 'proposal_detail'].includes(endpoint)) fail('ORIGIN_PRICE_CAPTURE_UNAVAILABLE');
  const selected = path => {
    if (endpoint === 'product_list' && path.length === 3 && path[0] === 'data' && typeof path[1] === 'number' && path[2] === 'preco') return [path[1], '/preco'];
    if (endpoint === 'product_detail' && path.join('/') === 'data/preco' && path.length === 2) return [0, '/preco'];
    if (endpoint === 'proposal_detail' && path.length === 4 && path[0] === 'data' && path[1] === 'itens' && typeof path[2] === 'number' && path[3] === 'valor') return [0, `/itens/${path[2]}/valor`];
    return null;
  };
  const {result,hash,tokens}=await parseSelectedPriceJson(text,bytes,selected);
  const data=result?.data,items=endpoint==='product_list'?(Array.isArray(data)?data:[]):[data];
  items.forEach((item,index)=>{
    const found=tokens.get(index)||[];
    if(JSON.stringify(found).length>130000)fail('ORIGIN_PRICE_TOKEN_LIMIT');
    if(item!==null&&typeof item==='object')captured.set(item,Object.freeze({endpoint,hash,tokens:Object.freeze(found)}));
  });
  return result;
}
