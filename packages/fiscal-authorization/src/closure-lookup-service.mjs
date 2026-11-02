/**075 discovery only. A404 never creates a command or invokes074 close. */
import {data,need,id,scope} from './service-common.mjs';
import {captureClosureLookupInput,closureLookupPublicFromLedger} from './closure-lookup-dto.mjs';
export function createAuthorizationClosureLookupService(configuration){
 const p=data(configuration,['lookupRpc']);need(typeof p.lookupRpc==='function');const {lookupRpc}=p;
 async function closureLookup(input,options={}){
  const x=data(input,['actor','authorizationCommandId','expectedAttemptId']);need(id(x.actor));const q=captureClosureLookupInput({authorization_command_id:x.authorizationCommandId,expected_attempt_id:x.expectedAttemptId}),args={p_user_id:x.actor,p_authorization_command_id:q.authorization_command_id,p_expected_attempt_id:q.expected_attempt_id},s=scope(options,15000);
  try{const value=await s.bounded(()=>lookupRpc(args,{signal:s.signal,deadline:s.deadline}));s.check();const out=closureLookupPublicFromLedger(value,q);s.check();return out;}finally{s.close();}
 }
 return Object.freeze({closureLookup});
}
