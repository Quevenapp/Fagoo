// Public/private keys below are generated synthetically in memory; no user certificate is read.
import {createHash} from 'node:crypto';
import {credentials,HOLDER,NOW} from '../../fiscal-xml/test/fixtures.mjs';
import {createSigner,disposeSigner,createSignedHomologationCandidate} from '../../fiscal-xml/src/index.mjs';
import {businessFixture} from '../../fiscal-core/test/business-fixtures.mjs';
import {buildBusinessXml} from '../../fiscal-xml/src/business-builder.mjs';
export {HOLDER,NOW};
export const hash=v=>createHash('sha256').update(v).digest('hex');
export async function signedFixture(){
 const credential=await credentials(),signer=createSigner({...credential,expectedHolderCnpj:HOLDER,purpose:'offline-homologation',now:NOW});
 try{return{credential,create(model='55',count=1){
  const unsigned=buildBusinessXml(businessFixture({model,count})).unsignedXml;
  const signed=createSignedHomologationCandidate({xml:unsigned,signer,expectedIssuerCnpj:HOLDER,expectedModel:model,expectedUnsignedHash:hash(unsigned),expectedCertificateFingerprint:hash(credential.certificateDer),now:NOW});
  const signedBytes=Buffer.from(signed.signedXml);
  return{signed,signedBytes,input:{signedBytes,signedHash:signed.xmlDigest,signedSize:signedBytes.length,certificateFingerprint:hash(credential.certificateDer),model,now:NOW}};
 },close(){disposeSigner(signer);}};}catch(e){disposeSigner(signer);throw e;}
}
export function fiscalResponse(request,{batch='104',status='100',protocol=true,receipt=false}={}){
 return Buffer.from(`<retEnviNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><tpAmb>2</tpAmb><verAplic>SINTETICO</verAplic><cStat>${batch}</cStat><xMotivo>RESPOSTA SINTETICA SEM VALOR FISCAL</xMotivo><cUF>35</cUF><dhRecbto>2026-10-16T09:01:00-03:00</dhRecbto>${receipt?'<infRec><nRec>350000000000001</nRec><tMed>1</tMed></infRec>':''}${protocol?`<protNFe versao="4.00"><infProt><tpAmb>2</tpAmb><verAplic>SINTETICO</verAplic><chNFe>${request.accessKey}</chNFe><dhRecbto>2026-10-16T09:01:00-03:00</dhRecbto><nProt>13526000000000001</nProt><digVal>${request.referenceDigest}</digVal><cStat>${status}</cStat><xMotivo>RESPOSTA SINTETICA SEM VALOR FISCAL</xMotivo></infProt></protNFe>`:''}</retEnviNFe>`);
}
