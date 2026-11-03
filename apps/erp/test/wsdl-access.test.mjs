import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccessController, AccessError} from '../src/lib/real-access.ts';
import {mountComponent} from './helpers/component-recovery-harness.mjs';
import {configured, company, envelope} from './helpers/a1-fixtures.mjs';
import {result} from '../../../packages/fiscal-wsdl-runtime/test/fixtures.mjs';

const actor = 'a0000000-0000-4000-8000-000000000099';
const otherActor = 'a0000000-0000-4000-8000-000000000098';
const token = 'synthetic-wsdl-session-token-123456789';
const nextToken = 'synthetic-wsdl-refreshed-token-123456789';
const session = (access_token = token, id = actor) => ({access_token, user: {id}});
const member = (role = 'admin', id = actor) => ({user_id: id, role, resources: ['nfe', 'nfce'], data_mode: 'staging_readonly'});
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) { for (let i = 0; i < 150 && !predicate(); i++) await tick(); assert.ok(predicate()); }
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };
const copy = structuredClone;

function setup({before = () => {}, after = () => {}, role = 'admin', origin = true} = {}) {
  const state = {role, actor, commands: new Map(), calls: [], phases: []};
  let onSession = () => {};
  const auth = {
    getSession: async () => ({data: {session: session()}, error: null}),
    onAuthStateChange(fn) { onSession = fn; return {data: {subscription: {unsubscribe() {}}}}; },
    signOut: async () => { onSession('SIGNED_OUT', null); return {error: null}; },
    signInWithPassword: async () => ({data: {session: null}, error: null}),
  };
  const controller = createAccessController(auth, 'https://erp.synthetic.invalid', async (url, options) => {
    const call = {url, options, body: options.body ? JSON.parse(options.body) : undefined};
    state.calls.push(call);
    const override = await before(call, state); if (override) return override;
    let value;
    if (url.endsWith('/v1/me')) value = member(state.role, state.actor);
    else if (url.endsWith('/v1/a1')) value = envelope(copy(configured));
    else if (url.endsWith('/v1/empresa/identidade')) value = copy(company);
    else if (url.endsWith('/v1/fiscal-wsdl/run')) {
      value = result('stored', call.body); state.commands.set(call.body.command_id, copy(value));
    } else {
      assert.match(url, /^https:\/\/gateway\.synthetic\.invalid\/v1\/fiscal-wsdl\/commands\/[a-f0-9-]{36}$/);
      const stored = state.commands.get(url.split('/').at(-1));
      if (!stored) return Response.json({error: 'WSDL_NOT_FOUND', recovery_required: false}, {status: 404});
      value = {...copy(stored), read_only: true, recovered: false};
    }
    return await after(call, state, value) ?? Response.json(value);
  }, origin ? {a1ApiUrl: 'https://gateway.synthetic.invalid'} : {});
  const stop = controller.start(), unsubscribe = controller.subscribe(() => state.phases.push(controller.getSnapshot().phase));
  return {...state, controller, state, emit: (event, value) => onSession(event, value), close() { unsubscribe(); stop(); }};
}
const runCalls = f => f.calls.filter(c => c.url.endsWith('/v1/fiscal-wsdl/run'));
const lookupCalls = f => f.calls.filter(c => c.url.includes('/v1/fiscal-wsdl/commands/'));
const mount = f => mountComponent('SefazConnection.tsx', {controller: f.controller}, {ports: {AccessError}});
async function confirm(view, operation='protocol') {
  view.find(node => node.type === 'select' && node.props.id.endsWith('-model')).props.onChange({target: {value: '55'}});
  view.find(node => node.type === 'select' && node.props.id.endsWith('-operation')).props.onChange({target: {value: operation}}); await view.flush();
  view.find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({target: {checked: true}}); await view.flush();
}
const body = () => ({command_id: 'a0000000-0000-4000-8000-000000000091', model: '55', operation: 'protocol', expected_a1_version: 1, expected_identity_version: 2, confirmed: true});

test('051 controller preserves the UI command after dispatched 403 and revalidates membership without remounting', async () => {
  let fail = true;
  const f = setup({after(call) { if (call.url.endsWith('/run') && fail) { fail = false; return Response.json({error: 'WSDL_FORBIDDEN', recovery_required: true}, {status: 403}); } }});
  try {
    await until(() => f.controller.getSnapshot().phase === 'ready'); const view = await mount(f);
    try {
      f.phases.length = 0; await confirm(view,'authorization'); await view.click('Verificar conexão');
      await until(() => f.calls.filter(c => c.url.endsWith('/v1/me')).length === 2); await view.flush();
      assert.equal(view.guard().busy, true); assert.equal(lookupCalls(f).length, 0); assert.ok(f.phases.every(p => p === 'ready'));
      const id = runCalls(f)[0].body.command_id;
      await view.click('Conferir resultado');
      assert.equal(view.guard().busy, false); assert.equal(runCalls(f).length, 1); assert.equal(f.commands.size, 1);
      assert.equal(lookupCalls(f)[0].url.split('/').at(-1), id);
      assert.equal(runCalls(f)[0].body.operation,'authorization');
      assert.match(view.text(), /não significa homologação concluída/);
    } finally { view.unmount(); }
  } finally { f.close(); }
});

test('051 same-actor refresh preserves in-flight intent and waits for fresh membership before the command GET', async () => {
  const runGate = gate(), meGate = gate(); let hold = true;
  const f = setup({before(call) { if (call.url.endsWith('/v1/me') && call.options.headers.Authorization === `Bearer ${nextToken}`) return meGate.promise; },
    after(call) { if (call.url.endsWith('/run') && hold) { hold = false; return runGate.promise; } }});
  try {
    await until(() => f.controller.getSnapshot().phase === 'ready'); const view = await mount(f);
    try {
      await confirm(view,'receipt'); view.button('Verificar conexão').props.onClick(); await until(() => f.commands.size === 1);
      const sent = runCalls(f)[0], ack = copy(f.commands.get(sent.body.command_id));
      f.emit('TOKEN_REFRESHED', session(nextToken)); await tick();
      assert.equal(sent.options.signal.aborted, false);
      runGate.resolve(Response.json(ack)); await view.flush();
      assert.equal(view.guard().busy, true); assert.equal(lookupCalls(f).length, 0);
      meGate.resolve(Response.json(member())); await view.flush();
      assert.equal(view.guard().busy, false); assert.equal(runCalls(f).length, 1);
      assert.equal(lookupCalls(f)[0].options.headers.Authorization, `Bearer ${nextToken}`);
      assert.equal(lookupCalls(f)[0].url.split('/').at(-1), sent.body.command_id);
      assert.equal(sent.body.operation,'receipt');
    } finally { view.unmount(); }
  } finally { runGate.resolve(Response.json({})); meGate.resolve(Response.json(member())); f.close(); }
});

test('051 confirmed access revocation prevents lookup of the former actor command', async () => {
  let revoked = false;
  const f = setup({before(call) { if (call.url.endsWith('/v1/me') && revoked) return Response.json({error: 'forbidden'}, {status: 403}); },
    after(call) { if (call.url.endsWith('/run')) { revoked = true; return Response.json({error: 'WSDL_FORBIDDEN', recovery_required: true}, {status: 403}); } }});
  try {
    await until(() => f.controller.getSnapshot().phase === 'ready'); const view = await mount(f);
    try {
      await confirm(view); await view.click('Verificar conexão'); await until(() => f.controller.getSnapshot().phase !== 'ready');
      await view.updateProps({}); assert.match(view.text(), /perfil não permite/);
      assert.equal(lookupCalls(f).length, 0); assert.equal(runCalls(f).length, 1);
      assert.equal(f.commands.size, 1); // Revocation does not claim the prior operation was undone.
    } finally { view.unmount(); }
  } finally { f.close(); }
});

test('051 actor switch fences a late ACK and neither renders it nor looks it up under the new session', async () => {
  const response = gate(); const f = setup({after(call) { if (call.url.endsWith('/run')) return response.promise; }});
  try {
    await until(() => f.controller.getSnapshot().phase === 'ready'); const view = await mount(f);
    try {
      await confirm(view); view.button('Verificar conexão').props.onClick(); await until(() => f.commands.size === 1);
      const sent = runCalls(f)[0], ack = copy(f.commands.get(sent.body.command_id));
      f.state.actor = otherActor; f.emit('SIGNED_IN', session(nextToken, otherActor));
      await until(() => f.controller.getSnapshot().membership?.user_id === otherActor);
      response.resolve(Response.json(ack)); await view.flush(); await view.updateProps({});
      assert.equal(sent.options.signal.aborted, true); assert.equal(lookupCalls(f).length, 0);
      assert.match(view.text(), /perfil não permite/); assert.doesNotMatch(view.text(), /Consulta guardada/);
    } finally { view.unmount(); }
  } finally { response.resolve(Response.json({})); f.close(); }
});

test('051 controller snapshots body/signal before lazy import and never dispatches for forbidden roles or routes', async () => {
  const f = setup();
  try {
    await until(() => f.controller.getSnapshot().phase === 'ready');
    const original = new AbortController(), counts = {add: 0, remove: 0};
    const add = original.signal.addEventListener.bind(original.signal), remove = original.signal.removeEventListener.bind(original.signal);
    original.signal.addEventListener = (...args) => { counts.add++; return add(...args); };
    original.signal.removeEventListener = (...args) => { counts.remove++; return remove(...args); };
    const data = body(), expected = copy(data), options = {method: 'POST', body: data, signal: original.signal};
    const pending = f.controller.wsdl('/v1/fiscal-wsdl/run', options);
    data.model = '65'; data.operation = 'authorization'; data.expected_a1_version = 9; options.body = {}; options.signal = new AbortController().signal;
    const observed = await pending; assert.equal(observed.receipt.a1_version, 1);
    assert.deepEqual(runCalls(f)[0].body, expected); assert.deepEqual(counts, {add: 1, remove: 1});
    let touched = 0; const accessor = Object.defineProperty({method: 'POST'}, 'body', {enumerable: true, get() { touched++; return body(); }});
    await assert.rejects(f.controller.wsdl('/v1/fiscal-wsdl/run', accessor), e => e.status === 400); assert.equal(touched, 0);
    const cancel = new AbortController(), stopped = f.controller.wsdl('/v1/fiscal-wsdl/run', {method: 'POST', body: body(), signal: cancel.signal});
    const rejected = assert.rejects(stopped, e => e.name === 'AbortError'); cancel.abort(); await rejected;
    assert.equal(runCalls(f).length, 1);
  } finally { f.close(); }
  for (const role of ['consulta', 'financeiro', 'vendas', 'estoque']) {
    const denied = setup({role}); try {
      await until(() => denied.controller.getSnapshot().phase === 'ready');
      await assert.rejects(denied.controller.wsdl('/v1/fiscal-wsdl/run', {method: 'POST', body: body()}), e => e.status === 403);
      assert.equal(runCalls(denied).length, 0);
    } finally { denied.close(); }
  }
});

test('051 controller accepts the three explicit service choices for both models without exposing arbitrary operations',async()=>{
 const f=setup();try{
  await until(()=>f.controller.getSnapshot().phase==='ready');
  for(const model of ['55','65'])for(const operation of ['protocol','authorization','receipt']){
   const input={...body(),command_id:crypto.randomUUID(),model,operation};
   const ack=await f.controller.wsdl('/v1/fiscal-wsdl/run',{method:'POST',body:input});
   const read=await f.controller.wsdl('/v1/fiscal-wsdl/commands/'+input.command_id);
   assert.equal(ack.receipt.operation,operation);assert.equal(read.receipt.operation,operation);assert.equal(read.receipt.model,model);
   assert.equal(read.read_only,true);assert.equal(read.can_emit,false);assert.equal(read.can_transmit,false);
  }
  assert.equal(runCalls(f).length,6);assert.equal(lookupCalls(f).length,6);
  for(const operation of ['status','send','protocol?x=1',['authorization']])await assert.rejects(f.controller.wsdl('/v1/fiscal-wsdl/run',{method:'POST',body:{...body(),operation}}),e=>e.status===400);
  assert.equal(runCalls(f).length,6);
 }finally{f.close();}
});
