-- Diário operacional separado do corpo comercial da OS. Nenhum efeito financeiro/estoque.
begin;
create table erp_documents.service_journal_entry (
 id uuid primary key default gen_random_uuid(),
 document_id uuid not null references erp_documents.document(id),
 sequence bigint not null check(sequence between 1 and 9999999999),
 document_version integer not null check(document_version>0),
 text text not null check(length(text) between 1 and 4000),
 actor_id uuid not null references auth.users(id),
 recorded_at timestamptz not null default clock_timestamp(),
 unique(document_id,sequence)
);
create table erp_documents.service_journal_command (
 command_id uuid primary key,actor_id uuid not null references auth.users(id),
 request_hash text not null,entry_id uuid not null unique references erp_documents.service_journal_entry(id),
 created_at timestamptz not null default clock_timestamp()
);
alter table erp_documents.service_journal_entry enable row level security;
alter table erp_documents.service_journal_command enable row level security;
revoke all on erp_documents.service_journal_entry,erp_documents.service_journal_command from public,anon,authenticated,service_role;
create function erp_documents.service_journal_immutable() returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'erp_journal_immutable' using errcode='55000';end $$;
create trigger service_journal_entry_immutable before update or delete on erp_documents.service_journal_entry for each row execute function erp_documents.service_journal_immutable();
create trigger service_journal_command_immutable before update or delete on erp_documents.service_journal_command for each row execute function erp_documents.service_journal_immutable();

create function erp_documents.service_journal_item(e erp_documents.service_journal_entry) returns jsonb language sql immutable set search_path=pg_catalog as $$
 select jsonb_build_object('id',e.id,'document_id',e.document_id,'sequence',e.sequence::text,
  'document_version',e.document_version,'text',e.text,'actor_id',e.actor_id,'recorded_at',e.recorded_at);
$$;
create function erp_documents.service_journal_context(p_user_id uuid,p_document_id uuid,p_write boolean default false)
returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare d erp_documents.document%rowtype;r text;
begin
 perform erp_documents.require_access(p_user_id,'service_orders',p_write);
 select * into d from erp_documents.document where id=p_document_id and kind='service_orders';
 if not found then raise exception 'erp_journal_not_found' using errcode='P0002';end if;
 select role into r from erp_access.membership where user_id=p_user_id and active;
 return jsonb_build_object('scope','service_order_journal','document_id',d.id,'document_version',d.version,
  'can_write',erp_documents.allowed(r,'service_orders',true),'data_mode','erp_native','operational_effects',false);
end $$;

create function public.erp_service_journal_list(p_user_id uuid,p_document_id uuid,p_limit integer default 25,p_before text default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare context jsonb;result jsonb;
begin
 context:=erp_documents.service_journal_context(p_user_id,p_document_id);
 if p_limit is null or p_limit not between 1 and 100 or (p_before is not null and p_before !~ '^[1-9][0-9]{0,9}$') then raise exception 'erp_journal_invalid_query' using errcode='22023';end if;
 with rows as materialized(select e.sequence,erp_documents.service_journal_item(e) item from erp_documents.service_journal_entry e
  where e.document_id=p_document_id and(p_before is null or e.sequence<p_before::bigint) order by e.sequence desc limit p_limit+1),
 page as(select * from rows order by sequence desc limit p_limit)
 select jsonb_build_object('items',coalesce((select jsonb_agg(item order by sequence desc) from page),'[]'::jsonb),'limit',p_limit,
  'has_more',(select count(*) from rows)>p_limit,'next_before',case when(select count(*) from rows)>p_limit then(select min(sequence)::text from page)end) into result;
 return context||result;
end $$;
create function public.erp_service_journal_get(p_user_id uuid,p_document_id uuid,p_entry_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare context jsonb;entry jsonb;
begin
 context:=erp_documents.service_journal_context(p_user_id,p_document_id);
 select erp_documents.service_journal_item(e) into entry from erp_documents.service_journal_entry e where document_id=p_document_id and id=p_entry_id;
 if entry is null then raise exception 'erp_journal_not_found' using errcode='P0002';end if;
 return context||jsonb_build_object('entry',entry);
end $$;
create function public.erp_service_journal_append(p_user_id uuid,p_document_id uuid,p_expected_document_version integer,p_command_id uuid,p_text text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare context jsonb;d erp_documents.document%rowtype;c erp_documents.service_journal_command%rowtype;
 e erp_documents.service_journal_entry%rowtype;v_hash text;v_text text;v_sequence bigint;
begin
 context:=erp_documents.service_journal_context(p_user_id,p_document_id,true);
 v_text:=btrim(p_text);
 if p_command_id is null or p_expected_document_version is null or p_expected_document_version<1 or v_text is null or length(v_text)>4000 or octet_length(p_text)>32768
  or v_text !~ E'[^ \\t\\r\\n]' or translate(v_text,E'\n\r\t','') ~ '[[:cntrl:]]' then raise exception 'erp_journal_invalid_input' using errcode='22023';end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'document',p_document_id,'version',p_expected_document_version,'text',p_text)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852928,hashtext(p_command_id::text));
 select * into c from erp_documents.service_journal_command where command_id=p_command_id;
 if found then
  if c.actor_id<>p_user_id or c.request_hash<>v_hash then raise exception 'erp_journal_command_conflict' using errcode='40001';end if;
  return public.erp_service_journal_get(p_user_id,p_document_id,c.entry_id)||jsonb_build_object('replayed',true);
 end if;
 -- Serializes appends and captures the commercial version without updating its body/version.
 select * into d from erp_documents.document where id=p_document_id and kind='service_orders' for update;
 if not found then raise exception 'erp_journal_not_found' using errcode='P0002';end if;
 if d.version<>p_expected_document_version then raise exception 'erp_journal_document_changed' using errcode='40001';end if;
 select coalesce(max(sequence),0)+1 into v_sequence from erp_documents.service_journal_entry where document_id=p_document_id;
 if v_sequence>9999999999 then raise exception 'erp_journal_limit' using errcode='22023';end if;
 insert into erp_documents.service_journal_entry(document_id,sequence,document_version,text,actor_id)
 values(p_document_id,v_sequence,d.version,v_text,p_user_id) returning * into e;
 insert into erp_documents.service_journal_command(command_id,actor_id,request_hash,entry_id)values(p_command_id,p_user_id,v_hash,e.id);
 return erp_documents.service_journal_context(p_user_id,p_document_id,true)||jsonb_build_object('entry',erp_documents.service_journal_item(e),'replayed',false);
end $$;
revoke all on function erp_documents.service_journal_immutable(),erp_documents.service_journal_item(erp_documents.service_journal_entry),erp_documents.service_journal_context(uuid,uuid,boolean) from public,anon,authenticated,service_role;
revoke all on function public.erp_service_journal_list(uuid,uuid,integer,text),public.erp_service_journal_get(uuid,uuid,uuid),public.erp_service_journal_append(uuid,uuid,integer,uuid,text) from public,anon,authenticated;
grant execute on function public.erp_service_journal_list(uuid,uuid,integer,text),public.erp_service_journal_get(uuid,uuid,uuid),public.erp_service_journal_append(uuid,uuid,integer,uuid,text) to service_role;
commit;
