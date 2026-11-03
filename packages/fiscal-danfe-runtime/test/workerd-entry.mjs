import {createDanfeGateway} from '../src/gateway.mjs';
const gateway=createDanfeGateway({fetchImpl:fetch,now:Date.now,nonce:()=>crypto.randomUUID()});
export default {fetch(request,env){return gateway(request,env);}};
