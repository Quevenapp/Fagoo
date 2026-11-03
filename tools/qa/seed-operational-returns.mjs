/** Loopback/PGlite QA only: wholly synthetic operational files; never imported by deployment code. */
import {randomUUID} from 'node:crypto';
import {PROFILES,returnFile} from '../../packages/cnab-core/test/fixtures.mjs';

export async function seedOperationalReturns({db,uid,handler,env,today}){
 const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].value;
 const call=async(path,body)=>{
  const response=await handler(new Request(`http://127.0.0.1:9011${path}`,{method:body?'POST':'GET',headers:{Authorization:'Bearer qa-synthetic-token-unsigned-safe',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})}),env);
  if(!response.ok)throw new Error(`QA_OPERATIONAL_RETURNS_HTTP_${response.status}`);
  return response.json();
 };
 const native=(action,data)=>scalar('select public.erp_finance_execute($1,$2,$3,$4::jsonb)value',[uid,randomUUID(),action,JSON.stringify(data)]);
 const identity=(await scalar("select public.erp_company_get($1,'identity')value",[uid])).record;
 if(!identity)throw new Error('QA_OPERATIONAL_RETURNS_IDENTITY_MISSING');
 const counts=()=>scalar("select jsonb_build_object('settlements',(select count(*)from erp_finance.settlement),'movements',(select count(*)from erp_finance.movement),'bindings',(select count(*)from erp_cnab.operational_binding))value");
 const before=await counts();
 const contact=(await scalar("select public.erp_catalog_save($1,'contacts',null,0,$2,$3::jsonb)value",[uid,randomUUID(),JSON.stringify({name:'PAGADOR FICTICIO RETORNO QA',person_type:'F',document:'12345678909',street:'RUA FICTICIA',number:'1',district:'TESTE',city:'PIRACICABA',state:'SP',postal_code:'13400000',roles:['customer']})])).record;
 const date=today.slice(8,10)+today.slice(5,7)+today.slice(2,4),records=[];
 for(const key of ['itau','inter']){
  const account=(await native('account_save',{expected_version:0,name:`${key==='itau'?'Itaú':'Inter'} fictício · Retornos operacionais QA`,kind:'bank'})).record;
  const {accountId,...fields}=PROFILES[key];
  const profile=(await call('/v1/cnab/profiles',{expected_version:0,command_id:randomUUID(),data:{...fields,cnpj:identity.data.cnpj,account:key==='itau'?'34567':'000345678',account_id:account.id,ourNumberStart:key==='itau'?'00000101':null,remittanceSequenceStart:'1'}})).profile;
  await call(`/v1/cobranca-operacional/profiles/${profile.id}/approval`,{command_id:randomUUID(),expected_approval_version:0,expected_profile_version:profile.version,expected_identity_version:identity.version,enabled:true,confirmed_on:today,reference:'DECLARACAO INTEIRAMENTE FICTICIA PARA QA'});
  const title=(await native('title_create_group',{kind:'receivable',contact_id:contact.id,description:`Retorno operacional ${key} · título fictício QA`,issued_on:today,total_cents:key==='itau'?'12345':'2570',installments:[{amount_cents:key==='itau'?'12345':'2570',due_on:today}]})).items[0];
  const body={command_id:randomUUID(),profile_id:profile.id,expected_version:profile.version,expected_approval_version:1,generated_on:today,titles:[{title_id:title.id,expected_version:title.version,document_number:key==='itau'?'RETIT001':'RETIN001',...(key==='inter'?{payment_limit_days:30}:{})}],confirm_operational:false};
  const preview=await call('/v1/cobranca-operacional/remittances/preview',body);
  const remittance=await call('/v1/cobranca-operacional/remittances',{...body,confirm_operational:true,preview_hash:preview.preview_hash});
  const reservation=await scalar('select public.erp_cnab_operational_reservation($1,$2,$3)value',[uid,remittance.id,1]),bt=reservation.snapshot.titles[0];
  const inputs=key==='itau'?[['06',bt.amountCents,'00001'],['06',bt.amountCents,'00002']]:[['02','0','00001'],['06',bt.amountCents,'00002']];
  for(const [occurrence,paid,fileSequence]of inputs){
   const bytes=returnFile({bank:fields.bank,profile:reservation.snapshot.profile,generatedDate:date,fileSequence,events:[{control:bt.control,documentNumber:bt.documentNumber,ourNumber:key==='itau'?bt.ourNumber:'00000000112',occurrence,amount:bt.amountCents,paid,dueDate:date,occurrenceDate:date,creditDate:date}]});
   const file=await call('/v1/retornos-operacionais/files',{profile_id:profile.id,expected_approval_version:1,command_id:randomUUID(),file_base64:Buffer.from(bytes).toString('base64'),obtained_from_bank:true,reference_id:`QA_FICTICIO_${key.toUpperCase()}_${occurrence}_${fileSequence}`});
   const event=(await call(`/v1/retornos-operacionais/files/${file.id}/events`)).items[0];
   const checked=await call(`/v1/retornos-operacionais/events/${event.event_id}/preview`,{file_id:file.id,line:event.line});
   if(key==='itau'&&!checked.context.settlement.allowed)throw new Error('QA_OPERATIONAL_ITAU_PREVIEW_BLOCKED');
   if(key==='inter'&&occurrence==='02'&&!checked.context.binding.allowed)throw new Error('QA_OPERATIONAL_INTER_BINDING_BLOCKED');
   if(key==='inter'&&occurrence==='06'&&checked.context.settlement.allowed)throw new Error('QA_OPERATIONAL_INTER_NUMBER_INFERRED');
   records.push({file_id:file.id,event_id:event.event_id,title_id:title.id,bank:fields.bank,occurrence});
  }
 }
 if(JSON.stringify(before)!==JSON.stringify(await counts()))throw new Error('QA_OPERATIONAL_RETURN_UNEXPECTED_FINANCIAL_EFFECT');
 if(records.length!==4||new Set(records.map(r=>r.event_id)).size!==3)throw new Error('QA_OPERATIONAL_RETURN_DEDUPE_MISSING');
 return records;
}
