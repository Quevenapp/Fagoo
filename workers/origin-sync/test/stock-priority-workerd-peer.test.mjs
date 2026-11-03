import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

test('peer workerd: real priority scheduler and client make only nine stubbed stock GETs for 75 products', {
  skip: process.env.BRUFAP_RUN_WORKERD_TESTS !== '1', timeout: 30000,
}, async () => {
  const { Miniflare, convertV4MiniflareOptions } = await import('miniflare');
  const { build } = await import('esbuild');
  const path = value => fileURLToPath(new URL(value, import.meta.url));
  const bundle = await build({ stdin: { contents: `
    import {OriginClient} from ${JSON.stringify(path('../src/client.mjs'))};
    import {runSync} from ${JSON.stringify(path('../src/sync.mjs'))};
    import {getResource} from ${JSON.stringify(path('../src/resources.mjs'))};
    export default {async fetch() {
      const states = new Map(), commits = [], seenOptions = [];
      const ids = Array.from({length:100}, (_,i) => String(100001+i));
      const repo = {
        async claim(resource) {return {acquired:true,lease_token:'synthetic',checkpoint_version:1,checkpoint:states.get(resource)??{}};},
        async renew() {}, async release() {},
        async rpc(name,args) {
          if(name==='origin_sync_renew') return {};
          if(name!=='origin_sync_stock_product_page') throw Error('UNEXPECTED_RPC');
          const remaining=ids.filter(v=>args.p_after===null||v>args.p_after), items=remaining.slice(0,25), more=remaining.length>25;
          return {items,has_more:more,next_cursor:more?items.at(-1):null,coverage_complete:false};
        },
        async apply(resource,entity,owner,lease,records,checkpoint) {
          if(!['control','stock_balances'].includes(entity)) throw Error('UNEXPECTED_WRITE');
          states.set(resource,structuredClone(checkpoint));
          commits.push({resource,ids:records.map(r=>r.source_id),checkpoint});return {inserted:records.length};
        }
      };
      class Client extends OriginClient {
        constructor(token,opts) {super(token,{...opts,intervalMs:0});}
        get(path,params,opts) {seenOptions.push({path,maxAttempts:opts?.maxAttempts});return super.get(path,params,opts);}
      }
      const result=await runSync(repo,{ORIGIN_ENABLED: 'true', ORIGIN_API_ORIGIN: 'https://api.provider.example', SYNC_ENABLED: 'true',EXTRA_RESOURCES_ENABLED:'true',STOCK_PRIORITY_ENABLED:'true',SYNC_START_DATE:'2024-01-01',MAX_API_REQUESTS:'240'},
        {Client,getToken:async()=> 'synthetic-only',resources:[getResource('stock_balances')]});
      return Response.json({result,commits,seenOptions});
    }};`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'silent' });
  const upstream = [];
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-10-15', cf: false,
    outboundService(request) {
      const u = new URL(request.url);
      assert.equal(u.origin, 'https://api.provider.example'); assert.equal(u.pathname, '/Api/v3/estoques/saldos');
      assert.equal(request.method, 'GET');
      const ids = u.searchParams.getAll('idsProdutos[]'), partition = u.searchParams.get('filtroSaldoEstoque');
      assert.equal(ids.length, 25); assert.ok(['0', '1', '2'].includes(partition));
      upstream.push({ ids, partition });
      return Response.json({ data: partition === '0' ? ids.map(id => ({ produto: { id }, saldoFisicoTotal: 0, depositos: [] })) : [] });
    },
  }));
  try {
    const response = await mf.dispatchFetch('https://synthetic.invalid/'); assert.equal(response.status, 200);
    const value = await response.json(), phase = value.result.stock_priority;
    assert.equal(phase.batches, 3); assert.equal(phase.requests, 9); assert.equal(phase.returned, 75);
    assert.equal(phase.coverage_complete, false); assert.equal(value.result.requests, 9);
    assert.equal(upstream.length, 9); assert.ok(value.seenOptions.every(v => v.maxAttempts === 1));
    const stock = value.commits.filter(v => v.resource === 'stock_balances');
    assert.deepEqual(stock.map(v => v.checkpoint.unfiltered.after), ['100025', '100050', '100075']);
    assert.equal(new Set(stock.flatMap(v => v.ids)).size, 75);
    assert.ok(stock.every(v => v.checkpoint.last_observation.coverage_complete === false));
    assert.equal(value.commits.at(-1).resource, '__scheduler__');
  } finally { await mf.dispose(); }
});
