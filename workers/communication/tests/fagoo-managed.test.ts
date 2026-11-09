import {env,createExecutionContext} from 'cloudflare:test';
import {describe,it,expect} from 'vitest';
import worker,{app} from '../src/index';
import {actorFromGrant,syncGrant,managedPushAllowed,attachAliases,type FagooGrant} from '../src/managed';
import {exec,one} from '../src/db';
import {perform} from '../src/service';
import {authorizedMedia} from '../src/media';
import {visibleEvent} from '../src/visibility';
import {internalCommand,internalChatDetail} from '../src/team';
import {queueContactProjection,processContactProjections} from '../src/contact-projection';
import {deliver} from '../src/engine';
const uuid=()=>crypto.randomUUID();
const caps=['communication.read','communication.claim','communication.reply','communication.transfer','team.chat'];
async function fixture(){
 const user=uuid(),other=uuid(),unit=uuid();
 const grant:FagooGrant={user_id:user,unit_id:unit,profile_id:unit,name:'Pessoa',unit_name:'Unidade',role:'operacao',capabilities:[...caps],team_ids:['support'],bots:[],people:[{id:user,name:'Pessoa',role:'operacao',team_ids:['support']},{id:other,name:'Outra',role:'operacao',team_ids:['support']}]};
 const current=new Map([[user,grant],[other,{...grant,user_id:other}]]);
 const runtime={...env,FAGOO_MANAGED:'true',FAGOO_GRANT:grant,FAGOO_ACTOR:actorFromGrant(grant),FAGOO_AUTHORITY:{authorize:async({userId}:any)=>{const g=current.get(userId);if(!g)throw Error('revoked');return g;}}};
 await syncGrant(runtime,grant);
 const conversation=async(owner:string|null,state='human',team:string|null='support')=>{const id=uuid();await exec(runtime,"INSERT INTO conversations(id,profile_id,external_namespace,external_id,phone,state,owner,session,last_customer,created,updated,department_id) VALUES(?,?,'channel:test',?,'5511999999999',?,?,?,?,?,?,?)",id,unit,id,state,owner,uuid(),Date.now(),Date.now(),Date.now(),team);return id;};
 const request=(suffix:string,method='GET',body?:unknown)=>app.fetch(new Request(`https://fagoo.test/api/v1/profiles/${unit}${suffix}`,{method,headers:{'Content-Type':'application/json','Idempotency-Key':uuid()},body:body===undefined?undefined:JSON.stringify(body)}),runtime,createExecutionContext());
 return {user,other,unit,grant,current,runtime,conversation,request,actor:runtime.FAGOO_ACTOR};
}
describe('Fagoo managed authorization',()=>{
 it('filters conversations and searches in the server and redacts the claimable queue',async()=>{
  const f=await fixture(),mine=await f.conversation(f.user),other=await f.conversation(f.other),queue=await f.conversation(null,'waiting'),foreign=await f.conversation(null,'waiting','finance');
  const list=await(await f.request('/conversations')).json<any>();expect(list.data.map((c:any)=>c.id)).toEqual([mine]);
  expect((await f.request(`/conversations/${other}`)).status).toBe(404);
  const search=await(await f.request(`/conversations?q=${other}`)).json<any>();expect(search.data).toEqual([]);
  const waiting=await(await f.request('/queue')).json<any>();expect(waiting.data.map((c:any)=>c.id)).toEqual([queue]);expect(JSON.stringify(waiting)).not.toContain('5511999999999');expect(JSON.stringify(waiting)).not.toContain(foreign);
 });
 it('claims once, fences old AI, transfers, and immediately removes previous access',async()=>{
  const f=await fixture(),id=await f.conversation(null,'waiting');
  await perform(f.runtime,f.actor,f.unit,'conversation.action',{id,action:'claim'},uuid());
  expect((await one(f.runtime,'SELECT owner,epoch,state FROM conversations WHERE id=?',id))).toMatchObject({owner:f.user,state:'human',epoch:1});
  await expect(perform(f.runtime,actorFromGrant({...f.grant,user_id:f.other}),f.unit,'conversation.action',{id,action:'claim'},uuid())).rejects.toThrow();
  await perform(f.runtime,f.actor,f.unit,'conversation.action',{id,action:'transfer',target:f.other},uuid());
  expect((await f.request(`/conversations/${id}`)).status).toBe(404);
  expect(await visibleEvent(f.runtime,f.actor,{profile_id:f.unit,kind:'conversation.updated',resource_id:id,payload:'{}'})).toBe(false);
 });
 it('revokes attached media with the conversation even for its original uploader',async()=>{
  const f=await fixture(),id=await f.conversation(f.user),media=uuid();
  await exec(f.runtime,"INSERT INTO media(id,profile_id,name,type,size,object_key,actor,created) VALUES(?,?,'private.txt','text/plain',1,?,?,?)",media,f.unit,media,f.user,Date.now());
  await exec(f.runtime,"INSERT INTO messages(id,profile_id,conversation_id,direction,author,text,attachments,created) VALUES(?,?,?,'human',?,'',?,?)",uuid(),f.unit,id,f.user,JSON.stringify([media]),Date.now());
  expect((await authorizedMedia(f.runtime,f.actor,f.unit,media)).id).toBe(media);
  await exec(f.runtime,'UPDATE conversations SET owner=? WHERE id=?',f.other,id);
  await expect(authorizedMedia(f.runtime,f.actor,f.unit,media)).rejects.toThrow();
 });
 it('keeps internal chats private even from a nonparticipant administrator',async()=>{
  const f=await fixture();const chat=await internalCommand(f.runtime,f.actor,f.unit,'internal.create',{peer_id:f.other},uuid());
  const third=actorFromGrant({...f.grant,user_id:uuid(),capabilities:[...caps,'communication.configure']});
  await expect(internalChatDetail(f.runtime,third,f.unit,chat.id)).rejects.toThrow();
  expect(await visibleEvent(f.runtime,third,{profile_id:f.unit,kind:'internal.message',payload:JSON.stringify({chat_id:chat.id})})).toBe(false);
 });
 it('checks current authority before private push and closes access on revocation',async()=>{
  const f=await fixture(),id=await f.conversation(f.user);
  expect(await managedPushAllowed(f.runtime,f.unit,f.user,'message',id)).toBe(true);
  f.current.delete(f.user);expect(await managedPushAllowed(f.runtime,f.unit,f.user,'message',id)).toBe(false);
 });
 it('rejects human credentials, setup, updater, and forged delegated headers on public fetch',async()=>{
  const f=await fixture();const publicEnv={...f.runtime,FAGOO_ACTOR:undefined,FAGOO_GRANT:undefined};
  for(const path of ['/api/auth/login','/api/auth/setup','/api/system/update-plan','/api/v1/users','/app']) {
   const response=await worker.fetch(new Request(`https://fagoo.test${path}`,{headers:{'X-Fagoo-Delegation':JSON.stringify(f.grant),Cookie:'wabotia=fake'}}),publicEnv,createExecutionContext());
   expect(response.status).toBeGreaterThanOrEqual(400);
  }
 });
 it('does not treat read access as permission to claim or reply',async()=>{
  const f=await fixture(),id=await f.conversation(f.user),read=actorFromGrant({...f.grant,capabilities:['communication.read']});
  await expect(perform(f.runtime,read,f.unit,'conversation.action',{id,action:'reply',text:'no'},uuid())).rejects.toThrow();
 });
 it('keeps mobile administrators in their own inbox and personal pushes',async()=>{
  const f=await fixture(),mine=await f.conversation(f.user),other=await f.conversation(f.other);
  const grant={...f.grant,role:'admin',team_ids:[],capabilities:[...caps,'communication.configure'],client:'mobile' as const};
  f.current.set(f.user,grant);f.runtime.FAGOO_ACTOR=actorFromGrant(grant);
  const list=await(await f.request('/conversations')).json<any>();expect(list.data.map((x:any)=>x.id)).toEqual([mine]);
  expect((await f.request(`/conversations/${other}`)).status).toBe(404);
  expect((await f.request('/settings','PUT',{})).status).toBe(403);
  expect(await visibleEvent(f.runtime,f.runtime.FAGOO_ACTOR,{profile_id:f.unit,kind:'conversation.updated',resource_id:other,payload:'{}'})).toBe(false);
  expect(await managedPushAllowed(f.runtime,f.unit,f.user,'message',other)).toBe(false);
  expect(await managedPushAllowed(f.runtime,f.unit,f.user,'message',mine)).toBe(true);
 });
 it('adopts legacy owners and private participants without rewriting their history',async()=>{
  const f=await fixture(),old='legacy-'+uuid(),oldPeer='legacy-'+uuid();
  await exec(f.runtime,'INSERT INTO fagoo_actor_aliases(profile_id,source_actor,canonical_user_id) VALUES(?,?,?),(?,?,?)',f.unit,old,f.user,f.unit,oldPeer,f.other);
  await attachAliases(f.runtime,f.actor);
  const id=await f.conversation(old),chat=uuid();
  const [a,b]=[old,oldPeer].sort();
  await exec(f.runtime,'INSERT INTO internal_chats(id,profile_id,member_a,member_b,created,updated) VALUES(?,?,?,?,?,?)',chat,f.unit,a,b,Date.now(),Date.now());
  const list=await(await f.request('/conversations')).json<any>();expect(list.data[0].owner).toBe(f.user);
  const detail=await(await f.request(`/conversations/${id}`)).json<any>();expect(detail.conversation.owner).toBe(f.user);
  expect((await one(f.runtime,'SELECT owner FROM conversations WHERE id=?',id)).owner).toBe(old);
  const reopened=await internalCommand(f.runtime,f.actor,f.unit,'internal.create',{peer_id:f.other},uuid());expect(reopened.id).toBe(chat);
  expect((await internalChatDetail(f.runtime,f.actor,f.unit,chat)).peer.id).toBe(f.other);
  expect(await visibleEvent(f.runtime,f.actor,{profile_id:f.unit,kind:'internal.message',payload:JSON.stringify({chat_id:chat})})).toBe(true);
 });
 it('queues canonical contacts durably while PostgreSQL is unavailable and creates only a projection',async()=>{
  const f=await fixture(),id=await f.conversation(f.user),canonical=uuid();
  const c={...(await one(f.runtime,'SELECT * FROM conversations WHERE id=?',id)),connection_id:'provider',external_namespace:'channel:provider',title:'Nome do canal'};
  let available=false;
  const runtime={...f.runtime,FAGOO_AUTHORITY:{...f.runtime.FAGOO_AUTHORITY,projectContact:async(input:any)=>{if(!available)throw Error('maintenance');return {contact_id:canonical,source_namespace:input.namespace,source_id:input.sourceId,name:'Nome canônico',phone:'5511888888888'};}}};
  await queueContactProjection(runtime,c);await processContactProjections(runtime,f.unit);
  expect((await one(runtime,'SELECT status,attempts FROM fagoo_contact_jobs WHERE conversation_id=?',id))).toMatchObject({status:'pending',attempts:1});
  available=true;await exec(runtime,'UPDATE fagoo_contact_jobs SET next_at=0 WHERE conversation_id=?',id);await processContactProjections(runtime,f.unit);
  const contact=await one(runtime,'SELECT c.*,f.canonical_contact_id FROM contacts c JOIN fagoo_contact_links f ON f.contact_id=c.id WHERE c.profile_id=?',f.unit);
  expect(contact).toMatchObject({source:'fagoo',name:'Nome canônico',phone:'5511888888888',canonical_contact_id:canonical});
  await queueContactProjection(runtime,c);await processContactProjections(runtime,f.unit);
  expect((await one(runtime,'SELECT count(*) n FROM contacts WHERE profile_id=?',f.unit)).n).toBe(1);
 });
 it('does not project arbitrary API-supplied phone numbers as provider identities',async()=>{
  const f=await fixture(),id=await f.conversation(f.user);const c=await one(f.runtime,'SELECT * FROM conversations WHERE id=?',id);
  await queueContactProjection(f.runtime,{...c,connection_id:'provider',external_namespace:'app:untrusted'});
  expect(await one(f.runtime,'SELECT * FROM fagoo_contact_jobs WHERE conversation_id=?',id)).toBeNull();
 });
 it('revokes queued human delivery when canonical reply permission is removed',async()=>{
  const f=await fixture(),id=await f.conversation(f.user),outbox=uuid();
  await exec(f.runtime,"INSERT INTO outbox(id,profile_id,conversation_id,epoch,kind,actor,payload,dedupe,created,updated) VALUES(?,?,?,0,'reply',?,'{\"text\":\"private\"}',?,?,?)",outbox,f.unit,id,f.user,uuid(),Date.now(),Date.now());
  f.current.set(f.user,{...f.grant,capabilities:['communication.read']});
  await deliver(f.runtime,await one(f.runtime,'SELECT * FROM outbox WHERE id=?',outbox));
  expect((await one(f.runtime,'SELECT status FROM outbox WHERE id=?',outbox)).status).toBe('cancelled');
 });
});
