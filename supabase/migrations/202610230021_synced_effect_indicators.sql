-- Observed Origin indicators are synchronization evidence, never native postings.
begin;
create table erp_sync.indicator_observation (
 entity text not null check(entity in('sales_orders','purchase_orders','service_orders','nfe','nfce')),
 source_id text not null check(source_id~'^[1-9][0-9]{0,39}$'),
 source_number text not null check(source_number~'^[0-9]{1,20}$'),
 observed_at timestamptz not null, stock_flag text check(stock_flag in('S','R')),
 stock_label text, finance boolean not null, finance_label text,
 evidence_hash text not null, recorded_at timestamptz not null default clock_timestamp(),
 primary key(entity,source_id,observed_at),
 check((stock_flag is null)=(stock_label is null)),
 check(stock_label is null or length(stock_label) between 1 and 300),
 check(finance_label is null or length(finance_label) between 1 and 200)
);
alter table erp_sync.indicator_observation enable row level security;
revoke all on erp_sync.indicator_observation from public,anon,authenticated,service_role;
create function erp_sync.indicator_observation_immutable()returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'indicator_observation_immutable' using errcode='42501';end$$;
create trigger indicator_observation_immutable before update or delete on erp_sync.indicator_observation for each row execute function erp_sync.indicator_observation_immutable();

-- Service-only ingestion of bounded DOM observations from the connected, authenticated Origin list.
create function public.erp_sync_indicator_observe(p_entity text,p_observed_at timestamptz,p_items jsonb)returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare x jsonb; n integer:=0; h text;
begin
 if p_entity is null or p_entity not in('sales_orders','purchase_orders','service_orders','nfe','nfce') or p_observed_at is null or p_observed_at>clock_timestamp()+interval '5 minutes'
  or jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 1000 then raise exception 'indicator_observation_invalid' using errcode='22023';end if;
 if (select count(distinct v->>'source_id') from jsonb_array_elements(p_items)v)<>jsonb_array_length(p_items) then raise exception 'indicator_observation_duplicate' using errcode='22023';end if;
 for x in select value from jsonb_array_elements(p_items)loop
  if jsonb_typeof(x)<>'object' or not(x ?& array['source_id','number','stock_flag','stock_label','finance','finance_label'])
   or exists(select 1 from jsonb_object_keys(x)k where k<>all(array['source_id','number','stock_flag','stock_label','finance','finance_label']))
   or coalesce(x->>'source_id','')!~'^[1-9][0-9]{0,39}$' or coalesce(x->>'number','')!~'^[0-9]{1,20}$'
   or jsonb_typeof(x->'finance')<>'boolean' or (x->>'stock_flag' is not null and x->>'stock_flag' not in('S','R'))
   or ((x->>'stock_flag' is null)<>(x->>'stock_label' is null))
   or (x->>'stock_label' is not null and (length(x->>'stock_label')>300 or x->>'stock_label' !~ '^Estoque lançado'))
   or (x->>'finance_label' is not null and (length(x->>'finance_label')>200 or x->>'finance_label' !~ '^Conta[s]? lançada[s]?')) then raise exception 'indicator_observation_invalid' using errcode='22023';end if;
  -- A different number for the same source ID belongs to another company/source and is refused.
  if exists(select 1 from origin_sync.raw_record r where r.entity=p_entity and r.source_id=x->>'source_id' and ltrim(r.payload->>'numero','0') is distinct from ltrim(x->>'number','0')) then raise exception 'indicator_observation_identity_mismatch' using errcode='22023';end if;
  h:=encode(sha256(convert_to(jsonb_build_object('entity',p_entity,'observed_at',p_observed_at,'item',x)::text,'UTF8')),'hex');
  if exists(select 1 from erp_sync.indicator_observation o where o.entity=p_entity and o.source_id=x->>'source_id' and o.observed_at=p_observed_at and o.evidence_hash<>h)then raise exception 'indicator_observation_conflict' using errcode='40001';end if;
  insert into erp_sync.indicator_observation(entity,source_id,source_number,observed_at,stock_flag,stock_label,finance,finance_label,evidence_hash)
   values(p_entity,x->>'source_id',x->>'number',p_observed_at,x->>'stock_flag',x->>'stock_label',(x->>'finance')::boolean,x->>'finance_label',h)on conflict do nothing;
  n:=n+1;
 end loop;
 return jsonb_build_object('processed',n,'operational_effects',false);
end$$;

create function erp_sync.indicator_titles(p_entity text,p_source text,p_note text)returns table(source_id text,title_id uuid,direction text)
language sql stable set search_path=pg_catalog as $$
 select r.source_id,t.id,t.kind from origin_sync.raw_record r
 left join erp_sync.link l on l.entity=r.entity and l.origin_id=r.source_id
 left join erp_finance.title t on t.id=l.record_id and not t.cancelled and t.deleted_at is null
 where r.entity=case when p_entity='purchase_orders' then 'payables' when p_entity in('nfe','nfce') then
  case (select payload->>'tipo' from origin_sync.raw_record where entity=p_entity and source_id=p_source)when '0'then 'payables'else 'receivables'end else 'receivables'end
 and r.payload->>'situacao' is distinct from '5'
 and ((p_entity in('nfe','nfce') and r.payload#>>'{origem,id}'=p_source and r.payload#>>'{origem,tipoOrigem}'='notafiscal'
   and not exists(select 1 from origin_sync.raw_record z where z.entity=case p_entity when'nfe'then'nfce'else'nfe'end and z.source_id=p_source))
  or(p_entity not in('nfe','nfce') and ((r.payload#>>'{origem,id}'=p_source and r.payload#>>'{origem,tipoOrigem}'=any(case p_entity when'purchase_orders'then array['compra']when'service_orders'then array['ordemservico']else array['venda','pedido']end))
    or(p_note is not null and r.payload#>>'{origem,id}'=p_note and r.payload#>>'{origem,tipoOrigem}'='notafiscal'))))
$$;

create function public.erp_synced_effect_indicators(p_user_id uuid,p_entity text,p_ids jsonb,p_detail text default null)returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_id text; v_source text; v_note text; v_number text; o erp_sync.indicator_observation; result jsonb:='[]'; v_titles jsonb; v_count integer; v_stock boolean:=true; v_finance boolean:=true; v_direction text;
begin
 if p_entity is null or p_entity not in('sales_orders','purchase_orders','service_orders','sales_proposals','nfe','nfce')
  or jsonb_typeof(p_ids) is distinct from 'array' or jsonb_array_length(p_ids) not between 1 and 100
  or (p_detail is not null and(p_detail not in('C','E')or jsonb_array_length(p_ids)<>1)) then raise exception 'erp_document_invalid' using errcode='22023';end if;
 if p_entity in('nfe','nfce')then perform erp_fiscal_invoices.require_read(p_user_id);else perform erp_documents.require_access(p_user_id,p_entity,false);end if;
 begin perform erp_stock.require_access(p_user_id,false);exception when insufficient_privilege then v_stock:=false;end;
 begin perform erp_finance.require_access(p_user_id,false);exception when insufficient_privilege then v_finance:=false;end;
 if p_detail='C' and not v_finance or p_detail='E' and not v_stock then raise exception 'erp_document_permission_denied'using errcode='42501';end if;
 if (select count(distinct x#>>'{}')from jsonb_array_elements(p_ids)x)<>jsonb_array_length(p_ids)then raise exception 'erp_document_invalid'using errcode='22023';end if;
 for v_id in select jsonb_array_elements_text(p_ids)loop
  v_source:=null;v_note:=null;v_number:=null;v_titles:=null;o:=null;
  if p_entity in('nfe','nfce')then
   if v_id!~'^[1-9][0-9]{0,39}$'then raise exception 'erp_document_invalid'using errcode='22023';end if;
   if not erp_fiscal_mirror.visible(p_user_id,p_entity,v_id)then continue;end if;
   select source_id,payload->>'numero' into v_source,v_number from origin_sync.raw_record where entity=p_entity and source_id=v_id;
  else
   if v_id!~'^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'then raise exception 'erp_document_invalid'using errcode='22023';end if;
   if not erp_document_mirror.visible(p_user_id,v_id::uuid)then continue;end if;
   select l.origin_id into v_source from erp_documents.document d join erp_sync.link l on l.entity=d.kind and l.record_id=d.id where d.kind=p_entity and d.id=v_id::uuid and d.origin='origin';
   if v_source is not null then select coalesce(nullif(payload#>>'{notaFiscal,id}','0'),nullif(payload->>'idNotaFiscal','0')),payload->>'numero' into v_note,v_number from origin_sync.raw_record where entity=p_entity and source_id=v_source;end if;
  end if;
  if v_source is null then continue;end if;
  select * into o from erp_sync.indicator_observation x where x.entity=p_entity and x.source_id=v_source and ltrim(x.source_number,'0')=ltrim(v_number,'0')order by x.observed_at desc limit 1;
  select count(*) into v_count from erp_sync.indicator_titles(p_entity,v_source,v_note);
  if p_detail='C'then
   select coalesce(jsonb_agg(jsonb_build_object('source_id',x.source_id,'id',x.title_id,'direction',coalesce(x.direction,case when p_entity='purchase_orders' then'payable'else'receivable'end))order by x.source_id),'[]')into v_titles from erp_sync.indicator_titles(p_entity,v_source,v_note)x;
  end if;
  result:=result||jsonb_build_array(jsonb_build_object('id',v_id,'finance',coalesce(o.finance,v_count>0),'finance_count',v_count,'finance_label',coalesce(o.finance_label,'Contas lançadas'),
   'stock',case when v_stock and o.stock_flag is not null then jsonb_build_object('flag',o.stock_flag,'label',o.stock_label)else null end,
   'observed_at',o.observed_at,'titles',v_titles));
 end loop;
 return jsonb_build_object('entity',p_entity,'items',result,'data_mode','synced_observation','operational_effects',false);
end$$;
revoke all on function erp_sync.indicator_observation_immutable(),erp_sync.indicator_titles(text,text,text),public.erp_sync_indicator_observe(text,timestamptz,jsonb),public.erp_synced_effect_indicators(uuid,text,jsonb,text)from public,anon,authenticated,service_role;
grant execute on function public.erp_sync_indicator_observe(text,timestamptz,jsonb),public.erp_synced_effect_indicators(uuid,text,jsonb,text)to service_role;
commit;
