import {readFile} from 'node:fs/promises';
// Only the missing commercial dependencies of the reusable synthetic 048/050 fixture.
export async function commercialFoundation(f){
 for(const name of ['0034_document_copy','0054_document_commercial'])await f.db.exec(await readFile(new URL(`../../../supabase/migrations/20261016${name}.sql`,import.meta.url),'utf8'));
}
export async function applyPricePrecision(f){
 await f.db.exec(await readFile(new URL('../../../supabase/migrations/202610160057_unit_price_precision.sql',import.meta.url),'utf8'));
}
