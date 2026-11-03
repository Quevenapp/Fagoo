#!/usr/bin/env node
// Leva H, lane plataforma (PRF-296, CTT-045, VND-042): builds supabase/migrations/202610210332_reference_tables.sql from the
// versioned copies in tools/reference/official (CNAE 2.3 subclasses and municipalities from IBGE, countries from the NF-e table).
// `--write` rewrites the migration; without it the script fails when the file differs (the tests run the same check).
// To update a table: fetch the official file again, rewrite the JSON copy (source, version and fetched_on included) and add
// a new migration with the new version; never edit an applied migration.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const root = new URL('../../', import.meta.url);
const read = name => JSON.parse(readFileSync(new URL(`tools/reference/official/${name}`, root), 'utf8'));
export const MIGRATION = 'supabase/migrations/202610210332_reference_tables.sql';
const q = value => value === null || value === undefined ? 'null' : `'${String(value).replace(/'/g, "''")}'`;
const digest = rows => createHash('sha256').update(JSON.stringify(rows)).digest('hex');

export function referenceDatasets() {
  const cnae = read('cnae-subclasses.json'), cities = read('municipios-ibge.json'), countries = read('paises-nfe.json');
  for (const row of cnae.rows) if (!/^\d{7}$/.test(row.code) || !/^\d{5}$/.test(row.class) || !/^[A-U]$/.test(row.section) || !row.description) throw new Error(`cnae ${row.code}`);
  for (const row of cities.rows) if (!/^\d{7}$/.test(row.code) || !/^[A-Z]{2}$/.test(row.uf) || !row.name) throw new Error(`municipio ${row.code}`);
  for (const row of countries.rows) if (!/^\d{4}$/.test(row.code) || !row.name || !/^\d{4}-\d{2}-\d{2}$/.test(row.start_on) || (row.end_on !== null && !/^\d{4}-\d{2}-\d{2}$/.test(row.end_on))) throw new Error(`pais ${row.code}`);
  return { cnae, cities, countries };
}

function values(rows, line) {
  const out = [];
  for (let i = 0; i < rows.length; i += 500) out.push(rows.slice(i, i + 500).map(line).join(',\n'));
  return out;
}

export function buildReferenceMigration() {
  const { cnae, cities, countries } = referenceDatasets();
  const meta = [['cnae', cnae], ['municipios', cities], ['paises', countries]];
  const head = `-- GERADO por tools/reference/build-reference-migration.mjs a partir de tools/reference/official; não editar à mão.
-- Leva H, lane plataforma: tabelas oficiais embarcadas, com fonte e versão registradas em erp_reference.dataset.
-- * CNAE 2.3 (subclasses) do IBGE/CONCLA (PRF-296): autocompletar o CNAE em Empresa › Dados da empresa; um CNAE novo ou alterado
--   precisa existir na tabela (os já gravados continuam como estão até serem alterados).
-- * Países da NF-e (cPais, NT 2018.003 v1.01) (CTT-045): código e descrição oficiais para o País do contato estrangeiro. Um código
--   pode ter mais de um nome (alteração de nome); nenhum código é deduzido de um nome digitado.
-- * Municípios do IBGE (VND-042): código e nome por UF, para conferir o Município nas pendências do pedido (333) e sugerir o nome.
-- Leitura por qualquer membro ativo (public.erp_reference_search). Tabelas e funções novas; nada de outra frente é redefinido.
begin;

do $$begin
 if to_regnamespace('erp_reference') is not null then raise exception 'reference_332_already_applied' using errcode='55000'; end if;
 if to_regclass('erp_company.extra') is null or to_regprocedure('erp_access.member_role(uuid)') is null then raise exception 'reference_332_requires_151' using errcode='55000'; end if;
end$$;

create schema erp_reference;
revoke all on schema erp_reference from public,anon,authenticated,service_role;
create table erp_reference.dataset(
 name text primary key check(name in('cnae','municipios','paises')),source text not null,source_url text not null,version text not null,
 fetched_on date not null,rows integer not null check(rows>0),sha256 text not null check(sha256~'^[a-f0-9]{64}$'),loaded_at timestamptz not null default clock_timestamp()
);
create table erp_reference.cnae(code text primary key check(code~'^[0-9]{7}$'),description text not null,class_code text not null check(class_code~'^[0-9]{5}$'),section text not null check(section~'^[A-U]$'));
create table erp_reference.municipality(code text primary key check(code~'^[0-9]{7}$'),name text not null,uf text not null check(uf~'^[A-Z]{2}$'),key text not null);
create index erp_reference_municipality_key on erp_reference.municipality(uf,key);
create table erp_reference.country(code text not null check(code~'^[0-9]{4}$'),name text not null,situation text,start_on date not null,end_on date,key text not null,primary key(code,name));
do $$declare t text;begin foreach t in array array['dataset','cnae','municipality','country'] loop
 execute format('alter table erp_reference.%I enable row level security',t);
 execute format('revoke all on erp_reference.%I from public,anon,authenticated,service_role',t);
end loop;end$$;

-- Comparison key: lower case, no accents, only letters and digits ("Alta Floresta D'Oeste" = "alta floresta doeste").
create function erp_reference.key(p text) returns text language sql immutable set search_path=pg_catalog as $$
 select regexp_replace(translate(lower(coalesce(p,'')),'áàâãäéèêëíìîïóòôõöúùûüçñ','aaaaaeeeeiiiiooooouuuucn'),'[^a-z0-9]','','g')
$$;
`;
  const cnaeSql = values(cnae.rows, r => `(${q(r.code)},${q(r.description)},${q(r.class)},${q(r.section)})`)
    .map(chunk => `insert into erp_reference.cnae(code,description,class_code,section) values\n${chunk};`).join('\n');
  const citySql = values(cities.rows, r => `(${q(r.code)},${q(r.name)},${q(r.uf)})`)
    .map(chunk => `insert into erp_reference.municipality(code,name,uf,key) select c,n,u,erp_reference.key(n) from (values\n${chunk}) v(c,n,u);`).join('\n');
  const countrySql = values(countries.rows, r => `(${q(r.code)},${q(r.name)},${q(r.situation)},${q(r.start_on)}::date,${r.end_on ? `${q(r.end_on)}::date` : 'null::date'})`)
    .map(chunk => `insert into erp_reference.country(code,name,situation,start_on,end_on,key) select c,n,s,b,e,erp_reference.key(n) from (values\n${chunk}) v(c,n,s,b,e);`).join('\n');
  const datasetSql = `insert into erp_reference.dataset(name,source,source_url,version,fetched_on,rows,sha256) values\n${meta.map(([name, d]) =>
    `(${q(name)},${q(d.source)},${q(d.source_url)},${q(d.version)},${q(d.fetched_on)},${d.rows.length},${q(digest(d.rows))})`).join(',\n')};`;
  const tail = `
-- The copy must be complete: any difference between the counts and the recorded rows stops the migration.
do $$begin
 if (select rows from erp_reference.dataset where name='cnae')<>(select count(*) from erp_reference.cnae)
  or (select rows from erp_reference.dataset where name='municipios')<>(select count(*) from erp_reference.municipality)
  or (select rows from erp_reference.dataset where name='paises')<>(select count(*) from erp_reference.country) then
  raise exception 'reference_332_incomplete_copy' using errcode='55000'; end if;
end$$;

create function erp_reference.cnae_format(p text) returns text language sql immutable set search_path=pg_catalog as $$
 select left(p,4)||'-'||substr(p,5,1)||'/'||right(p,2)
$$;
create function erp_reference.dataset_json(p_name text) returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('name',d.name,'source',d.source,'source_url',d.source_url,'version',d.version,'fetched_on',to_char(d.fetched_on,'YYYY-MM-DD'),'rows',d.rows)
 from erp_reference.dataset d where d.name=p_name
$$;

-- Busca nas tabelas oficiais (autocompletar): pelo código ou por parte do nome; município dentro da UF; país vigente na data.
create function public.erp_reference_search(p_user_id uuid,p_table text,p_query text,p_uf text,p_limit integer) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_key text;v_digits text;v_items jsonb;v_today date:=(clock_timestamp() at time zone 'America/Sao_Paulo')::date;
begin
 perform erp_access.member_role(p_user_id);
 if p_table is null or p_table not in('cnae','municipios','paises') or p_limit is null or p_limit not between 1 and 50
  or p_query is not null and(length(p_query)>80 or p_query~'[[:cntrl:]]') or p_uf is not null and(p_table<>'municipios' or p_uf!~'^[A-Z]{2}$') then
  raise exception 'erp_reference_input_invalid' using errcode='22023'; end if;
 v_key:=erp_reference.key(p_query);v_digits:=regexp_replace(coalesce(p_query,''),'[^0-9]','','g');
 if p_table='cnae' then
  select coalesce(jsonb_agg(jsonb_build_object('code',erp_reference.cnae_format(c.code),'description',c.description,'section',c.section) order by c.code),'[]'::jsonb) into v_items
  from(select * from erp_reference.cnae c where v_key='' or v_digits<>'' and c.code like v_digits||'%' or erp_reference.key(c.description) like '%'||v_key||'%' order by c.code limit p_limit) c;
 elsif p_table='municipios' then
  select coalesce(jsonb_agg(jsonb_build_object('code',m.code,'name',m.name,'uf',m.uf) order by m.starts desc,m.name,m.code),'[]'::jsonb) into v_items
  from(select m.*,m.key like v_key||'%' starts from erp_reference.municipality m where(p_uf is null or m.uf=p_uf)
   and(v_key='' or v_digits<>'' and m.code like v_digits||'%' or m.key like '%'||v_key||'%') order by m.key like v_key||'%' desc,m.name,m.code limit p_limit) m;
 else
  select coalesce(jsonb_agg(jsonb_build_object('code',c.code,'name',c.name) order by c.starts desc,c.name),'[]'::jsonb) into v_items
  from(select c.*,c.key like v_key||'%' starts from erp_reference.country c where c.start_on<=v_today and(c.end_on is null or c.end_on>=v_today)
   and(v_key='' or v_digits<>'' and c.code like v_digits||'%' or c.key like '%'||v_key||'%') order by c.key like v_key||'%' desc,c.name limit p_limit) c;
 end if;
 return jsonb_build_object('scope','reference_search','data_mode','erp_native','table',p_table,'dataset',erp_reference.dataset_json(p_table),'items',v_items);
end $$;

-- Is (city, UF) an IBGE municipality? Null when either is empty or the UF is EX (exterior).
create function erp_reference.municipality_known(p_city text,p_uf text) returns boolean language sql stable set search_path=pg_catalog as $$
 select case when nullif(btrim(coalesce(p_city,'')),'') is null or upper(btrim(coalesce(p_uf,''))) in('','EX') then null
  else exists(select 1 from erp_reference.municipality m where m.uf=upper(btrim(p_uf)) and m.key=erp_reference.key(p_city)) end
$$;

-- PRF-296: a CNAE written (new or changed) must be an official subclass; the value already stored is kept as it is.
create function erp_reference.company_extra_cnae() returns trigger language plpgsql set search_path=pg_catalog as $$
declare v text:=regexp_replace(coalesce(new.data->>'cnae',''),'[^0-9]','','g');
begin
 if v<>'' and(tg_op='INSERT' or new.data->>'cnae' is distinct from old.data->>'cnae') and not exists(select 1 from erp_reference.cnae c where c.code=v) then
  raise exception 'erp_company_extra_cnae_unknown' using errcode='22023'; end if;
 return new;
end $$;
create trigger extra_cnae_official before insert or update on erp_company.extra for each row execute function erp_reference.company_extra_cnae();

revoke all on all functions in schema erp_reference from public,anon,authenticated,service_role;
revoke all on function public.erp_reference_search(uuid,text,text,text,integer) from public,anon,authenticated,service_role;
grant execute on function public.erp_reference_search(uuid,text,text,text,integer) to service_role;
commit;
`;
  return `${head}\n${datasetSql}\n${cnaeSql}\n${citySql}\n${countrySql}\n${tail}`;
}

if (import.meta.url === new URL(process.argv[1], 'file:').href || process.argv[1]?.endsWith('build-reference-migration.mjs')) {
  const sql = buildReferenceMigration(), target = new URL(MIGRATION, root);
  if (process.argv.includes('--write')) { writeFileSync(target, sql); console.log(`wrote ${MIGRATION} (${sql.length} bytes)`); }
  else {
    let current = ''; try { current = readFileSync(target, 'utf8').replace(/\r\n/g, '\n'); } catch { /* missing */ }
    if (current !== sql) { console.error(`${MIGRATION} differs from the data copies; run with --write`); process.exit(1); }
    console.log(`${MIGRATION} is current`);
  }
}
