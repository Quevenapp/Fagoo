// Atalhos favoritos (Meu Negócio > Página inicial): the catalog of shortcuts is derived from the Origin menu
// (apps/erp/src/lib/origin-menu.ts, resolveMenu('real')): every real screen of the menu, items and footers, in menu order,
// except the home itself. Two copies are generated from it and checked by tests:
//  - HOME_SHORTCUTS in workers/erp-api/src/home.mjs (path -> roles that open it);
//  - erp_home.shortcut_catalog() in the latest migration that carries the generated block (the preferências lane).
// When another lane adds or changes a real menu path, run `node tools/home/generate-shortcut-catalog.mjs --write`:
// it rewrites both blocks. The SQL block lives in a migration that is not applied yet (202610200305, which took it over from
// the applied 286 with a hash guard of the applied version; 152, 190, 233, 266 and 286 keep the blocks production has); once that
// migration is applied, a new one must take over the block the same way (change CATALOG_MIGRATION and add the hash guard of
// the applied version).
import{readFile,writeFile}from'node:fs/promises';
import{ORIGIN_MENU}from'../../apps/erp/src/lib/origin-menu.ts';

export const ROLES=Object.freeze(['admin','consulta','vendas','financeiro','estoque','fiscal']);
// Mirror of erp_access.resources_for_role (migration 004); a PGlite test compares both.
export const RESOURCE_ROLES=Object.freeze({
 admin:['contacts','products','sales_orders','purchase_orders','sales_proposals','receivables','payables','nfe','nfce'],
 consulta:['contacts','products','sales_orders','purchase_orders','sales_proposals','receivables','payables','nfe','nfce'],
 vendas:['contacts','products','sales_orders','sales_proposals'],
 financeiro:['contacts','receivables','payables'],
 estoque:['contacts','products','purchase_orders'],
 fiscal:['contacts','products','sales_orders','purchase_orders','nfe','nfce'],
});
export const WORKER=new URL('../../workers/erp-api/src/home.mjs',import.meta.url);
export const CATALOG_MIGRATION=new URL('../../supabase/migrations/202610200305_home_shortcut_catalog.sql',import.meta.url);
export const BEGIN_JS='// BEGIN GENERATED HOME SHORTCUTS (tools/home/generate-shortcut-catalog.mjs)';
export const BEGIN_SQL='-- BEGIN GENERATED HOME SHORTCUTS (tools/home/generate-shortcut-catalog.mjs)';
export const END_JS='// END GENERATED HOME SHORTCUTS',END_SQL='-- END GENERATED HOME SHORTCUTS';

/** Real menu targets in menu order (first occurrence of a path wins), without the home (/acesso). */
export function catalogEntries(menu=ORIGIN_MENU){
 const out=[];
 for(const group of menu)for(const item of[...group.columns.flatMap(column=>column.items),...(group.footer?[group.footer]:[])]){
  const target=item.real;if(!target||target.to==='/acesso'||out.some(e=>e.path===target.to))continue;
  if(typeof target.to!=='string'||!/^\/[a-z0-9-]+(?:\/[a-z0-9-]+)*(?:\?[a-z0-9_=&-]+)?$/.test(target.to)||target.to.length>200)throw new Error(`HOME_SHORTCUT_PATH_INVALID ${target.to}`);
  if(target.roles&&(!target.roles.length||target.roles.some(r=>!ROLES.includes(r))))throw new Error(`HOME_SHORTCUT_ROLES_INVALID ${target.to}`);
  if(target.resource&&!Object.values(RESOURCE_ROLES).some(list=>list.includes(target.resource)))throw new Error(`HOME_SHORTCUT_RESOURCE_INVALID ${target.to}`);
  out.push({path:target.to,roles:target.roles?ROLES.filter(r=>target.roles.includes(r)):null,resource:target.resource??null});
 }
 return out;
}
/** Roles that open a shortcut: the target roles (or every role) that also hold the target resource. */
export const entryRoles=entry=>ROLES.filter(r=>(!entry.roles||entry.roles.includes(r))&&(!entry.resource||RESOURCE_ROLES[r].includes(entry.resource)));
const q=v=>`'${String(v).replaceAll("'","''")}'`;
export function workerBlock(entries=catalogEntries()){
 return[BEGIN_JS,'export const HOME_SHORTCUTS=Object.freeze({',...entries.map(e=>` ${q(e.path)}:Object.freeze([${entryRoles(e).map(q).join(',')}]),`),'});',END_JS].join('\n');
}
export function sqlBlock(entries=catalogEntries()){
 const rows=entries.map((e,i)=>`  (${i+1},${q(e.path)},${e.roles?`array[${e.roles.map(q).join(',')}]`:'null::text[]'},${e.resource?q(e.resource):'null::text'})`);
 return[BEGIN_SQL,'create or replace function erp_home.shortcut_catalog() returns table(ordinal integer,path text,roles text[],resource text)',
  'language sql immutable set search_path=pg_catalog as $$',' values',rows.join(',\n'),'$$;','revoke all on function erp_home.shortcut_catalog() from public,anon,authenticated,service_role;',END_SQL].join('\n');
}
const between=(text,begin,end)=>{const start=text.indexOf(begin),stop=text.indexOf(end,start);if(start<0||stop<start)throw new Error(`GENERATED_BLOCK_MISSING ${begin}`);return[start,stop+end.length];};
const read=async url=>(await readFile(url,'utf8')).replace(/\r\n/g,'\n');
export async function committedWorkerBlock(){const text=await read(WORKER),[a,b]=between(text,BEGIN_JS,END_JS);return text.slice(a,b);}
export async function committedSqlBlock(){const text=await read(CATALOG_MIGRATION),[a,b]=between(text,BEGIN_SQL,END_SQL);return text.slice(a,b);}
// Keeps the file's line endings (a Windows checkout may carry CRLF).
async function rewrite(url,begin,end,block){
 const raw=await readFile(url,'utf8'),crlf=raw.includes('\r\n'),text=raw.replace(/\r\n/g,'\n'),[a,b]=between(text,begin,end),next=text.slice(0,a)+block+text.slice(b);
 await writeFile(url,crlf?next.replace(/\n/g,'\r\n'):next);
}

if(process.argv[1]?.replaceAll('\\','/').endsWith('tools/home/generate-shortcut-catalog.mjs')){
 if(process.argv.includes('--write')){await rewrite(WORKER,BEGIN_JS,END_JS,workerBlock());await rewrite(CATALOG_MIGRATION,BEGIN_SQL,END_SQL,sqlBlock());}
 else process.stdout.write(`${workerBlock()}\n\n${sqlBlock()}\n`);
}
