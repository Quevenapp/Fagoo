import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { prepareProtocolQuery } from '../src/index.mjs';
import { buildAccessKey } from '../../fiscal-core/src/identity.mjs';
import { identity } from '../../fiscal-core/test/fixtures.mjs';

const query = (overrides = {}) => prepareProtocolQuery({ accessKey: buildAccessKey(identity), expectedModel: '55', environment: '2', requestId: 'query_test_01', ...overrides });
test('protocol query binds the existing key and exact SP/model/homologation endpoint without sending', () => {
  for (const expectedModel of ['55', '65']) {
    const key = buildAccessKey({ ...identity, model: expectedModel });
    const plan = query({ accessKey: key, expectedModel });
    assert.ok(Object.isFrozen(plan));
    assert.match(plan.xml, new RegExp(`<chNFe>${key}</chNFe>`));
    assert.equal(plan.xmlDigest, createHash('sha256').update(plan.xml).digest('hex'));
    assert.equal(new URL(plan.endpoint).hostname, expectedModel === '55' ? 'homologacao.nfe.fazenda.sp.gov.br' : 'homologacao.nfce.fazenda.sp.gov.br');
    assert.equal(plan.canTransmit, false); assert.equal(plan.requiresMutualTls, true);
    assert.equal(plan.xml.includes('SOAP'), false);
  }
});
test('queries cannot switch production/model/UF or inject an unvalidated key/request id', () => {
  for (const input of [{ environment: '1' }, { expectedModel: 55 }, { expectedModel: '65' },
    { accessKey: buildAccessKey({ ...identity, cUF: '33' }) }, { accessKey: buildAccessKey(identity).slice(0, 43) + 'X' },
    { accessKey: '<chNFe/>' }, { requestId: '<xml>' }, { requestId: '' }]) assert.throws(() => query(input));
});
test('normal-emission query profile accepts alphanumeric keys but refuses contingency and special series', () => {
  const key = buildAccessKey({ ...identity, cnpj: '12ABC34501DE35' });
  assert.equal(query({ accessKey: key }).accessKey, key);
  assert.throws(() => query({ accessKey: buildAccessKey({ ...identity, tpEmis: '6' }) }), /QUERY_PROFILE_UNSUPPORTED/);
  assert.throws(() => query({ accessKey: buildAccessKey({ ...identity, series: '890' }) }), /QUERY_PROFILE_UNSUPPORTED/);
});
