import {createAuthorizationGateway} from '../src/gateway.mjs';
const gateway=createAuthorizationGateway({fetchImpl:(...args)=>fetch(...args),now:Date.now,nonce:()=>crypto.randomUUID()});
export default {fetch:(request,env)=>gateway(request,env)};
