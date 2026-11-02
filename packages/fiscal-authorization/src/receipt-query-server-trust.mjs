import {readFile} from 'node:fs/promises';
import {X509Certificate, createHash} from 'node:crypto';
import {createSecureContext, rootCertificates, SecureContext} from 'node:tls';
import {createReceiptQueryTlsLoader} from '../../fiscal-vault/src/receipt-query-tls-loader.mjs';

export const SP_RECEIPT_QUERY_SERVER_TRUST = 'node-bundled-plus-iti-ssl-v10-20261016';
export const SP_RECEIPT_QUERY_ROOT_HASH = '6e0bff069a26994c15de2c4888cc54af84882e5495b7fbf66be9ccffec7489f6';
const ROOT_FILE = new URL('../../fiscal-vault/trust/icp-brasil-v10.pem', import.meta.url);
const fail = () => { throw new Error('RECEIPT_QUERY_SERVER_TRUST_INVALID'); };
const contexts = new WeakMap();
const proof = Object.freeze({server_trust_profile:SP_RECEIPT_QUERY_SERVER_TRUST,server_trust_anchor_sha256:SP_RECEIPT_QUERY_ROOT_HASH});

/** Local composition attestation only; not a SQL grant or proof of remote TLS. */
export function requireReceiptQueryServerContext(context, expectedClientFingerprint) {
  if (!(context instanceof SecureContext) || !contexts.has(context) ||
      typeof expectedClientFingerprint !== 'string' || contexts.get(context) !== expectedClientFingerprint) fail();
  return proof;
}

/**
 * Private composition for the fixed SP homologation receipt-query client only. The
 * server trust anchor is an audited public ITI SSL root, never a certificate
 * supplied by the company's PKCS#12. No process-wide CA setting is changed.
 * readFileImpl/createContext/now are trusted test seams, not HTTP input.
 */
export async function createSpReceiptQueryTlsLoader(options = {}, {
  readFileImpl = readFile, createContext = createSecureContext, now = () => new Date(),
} = {}) {
  let anchor;
  try {
    const pem = await readFileImpl(ROOT_FILE);
    if (!(pem instanceof Uint8Array) || pem.length < 1 || pem.length > 8192) fail();
    const text = new TextDecoder('utf8', {fatal:true}).decode(pem);
    if (!/^\s*-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*$/.test(text)) fail();
    anchor = new X509Certificate(text);
    if (createHash('sha256').update(anchor.raw).digest('hex') !== SP_RECEIPT_QUERY_ROOT_HASH || !anchor.ca ||
        !anchor.checkIssued(anchor) || !anchor.verify(anchor.publicKey)) fail();
  } catch { fail(); }
  const checkTime = () => {
    const at = now();
    if (!(at instanceof Date) || !Number.isFinite(at.getTime()) ||
        at.getTime() < anchor.validFromDate.getTime() || at.getTime() > anchor.validToDate.getTime()) fail();
  };
  checkTime();
  // Use Node's versioned bundled roots explicitly. OS/extra-CA environment
  // options cannot silently expand this dedicated profile.
  const ca = Object.freeze([...rootCertificates, anchor.toString()]);
  return createReceiptQueryTlsLoader(options, {createContext(clientOptions) {
    checkTime();
    const context=createContext({...clientOptions, ca:[...ca]});
    if (!(context instanceof SecureContext)) fail();
    // Bind the capability to the actual leaf supplied to OpenSSL, not metadata
    // later handed to a transport. The PFX chain remains only a client chain.
    const certificate=new X509Certificate(clientOptions.cert);
    contexts.set(context,createHash('sha256').update(certificate.raw).digest('hex'));return context;
  }});
}
