import { all, one, exec } from './db';
import { type Actor, type Env, ApiError, now } from './types';
import {queueRouting} from './queue-notices';

export interface FagooGrant {
  user_id:string; unit_id:string; profile_id:string; name:string; unit_name:string;
  role:string; capabilities:string[]; team_ids:string[]; bots:string[];
  people:{id:string;name:string;role:string;team_ids:string[]}[];
  canonical_contact_id?:string;
  client?:'web'|'mobile';
}
export const managed = (env:Env) => env.FAGOO_MANAGED === 'true';
export const configured = (actor:Actor) => actor.fagoo?.client!=='mobile' && !!actor.fagoo?.capabilities.includes('communication.configure');
export function canonicalActor(actor:Actor,id:string|null|undefined){return id ? actor.fagoo?.aliases?.[id] || id : id;}
export function actorIds(actor:Actor,id=actor.id){return [id,...Object.entries(actor.fagoo?.aliases || {}).filter(([,target])=>target===id).map(([source])=>source)];}
export function chatPeer(actor:Actor,chat:any){return canonicalActor(actor,actorIds(actor).includes(chat.member_a)?chat.member_b:chat.member_a) as string;}
export async function attachAliases(env:Env,actor:Actor){if(actor.fagoo){const rows=await all(env,'SELECT source_actor,canonical_user_id FROM fagoo_actor_aliases WHERE profile_id=?',actor.profiles[0]);actor.fagoo.aliases=Object.fromEntries(rows.map(r=>[r.source_actor,r.canonical_user_id]));}return actor;}
export function actorFromGrant(grant:FagooGrant):Actor {
  if (!grant || !/^[a-f0-9-]{36}$/i.test(grant.user_id) || !/^[a-f0-9-]{36}$/i.test(grant.unit_id) || typeof grant.profile_id !== 'string' || !Array.isArray(grant.capabilities) || !Array.isArray(grant.team_ids) || !Array.isArray(grant.bots)) throw new ApiError(403,'invalid_delegation','Contexto Fagoo inválido.');
  const caps = grant.capabilities;
  const scopes = new Set<string>();
  if(caps.includes('communication.configure') && grant.client!=='mobile') scopes.add('*');
  if(caps.includes('communication.read')) ['conversations:read','media:read','events:read','tickets:read','notes:read'].forEach(s=>scopes.add(s));
  if(caps.includes('communication.claim') || caps.includes('communication.reply') || caps.includes('communication.transfer')) scopes.add('conversations:write');
  if(caps.includes('communication.reply')) ['media:write','tickets:write'].forEach(s=>scopes.add(s));
  if(caps.includes('team.chat')) ['presence:read','presence:write','bots:read','bots:invoke','events:read'].forEach(s=>scopes.add(s));
  return {id:grant.user_id,kind:'user',name:grant.name,role:caps.includes('communication.configure') && grant.client!=='mobile'?'admin':'operator',profiles:[grant.profile_id],scopes:[...scopes],bots:grant.bots,rate:300,runLimit:10,fagoo:{unitId:grant.unit_id,capabilities:caps,teamIds:grant.team_ids,client:grant.client || 'web',administrator:grant.role==='admin',people:grant.people || []}};
}
export async function syncGrant(env:Env,grant:FagooGrant) {
  await exec(env,"INSERT OR IGNORE INTO profiles(id,name,settings,enabled,created) VALUES(?,?,'{}',0,?)",grant.profile_id,grant.unit_name,now());
  await exec(env,'INSERT INTO fagoo_profiles(profile_id,unit_id) VALUES(?,?) ON CONFLICT(profile_id) DO UPDATE SET unit_id=excluded.unit_id',grant.profile_id,grant.unit_id);
  // No passwords are imported or issued. Managed mode rejects every independent login.
  for(const person of [...(grant.people || []),{id:grant.user_id,name:grant.name,role:grant.role,team_ids:grant.team_ids}]) {
    await exec(env,"INSERT INTO users(id,email,name,password,role,profiles,disabled,created) VALUES(?,?,?,'!FAGOO-MANAGED',?,'[]',0,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,role=excluded.role,disabled=0",person.id,`${person.id}@identity.fagoo.invalid`,person.name,person.role==='admin'?'admin':'operator',now());
    const row=await one(env,'SELECT profiles FROM users WHERE id=?',person.id);
    const profiles=JSON.parse(row.profiles || '[]');
    if(!profiles.includes(grant.profile_id)) await exec(env,'UPDATE users SET profiles=? WHERE id=?',JSON.stringify([...profiles,grant.profile_id]),person.id);
  }
}
export function requireCapability(actor:Actor,capability:string) {
  if(actor.fagoo && !actor.fagoo.capabilities.includes(capability)) throw new ApiError(403,'missing_capability','Permissão insuficiente para esta ação.');
}
export function managedVisible(actor:Actor,c:any,claim=false):boolean {
  if(!actor.fagoo) return true;
  if(!actor.profiles.includes(c.profile_id)) return false;
  if(configured(actor)) return true;
  const team=actor.fagoo.administrator || !c.department_id || actor.fagoo.teamIds.includes(c.department_id);
  if(!team) return false;
  if(canonicalActor(actor,c.owner)===actor.id && c.state==='human') return actor.fagoo.capabilities.includes('communication.read');
  if(claim) return actor.fagoo.capabilities.includes('communication.claim') && c.state==='waiting' && !c.owner;
  return actor.fagoo.capabilities.includes('communication.read') && canonicalActor(actor,c.owner)===actor.id && c.state==='human';
}
export async function currentGrant(env:Env,profile:string,userId:string,capability:string):Promise<FagooGrant|null> {
  if(!managed(env)) return null;
  const mapping=await one(env,'SELECT unit_id FROM fagoo_profiles WHERE profile_id=?',profile);
  if(!mapping || !env.FAGOO_AUTHORITY) return null;
  try { const grant=await env.FAGOO_AUTHORITY.authorize({userId,unitId:mapping.unit_id,capability});
    if(grant?.user_id!==userId || grant.profile_id!==profile || !grant.capabilities?.includes(capability)) return null;
    return grant;
  } catch { return null; }
}
export async function managedPushAllowed(env:Env,profile:string,userId:string,kind:string,resource:string) {
  if(!managed(env)) return true;
  const capability=kind==='internal'?'team.chat':kind==='queue'?'communication.claim':'communication.read';
  const grant=await currentGrant(env,profile,userId,capability);
  if(!grant) return false;
  const actor=await attachAliases(env,actorFromGrant({...grant,client:'mobile'}));
  if(kind==='internal') return !!await one(env,'SELECT id FROM internal_chats WHERE id=? AND profile_id=? AND (member_a IN(SELECT value FROM json_each(?)) OR member_b IN(SELECT value FROM json_each(?)))',resource,profile,JSON.stringify(actorIds(actor)),JSON.stringify(actorIds(actor)));
  const c=await one(env,"SELECT * FROM conversations WHERE id=coalesce((SELECT conversation_id FROM tickets WHERE id=? AND profile_id=?),?) AND profile_id=?",resource,profile,resource,profile);
  return !!c && managedVisible(actor,c,kind==='queue');
}
export async function managedRequest(env:Env,actor:Actor,request:Request):Promise<Response|null> {
  if(!actor.fagoo) return null;
  if(actor.fagoo.client==='mobile' && !/^\/api\/v1\/(?:devices(?:\/[^/]+)?|profiles\/[^/]+\/(?:conversations(?:\/[^/]+(?:\/(?:actions|message-actions))?)?|queue|team|internal-chats(?:\/[^/]+(?:\/messages)?)?|events|presence|media(?:\/.*)?|devices(?:\/.*)?))$/.test(new URL(request.url).pathname)) throw new ApiError(403,'mobile_surface_only','Esta área está disponível na web.');
  const global=/^\/api\/v1\/(applications|keys)(?:\/([^/]+))?/.exec(new URL(request.url).pathname);
  if(global) {
    requireCapability(actor,'communication.configure');
    if(global[2]) {
      const app=await one(env,global[1]==='keys'?'SELECT a.profiles FROM applications a JOIN api_keys k ON k.app_id=a.id WHERE k.id=?':'SELECT profiles FROM applications WHERE id=?',global[2]);
      if(!app || !JSON.parse(app.profiles).includes(actor.profiles[0])) throw new ApiError(404,'not_found','Aplicação não encontrada.');
    }
    return null;
  }
  if(/^\/api\/v1\/devices(?:\/|$)/.test(new URL(request.url).pathname)) {
    if(!actor.fagoo.capabilities.some(c=>c==='communication.read' || c==='team.chat')) throw new ApiError(403,'missing_capability','Notificações pessoais não autorizadas.');
    return null;
  }
  const url=new URL(request.url), route=/^\/api\/v1\/profiles\/([^/]+)(\/.*)?$/.exec(url.pathname);
  if(!route || route[1]!==actor.profiles[0]) throw new ApiError(404,'not_found','Recurso indisponível.');
  const profile=route[1], suffix=route[2] || '';
  if(suffix==='/contact-links' && request.method==='POST') {
    requireCapability(actor,'communication.configure');
    const data=await request.json<any>();
    if(!data.canonical_contact_id || env.FAGOO_GRANT?.canonical_contact_id!==data.canonical_contact_id)throw new ApiError(403,'contact_not_authorized','Contato não autorizado no Fagoo.');
    const contact=await one(env,'SELECT id FROM contacts WHERE id=? AND profile_id=?',data.contact_id,profile);
    if(!contact)throw new ApiError(404,'not_found','Contato de origem não encontrado.');
    const previous=await one(env,'SELECT canonical_contact_id FROM fagoo_contact_links WHERE profile_id=? AND contact_id=?',profile,data.contact_id);
    if(previous && previous.canonical_contact_id!==data.canonical_contact_id && previous.canonical_contact_id!==data.expected_contact_id)throw new ApiError(409,'contact_conflict','Revise o vínculo existente antes de substituir.');
    await exec(env,'INSERT INTO fagoo_contact_links(profile_id,contact_id,canonical_contact_id) VALUES(?,?,?) ON CONFLICT(profile_id,contact_id) DO UPDATE SET canonical_contact_id=excluded.canonical_contact_id',profile,data.contact_id,data.canonical_contact_id);
    return Response.json({contact_id:data.contact_id,canonical_contact_id:data.canonical_contact_id});
  }
  if(suffix==='/queue-routing' && ['GET','PUT'].includes(request.method)) {
    requireCapability(actor,'communication.configure');
    return Response.json(await queueRouting(env,profile,request.method==='PUT'?await request.json():undefined));
  }
  if(/^\/contact-timeline\/[a-f0-9-]{36}$/i.test(suffix) && request.method==='GET') {
    requireCapability(actor,'communication.read');
    const contact=suffix.split('/')[2];
    const rows=await all(env,"SELECT c.id,c.created,c.state,c.owner,c.department_id,c.profile_id FROM fagoo_contact_links f JOIN conversation_contacts cc ON cc.contact_id=f.contact_id AND cc.profile_id=f.profile_id JOIN conversations c ON c.id=cc.conversation_id WHERE f.profile_id=? AND f.canonical_contact_id=? ORDER BY c.created DESC LIMIT 100",profile,contact);
    return Response.json({data:rows.filter(c=>managedVisible(actor,c)).map(c=>({id:c.id,at:new Date(c.created).toISOString(),title:'Atendimento WhatsApp',kind:'communication'}))});
  }
  if(suffix==='/queue' && request.method==='GET') {
    requireCapability(actor,'communication.claim');
    const rows=await all(env,"SELECT id,profile_id,state,owner,department_id,created,updated FROM conversations WHERE profile_id=? AND state='waiting' AND owner IS NULL AND (?=1 OR department_id IS NULL OR department_id IN (SELECT value FROM json_each(?))) ORDER BY updated,id LIMIT 100",profile,configured(actor)||actor.fagoo.administrator?1:0,JSON.stringify(actor.fagoo.teamIds));
    return Response.json({data:rows.map(({profile_id,owner,...c})=>c)});
  }
  if(configured(actor)) return null;
  if(/^\/(team|internal-chats)(\/|$)/.test(suffix)) { requireCapability(actor,'team.chat'); return null; }
  if(/^\/(conversations|media|events|tickets|presence|devices)(\/|$)/.test(suffix)) return null;
  throw new ApiError(403,'missing_capability','Esta área exige configuração de comunicação.');
}
