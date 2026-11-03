// Isolated PostgreSQL contracts and synthetic credentials only. No external drivers.
import {readFile} from 'node:fs/promises';
import {revalidationFixture,hash} from '../../../../packages/fiscal-authorization/test/stored-response-revalidation-fixture.mjs';
export {hash};
export async function fiscalDraftStatusFixture(){
 const f=await revalidationFixture();try{
  await f.db.exec(await readFile(new URL('../../../../supabase/migrations/202610160082_fiscal_draft_status.sql',import.meta.url),'utf8'));
  const list=(patch={})=>f.callSql('erp_fiscal_draft_status_list',{p_user_id:f.users.fiscal,...patch});
  const draftId=async candidateId=>(await f.db.query('select j.draft_id from erp_fiscal_signed.candidate c join erp_fiscal_unsigned.job j on j.id=c.unsigned_job_id where c.id=$1',[candidateId])).rows[0].draft_id;
  const snapshot=async()=>{const out={};for(const{schema_name,table_name}of(await f.db.query("select n.nspname schema_name,c.relname table_name from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r'and(n.nspname~'^(erp|origin)_'or n.nspname in('auth','storage'))order by 1,2")).rows){const name=schema_name+'.'+table_name;out[name]=(await f.db.query(`select count(*)::int count,encode(sha256(convert_to(coalesce(string_agg(x,''order by x),''),'UTF8')),'hex')hash from(select to_jsonb(t)::text x from ${name} t) q`)).rows[0];}return out;};
  const terminal=async(model='65',state='rejected',version=4)=>{
   const c=await f.candidate(model),proof=await f.review(c),b=await f.begin(c,version),p=await f.prepare(b,proof);await f.use(b,proof);const args=await f.finishArgs(b,p);
   if(state==='rejected')Object.assign(args,{p_processed_hash:null,p_processed_size:null,p_evidence:{...args.p_evidence,outcome:'rejected',cstat:'104',protocol_cstat:'245',protocol_number:null,reference_digest:null,signature_verified:false,processed_xsd_validated:false}});
   if(state==='receipt_pending')Object.assign(args,{p_processed_hash:null,p_processed_size:null,p_evidence:{...args.p_evidence,outcome:'receipt_pending',cstat:'103',protocol_cstat:null,protocol_number:null,receipt_number:'350000000000001',reference_digest:null,signature_verified:false,processed_xsd_validated:false}});
   const saved=await f.wire('finish',args);return{c,proof,b,p,args,saved,id:await draftId(c.input.candidateId)};
  };
  return{...f,list,draftId,snapshotAll:snapshot,terminal};
 }catch(e){await f.close();throw e;}
}
