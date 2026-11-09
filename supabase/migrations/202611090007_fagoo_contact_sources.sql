-- Channel identities link explicitly to canonical ERP contacts, never by matching phone/email.
begin;
create table fagoo.contact_source(
 unit_id uuid not null references fagoo.unit(id),source_namespace text not null check(length(source_namespace) between 1 and 200),
 source_id text not null check(length(source_id) between 1 and 200),contact_id uuid not null references erp_catalog.contact(record_id),
 created_at timestamptz not null default now(),last_seen_at timestamptz not null default now(),primary key(unit_id,source_namespace,source_id)
);
alter table fagoo.contact_source enable row level security;
revoke all on fagoo.contact_source from public,anon,authenticated,service_role;
create function public.fagoo_contact_project(p_unit_id uuid,p_source_namespace text,p_source_id text,p_name text,p_phone text default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$declare v_id uuid;v_created boolean:=false;v_name text;v_phone text;begin
 if p_unit_id is null or not exists(select 1 from fagoo.unit where id=p_unit_id and active)
  or length(coalesce(p_source_namespace,'')) not between 1 and 200 or length(coalesce(p_source_id,'')) not between 1 and 200
  or length(coalesce(btrim(p_name),'')) not between 1 and 200 or length(coalesce(p_phone,''))>40 then raise exception 'fagoo_invalid_contact_source' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended(jsonb_build_array('contact-source',p_unit_id,p_source_namespace,p_source_id)::text,0));
 select contact_id into v_id from fagoo.contact_source where unit_id=p_unit_id and source_namespace=p_source_namespace and source_id=p_source_id;
 if v_id is null then
  v_id:=gen_random_uuid();insert into erp_catalog.record(id,entity,name,human_edited) values(v_id,'contacts',btrim(p_name),false);
  insert into erp_catalog.contact(record_id,phone) values(v_id,nullif(btrim(p_phone),''));
  insert into fagoo.contact_source(unit_id,source_namespace,source_id,contact_id) values(p_unit_id,p_source_namespace,p_source_id,v_id);v_created:=true;
 else update fagoo.contact_source set last_seen_at=now() where unit_id=p_unit_id and source_namespace=p_source_namespace and source_id=p_source_id;end if;
 select r.name,coalesce(c.mobile,c.phone) into v_name,v_phone from erp_catalog.record r join erp_catalog.contact c on c.record_id=r.id where r.id=v_id;
 return jsonb_build_object('contact_id',v_id,'created',v_created,'source_namespace',p_source_namespace,'source_id',p_source_id,'name',v_name,'phone',v_phone);
end $$;
revoke all on function public.fagoo_contact_project(uuid,text,text,text,text) from public,anon,authenticated;
grant execute on function public.fagoo_contact_project(uuid,text,text,text,text) to service_role;
commit;
