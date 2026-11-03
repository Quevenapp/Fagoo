/** Synthetic browser QA data only. Never import this module in deployment code. */
import {randomUUID} from 'node:crypto';
import {PROFILES,returnFile} from '../../packages/cnab-core/test/fixtures.mjs';
export async function seedCnabReview({db,uid,handler,env,today}){
 const scalar=async(sql,args)=>(await db.query(sql,args)).rows[0].value;
 const call=async(path,body)=>{const response=await handler(new Request(`http://127.0.0.1:9011/v1/cnab${path}`,{method:'POST',headers:{Authorization:'Bearer qa-synthetic-token-unsigned-safe','Content-Type':'application/json'},body:JSON.stringify(body)}),env);if(!response.ok)throw new Error(`QA_CNAB_SEED_${response.status}_${path.split('/')[1]}_${JSON.stringify(await response.json())}`);return response.json();};
 const native=(action,data)=>scalar('select public.erp_finance_execute($1,$2,$3,$4::jsonb)value',[uid,randomUUID(),action,JSON.stringify(data)]);
 const contact=(await scalar("select public.erp_catalog_save($1,'contacts',null,0,$2,$3::jsonb)value",[uid,randomUUID(),JSON.stringify({name:'PAGADOR FICTICIO QA',person_type:'F',document:'12345678909',street:'RUA FICTICIA',number:'1',district:'TESTE',city:'PIRACICABA',state:'SP',postal_code:'13400000',roles:['customer']})])).record;
 const date=today.slice(8,10)+today.slice(5,7)+today.slice(2,4);
 for(const key of ['itau','inter']){
  const account=(await native('account_save',{expected_version:0,name:`${key==='itau'?'Itaú':'Inter'} fictício · CNAB QA`,kind:'bank'})).record;
  const {accountId,...sourceFields}=PROFILES[key];
  const identity=await scalar("select public.erp_company_get($1,'identity')value",[uid]);
  const fields={...sourceFields,cnpj:identity.record.data.cnpj};
  const profile=(await call('/profiles',{expected_version:0,command_id:randomUUID(),data:{...fields,account_id:account.id,ourNumberStart:key==='itau'?'00000001':null,remittanceSequenceStart:'1'}})).profile;
  const title=(await native('title_create_group',{kind:'receivable',contact_id:contact.id,description:`Cobrança inteiramente fictícia · ${key} QA`,issued_on:today,total_cents:'12345',installments:[{amount_cents:'12345',due_on:today}]})).items[0];
  const remittance=await call('/remittances',{profile_id:profile.id,expected_version:profile.version,command_id:randomUUID(),generated_on:today,titles:[{title_id:title.id,expected_version:title.version,document_number:key==='itau'?'QAITA001':'QAINT001',...(key==='inter'?{payment_limit_days:30}:{})}]});
  const reservation=await scalar('select public.erp_cnab_reservation($1,$2)value',[uid,remittance.id]),bt=reservation.snapshot.titles[0];
  const input={bank:fields.bank,profile:reservation.snapshot.profile,generatedDate:date,events:[{control:bt.control,documentNumber:bt.documentNumber,ourNumber:key==='itau'?bt.ourNumber:'12345678901',occurrence:key==='itau'?'06':'02',amount:bt.amountCents,paid:key==='itau'?bt.amountCents:'0',dueDate:date,occurrenceDate:date,creditDate:date}]};
  await call('/returns',{profile_id:profile.id,command_id:randomUUID(),file_base64:Buffer.from(returnFile(input)).toString('base64'),obtained_from_bank:false});
  await native('title_create_group',{kind:'receivable',contact_id:contact.id,description:`Nova cobrança operacional fictícia · ${key} QA`,issued_on:today,total_cents:'2570',installments:[{amount_cents:'2570',due_on:today}]});
  if(key==='itau')await call('/returns',{profile_id:profile.id,command_id:randomUUID(),file_base64:Buffer.from(returnFile({...input,fileSequence:'00002'})).toString('base64'),obtained_from_bank:false});
 }
}
