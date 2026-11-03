/** Synthetic PGlite-only administration fixtures. No number is reserved. */
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {parseFiscalNumberingRoute,executeFiscalNumberingRoute} from '../../workers/erp-api/src/fiscal-numbering.mjs';
import {numberingPage} from '../../apps/erp/src/lib/fiscal-numbering-model.ts';

export async function seedFiscalNumbering({db,uid}){
 if(!(db instanceof PGlite))throw new Error('QA_NUMBERING_PGLITE_REQUIRED');
 const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].value;
 if(await scalar('select count(*)::integer value from erp_fiscal_numbering.series'))throw new Error('QA_NUMBERING_ALREADY_SEEDED');
 const rpc=async(name,args)=>{const pairs=Object.entries(args);return scalar(`select public.${name}(${pairs.map(([key],i)=>`${key}=>$${i+1}`).join(',')})value`,pairs.map(([,value])=>value));};
 const identity=(await rpc('erp_company_get',{p_user_id:uid,p_section:'identity'})).record;
 if(!identity||!['11222333000181','12345678000195'].includes(identity.data.cnpj)||identity.data.state!=='SP')throw new Error('QA_NUMBERING_SYNTHETIC_IDENTITY_REQUIRED');
 const effects=()=>scalar('select jsonb_build_array((select count(*)from erp_fiscal_numbering.reservation),(select count(*)from erp_finance.title),(select count(*)from erp_stock.movement))value');
 const before=await effects();
 for(let index=0;index<28;index++){
  const enabled=index%4!==0;
  await rpc('erp_fiscal_numbering_configure',{p_user_id:uid,p_command_id:randomUUID(),p_id:null,p_expected_version:0,p_expected_identity_version:identity.version,p_model:index<26?'55':'65',p_environment:'2',p_series:String(index<26?index+10:index-16),p_initial_number:index===0?'999999999':String(index+1),p_enabled:enabled,p_exclusive_use_confirmed:enabled,p_reference:'Conferência exclusivamente sintética para QA local; nenhuma numeração reservada'});
 }
 const request=async(path)=>executeFiscalNumberingRoute(await parseFiscalNumberingRoute(new Request('https://synthetic.invalid/v1/numeracao-fiscal/series'+path)),{userId:uid,rpc});
 const first=numberingPage((await request('?limit=25')).body),second=numberingPage((await request('?limit=25&after='+first.next_cursor)).body,'',first.next_cursor);
 if(first.items.length!==25||second.items.length!==3||!first.has_more||second.has_more||JSON.stringify(before)!==JSON.stringify(await effects()))throw new Error('QA_NUMBERING_INVARIANT_FAILED');
 return{series:28,reserved_numbers:0,models:['55','65']};
}
