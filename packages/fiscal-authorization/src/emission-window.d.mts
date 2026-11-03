export const NFCE_MAX_AGE_MS:300000;
export const NFCE_MAX_FUTURE_MS:300000;
export const NFCE_OPERATIONAL_MARGIN_MS:30000;
export type NfceEmissionWindow=Readonly<{issued_at:string;observed_at:string;expires_at:string;send_before:string;
 max_age_seconds:300;safety_margin_seconds:0|30;status:'valid'|'expired'|'future'|'too_short'}>;
export type NfceEmissionWindowInput=Readonly<{model:'55'|'65';environment:'2';emissionType:'1';issuedAt:string;now:number;safetyMarginMs:0|30000}>;
export class NfceEmissionWindowError extends Error {readonly code:string;}
/** Pure projection; caller must attest the immutable identity and choose a trusted clock. */
export function evaluateNfceEmissionWindow(input:NfceEmissionWindowInput):NfceEmissionWindow|null;
/** Only for NEW normal dispatch; never gate history/recovery or processed readers. */
export function requireNfceEmissionWindow(input:NfceEmissionWindowInput):NfceEmissionWindow|null;
