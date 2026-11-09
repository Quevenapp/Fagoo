import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {fagooFixture} from './fagoo-fixture.mjs';
export async function queuesFixture(){
 const f=await fagooFixture();
 try{
  await f.db.exec(await readFile(new URL('../../../../supabase/migrations/202611090003_fagoo_queues.sql',import.meta.url),'utf8'));
  await f.db.exec(await readFile(new URL('../../../../supabase/migrations/202611090009_fagoo_print_destination.sql',import.meta.url),'utf8'));
  const unit=await f.configure('unit.save',{name:'Loja sintética',timezone:'America/Sao_Paulo'});
  const other=await f.configure('unit.save',{name:'Outra unidade'});
  await f.configure('member.save',{user_id:f.users.operacao,unit_id:unit.id,capabilities:['queue.read','queue.operate','ticket.issue'],team_ids:[]});
  const device=await f.configure('device.save',{unit_id:unit.id,name:'Painel sintético',capabilities:['panel.read','ticket.issue','print.execute','audio.execute']});
  await f.configure('device.issue',{id:device.id,token_hash:'a'.repeat(64)});
  const args=({user=f.users.admin,deviceId=null,unitId=unit.id}={})=>({p_user_id:deviceId?null:user,p_device_id:deviceId,p_unit_id:unitId});
  const snapshot=options=>f.rpc('fagoo_queue_snapshot',args(options));
  const command=(type,payload={},options={})=>f.rpc('fagoo_queue_command',{...args(options),p_command_id:options.commandId??randomUUID(),p_type:type,p_payload:payload,p_expected_version:options.version??null});
  const issue=async(payload={},options={})=>{const r=await command('ticket.issue',{queue_id:queue.id,...payload},options);if(!r.ok)throw new Error(JSON.stringify(r));return r.result.ticket;};
  const queue=(await snapshot()).queues[0];
  return {...f,unit,other,device,queue,args,snapshot,command,issue};
 }catch(e){await f.close();throw e;}
}
