import { requireCnab } from './primitives.mjs';
import { validateProfile } from './profiles.mjs';
import { serializeRemittance } from './remittance-serializer.mjs';

/** Compatibility entry: existing callers can still produce homologation artifacts only. */
export async function generateRemittance(input={}){
 requireCnab(input.purpose==='homologation','CNAB_PRODUCTION_GENERATION_UNAVAILABLE');
 validateProfile(input.profile, {generation:true});
 return serializeRemittance(input);
}
/** Server orchestration must verify the persisted operational authorization before this pure encoder. */
export async function generateOperationalRemittance(input={}){
 requireCnab(input.purpose==='operational','CNAB_OPERATIONAL_PURPOSE_REQUIRED');
 validateProfile(input.profile, {generation:true});
 const generated=await serializeRemittance(input);
 return{...generated,bankTransmissionPerformed:false,financialMutationPerformed:false,originAuthenticated:false};
}
