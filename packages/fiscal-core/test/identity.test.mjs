import test from 'node:test';
import assert from 'node:assert/strict';
import { accessKeyCheckDigit, buildAccessKey, cnpjCheckDigits, emissionIdentityKey, inspectAccessKey, isValidCnpj, randomNumericCode, validateFiscalIdentity } from '../src/index.mjs';
import { identity } from './fixtures.mjs';

test('official MOC mod11 example yields DV 5, independently of current emission eligibility', () => {
  // MOC 7.0 Visão Geral pp. 19–20: sum=644, remainder=6, DV=5. Historical tpEmis=0.
  assert.equal(accessKeyCheckDigit('5206043300991100250655012000000780026730161'), '5');
  assert.equal(inspectAccessKey('52060433009911002506550120000007800267301615').valid, false);
});

test('official Receita alphanumeric CNPJ example yields 35 and numeric CNPJ remains compatible', () => {
  assert.equal(cnpjCheckDigits('12ABC34501DE'), '35');
  assert.equal(isValidCnpj('12ABC34501DE35'), true);
  assert.equal(isValidCnpj(identity.cnpj), true);
  for (const value of ['00000000000000', '11111111111111', '12.ABC.345/01DE-35', '12abc34501de35', '12ABC34501DE34', 12345678000195, null]) assert.equal(isValidCnpj(value), false);
});

test('access key preserves the local issuance month and matches all identity fields', () => {
  const key = buildAccessKey({ ...identity, issuedAt: '2026-10-31T23:30:00-03:00' });
  assert.equal(key.length, 44);
  assert.equal(key.slice(2, 6), '2610');
  const result = inspectAccessKey(key);
  assert.equal(result.valid, true);
  assert.equal(result.parts.series, '001');
  assert.equal(result.parts.number, '000000123');
  assert.equal(result.parts.model, '55');
  const bad = key.slice(0, 43) + (key.endsWith('0') ? '1' : '0');
  assert.equal(inspectAccessKey(bad).valid, false);
  assert.equal(inspectAccessKey(`NFe${key}`).valid, false);
});

test('model 65 and CNPJ alphanumeric keys use the official 44-position format', () => {
  const key = buildAccessKey({ ...identity, cnpj: '12ABC34501DE35', model: '65' });
  assert.match(key, /^[0-9]{6}[A-Z0-9]{12}[0-9]{26}$/);
  assert.equal(inspectAccessKey(key).valid, true);
  assert.equal(inspectAccessKey(key).parts.cnpj, '12ABC34501DE35');
});

test('identity refuses invalid structural values without echoing inputs in errors', () => {
  for (const change of [{ cUF: '99' }, { model: '57' }, { environment: '0' }, { series: -1 }, { series: 1000 }, { series: '1e2' }, { number: 0 }, { number: 1e9 }, { number: 1.5 }, { issuedAt: '2026-02-30T01:00:00-03:00' }, { issuedAt: '2026-10-15' }, { issuedAt: '2026-10-15T25:00:00Z' }, { cNF: 12345678 }, { cNF: '1234' }, { model: '65', tpEmis: '6' }, { cnpj: '<private>' }]) {
    const result = validateFiscalIdentity({ ...identity, ...change });
    assert.equal(result.valid, false, JSON.stringify(change));
    assert.doesNotMatch(JSON.stringify(result), /private/);
    assert.throws(() => buildAccessKey({ ...identity, ...change }), /FISCAL_IDENTITY_INVALID/);
  }
  assert.equal(validateFiscalIdentity({ ...identity, issuedAt: '2028-02-29T00:00:00Z', series: 0, number: 999999999 }).valid, true);
});

test('application identity prevents duplicate numbering when date or random code changes, and separates environments', () => {
  assert.equal(emissionIdentityKey(identity), emissionIdentityKey({ ...identity, cNF: '87654321', issuedAt: '2026-11-01T00:00:00-03:00' }));
  assert.notEqual(emissionIdentityKey(identity), emissionIdentityKey({ ...identity, environment: '1' }));
  assert.equal(buildAccessKey(identity), buildAccessKey({ ...identity, environment: '1' }));
});

test('random code rejects the biased tail and preserves leading zeroes', () => {
  const samples = [0xffffffff, 42]; let calls = 0;
  assert.equal(randomNumericCode({ getRandomValues: array => { array[0] = samples[calls++]; return array; } }), '00000042');
  assert.equal(calls, 2);
});
