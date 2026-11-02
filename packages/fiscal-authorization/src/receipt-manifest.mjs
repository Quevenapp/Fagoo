/** Observed public WSDL pins only. No transport, authorization or endpoint discovery. */
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
const common={environment:'2',operation:'receipt',soapVersion:'1.2',style:'document',use:'literal',
 serviceNamespace:'http://www.portalfiscal.inf.br/nfe/wsdl/NFeRetAutorizacao4',
 bindingName:'NFeRetAutorizacao4Soap12',operationName:'nfeRetAutorizacaoLote',
 soapAction:'http://www.portalfiscal.inf.br/nfe/wsdl/NFeRetAutorizacao4/nfeRetAutorizacaoLote',
 inputElement:'nfeDadosMsg',outputElement:'nfeResultMsg',declaredSoapHeaders:false,externalDependencies:false};
export const RECEIPT_MANIFEST=freeze({profile:'sp-receipt-payload-reviewed-20261016-v1',observedOn:'2026-10-16',
 provenance:'separately-authorized-wsdl-get-and-private-storage-readback',
 bindings:[
  {...common,model:'55',endpoint:'https://homologacao.nfe.fazenda.sp.gov.br/ws/nferetautorizacao4.asmx',
   wsdl:{url:'https://homologacao.nfe.fazenda.sp.gov.br/ws/nferetautorizacao4.asmx?WSDL',sha256:'bb288d8bb187dbd909d163a1bcd26ab3bb6a16d960776771b57ab1584999a429',sizeBytes:3069}},
  {...common,model:'65',endpoint:'https://homologacao.nfce.fazenda.sp.gov.br/ws/NFeRetAutorizacao4.asmx',
   wsdl:{url:'https://homologacao.nfce.fazenda.sp.gov.br/ws/NFeRetAutorizacao4.asmx?WSDL',sha256:'a838070b990d2aee1148826f7c3569c70d797a261622345ebcec5837add470f9',sizeBytes:3072}},
 ],
 schema:{dependencyProfile:'pl010f-v1.04',dependencyManifestSha256:'6099e1ce8a90a079609f986ab0b9783744d2fbb10151fab0b5e7a3549c82d9a0',requestType:'TConsReciNFe',responseType:'TRetConsReciNFe'},
 limitations:['Payload core only: no SOAP builder, transport, polling, SQL or grants.',
  'The original single-candidate authorization remains receipt_pending; query results are separate observations.',
  'WSDL pins do not authorize use or attest TLS, CCG, tax rules or SEFAZ origin.',
  'A future composition must reauthorize the actor and revalidate the versioned backend evidence.'],
});
