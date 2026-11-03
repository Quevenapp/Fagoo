import {accessConfig} from './access-config';
import {createInviteActivation} from './invite-activation';
import {createTransientInviteAuth} from './invite-auth-client';

/** Must run synchronously in main, before importing App or rendering React. */
export function captureBrowserInvite({href,origin,replaceUrl,env}:{href:string;origin:string;replaceUrl:(path:string)=>void;env:Record<string,unknown>}){
 let transient:ReturnType<typeof createTransientInviteAuth>|null=null;
 return createInviteActivation({href,expectedOrigin:origin,replaceUrl,
  createAuth(){const configuration=accessConfig(env);if(!configuration)throw new Error('ACTIVATION_NOT_CONFIGURED');transient=createTransientInviteAuth(configuration);return transient.auth;},
  abortRequests(){transient?.abortRequests();},clearSession(){transient?.clearSession();transient=null;},async endSession(){await transient?.endSession();}
 });
}
