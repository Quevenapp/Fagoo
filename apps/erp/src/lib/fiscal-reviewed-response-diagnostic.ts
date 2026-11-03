import type {DispatchResult} from './fiscal-reviewed-authorization-model';

const VALIDATION_REASONS = Object.freeze({
 SOAP_FAULT:'O serviço retornou uma falha ao processar a solicitação. O resultado da nota não foi confirmado.',
 SOAP_INVALID:'A resposta guardada não corresponde ao formato de comunicação esperado.',
 XML_INVALID:'Não foi possível validar a estrutura do XML de resposta.',
 XSD_INVALID:'A resposta não atende ao esquema XML esperado.',
 CONTEXT_MISMATCH:'Os dados da resposta não correspondem à nota ou à solicitação enviada.',
 DIGEST_MISMATCH:'O resumo criptográfico da resposta não corresponde ao da nota enviada.',
 PROCESSED_INVALID:'Não foi possível validar o documento formado pela nota e pelo protocolo recebidos.',
});
type Diagnostic = Readonly<
 {kind:'validation';code:string|null;message:string} |
 {kind:'sefaz';code:string;batchCode:string|null}
>;
const responseCode=(value:unknown):value is string=>typeof value==='string'&&/^\d{3,4}$/.test(value);

/** Display only already validated public codes; never derive a reason from XML or free text. */
export function reviewedResponseDiagnostic(artifact:DispatchResult['artifact']):Diagnostic|null{
 if(!artifact)return null;
 if(artifact.outcome==='invalid_response'){
  const code=artifact.rejection_code;
  return code!==null&&Object.hasOwn(VALIDATION_REASONS,code)
   ?{kind:'validation',code,message:VALIDATION_REASONS[code]}
   :{kind:'validation',code:null,message:'A resposta guardada não pôde ser validada. O motivo não está disponível nesta consulta.'};
 }
 if(!responseCode(artifact.cstat))return null;
 return {kind:'sefaz',code:responseCode(artifact.protocol_cstat)?artifact.protocol_cstat:artifact.cstat,batchCode:responseCode(artifact.protocol_cstat)?artifact.cstat:null};
}
