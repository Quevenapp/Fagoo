/** Exact, separately observed public WSDL. No network or operational authorization. */
const freeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};
export const AUTHORIZATION_SOAP_MANIFEST=freeze({
 profile:'sp55-authorization-soap12-reviewed-20261016-v1',
 reviewedOn:'2026-10-16',model:'55',environment:'2',operation:'authorization',
 source:{
  url:'https://homologacao.nfe.fazenda.sp.gov.br/ws/nfeautorizacao4.asmx?WSDL',
  sha256:'feb888587ca4aaff7ed0063f33107ba90109ea3b2e38bd4442f14981f13090bd',sizeBytes:4049,
  provenance:'separately-authorized-wsdl-get-and-private-storage-readback',
 },
 endpoint:'https://homologacao.nfe.fazenda.sp.gov.br/ws/nfeautorizacao4.asmx',
 soapVersion:'1.2',style:'document',use:'literal',
 serviceNamespace:'http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4',
 bindingName:'NFeAutorizacao4Soap12',portType:'NFeAutorizacao4Soap12',
 operationName:'nfeAutorizacaoLote',
 soapAction:'http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4/nfeAutorizacaoLote',
 inputMessage:'nfeAutorizacaoLoteSoap12In',inputPart:'nfeDadosMsg',inputElement:'nfeDadosMsg',
 outputMessage:'nfeAutorizacaoLoteSoap12Out',outputPart:'nfeAutorizacaoLoteResult',outputElement:'nfeResultMsg',
 declaredSoapHeaders:false,externalDependencies:false,
 excludedOperations:['nfeAutorizacaoLoteZip'],
 limitations:['Only the observed model55 endpoint; no model65 authorization WSDL pin.',
  'Local binding review does not attest a SOAP exchange, tax rules, TLS or permission to submit.',
  'The existing synthetic adapter and closed legacy binding status are unchanged.',
  'No receipt consultation, polling, retry, custody, transport or SQL mutation.'],
});
// Keep the original 55 manifest and its digest unchanged. Each model has its own
// observed endpoint and WSDL pin; the common operation names are not authority.
export const AUTHORIZATION_SOAP_MANIFESTS=freeze({
 '55':AUTHORIZATION_SOAP_MANIFEST,
 '65':{
  ...AUTHORIZATION_SOAP_MANIFEST,
  profile:'sp65-authorization-soap12-reviewed-20261016-v1',model:'65',
  source:{
   url:'https://homologacao.nfce.fazenda.sp.gov.br/ws/NFeAutorizacao4.asmx?WSDL',
   sha256:'b1c67b11afb4bdbb54903eee908ad14694b4b9a1cd78518af89c612f79fb3771',sizeBytes:4058,
   provenance:'separately-authorized-wsdl-get-and-private-storage-readback',
  },
  endpoint:'https://homologacao.nfce.fazenda.sp.gov.br/ws/NFeAutorizacao4.asmx',
  limitations:['Only the separately observed model65 endpoint; no borrowed model55 or receipt WSDL pin.',
   'Local binding review does not attest a SOAP exchange, tax rules, TLS or permission to submit.',
   'The existing synthetic adapter and closed legacy binding status are unchanged.',
   'No receipt consultation, polling, retry, custody, transport or SQL mutation.'],
 },
});
