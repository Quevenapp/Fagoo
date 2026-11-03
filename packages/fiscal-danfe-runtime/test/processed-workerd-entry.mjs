import {createProcessedGateway} from '../src/processed-gateway.mjs';
export default{fetch:createProcessedGateway({fetchImpl:(...args)=>fetch(...args),now:()=>Date.now(),nonce:()=>crypto.randomUUID()})};
