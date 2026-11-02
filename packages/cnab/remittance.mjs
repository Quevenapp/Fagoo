import { requireCnab } from './primitives.mjs';
import { validateProfile } from './profiles.mjs';
import { serializeRemittance } from './remittance-serializer.mjs';

/** Produces a local homologation artifact. Never transmits to a bank. */
export async function generateRemittance(input={}) {
  requireCnab(input.purpose==='homologation','CNAB_PRODUCTION_GENERATION_UNAVAILABLE');
  validateProfile(input.profile,{generation:true});
  return serializeRemittance(input);
}
