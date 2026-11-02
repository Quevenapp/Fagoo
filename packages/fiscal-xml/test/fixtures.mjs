// All keys/certificates/PFX exist only in test memory and are self-signed synthetic fixtures.
import { generateKeyPairSync, webcrypto, X509Certificate } from 'node:crypto';
import * as asn1js from 'asn1js';
import { AuthenticatedSafe, AttributeTypeAndValue, BasicConstraints, CertBag, Certificate, CryptoEngine, Extension,
  PFX, PKCS8ShroudedKeyBag, PrivateKeyInfo, RelativeDistinguishedNames, SafeBag, SafeContents } from 'pkijs';
import { buildAccessKey, cnpjCheckDigits } from '../../fiscal-core/src/identity.mjs';

export const HOLDER = '990000000001' + cnpjCheckDigits('990000000001');
export const OTHER = '880000000001' + cnpjCheckDigits('880000000001');
export const NOW = new Date('2026-10-16T12:00:00Z');
export const PASSWORD = new TextEncoder().encode('senha-ficticia-de-teste');
export const engine = new CryptoEngine({name:'test-only',crypto:webcrypto,subtle:webcrypto.subtle});
export async function credentials({cnpj = HOLDER,notBefore = '2026-01-01T00:00:00Z',notAfter = '2027-01-01T00:00:00Z',digitalSignature = true,ca = false,omitCnpj = false,duplicateCnpj = false} = {}) {
  const {privateKey,publicKey} = generateKeyPairSync('rsa',{modulusLength:2048});
  const der = privateKey.export({format:'der',type:'pkcs8'});
  const privateCrypto = await webcrypto.subtle.importKey('pkcs8',der,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},true,['sign']);
  const publicCrypto = await webcrypto.subtle.importKey('spki',publicKey.export({format:'der',type:'spki'}),{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},true,['verify']);
  const cert = new Certificate(); cert.version = 2; cert.serialNumber = new asn1js.Integer({value:1});
  const name = new RelativeDistinguishedNames({typesAndValues:[new AttributeTypeAndValue({type:'2.5.4.3',value:new asn1js.Utf8String({value:'CERTIFICADO FICTICIO FAGOO'})})]});
  cert.subject = name; cert.issuer = name; cert.notBefore.value = new Date(notBefore); cert.notAfter.value = new Date(notAfter);
  await cert.subjectPublicKeyInfo.importKey(publicCrypto,engine);
  const cnpjName = () => new asn1js.Constructed({idBlock:{tagClass:3,tagNumber:0},value:[
    new asn1js.ObjectIdentifier({value:'2.16.76.1.3.3'}),
    new asn1js.Constructed({idBlock:{tagClass:3,tagNumber:0},value:[new asn1js.Utf8String({value:cnpj})]}),
  ]});
  cert.extensions = [
    new Extension({extnID:'2.5.29.19',critical:true,extnValue:new BasicConstraints({cA:ca}).toSchema().toBER(false)}),
    new Extension({extnID:'2.5.29.15',critical:true,extnValue:new asn1js.BitString({unusedBits:6,valueHex:new Uint8Array([digitalSignature ? 0xC0 : 0x40]).buffer}).toBER(false)}),
    ...(omitCnpj ? [] : [new Extension({extnID:'2.5.29.17',critical:false,extnValue:new asn1js.Sequence({value:duplicateCnpj ? [cnpjName(),cnpjName()] : [cnpjName()]}).toBER(false)})]),
  ];
  await cert.sign(privateCrypto,'SHA-256',engine);
  const certificateDer = Buffer.from(cert.toSchema(true).toBER(false));
  const certificate = new X509Certificate(certificateDer).toString();
  return {privateKey,certificate,certificateDer,pkijsCertificate:cert,privateDer:der};
}
export function unsignedXml({model = '55',environment = '2',cnpj = HOLDER,cUF = '35',tpEmis = '1'} = {}) {
  const identity = {cUF,cnpj,model,environment,series:'1',number:'1',issuedAt:'2026-10-16T09:00:00-03:00',cNF:'12345678',tpEmis};
  const key = buildAccessKey(identity);
  // Deliberately only a structural cryptography fixture, not a tax-complete or XSD-valid invoice.
  return `<NFe xmlns="http://www.portalfiscal.inf.br/nfe"><infNFe Id="NFe${key}" versao="4.00"><ide><cUF>${cUF}</cUF><cNF>12345678</cNF><mod>${model}</mod><serie>1</serie><nNF>1</nNF><dhEmi>2026-10-16T09:00:00-03:00</dhEmi><tpEmis>${tpEmis}</tpEmis><cDV>${key.at(-1)}</cDV><tpAmb>${environment}</tpAmb></ide><emit><CNPJ>${cnpj}</CNPJ><xNome>EMPRESA FICTICIA</xNome></emit><infAdic><infCpl>DOCUMENTO SINTETICO SEM VALOR FISCAL</infCpl></infAdic></infNFe></NFe>`;
}
export async function pfxFixture(credential,{password = PASSWORD,encryptedSafe = false,iterations = 2048,keyLength = 256,macHash = 'SHA-256'} = {}) {
  const encryption = {password:password.buffer,contentEncryptionAlgorithm:{name:'AES-CBC',length:keyLength},hmacHashAlgorithm:'SHA-256',iterationCount:2048};
  const shrouded = new PKCS8ShroudedKeyBag({parsedValue:PrivateKeyInfo.fromBER(credential.privateDer)});
  await shrouded.makeInternalValues(encryption,engine);
  const safe = new AuthenticatedSafe({parsedValue:{safeContents:[{privacyMode:encryptedSafe ? 1 : 0,value:new SafeContents({safeBags:[
    new SafeBag({bagId:'1.2.840.113549.1.12.10.1.2',bagValue:shrouded}),
    new SafeBag({bagId:'1.2.840.113549.1.12.10.1.3',bagValue:new CertBag({parsedValue:credential.pkijsCertificate})}),
  ]})}]}});
  await safe.makeInternalValues({safeContents:[encryptedSafe ? {...encryption} : {}]},engine);
  const pfx = new PFX({parsedValue:{integrityMode:0,authenticatedSafe:safe}});
  await pfx.makeInternalValues({password:password.buffer,iterations,hmacHashAlgorithm:macHash,pbkdf2HashAlgorithm:{name:'SHA-256'}},engine);
  return new Uint8Array(pfx.toSchema().toBER(false));
}
