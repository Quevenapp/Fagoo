import { X509Certificate, createHash, verify, constants } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { createTrustPolicy } from './trust-policy.mjs';

const require = createRequire(new URL('../../fiscal-xml/package.json', import.meta.url));
const asn = require('asn1js');
const { Certificate, RelativeDistinguishedNames, AuthorityKeyIdentifier, CRLDistributionPoints, AlgorithmIdentifier, RSASSAPSSParams } = require('pkijs');
const MAX_CRL = 8 * 1024 * 1024, MAX_TOTAL = 32 * 1024 * 1024, MAX_ENTRIES = 100000;
const DAY = 86400000, OID = { aki: '2.5.29.35', ski: '2.5.29.14', ku: '2.5.29.15', number: '2.5.29.20', delta: '2.5.29.27', idp: '2.5.29.28', freshest: '2.5.29.46', cdp: '2.5.29.31' };
const hash = value => createHash('sha256').update(value).digest('hex');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
export class CrlPolicyError extends Error { constructor(code) { super(code); this.code = code; } }
const need = (condition, code) => { if (!condition) throw new CrlPolicyError(code); };
const tick = deadline => need(performance.now() < deadline, 'CRL_EVALUATION_TIMEOUT');
function small(bytes) {
  need(bytes.byteLength <= 16384, 'CRL_FIELD_TOO_LARGE');
  reader(Buffer.from(bytes), Infinity, false);
  const decoded = asn.fromBER(bytes, { maxDepth: 24, maxNodes: 4000 });
  need(decoded.offset === bytes.byteLength, 'CRL_ASN1_INVALID'); return decoded.result;
}
function cert(input) {
  const native = new X509Certificate(input), parsed = new Certificate({ schema: small(native.raw) });
  return { native, parsed, fingerprint: hash(native.raw) };
}
function certificateCopy(input) {
  need(typeof input === 'string' ? input.length <= 50000 : input instanceof Uint8Array && input.byteLength > 0 && input.byteLength <= 32768, 'CRL_CERTIFICATE_INPUT_INVALID');
  return typeof input === 'string' ? input : Buffer.from(input);
}
function crlBytes(input) {
  if (input instanceof Uint8Array) { need(input.byteLength > 0 && input.byteLength <= MAX_CRL, 'CRL_INPUT_LIMIT'); return Buffer.from(input); }
  need(typeof input === 'string' && input.length <= 12 * 1024 * 1024, 'CRL_INPUT_INVALID');
  const match = /^\s*-----BEGIN X509 CRL-----\s+([A-Za-z0-9+/=\r\n]+)\s+-----END X509 CRL-----\s*$/.exec(input);
  need(match, 'CRL_PEM_INVALID'); const encoded = match[1].replace(/[\r\n]/g, '');
  need(encoded.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded), 'CRL_PEM_INVALID');
  const bytes = Buffer.from(encoded, 'base64');
  need(bytes.length > 0 && bytes.length <= MAX_CRL && bytes.toString('base64') === encoded, 'CRL_PEM_INVALID'); return bytes;
}

// Minimal definite-length DER traversal. Revoked entries are visited one at a
// time; no 100,000-node PKIJS object graph or serial-number list is returned.
function reader(bytes, deadline, requireSequence = true) {
  let nodes = 0;
  const tlv = (start, ceiling = bytes.length) => {
    if ((++nodes & 255) === 0) tick(deadline);
    need(nodes <= 1500000 && start >= 0 && start + 2 <= ceiling, 'CRL_DER_LIMIT_OR_INVALID');
    const tag = bytes[start]; need((tag & 31) !== 31 && tag !== 0, 'CRL_DER_TAG_UNSUPPORTED');
    let offset = start + 2, length = bytes[start + 1];
    if (length & 128) {
      const count = length & 127; need(count >= 1 && count <= 4 && offset + count <= ceiling && bytes[offset] !== 0, 'CRL_DER_LENGTH_INVALID');
      length = 0; for (let i = 0; i < count; i++) length = length * 256 + bytes[offset++];
      need(length >= 128, 'CRL_DER_LENGTH_INVALID');
    }
    const end = offset + length; need(end <= ceiling, 'CRL_DER_LENGTH_INVALID');
    return { tag, start, content: offset, end, length };
  };
  const children = function* (node) { let offset = node.content; while (offset < node.end) { const child = tlv(offset, node.end); yield child; offset = child.end; } need(offset === node.end, 'CRL_DER_LENGTH_INVALID'); };
  const walk = (node, depth = 0) => {
    need(depth <= 24, 'CRL_DER_DEPTH_LIMIT'); const value = bytes.subarray(node.content, node.end);
    if ([2, 10].includes(node.tag)) need(value.length > 0 && !(value.length > 1 && (value[0] === 0 && (value[1] & 128) === 0 || value[0] === 255 && (value[1] & 128) !== 0)), 'CRL_DER_INTEGER_INVALID');
    if (node.tag === 1) need(value.length === 1 && [0, 255].includes(value[0]), 'CRL_DER_BOOLEAN_INVALID');
    if (node.tag === 5) need(value.length === 0, 'CRL_DER_NULL_INVALID');
    if (node.tag === 3) need(value.length > 0 && value[0] <= 7 && (value.length > 1 ? (value.at(-1) & ((1 << value[0]) - 1)) === 0 : value[0] === 0), 'CRL_DER_BITSTRING_INVALID');
    if (node.tag === 6) {
      need(value.length > 0 && value.length <= 128, 'CRL_DER_OID_INVALID'); let start = true;
      for (const byte of value) { need(!start || byte !== 128, 'CRL_DER_OID_INVALID'); start = (byte & 128) === 0; }
      need(start, 'CRL_DER_OID_INVALID');
    }
    if (node.tag & 32) { let previous; for (const child of children(node)) {
      const encoded = bytes.subarray(child.start, child.end);
      if (node.tag === 0x31 && previous) need(Buffer.compare(previous, encoded) <= 0, 'CRL_DER_SET_ORDER_INVALID');
      previous = encoded; walk(child, depth + 1);
    } }
  };
  const raw = node => bytes.subarray(node.start, node.end), value = node => bytes.subarray(node.content, node.end);
  const root = tlv(0); need((!requireSequence || root.tag === 0x30) && root.end === bytes.length, 'CRL_DER_INVALID'); walk(root); tick(deadline);
  return { tlv, children, raw, value, root };
}
function unsigned(bytes, max = 20) {
  need(bytes.length > 0 && bytes.length <= max + 1 && (bytes[0] & 128) === 0, 'CRL_INTEGER_INVALID');
  if (bytes.length > 1 && bytes[0] === 0) { need((bytes[1] & 128) !== 0, 'CRL_INTEGER_NONCANONICAL'); bytes = bytes.subarray(1); }
  need(bytes.length <= max, 'CRL_INTEGER_INVALID'); return bytes.toString('hex');
}
function integer(node, r) { need(node?.tag === 2, 'CRL_INTEGER_INVALID'); return unsigned(r.value(node)); }
function moment(node, r, allowEarlyGeneralized = false) {
  // latin1 preserves high bits: Node's ascii decoder would normalize them into
  // ASCII digits and could accept a signed but non-DER time representation.
  need(node && [23, 24].includes(node.tag), 'CRL_TIME_INVALID'); const value = r.value(node).toString('latin1');
  let full;
  if (node.tag === 23) { need(/^\d{12}Z$/.test(value), 'CRL_TIME_INVALID'); full = (Number(value.slice(0, 2)) >= 50 ? '19' : '20') + value; }
  else { need(/^\d{14}Z$/.test(value) && (allowEarlyGeneralized || Number(value.slice(0, 4)) >= 2050), 'CRL_TIME_INVALID'); full = value; }
  const iso = `${full.slice(0, 4)}-${full.slice(4, 6)}-${full.slice(6, 8)}T${full.slice(8, 10)}:${full.slice(10, 12)}:${full.slice(12, 14)}.000Z`, time = Date.parse(iso);
  need(Number.isFinite(time) && new Date(time).toISOString() === iso, 'CRL_TIME_INVALID'); return time;
}
function extensions(node, r) {
  need(node?.tag === 0x30 && node.length <= 16384, 'CRL_EXTENSIONS_INVALID'); const result = new Map();
  for (const entry of r.children(node)) {
    need(entry.tag === 0x30 && result.size < 32, 'CRL_EXTENSIONS_INVALID'); const parts = [...r.children(entry)];
    need(parts.length === 2 || parts.length === 3, 'CRL_EXTENSIONS_INVALID');
    const id = small(r.raw(parts[0])); need(id instanceof asn.ObjectIdentifier, 'CRL_EXTENSIONS_INVALID');
    const oid = id.valueBlock.toString(); need(oid.length <= 128 && !result.has(oid), 'CRL_DUPLICATE_EXTENSION');
    const critical = parts.length === 3;
    if (critical) need(parts[1].tag === 1 && parts[1].length === 1 && r.value(parts[1])[0] === 255, 'CRL_EXTENSION_CRITICAL_INVALID');
    const body = parts.at(-1); need(body.tag === 4 && body.length > 0 && body.length <= 8192, 'CRL_EXTENSIONS_INVALID');
    reader(r.value(body), Infinity, false);
    result.set(oid, { critical, bytes: r.value(body) });
  }
  return result;
}
function parseCrl(bytes, deadline) {
  const r = reader(bytes, deadline), top = [...r.children(r.root)];
  need(top.length === 3 && top[0].tag === 0x30 && top[1].tag === 0x30 && top[2].tag === 3 && top[2].length > 1 && top[2].length <= 1025 && r.value(top[2])[0] === 0, 'CRL_SCHEMA_INVALID');
  const fields = [...r.children(top[0])]; let index = 0;
  need(integer(fields[index++], r) === '01', 'CRL_VERSION_UNSUPPORTED');
  const signature = fields[index++]; need(signature.tag === 0x30 && r.raw(signature).equals(r.raw(top[1])), 'CRL_SIGNATURE_ALGORITHM_MISMATCH');
  const issuerNode = fields[index++]; need(issuerNode.tag === 0x30, 'CRL_ISSUER_INVALID');
  const issuer = new RelativeDistinguishedNames({ schema: small(r.raw(issuerNode)) });
  const thisUpdate = moment(fields[index++], r);
  need([23, 24].includes(fields[index]?.tag), 'CRL_NEXT_UPDATE_REQUIRED'); const nextUpdate = moment(fields[index++], r);
  let revoked = null; if (fields[index]?.tag === 0x30) revoked = fields[index++];
  need(fields[index]?.tag === 0xa0 && index === fields.length - 1, 'CRL_EXTENSIONS_REQUIRED');
  const container = [...r.children(fields[index])]; need(container.length === 1, 'CRL_EXTENSIONS_INVALID');
  const exts = extensions(container[0], r);
  return { r, issuer, thisUpdate, nextUpdate, revoked, exts, signature: r.value(top[2]).subarray(1), algorithm: new AlgorithmIdentifier({ schema: small(r.raw(signature)) }), tbs: r.raw(top[0]), hash: hash(bytes) };
}
function signatureOptions(algorithm, key) {
  const id = algorithm.algorithmId, params = algorithm.algorithmParams;
  const rsa = { '1.2.840.113549.1.1.11': 'sha256', '1.2.840.113549.1.1.12': 'sha384', '1.2.840.113549.1.1.13': 'sha512' };
  const ec = { '1.2.840.10045.4.3.2': 'sha256', '1.2.840.10045.4.3.3': 'sha384', '1.2.840.10045.4.3.4': 'sha512' };
  if (rsa[id]) { need(key.asymmetricKeyType === 'rsa' && (params === undefined || params instanceof asn.Null), 'CRL_SIGNATURE_ALGORITHM_UNSUPPORTED'); return [rsa[id], key]; }
  if (ec[id]) { need(key.asymmetricKeyType === 'ec' && ['prime256v1', 'secp384r1', 'secp521r1'].includes(key.asymmetricKeyDetails.namedCurve) && params === undefined, 'CRL_SIGNATURE_ALGORITHM_UNSUPPORTED'); return [ec[id], key]; }
  if (id === '1.3.101.112' || id === '1.3.101.113') { need(key.asymmetricKeyType === (id.endsWith('112') ? 'ed25519' : 'ed448') && params === undefined, 'CRL_SIGNATURE_ALGORITHM_UNSUPPORTED'); return [null, key]; }
  if (id === '1.2.840.113549.1.1.10') {
    need(key.asymmetricKeyType === 'rsa' && params instanceof asn.Sequence, 'CRL_SIGNATURE_ALGORITHM_UNSUPPORTED');
    const pss = new RSASSAPSSParams({ schema: params }), hashes = { '2.16.840.1.101.3.4.2.1': ['sha256', 32], '2.16.840.1.101.3.4.2.2': ['sha384', 48], '2.16.840.1.101.3.4.2.3': ['sha512', 64] }, selected = hashes[pss.hashAlgorithm.algorithmId];
    need(selected && pss.maskGenAlgorithm.algorithmId === '1.2.840.113549.1.1.8' && pss.maskGenAlgorithm.algorithmParams instanceof asn.Sequence && pss.saltLength === selected[1] && pss.trailerField === 1, 'CRL_SIGNATURE_ALGORITHM_UNSUPPORTED');
    const mask = new AlgorithmIdentifier({ schema: pss.maskGenAlgorithm.algorithmParams });
    need(mask.algorithmId === pss.hashAlgorithm.algorithmId && [mask.algorithmParams, pss.hashAlgorithm.algorithmParams].every(p => p === undefined || p instanceof asn.Null), 'CRL_SIGNATURE_ALGORITHM_UNSUPPORTED');
    return [selected[0], { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: pss.saltLength }];
  }
  throw new CrlPolicyError('CRL_SIGNATURE_ALGORITHM_UNSUPPORTED');
}
function certificateScope(child) {
  const exts = child.parsed.extensions ?? [];
  need(!exts.some(e => e.extnID === OID.freshest), 'CRL_DELTA_REFERENCED_UNSUPPORTED');
  const cdp = exts.find(e => e.extnID === OID.cdp); if (!cdp) return;
  const points = new CRLDistributionPoints({ schema: small(cdp.extnValue.valueBlock.valueHexView) }).distributionPoints;
  need(points.length > 0 && points.length <= 16, 'CRL_DISTRIBUTION_POINT_UNSUPPORTED');
  for (const point of points) {
    need(!point.reasons && !point.cRLIssuer && Array.isArray(point.distributionPoint) && point.distributionPoint.length > 0 && point.distributionPoint.length <= 16, 'CRL_DISTRIBUTION_POINT_UNSUPPORTED');
    for (const name of point.distributionPoint) need(name.type === 6 && typeof name.value === 'string' && name.value.length <= 2048 && /^[\x21-\x7e]+$/.test(name.value), 'CRL_DISTRIBUTION_POINT_UNSUPPORTED');
  }
}
function bindCrl(crl, issuer, child, now, maxAgeMs) {
  certificateScope(child);
  const exts = issuer.parsed.extensions ?? [], ku = exts.find(e => e.extnID === OID.ku), ski = exts.find(e => e.extnID === OID.ski);
  const usage = ku && small(ku.extnValue.valueBlock.valueHexView), keyId = ski && small(ski.extnValue.valueBlock.valueHexView);
  need(issuer.native.ca && usage instanceof asn.BitString && (usage.valueBlock.valueHexView[0] & 2) !== 0, 'CRL_ISSUER_CRL_SIGN_REQUIRED');
  need(keyId instanceof asn.OctetString && keyId.valueBlock.valueHexView.length >= 1 && keyId.valueBlock.valueHexView.length <= 64, 'CRL_ISSUER_SKI_REQUIRED');
  const aki = crl.exts.get(OID.aki), number = crl.exts.get(OID.number);
  need(aki && !aki.critical && number && !number.critical, 'CRL_AKI_AND_NUMBER_REQUIRED');
  const authority = new AuthorityKeyIdentifier({ schema: small(aki.bytes) });
  need(authority.keyIdentifier && Buffer.from(authority.keyIdentifier.valueBlock.valueHexView).equals(Buffer.from(keyId.valueBlock.valueHexView)), 'CRL_AKI_MISMATCH');
  if (authority.authorityCertIssuer || authority.authorityCertSerialNumber) {
    need(authority.authorityCertIssuer?.length === 1 && authority.authorityCertIssuer[0].type === 4 && authority.authorityCertIssuer[0].value.isEqual(issuer.parsed.issuer) && authority.authorityCertSerialNumber && unsigned(Buffer.from(authority.authorityCertSerialNumber.valueBlock.valueHexView)) === unsigned(Buffer.from(issuer.parsed.serialNumber.valueBlock.valueHexView)), 'CRL_AKI_AUTHORITY_MISMATCH');
  }
  const integerValue = small(number.bytes); need(integerValue instanceof asn.Integer, 'CRL_NUMBER_INVALID');
  crl.number = BigInt(`0x${unsigned(Buffer.from(integerValue.valueBlock.valueHexView))}`);
  const key = issuer.native.publicKey;
  need(key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength >= 2048 && key.asymmetricKeyDetails.modulusLength <= 8192, 'CRL_SIGNATURE_ALGORITHM_UNSUPPORTED');
  const [algorithm, options] = signatureOptions(crl.algorithm, key);
  need(verify(algorithm, crl.tbs, options, crl.signature), 'CRL_SIGNATURE_INVALID');
  // Conclusions below depend on the verified signature, never just a parsed name.
  need(crl.thisUpdate <= now && now < crl.nextUpdate && crl.thisUpdate < crl.nextUpdate && crl.thisUpdate >= issuer.native.validFromDate.getTime(), 'CRL_NOT_CURRENT');
  need(now - crl.thisUpdate < maxAgeMs, 'CRL_FRESHNESS_LIMIT');
  need(!crl.exts.has(OID.delta) && !crl.exts.has(OID.freshest), 'CRL_DELTA_UNSUPPORTED');
  need(!crl.exts.has(OID.idp), 'CRL_PARTITION_OR_INDIRECT_UNSUPPORTED');
  for (const [id, extension] of crl.exts) need(!extension.critical || [OID.aki, OID.number].includes(id), 'CRL_CRITICAL_EXTENSION_UNSUPPORTED');
  crl.validUntil = Math.min(crl.nextUpdate, crl.thisUpdate + maxAgeMs, issuer.native.validToDate.getTime());
}
function revokedEntries(crl, serial, deadline) {
  if (!crl.revoked) return null;
  let count = 0, found = null; const seen = new Set(), r = crl.r;
  for (const entry of r.children(crl.revoked)) {
    if ((++count & 255) === 0) tick(deadline);
    need(count <= MAX_ENTRIES && entry.tag === 0x30 && entry.length <= 16384, 'CRL_REVOKED_ENTRIES_LIMIT');
    const fields = [...r.children(entry)]; need(fields.length === 2 || fields.length === 3, 'CRL_ENTRY_INVALID');
    const value = integer(fields[0], r); need(!seen.has(value), 'CRL_DUPLICATE_SERIAL'); seen.add(value);
    const date = moment(fields[1], r); need(date <= crl.thisUpdate, 'CRL_REVOCATION_DATE_INVALID');
    let reason = 0;
    if (fields[2]) for (const [id, extension] of extensions(fields[2], r)) {
      need(id !== '2.5.29.29', 'CRL_INDIRECT_ENTRY_UNSUPPORTED');
      if (id === '2.5.29.21') {
        const code = small(extension.bytes); need(!extension.critical && code instanceof asn.Enumerated && code.valueBlock.valueHexView.length === 1, 'CRL_REASON_INVALID');
        reason = code.valueBlock.valueDec; need([0, 1, 2, 3, 4, 5, 6, 9, 10].includes(reason), 'CRL_REASON_UNSUPPORTED');
      } else if (id === '2.5.29.24') {
        // invalidityDate is always GeneralizedTime, including years before2050.
        const invalidity = small(extension.bytes); need(!extension.critical && invalidity instanceof asn.GeneralizedTime, 'CRL_INVALIDITY_DATE_INVALID');
        const body = Buffer.from(invalidity.valueBlock.valueHexView);
        need(moment({ tag: 24 }, { value: () => body }, true) <= date, 'CRL_INVALIDITY_DATE_INVALID');
      } else need(!extension.critical && id !== '2.5.29.23', 'CRL_ENTRY_EXTENSION_UNSUPPORTED');
    }
    if (value === serial) found = { revoked_at: new Date(date).toISOString(), reason };
  }
  tick(deadline); return found;
}

/** Public certificate/CRL bytes only. No network, PFX, secret or production gate. */
export async function createOfflineCrlValidator({ binaryPath, customTrustAnchors, timeoutMs = 10000, maxAgeMs = 6 * 3600000 } = {}) {
  need(Number.isInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 10000 && Number.isSafeInteger(maxAgeMs) && maxAgeMs >= 60000 && maxAgeMs <= 90 * DAY, 'CRL_CONFIGURATION_INVALID');
  need(customTrustAnchors === undefined || Array.isArray(customTrustAnchors), 'CRL_CONFIGURATION_INVALID');
  const anchors = customTrustAnchors?.map(certificateCopy);
  const trustPolicy = await createTrustPolicy({ binaryPath, customTrustAnchors: anchors, timeoutMs });
  const roots = anchors ?? await Promise.all(['v4', 'v5', 'v6', 'v10', 'v11', 'v12', 'v13'].map(version => readFile(new URL(`../trust/icp-brasil-${version}.pem`, import.meta.url))));
  const rootCerts = roots.map(cert);
  return Object.freeze({ async evaluate(input) {
    const deadline = performance.now() + timeoutMs;
    need(exact(input, ['certificate', 'intermediates', 'expectedHolderCnpj', 'crls', 'now']) && Array.isArray(input.crls) && input.crls.length <= 10 && Array.isArray(input.intermediates ?? []) && (input.intermediates ?? []).length <= 10, 'CRL_REQUEST_INVALID');
    const certificate = certificateCopy(input.certificate), intermediates = (input.intermediates ?? []).map(certificateCopy);
    const now = input.now ?? new Date(); need(now instanceof Date && Number.isFinite(now.getTime()) && now.getUTCFullYear() >= 2000 && now.getUTCFullYear() <= 2099, 'CRL_CLOCK_INVALID'); const at = new Date(now.getTime());
    let total = 0; const bytes = input.crls.map(value => { tick(deadline); const data = crlBytes(value); total += data.length; need(total <= MAX_TOTAL, 'CRL_TOTAL_LIMIT'); return data; });
    need(new Set(bytes.map(hash)).size === bytes.length, 'CRL_DUPLICATE_INPUT');
    tick(deadline);
    const trust = await trustPolicy.evaluate({ certificate, intermediates, expectedHolderCnpj: input.expectedHolderCnpj, now: at }); tick(deadline);
    const certificates = [certificate, ...intermediates].map(cert), byHash = new Map([...certificates, ...rootCerts].map(c => [c.fingerprint, c]));
    const path = trust.trust.chain_sha256.map(id => byHash.get(id));
    need(path.every(Boolean), 'CRL_RESOLVED_CHAIN_INVALID');
    const parsed = [], rejected = [];
    for (const data of bytes) { tick(deadline); try { parsed.push(parseCrl(data, deadline)); } catch (error) { if (error?.code === 'CRL_EVALUATION_TIMEOUT') throw error; rejected.push({ crl_sha256: hash(data), code: error instanceof CrlPolicyError ? error.code : 'CRL_INVALID' }); } }
    const results = [];
    for (let index = 0; index < path.length - 1; index++) {
      tick(deadline); const child = path[index], issuer = path[index + 1], serial = unsigned(Buffer.from(child.parsed.serialNumber.valueBlock.valueHexView));
      const result = { certificate_sha256: child.fingerprint, issuer_sha256: issuer.fingerprint, state: 'unknown', crl_sha256: null, crl_number: null, this_update: null, next_update: null, valid_until: null, revoked_at: null, reason: null, issues: [] };
      const candidates = parsed.filter(crl => crl.issuer.isEqual(issuer.parsed.subject)), valid = [];
      if (!candidates.length) result.issues.push('CRL_MISSING');
      for (const crl of candidates) {
        try { bindCrl(crl, issuer, child, at.getTime(), maxAgeMs); tick(deadline); const revoked = revokedEntries(crl, serial, deadline); valid.push({ crl, revoked }); }
        catch (error) { if (error?.code === 'CRL_EVALUATION_TIMEOUT') throw error; result.issues.push(error instanceof CrlPolicyError ? error.code : 'CRL_INVALID'); }
      }
      // An unparseable supplied list cannot silently disappear from coverage.
      if (rejected.length) result.issues.push('CRL_SUPPLIED_EVIDENCE_INVALID');
      if (valid.length && !result.issues.length) {
        valid.sort((a, b) => a.crl.number < b.crl.number ? -1 : a.crl.number > b.crl.number ? 1 : 0);
        for (let n = 1; n < valid.length; n++) if (valid[n].crl.number === valid[n - 1].crl.number || valid[n].crl.thisUpdate < valid[n - 1].crl.thisUpdate) result.issues.push('CRL_PUBLICATION_CONFLICT');
        if (!result.issues.length) { const { crl, revoked } = valid.at(-1); Object.assign(result, { state: revoked ? 'revoked' : 'not_revoked_in_supplied_crl', crl_sha256: crl.hash, crl_number: crl.number.toString(), this_update: new Date(crl.thisUpdate).toISOString(), next_update: new Date(crl.nextUpdate).toISOString(), valid_until: new Date(crl.validUntil).toISOString(), ...(revoked ?? {}) }); }
      }
      result.issues = [...new Set(result.issues)]; results.push(result);
    }
    tick(deadline); const checked = trust.trust.chain_validated && results.length > 0 && results.every(row => row.state !== 'unknown');
    const state = results.some(row => row.state === 'revoked') ? 'revoked' : checked ? 'not_revoked_in_supplied_crls' : 'unknown';
    return freeze({ assessment: 'offline-crl-v1', checked_at: at.toISOString(), state, all_non_anchor_certificates_checked: checked,
      chain: { validated: trust.trust.chain_validated, icp_brasil: trust.trust.icp_brasil_chain_validated, snapshot_fresh: trust.trust.snapshot_fresh, certificate_sha256: [...trust.trust.chain_sha256], root_revocation: 'trust_anchor_not_checked_by_crl' },
      max_age_ms: maxAgeMs, online_checked: false, latest_publication_proven: false, results, rejected_evidence: rejected,
      blockers: [...new Set([...(trust.trust.chain_validated ? [] : ['CRL_CHAIN_NOT_VALIDATED']), ...(checked ? [] : ['CRL_CHAIN_COVERAGE_INCOMPLETE']), ...(state === 'revoked' ? ['CERTIFICATE_REVOKED'] : []), 'LATEST_PUBLICATION_NOT_PROVEN_OFFLINE', 'OPERATION_NOT_AUTHORIZED'])], can_emit: false, can_transmit: false });
  } });
}
