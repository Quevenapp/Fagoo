import {parseReturn} from './return.mjs';
import {requireCnab} from './primitives.mjs';
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const canonical=x=>JSON.stringify(x&&typeof x==='object'?(Array.isArray(x)?x.map(v=>JSON.parse(canonical(v))):Object.fromEntries(Object.keys(x).sort().map(k=>[k,JSON.parse(canonical(x[k]))]))):x);

/** Reparse private bytes each time. This attests correspondence, never bank origin or financial eligibility. */
export async function verifyOperationalReturnEvent({bytes,profile,century=2000,fileHash,eventHash,lineHash,line,payload,fileWarnings,generatedOn}={}){
 requireCnab(bytes instanceof Uint8Array&&bytes.length<=4020000&&century===2000&&hash(fileHash)&&hash(eventHash)&&hash(lineHash)&&Number.isInteger(line)&&line>=2&&line<=9999&&payload&&typeof payload==='object'&&!Array.isArray(payload)&&Array.isArray(fileWarnings),'CNAB_OPERATIONAL_PROOF_INVALID');
 const parsed=await parseReturn(bytes,{profile,century});
 const event=parsed.events.find(e=>e.line===line);requireCnab(event&&parsed.fileHash===fileHash&&event.eventHash===eventHash&&event.lineHash===lineHash&&parsed.generatedOn===generatedOn&&canonical(parsed.warnings)===canonical(fileWarnings),'CNAB_OPERATIONAL_PROOF_MISMATCH');
 const{eventHash:ignoredEvent,lineHash:ignoredLine,line:ignoredNumber,...body}=event;
 requireCnab(canonical(body)===canonical(payload),'CNAB_OPERATIONAL_PROOF_MISMATCH');
 return Object.freeze({parsed,event,bytesVerified:true,originAuthenticated:false,financialMutationPerformed:false});
}
