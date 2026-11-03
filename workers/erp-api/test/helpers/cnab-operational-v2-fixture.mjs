import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createNetCreditFixture} from './itau-net-credit-fixture.mjs';
import {mod10} from '../../../../packages/cnab-core/src/primitives.mjs';
import {PROFILES} from '../../../../packages/cnab-core/test/fixtures.mjs';
import {generateOperationalRemittanceV2} from '../../../../packages/cnab-core/src/index.mjs';
export const OBSERVED='itau109-origin-observed-v1',LEGACY='itau109-no-charges-v1';
export async function createOperationalV2Fixture(){
 const f=await createNetCreditFixture();let ordinal=0;
 await f.db.exec(await readFile(new URL('../../../../supabase/migrations/202610160066_itau_boleto_preview.sql',import.meta.url),'utf8'));
 await f.db.exec(await readFile(new URL('../../../../supabase/migrations/202610160067_itau_operational_encoding.sql',import.meta.url),'utf8'));
 async function rpc(name,args){const pairs=Object.entries(args);await f.db.exec('set role service_role');try{return await f.scalar(`select public.${name}(${pairs.map(([k],i)=>`${k}=>$${i+1}`).join(',')})v`,pairs.map(([k,v])=>['p_allowed_encoding_profiles','p_zero_daily_title_ids'].includes(k)?v:v&&typeof v==='object'?JSON.stringify(v):v));}finally{await f.db.exec('reset role');}}
 async function profiles(){return(await rpc('erp_cnab_operational_profiles_v2',{p_user_id:f.users.admin})).items;}
 async function profile(simple=false){const account=(await f.native('account_save',{expected_version:0,name:'SYNTHETIC V2 '+(++ordinal),kind:'bank'})).record,{accountId,...base}=PROFILES.itau;
  const p=await rpc('erp_cnab_profile_save',{p_user_id:f.users.admin,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{...base,simpleCollectionPolicyVerified:simple,account:String(30000+ordinal),accountDigit:mod10(base.agency+String(30000+ordinal)),account_id:account.id,ourNumberStart:'00000001',remittanceSequenceStart:'1'}});return p.profile;}
 async function approve(p,allowed=[OBSERVED],overrides={}){const s=(await profiles()).find(x=>x.profile.id===p.id);const args={p_user_id:f.users.admin,p_profile_id:p.id,p_command_id:randomUUID(),p_expected_approval:s.approval.approval_version,p_expected_profile:s.profile.version,p_expected_identity:1,p_enabled:allowed.length>0,p_confirmed_on:f.today,p_reference:'SYNTHETIC HISTORICAL DECLARATION',p_allowed_encoding_profiles:allowed,p_compatibility_confirmed:allowed.includes(OBSERVED),p_permanent_instructions_acknowledged:allowed.includes(OBSERVED),...overrides};return{args,result:await rpc('erp_cnab_operational_approve_v2',args)};}
 async function title(amount='12345'){return(await f.native('title_create_group',{kind:'receivable',contact_id:f.contact.id,description:'SYNTHETIC V2 TITLE',issued_on:f.today,total_cents:amount,installments:[{amount_cents:amount,due_on:f.today}]})).items[0];}
 async function selection(p,titles,encoding=OBSERVED,zero=[]){const s=(await profiles()).find(x=>x.profile.id===p.id);return{p_user_id:f.users.financeiro,p_command_id:randomUUID(),p_profile_id:p.id,p_expected_version:s.profile.version,p_expected_approval:s.approval.approval_version,p_generated_on:f.today,p_titles:titles.map(t=>({title_id:t.id,expected_version:t.version,document_number:'V'+String(++ordinal).padStart(8,'0')})),p_confirm_operational:false,p_preview:true,p_preview_hash:null,p_encoding_profile:encoding,p_confirm_encoding_profile:false,p_zero_daily_title_ids:zero};}
 const preview=args=>rpc('erp_cnab_operational_reserve_v2',args);
 const reserve=async(args,pr)=>rpc('erp_cnab_operational_reserve_v2',{...args,p_preview:false,p_preview_hash:(pr??await preview(args)).preview_hash,p_confirm_operational:true,p_confirm_encoding_profile:true});
 const read=(id,approval=1)=>rpc('erp_cnab_operational_reservation_v2',{p_user_id:f.users.financeiro,p_id:id,p_expected_approval:approval});
 async function finalize(r,approval=1,overrides={}){const value=await read(r.id,approval),generated=await generateOperationalRemittanceV2(value.snapshot),path=`profiles/${r.profile_id}/remittances/${generated.fileHash}.rem`;
  await f.ports().storeFile({bucket:'brufap-cnab',path,bytes:generated.bytes,upsert:false});const args={p_user_id:f.users.financeiro,p_command_id:randomUUID(),p_id:r.id,p_hash:generated.fileHash,p_size:generated.bytes.length,p_path:path,p_manifest:generated.manifest,p_expected_approval:approval,...overrides};
  return{args,generated,result:await rpc('erp_cnab_operational_finalize_v2',args)};}
 const command=(id,actor=f.users.financeiro)=>rpc('erp_cnab_operational_command_v2',{p_user_id:actor,p_command_id:id});
 return{...f,rpc,profiles,profile,approve,title,selection,preview,reserve,read,finalize,command};
}
