import {env,createExecutionContext} from 'cloudflare:test';
import {it,expect,vi,afterEach} from 'vitest';
import {fcmMessage} from '../src/push-fcm';
import {FagooCommunication} from '../src/index';
import {exec} from '../src/db';
import type {FagooGrant} from '../src/managed';

afterEach(()=>vi.unstubAllGlobals());

async function managedFixture() {
 const user=crypto.randomUUID(),other=crypto.randomUUID(),unit=crypto.randomUUID(),id='device-'+crypto.randomUUID();
 const grant:FagooGrant={user_id:user,unit_id:unit,profile_id:unit,name:'Synthetic',unit_name:'Synthetic unit',role:'operacao',capabilities:['communication.read','team.chat'],team_ids:[],bots:[],people:[{id:other,name:'Other synthetic user',role:'operacao',team_ids:[]}]};
 const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']) as CryptoKeyPair;
 const der=new Uint8Array(await crypto.subtle.exportKey('pkcs8',pair.privateKey));
 const account={type:'service_account',project_id:'synthetic-fagoo',client_email:`${user}@synthetic.iam.gserviceaccount.com`,token_uri:'https://oauth2.googleapis.com/token',private_key:`-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`};
 let allowed=true;const calls:{url:string;body:any}[]=[];let onOAuth:()=>void|Promise<void>=()=>{};
 const runtime={...env,FAGOO_MANAGED:'true',FAGOO_QUEUE_FCM_SERVICE_ACCOUNT_JSON:JSON.stringify(account),FAGOO_AUTHORITY:{authorize:async()=>{if(!allowed)throw Error('revoked');return grant;}}};
 const engine=new FagooCommunication(createExecutionContext(),runtime);
 const request=(suffix:string,method='POST',body?:unknown,client='web')=>engine.fetch(new Request(`https://fagoo.test/api/v1/profiles/${unit}${suffix}`,{method,headers:{'X-Fagoo-Delegation':JSON.stringify(grant),'X-Fagoo-Client':client,'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},body:body===undefined?undefined:JSON.stringify(body)}));
 vi.stubGlobal('fetch',async(input:any,init:any={})=>{
  const url=String(input);calls.push({url,body:init.body});
  if(url==='https://oauth2.googleapis.com/token'){await onOAuth();return Response.json({access_token:'synthetic-access-token',expires_in:3600});}
  if(url==='https://fcm.googleapis.com/v1/projects/synthetic-fagoo/messages:send')return Response.json({name:'projects/synthetic-fagoo/messages/synthetic'});
  throw Error('Unexpected external request');
 });
 expect((await request(`/devices/${id}`,'PUT',{platform:'ios',provider:'fcm',token:'synthetic-'+id,enabled:true})).status).toBe(200);
 return {user,other,unit,id,grant,runtime,request,calls,revoke:()=>{allowed=false;},onOAuth:(action:()=>void|Promise<void>)=>{onOAuth=action;}};
}

it('managed iOS push is silent data and cannot display after switching to panel',()=>{
 const value=fcmMessage({platform:'ios',token:'synthetic',title:'Fagoo',body:'Novo aviso',data:{user_id:'actor',unit_id:'unit'},priority:'high',data_only:true}) as any;
 expect(value.message.notification).toBeUndefined();
 expect(value.message.apns.headers['apns-push-type']).toBe('background');
 expect(value.message.apns.headers['apns-priority']).toBe('5');
 expect(value.message.apns.payload.aps).toEqual({'content-available':1});
 expect(value.message.data.user_id).toBe('actor');
});

it('the delegated managed device test is reachable but emits only scoped generic data, never an automatic iOS alert',async()=>{
 const f=await managedFixture();
 const response=await f.request(`/devices/${f.id}/test`);
 expect(response.status).toBe(200);expect((await response.json() as any).results[0].status).toBe('ok');
 const payload=JSON.parse(f.calls.find(c=>c.url.includes('/messages:send'))!.body).message;
 expect(payload.notification).toBeUndefined();expect(payload.apns.payload.aps).toEqual({'content-available':1});
 expect(payload.apns.headers).toMatchObject({'apns-push-type':'background','apns-priority':'5'});
 expect(payload.data).toEqual({title:'Fagoo',body:'Notificação de teste recebida com sucesso.',type:'test',server:'https://fagoo.test',user_id:f.user,unit_id:f.unit,profile_id:f.unit});
 // Native apps currently ignore type=test. Even after a mode switch APNs cannot display it itself.
 expect(payload.data.conversation_id).toBeUndefined();expect(payload.data.chat_id).toBeUndefined();
 expect((await f.request(`/devices/${f.id}/test`,'POST',undefined,'mobile')).status).toBe(403);
 expect([403,404]).toContain((await f.request('/system/push/test')).status);
});

it('managed push tests cannot target a disabled device, another unit, another owner or an old installation',async()=>{
 const f=await managedFixture();
 for(const [column,value] of [['enabled',0],['profiles',JSON.stringify([crypto.randomUUID()])],['user_id',f.other],['origin','https://old.test']]){
  await exec(f.runtime,`UPDATE devices SET ${column}=? WHERE id=?`,value,f.id);
  const response=await f.request(`/devices/${f.id}/test`);
  expect([403,404]).toContain(response.status);expect(f.calls).toEqual([]);
  await exec(f.runtime,'UPDATE devices SET enabled=1,profiles=?,user_id=?,origin=? WHERE id=?',JSON.stringify([f.unit]),f.user,'https://fagoo.test',f.id);
 }
});

it('managed push tests recheck authority and registration after OAuth, before any FCM send',async()=>{
 for(const revokeRegistration of [false,true]){
  const f=await managedFixture();
  f.onOAuth(async()=>{if(revokeRegistration)await exec(f.runtime,'UPDATE devices SET enabled=0 WHERE id=?',f.id);else f.revoke();});
  const response=await f.request(`/devices/${f.id}/test`);
  expect(response.status).toBe(200);expect((await response.json() as any).results[0]).toMatchObject({status:'error',error:'push_not_authorized'});
  expect(f.calls.map(c=>c.url)).toEqual(['https://oauth2.googleapis.com/token']);
 }
});
