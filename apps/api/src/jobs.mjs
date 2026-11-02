import { Pool } from 'pg';
import { setTimeout } from 'node:timers/promises';
import { configuration } from './config.mjs';
import { dispatchWebhookBatch } from './webhook-delivery.mjs';
const config=configuration(),pool=new Pool({connectionString:config.databaseUrl,max:2});
pool.on('error',()=>console.error(JSON.stringify({component:'event-delivery',error:'IDLE_CONNECTION_FAILED'})));
const shutdown=new AbortController();for(const event of ['SIGTERM','SIGINT'])process.on(event,()=>shutdown.abort());
while(!shutdown.signal.aborted){
 try{const result=await dispatchWebhookBatch(pool,config);if(result.claimed)console.log(JSON.stringify({component:'event-delivery',...result}));}
 catch{console.error(JSON.stringify({component:'event-delivery',error:'DISPATCH_FAILED'}));}
 await setTimeout(5000,undefined,{signal:shutdown.signal}).catch(()=>{});
}
await pool.end();
