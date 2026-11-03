-- Read-only input for an explicitly nonpayable Itaú109 print specimen.
-- No counter, reservation, title, settlement, command or Storage write.
begin;

create function public.erp_cnab_itau_boleto_context(p_user_id uuid,p_billing_title_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare
 b erp_cnab.billing_title; r erp_cnab.remittance; p erp_cnab.profile;
 t erp_finance.title; c erp_catalog.record; company erp_company.identity;
 selected_title jsonb; selected_manifest jsonb; approval jsonb; result jsonb; n integer;
begin
 perform erp_cnab.access(p_user_id);
 if p_billing_title_id is null then raise exception 'erp_boleto_preview_id_required' using errcode='22023'; end if;
 select * into b from erp_cnab.billing_title where id=p_billing_title_id;
 if not found then raise exception 'erp_boleto_preview_not_found' using errcode='P0002'; end if;
 select * into r from erp_cnab.remittance where id=b.remittance_id and profile_id=b.profile_id;
 select * into p from erp_cnab.profile where id=b.profile_id;
 if r.id is null or p.id is null or r.state<>'ready' then
  raise exception 'erp_boleto_preview_remittance_not_ready' using errcode='40001'; end if;
 if p.identity->>'bank' is distinct from '341' or p.identity->>'wallet' is distinct from '109'
  or p.identity->>'layout' is distinct from 'itau-cnab400-2017-01' then
  raise exception 'erp_boleto_preview_profile_unsupported' using errcode='0A000'; end if;
 if r.purpose not in('homologation','operational') or r.snapshot->>'purpose' is distinct from r.purpose
  or r.snapshot->'profile' is distinct from erp_cnab.core_profile(p.id)
  or r.snapshot->>'generatedOn' is distinct from r.generated_on::text
  or r.snapshot->>'remittanceSequence' is distinct from r.sequence::text
  or p.settings->'contractVerified' is distinct from 'true'::jsonb
  or p.settings->'simpleCollectionPolicyVerified' is distinct from 'true'::jsonb
  or not exists(select 1 from erp_finance.account where id=p.account_id and active and kind='bank') then
  raise exception 'erp_boleto_preview_profile_changed' using errcode='40001'; end if;
 if r.purpose='operational' then
  approval:=erp_cnab.require_operational(p.id);
  perform erp_cnab.operational_snapshot_check(r.id);
 end if;
 perform erp_cnab.storage_check(r.profile_id,'remittances',r.file_hash,r.byte_size,r.object_path);
 if jsonb_typeof(r.snapshot->'titles') is distinct from 'array' or jsonb_array_length(r.snapshot->'titles') not between 1 and 30
  or jsonb_typeof(r.manifest) is distinct from 'array' or jsonb_array_length(r.manifest)<>jsonb_array_length(r.snapshot->'titles') then
  raise exception 'erp_boleto_preview_snapshot_invalid' using errcode='40001'; end if;
 select count(*) into n from jsonb_array_elements(r.snapshot->'titles') x where x->>'id'=b.id::text;
 if n<>1 then raise exception 'erp_boleto_preview_title_binding_invalid' using errcode='40001'; end if;
 select x into selected_title from jsonb_array_elements(r.snapshot->'titles') x where x->>'id'=b.id::text;
 select count(*) into n from jsonb_array_elements(r.manifest) x where x->>'titleId'=b.id::text;
 if n<>1 then raise exception 'erp_boleto_preview_manifest_invalid' using errcode='40001'; end if;
 select x into selected_manifest from jsonb_array_elements(r.manifest) x where x->>'titleId'=b.id::text;
 if selected_title is distinct from b.snapshot->'title' or b.snapshot->>'finance_title_id' is distinct from b.title_id::text
  or selected_title->>'control' is distinct from b.control or selected_title->>'documentNumber' is distinct from b.document_number
  or selected_title->>'ourNumber' is distinct from b.our_number_base
  or b.our_number_base is null or b.our_number_base!~'^[0-9]{8}$' or b.our_number_base='00000000'
  or b.our_number is null or b.our_number!~'^[0-9]{9}$' or left(b.our_number,8)<>b.our_number_base
  or selected_manifest->>'control' is distinct from b.control or selected_manifest->>'documentNumber' is distinct from b.document_number
  or selected_manifest->>'ourNumber' is distinct from b.our_number
  or selected_manifest->>'amountCents' is distinct from selected_title->>'amountCents'
  or selected_manifest->>'dueDate' is distinct from selected_title->>'dueOn' then
  raise exception 'erp_boleto_preview_snapshot_binding_invalid' using errcode='40001'; end if;
 -- Barcode44 has ten amount positions, even though the CNAB detail has thirteen.
 if jsonb_typeof(selected_title->'amountCents') is distinct from 'string'
  or selected_title->>'amountCents'!~'^[1-9][0-9]{0,9}$'
  or b.document_number!~'^[A-Za-z0-9./-]{1,10}$'
  or exists(select 1 from jsonb_array_elements(r.snapshot->'titles') x where x ? 'collectionTerms') then
  raise exception 'erp_boleto_preview_print_profile_unsupported' using errcode='0A000'; end if;
 select * into t from erp_finance.title where id=b.title_id;
 select * into c from erp_catalog.record where id=t.contact_id;
 if t.id is null or c.id is null or not c.active or t.kind<>'receivable' or t.cancelled or t.settled_cents<>0
  or b.snapshot->>'finance_title_version' is distinct from t.version::text
  or b.snapshot->>'contact_version' is distinct from c.version::text
  or selected_title->>'amountCents' is distinct from t.amount_cents::text
  or selected_title->>'issuedOn' is distinct from t.issued_on::text or selected_title->>'dueOn' is distinct from t.due_on::text then
  raise exception 'erp_boleto_preview_native_context_changed' using errcode='40001'; end if;
 select * into company from erp_company.identity where singleton;
 if company.version is null or company.data->>'cnpj' is distinct from p.identity->>'cnpj' then
  raise exception 'erp_boleto_preview_beneficiary_identity_mismatch' using errcode='40001'; end if;
 -- Address016 was not captured in014. Identify this current supplemental source;
 -- do not claim that it was part of the historical remittance or change either.
 result:=jsonb_build_object(
  'profile','itau109-persisted-print-preview-v1','private_context',true,
  'billing_title_id',b.id,'remittance_id',r.id,'profile_id',p.id,'finance_title_id',t.id,
  'source_purpose',r.purpose,'state','ready','snapshot',r.snapshot,'billing_snapshot',b.snapshot,
  'manifest',r.manifest,'our_number',b.our_number,
  'snapshot_hash',encode(sha256(convert_to(r.snapshot::text,'UTF8')),'hex'),
  'file',jsonb_build_object('bucket','brufap-cnab','path',r.object_path,'hash',r.file_hash,'size',r.byte_size),
  'beneficiary',jsonb_build_object('identity_version',company.version,'cnpj',company.data->>'cnpj',
    'address_source','company_identity_current',
    'address',jsonb_build_object('address',concat_ws(' ',nullif(company.data->>'street',''),nullif(company.data->>'number',''),nullif(company.data->>'complement','')),
      'neighborhood',company.data->>'district','city',company.data->>'city','state',company.data->>'state','postalCode',company.data->>'postal_code')),
  'current',jsonb_build_object('title_version',t.version,'contact_version',c.version,'profile_version',p.version,
    'approval_version',approval->'approval_version','company_identity_version',company.version,
    'title_status','open','title_cancelled',false,'settled_cents','0'),
  'read_only',true,'can_pay',false,'can_issue',false,'can_transmit',false,'financial_mutation_performed',false
 );
 return result||jsonb_build_object('context_hash',encode(sha256(convert_to(result::text,'UTF8')),'hex'));
end $$;
revoke all on function public.erp_cnab_itau_boleto_context(uuid,uuid) from public,anon,authenticated;
grant execute on function public.erp_cnab_itau_boleto_context(uuid,uuid) to service_role;

-- Discovery only: listing a local reservation does not certify eligibility to print.
create function public.erp_cnab_itau_boleto_items(p_user_id uuid,p_remittance_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare r erp_cnab.remittance; p erp_cnab.profile; items jsonb; n integer;
begin
 perform erp_cnab.access(p_user_id);
 if p_remittance_id is null then raise exception 'erp_boleto_preview_id_required' using errcode='22023'; end if;
 select * into r from erp_cnab.remittance where id=p_remittance_id;
 if not found then raise exception 'erp_boleto_preview_not_found' using errcode='P0002'; end if;
 select * into p from erp_cnab.profile where id=r.profile_id;
 if r.state<>'ready' or r.file_hash is null or r.file_hash!~'^[a-f0-9]{64}$' then
  raise exception 'erp_boleto_preview_remittance_not_ready' using errcode='40001'; end if;
 if p.identity->>'bank' is distinct from '341' or p.identity->>'wallet' is distinct from '109'
  or p.identity->>'layout' is distinct from 'itau-cnab400-2017-01' then
  raise exception 'erp_boleto_preview_profile_unsupported' using errcode='0A000'; end if;
 select count(*) into n from erp_cnab.billing_title where remittance_id=r.id;
 if n not between 1 and 30 or jsonb_typeof(r.snapshot->'titles') is distinct from 'array'
  or n<>jsonb_array_length(r.snapshot->'titles') or exists(
   select 1 from erp_cnab.billing_title b where b.remittance_id=r.id and
   (b.profile_id<>r.profile_id or b.snapshot->'title'->>'id' is distinct from b.id::text
    or b.snapshot->>'finance_title_id' is distinct from b.title_id::text
    or b.snapshot->'title'->>'documentNumber' is distinct from b.document_number
    or jsonb_typeof(b.snapshot->'title'->'amountCents') is distinct from 'string'
    or b.snapshot->'title'->>'amountCents'!~'^[1-9][0-9]{0,12}$'
    or jsonb_typeof(b.snapshot->'title'->'dueOn') is distinct from 'string')) then
  raise exception 'erp_boleto_preview_snapshot_binding_invalid' using errcode='40001'; end if;
 select jsonb_agg(jsonb_build_object('billing_title_id',b.id,'finance_title_id',b.title_id,
  'document_number',b.document_number,'amount_cents',b.snapshot->'title'->>'amountCents',
  'due_on',b.snapshot->'title'->>'dueOn')order by b.id) into items
 from erp_cnab.billing_title b where b.remittance_id=r.id;
 return jsonb_build_object('data_mode','itau_boleto_items_readonly','read_only',true,'can_pay',false,
  'remittance_id',r.id,'profile_id',p.id,'source_purpose',r.purpose,'state','ready',
  'remittance_hash',r.file_hash,'items',items);
end $$;
revoke all on function public.erp_cnab_itau_boleto_items(uuid,uuid) from public,anon,authenticated;
grant execute on function public.erp_cnab_itau_boleto_items(uuid,uuid) to service_role;
commit;
