import { buildAccessKey } from '../../fiscal-core/src/identity.mjs';
import { NFCE_SP_HOMOLOGATION_QR_V3, nfceQrProfile } from '../../fiscal-core/src/nfce-qr-profile.mjs';
import { need } from './common.mjs';

// Explicit, offline test profile. Endpoints are constants, never caller-supplied URLs.
export { NFCE_SP_HOMOLOGATION_QR_V3 };

export function expectedNfceSupplement(identity, profile) {
  need(profile === NFCE_SP_HOMOLOGATION_QR_V3, 'NFCE_QR_PROFILE_UNSUPPORTED');
  const selected = nfceQrProfile(identity, profile);
  need(selected, 'NFCE_QR_IDENTITY_UNSUPPORTED');
  const accessKey = buildAccessKey(identity);
  return Object.freeze({ profile, version:selected.version, qrCode:`${selected.qrEndpoint}?p=${accessKey}|3|2`,
    urlChave:selected.consultationEndpoint, derivedFromSignedIdentity:true, partOfSignature:false });
}
