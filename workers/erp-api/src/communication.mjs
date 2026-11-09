import {dispatchQueuePush} from './queues-push.mjs';
/** Fagoo's only human gateway to the internal communication engine. */
export const COMMUNICATION_BASE = '/v1/communication';
export const communicationRoute = path => path === COMMUNICATION_BASE || path.startsWith(`${COMMUNICATION_BASE}/`);
export const communicationPublicRoute = path => /^\/webhooks\/(?:meta|meta-accounts|telegram)\/[^/]+$/.test(path) || /^\/internal\/v1\/connectors\/[^/]+\//.test(path) || /^\/api\/public\/whatsapp\/[^/]+$/.test(path) || path.startsWith('/api/v1/');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (status, code) => Response.json({error:{code,message:code}}, {status,headers:{'Cache-Control':'no-store'}});
export async function forwardCommunicationPublic({request,env}) {
  if (!communicationPublicRoute(new URL(request.url).pathname)) return fail(404,'COMMUNICATION_NOT_FOUND');
  if (!env.COMMUNICATION_PUBLIC?.fetch) return fail(503,'COMMUNICATION_NOT_CONFIGURED');
  // No body parsing, redirects or credential substitution: provider signatures remain valid.
  return env.COMMUNICATION_PUBLIC.fetch(request);
}
export async function handleCommunication({request,env,userId,deviceId,rpc,context}) {
  if (deviceId || !UUID.test(userId || '')) return fail(403,'COMMUNICATION_USER_REQUIRED');
  const url = new URL(request.url);
  const route = /^\/v1\/communication\/units\/([^/]+)(\/.*)?$/.exec(url.pathname);
  if (!route || !UUID.test(route[1])) return fail(404,'COMMUNICATION_NOT_FOUND');
  const unitId = route[1], suffix = route[2] || '';
  if (/^\/(?:auth|users|profiles|pairings|system)(?:\/|$)/.test(suffix)) return fail(404,'COMMUNICATION_MANAGED_BY_FAGOO');
  const method = request.method.toUpperCase();
  let payload;
  if (!['GET','HEAD'].includes(method) && (request.headers.get('content-type') || '').includes('application/json')) {
    const raw = await request.clone().text();
    if (raw.length > 2 * 1024 * 1024) return fail(413,'COMMUNICATION_PAYLOAD_TOO_LARGE');
    try { payload = JSON.parse(raw); } catch { return fail(400,'COMMUNICATION_INVALID_JSON'); }
  }
  let capability = 'communication.read';
  if (/^\/(?:devices|events)(?:\/|$)/.test(suffix) && !context?.units?.find(u=>u.id===unitId)?.capabilities?.includes('communication.read')) capability='team.chat';
  if (/^\/(team|internal-chats)(\/|$)/.test(suffix)) capability = 'team.chat';
  else if (suffix === '/queue') capability = 'communication.claim';
  else if (/\/conversations\/[^/]+\/message-actions$/.test(suffix)) capability='communication.reply';
  else if (/^\/(applications|keys|bot-policies|contact-links)(\/|$)/.test(suffix)) capability = 'communication.configure';
  else if (/\/conversations\/[^/]+\/actions$/.test(suffix)) {
    capability = ({claim:'communication.claim',reply:'communication.reply',transfer:'communication.transfer',resume:'communication.transfer',resolve:'communication.reply',note:'communication.reply',tags:'communication.reply',topic:'communication.reply',menu:'communication.reply',protocols:'communication.reply',survey:'communication.reply'})[payload?.action];
    if (!capability) return fail(400,'COMMUNICATION_INVALID_ACTION');
  } else if (!['GET','HEAD'].includes(method) && !/^\/(devices|presence|media|tickets)(\/|$)/.test(suffix)) capability = 'communication.configure';
  else if (!['GET','HEAD'].includes(method) && /^\/(media|tickets)(\/|$)/.test(suffix)) capability = 'communication.reply';
  let grant;
  try { grant = await rpc('fagoo_communication_context',{p_user_id:userId,p_unit_id:unitId,p_capability:capability}); }
  catch(error) { const forbidden=error?.status===403 || error?.code==='PG_42501'; return fail(forbidden?403:503,forbidden?'COMMUNICATION_FORBIDDEN':'COMMUNICATION_AUTHORITY_UNAVAILABLE'); }
  if (!grant || grant.user_id !== userId || grant.unit_id !== unitId || !Array.isArray(grant.capabilities) || !grant.capabilities.includes(capability)) return fail(403,'COMMUNICATION_FORBIDDEN');
  if(suffix==='/bot-policies' && method==='POST') {
    try{return Response.json(await rpc('fagoo_communication_bot_policy',{p_user_id:userId,p_unit_id:unitId,p_bot_id:payload?.bot_id,p_required_capabilities:payload?.required_capabilities,p_enabled:payload?.enabled,p_required_resources:payload?.required_resources || [],p_required_permissions:payload?.required_permissions || []}),{headers:{'Cache-Control':'no-store'}});}catch(error){return fail(error?.status===403 || error?.code==='PG_42501'?403:400,'COMMUNICATION_POLICY_REJECTED');}
  }
  if(suffix==='/bot-policies' && method==='GET')return Response.json(await rpc('fagoo_communication_bot_policies',{p_user_id:userId,p_unit_id:unitId}),{headers:{'Cache-Control':'no-store'}});
  if(suffix==='/contact-links' && method==='POST') {
    try{const allowed=await rpc('fagoo_communication_contact_access',{p_user_id:userId,p_unit_id:unitId,p_contact_id:payload?.canonical_contact_id});grant.canonical_contact_id=allowed.contact_id;}
    catch{return fail(403,'COMMUNICATION_CONTACT_FORBIDDEN');}
  }
  if (!env.COMMUNICATION?.fetch) return fail(503,'COMMUNICATION_NOT_CONFIGURED');
  const target = new URL(request.url);
  target.pathname = `/api/v1/profiles/${encodeURIComponent(grant.profile_id)}${suffix}`;
  if(/^\/(applications|keys)(\/|$)/.test(suffix)) target.pathname='/api/v1'+suffix;
  const headers = new Headers(request.headers);
  for (const key of [...headers.keys()]) if (/^(authorization|cookie|x-fagoo-|x-communication-)/i.test(key)) headers.delete(key);
  headers.set('X-Fagoo-Delegation',JSON.stringify(grant));
  headers.set('X-Fagoo-Client',request.headers.get('X-Fagoo-Client') === 'mobile' ? 'mobile' : 'web');
  // This identity is accepted only by the named service-binding entrypoint.
  const response = await env.COMMUNICATION.fetch(new Request(target,{method,headers,body:['GET','HEAD'].includes(method)?undefined:request.body,redirect:'manual'}));
  const responseHeaders = new Headers(response.headers);
  responseHeaders.delete('set-cookie'); responseHeaders.set('Cache-Control','no-store');
  return new Response(response.body,{status:response.status,headers:responseHeaders});
}

/** Cron dispatcher: acknowledgement is separate from enqueueing; unknown is never resent. */
export async function runCommunicationNoticeTasks({env,rpc,publicOrigin}) {
  if(!env.COMMUNICATION?.sendQueueNotice)return {configured:false};
  const origin=new URL(publicOrigin);
  if(origin.protocol!=='https:' || origin.username || origin.password || origin.pathname!=='/')throw Error('FAGOO_PUBLIC_ORIGIN_REQUIRED');
  const pending=await rpc('fagoo_queue_notice_pending_deliveries',{});
  for(const notice of pending.notices || []) {
    try {const result=await env.COMMUNICATION.queueNoticeStatus(notice);const status=({sent:'sent',failed:'failed',cancelled:'expired',expired:'expired'})[result.status];
      if(status)await rpc('fagoo_queue_notice_ack',{p_notice_id:notice.notice_id,p_claim_id:notice.claim_id,p_status:status,p_delivery_id:notice.delivery_id});
    }catch{/* Keep unknown for explicit reconciliation, never send again. */}
  }
  const claimId=crypto.randomUUID();
  const claim=await rpc('fagoo_queue_notice_claim',{p_claim_id:claimId,p_limit:20});
  for(const claimed of claim.notices || []) {
    const notice=await rpc('fagoo_queue_notice_revalidate',{p_notice_id:claimed.notice_id,p_claim_id:claimed.claim_id});
    if(!notice)continue;
    let status='unknown',deliveryId=null;
    try {
      const link=new URL(`/senha/${encodeURIComponent(notice.public_token)}`,origin).href;
      const result=notice.channel && notice.channel!=='whatsapp' ? await dispatchQueuePush({env,rpc,notice}) : await env.COMMUNICATION.sendQueueNotice({...notice,expires_at:typeof notice.expires_at==='number'?notice.expires_at:Date.parse(notice.expires_at),text:`${notice.text}\n${link}`,free_only:true});
      deliveryId=result.delivery_id || null;
      status=({sent:'sent',failed:'failed',expired:'expired'})[result.status] || 'unknown';
    }catch{/* Lost acknowledgement is unknown; the dispatcher must not repeat physical delivery. */}
    await rpc('fagoo_queue_notice_ack',{p_notice_id:notice.notice_id,p_claim_id:notice.claim_id,p_status:status,p_delivery_id:deliveryId});
  }
  return {configured:true,claimed:claim.notices?.length || 0};
}
