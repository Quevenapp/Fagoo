import { createHash } from 'node:crypto';

export class FiscalXmlError extends Error {
  constructor(code) { super(code); this.name = 'FiscalXmlError'; this.code = code; }
}
export function need(condition, code) { if (!condition) throw new FiscalXmlError(code); }
export function safeError(error, code) { return error instanceof FiscalXmlError ? error : new FiscalXmlError(code); }
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const NS = 'http://www.portalfiscal.inf.br/nfe';
export const DS = 'http://www.w3.org/2000/09/xmldsig#';
export const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
export const ENVELOPED = DS + 'enveloped-signature';
export const RSA_SHA1 = DS + 'rsa-sha1';
export const SHA1 = DS + 'sha1';
export const MAX_XML_BYTES = 512000;
