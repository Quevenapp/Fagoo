-- Explicit private export only. Keep the result0600 outside the public repository.
-- This metadata snapshot is not a Storage-byte snapshot or a database restore proof.
-- Required connection setting: fagoo.storage_project, supplied privately by the operator.
-- No default project or hosted destination is embedded. Missing configuration fails closed.
begin isolation level repeatable read read only;
set local statement_timeout='15s';
set local search_path=pg_catalog;
set local timezone='UTC';
with allowed(id,max_bytes)as(values
 ('origin-backups',41943040),('origin-fiscal-xml',8388608),('erp-attachments',10485760),
 ('brufap-cnab',4020000),('brufap-a1-vault',1500000),('brufap-fiscal-artifacts',8388608),('brufap-received-dfe',8388608)
), bucket_rows as(
 select a.id,b.id is not null present,b.public,a.max_bytes from allowed a left join storage.buckets b on b.id=a.id
), totals as(select count(*)n from storage.objects where bucket_id in(select id from allowed)),
 selected as materialized(
 select o.bucket_id,o.name,o.metadata,o.updated_at from storage.objects o
 where o.bucket_id in(select id from allowed)order by o.bucket_id collate "C",o.name collate "C"limit 10001
), fiscal_journal_refs as(
 -- Journal filenames carry the request SHA, not necessarily the stored content SHA.
 -- Bind exact keys to committed ledger bytes; never infer response/observation hashes from names.
 select 'authorization/'||r.attempt_id::text||'/requests/'||r.sha256||'.xml' name,r.sha256 hash,r.size_bytes
 from erp_fiscal_authorization.request r
 union all
 select 'authorization/'||r.attempt_id::text||'/responses/'||q.sha256||'.xml',r.response_hash,r.response_size
 from erp_fiscal_authorization.result r join erp_fiscal_authorization.request q using(attempt_id)
 union all
 select 'authorization/'||r.attempt_id::text||'/processed/'||r.processed_hash||'.xml',r.processed_hash,r.processed_size
 from erp_fiscal_authorization.result r where r.processed_hash is not null
 union all
 select 'authorization/'||o.attempt_id::text||'/observations/'||o.request_hash||'.json',o.sha256,o.size_bytes
 from erp_fiscal_reviewed_authorization.observation o
 join erp_fiscal_authorization.request q on q.attempt_id=o.attempt_id and q.sha256=o.request_hash
 join erp_fiscal_authorization.result r on r.attempt_id=o.attempt_id and r.response_hash=o.response_hash
 union all
 select 'reconciliation/'||a.id::text||'/requests/'||a.request_hash||'.xml',a.request_hash,a.request_size
 from erp_fiscal_reconciliation.attempt a where a.request_hash is not null
 union all
 select 'reconciliation/'||a.id::text||'/responses/'||a.request_hash||'.xml',r.response_hash,r.size_bytes
 from erp_fiscal_reconciliation.artifact r join erp_fiscal_reconciliation.attempt a on a.id=r.attempt_id
 union all
 select 'reconciliation/'||a.id::text||'/observations/'||a.request_hash||'.json',r.evidence->>'transport_receipt_hash',
  case when r.evidence->>'transport_receipt_size'~'^[1-9][0-9]{0,3}$'then(r.evidence->>'transport_receipt_size')::integer end
 from erp_fiscal_reconciliation.artifact r join erp_fiscal_reconciliation.attempt a on a.id=r.attempt_id
 where r.evidence->>'origin'='operational'
), fiscal_journal as(
 select name,min(hash) hash,min(size_bytes) size_bytes,count(*) reference_count from fiscal_journal_refs group by name
), projected as(
 select o.*,case when o.metadata->>'size'~'^(0|[1-9][0-9]{0,10})$'then(o.metadata->>'size')::bigint else null end size_bytes,
  case when o.name~'(^|/)[a-f0-9]{64}(\.[a-z0-9]{1,8})?$'then substring(o.name from '([a-f0-9]{64})(?:\.[a-z0-9]{1,8})?$')else null end path_hash,
  sealed.hash sealed_hash,sealed.size_bytes sealed_size,a.max_bytes,
  o.bucket_id='brufap-fiscal-artifacts'and o.name~'^(authorization|reconciliation)/' is_journal,
  journal.hash journal_hash,journal.size_bytes journal_size,journal.reference_count journal_refs
 from selected o join allowed a on a.id=o.bucket_id
 left join erp_a1.sealed_object sealed on o.bucket_id='brufap-a1-vault'
  and o.name='credentials/'||sealed.credential_id::text||'/'||sealed.hash||'.json'
 left join fiscal_journal journal on o.bucket_id='brufap-fiscal-artifacts'and journal.name=o.name
), items as(
 select jsonb_build_object('bucket',bucket_id,'key',name,'size_bytes',size_bytes,'updated_at',updated_at,
  'metadata',jsonb_build_object('mime_type',metadata->>'mimetype','etag',metadata->>'eTag','cache_control',metadata->>'cacheControl'),
  'expected_sha256',case when bucket_id='brufap-a1-vault'then sealed_hash when is_journal then journal_hash else path_hash end,
  'hash_basis',case when bucket_id='brufap-a1-vault'and sealed_hash is not null then'a1_sealed_ledger'when is_journal and journal_hash is not null then'fiscal_journal_ledger'when not is_journal and bucket_id<>'brufap-a1-vault'and path_hash is not null then'content_addressed_path'else null end,
  'issues',to_jsonb(array_remove(array[
    case when size_bytes is null or size_bytes>max_bytes then'SIZE_REVIEW_REQUIRED'end,
    case when bucket_id='brufap-a1-vault'and(sealed_hash is null or sealed_size is distinct from size_bytes or metadata->>'mimetype'is distinct from'application/json')then'A1_SEALED_REFERENCE_REQUIRED'end,
    case when is_journal and(journal_refs is distinct from 1::bigint or journal_hash is null or journal_hash!~'^[a-f0-9]{64}$' or journal_size is null or journal_size<=0 or journal_size is distinct from size_bytes or metadata->>'mimetype'is distinct from'application/octet-stream')then'FISCAL_JOURNAL_REFERENCE_REQUIRED'end
  ],null)))value from projected
)
select jsonb_build_object('profile','brufap-private-storage-inventory-v1','project',current_setting('fagoo.storage_project'),
 'snapshot_id',gen_random_uuid(),'observed_at',transaction_timestamp(),'read_only',true,
 'total_objects',(select n from totals),'truncated',(select n>10000 from totals),
 'unknown_private_bucket_count',(select count(*)from storage.buckets where not public and id not in(select id from allowed)),
 'buckets',(select jsonb_agg(jsonb_build_object('id',id,'present',present,'public',public,'max_bytes',max_bytes)order by id)from bucket_rows),
 'objects',(select coalesce(jsonb_agg(value order by value->>'bucket'collate "C",value->>'key'collate "C"),'[]'::jsonb)from items),
 'database_restore_verified',false,'vault_recovery_verified',false,'storage_bytes_snapshot_verified',false
)as inventory;
rollback;
