import test from 'node:test';
import assert from 'node:assert/strict';
import {createWsdlPreparationDiagnostic} from '../src/preparation-diagnostic.mjs';

test('diagnostic is one closed bounded line and never serializes an error or supplied details', () => {
  const lines = []; let clock = 1, touched = 0;
  const failure = {code: 'WSDL_RPC_TIMEOUT', secret: 'PRIVATE_PASSWORD', id: 'PRIVATE_ID',
    get message() { touched++; throw Error('PRIVATE_MESSAGE'); },
    get stack() { touched++; throw Error('PRIVATE_STACK'); },
    toJSON() { touched++; return 'PRIVATE_JSON'; }};
  const report = createWsdlPreparationDiagnostic(value => lines.push(value), () => clock);
  clock = 12.9; report('authorization_replay', failure); report('envelope_open', failure);
  assert.equal(lines.length, 1); assert.ok(Buffer.byteLength(lines[0]) <= 256);
  assert.deepEqual(JSON.parse(lines[0]), {event: 'wsdl_preparation_failed', version: 1,
    phase: 'authorization_replay', code: 'deadline_exceeded', elapsed_ms: 11});
  assert.equal(touched, 0); assert.doesNotMatch(lines[0], /PRIVATE|WSDL_RPC_TIMEOUT/);
});

test('unknown codes, accessors, inherited codes, proxies and coercions cannot enter diagnostics', () => {
  let touched = 0;
  const candidates = [null, 'PRIVATE_RAW_STRING', {code: 'PRIVATE_CODE'}, {code: 'x'.repeat(100000)},
    {get code() { touched++; return '42501'; }}, Object.create({code: '42501'}),
    new Proxy({}, {getOwnPropertyDescriptor() { throw Error('PRIVATE_PROXY'); }}),
    {code: {toString() { touched++; return '42501'; }}}];
  for (const value of candidates) {
    const lines = [], phase = {toString() { touched++; return 'authorization_replay'; }};
    createWsdlPreparationDiagnostic(x => lines.push(x), () => 1)(phase, value);
    assert.deepEqual(JSON.parse(lines[0]), {event: 'wsdl_preparation_failed', version: 1,
      phase: 'input_validation', code: 'unclassified', elapsed_ms: 0});
  }
  assert.equal(touched, 0);
});

test('only explicit local TLS and certificate codes refine the observed phase', () => {
  for (const [code, phase, reason] of [
    ['VAULT_TLS_CONTEXT_CREATION_FAILED', 'tls_local', 'tls_context_creation_failed'],
    ['VAULT_TLS_CONTEXT_FACTORY_INVALID', 'tls_local', 'tls_context_invalid'],
    ['VAULT_TLS_CLIENT_USAGE_EXCLUDED', 'certificate_binding', 'certificate_usage_rejected'],
    ['VAULT_PFX_REJECTED', 'pkcs12_validation', 'pkcs12_rejected'],
    ['VAULT_TLS_PRIVATE_UNKNOWN', 'pkcs12_validation', 'unclassified'],
  ]) {
    let line; createWsdlPreparationDiagnostic(x => { line = x; }, () => 0)('pkcs12_validation', {code});
    assert.equal(JSON.parse(line).phase, phase); assert.equal(JSON.parse(line).code, reason);
  }
});

test('diagnostic elapsed time is an integer between zero and thirty seconds', () => {
  for (const [start, finish, expected] of [[1, 0, 0], [0, 999999, 30000], [4, 8.9, 4], [NaN, Infinity, 0]]) {
    let calls = 0, line;
    createWsdlPreparationDiagnostic(x => { line = x; }, () => calls++ === 0 ? start : finish)('envelope_open', null);
    assert.equal(JSON.parse(line).elapsed_ms, expected);
  }
  let line; createWsdlPreparationDiagnostic(x => { line = x; }, () => { throw Error('PRIVATE_CLOCK'); })('envelope_open', null);
  assert.equal(JSON.parse(line).elapsed_ms, 0);
});

test('a throwing or asynchronous sink cannot propagate, block or assimilate returned thenables', async () => {
  let calls = 0, assimilated = 0;
  const throwing = createWsdlPreparationDiagnostic(() => { calls++; throw Error('PRIVATE_SINK'); });
  assert.doesNotThrow(() => throwing('envelope_open', null)); throwing('envelope_open', null);
  assert.equal(calls, 1);
  createWsdlPreparationDiagnostic(() => Promise.reject(Error('PRIVATE_ASYNC_SINK')))('envelope_open', null);
  createWsdlPreparationDiagnostic(() => ({get then() { assimilated++; throw Error('PRIVATE_THENABLE'); }}))('envelope_open', null);
  createWsdlPreparationDiagnostic(undefined)('envelope_open', null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(assimilated, 0);
});
