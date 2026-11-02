/** Pure clock projection for a NEW normal NFC-e homologation dispatch only.
 * This does not attest XML, grant permission, or determine remote reception time.
 * Historical reads, response validation and NF-e55 must not use it as a gate. */
import {validFiscalTimestamp} from '../../fiscal-core/src/identity.mjs';

export const NFCE_MAX_AGE_MS=300000;
export const NFCE_MAX_FUTURE_MS=300000;
export const NFCE_OPERATIONAL_MARGIN_MS=30000;
export class NfceEmissionWindowError extends Error {
 constructor(code){super(code);this.name='NfceEmissionWindowError';this.code=code;}
}
const invalid=()=>{throw new NfceEmissionWindowError('AUTHORIZATION_NFCE_EMISSION_INPUT_INVALID');};
function capture(value){
 const keys=['model','environment','emissionType','issuedAt','now','safetyMarginMs'];
 try{
  if(!value||![Object.prototype,null].includes(Object.getPrototypeOf(value)))invalid();
  const d=Object.getOwnPropertyDescriptors(value),own=Reflect.ownKeys(d);
  if(own.length!==keys.length||own.some(k=>typeof k!=='string'||!keys.includes(k)||!d[k].enumerable||!Object.hasOwn(d[k],'value')))invalid();
  return Object.fromEntries(keys.map(k=>[k,d[k].value]));
 }catch{invalid();}
}
function timestamp(value){
 if(typeof value!=='string')invalid();
 // Original fiscal grammar, or the exact millisecond UTC projection we emit.
 const fiscal=[20,25].includes(value.length)&&validFiscalTimestamp(value);
 const canonical=value.length===24&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
  &&Number.isFinite(Date.parse(value))&&new Date(Date.parse(value)).toISOString()===value;
 if(!fiscal&&!canonical)invalid();
 return Date.parse(value);
}
export function evaluateNfceEmissionWindow(input){
 const v=capture(input);
 if(v.model==='55')return null;
 if(v.model!=='65'||v.environment!=='2'||v.emissionType!=='1'||![0,NFCE_OPERATIONAL_MARGIN_MS].includes(v.safetyMarginMs)
  ||!Number.isSafeInteger(v.now)||v.now<Date.UTC(2000,0,1)||v.now>Date.UTC(9999,11,31)-NFCE_MAX_AGE_MS)invalid();
 const issued=timestamp(v.issuedAt),expires=issued+NFCE_MAX_AGE_MS,sendBefore=expires-v.safetyMarginMs;
 if(issued<Date.UTC(2000,0,1)||expires>Date.UTC(9999,11,31))invalid();
 const status=issued-v.now>NFCE_MAX_FUTURE_MS?'future':v.now>=expires?'expired':v.now>=sendBefore?'too_short':'valid';
 return Object.freeze({issued_at:new Date(issued).toISOString(),observed_at:new Date(v.now).toISOString(),
  expires_at:new Date(expires).toISOString(),send_before:new Date(sendBefore).toISOString(),
  max_age_seconds:300,safety_margin_seconds:v.safetyMarginMs/1000,status});
}
/** Throws a closed local refusal. A prior use/dispatch remains consumed. */
export function requireNfceEmissionWindow(input){
 const value=evaluateNfceEmissionWindow(input);
 if(value&&value.status!=='valid')throw new NfceEmissionWindowError({expired:'AUTHORIZATION_NFCE_EMISSION_EXPIRED',
  future:'AUTHORIZATION_NFCE_EMISSION_FUTURE',too_short:'AUTHORIZATION_NFCE_EMISSION_WINDOW_TOO_SHORT'}[value.status]);
 return value;
}
