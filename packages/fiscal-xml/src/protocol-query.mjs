import { createHash } from 'node:crypto';
import { inspectAccessKey } from '../../fiscal-core/src/identity.mjs';
import { need, NS } from './common.mjs';

const ENDPOINTS = Object.freeze({
  '55': 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nfeconsultaprotocolo4.asmx',
  '65': 'https://homologacao.nfce.fazenda.sp.gov.br/ws/NFeConsultaProtocolo4.asmx',
});

/** Pure preparation. Contains no transport, credentials, automatic retry or authorization claim. */
export function prepareProtocolQuery({ accessKey, expectedModel, environment, requestId } = {}) {
  need(environment === '2', 'QUERY_HOMOLOGATION_REQUIRED');
  need(['55', '65'].includes(expectedModel), 'QUERY_MODEL_REQUIRED');
  need(typeof requestId === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(requestId), 'QUERY_REQUEST_ID_INVALID');
  const inspected = inspectAccessKey(accessKey);
  need(inspected.valid, 'QUERY_ACCESS_KEY_INVALID');
  need(inspected.parts.model === expectedModel && inspected.parts.cUF === '35', 'QUERY_IDENTITY_MISMATCH');
  need(inspected.parts.tpEmis === '1' && Number(inspected.parts.series) <= 889, 'QUERY_PROFILE_UNSUPPORTED');
  // Every interpolated value is constrained above. No arbitrary XML or endpoint is accepted.
  const xml = `<consSitNFe xmlns="${NS}" versao="4.00"><tpAmb>2</tpAmb><xServ>CONSULTAR</xServ><chNFe>${accessKey}</chNFe></consSitNFe>`;
  return Object.freeze({ operation: 'protocol', requestId, accessKey, model: expectedModel, environment,
    endpoint: ENDPOINTS[expectedModel], xml, xmlDigest: createHash('sha256').update(xml, 'utf8').digest('hex'),
    requiresMutualTls: true, canTransmit: false });
}
