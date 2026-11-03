/** Synthetic local SQL/HTTP fixtures only. No bank, credential, real return or browser write. */
import {randomUUID} from 'node:crypto';
import {PROFILES,returnFile} from '../../packages/cnab-core/test/fixtures.mjs';

export async function seedItauNetCredit({db,uid,handler,env,today}){
 const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].value;
 const native=(action,data)=>scalar('select public.erp_finance_execute($1,$2,$3,$4::jsonb)value',[uid,randomUUID(),action,JSON.stringify(data)]);
 const call=async(path,body)=>{const response=await handler(new Request(`http://127.0.0.1:9011${path}`,{method:body?'POST':'GET',headers:{Authorization:'Bearer qa-synthetic-token-unsigned-safe',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})}),env);if(!response.ok)throw new Error(`QA_NET_CREDIT_HTTP_${response.status}`);return response.json();};
 const identity=(await scalar("select public.erp_company_get($1,'identity')value",[uid])).record;
 if(!identity)throw new Error('QA_NET_CREDIT_IDENTITY_MISSING');
 const before=await scalar("select jsonb_build_object('settlements',(select count(*) from erp_finance.settlement),'movements',(select count(*) from erp_finance.movement))value");
 const contact=(await scalar("select public.erp_catalog_save($1,'contacts',null,0,$2,$3::jsonb)value",[uid,randomUUID(),JSON.stringify({name:'PAGADOR FICTICIO TARIFA QA058',person_type:'F',document:'12345678909',street:'RUA FICTICIA',number:'1',district:'TESTE',city:'PIRACICABA',state:'SP',postal_code:'13400000',roles:['customer']})])).record;
 const date=today.slice(8,10)+today.slice(5,7)+today.slice(2,4),rows=[];
 for(const [index,state] of ['pending','applied','reversed'].entries()){
  const label=state==='pending'?'Prévia de tarifa':state==='applied'?'Baixa com tarifa':'Tarifa estornada';
  const account=(await native('account_save',{expected_version:0,name:`QA058 · ${label} · Conta fictícia`,kind:'bank'})).record;
  const {accountId,...base}=PROFILES.itau;
  const profile=(await call('/v1/cnab/profiles',{expected_version:0,command_id:randomUUID(),data:{...base,cnpj:identity.data.cnpj,account:String(45670+index),account_id:account.id,ourNumberStart:'00000301',remittanceSequenceStart:'1'}})).profile;
  await call(`/v1/cobranca-operacional/profiles/${profile.id}/approval`,{command_id:randomUUID(),expected_approval_version:0,expected_profile_version:profile.version,expected_identity_version:identity.version,enabled:true,confirmed_on:today,reference:'DECLARACAO FICTICIA QA058 SEM ACAO BANCARIA'});
  const title=(await native('title_create_group',{kind:'receivable',contact_id:contact.id,description:`QA058 · ${label} · Título fictício`,issued_on:today,total_cents:'12345',installments:[{amount_cents:'12345',due_on:today}]})).items[0];
  const body={command_id:randomUUID(),profile_id:profile.id,expected_version:profile.version,expected_approval_version:1,generated_on:today,titles:[{title_id:title.id,expected_version:title.version,document_number:`QA05800${index}`}],confirm_operational:false};
  const checked=await call('/v1/cobranca-operacional/remittances/preview',body),remittance=await call('/v1/cobranca-operacional/remittances',{...body,confirm_operational:true,preview_hash:checked.preview_hash});
  const reservation=await scalar('select public.erp_cnab_operational_reservation($1,$2,$3)value',[uid,remittance.id,1]),bt=reservation.snapshot.titles[0];
  const bytes=returnFile({bank:'341',profile:reservation.snapshot.profile,generatedDate:date,fileSequence:'00001',events:[{control:bt.control,documentNumber:bt.documentNumber,ourNumber:bt.ourNumber,occurrence:'06',amount:'12345',paid:'12000',fee:'345',dueDate:date,occurrenceDate:date,creditDate:date}]});
  const file=await call('/v1/retornos-operacionais/files',{profile_id:profile.id,expected_approval_version:1,command_id:randomUUID(),file_base64:Buffer.from(bytes).toString('base64'),obtained_from_bank:true,reference_id:`QA058_FICTICIO_${state.toUpperCase()}`});
  const event=(await call(`/v1/retornos-operacionais/files/${file.id}/events`)).items[0];
  const category=(await native('category_save',{expected_version:0,name:state==='reversed'?'QA058 · Categoria histórica fictícia':'QA058 · Tarifa bancária fictícia',kind:'payable'})).record;
  const selection={file_id:file.id,line:event.line,fee_category_id:category.id,expected_fee_category_version:category.version},preview=await call(`/v1/retornos-itau109/events/${event.event_id}/preview`,selection);
  if(!preview.context.settlement.allowed||preview.context.plan.posting.net_cash_cents!=='12000')throw new Error('QA_NET_CREDIT_PREVIEW_BLOCKED');
  let command=null;
  if(state!=='pending'){
   command=randomUUID();
   const ack=await scalar('select public.erp_cnab_itau_net_credit_settle(p_user_id=>$1,p_command_id=>$2,p_event_id=>$3,p_file_id=>$4,p_line=>$5,p_expected_approval=>$6,p_context_hash=>$7,p_fee_category_id=>$8,p_expected_fee_category_version=>$9,p_confirm=>true)value',[uid,command,event.event_id,file.id,event.line,1,preview.context_hash,category.id,category.version]);
   if(state==='reversed'){
    await native('category_save',{id:category.id,expected_version:1,name:'QA058 · Categoria histórica inativa',kind:'payable',active:false});
    await native('reverse',{id:title.id,expected_version:2,settlement_id:ack.receipt.settlement_id,posted_on:today,note:'ESTORNO EXCLUSIVAMENTE SINTETICO NO BOOT QA058'});
    await native('account_save',{id:account.id,expected_version:3,name:`QA058 · ${label} · Conta fictícia inativa`,kind:'bank',active:false});
   }
   const current=await call(`/v1/retornos-itau109/commands/${command}`);
   if(current.receipt.posting.fee_cents!=='345'||current.current_account.balance_cents!==(state==='reversed'?'0':'12000')||current.current_settlement.reversed!==(state==='reversed'))throw new Error('QA_NET_CREDIT_RECEIPT_MISMATCH');
  }
  rows.push({state,file_id:file.id,event_id:event.event_id,command_id:command,category_id:category.id});
 }
 const after=await scalar("select jsonb_build_object('settlements',(select count(*) from erp_finance.settlement),'movements',(select count(*) from erp_finance.movement))value");
 if(Number(after.settlements)-Number(before.settlements)!==3||Number(after.movements)-Number(before.movements)!==6)throw new Error('QA_NET_CREDIT_CARDINALITY');
 return rows;
}
