import {extractProcessedDocument,assertProcessedDocument} from './processed-extract.mjs';
import {renderDocumentLayout} from './render-core.mjs';
import {localDate} from './format.mjs';

/** Read-only homologation document from the historical reader's opaque handle.
 * The caller must reauthorize the handle after rendering, before returning HTML. */
export function renderProcessedHtml(handle){
 const {preview,source,profile}=assertProcessedDocument(extractProcessedDocument(handle));
 const p=source.protocol;
 const protocol=`${p.number} · ${localDate(p.received_at)} - São Paulo · cStat ${p.cstat}`;
 const presentation=Object.freeze({
  banner:'HOMOLOGAÇÃO - SEM VALOR FISCAL',
  bannerNote:'Documento processado em ambiente de testes. Não acompanha mercadorias.',
  authorizationLabel:'Protocolo de autorização - homologação',authorizationValue:protocol,
  barcodeNote:'Documento de homologação. Protocolo recebido e arquivado.',
  footer55:'HOMOLOGAÇÃO - SEM VALOR FISCAL · XML processado',
  receiptProtocol:'Protocolo de autorização - homologação: '+protocol,
  footer65:'HOMOLOGAÇÃO - SEM VALOR FISCAL',
  footer65Note:'Protocolo recebido em ambiente de testes.',title:'DANFE de homologação',
 });
 return Object.freeze({...renderDocumentLayout(preview,presentation),profile});
}
