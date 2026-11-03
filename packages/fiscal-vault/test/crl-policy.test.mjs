import test from 'node:test';
import assert from 'node:assert/strict';
import { createOfflineCrlValidator } from '../src/crl-policy.mjs';
import { binary, HOLDER } from './trust-fixtures.mjs';
import { trustFixture, makeCrl, complete, reissue, largeCrl, signedTbs, noncanonicalAlgorithmCrl, ext, asn, pki, NOW } from './crl-fixtures.mjs';
const base = await trustFixture();
const validator = (f = base, options = {}) => createOfflineCrlValidator({ binaryPath: binary, customTrustAnchors: [f.root.certificate], ...options });
const unknown = result => { assert.equal(result.state, 'unknown'); assert.equal(result.all_non_anchor_certificates_checked, false); assert.equal(result.can_transmit, false); };

test('all non-anchor certificates need current signed complete CRLs; DER/PEM evidence never claims online status or ICP for custom roots', async () => {
  const v = await validator(), f = await complete(base), result = await v.evaluate({ ...f.input, crls: [f.leaf.pem, f.root.bytes] });
  assert.equal(result.state, 'not_revoked_in_supplied_crls'); assert.equal(result.results.length, 2); assert.equal(result.all_non_anchor_certificates_checked, true);
  assert.equal(result.chain.icp_brasil, false); assert.equal(result.online_checked, false); assert.equal(result.latest_publication_proven, false); assert.equal(result.can_emit, false); assert.equal(result.can_transmit, false);
  assert.equal(result.results[0].crl_sha256, f.leaf.hash); assert.equal(result.results[0].crl_number, '1'); assert.ok(Object.isFrozen(result.results[0]));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(`${HOLDER}|SYNTHETIC|PRIVATE KEY|https?://|CERTIFICATE-----`));
});
test('leaf and intermediate revocation are both detected under their own issuer and serial', async () => {
  const v = await validator();
  for (const position of [0, 1]) {
    const f = await complete(base, position === 0 ? { revoked: [{ serial: 1, reason: 1 }] } : {}, position === 1 ? { revoked: [{ serial: 1, reason: 2 }] } : {}), result = await v.evaluate(f.input);
    assert.equal(result.state, 'revoked'); assert.equal(result.results[position].state, 'revoked'); assert.equal(result.results[position].reason, position + 1); assert.equal(result.all_non_anchor_certificates_checked, true);
  }
});
test('missing CRL for any intermediate, untrusted chains and unrelated issuers never imply non-revocation', async () => {
  const v = await validator(), f = await complete(base);
  unknown(await v.evaluate({ ...f.input, crls: [f.leaf.bytes] }));
  unknown(await v.evaluate({ ...f.input, crls: [] }));
  unknown(await v.evaluate({ ...f.input, intermediates: [] }));
  const other = await trustFixture(); await reissue(other.intermediate, other.root, c => { c.subject.typesAndValues[0].value = new asn.Utf8String({ value: 'OTHER SYNTHETIC ISSUER' }); });
  const stray = await makeCrl(other.intermediate); unknown(await v.evaluate({ ...f.input, crls: [stray.bytes, f.root.bytes] }));
});
test('signature tampering, matching issuer name with wrong key, AKI mismatch and missing AKI are fail-closed', async () => {
  const v = await validator(), f = await complete(base), damaged = Buffer.from(f.leaf.bytes); damaged[damaged.length - 1] ^= 1;
  for (const bytes of [damaged, (await makeCrl(base.intermediate, { aki: new Uint8Array(20) })).bytes, (await makeCrl(base.intermediate, { omitAki: true })).bytes]) unknown(await v.evaluate({ ...f.input, crls: [bytes, f.root.bytes] }));
  const other = await trustFixture(), wrong = await makeCrl(other.intermediate); unknown(await v.evaluate({ ...f.input, crls: [wrong.bytes, f.root.bytes] }));
});
test('issuer cRLSign must be present independently of valid certificate-chain signatures', async () => {
  const f = await trustFixture(); await reissue(f.intermediate, f.root, c => { c.extensions = c.extensions.filter(e => e.extnID !== '2.5.29.15'); c.extensions.push(ext('2.5.29.15', new asn.BitString({ unusedBits: 2, valueHex: new Uint8Array([4]) }), true)); });
  f.input.intermediates = [f.intermediate.certificate]; const v = await validator(f), result = await v.evaluate((await complete(f)).input);
  unknown(result); assert.ok(result.results[0].issues.includes('CRL_ISSUER_CRL_SIGN_REQUIRED'));
});
test('future, expired, missing nextUpdate and product freshness limits never count as current CRLs', async () => {
  const v = await validator();
  for (const options of [{ thisUpdate: '2026-10-16T13:00:00Z' }, { nextUpdate: '2026-10-16T12:00:00Z' }, { nextUpdate: null }, { thisUpdate: '2026-10-16T06:00:00Z' }, { thisUpdate: '2026-10-14T10:00:00Z' }, { thisUpdate: '2026-10-17T10:00:00Z', nextUpdate: '2026-10-16T10:00:00Z' }]) unknown(await v.evaluate((await complete(base, options)).input));
  const f = await complete(base, {}, { thisUpdate: '2026-08-20T10:00:00Z', nextUpdate: '2026-11-17T10:00:00Z' }); unknown(await v.evaluate(f.input));
  const configurable = await validator(base, { maxAgeMs: 90 * 86400000 }); assert.equal((await configurable.evaluate(f.input)).state, 'not_revoked_in_supplied_crls');
});
test('delta, freshest and issuingDistributionPoint lists are explicit unsupported scopes, including non-critical indicators', async () => {
  const v = await validator();
  for (const extra of [ext('2.5.29.27', new asn.Integer({ value: 1 }), true), ext('2.5.29.46', new asn.Sequence()), ext('2.5.29.28', new pki.IssuingDistributionPoint({ indirectCRL: true }).toSchema(), true), ext('2.5.29.28', new pki.IssuingDistributionPoint({ onlyContainsUserCerts: true }).toSchema(), true)]) unknown(await v.evaluate((await complete(base, { extensions: [extra] })).input));
});
test('direct URI certificate distribution points are supported without fetching; partial-reason and indirect references are not', async () => {
  for (const partial of [false, true]) {
    const f = await trustFixture(); await reissue(f.leaf, f.intermediate, c => { c.extensions.push(ext('2.5.29.31', new pki.CRLDistributionPoints({ distributionPoints: [new pki.DistributionPoint({ distributionPoint: [new pki.GeneralName({ type: 6, value: 'https://never-fetch.synthetic.invalid/list.crl' })], ...(partial ? { reasons: new asn.BitString({ unusedBits: 1, valueHex: new Uint8Array([2]) }) } : {}) })] }).toSchema())); }); f.input.certificate = f.leaf.certificate;
    const result = await (await validator(f)).evaluate((await complete(f)).input); if (partial) unknown(result); else assert.equal(result.state, 'not_revoked_in_supplied_crls');
  }
});
test('critical extensions, certificateIssuer entries, duplicate extensions and unsupported removal reasons cannot be ignored', async () => {
  const v = await validator();
  for (const options of [{ extensions: [ext('1.2.3.4.999', new asn.Null(), true)] }, { extensions: [ext('2.5.29.20', new asn.Integer({ value: 1 }))] }, { revoked: [{ extensions: [ext('2.5.29.29', new asn.Sequence())] }] }, { revoked: [{ reason: 8 }] }, { revoked: [{ extensions: [ext('1.2.3.4.999', new asn.Null(), true)] }] }]) unknown(await v.evaluate((await complete(base, options)).input));
});
test('serials retain 20-byte integer precision and duplicate serials or future revocation dates invalidate complete-list coverage', async () => {
  const f = await trustFixture(), serial = '7fffffffffffffffffffffffffffffffffffffff'; await reissue(f.leaf, f.intermediate, c => { c.serialNumber = new asn.Integer({ valueHex: Buffer.from(serial, 'hex') }); }); f.input.certificate = f.leaf.certificate;
  const v = await validator(f), revoked = await v.evaluate((await complete(f, { revoked: [{ serial }] })).input); assert.equal(revoked.results[0].state, 'revoked');
  unknown(await v.evaluate((await complete(f, { revoked: [{ serial }, { serial }] })).input));
  unknown(await v.evaluate((await complete(f, { revoked: [{ serial, date: '2026-10-16T11:00:00Z' }] })).input));
});
test('newer supplied complete publications are selected deterministically; conflicting number/time evidence fails closed', async () => {
  const v = await validator(), f = await complete(base), newer = await makeCrl(base.intermediate, { number: 2, thisUpdate: '2026-10-16T11:00:00Z', revoked: [{ serial: 1 }] });
  const result = await v.evaluate({ ...f.input, crls: [newer.bytes, ...f.input.crls] }); assert.equal(result.results[0].crl_number, '2'); assert.equal(result.state, 'revoked');
  const conflict = await makeCrl(base.intermediate, { number: 1, revoked: [{ serial: 1 }] }); unknown(await v.evaluate({ ...f.input, crls: [conflict.bytes, ...f.input.crls] }));
  const backwards = await makeCrl(base.intermediate, { number: 2, thisUpdate: '2026-10-16T09:00:00Z' }); unknown(await v.evaluate({ ...f.input, crls: [backwards.bytes, ...f.input.crls] }));
});
test('strong RSA-PSS works; SHA-1 and different inner/outer signature algorithms do not', async () => {
  const v = await validator(); assert.equal((await v.evaluate((await complete(base, { pss: true }, { pss: true })).input)).state, 'not_revoked_in_supplied_crls');
  unknown(await v.evaluate((await complete(base, { weak: true })).input));
  const f = await complete(base); f.leaf.crl.signatureAlgorithm.algorithmId = '1.2.840.113549.1.1.12'; unknown(await v.evaluate({ ...f.input, crls: [Buffer.from(f.leaf.crl.toSchema().toBER(false)), f.root.bytes] }));
});
test('bounded public inputs reject coercion, URLs, duplicate files, oversized or non-DER material and forged status fields', async () => {
  const v = await validator(), f = await complete(base);
  for (const input of [{ ...f.input, crls: ['https://never-fetch.invalid/list.crl'] }, { ...f.input, crls: [[f.leaf.bytes]] }, { ...f.input, crls: Array(11).fill(f.leaf.bytes) }, { ...f.input, crls: [f.leaf.bytes, f.leaf.bytes] }, { ...f.input, crls: [new Uint8Array(8 * 1024 * 1024 + 1)] }, { ...f.input, now: NOW.toISOString() }, { ...f.input, revocationChecked: true }]) await assert.rejects(() => v.evaluate(input));
  unknown(await v.evaluate({ ...f.input, crls: [new Uint8Array([0x30, 0x80, 0, 0]), ...f.input.crls] }));
  await assert.rejects(() => validator(base, { maxAgeMs: 91 * 86400000 }));
});
test('the full 100,000-entry limit is scanned with bounded objects; excess entries and the total deadline fail closed', async () => {
  const root = await makeCrl(base.root), allowed = await largeCrl(base.intermediate, 100000), v = await validator();
  assert.ok(allowed.length < 8 * 1024 * 1024);
  const result = await v.evaluate({ ...base.input, crls: [allowed, root.bytes] }); assert.equal(result.state, 'revoked'); assert.equal(result.all_non_anchor_certificates_checked, true);
  const excessive = await largeCrl(base.intermediate, 100001), invalid = await v.evaluate({ ...base.input, crls: [excessive, root.bytes] }); unknown(invalid); assert.ok(invalid.results[0].issues.includes('CRL_REVOKED_ENTRIES_LIMIT'));
  const bounded = await validator(base, { timeoutMs: 100 }), started = Date.now();
  await assert.rejects(() => bounded.evaluate({ ...base.input, crls: [allowed, root.bytes] }), /CRL_EVALUATION_TIMEOUT|TRUST_EVALUATION_TIMEOUT|TRUST_OPENSSL_UNAVAILABLE_TIMEOUT_OR_OUTPUT_LIMIT/);
  assert.ok(Date.now() - started < 3000);
});
test('invalidityDate is canonical GeneralizedTime and cannot postdate revocation', async () => {
  const v = await validator(), good = ext('2.5.29.24', new asn.GeneralizedTime({ valueDate: new Date('2026-10-15T09:00:00Z') }));
  assert.equal((await v.evaluate((await complete(base, { revoked: [{ extensions: [good] }] })).input)).state, 'revoked');
  const late = ext('2.5.29.24', new asn.GeneralizedTime({ valueDate: new Date('2026-10-16T11:00:00Z') })); unknown(await v.evaluate((await complete(base, { revoked: [{ extensions: [late] }] })).input));
});
test('signed times containing high-bit bytes are rejected rather than decoded as ASCII digits', async () => {
  const v = await validator(), f = await complete(base), tbs = Buffer.from(f.leaf.crl.tbsView);
  for (const text of ['261016100000Z', '261017100000Z']) {
    const offset = tbs.indexOf(Buffer.from(text)); assert.ok(offset >= 0);
    for (let i = offset; i < offset + text.length; i++) tbs[i] |= 0x80;
  }
  const result = await v.evaluate({ ...f.input, crls: [signedTbs(base.intermediate, f.leaf, tbs), f.root.bytes] });
  unknown(result); assert.equal(result.rejected_evidence[0].code, 'CRL_TIME_INVALID');
});
test('signed non-minimal OIDs in inner/outer algorithms and extension values are not normalized into valid DER', async () => {
  const v = await validator(), f = await complete(base);
  let result = await v.evaluate({ ...f.input, crls: [noncanonicalAlgorithmCrl(base.intermediate, f.leaf), f.root.bytes] });
  unknown(result); assert.equal(result.rejected_evidence[0].code, 'CRL_DER_OID_INVALID');
  const malformed = new pki.Extension({ extnID: '1.2.3.4.999', extnValue: new Uint8Array([6, 2, 128, 42]).buffer });
  result = await v.evaluate((await complete(base, { extensions: [malformed] })).input); unknown(result); assert.equal(result.rejected_evidence[0].code, 'CRL_DER_OID_INVALID');
});
