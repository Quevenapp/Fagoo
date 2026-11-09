import {all,one,exec,batch} from './db';
import {type Env,now} from './types';
/** Inbound identity comes only from an authenticated connector/provider namespace. */
export async function queueContactProjection(env:Env,c:any,messageId?:string,text=''){
 if(env.FAGOO_MANAGED!=='true' || c.chat_type==='group' || !c.connection_id || c.external_namespace!==`channel:${c.connection_id}`)return;
 await exec(env,"INSERT INTO fagoo_contact_jobs(conversation_id,profile_id,namespace,source_id,name,phone,status,next_at,attempts) VALUES(?,?,?,?,?,?,'pending',?,0) ON CONFLICT(conversation_id) DO UPDATE SET status=CASE WHEN fagoo_contact_jobs.status='needs_review' THEN 'needs_review' ELSE 'pending' END,next_at=excluded.next_at,name=excluded.name,phone=excluded.phone",c.id,c.profile_id,c.external_namespace,c.recipient_id || c.external_id,String(c.title || c.phone || 'Contato do canal').slice(0,200),c.phone || '',now());
 const consent=/^(?:FAGOO|VINKI)\s+([A-Za-z0-9_-]{20,160})$/i.exec(text.trim());
 if(consent && messageId && /^\d{8,15}$/.test(c.phone || ''))await exec(env,"INSERT OR IGNORE INTO fagoo_subscription_jobs(id,profile_id,phone,token,status,next_at,attempts) VALUES(?,?,?,?,'pending',?,0)",messageId,c.profile_id,c.phone,consent[1],now());
}
export async function processContactProjections(env:Env,profile:string){
 if(env.FAGOO_MANAGED!=='true' || !env.FAGOO_AUTHORITY)return;
 const mapping=await one(env,'SELECT unit_id FROM fagoo_profiles WHERE profile_id=?',profile);if(!mapping)return;
 for(const row of await all(env,"SELECT * FROM fagoo_contact_jobs WHERE profile_id=? AND status='pending' AND next_at<=? LIMIT 10",profile,now())){
  try{
   const linked=await one(env,'SELECT c.id,c.source,f.canonical_contact_id FROM conversation_contacts cc JOIN contacts c ON c.id=cc.contact_id LEFT JOIN fagoo_contact_links f ON f.contact_id=c.id AND f.profile_id=cc.profile_id WHERE cc.conversation_id=? AND cc.profile_id=?',row.conversation_id,profile);
   if(linked && linked.source!=='fagoo'){
    await exec(env,'UPDATE fagoo_contact_jobs SET status=?,canonical_contact_id=?,error=? WHERE conversation_id=?',linked.canonical_contact_id?'done':'needs_review',linked.canonical_contact_id || null,linked.canonical_contact_id?null:'Revise o vínculo do contato legado.',row.conversation_id);continue;
   }
   const result=await env.FAGOO_AUTHORITY.projectContact?.({unitId:mapping.unit_id,namespace:row.namespace,sourceId:row.source_id,name:row.name,phone:row.phone});
   if(!result || !/^[a-f0-9-]{36}$/i.test(result.contact_id) || result.source_namespace!==row.namespace || result.source_id!==row.source_id)throw Error('invalid_projection');
   const id=`fagoo:${profile}:${result.contact_id}`,name=String(result.name || row.name).slice(0,200),phone=String(result.phone || '').slice(0,40);
   await batch(env,[
    ["INSERT INTO contacts(id,profile_id,namespace,name,phone,search_text,source,created_by,updated_by,created,updated) VALUES(?,?,'team',?,?,?,'fagoo','fagoo','fagoo',?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,phone=excluded.phone,search_text=excluded.search_text,updated=excluded.updated,version=contacts.version+1",[id,profile,name,phone,`${name} ${phone}`.toLowerCase(),now(),now()]],
    ['INSERT INTO fagoo_contact_links(profile_id,contact_id,canonical_contact_id) VALUES(?,?,?) ON CONFLICT(profile_id,contact_id) DO UPDATE SET canonical_contact_id=excluded.canonical_contact_id',[profile,id,result.contact_id]],
    ["INSERT INTO conversation_contacts(conversation_id,profile_id,contact_id,linked_by,created) VALUES(?,?,?,'fagoo',?) ON CONFLICT(conversation_id) DO NOTHING",[row.conversation_id,profile,id,now()]],
    ["UPDATE fagoo_contact_jobs SET status='done',canonical_contact_id=?,error=NULL WHERE conversation_id=?",[result.contact_id,row.conversation_id]],
   ]);
  }catch{await exec(env,"UPDATE fagoo_contact_jobs SET attempts=attempts+1,next_at=?,error='Cadastro canônico temporariamente indisponível.' WHERE conversation_id=?",now()+Math.min(300000,1000*2**Math.min(row.attempts+1,9)),row.conversation_id);}
 }
 for(const row of await all(env,"SELECT * FROM fagoo_subscription_jobs WHERE profile_id=? AND status='pending' AND next_at<=? LIMIT 10",profile,now())){
  try{if(!env.FAGOO_AUTHORITY.subscribeWhatsApp)throw Error('authority_unavailable');await env.FAGOO_AUTHORITY.subscribeWhatsApp({unitId:mapping.unit_id,token:row.token,phone:row.phone});await exec(env,"UPDATE fagoo_subscription_jobs SET status='done',error=NULL WHERE id=?",row.id);}
  catch{await exec(env,"UPDATE fagoo_subscription_jobs SET attempts=attempts+1,next_at=?,error='Confirmação temporariamente indisponível.' WHERE id=?",now()+Math.min(300000,1000*2**Math.min(row.attempts+1,9)),row.id);}
 }
}
