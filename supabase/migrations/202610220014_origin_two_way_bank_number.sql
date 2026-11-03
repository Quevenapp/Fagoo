-- Mão dupla (009-013): contas do Origin com "numeroBanco" vazio ("") eram recusadas pela regra de erp_finance.title
-- (bank_number nulo ou texto sem espaços nas pontas). Texto vazio ou só com espaços entra como nulo.
begin;

do $$declare v_def text; v_new text;
begin
 v_def:=replace(pg_get_functiondef('erp_sync.pull_title(origin_sync.raw_record)'::regprocedure),E'\r','');
 v_new:=replace(v_def,'left(s.payload->>''numeroBanco'',40)',
  'nullif(btrim(left(regexp_replace(s.payload->>''numeroBanco'',''[[:cntrl:]]'','''',''g''),40)),'''')');
 if v_new=v_def then raise exception 'origin_two_way_014_pull_title_changed'; end if;
 execute v_new;
end$$;

update erp_sync.inbox set retry_at='-infinity',error=null where error like '%title_bank_number_check%';
update erp_sync.issue set resolved_at=clock_timestamp() where resolved_at is null and code like '%title_bank_number_check%';

commit;
