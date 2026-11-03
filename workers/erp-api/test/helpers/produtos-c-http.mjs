// HTTP helpers of the produtos lane, wave C: the Worker against the real SQL in PGlite (realHandler) or against a fixed
// upstream answer (fakeHandler). Synthetic users only; no request data is logged.
import { createHandler } from '../../src/index.mjs';

export const env = { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-server-key', ALLOWED_ORIGINS: 'https://erp.example.test' };
const ARRAYS = new Set(['p_ids', 'p_product_ids', 'p_sale_statuses']);
export function realHandler(f) {
  const calls = [];
  const handler = createHandler({ fetchImpl: async (url, options) => {
    if (url.endsWith('/auth/v1/user')) return new Response(JSON.stringify({ id: f.users[options.headers.Authorization.split('-').at(-1)] }));
    const name = new URL(url).pathname.split('/').at(-1), args = Object.entries(JSON.parse(options.body)); calls.push({ name, args: Object.fromEntries(args) });
    await f.db.exec('SET ROLE service_role');
    try {
      // PostgREST turns JSON arrays into PostgreSQL arrays for array parameters; the rest travels as JSON.
      const result = await f.db.query(`SELECT public.${name}(${args.map(([key], index) => `${key} => $${index + 1}`).join(',')}) AS value`,
        args.map(([key, value]) => ARRAYS.has(key) && Array.isArray(value) ? value : value && typeof value === 'object' ? JSON.stringify(value) : value));
      return new Response(JSON.stringify(result.rows[0].value));
    } catch (error) { return new Response(JSON.stringify({ code: error.code, message: 'private SQL details' }), { status: 400 }); }
    finally { await f.db.exec('RESET ROLE'); }
  } });
  const call = async (path, method = 'GET', data, actor = 'admin') => {
    const response = await handler(new Request(`https://api.example.test${path}`, { method, headers: { Authorization: `Bearer synthetic-${actor}`, ...(data ? { 'Content-Type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : undefined }), env);
    return { status: response.status, data: await response.json() };
  };
  return { call, calls };
}
export function fakeHandler(result) {
  const calls = [];
  return { calls, handler: createHandler({ fetchImpl: async (url, options) => { calls.push({ url, body: options.body });
    return new Response(JSON.stringify(url.endsWith('/auth/v1/user') ? { id: 'a0000000-0000-4000-8000-000000000001' } : typeof result === 'function' ? result(JSON.parse(options.body)) : result)); } }) };
}
export const request = (path, method = 'GET', body) => new Request(`https://api.example.test${path}`, { method, headers: { Authorization: 'Bearer synthetic-user', Origin: 'https://erp.example.test', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
export const rpcOf = call => call.url.split('/').at(-1);
export const upstream = calls => calls.filter(call => !call.url.endsWith('/auth/v1/user'));
