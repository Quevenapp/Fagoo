-- Read-only list projection. Draft state, reservation and captured responses remain separate.
-- No Storage, current A1/policy gate, send, mutation or replacement of an earlier contract.
begin;
create function erp_fiscal_drafts.status_result(e jsonb,response_hash text,response_size integer,processed_hash text,processed_size integer,recorded_at timestamptz)
returns jsonb language sql immutable set search_path=pg_catalog as $$
 select jsonb_build_object('response_hash',response_hash,'response_size',response_size,'processed_hash',processed_hash,'processed_size',processed_size,
  'cstat',e->'cstat','protocol_cstat',e->'protocol_cstat','protocol_number',e->'protocol_number','received_at',e->'received_at','rejection_code',e->'rejection_code','recorded_at',recorded_at)
$$;
create function erp_fiscal_drafts.status_row(actor uuid,p_draft_id uuid)
returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare d jsonb;r erp_fiscal_numbering.reservation;i erp_fiscal_authorization.intent;a erp_fiscal_authorization.attempt;
 c erp_fiscal_signed.candidate;j erp_fiscal_unsigned.job;sa erp_fiscal_signed.artifact;p erp_fiscal_authorization.policy;
 cmd erp_fiscal_authorization.command;req erp_fiscal_authorization.request;res erp_fiscal_authorization.result;
 b erp_fiscal_reviewed_authorization.review_binding;o erp_fiscal_reviewed_authorization.observation;rv erp_fiscal_authorization_revalidation.command;
 base jsonb;numbering jsonb;auth jsonb;review jsonb:=null;result jsonb:=null;revalidated jsonb;basis jsonb;source jsonb;completion jsonb;ctx jsonb;
 selected text;differences jsonb:='[]';latest_job boolean;latest_candidate boolean;v jsonb;tag text;rv_count integer;historical_hashes jsonb;
begin
 d:=erp_fiscal_drafts.record(p_draft_id);
 if d is null then raise exception 'fiscal_status_not_found'using errcode='P0002';end if;
 base:=jsonb_build_object('draft',erp_fiscal_drafts.summary(d));
 numbering:=jsonb_build_object('visibility','none','reservation',null);
 auth:=jsonb_build_object('visibility','none','selection',null,'original',null,'revalidation',jsonb_build_object('visibility','none','result',null),'basis',null);
 select *into r from erp_fiscal_numbering.reservation x where x.draft_id=p_draft_id;
 if r.id is null then return base||jsonb_build_object('numbering',numbering,'authorization',auth);end if;
 -- The old draft may be visible while fiscal metadata belongs to a different issuer.
 if r.issuer_cnpj is distinct from(select data->>'cnpj'from erp_company.identity where singleton)then
  return base||jsonb_build_object('numbering',jsonb_build_object('visibility','restricted','reservation',null),
   'authorization',auth||jsonb_build_object('visibility','restricted','revalidation',jsonb_build_object('visibility','restricted','result',null)));
 end if;
 if r.model is distinct from d->>'model' or r.environment is distinct from d->>'environment' or r.source_document_id::text is distinct from d->>'source_document_id' then
  return base||jsonb_build_object('numbering',jsonb_build_object('visibility','inconsistent','reservation',null),'authorization',auth||jsonb_build_object('visibility','inconsistent'));
 end if;
 numbering:=jsonb_build_object('visibility','available','reservation',jsonb_build_object('reservation_id',r.id,'series',r.series,'number',r.number,'draft_version',r.draft_version,'reserved_at',r.reserved_at));
 begin
  select *into i from erp_fiscal_authorization.intent where reservation_id=r.id;
  if i.id is null then return base||jsonb_build_object('numbering',numbering,'authorization',auth);end if;
  if i.issuer_cnpj is distinct from r.issuer_cnpj or i.model is distinct from r.model then raise exception'fiscal_status_binding'using errcode='40001';end if;
  selected:=case when i.consumed_attempt_id is not null then 'consumed'else 'active'end;
  select *into a from erp_fiscal_authorization.attempt where id=coalesce(i.consumed_attempt_id,i.active_attempt_id);
  if a.id is null or a.intent_id<>i.id or a.model<>r.model or(selected='consumed')is distinct from(a.used_at is not null)
   or i.active_attempt_id is distinct from a.id then raise exception'fiscal_status_binding'using errcode='40001';end if;
  select *into c from erp_fiscal_signed.candidate where id=a.candidate_id;
  select *into j from erp_fiscal_unsigned.job where id=c.unsigned_job_id;
  select *into sa from erp_fiscal_signed.artifact where candidate_id=c.id;
  select *into cmd from erp_fiscal_authorization.command where id=a.command_id;
  select *into p from erp_fiscal_authorization.policy where model=a.model and version=a.policy_version;
  if c.id is null or c.state<>'stored' or j.id is null or j.state<>'stored' or j.reservation_id<>r.id or j.draft_id<>r.draft_id
   or c.basis_hash<>j.basis_hash or sa.candidate_id is null or sa.signed_hash<>a.signed_hash or sa.size_bytes<>a.signed_size
   or cmd.id is null or cmd.attempt_id<>a.id or cmd.actor<>a.actor or cmd.receipt->>'attempt_id'is distinct from a.id::text
   or cmd.receipt->>'candidate_id'is distinct from c.id::text or cmd.receipt->>'candidate_version'is distinct from c.version::text
   or cmd.receipt->>'signed_hash'is distinct from a.signed_hash or p.model is null
   or i.access_key is distinct from(select access_key from erp_fiscal_unsigned.identity where reservation_id=r.id)
  then raise exception'fiscal_status_binding'using errcode='40001';end if;
  if p.authorization_profile not in('legacy_v1','reviewed_subset_v1')then
   return base||jsonb_build_object('numbering',numbering,'authorization',auth||jsonb_build_object('visibility','unsupported'));
  end if;
  source:=erp_fiscal_authorization.source(actor,c.id,a.signed_hash);
  if cmd.receipt is distinct from(source-array['issuer_cnpj','access_key','reference_digest'])||jsonb_build_object('attempt_id',a.id,'intent_id',i.id,'ordinal',a.ordinal::text,'command_id',a.command_id,
   'batch_id',a.ordinal::text,'environment','2','origin',p.origin,'policy_version',p.version,'identity_version',a.identity_version,'a1_version',a.a1_version,'created_at',a.created_at)
   or a.reference_digest is distinct from source->>'reference_digest'
   or a.certificate_fingerprint is distinct from c.certificate_fingerprint or a.credential_id is distinct from c.credential_id
   or a.envelope_hash is distinct from c.envelope_hash or a.a1_version is distinct from c.a1_version
  then raise exception'fiscal_status_receipt_binding'using errcode='40001';end if;
  select record into completion from erp_fiscal_completion.revision where draft_id=r.draft_id and version=j.completion_version;
  select jsonb_build_object('draft_record_hash',erp_fiscal_unsigned.hash(dr.record),'item_record_hash',erp_fiscal_unsigned.hash(ir.record),
   'tax_record_hash',erp_fiscal_unsigned.hash(tr.record),'completion_record_hash',j.completion_hash)into historical_hashes
   from erp_fiscal_drafts.revision dr join erp_fiscal_items.revision ir on ir.draft_id=dr.draft_id and ir.version=r.item_preparation_version
   join erp_fiscal_tax.revision tr on tr.draft_id=dr.draft_id and tr.version=r.tax_preparation_version where dr.draft_id=r.draft_id and dr.version=r.draft_version;
  if completion is null or erp_fiscal_unsigned.hash(completion)<>j.completion_hash
   or historical_hashes is null or j.proofs->'basis_hashes'is distinct from historical_hashes
   or(j.proofs-array['builder_version','basis_hashes','completion_hash','completion_version'])is distinct from(completion-array['item_basis','completion','pending','created_at','version'])
   or j.proofs->>'draft_id'is distinct from r.draft_id::text or j.proofs->>'draft_version'is distinct from r.draft_version::text
   or j.proofs->>'snapshot_hash'is distinct from r.snapshot_hash
   or j.proofs->>'item_preparation_version'is distinct from r.item_preparation_version::text
   or j.proofs->>'tax_preparation_version'is distinct from r.tax_preparation_version::text
   or j.proofs->>'source_document_id'is distinct from r.source_document_id::text
   or j.proofs->>'source_document_version'is distinct from r.source_document_version::text
  then raise exception'fiscal_status_basis'using errcode='40001';end if;
  ctx:=erp_fiscal_completion.context(r.draft_id,completion);
  latest_job:=not exists(select 1 from erp_fiscal_unsigned.job where reservation_id=r.id and version>j.version);
  latest_candidate:=not exists(select 1 from erp_fiscal_signed.candidate where unsigned_job_id=j.id and version>c.version);
  if ctx->'matches_current_draft'is distinct from'true'::jsonb then differences:=differences||'"DRAFT_CHANGED"'::jsonb;end if;
  if ctx->'matches_current_item_preparation'is distinct from'true'::jsonb then differences:=differences||'"ITEM_PREPARATION_CHANGED"'::jsonb;end if;
  if ctx->'matches_current_tax_preparation'is distinct from'true'::jsonb then differences:=differences||'"TAX_PREPARATION_CHANGED"'::jsonb;end if;
  if ctx->>'completion_version'is distinct from j.completion_version::text then differences:=differences||'"COMPLETION_CHANGED"'::jsonb;end if;
  if ctx->'matches_current_company'is distinct from'true'::jsonb then differences:=differences||'"COMPANY_CHANGED"'::jsonb;end if;
  if ctx->'source_changed'is distinct from'false'::jsonb or ctx->>'source_document_version'is distinct from r.source_document_version::text then differences:=differences||'"SOURCE_CHANGED"'::jsonb;end if;
  if ctx->>'source_status'='cancelled'then differences:=differences||'"SOURCE_CANCELLED"'::jsonb;end if;
  if ctx->>'draft_status'='archived'then differences:=differences||'"DRAFT_ARCHIVED"'::jsonb;end if;
  if not latest_job then differences:=differences||'"NEWER_XML_JOB"'::jsonb;end if;
  if not latest_candidate then differences:=differences||'"NEWER_SIGNED_CANDIDATE"'::jsonb;end if;
  basis:=jsonb_build_object('draft_version',r.draft_version,'source_document_version',r.source_document_version,'item_preparation_version',r.item_preparation_version,
   'tax_preparation_version',r.tax_preparation_version,'completion_version',j.completion_version,'company_identity_version',r.company_identity_version,'company_fiscal_version',r.company_fiscal_version,
   'is_latest_job',latest_job,'is_latest_candidate',latest_candidate,'matches_current_preparation',jsonb_array_length(differences)=0,'differences',differences);
  select *into b from erp_fiscal_reviewed_authorization.review_binding where attempt_id=a.id;
  if p.authorization_profile='reviewed_subset_v1'then
   -- A legacy begin069 without prepare may have no review yet; never invent one.
   if b.attempt_id is not null then
    perform erp_fiscal_reviewed_authorization.check_review(a,b.proof,false);
    review:=erp_fiscal_drafts.pick(b.proof,array['review_id','review_version','profile','profile_hash','review_hash']);
   elsif a.state<>'prepared'and a.state<>'failed_before_dispatch'then raise exception'fiscal_status_review_missing'using errcode='40001';end if;
  elsif b.attempt_id is not null then raise exception'fiscal_status_profile_binding'using errcode='40001';end if;
  select *into res from erp_fiscal_authorization.result where attempt_id=a.id;
  select *into req from erp_fiscal_authorization.request where attempt_id=a.id;
  if res.attempt_id is not null then
   if a.used_at is null or a.finished_at is null or req.attempt_id is null
    or erp_fiscal_authorization.result_state(a,res.evidence,res.response_hash,res.processed_hash)is distinct from a.state
    or a.finalize_hash is distinct from erp_fiscal_wsdl.hash(jsonb_build_object('response_hash',res.response_hash,'response_size',res.response_size,'evidence',res.evidence,'processed_hash',res.processed_hash,'processed_size',res.processed_size))
   then raise exception'fiscal_status_result_binding'using errcode='40001';end if;
   if p.authorization_profile='reviewed_subset_v1'then
    select *into o from erp_fiscal_reviewed_authorization.observation where attempt_id=a.id;
    tag:=erp_fiscal_wsdl.hash(jsonb_build_object('request_hash',req.sha256,'response_hash',res.response_hash,'response_size',res.response_size,'evidence',res.evidence,
     'processed_hash',res.processed_hash,'processed_size',res.processed_size,'rule_review',b.proof,'observation_hash',o.sha256,'observation_size',o.size_bytes));
    if o.attempt_id is null or o.origin<>p.origin or o.request_hash<>req.sha256 or o.response_hash<>res.response_hash
     or o.review_hash is distinct from b.proof->>'review_hash' or o.finalize_hash<>tag
     or(p.origin='operational'and(res.evidence->>'transport_hash'is distinct from o.sha256 or res.evidence->>'transport_size'is distinct from o.size_bytes::text))
    then raise exception'fiscal_status_observation_binding'using errcode='40001';end if;
   end if;
   result:=erp_fiscal_drafts.status_result(res.evidence,res.response_hash,res.response_size,res.processed_hash,res.processed_size,res.created_at);
  elsif a.state in('receipt_pending','rejected','review_required','authorization_observed','authorized_homologation')then raise exception'fiscal_status_result_missing'using errcode='40001';end if;
  auth:=jsonb_build_object('visibility','available','selection',selected,'original',jsonb_build_object(
   'command_id',a.command_id,'attempt_id',a.id,'candidate_id',c.id,'candidate_version',c.version,'signed_hash',a.signed_hash,'origin',p.origin,
   'authorization_profile',p.authorization_profile,'policy_version',p.version,'state',a.state,'created_at',a.created_at,'used_at',a.used_at,'finished_at',a.finished_at,
   'error_code',a.error_code,'rule_review',review,'result',result),'basis',basis);
  -- Non-owners receive no existence oracle for079, even when no receipt is present.
  revalidated:=jsonb_build_object('visibility',case when a.actor=actor then 'none'else 'restricted'end,'result',null);
  if a.actor=actor then
   begin
    select count(*)into rv_count from erp_fiscal_authorization_revalidation.command where attempt_id=a.id;
    if rv_count>0 then
     select *into rv from erp_fiscal_authorization_revalidation.command where attempt_id=a.id order by created_at,id limit 1;
     if rv_count<>1 or rv.parser_profile<>'authorization-stored-response-utf8-v1'
      or rv.parser_manifest_hash<>'26a4ba4dcc9dbad2e196ae76136fbe8465f5dd235ca7aa30c468c192a8cce033' then
      revalidated:=jsonb_build_object('visibility','unsupported','result',null);
     else
      source:=erp_fiscal_authorization_revalidation.source(actor,a.command_id,a.id);v:=rv.receipt;
      if rv.actor<>actor or rv.source is distinct from source or rv.source_hash<>erp_fiscal_wsdl.hash(source)
       or v->>'command_id'is distinct from rv.id::text or v->>'authorization_command_id'is distinct from a.command_id::text
       or v->>'attempt_id'is distinct from a.id::text or v->>'candidate_id'is distinct from c.id::text or v->>'candidate_version'is distinct from c.version::text
       or v->>'signed_hash'is distinct from a.signed_hash or v->>'model'is distinct from a.model or v->>'origin'is distinct from'operational'
       or v->>'source_hash'is distinct from rv.source_hash or v->>'parser_profile'is distinct from rv.parser_profile or v->>'parser_manifest_hash'is distinct from rv.parser_manifest_hash
       or v->>'original_state'is distinct from'review_required' or v->'tax_rules_validated'is distinct from'false'::jsonb
       or(v->>'created_at')::timestamptz is distinct from rv.created_at
       or v->'evidence'->>'transport_hash'is distinct from o.sha256 or v->'evidence'->>'transport_size'is distinct from o.size_bytes::text
       or erp_fiscal_authorization.result_state(a,v->'evidence',res.response_hash,v->>'processed_hash')is distinct from v->>'state'
       or(v->>'processed_hash'is null)is distinct from(v->>'processed_size'is null)
       or(v->>'processed_hash'is not null and(v->>'processed_hash'!~'^[a-f0-9]{64}$'or(v->>'processed_size')::integer not between 1 and 512000))
      then raise exception'fiscal_status_revalidation_binding'using errcode='40001';end if;
      tag:=erp_fiscal_wsdl.hash(jsonb_build_object('actor',actor,'authorization_command_id',a.command_id,'attempt_id',a.id,'source_hash',rv.source_hash,
       'parser_profile',rv.parser_profile,'parser_manifest_hash',rv.parser_manifest_hash,'evidence',v->'evidence','processed_hash',v->>'processed_hash','processed_size',(v->>'processed_size')::integer,'confirmed',true));
      if tag<>rv.request_hash then raise exception'fiscal_status_revalidation_receipt'using errcode='40001';end if;
      revalidated:=jsonb_build_object('visibility','available','result',erp_fiscal_drafts.status_result(v->'evidence',res.response_hash,res.response_size,v->>'processed_hash',(v->>'processed_size')::integer,rv.created_at)
       ||jsonb_build_object('command_id',rv.id,'parser_profile',rv.parser_profile,'parser_manifest_hash',rv.parser_manifest_hash,'source_hash',rv.source_hash,'state',v->'state'));
     end if;
    end if;
   exception when data_exception or sqlstate '40001' or sqlstate '55000' or sqlstate 'P0002'then revalidated:=jsonb_build_object('visibility','inconsistent','result',null);
   end;
  end if;
  auth:=auth||jsonb_build_object('revalidation',revalidated);
 exception when insufficient_privilege then
  auth:=jsonb_build_object('visibility','restricted','selection',null,'original',null,'revalidation',jsonb_build_object('visibility','restricted','result',null),'basis',null);
 when data_exception or sqlstate '40001' or sqlstate '55000' or sqlstate 'P0002'then
  auth:=jsonb_build_object('visibility','inconsistent','selection',null,'original',null,'revalidation',jsonb_build_object('visibility','none','result',null),'basis',null);
 end;
 return base||jsonb_build_object('numbering',numbering,'authorization',auth);
end$$;
create function public.erp_fiscal_draft_status_list(p_user_id uuid,p_model text default null,p_status text default null,p_source_document_id uuid default null,p_limit integer default 25,p_after uuid default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare rows jsonb;more boolean;output jsonb;
begin
 perform erp_fiscal_drafts.require_access(p_user_id);
 if(p_model is not null and p_model not in('55','65'))or(p_status is not null and p_status not in('draft','archived'))or p_limit is null or p_limit not between 1 and 25 then raise exception'fiscal_status_query_invalid'using errcode='22023';end if;
 with selected as materialized(select id from erp_fiscal_drafts.draft where(p_model is null or model=p_model)and(p_status is null or status=p_status)
  and(p_source_document_id is null or source_document_id=p_source_document_id)and(p_after is null or id>p_after)order by id limit p_limit+1),
 page as(select id from selected order by id limit p_limit)
 select coalesce((select jsonb_agg(erp_fiscal_drafts.status_row(p_user_id,id)order by id)from page),'[]'::jsonb),(select count(*)>p_limit from selected)into rows,more;
 output:=jsonb_build_object('profile','fiscal-draft-status-v1','read_only',true,'observed_at',statement_timestamp(),'can_emit',false,'can_transmit',false,'operational_effects',false,
  'items',rows,'limit',p_limit,'has_more',more,'next_cursor',case when more then rows->-1->'draft'->>'id'end);
 if octet_length(output::text)>262144 then raise exception'fiscal_status_response_limit'using errcode='54000';end if;
 return output;
end$$;
revoke all on function erp_fiscal_drafts.status_result(jsonb,text,integer,text,integer,timestamptz),erp_fiscal_drafts.status_row(uuid,uuid)from public,anon,authenticated,service_role;
revoke all on function public.erp_fiscal_draft_status_list(uuid,text,text,uuid,integer,uuid)from public,anon,authenticated,service_role;
grant execute on function public.erp_fiscal_draft_status_list(uuid,text,text,uuid,integer,uuid)to service_role;
commit;
