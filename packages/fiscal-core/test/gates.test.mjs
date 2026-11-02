import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateEmissionGates, NFCE_SP_HOMOLOGATION_QR_V3, nfceQrProfile } from '../src/index.mjs';
import { identity, config, now } from './fixtures.mjs';

test('complete synthetic metadata permits preparation but never enables transmission', () => {
  const result = evaluateEmissionGates(identity, config, now);
  assert.equal(result.configurationReady, true);
  assert.equal(result.canTransmit, false);
  assert.deepEqual(result.transmissionBlockers, ['TRANSPORT_NOT_IMPLEMENTED']);
});

test('unknown regime, missing A1, wrong issuer, expired certificate and missing accreditation block preparation', () => {
  for (const [change, code] of [
    [{ taxRegime: { crt: 3, confirmed: false } }, 'TAX_REGIME_UNCONFIRMED'],
    [{ certificate: {} }, 'VERIFIED_A1_REQUIRED'],
    [{ certificate: { ...config.certificate, cnpj: '12ABC34501DE35' } }, 'CERTIFICATE_ISSUER_MISMATCH'],
    [{ certificate: { ...config.certificate, validUntil: '2026-10-15T00:00:00Z' } }, 'CERTIFICATE_OUTSIDE_VALIDITY'],
    [{ accreditation: {} }, 'ACCREDITATION_UNCONFIRMED'],
    [{ schemaProfile: {} }, 'CURRENT_SCHEMA_PROFILE_UNCONFIRMED'],
    [{ taxRulesReviewed: false }, 'TAX_RULES_UNREVIEWED'],
  ]) {
    const result = evaluateEmissionGates(identity, { ...config, ...change }, now);
    assert.equal(result.configurationReady, false);
    assert.ok(result.errors.includes(code));
  }
});

test('legacy NFC-e configuration requires CSC bound to environment; production requires model-specific homologation', () => {
  assert.equal(evaluateEmissionGates({ ...identity, model: '65' }, config, now).configurationReady, true);
  const result = evaluateEmissionGates({ ...identity, model: '65', environment: '1' }, config, now);
  for (const code of ['CSC_FOR_ENVIRONMENT_REQUIRED', 'HOMOLOGATION_EVIDENCE_REQUIRED', 'PRODUCTION_NOT_ENABLED']) assert.ok(result.errors.includes(code));
  assert.equal(evaluateEmissionGates(identity, { ...config, csc: {} }, now).configurationReady, true);
});

test('explicit online SP homologation QR v3 format has no CSC and never authorizes transmission', () => {
  const selected = { ...config, csc: {}, nfceQrProfile: NFCE_SP_HOMOLOGATION_QR_V3 };
  const id = { ...identity, model: '65' };
  const result = evaluateEmissionGates(id, selected, now);
  assert.equal(result.configurationReady, true);
  assert.equal(result.canTransmit, false);
  assert.deepEqual(result.transmissionBlockers, ['TRANSPORT_NOT_IMPLEMENTED']);
  assert.equal(nfceQrProfile(id, selected.nfceQrProfile).cscRequired, false);
  assert.equal(Object.isFrozen(nfceQrProfile(id, selected.nfceQrProfile)), true);
  for (const missing of [{certificate: {}}, {accreditation: {}}, {schemaProfile: {}}, {taxRulesReviewed: false}]) {
    assert.equal(evaluateEmissionGates(id, {...selected, ...missing}, now).configurationReady, false);
  }
});

test('QR v3 scope never extends to other environments, UF, contingency or unrecognized profiles', () => {
  const selected = { ...config, nfceQrProfile: NFCE_SP_HOMOLOGATION_QR_V3 };
  const id = { ...identity, model: '65' };
  for (const change of [{environment:'1'}, {cUF:'33'}, {tpEmis:'9'}]) {
    const result = evaluateEmissionGates({...id,...change}, selected, now);
    assert.equal(result.configurationReady, false);
    assert.ok(result.errors.includes('NFCE_QR_PROFILE_UNSUPPORTED'));
    assert.equal(nfceQrProfile({...id,...change},selected.nfceQrProfile), null);
  }
  for (const value of ['3', true, null, {}, 'sp-production-online-qr-v3']) {
    assert.ok(evaluateEmissionGates(id, {...selected,nfceQrProfile:value}, now).errors.includes('NFCE_QR_PROFILE_UNSUPPORTED'));
  }
  assert.equal(nfceQrProfile(identity,selected.nfceQrProfile), null);
});

test('reserved series, other states, contingency and invalid clock cannot pass implementation gates', () => {
  for (const [change, code] of [[{ series: 900 }, 'SERIES_RESERVED_FOR_OTHER_ISSUERS'], [{ cUF: '33' }, 'UF_NOT_IMPLEMENTED'], [{ tpEmis: '6' }, 'CONTINGENCY_NOT_IMPLEMENTED']]) {
    assert.ok(evaluateEmissionGates({ ...identity, ...change }, config, now).errors.includes(code));
  }
  assert.equal(evaluateEmissionGates(identity, config, new Date(NaN)).configurationReady, false);
});

test('malformed configuration and impossible certificate calendar dates produce blocking reports', () => {
  for (const malformed of [null, [], true, 'invalid', { certificate: [] }, { schemaProfile: { id: 'profile', reviewed: true, models: '55' } }]) {
    assert.equal(evaluateEmissionGates(identity, malformed, now).configurationReady, false);
  }
  const invalidDate = { ...config, certificate: { ...config.certificate, validFrom: '2026-02-30T00:00:00Z' } };
  assert.ok(evaluateEmissionGates(identity, invalidDate, now).errors.includes('CERTIFICATE_OUTSIDE_VALIDITY'));
  assert.equal(evaluateEmissionGates(identity, { ...config, certificate: { ...config.certificate, validUntil: '2027-01-01T00:00:00.000Z' } }, now).configurationReady, true);
});
