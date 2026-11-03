import {assertPreview} from './extract.mjs';
import {renderDocumentLayout} from './render-core.mjs';
const PRESENTATION=Object.freeze({
 banner:'PRÉVIA DE HOMOLOGAÇÃO - SEM VALOR FISCAL',
 bannerNote:'NÃO AUTORIZADA · Não acompanha mercadorias nem comprova autorização de uso.',
 authorizationLabel:'Autorização de uso',authorizationValue:'Não autorizada - prévia de homologação',
 barcodeNote:'Prévia local. Não há protocolo de autorização.',
 footer55:'PRÉVIA - SEM VALOR FISCAL · XML de homologação',
 receiptProtocol:'Não há protocolo de autorização.',
 footer65:'PRÉVIA DE HOMOLOGAÇÃO - SEM VALOR FISCAL · NÃO AUTORIZADA',
 footer65Note:'Assinatura não é autorização de uso.',title:'Prévia de homologação',
});
/** No scripts, network resources, arbitrary SVG, external logos or authorization option. */
export function renderCandidateHtml(value){
 const data=assertPreview(value),render=renderDocumentLayout(data,PRESENTATION);
 return Object.freeze({...render,profile:data.profile,source_sha256:data.source.sha256,mode:'candidate_preview',authorized:false,authorization_verified:false,can_emit:false,can_transmit:false});
}
