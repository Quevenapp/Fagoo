-- Read-only examination of observed Origin AP/AR facts. No import or ledger writes.
begin;

create function erp_cutover.financial_text(v jsonb,p_limit integer) returns text
language sql immutable set search_path=pg_catalog as $$
 select case when jsonb_typeof(v)='string' and (v#>>'{}')!~'[[:cntrl:]]' then left(v#>>'{}',p_limit) end
$$;
create function erp_cutover.financial_date(v jsonb) returns date
language plpgsql immutable set search_path=pg_catalog as $$
declare t text;d date;
begin
 if jsonb_typeof(v) is distinct from 'string' then return null;end if;t:=v#>>'{}';
 if t!~'^(19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}$' then return null;end if;
 d:=t::date;if to_char(d,'YYYY-MM-DD')<>t then return null;end if;return d;
exception when datetime_field_overflow or invalid_datetime_format then return null;
end $$;
create function erp_cutover.financial_money(p jsonb,k text) returns jsonb
language plpgsql immutable set search_path=pg_catalog as $$
declare v jsonb:=p->k;t text;state text;n numeric;
begin
 if v is null then state:='missing';
 elsif v='null'::jsonb then state:='null';
 elsif jsonb_typeof(v)<>'number' then state:='invalid_type';
 else
  t:=v#>>'{}';
  if length(t)>80 then state:='out_of_range';
  elsif t!~'^[0-9]+(\.[0-9]{1,2})?$' then state:='invalid_value';
  elsif length(split_part(t,'.',1))>14 then state:='out_of_range';
  else n:=t::numeric;return jsonb_build_object('state','available','value',to_char(n,'FM99999999999990.00'),'cents',(n*100)::numeric(18,0)::text);end if;
 end if;
 return jsonb_build_object('state',state,'value',null,'cents',null);
end $$;
create function erp_cutover.financial_status(p jsonb) returns jsonb
language sql immutable set search_path=pg_catalog as $$
 select jsonb_build_object('code',c,'label',coalesce(erp_cutover.status_label(c),'Não reconhecida'),
 'scope',case c when '1' then 'open' when '3' then 'partial' else case when c is null then 'unknown' else 'outside_open_scope' end end)
 from(select case when jsonb_typeof(p->'situacao') in('number','string') and p->>'situacao' in('1','2','3','4','5','6','7') then p->>'situacao' end c)s
$$;
create function erp_cutover.financial_issue_level(c text) returns text
language sql immutable set search_path=pg_catalog as $$
 select case when c=any(array['SOURCE_ID_MISMATCH','SOURCE_STATUS_UNKNOWN','AMOUNT_UNAVAILABLE','AMOUNT_ZERO','AMOUNT_EXCEEDS_NATIVE_LIMIT',
 'BALANCE_UNAVAILABLE','BALANCE_EXCEEDS_AMOUNT','DATES_MISSING_OR_INVALID','DUE_BEFORE_ISSUED','CONTACT_REFERENCE_MISSING',
 'CONTACT_REFERENCE_INVALID','CONTACT_UNMATCHED','CONTACT_INACTIVE']) then 'blocker' when c='REFRESH_PENDING' then 'info' else 'review' end
$$;

create function erp_cutover.financial_row(r origin_sync.raw_record,p_detail boolean) returns jsonb
language plpgsql stable set search_path=pg_catalog as $$
declare p jsonb:=r.payload;amount jsonb;balance jsonb;status jsonb;contact jsonb;result jsonb;issues text[]:=array[]::text[];
 cid text;match text;native erp_catalog.record%rowtype;origin erp_catalog.origin%rowtype;contact_hash text;
 pending boolean;source_changed boolean;issued date;due date;original_due date;competence date;v jsonb;field text;lim integer;
 refresh_origin origin_finance_refresh.origin%rowtype;attempt origin_finance_refresh.attempt%rowtype;refresh_state text;
 refs jsonb;ids jsonb:='[]'::jsonb;raw_ids jsonb;extra jsonb;part_kind text;part_total text;bank_number text;
begin
 amount:=erp_cutover.financial_money(p,'valor');balance:=erp_cutover.financial_money(p,'saldo');status:=erp_cutover.financial_status(p);
 if erp_cutover.exact_id(p->'id') is distinct from r.source_id then issues:=array_append(issues,'SOURCE_ID_MISMATCH');end if;
 if status->>'scope'='unknown' then issues:=array_append(issues,'SOURCE_STATUS_UNKNOWN');
 elsif status->>'scope'='outside_open_scope' then issues:=array_append(issues,'SOURCE_STATUS_OUTSIDE_OPEN_SCOPE');
 elsif status->>'scope'='partial' then issues:=array_append(issues,'PARTIAL_STATUS_REQUIRES_REVIEW');end if;
 if amount->>'state'<>'available' then issues:=array_append(issues,'AMOUNT_UNAVAILABLE');
 elsif amount->>'cents'='0' then issues:=array_append(issues,'AMOUNT_ZERO');
 elsif (amount->>'cents')::numeric>999999999999999 then issues:=array_append(issues,'AMOUNT_EXCEEDS_NATIVE_LIMIT');end if;
 if balance->>'state'<>'available' then issues:=array_append(issues,'BALANCE_UNAVAILABLE');
 else
  if balance->>'cents'='0' then issues:=array_append(issues,'BALANCE_ZERO');end if;
  if amount->>'state'='available' and (balance->>'cents')::numeric>(amount->>'cents')::numeric then issues:=array_append(issues,'BALANCE_EXCEEDS_AMOUNT');end if;
  if status->>'scope'='open' and amount->>'state'='available' and balance->>'cents'<>amount->>'cents' then issues:=array_append(issues,'OPEN_BALANCE_DIFFERS');end if;
 end if;
 issued:=erp_cutover.financial_date(p->'dataEmissao');due:=erp_cutover.financial_date(p->'vencimento');
 original_due:=erp_cutover.financial_date(p->'vencimentoOriginal');competence:=erp_cutover.financial_date(p->'competencia');
 if issued is null or due is null or(p ? 'vencimentoOriginal' and p->'vencimentoOriginal'<>'null'::jsonb and original_due is null)
  or(p ? 'competencia' and p->'competencia'<>'null'::jsonb and competence is null) then issues:=array_append(issues,'DATES_MISSING_OR_INVALID');end if;
 if due<issued then issues:=array_append(issues,'DUE_BEFORE_ISSUED');end if;
 foreach field in array array['numeroDocumento','historico'] loop
  v:=p->field;lim:=case field when 'historico' then 240 else 200 end;
  if v is not null and v<>'null'::jsonb then
   if jsonb_typeof(v)<>'string' or(v#>>'{}')~'[[:cntrl:]]' then issues:=array_append(issues,'SOURCE_TEXT_INVALID');
   elsif length(v#>>'{}')>lim then issues:=array_append(issues,'SOURCE_TEXT_TRUNCATED');end if;
  end if;
 end loop;
 v:=p#>'{contato,id}';cid:=erp_cutover.exact_id(v);
 if p->'contato' is null or p->'contato'='null'::jsonb or(jsonb_typeof(p->'contato')='object' and(v is null or v='null'::jsonb)) then match:='missing_reference';issues:=array_append(issues,'CONTACT_REFERENCE_MISSING');
 elsif jsonb_typeof(p->'contato')<>'object' or cid is null then match:='invalid_reference';cid:=null;issues:=array_append(issues,'CONTACT_REFERENCE_INVALID');
 else
  select * into origin from erp_catalog.origin o where o.entity='contacts' and o.source_id=cid;
  if found then
   select * into native from erp_catalog.record c where c.id=origin.record_id and c.entity='contacts' and exists(select 1 from erp_catalog.contact cc where cc.record_id=c.id);
  end if;
  if native.id is null then match:='unmatched';issues:=array_append(issues,'CONTACT_UNMATCHED');
  else
   match:=case when native.active then 'matched' else 'inactive' end;
   if not native.active then issues:=array_append(issues,'CONTACT_INACTIVE');end if;
   select version_hash into contact_hash from origin_sync.raw_record where entity='contacts' and source_id=cid;
   source_changed:=case when contact_hash is not null then origin.applied_hash is distinct from contact_hash end;
   pending:=origin.candidate is not null or origin.state<>'synced' or coalesce(source_changed,false);
   if pending then issues:=array_append(issues,'CONTACT_PENDING_REVIEW');end if;
   if native.human_edited then issues:=array_append(issues,'CONTACT_LOCALLY_EDITED');end if;
  end if;
 end if;
 contact:=jsonb_build_object('source_id',cid,'match',match,'record_id',native.id,'record_version',native.version::text,'name',native.name,
  'origin_state',case when native.id is not null then origin.state end,'human_edited',native.human_edited,'pending_review',pending,'source_changed_since_apply',source_changed);
 if r.last_seen_at<statement_timestamp()-interval '1 hour' then issues:=array_append(issues,'OBSERVATION_OLDER_THAN_ONE_HOUR');end if;
 if r.last_seen_at>statement_timestamp() then issues:=array_append(issues,'OBSERVATION_IN_FUTURE');end if;
 select * into refresh_origin from origin_finance_refresh.origin where entity=r.entity and source_id=r.source_id;
 if refresh_origin.current_attempt is not null then select * into attempt from origin_finance_refresh.attempt where id=refresh_origin.current_attempt and entity=r.entity and source_id=r.source_id;end if;
 -- Origin evidence can exist without a matching linked attempt. Do not infer that no attempt occurred,
 -- and never borrow an attempt from a different source merely because the simple FK accepts its UUID.
 refresh_state:=case when attempt.id is not null then attempt.state
  when refresh_origin.current_attempt is not null or refresh_origin.last_attempt_at is not null
   or refresh_origin.last_success_at is not null or refresh_origin.next_attempt_at is not null
   or refresh_origin.failures>0 or refresh_origin.last_error is not null then 'incomplete'
  else 'never_attempted' end;
 if refresh_state='incomplete' then issues:=array_append(issues,'REFRESH_EVIDENCE_INCOMPLETE');end if;
 if attempt.state='pending' then issues:=array_append(issues,'REFRESH_PENDING');
 elsif attempt.state='failed' then issues:=array_append(issues,'REFRESH_FAILED');
 elsif attempt.state='conflict' then issues:=array_append(issues,'REFRESH_CONFLICT');end if;
 result:=jsonb_build_object('entity',r.entity,'source_id',r.source_id,'source_version',r.version::text,'source_hash',r.version_hash,
  'observed_at',r.last_seen_at,'changed_at',r.changed_at,'status',status,
  'document_number',erp_cutover.financial_text(p->'numeroDocumento',200),'description',erp_cutover.financial_text(p->'historico',240),
  'issued_on',issued,'due_on',due,'original_due_on',original_due,'competence_on',competence,'amount',amount,'balance',balance,'contact',contact);
 if p_detail then
  refs:=jsonb_build_object('carrier_id',erp_cutover.exact_id(p#>'{portador,id}'),'payment_method_id',erp_cutover.exact_id(p#>'{formaPagamento,id}'),
   'category_id',erp_cutover.exact_id(p#>'{categoria,id}'),'accounting_id',erp_cutover.exact_id(p#>'{contaContabil,id}'));
  foreach field in array array['portador','formaPagamento','categoria','contaContabil'] loop
   v:=p->field;
   if v is not null and v<>'null'::jsonb and(jsonb_typeof(v)<>'object' or erp_cutover.exact_id(v->'id') is null) then issues:=array_append(issues,'REFERENCE_INVALID');end if;
  end loop;
  bank_number:=erp_cutover.financial_text(p->'numeroBanco',200);
  if p ? 'numeroBanco' and p->'numeroBanco'<>'null'::jsonb and(bank_number is null or length(p->>'numeroBanco')>200) then
   bank_number:=null;issues:=array_append(issues,'REFERENCE_INVALID');end if;
  raw_ids:=p->'borderos';
  if raw_ids is not null and raw_ids<>'null'::jsonb then
   if jsonb_typeof(raw_ids)<>'array' or jsonb_array_length(raw_ids)>100 then issues:=array_append(issues,'REFERENCE_INVALID');
   else
    for v in select value from jsonb_array_elements(raw_ids) loop
     if erp_cutover.exact_id(v) is null then issues:=array_append(issues,'REFERENCE_INVALID');else ids:=ids||jsonb_build_array(erp_cutover.exact_id(v));end if;
    end loop;
   end if;
  end if;
  if jsonb_typeof(p->'ocorrencia')='object' then
   part_kind:=erp_cutover.exact_id(p#>'{ocorrencia,tipo}');part_total:=erp_cutover.exact_id(p#>'{ocorrencia,numeroParcelas}');
   if(part_kind is not null and part_kind!~'^[0-9]{1,3}$')or(part_total is not null and part_total!~'^[0-9]{1,6}$')
    or(p#>'{ocorrencia,tipo}' is not null and p#>'{ocorrencia,tipo}'<>'null'::jsonb and part_kind is null)
    or(p#>'{ocorrencia,numeroParcelas}' is not null and p#>'{ocorrencia,numeroParcelas}'<>'null'::jsonb and part_total is null) then
    part_kind:=null;part_total:=null;issues:=array_append(issues,'REFERENCE_INVALID');end if;
  elsif p ? 'ocorrencia' and p->'ocorrencia'<>'null'::jsonb then issues:=array_append(issues,'REFERENCE_INVALID');end if;
  extra:=jsonb_build_object('id',erp_cutover.exact_id(p#>'{origem,id}'),'type',erp_cutover.financial_text(p#>'{origem,tipoOrigem}',100),'number',erp_cutover.financial_text(p#>'{origem,numero}',200));
  if p ? 'origem' and p->'origem'<>'null'::jsonb and(jsonb_typeof(p->'origem')<>'object'
   or(p#>'{origem,id}' is not null and p#>'{origem,id}'<>'null'::jsonb and extra->>'id' is null)
   or(p#>'{origem,tipoOrigem}' is not null and p#>'{origem,tipoOrigem}'<>'null'::jsonb and extra->>'type' is null)
   or(p#>'{origem,numero}' is not null and p#>'{origem,numero}'<>'null'::jsonb and extra->>'number' is null)
   or length(p#>>'{origem,tipoOrigem}')>100 or length(p#>>'{origem,numero}')>200) then issues:=array_append(issues,'REFERENCE_INVALID');end if;
  issues:=issues||array['BANK_MAPPING_NOT_ESTABLISHED','INSTALLMENT_LINKAGE_NOT_ESTABLISHED'];
  result:=result||jsonb_build_object('banking',refs||jsonb_build_object('bank_number',bank_number,'bordero_ids',ids,'bank_mapping','not_established'),
   'installments',jsonb_build_object('kind',part_kind,'total',part_total,'index',null,'group_id',null,'linkage','not_established'),'origin',extra,
   'refresh',jsonb_build_object('state',refresh_state,'last_attempt_at',refresh_origin.last_attempt_at,
    'last_success_at',refresh_origin.last_success_at,'last_finished_at',attempt.finished_at,'next_attempt_at',refresh_origin.next_attempt_at,
    'error_code',attempt.error_code,'http_status',attempt.http_status,
    'current_source_matches_result',case when attempt.state='stored' then attempt.result_hash=r.version_hash and attempt.result_version=r.version end));
 end if;
 return result||jsonb_build_object('issues',(select coalesce(jsonb_agg(jsonb_build_object('code',c,'level',erp_cutover.financial_issue_level(c)) order by c),'[]') from(select distinct unnest(issues)c)x));
end $$;

create function erp_cutover.financial_envelope() returns jsonb
language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('data_mode','financial_cutover_readonly','as_of',statement_timestamp(),'persisted',false,'import_enabled',false,
  'operational_effects',false,'reconciled',false,'cutoff_at',null,'coverage_certified',false)
$$;
create function public.erp_cutover_financial_list(p_user_id uuid,p_entity text,p_status text default 'open_partial',p_limit integer default 25,
 p_after text default null,p_query text default null,p_from date default null,p_to date default null) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare result jsonb;
begin
 perform erp_cutover.require_admin(p_user_id);
 if p_entity is null or p_entity not in('receivables','payables') or p_status is null or p_status not in('open_partial','all','unknown')
  or p_limit is null or p_limit not between 1 and 25 or(p_after is not null and(length(p_after) not between 1 and 200 or p_after~'[[:cntrl:]]'))
  or(p_query is not null and(length(p_query)>100 or p_query~'[[:cntrl:]]'))
  or(p_from is not null and(not isfinite(p_from) or p_from<date '1900-01-01' or p_from>date '2099-12-31'))
  or(p_to is not null and(not isfinite(p_to) or p_to<date '1900-01-01' or p_to>date '2099-12-31')) or p_from>p_to then
  raise exception 'erp_invalid_query' using errcode='22023';end if;
 with candidates as materialized(
  select r.* from origin_sync.raw_record r where r.entity=p_entity
   and(p_after is null or r.source_id collate "C">p_after collate "C")
   and(p_status='all' or(p_status='open_partial' and erp_cutover.financial_status(r.payload)->>'scope' in('open','partial'))
    or(p_status='unknown' and erp_cutover.financial_status(r.payload)->>'scope'='unknown'))
   and(nullif(p_query,'') is null or strpos(r.source_id,p_query)>0 or strpos(erp_cutover.financial_text(r.payload->'numeroDocumento',200),p_query)>0)
   and(p_from is null or erp_cutover.financial_date(r.payload->'vencimento')>=p_from)
   and(p_to is null or erp_cutover.financial_date(r.payload->'vencimento')<=p_to)
  order by r.source_id collate "C" limit p_limit+1
 ), page as materialized(select r.source_id,erp_cutover.financial_row(r,false) item from candidates r order by r.source_id collate "C" limit p_limit)
 select erp_cutover.financial_envelope()||jsonb_build_object('entity',p_entity,'status',p_status,'limit',p_limit,'q',p_query,'from',p_from,'to',p_to,
  'items',coalesce((select jsonb_agg(item order by source_id collate "C") from page),'[]'),
  'has_more',(select count(*) from candidates)>p_limit,'next_cursor',case when(select count(*) from candidates)>p_limit then(select source_id from page order by source_id collate "C" desc limit 1) end,
  'page_totals',(select jsonb_build_object('amount_cents',coalesce(sum((item#>>'{amount,cents}')::numeric),0)::text,
   'balance_cents',coalesce(sum((item#>>'{balance,cents}')::numeric),0)::text,
   'amount_available_count',count(*) filter(where item#>>'{amount,state}'='available'),
   'balance_available_count',count(*) filter(where item#>>'{balance,state}'='available'),
   'amount_unavailable_count',count(*) filter(where item#>>'{amount,state}'<>'available'),
   'balance_unavailable_count',count(*) filter(where item#>>'{balance,state}'<>'available'),'scope','current_page_only') from page)) into result;
 return result;
end $$;
create function public.erp_cutover_financial_get(p_user_id uuid,p_entity text,p_source_id text) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare r origin_sync.raw_record%rowtype;
begin
 perform erp_cutover.require_admin(p_user_id);
 if p_entity is null or p_entity not in('receivables','payables') or p_source_id is null or length(p_source_id) not between 1 and 200 or p_source_id~'[[:cntrl:]]' then raise exception 'erp_invalid_query' using errcode='22023';end if;
 select * into r from origin_sync.raw_record where entity=p_entity and source_id=p_source_id;
 if not found then raise exception 'erp_cutover_source_not_found' using errcode='P0002';end if;
 return erp_cutover.financial_envelope()||jsonb_build_object('record',erp_cutover.financial_row(r,true));
end $$;
revoke all on all functions in schema erp_cutover from public,anon,authenticated,service_role;
revoke all on function public.erp_cutover_financial_list(uuid,text,text,integer,text,text,date,date),public.erp_cutover_financial_get(uuid,text,text) from public,anon,authenticated;
grant execute on function public.erp_cutover_financial_list(uuid,text,text,integer,text,text,date,date),public.erp_cutover_financial_get(uuid,text,text) to service_role;
commit;
