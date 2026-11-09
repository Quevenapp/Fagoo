import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {preferencesFixture} from './preferences-fixture.mjs';
export async function fagooFixture(){
 const f=await preferencesFixture();
 try{
  await f.db.exec(await readFile(new URL('../../../../supabase/migrations/202611090002_fagoo_identity.sql',import.meta.url),'utf8'));
  const operator=randomUUID();await f.db.query('insert into auth.users(id,email)values($1,$2)',[operator,'operator@synthetic.test']);
  await f.db.query("insert into erp_access.membership(user_id,role)values($1,'operacao')",[operator]);f.users.operacao=operator;
  const configure=(action,payload,{user=f.users.admin,command=randomUUID()}={})=>f.rpc('fagoo_command',{p_user_id:user,p_command_id:command,p_action:action,p_payload:payload});
  return {...f,configure};
 }catch(error){await f.close();throw error;}
}
