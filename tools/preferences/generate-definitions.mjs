// Generates the "erp_preferences.page/definition" inserts from packages/erp-domain/src/preferences, one block per migration.
// Pages without `since` belong to migration 115 (already applied: its block never changes); a page with `since: '150'`
// is inserted by migration 202610200150 (page ordinals continue after the pages of 115). A key added later to an applied page
// carries its own `since` (for example '187'): only that migration inserts it, after the page's existing keys.
// Usage: node tools/preferences/generate-definitions.mjs [--write]. With --write it replaces every generated block in place;
// without it, it prints them. The SQL tests fail when a committed block differs from this output.
import{readFile,writeFile}from'node:fs/promises';
import{STORED_PREFERENCE_PAGES}from'../../packages/erp-domain/src/preferences/catalog.mjs';
import{definitionRows,fieldMigration,storedFields}from'../../packages/erp-domain/src/preferences/core.mjs';
// 264: a field whose format changed later (formatSince) is written as each migration applied it; min_length goes into the insert
// only for a block that has a row with it (the applied blocks never had the column).
export const MIGRATIONS=Object.freeze({
 '115':new URL('../../supabase/migrations/202610200115_erp_preferences.sql',import.meta.url),
 '150':new URL('../../supabase/migrations/202610200150_business_dashboards.sql',import.meta.url),
 '151':new URL('../../supabase/migrations/202610200151_notifications_company.sql',import.meta.url),
 '187':new URL('../../supabase/migrations/202610200187_notifications_expiry.sql',import.meta.url),
 '188':new URL('../../supabase/migrations/202610200188_business_settings.sql',import.meta.url),
 // Produtos lane, wave D: Sequencial EAN (prefixo GS1 e próximo número do item) on Configurações de produtos.
 '191':new URL('../../supabase/migrations/202610200191_product_registry_d.sql',import.meta.url),
 // Mixed lane, wave F: "Lote próximo ao vencimento" on the Central de Notificações.
 '283':new URL('../../supabase/migrations/202610200283_preferences_activity_notifications_f.sql',import.meta.url),
});
export const MIGRATION=MIGRATIONS['115'];
export const BEGIN='-- BEGIN GENERATED DEFINITIONS (tools/preferences/generate-definitions.mjs)';
export const END='-- END GENERATED DEFINITIONS';
const q=v=>`'${String(v).replaceAll("'","''")}'`;
const json=v=>v===null?'null':`${q(JSON.stringify(v))}::jsonb`;
const num=v=>v===null?'null':String(v);
export const pageMigration=page=>page.since??'115';
export function generatedBlock(migration='115'){
 if(!Object.hasOwn(MIGRATIONS,migration))throw new Error('GENERATED_MIGRATION_UNKNOWN');
 const ordinal=new Map(STORED_PREFERENCE_PAGES.map((p,i)=>[p.id,i+1])),own=STORED_PREFERENCE_PAGES.filter(p=>pageMigration(p)===migration);
 const pages=own.map(p=>` (${q(p.id)},${q(p.category)},${ordinal.get(p.id)},${q(p.scope)},array[${p.readRoles.map(q).join(',')}]::text[])`);
 const rows=STORED_PREFERENCE_PAGES.flatMap(p=>{const keys=new Set(storedFields(p).filter(f=>fieldMigration(p,f)===migration).map(f=>f.key));return definitionRows(p,migration).filter(r=>keys.has(r.key));});
 const withMin=rows.some(r=>Object.hasOwn(r,'min_length'));
 const lines=rows.map(r=>` (${q(r.key)},${q(r.page_id)},${q(r.section)},${r.ordinal},${q(r.kind)},${json(r.options)},${json(r.default_value)},${num(r.min_value)},${num(r.max_value)},${num(r.scale)},${num(r.max_length)},${num(r.max_items)},${r.format===null?'null':q(r.format)}${withMin?`,${num(r.min_length??null)}`:''})`);
 return[BEGIN,...(pages.length?['insert into erp_preferences.page(id,category,ordinal,scope,read_roles)values',pages.join(',\n')+';']:[]),
  `insert into erp_preferences.definition(key,page_id,section,ordinal,kind,options,default_value,min_value,max_value,scale,max_length,max_items,format${withMin?',min_length':''})values`,lines.join(',\n')+';',END].join('\n');
}
export async function committedBlock(migration='115'){
 const text=(await readFile(MIGRATIONS[migration],'utf8')).replace(/\r\n/g,'\n'),start=text.indexOf(BEGIN),end=text.indexOf(END);
 if(start<0||end<start)throw new Error('GENERATED_BLOCK_MISSING');return text.slice(start,end+END.length);
}
if(process.argv[1]?.replaceAll('\\','/').endsWith('tools/preferences/generate-definitions.mjs')){
 for(const migration of Object.keys(MIGRATIONS)){
  const block=generatedBlock(migration);
  // Keeps the file's line endings (a Windows checkout may carry CRLF), so an applied migration never shows a spurious change.
  if(process.argv.includes('--write')){const url=MIGRATIONS[migration],raw=await readFile(url,'utf8'),crlf=raw.includes('\r\n'),text=raw.replace(/\r\n/g,'\n');const start=text.indexOf(BEGIN),end=text.indexOf(END);
   if(start<0||end<start)throw new Error('GENERATED_BLOCK_MISSING');const next=text.slice(0,start)+block+text.slice(end+END.length);await writeFile(url,crlf?next.replace(/\n/g,'\r\n'):next);}
  else process.stdout.write(`-- ${migration}\n${block}\n`);
 }
}
