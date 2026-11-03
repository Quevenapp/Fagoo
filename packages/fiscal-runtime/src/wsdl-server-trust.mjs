import {readFile} from 'node:fs/promises';
import {X509Certificate, createHash} from 'node:crypto';
import {createSecureContext, rootCertificates} from 'node:tls';
import {createWsdlTlsLoader} from '../../fiscal-vault/src/wsdl-tls-loader.mjs';

export const SP_WSDL_SERVER_TRUST = 'node-bundled-plus-iti-ssl-v10-20261016';
const ROOT_HASH = '6e0bff069a26994c15de2c4888cc54af84882e5495b7fbf66be9ccffec7489f6';
const ROOT_FILE = new URL('../../fiscal-vault/trust/icp-brasil-v10.pem', import.meta.url);
const fail = () => { throw new Error('WSDL_SERVER_TRUST_INVALID'); };

/**
 * Private composition for the fixed SP homologation WSDL client only. The
 * server trust anchor is an audited public ITI SSL root, never a certificate
 * supplied by the company's PKCS#12. No process-wide CA setting is changed.
 * readFileImpl/createContext/now are trusted test seams, not HTTP input.
 */
export async function createSpWsdlTlsLoader(options = {}, {
  readFileImpl = readFile, createContext = createSecureContext, now = () => new Date(),
} = {}) {
  let anchor;
  try {
    const pem = await readFileImpl(ROOT_FILE);
    if (!(pem instanceof Uint8Array) || pem.length < 1 || pem.length > 8192) fail();
    const text = new TextDecoder('utf8', {fatal:true}).decode(pem);
    if (!/^\s*-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*$/.test(text)) fail();
    anchor = new X509Certificate(text);
    if (createHash('sha256').update(anchor.raw).digest('hex') !== ROOT_HASH || !anchor.ca ||
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
  return createWsdlTlsLoader(options, {createContext(clientOptions) {
    checkTime();
    return createContext({...clientOptions, ca:[...ca]});
  }});
}
