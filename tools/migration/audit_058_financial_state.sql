-- Read-only comparison of persistent business rows before/after migration058.
-- This file performs no RPC, mutation, bank request or temporary object creation.
-- Run in an authorized SQL session; save the aggregate JSON privately. No row IDs,
-- names, account numbers, customer data, balances or per-row hashes are returned.
-- All 31 relations exist before058. The new cnab_cash_plan is deliberately absent:
-- its creation changes schema, while this audit detects unintended changes to
-- existing business rows. Compare content_sha256 and row_count per relation and
-- state_sha256 overall; observed_at is informational and excluded from hashes.
-- A legitimate concurrent business write also changes the digest: compare during
-- a coordinated quiet window. Hashes are a change detector, not an authorization.
-- Row hashes cover every stored column (including JSON); sorted fixed-width hashes
-- preserve multiplicity without requiring a public key or leaking row ordering.
-- UTC/ISO settings stabilize timestamp serialization on the same PostgreSQL server.

begin transaction isolation level repeatable read read only;
set local time zone 'UTC';
set local datestyle = 'ISO, YMD';
set local statement_timeout = '30s';
set local lock_timeout = '2s';

with relation_state as (
  select 'erp_finance.account'::text as relation, count(*)::bigint as row_count,
    encode(sha256(convert_to(coalesce(string_agg(row_hash, '' order by row_hash collate "C"), ''), 'UTF8')), 'hex') as content_sha256
  from (select encode(sha256(convert_to(to_jsonb(r)::text, 'UTF8')), 'hex') as row_hash from erp_finance.account r) rows_hashed
  union all
  select 'erp_finance.category'::text as relation, count(*)::bigint as row_count,
    encode(sha256(convert_to(coalesce(string_agg(row_hash, '' order by row_hash collate "C"), ''), 'UTF8')), 'hex') as content_sha256
  from (select encode(sha256(convert_to(to_jsonb(r)::text, 'UTF8')), 'hex') as row_hash from erp_finance.category r) rows_hashed
  union all
  select 'erp_finance.title'::text as relation, count(*)::bigint as row_count,
    encode(sha256(convert_to(coalesce(string_agg(row_hash, '' order by row_hash collate "C"), ''), 'UTF8')), 'hex') as content_sha256
  from (select encode(sha256(convert_to(to_jsonb(r)::text, 'UTF8')), 'hex') as row_hash from erp_finance.title r) rows_hashed
  union all
  select 'erp_finance.settlement'::text as relation, count(*)::bigint as row_count,
    encode(sha256(convert_to(coalesce(string_agg(row_hash, '' order by row_hash collate "C"), ''), 'UTF8')), 'hex') as content_sha256
  from (select encode(sha256(convert_to(to_jsonb(r)::text, 'UTF8')), 'hex') as row_hash from erp_finance.settlement r) rows_hashed
  union all
  select 'erp_finance.movement'::text as relation, count(*)::bigint as row_count,
    encode(sha256(convert_to(coalesce(string_agg(row_hash, '' order by row_hash collate "C"), ''), 'UTF8')), 'hex') as content_sha256
  from (select encode(sha256(convert_to(to_jsonb(r)::text, 'UTF8')), 'hex') as row_hash from erp_finance.movement r) rows_hashed
  union all
  select 'erp_finance.command'::text as relation, count(*)::bigint as row_count,
    encode(sha256(convert_to(coalesce(string_agg(row_hash, '' order by row_hash collate "C"), ''), 'UTF8')), 'hex') as content_sha256
  from (select encode(sha256(convert_to(to_jsonb(r)::text, 'UTF8')), 'hex') as row_hash from erp_finance.command r) rows_hashed
  union all
  select 'erp_finance.audit'::text as relation, count(*)::bigint as row_count,
    encode(sha256(convert_to(coalesce(string_agg(row_hash, '' order by row_hash collate "C"), ''), 'UTF8')), 'hex') as content_sha256
  from (select encode(sha256(convert_to(to_jsonb(r)::text, 'UTF8')), 'hex') as row_hash from erp_finance.audit r) rows_hashed
  union all
  select 'erp_finance.document_posting'::text as relation, count(*)::bigint as row_count,
    encode(sha256(convert_to(coalesce(string_agg(row_hash, '' order by row_hash collate "C"), ''), 'UTF8')), 'hex') as content_sha256
  from (select encode(sha256(convert_to(to_jsonb(r)::text, 'UTF8')), 'hex') as row_hash from erp_finance.document_posting r) rows_hashed
  union all
  select 'erp_finance.document_title'::text as relation, count(*)::bigint as row_count,
    encode(sha256(convert_to(coalesce(string_agg(row_hash, '' order by row_hash collate "C"), ''), 'UTF8')), 'hex') as content_sha256
  from (select encode(sha256(convert_to(to_jsonb(r)::text, 'UTF8')), 'hex') as row_hash from erp_finance.document_title r) rows_hashed
  union all
  select 'erp_finance.document_command'::text as relation, count(*)::bigint as row_count,
    encode(sha256(convert_to(coalesce(string_agg(row_hash, '' order by row_hash collate "C"), ''), 'UTF8')), 'hex') as content_sha256
  from (select encode(sha256(convert_to(to_jsonb(r)::text, 'UTF8')), 'hex') as row_hash from erp_finance.document_command r) rows_hashed
  union all
  select 'erp_finance.origin_import_origin'::text as relation, count(*)::bigint as row_count,
    encode(sha256(convert_to(coalesce(string_agg(row_hash, '' order by row_hash collate "C"), ''), 'UTF8')), 'hex') as content_sha256
  from (select encode(sha256(convert_to(to_jsonb(r)::text, 'UTF8')), 'hex') as row_hash from erp_finance.origin_import_origin r) rows_hashed
  union all
  select 'erp_finance.transfer'::text as relation, count(*)::bigint as row_count,
    encode(sha256(convert_to(coalesce(string_agg(row_hash, '' order by row_hash collate "C"), ''), 'UTF8')), 'hex') as content_sha256
  from (select encode(sha256(convert_to(to_jsonb(r)::text, 'UTF8')), 'hex') as row_hash from erp_finance.transfer r) rows_hashed
  union all
  select 'erp_cnab.profile'::text as relation, count(*)::bigint as row_count,
    encode(sha256(convert_to(coalesce(string_agg(row_hash, '' order by row_hash collate "C"), ''), 'UTF8')), 'hex') as content_sha256
  from (select encode(sha256(convert_to(to_jsonb(r)::text, 'UTF8')), 'hex') as row_hash from erp_cnab.profile r) rows_hashed
  union all
  select 'erp_cnab.remittance'::text as relation, count(*)::bigint as row_count,
    encode(sha256(convert_to(coalesce(string_agg(row_hash, '' order by row_hash collate "C"), ''), 'UTF8')), 'hex') as content_sha256
  from (select encode(sha256(convert_to(to_jsonb(r)::text, 'UTF8')), 'hex') as row_hash from erp_cnab.remittance r) rows_hashed
  union all
  select 'erp_cnab.billing_title'::text as relation, count(*)::bigint as row_count,
    encode(sha256(convert_to(coalesce(string_agg(row_hash, '' order by row_hash collate "C"), ''), 'UTF8')), 'hex') as content_sha256
  from (select encode(sha256(convert_to(to_jsonb(r)::text, 'UTF8')), 'hex') as row_hash from erp_cnab.billing_title r) rows_hashed
  union all
  select 'erp_cnab.return_file'::text as relation, count(*)::bigint as row_count,
    encode(sha256(convert_to(coalesce(string_agg(row_hash, '' order by row_hash collate "C"), ''), 'UTF8')), 'hex') as content_sha256
  from (select encode(sha256(convert_to(to_jsonb(r)::text, 'UTF8')), 'hex') as row_hash from erp_cnab.return_file r) rows_hashed
  union all
  select 'erp_cnab.return_event'::text as relation, count(*)::bigint as row_count,
    encode(sha256(convert_to(coalesce(string_agg(row_hash, '' order by row_hash collate "C"), ''), 'UTF8')), 'hex') as content_sha256
  from (select encode(sha256(convert_to(to_jsonb(r)::text, 'UTF8')), 'hex') as row_hash from erp_cnab.return_event r) rows_hashed
  union all
  select 'erp_cnab.return_occurrence'::text as relation, count(*)::bigint as row_count,
    encode(sha256(convert_to(coalesce(string_agg(row_hash, '' order by row_hash collate "C"), ''), 'UTF8')), 'hex') as content_sha256
  from (select encode(sha256(convert_to(to_jsonb(r)::text, 'UTF8')), 'hex') as row_hash from erp_cnab.return_occurrence r) rows_hashed
  union all
  select 'erp_cnab.command'::text as relation, count(*)::bigint as row_count,
    encode(sha256(convert_to(coalesce(string_agg(row_hash, '' order by row_hash collate "C"), ''), 'UTF8')), 'hex') as content_sha256
  from (select encode(sha256(convert_to(to_jsonb(r)::text, 'UTF8')), 'hex') as row_hash from erp_cnab.command r) rows_hashed
  union all
  select 'erp_cnab.audit'::text as relation, count(*)::bigint as row_count,
    encode(sha256(convert_to(coalesce(string_agg(row_hash, '' order by row_hash collate "C"), ''), 'UTF8')), 'hex') as content_sha256
  from (select encode(sha256(convert_to(to_jsonb(r)::text, 'UTF8')), 'hex') as row_hash from erp_cnab.audit r) rows_hashed
  union all
  select 'erp_cnab.human_review'::text as relation, count(*)::bigint as row_count,
    encode(sha256(convert_to(coalesce(string_agg(row_hash, '' order by row_hash collate "C"), ''), 'UTF8')), 'hex') as content_sha256
  from (select encode(sha256(convert_to(to_jsonb(r)::text, 'UTF8')), 'hex') as row_hash from erp_cnab.human_review r) rows_hashed
  union all
  select 'erp_cnab.human_review_revision'::text as relation, count(*)::bigint as row_count,
    encode(sha256(convert_to(coalesce(string_agg(row_hash, '' order by row_hash collate "C"), ''), 'UTF8')), 'hex') as content_sha256
  from (select encode(sha256(convert_to(to_jsonb(r)::text, 'UTF8')), 'hex') as row_hash from erp_cnab.human_review_revision r) rows_hashed
  union all
  select 'erp_cnab.operational_approval'::text as relation, count(*)::bigint as row_count,
    encode(sha256(convert_to(coalesce(string_agg(row_hash, '' order by row_hash collate "C"), ''), 'UTF8')), 'hex') as content_sha256
  from (select encode(sha256(convert_to(to_jsonb(r)::text, 'UTF8')), 'hex') as row_hash from erp_cnab.operational_approval r) rows_hashed
  union all
  select 'erp_cnab.operational_approval_revision'::text as relation, count(*)::bigint as row_count,
    encode(sha256(convert_to(coalesce(string_agg(row_hash, '' order by row_hash collate "C"), ''), 'UTF8')), 'hex') as content_sha256
  from (select encode(sha256(convert_to(to_jsonb(r)::text, 'UTF8')), 'hex') as row_hash from erp_cnab.operational_approval_revision r) rows_hashed
  union all
  select 'erp_cnab.operational_binding'::text as relation, count(*)::bigint as row_count,
    encode(sha256(convert_to(coalesce(string_agg(row_hash, '' order by row_hash collate "C"), ''), 'UTF8')), 'hex') as content_sha256
  from (select encode(sha256(convert_to(to_jsonb(r)::text, 'UTF8')), 'hex') as row_hash from erp_cnab.operational_binding r) rows_hashed
  union all
  select 'erp_cnab.operational_settlement'::text as relation, count(*)::bigint as row_count,
    encode(sha256(convert_to(coalesce(string_agg(row_hash, '' order by row_hash collate "C"), ''), 'UTF8')), 'hex') as content_sha256
  from (select encode(sha256(convert_to(to_jsonb(r)::text, 'UTF8')), 'hex') as row_hash from erp_cnab.operational_settlement r) rows_hashed
  union all
  select 'erp_documents.numbering'::text as relation, count(*)::bigint as row_count,
    encode(sha256(convert_to(coalesce(string_agg(row_hash, '' order by row_hash collate "C"), ''), 'UTF8')), 'hex') as content_sha256
  from (select encode(sha256(convert_to(to_jsonb(r)::text, 'UTF8')), 'hex') as row_hash from erp_documents.numbering r) rows_hashed
  union all
  select 'erp_documents.document'::text as relation, count(*)::bigint as row_count,
    encode(sha256(convert_to(coalesce(string_agg(row_hash, '' order by row_hash collate "C"), ''), 'UTF8')), 'hex') as content_sha256
  from (select encode(sha256(convert_to(to_jsonb(r)::text, 'UTF8')), 'hex') as row_hash from erp_documents.document r) rows_hashed
  union all
  select 'erp_documents.item'::text as relation, count(*)::bigint as row_count,
    encode(sha256(convert_to(coalesce(string_agg(row_hash, '' order by row_hash collate "C"), ''), 'UTF8')), 'hex') as content_sha256
  from (select encode(sha256(convert_to(to_jsonb(r)::text, 'UTF8')), 'hex') as row_hash from erp_documents.item r) rows_hashed
  union all
  select 'erp_documents.command'::text as relation, count(*)::bigint as row_count,
    encode(sha256(convert_to(coalesce(string_agg(row_hash, '' order by row_hash collate "C"), ''), 'UTF8')), 'hex') as content_sha256
  from (select encode(sha256(convert_to(to_jsonb(r)::text, 'UTF8')), 'hex') as row_hash from erp_documents.command r) rows_hashed
  union all
  select 'erp_documents.audit'::text as relation, count(*)::bigint as row_count,
    encode(sha256(convert_to(coalesce(string_agg(row_hash, '' order by row_hash collate "C"), ''), 'UTF8')), 'hex') as content_sha256
  from (select encode(sha256(convert_to(to_jsonb(r)::text, 'UTF8')), 'hex') as row_hash from erp_documents.audit r) rows_hashed
), summary as (
  select jsonb_agg(jsonb_build_object('relation',relation,'row_count',row_count,'content_sha256',content_sha256)
           order by relation collate "C") as relations,
    encode(sha256(convert_to(string_agg(relation||':'||row_count::text||':'||content_sha256, E'\n' order by relation collate "C"), 'UTF8')), 'hex') as state_sha256
  from relation_state
)
select jsonb_build_object(
  'profile','brufap-financial-state-before-after-058-v1',
  'read_only',true,
  'observed_at',transaction_timestamp(),
  'relations_count',31,
  'state_sha256',state_sha256,
  'relations',relations
) as financial_state_audit
from summary;

rollback;
