import { stockMirrorFixture } from './stock-mirror-fixture.mjs';
export const FISCAL_MIRROR_MIGRATIONS=['202610220002_fiscal_origin_mirror.sql','202610220003_fiscal_mirror_reads.sql'];
export async function fiscalMirrorFixture({migrate=true}={}) {
 const f=await stockMirrorFixture();try{
  if(migrate)for(const migration of FISCAL_MIRROR_MIGRATIONS)await f.migrate(migration);
  const fiscalList=(args={})=>f.rpc('erp_fiscal_invoice_list',{p_user_id:f.users.admin,...args});
  const fiscalProject=(p_limit=100)=>f.rpc('erp_fiscal_mirror_project',{p_limit});
  return {...f,fiscalList,fiscalProject};
 }catch(error){await f.close();throw error;}
}
