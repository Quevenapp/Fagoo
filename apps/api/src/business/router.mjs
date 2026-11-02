import { createBusinessService } from './service.mjs';
import { BusinessError, assert } from '../../../../packages/domain/decimal.mjs';

const respond = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
async function input(request) {
  assert(/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? ''), 'JSON_REQUIRED', 415);
  assert(!request.headers.has('content-encoding') || request.headers.get('content-encoding') === 'identity', 'ENCODING_UNSUPPORTED', 415);
  assert(request.body, 'BODY_REQUIRED'); const reader = request.body.getReader(); const chunks = []; let length = 0;
  try {
    while (true) { const item = await reader.read(); if (item.done) break; length += item.value.byteLength; assert(length <= 1_048_576, 'BODY_TOO_LARGE', 413); chunks.push(item.value); }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw new BusinessError(400, 'INVALID_JSON'); }
  } finally { await reader.cancel().catch(() => {}); }
}
function parameters(url, allowed) {
  const result = {};
  for (const [key, value] of url.searchParams) { assert(allowed.includes(key) && !Object.hasOwn(result, key) && value !== '', 'INVALID_QUERY'); result[key] = value; }
  return result;
}
/** Authentication is supplied by the server; this router independently enforces business scopes. */
export async function handleBusinessRequest(request, { pool, actor }) {
  const url = new URL(request.url); const path = url.pathname; const method = request.method;
  if (!path.startsWith('/api/v1/')) return null;
  const service = createBusinessService(pool); let action;
  const read = (allowed, callback) => { assert(method === 'GET', 'METHOD_NOT_ALLOWED', 405); return () => callback(parameters(url, allowed)); };
  const write = (verb, callback) => { assert(method === verb, 'METHOD_NOT_ALLOWED', 405); parameters(url, []); return async () => callback(await input(request)); };
  try {
    if (path === '/api/v1/products') action = method === 'GET' ? read(['q','limit','cursor'], p => service.products(actor,p)) : write('POST', b => service.saveProduct(actor,b));
    else if (/^\/api\/v1\/products\/[^/]+\/suppliers$/.test(path)) action = write('POST',b => service.supplierProduct(actor,path.split('/')[4],b));
    else if (/^\/api\/v1\/products\/[^/]+$/.test(path)) action = method === 'GET' ? read([],()=>service.product(actor,path.split('/')[4])) : write('PATCH',b=>service.saveProduct(actor,b,path.split('/')[4]));
    else if (path === '/api/v1/contacts') action = method === 'GET' ? read(['q','kind','limit','cursor'],p=>service.contacts(actor,p)) : write('POST',b=>service.saveContact(actor,b));
    else if (/^\/api\/v1\/contacts\/[^/]+$/.test(path)) action = write('PATCH',b=>service.saveContact(actor,b,path.split('/')[4]));
    else if (path === '/api/v1/warehouses') action = method === 'GET' ? read([],()=>service.warehouses(actor)) : write('POST',b=>service.createWarehouse(actor,b));
    else if (path === '/api/v1/price-rules') action = method === 'GET' ? read(['limit','cursor'],p=>service.priceRules(actor,p)) : write('POST',b=>service.savePriceRule(actor,b));
    else if (/^\/api\/v1\/price-rules\/[^/]+$/.test(path)) action = write('PATCH',b=>service.savePriceRule(actor,b,path.split('/')[4]));
    else if (path === '/api/v1/orders') action = method === 'GET' ? read(['kind','limit','cursor'],p=>service.orders(actor,p)) : write('POST',b=>service.createOrder(actor,b));
    else if (/^\/api\/v1\/orders\/[^/]+$/.test(path)) action = read([],()=>service.order(actor,path.split('/')[4]));
    else if (/^\/api\/v1\/orders\/[^/]+\/(confirm|fulfill|receipts|finance|cancel|reverse-fulfillment)$/.test(path)) {
      const [, , , , id, operation] = path.split('/'); const operations = { confirm:'confirmOrder', fulfill:'fulfillOrder', receipts:'receiveOrder', finance:'postFinance',cancel:'cancelOrder','reverse-fulfillment':'reverseFulfillment' };
      action = write('POST',b=>service[operations[operation]](actor,id,b));
    }
    else if (/^\/api\/v1\/orders\/[^/]+\/receipts\/[^/]+\/reverse$/.test(path)) action=write('POST',b=>service.reverseReceipt(actor,path.split('/')[4],path.split('/')[6],b));
    else if (/^\/api\/v1\/orders\/[^/]+\/finance\/[^/]+\/reverse$/.test(path)) action=write('POST',b=>service.reverseFinance(actor,path.split('/')[4],path.split('/')[6],b));
    else if (path === '/api/v1/stock') action = read(['warehouse_id','product_id','limit','cursor'],p=>service.stock(actor,p));
    else if (path === '/api/v1/stock/adjustments') action = write('POST',b=>service.adjustStock(actor,b));
    else if (path === '/api/v1/stock/movements') action = read(['warehouse_id','product_id','from','to','limit','cursor'],p=>service.stockMovements(actor,p));
    else if (path === '/api/v1/payables') action = read(['limit','cursor'],p=>service.finance(actor,p,'payable'));
    else if (path === '/api/v1/receivables') action = read(['limit','cursor'],p=>service.finance(actor,p,'receivable'));
    else if (path === '/api/v1/analytics/overview') action = read([],()=>service.overview(actor));
    else if (path === '/api/v1/analytics/sales-series') action = read(['from','to','group','limit','cursor'],p=>service.salesSeries(actor,p));
    else if (path === '/api/v1/analytics/replenishment-context') action = read(['from','to','limit','cursor'],p=>service.replenishment(actor,p));
    else if (path === '/api/v1/commerce/customer-context') action = read(['contact_id','product_id','quantity','payment_terms'],p=>service.commercialContext(actor,p.contact_id,p.product_id,p));
    else if (path === '/api/v1/invoices/received') action = read(['limit','cursor'],p=>service.receivedInvoices(actor,p));
    else if (path === '/api/v1/events') action = read(['after','limit'],p=>service.events(actor,p));
    else if (path === '/api/v1/events/ack') action = write('POST',b=>service.acknowledgeEvents(actor,b));
    else if (/^\/api\/v1\/commands\/[^/]+$/.test(path)) action = read([],()=>service.commandResult(actor,path.split('/')[4]));
    else return null;
    return respond(await action());
  } catch (error) {
    if (error instanceof BusinessError) return respond({ error: { code: error.code, ...(error.details ? { details: error.details } : {}) } }, error.status);
    throw error;
  }
}
