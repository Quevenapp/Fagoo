import { randomUUID } from 'node:crypto';
import { fiscalMirrorFixture } from './fiscal-mirror-fixture.mjs';
export const DOCUMENT_MIRROR_MIGRATION='202610220006_document_origin_mirror.sql';
export async function documentMirrorFixture({migrate=true,guards=false,actor=true}={}){
 const f=await fiscalMirrorFixture();try{
  for(const n of['202610220004_fiscal_xml_scope.sql','202610220005_fiscal_mirror_invalid_state.sql'])await f.migrate(n);
  if(migrate)await f.migrate(DOCUMENT_MIRROR_MIGRATION);
  if(guards)await f.migrate('202610220007_document_mirror_guards.sql');
  const actorId=randomUUID();
  if(migrate&&actor){await f.db.query("insert into auth.users(id,banned_until)values($1,'infinity')",[actorId]);await f.db.query('insert into erp_document_mirror.settings(actor_id)values($1)',[actorId]);}
  const documentProject=(p_limit=100)=>f.rpc('erp_document_mirror_project',{p_limit});
  return{...f,actorId,documentProject};
 }catch(e){await f.close();throw e;}
}
