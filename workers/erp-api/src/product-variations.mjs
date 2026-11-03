/** Leva H, lane produtos (migration 202610210410), under /v1/cadastros/products/:id/variacoes:
 * - GET: the variations of a product with Formato V (the SKU children with code, price, GTIN and attributes);
 * - POST {command_id, attributes, code, gtin?, price?}: Adicionar variação — a new SKU child created by the product save, linked to
 *   the pai with its attributes (Cor, Tamanho...). Strict input before the database, closed answers after it. */
import {isCanonicalUnitPrice} from '../../../packages/erp-domain/src/unit-price.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL = /[\x00-\x1f\x7f]/;
export class ProductVariationsError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const invalid = () => { throw new ProductVariationsError(400, 'ERP_INVALID_QUERY'); };
const bad = () => { throw new ProductVariationsError(502, 'ERP_UPSTREAM_INVALID_RESPONSE'); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const only = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const text = (value, max) => typeof value === 'string' && value.trim().length >= 1 && [...value].length <= max && !CONTROL.test(value);

export function productVariationsRoute(path) {
  const match = /^\/v1\/cadastros\/products\/([0-9a-fA-F-]{36})\/variacoes$/.exec(path);
  return match && UUID.test(match[1]) ? { product: 'variations', entity: 'products', id: match[1].toLowerCase() } : null;
}
export const productVariationsMethods = () => ['GET', 'POST'];
export async function productVariationsOperation(request, route, params, readBody) {
  if (params.size) invalid();
  if (request.method === 'GET') return { rpc: 'erp_catalog_product_variations', args: { p_parent: route.id }, type: 'list' };
  const body = await readBody(request);
  if (!only(body, ['command_id', 'attributes', 'code', 'gtin', 'price']) || typeof body.command_id !== 'string' || !UUID.test(body.command_id) || !object(body.attributes)) invalid();
  const keys = Object.keys(body.attributes);
  if (!keys.length || keys.length > 5 || keys.some(key => !text(key, 60) || !text(body.attributes[key], 60))
    || new Set(keys.map(key => key.trim().toLowerCase())).size !== keys.length || !text(body.code, 100)
    || (body.gtin !== undefined && body.gtin !== null && !/^\d{8}$|^\d{12,14}$/.test(body.gtin)) || (body.price !== undefined && body.price !== null && !isCanonicalUnitPrice(body.price, 14))) invalid();
  const data = { attributes: Object.fromEntries(keys.map(key => [key.trim(), body.attributes[key].trim()])), code: body.code.trim(), ...(body.gtin ? { gtin: body.gtin } : {}), ...(body.price ? { price: body.price } : {}) };
  return { rpc: 'erp_catalog_product_variation_add', args: { p_command_id: body.command_id.toLowerCase(), p_parent: route.id, p_data: data }, type: 'add' };
}
function view(value, route) {
  if (!object(value) || value.data_mode !== 'erp_native' || !exact(value.parent, ['id', 'name', 'code', 'format']) || value.parent.id !== route.id || !Array.isArray(value.children) || value.children.length > 500) bad();
  const children = value.children.map(child => {
    if (!exact(child, ['id', 'name', 'code', 'active', 'gtin', 'price', 'attributes']) || !UUID.test(child.id ?? '') || typeof child.name !== 'string' || typeof child.active !== 'boolean'
      || !(child.code === null || typeof child.code === 'string') || !(child.gtin === null || typeof child.gtin === 'string') || !(child.price === null || typeof child.price === 'string')
      || !object(child.attributes) || Object.values(child.attributes).some(v => typeof v !== 'string')) bad();
    return { id: child.id, name: child.name, code: child.code, active: child.active, gtin: child.gtin, price: child.price, attributes: { ...child.attributes } };
  });
  return { parent: { ...value.parent }, children, data_mode: 'erp_native' };
}
export function productVariationsResponse(value, route, operation) {
  if (operation.type === 'list') { if (value?.scope !== 'product_variations') bad(); return view(value, route); }
  if (value?.scope !== 'product_variation_command' || typeof value.replayed !== 'boolean' || !UUID.test(value.child_id ?? '')) bad();
  const result = view(value, route); if (!result.children.some(child => child.id === value.child_id)) bad();
  return { ...result, child_id: value.child_id, replayed: value.replayed };
}
