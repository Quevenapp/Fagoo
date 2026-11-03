import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccessController } from '../src/lib/real-access.ts';
const user = 'a0000000-0000-4000-8000-000000000001';
const auth = { getSession: async () => ({ data: { session: { access_token: 'synthetic-token', user: { id: user } } }, error: null }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), signInWithPassword: async () => ({ data: { session: null }, error: null }), signOut: async () => ({ error: null }) };
const me = () => new Response(JSON.stringify({ user_id: user, role: 'fiscal', resources: ['nfe'], data_mode: 'staging_readonly' }));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('history JSON and Blob use authenticated GET only; private records are not added to the controller state', async () => {
  const calls = [];
  const controller = createAccessController(auth, 'https://api.example.test', async (url, options) => {
    calls.push(options); return url.endsWith('/me') ? me() : new Response(url.endsWith('/download') ? '<xml>synthetic</xml>' : JSON.stringify({ items: [{ private: 'memory-only' }] }));
  });
  const stop = controller.start(); await tick();
  assert.deepEqual(await controller.history('/v1/history/backups'), { items: [{ private: 'memory-only' }] });
  const file = await controller.historyDownload('/v1/history/xml/synthetic/download'); assert.equal(await file.text(), '<xml>synthetic</xml>');
  assert.equal(calls.at(-1).method, 'GET'); assert.equal(calls.at(-1).credentials, 'omit'); assert.equal(calls.at(-1).redirect, 'error'); assert.equal(calls.at(-1).cache, 'no-store');
  assert.doesNotMatch(JSON.stringify(controller.getSnapshot()), /memory-only|synthetic-token/);
  await assert.rejects(() => controller.history('https://evil.example.test'), error => error.status === 400); stop();
});

test('history limits download/JSON size, clears permissions only after membership revocation is confirmed and aborts late downloads on logout', async () => {
  for (const [download, size] of [[false, 1024 * 1024 + 1], [true, 8 * 1024 * 1024 + 1]]) {
    const controller = createAccessController(auth, 'https://api.example.test', async url => url.endsWith('/me') ? me() : new Response('x', { headers: { 'Content-Length': String(size) } }));
    const stop = controller.start(); await tick(); await assert.rejects(() => download ? controller.historyDownload('/v1/history/xml/x/download') : controller.history('/v1/history/backups'), error => error.status === 502); stop();
  }
  let membershipChecks=0;
  const forbidden = createAccessController(auth, 'https://api.example.test', async url => url.endsWith('/me')&&++membershipChecks===1 ? me() : new Response('{}', { status: 403 }));
  const stopDenied = forbidden.start(); await tick(); await assert.rejects(() => forbidden.history('/v1/history/backups')); await tick(); assert.equal(forbidden.getSnapshot().phase, 'pending'); assert.equal(forbidden.getSnapshot().membership, null); stopDenied();
  let resolve; let signal;
  const controller = createAccessController(auth, 'https://api.example.test', async (url, options) => { if (url.endsWith('/me')) return me(); signal = options.signal; return new Promise(next => { resolve = next; }); });
  const stop = controller.start(); await tick(); const request = controller.historyDownload('/v1/history/xml/x/download'); await controller.logout(); assert.equal(signal.aborted, true);
  resolve(new Response('private late bytes')); await assert.rejects(request, error => error.name === 'AbortError'); assert.equal(controller.getSnapshot().phase, 'signed_out'); stop();
});
