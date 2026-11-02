// This selection describes an offline format, not live SEFAZ acceptance.
// NT 2025.001 v1.03 removes CSC from QR v3. Keep the implemented scope exact.
export const NFCE_SP_HOMOLOGATION_QR_V3 = 'sp-homologation-online-qr-v3';
const profile = Object.freeze({
  id: NFCE_SP_HOMOLOGATION_QR_V3, version: '3', cUF: '35', model: '65',
  environment: '2', tpEmis: '1', cscRequired: false,
  qrEndpoint: 'https://www.homologacao.nfce.fazenda.sp.gov.br/qrcode',
  consultationEndpoint: 'https://www.homologacao.nfce.fazenda.sp.gov.br/consulta',
});

/** Metadata only. Unknown profiles and other contexts have no implemented policy. */
export function nfceQrProfile(identity, selected) {
  if (selected !== profile.id || !identity || typeof identity !== 'object') return null;
  return ['cUF', 'model', 'environment', 'tpEmis'].every(key => identity[key] === profile[key]) ? profile : null;
}
