// Synthetic cross-package pipeline only. Emits fictional XML exclusively to the local test runner.
import { businessFixture,refreshTaxProof } from '../../fiscal-core/test/business-fixtures.mjs';
import { buildBusinessXml } from '../../fiscal-xml/src/business-builder.mjs';
import { credentials,HOLDER,NOW } from '../../fiscal-xml/test/fixtures.mjs';
import { createSigner,disposeSigner,signNfeXml,addNfceOnlineSupplement,NFCE_SP_HOMOLOGATION_QR_V3 } from '../../fiscal-xml/src/index.mjs';
const credential=await credentials(),signer=createSigner({...credential,expectedHolderCnpj:HOLDER,now:NOW,purpose:'offline-homologation'});
const result={};
try {
  for(const model of['55','65'])for(const csosn of(model==='55'?['101','102','500']:['102','500'])){
    const f=businessFixture({model,csosn,discount:'0.01',freight:'0.05',other:'0.02'});
    if(csosn==='500'){
      const c=f.taxPreparation.record.items[0].decisions.icms;
      c.retention={base:'20.00',rate:'18.00',substitute_icms:'1.00',retained_icms:'2.60'};
      c.fcp={base:'20.00',rate:'2.00',amount:'0.40'};c.effective={reduction_rate:'10.00',base:'18.00',rate:'18.00',amount:'3.24'};
      f.completion.items[0].icms.groups500={retention:'include',fcp:'include',effective:'include'};f.completion.totals.vFCPSTRet='0.40';refreshTaxProof(f);
    }
    const built=buildBusinessXml(f),signed=signNfeXml({xml:built.unsignedXml,signer,expectedIssuerCnpj:HOLDER,now:NOW});
    result[`${model}-${csosn}`]={model,xml:signed.signedXml,unsigned:built.unsignedXml,signature_verified:signed.verification.signatureVerified,can_transmit:false};
    if(model==='65'&&csosn==='102'){
      const qr=addNfceOnlineSupplement({xml:signed.signedXml,profile:NFCE_SP_HOMOLOGATION_QR_V3,expectedCertificate:credential.certificate,expectedHolderCnpj:HOLDER,expectedIssuerCnpj:HOLDER,now:NOW});
      result['65-qr']={model,xml:qr.signedXml,signature_verified:qr.verification.signatureVerified,can_transmit:false};
    }
  }
  const f=businessFixture({count:250}),built=buildBusinessXml(f),signed=signNfeXml({xml:built.unsignedXml,signer,expectedIssuerCnpj:HOLDER,now:NOW});
  result['55-250']={model:'55',xml:signed.signedXml,signature_verified:signed.verification.signatureVerified,can_transmit:false};
  process.stdout.write(JSON.stringify(result));
}finally{disposeSigner(signer);}
