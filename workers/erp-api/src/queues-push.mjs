// SPDX-License-Identifier: AGPL-3.0-only
// Ported from Vinki cloud/intermediario push adapters; provider acceptance is not device delivery.
// FCM HTTP v1: https://firebase.google.com/docs/cloud-messaging/send/v1-api
// APNs token authentication: https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns
const encoder=new TextEncoder();let fcmCache=null,apnsCache=null;
const b64=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
const part=value=>b64(encoder.encode(JSON.stringify(value)));
function pem(value){const raw=value.replace(/-----[^-]+-----/g,'').replace(/\s/g,'');return Uint8Array.from(atob(raw),c=>c.charCodeAt(0));}
async function jwt(privateKey,algorithm,header,payload){
 const key=await crypto.subtle.importKey('pkcs8',pem(privateKey),algorithm==='RS256'?{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'}:{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
 const input=part({alg:algorithm,...header})+'.'+part(payload);
 const signature=await crypto.subtle.sign(algorithm==='RS256'?'RSASSA-PKCS1-v1_5':{name:'ECDSA',hash:'SHA-256'},key,encoder.encode(input));return input+'.'+b64(signature);
}
const keyHash=async value=>b64(await crypto.subtle.digest('SHA-256',encoder.encode(value)));
const result=(status,delivery_id=null,reason=null)=>({status,delivery_id,reason});
async function request(fetcher,url,options){return fetcher(url,{...options,redirect:'error',signal:AbortSignal.timeout(10000)});}
export function resetQueuePushCache(){fcmCache=null;apnsCache=null;}
/** The caller owns the durable claim and ACK; this function NEVER retries a notification. */
export async function dispatchQueuePush({env,rpc,notice,fetcher=fetch,now=()=>Date.now()}){
 if(!['push_fcm','push_apns'].includes(notice.channel)||typeof notice.destination!=='string'||notice.destination.length<8||notice.destination.length>4096||typeof notice.text!=='string'||notice.text.length>1000)return result('failed',null,'invalid_notice');
 const deadline=Date.parse(notice.expires_at);if(!Number.isFinite(deadline)||deadline<=now())return result('expired');
 const allowed=()=>rpc('fagoo_queue_notice_delivery_allowed',{p_notice_id:notice.notice_id,p_claim_id:notice.claim_id,p_delivery_id:null});
 let authorization,project,topic,apnsBase;
 try{
  if(notice.channel==='push_fcm'){
   const value=env.FAGOO_QUEUE_FCM_SERVICE_ACCOUNT_JSON??env.FCM_CONTA_SERVICO;if(!value)return result('failed',null,'provider_not_configured');
   const account=JSON.parse(value);if(!/^[a-zA-Z0-9-]{3,100}$/.test(account.project_id??'')||typeof account.client_email!=='string'||typeof account.private_key!=='string')return result('failed',null,'provider_invalid');
   const fingerprint=await keyHash(value);project=account.project_id;
   if(fcmCache?.fingerprint===fingerprint&&fcmCache.expires>now()+60000)authorization=fcmCache.token;
   else{
    const iat=Math.floor(now()/1000),assertion=await jwt(account.private_key,'RS256',{typ:'JWT'},{iss:account.client_email,scope:'https://www.googleapis.com/auth/firebase.messaging',aud:'https://oauth2.googleapis.com/token',iat,exp:iat+3600});
    const response=await request(fetcher,'https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion}).toString()});
    if(!response.ok)return result('failed',null,'provider_auth_unavailable');const value=await response.json();if(typeof value.access_token!=='string'||!value.access_token)return result('failed',null,'provider_auth_invalid');
    authorization=value.access_token;fcmCache={fingerprint,token:authorization,expires:now()+Math.min(Number(value.expires_in)||3600,3600)*1000};
   }
  }else{
   const privateKey=env.FAGOO_QUEUE_APNS_PRIVATE_KEY??env.APNS_CHAVE_P8,kid=env.FAGOO_QUEUE_APNS_KEY_ID??env.APNS_KEY_ID,team=env.FAGOO_QUEUE_APNS_TEAM_ID??env.APNS_TEAM_ID;topic=env.FAGOO_QUEUE_APNS_TOPIC??env.APNS_TOPICO;
   if(!privateKey||!kid||!team||!topic)return result('failed',null,'provider_not_configured');
   if(!/^[a-fA-F0-9]{64,200}$/.test(notice.destination)||! /^[A-Za-z0-9.-]{1,200}$/.test(topic))return result('failed',null,'invalid_apns_destination');
   const fingerprint=await keyHash(privateKey+kid+team);
   if(apnsCache?.fingerprint===fingerprint&&now()-apnsCache.created<50*60000)authorization=apnsCache.token;
   else{authorization=await jwt(privateKey,'ES256',{kid},{iss:team,iat:Math.floor(now()/1000)});apnsCache={fingerprint,token:authorization,created:now()};}
   apnsBase=(env.FAGOO_QUEUE_APNS_ENVIRONMENT??'production')==='sandbox'?'https://api.sandbox.push.apple.com':'https://api.push.apple.com';
  }
 }catch{return result('failed',null,'provider_auth_unavailable');}
 // Authorization refresh can take time; the current ticket must still allow this exact call.
 try{if(deadline<=now()||await allowed()!==true)return result('expired');}catch{return result('failed',null,'authority_unavailable');}
 const data={token_publico:notice.public_token,notice_id:notice.notice_id};let response;
 try{
  if(notice.channel==='push_fcm'){
   response=await request(fetcher,`https://fcm.googleapis.com/v1/projects/${project}/messages:send`,{method:'POST',headers:{authorization:`Bearer ${authorization}`,'content-type':'application/json'},body:JSON.stringify({message:{token:notice.destination,notification:{title:'FAGOO · Sua vez',body:notice.text},data,android:{ttl:Math.max(1,Math.floor((deadline-now())/1000))+'s',collapse_key:notice.public_token,priority:'high'},apns:{headers:{'apns-expiration':String(Math.floor(deadline/1000)),'apns-collapse-id':notice.public_token,'apns-priority':'10'}}}})});
   const value=await response.json().catch(()=>null);if(response.ok)return typeof value?.name==='string'?result('sent',value.name):result('unknown',null,'provider_response_invalid');
   if(response.status===401)fcmCache=null;return result('failed',null,'provider_rejected');
  }
  response=await request(fetcher,`${apnsBase}/3/device/${notice.destination}`,{method:'POST',headers:{authorization:`bearer ${authorization}`,'apns-topic':topic,'apns-push-type':'alert','apns-priority':'10','apns-expiration':String(Math.floor(deadline/1000)),'apns-collapse-id':notice.public_token,'apns-id':notice.notice_id,'content-type':'application/json'},body:JSON.stringify({aps:{alert:{title:'FAGOO · Sua vez',body:notice.text},sound:'default'},...data})});
  if(response.status===200)return result('sent',response.headers.get('apns-id')??notice.notice_id);
  if(response.status===403)apnsCache=null;return result(response.status===410?'expired':'failed',null,'provider_rejected');
 }catch{return result('unknown',null,'delivery_result_unknown');}
}
