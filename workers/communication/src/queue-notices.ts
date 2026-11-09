import {all,one,exec,batch} from './db';
import {type Env,type Actor,ApiError,now} from './types';
const queueScopes=['routing:read','routing:send','conversations:read','conversations:write'];
export async function queueRouting(env:Env,profile:string,input?:any){
 if(input){
  if(!['pool','number'].includes(input.source_type) || typeof input.source_id!=='string')throw new ApiError(400,'invalid_route','Selecione uma linha ou grupo.');
  const source=await one(env,input.source_type==='pool'?'SELECT id FROM number_pools WHERE id=? AND profile_id=?':'SELECT n.connection_id id FROM meta_numbers n JOIN connections c ON c.id=n.connection_id WHERE n.connection_id=? AND c.profile_id=?',input.source_id,profile);
  if(!source)throw new ApiError(404,'not_found','Rota não encontrada nesta unidade.');
  await exec(env,'INSERT INTO fagoo_queue_routes(profile_id,source_type,source_id) VALUES(?,?,?) ON CONFLICT(profile_id) DO UPDATE SET source_type=excluded.source_type,source_id=excluded.source_id',profile,input.source_type,input.source_id);
 }
 return {route:await one(env,'SELECT source_type,source_id FROM fagoo_queue_routes WHERE profile_id=?',profile),free_only:true};
}
export async function sendQueueNotice(env:Env,input:any){
 if(!input || !/^[a-f0-9-]{36}$/i.test(input.notice_id || '') || !/^[a-f0-9-]{36}$/i.test(input.unit_id || '') || !/^\d{8,15}$/.test(input.phone || '') || typeof input.text!=='string' || input.text.length>3800 || !Number.isSafeInteger(input.expires_at)) throw new ApiError(400,'invalid_notice','Aviso inválido.');
 if(input.expires_at<=now())return {status:'expired',delivery_id:null};
 const mapping=await one(env,'SELECT profile_id FROM fagoo_profiles WHERE unit_id=?',input.unit_id);
 if(!mapping)throw new ApiError(409,'communication_not_initialized','Abra e configure o atendimento da unidade.');
 const profile=mapping.profile_id,route=await one(env,'SELECT * FROM fagoo_queue_routes WHERE profile_id=?',profile);
 if(!route)throw new ApiError(409,'queue_route_required','Configure a linha de avisos da fila no Fagoo.');
 const appId=`fagoo-queue:${input.unit_id}`;
 if(!/^[a-f0-9-]{36}$/i.test(input.claim_id || ''))throw new ApiError(400,'invalid_notice','Reserva do aviso inválida.');
 await exec(env,'INSERT OR IGNORE INTO fagoo_queue_notices(notice_id,claim_id,unit_id) VALUES(?,?,?)',input.notice_id,input.claim_id,input.unit_id);
 await batch(env,[
  ["INSERT INTO applications(id,name,profiles,scopes,bots,rate,run_limit,disabled,created) VALUES(?,?,?,?,'[]',120,1,0,?) ON CONFLICT(id) DO UPDATE SET profiles=excluded.profiles,scopes=excluded.scopes,disabled=0",[appId,'Avisos da fila Fagoo',JSON.stringify([profile]),JSON.stringify(queueScopes),now()]],
  ['DELETE FROM number_router_grants WHERE app_id=?',[appId]],
  ['INSERT INTO number_router_grants(app_id,profile_id,source_type,source_id,allow_paid) VALUES(?,?,?,?,0)',[appId,profile,route.source_type,route.source_id]],
 ]);
 const actor:Actor={id:`app:${appId}`,kind:'app',name:'Avisos da fila Fagoo',role:'service',profiles:[profile],scopes:queueScopes,bots:[],rate:120,runLimit:1};
 const result=await env.COORDINATOR.get(env.COORDINATOR.idFromName(profile)).fetch('https://coordinator/command',{method:'POST',body:JSON.stringify({profile,actor,operation:'router.send',key:input.notice_id,requestId:input.notice_id,data:{[route.source_type==='pool'?'pool_id':'number_id']:route.source_id,to:input.phone,text:input.text,external_id:`queue:${input.notice_id}`,free_only:true,expires_at:Math.min(input.expires_at,now()+86400000)}})});
 const value=await result.json<any>();
 if(!result.ok)return {status:value.error?.code==='operation_unknown'?'unknown':'failed',delivery_id:null,error:value.error?.code};
 await exec(env,'UPDATE fagoo_queue_notices SET delivery_id=? WHERE notice_id=? AND claim_id=?',value.delivery_id,input.notice_id,input.claim_id);
 return {status:value.status,delivery_id:value.delivery_id};
}
export async function queueNoticeStatus(env:Env,input:any){
 const row=await one(env,'SELECT o.id,o.status,o.error FROM outbox o JOIN fagoo_profiles f ON f.profile_id=o.profile_id WHERE f.unit_id=? AND o.id=? AND o.actor=?',input.unit_id,input.delivery_id,`app:fagoo-queue:${input.unit_id}`);
 if(!row)return {status:'unknown',delivery_id:input.delivery_id};
 return {status:row.status,delivery_id:row.id};
}
