// Synthetic XML only. No key/certificate, network request or real invoice.
import { prepareProtocolSoapDraft, extractProtocolSoapCandidate } from '../../fiscal-xml/src/index.mjs';
import { buildAccessKey } from '../../fiscal-core/src/identity.mjs';
import { identity } from '../../fiscal-core/test/fixtures.mjs';
const NS='http://www.portalfiscal.inf.br/nfe',SERVICE=NS+'/wsdl/NFeConsultaProtocolo4';
const TIME='2026-10-16T01:00:00-03:00',DIGEST=Buffer.from(Array.from({length:20},(_,i)=>i)).toString('base64');
const values=[];
for(const model of ['55','65']){
 const accessKey=buildAccessKey({...identity,model});
 const draft=prepareProtocolSoapDraft({accessKey,expectedModel:model,environment:'2',requestId:'soap_xsd_synthetic'});
 const payload=`<retConsSitNFe xmlns="${NS}" versao="4.00"><tpAmb>2</tpAmb><verAplic>TESTE_SINTETICO</verAplic><cStat>101</cStat><xMotivo>TESTE FICTICIO</xMotivo><cUF>35</cUF><dhRecbto>${TIME}</dhRecbto><chNFe>${accessKey}</chNFe><protNFe versao="4.00"><infProt><tpAmb>2</tpAmb><verAplic>TESTE_SINTETICO</verAplic><chNFe>${accessKey}</chNFe><dhRecbto>${TIME}</dhRecbto><nProt>13526000000000001</nProt><digVal>${DIGEST}</digVal><cStat>100</cStat><xMotivo>TESTE FICTICIO</xMotivo></infProt></protNFe></retConsSitNFe>`;
 const wrap=xml=>`<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body><nfeResultMsg xmlns="${SERVICE}">${xml}</nfeResultMsg></s:Body></s:Envelope>`;
 const extract=xml=>extractProtocolSoapCandidate({envelopeXml:wrap(xml),expectedAccessKey:accessKey,expectedModel:model,environment:'2'});
 values.push({model,accessKey,referenceDigest:DIGEST,draft,candidate:extract(payload),incomplete:extract(payload.replace('<verAplic>TESTE_SINTETICO</verAplic>',''))});
}
process.stdout.write(JSON.stringify(values));
