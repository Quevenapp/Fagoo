export const AUTHORIZATION_SOAP_MANIFEST:Readonly<{
 profile:'sp55-authorization-soap12-reviewed-20261016-v1';reviewedOn:'2026-10-16';model:'55';environment:'2';operation:'authorization';
 source:Readonly<{url:string;sha256:string;sizeBytes:4049;provenance:'separately-authorized-wsdl-get-and-private-storage-readback'}>;
 endpoint:string;soapVersion:'1.2';style:'document';use:'literal';serviceNamespace:string;
 bindingName:'NFeAutorizacao4Soap12';portType:'NFeAutorizacao4Soap12';operationName:'nfeAutorizacaoLote';soapAction:string;
 inputMessage:'nfeAutorizacaoLoteSoap12In';inputPart:'nfeDadosMsg';inputElement:'nfeDadosMsg';
 outputMessage:'nfeAutorizacaoLoteSoap12Out';outputPart:'nfeAutorizacaoLoteResult';outputElement:'nfeResultMsg';
 declaredSoapHeaders:false;externalDependencies:false;excludedOperations:readonly ['nfeAutorizacaoLoteZip'];limitations:readonly string[];
}>;
export const AUTHORIZATION_SOAP_MANIFESTS:Readonly<{
 '55':typeof AUTHORIZATION_SOAP_MANIFEST;
 '65':Readonly<Omit<typeof AUTHORIZATION_SOAP_MANIFEST,'profile'|'model'|'source'|'limitations'>&{
  profile:'sp65-authorization-soap12-reviewed-20261016-v1';model:'65';
  source:Readonly<{url:string;sha256:string;sizeBytes:4058;provenance:'separately-authorized-wsdl-get-and-private-storage-readback'}>;
  limitations:readonly string[];
 }>;
}>;
