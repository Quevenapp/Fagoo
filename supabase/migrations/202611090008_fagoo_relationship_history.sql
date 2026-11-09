-- Explicit queue/contact association and source-authorized relationship history.
begin;
create table fagoo.relationship_link(
 ticket_id uuid primary key,unit_id uuid not null,contact_id uuid not null references erp_catalog.contact(record_id),
 version integer not null default 1,updated_by uuid not null references auth.users(id),updated_at timestamptz not null default now(),
 foreign key(unit_id,ticket_id) references fagoo.queue_ticket(unit_id,id)
);
create table fagoo.relationship_command(command_id uuid primary key,unit_id uuid not null references fagoo.unit(id),actor uuid not null references auth.users(id),request_hash text not null,result jsonb not null,created_at timestamptz not null default now());
create table fagoo.relationship_audit(id bigint generated always as identity primary key,unit_id uuid not null references fagoo.unit(id),ticket_id uuid not null references fagoo.queue_ticket(id),contact_id uuid not null references erp_catalog.contact(record_id),previous_contact_id uuid references erp_catalog.contact(record_id),actor uuid not null references auth.users(id),command_id uuid not null references fagoo.relationship_command(command_id),at timestamptz not null default now());
create index relationship_contact on fagoo.relationship_link(unit_id,contact_id);
alter table fagoo.relationship_link enable row level security;alter table fagoo.relationship_command enable row level security;alter table fagoo.relationship_audit enable row level security;
create function public.fagoo_relationship_link_read(p_user_id uuid,p_unit_id uuid,p_ticket_id uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$declare v fagoo.relationship_link;begin
 perform fagoo.require_unit(p_user_id,null,p_unit_id,'crm.read');perform fagoo.require_unit(p_user_id,null,p_unit_id,'queue.read');
 if not exists(select 1 from fagoo.queue_ticket where id=p_ticket_id and unit_id=p_unit_id) then raise exception 'relationship_ticket_not_found' using errcode='P0002';end if;
 select * into v from fagoo.relationship_link where unit_id=p_unit_id and ticket_id=p_ticket_id;
 if found then perform erp_catalog.contact_require_visible(p_user_id,v.contact_id);return jsonb_build_object('link',to_jsonb(v));end if;return '{"link":null}'::jsonb;
end $$;
create function public.fagoo_relationship_link_receipt(p_user_id uuid,p_unit_id uuid,p_command_id uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$declare v jsonb;begin
 perform fagoo.require_unit(p_user_id,null,p_unit_id,'crm.read');perform fagoo.require_unit(p_user_id,null,p_unit_id,'queue.read');
 select result into v from fagoo.relationship_command where unit_id=p_unit_id and command_id=p_command_id and actor=p_user_id;
 return coalesce(v||'{"replayed":true}'::jsonb,'{"status":"not_found"}'::jsonb);
end $$;
create function public.fagoo_relationship_link(p_user_id uuid,p_unit_id uuid,p_command_id uuid,p_ticket_id uuid,p_contact_id uuid,p_expected_version integer default 0) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text;v_command fagoo.relationship_command;v_link fagoo.relationship_link;v_previous uuid;v_result jsonb;
begin
 perform fagoo.require_unit(p_user_id,null,p_unit_id,'crm.write');perform fagoo.require_unit(p_user_id,null,p_unit_id,'crm.read');perform fagoo.require_unit(p_user_id,null,p_unit_id,'queue.operate');perform fagoo.require_unit(p_user_id,null,p_unit_id,'queue.read');
 if p_command_id is null or p_contact_id is null or p_ticket_id is null or p_expected_version is null or p_expected_version<0 then raise exception 'relationship_invalid_command' using errcode='22023';end if;
 perform erp_catalog.contact_require_visible(p_user_id,p_contact_id);
 if not exists(select 1 from erp_catalog.record r join erp_catalog.contact c on c.record_id=r.id where r.id=p_contact_id and r.active) then raise exception 'relationship_invalid_contact' using errcode='22023';end if;
 v_hash:=md5(jsonb_build_array(p_unit_id,p_ticket_id,p_contact_id,p_expected_version)::text);
 perform pg_advisory_xact_lock(hashtextextended('relationship-command:'||p_command_id::text,0));
 select * into v_command from fagoo.relationship_command where command_id=p_command_id;
 if found then if v_command.actor<>p_user_id or v_command.unit_id<>p_unit_id or v_command.request_hash<>v_hash then raise exception 'relationship_command_conflict' using errcode='40001';end if;return v_command.result||'{"replayed":true}'::jsonb;end if;
 perform 1 from fagoo.queue_ticket where id=p_ticket_id and unit_id=p_unit_id for update;if not found then raise exception 'relationship_ticket_not_found' using errcode='P0002';end if;
 select * into v_link from fagoo.relationship_link where ticket_id=p_ticket_id;
 if coalesce(v_link.version,0)<>p_expected_version then raise exception 'relationship_version_conflict' using errcode='40001';end if;
 v_previous:=v_link.contact_id;if v_previous is not null then perform erp_catalog.contact_require_visible(p_user_id,v_previous);end if;
 insert into fagoo.relationship_link(ticket_id,unit_id,contact_id,updated_by) values(p_ticket_id,p_unit_id,p_contact_id,p_user_id)
 on conflict(ticket_id) do update set contact_id=excluded.contact_id,version=fagoo.relationship_link.version+1,updated_by=excluded.updated_by,updated_at=now() returning * into v_link;
 v_result:=jsonb_build_object('status','succeeded','command_id',p_command_id,'link',to_jsonb(v_link),'replayed',false);
 insert into fagoo.relationship_command values(p_command_id,p_unit_id,p_user_id,v_hash,v_result,now());
 insert into fagoo.relationship_audit(unit_id,ticket_id,contact_id,previous_contact_id,actor,command_id) values(p_unit_id,p_ticket_id,p_contact_id,v_previous,p_user_id,p_command_id);
 return v_result;
end $$;
create function public.fagoo_relationship_history(p_user_id uuid,p_unit_id uuid,p_contact_id uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_queue boolean:=false;v_events jsonb;
begin
 perform fagoo.require_unit(p_user_id,null,p_unit_id,'crm.read');perform erp_catalog.contact_require_visible(p_user_id,p_contact_id);
 if p_contact_id is null or not exists(select 1 from erp_catalog.contact where record_id=p_contact_id) then raise exception 'relationship_contact_not_found' using errcode='P0002';end if;
 begin perform fagoo.require_unit(p_user_id,null,p_unit_id,'queue.read');v_queue:=true;exception when insufficient_privilege then v_queue:=false;end;
 select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'at',e.at,'kind',e.kind,'title',e.title,'href',e.href) order by e.at desc,e.id),'[]') into v_events from(select * from(
  select 'crm:'||e.id::text id,e.at,e.kind,e.title,null::text href from fagoo.crm_event e where e.unit_id=p_unit_id and e.contact_id=p_contact_id and fagoo.crm_visible(p_user_id,p_unit_id,e.owner_id)
  union all
  select 'queue:issued:'||t.id::text,t.issued_at,'queue.issued','Senha '||t.display_number||' emitida','/filas?unit='||p_unit_id::text from fagoo.relationship_link l join fagoo.queue_ticket t on t.id=l.ticket_id where v_queue and l.unit_id=p_unit_id and l.contact_id=p_contact_id
  union all
  select 'queue:closed:'||t.id::text,t.closed_at,'queue.closed','Senha '||t.display_number||': '||t.status,'/filas?unit='||p_unit_id::text from fagoo.relationship_link l join fagoo.queue_ticket t on t.id=l.ticket_id where v_queue and l.unit_id=p_unit_id and l.contact_id=p_contact_id and t.closed_at is not null
  union all
  select 'queue:event:'||e.id::text,e.occurred_at,'queue.event','Senha '||t.display_number||' — '||case e.type when 'ticket.called' then 'chamada' when 'ticket.recalled' then 'rechamada' when 'ticket.transferred' then 'transferência' else e.type end,'/filas?unit='||p_unit_id::text from fagoo.relationship_link l join fagoo.queue_ticket t on t.id=l.ticket_id join fagoo.queue_event e on e.unit_id=l.unit_id and e.aggregate_id=t.id where v_queue and l.unit_id=p_unit_id and l.contact_id=p_contact_id
  union all
  select 'queue:service:'||s.id::text,s.started_at,'queue.service','Atendimento da senha '||t.display_number||' no guichê '||s.desk,'/filas?unit='||p_unit_id::text from fagoo.relationship_link l join fagoo.queue_ticket t on t.id=l.ticket_id join fagoo.queue_service s on s.unit_id=l.unit_id and s.ticket_id=t.id where v_queue and l.unit_id=p_unit_id and l.contact_id=p_contact_id
  union all
  select 'queue:rating:'||r.id::text,r.received_at,'queue.rating','Avaliação da senha '||t.display_number||': '||r.stars::text||'/5'||case when nullif(r.comment,'') is null then '' else ' — '||r.comment end,'/filas?unit='||p_unit_id::text from fagoo.relationship_link l join fagoo.queue_ticket t on t.id=l.ticket_id join fagoo.queue_rating_invite i on i.unit_id=l.unit_id and i.ticket_id=t.id join fagoo.queue_rating r on r.invite_id=i.id where v_queue and l.unit_id=p_unit_id and l.contact_id=p_contact_id
  union all
  select 'document:'||d.id::text,d.updated_at,'commercial.document',case d.kind when 'sales_proposals' then 'Proposta comercial' when 'sales_orders' then 'Pedido de venda' when 'purchase_orders' then 'Pedido de compra' when 'service_orders' then 'Ordem de serviço' else 'Documento comercial' end||' '||d.number::text||' — '||d.status,'/documentos-empresa?tipo='||d.kind||'&documento='||d.id::text from erp_documents.document d where d.contact_id=p_contact_id and fagoo.crm_document_visible(p_user_id,d.id)
 ) source order by source.at desc,source.id limit 500) e;
 return jsonb_build_object('contact_id',p_contact_id,'events',v_events);
end $$;
revoke all on fagoo.relationship_link,fagoo.relationship_command,fagoo.relationship_audit from public,anon,authenticated,service_role;
revoke all on all sequences in schema fagoo from public,anon,authenticated,service_role;
revoke all on function public.fagoo_relationship_link_read(uuid,uuid,uuid),public.fagoo_relationship_link_receipt(uuid,uuid,uuid),public.fagoo_relationship_link(uuid,uuid,uuid,uuid,uuid,integer),public.fagoo_relationship_history(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.fagoo_relationship_link_read(uuid,uuid,uuid),public.fagoo_relationship_link_receipt(uuid,uuid,uuid),public.fagoo_relationship_link(uuid,uuid,uuid,uuid,uuid,integer),public.fagoo_relationship_history(uuid,uuid,uuid) to service_role;
commit;
