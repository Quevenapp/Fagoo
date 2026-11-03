import{createRequire}from'node:module';import{X509Certificate,createHash,webcrypto}from'node:crypto';
import{credentials,HOLDER,OTHER,NOW}from'../../fiscal-xml/test/fixtures.mjs';
const require=createRequire(new URL('../../fiscal-xml/package.json',import.meta.url));
const asn=require('asn1js'),pki=require('pkijs');
export{HOLDER,OTHER,NOW};export const binary=process.env.BRUFAP_TEST_OPENSSL_PATH??'/opt/homebrew/opt/openssl@3/bin/openssl';
const engine=new pki.CryptoEngine({name:'synthetic-trust-policy',crypto:webcrypto,subtle:webcrypto.subtle});
const keyId=cert=>createHash('sha1').update(cert.subjectPublicKeyInfo.subjectPublicKey.valueBlock.valueHexView).digest();
const ext=(id,value,critical=false)=>new pki.Extension({extnID:id,critical,extnValue:value.toBER(false)});
async function issue(value,issuer,{name,ca=false,pathLen,policies,eku,unknownCritical=false,notAfter,dns,excludeDns,signature=true,omitAki=false}={}){
 const cert=value.pkijsCertificate;cert.subject.typesAndValues[0].value=new asn.Utf8String({value:name});cert.issuer=issuer.pkijsCertificate.subject;
 if(notAfter)cert.notAfter.value=new Date(notAfter);
 cert.extensions=cert.extensions.filter(e=>!['2.5.29.19','2.5.29.15','2.5.29.14','2.5.29.35','2.5.29.32','2.5.29.37','2.5.29.30'].includes(e.extnID));
 cert.extensions.push(ext('2.5.29.19',new pki.BasicConstraints({cA:ca,...(pathLen===undefined?{}:{pathLenConstraint:pathLen})}).toSchema(),true));
 cert.extensions.push(ext('2.5.29.15',new asn.BitString({unusedBits:ca?1:5,valueHex:new Uint8Array([ca?0x06:signature?0xE0:0x60]).buffer}),true));
 cert.extensions.push(ext('2.5.29.14',new asn.OctetString({valueHex:keyId(cert)})));
 if(!omitAki)cert.extensions.push(ext('2.5.29.35',new pki.AuthorityKeyIdentifier({keyIdentifier:new asn.OctetString({valueHex:keyId(issuer.pkijsCertificate)})}).toSchema()));
 if(policies)cert.extensions.push(ext('2.5.29.32',new asn.Sequence({value:policies.map(oid=>new asn.Sequence({value:[new asn.ObjectIdentifier({value:oid})]}))})));
 if(eku)cert.extensions.push(ext('2.5.29.37',new asn.Sequence({value:eku.map(oid=>new asn.ObjectIdentifier({value:oid}))})));
 if(unknownCritical)cert.extensions.push(ext('1.2.3.4.999',new asn.Utf8String({value:'UNHANDLED SYNTHETIC'}),true));
 if(dns){const san=cert.extensions.find(e=>e.extnID==='2.5.29.17'),decoded=asn.fromBER(san.extnValue.valueBlock.valueHexView).result;decoded.valueBlock.value.push(new asn.Primitive({idBlock:{tagClass:3,tagNumber:2},valueHex:new TextEncoder().encode(dns)}));san.extnValue=new asn.OctetString({valueHex:decoded.toBER(false)});}
 if(excludeDns)cert.extensions.push(ext('2.5.29.30',new pki.NameConstraints({excludedSubtrees:[new pki.GeneralSubtree({base:new pki.GeneralName({type:2,value:excludeDns})})]}).toSchema(),true));
 const key=await webcrypto.subtle.importKey('pkcs8',issuer.privateDer,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},true,['sign']);await cert.sign(key,'SHA-256',engine);
 value.certificateDer=Buffer.from(cert.toSchema(true).toBER(false));value.certificate=new X509Certificate(value.certificateDer).toString();return value;
}
export async function trustFixture(options={}){
 const root=await credentials({ca:true});await issue(root,root,{name:'SYNTHETIC ROOT - NOT ICP BRASIL',ca:true,pathLen:options.rootPathLen??1,notAfter:options.rootNotAfter});
 const intermediate=await credentials({ca:true});await issue(intermediate,root,{name:'SYNTHETIC INTERMEDIATE',ca:options.intermediateCa!==false,pathLen:0,excludeDns:options.excludeDns});
 const leaf=await credentials();await issue(leaf,intermediate,{name:'SYNTHETIC A1 LEAF',policies:options.policies===null?undefined:options.policies??['2.16.76.1.2.1.999'],eku:options.eku===null?undefined:options.eku??['1.3.6.1.5.5.7.3.2'],unknownCritical:options.unknownCritical,notAfter:options.leafNotAfter,dns:options.dns,signature:options.signature!==false,omitAki:options.omitAki});
 return{leaf,intermediate,root,input:{certificate:leaf.certificate,intermediates:[intermediate.certificate],expectedHolderCnpj:HOLDER,now:NOW}};
}
