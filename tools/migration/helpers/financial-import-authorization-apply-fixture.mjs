// Synthetic installation proof. No real source IDs, credentials or network ports.
import {STOCK_OBSERVATIONS_SEED} from './stock-observations-apply-fixture.mjs';
import {createFinancialImportFixture} from './financial-import-postgres-fixture.mjs';

export const FINANCIAL_IMPORT_APPLY='public.erp_origin_financial_import_apply(uuid,text,jsonb,boolean,uuid,text,boolean)';
export async function seedFinancialImportAuthorizationApply(ports){
 await ports.ok(await ports.run(STOCK_OBSERVATIONS_SEED));
 const fixture=await createFinancialImportFixture(ports),source=await fixture.source({category:true});
 const args=await fixture.prepare([source]);
 const receipt=await ports.rpc('erp_origin_financial_import_apply',args);
 return {fixture,source,args,receipt};
}
