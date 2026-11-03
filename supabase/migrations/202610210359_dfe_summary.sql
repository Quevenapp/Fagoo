-- Leva H, lane espelho (NFE-212): Notas recebidas com Data emissão, Valor, Fornecedor e CNPJ/CPF dos documentos já guardados.
-- * erp_dfe.document é imutável e os bytes ficam no Storage (brufap-received-dfe). A extração é feita no Worker, que baixa o objeto,
--   confere tamanho e SHA-256 com o documento, lê o resumo (resNFe: dhEmi, vNF, xNome, CNPJ/CPF, cSitNFe) ou a NF-e completa
--   (nfeProc: ide/dhEmi, ICMSTot/vNF, emit) e grava aqui o resultado. Os dados são derivados dos bytes imutáveis: a gravação é
--   única por documento (repetir não muda nada) e confere a chave de acesso e o emitente com a chave do documento.
-- * erp_dfe.summary é somente acréscimo. Lê e grava quem consulta as notas recebidas (administrador, fiscal e consulta), com a
--   mesma conferência de empresa do canal (check_company).
-- * A coleta DF-e na SEFAZ continua desligada: nada aqui consulta, manifesta, emite, cria conta ou estoque.
begin;

do $$begin
 if to_regclass('erp_dfe.document') is null or to_regprocedure('erp_dfe.access(uuid,text)') is null or to_regprocedure('erp_dfe.check_company(erp_dfe.channel,boolean)') is null then
  raise exception 'dfe_summary_359_requires_045' using errcode='55000'; end if;
end$$;

create table erp_dfe.summary(
 document_id uuid primary key references erp_dfe.document(id),
 object_hash text not null check(object_hash~'^[a-f0-9]{64}$'),
 issue_date date check(issue_date between date '2000-01-01' and date '2099-12-31'),
 total numeric(15,2) check(total>=0),
 supplier_name text check(length(supplier_name) between 1 and 200 and supplier_name!~'[[:cntrl:]]'),
 supplier_document text check(supplier_document~'^([0-9]{11}|[0-9]{14})$'),
 situation text check(situation in('1','2','3')),
 recorded_by uuid not null references auth.users(id),
 recorded_at timestamptz not null default clock_timestamp()
);
alter table erp_dfe.summary enable row level security;
revoke all on erp_dfe.summary from public,anon,authenticated,service_role;
create trigger dfe_summary_immutable before update or delete on erp_dfe.summary for each row execute function erp_dfe.immutable();
comment on table erp_dfe.summary is 'NFE-212: data de emissão, valor, fornecedor e situação lidos pelo Worker dos bytes conferidos do resumo ou da NF-e recebida.';

create function erp_dfe.summary_json(s erp_dfe.summary) returns jsonb language sql immutable set search_path=pg_catalog as $$
 select jsonb_build_object('document_id',s.document_id,'issue_date',s.issue_date,'total',case when s.total is null then null else to_char(s.total,'FM9999999999990.00') end,
  'supplier_name',s.supplier_name,'supplier_document',s.supplier_document,'situation',s.situation)
$$;

-- The Worker's reading of the checked bytes of one received document. Idempotent: the first reading stays.
create function public.erp_dfe_summary_record(p_user_id uuid,p_document_id uuid,p_object_hash text,p_summary jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare d erp_dfe.document;c erp_dfe.channel;s erp_dfe.summary;v_date date;v_total numeric;v_doc text;v_name text;v_sit text;inserted boolean:=false;
begin
 perform erp_dfe.access(p_user_id,'read');
 select * into d from erp_dfe.document where id=p_document_id;
 if not found then raise exception 'dfe_document_missing' using errcode='P0002'; end if;
 select * into c from erp_dfe.channel where id=d.channel_id;perform erp_dfe.check_company(c);
 if d.kind not in('invoice_summary','invoice') or p_object_hash is distinct from d.object_hash or jsonb_typeof(p_summary)<>'object'
  or exists(select 1 from jsonb_object_keys(p_summary) k where k not in('access_key','issue_date','total','supplier_name','supplier_document','situation'))
  or p_summary->>'access_key' is distinct from d.access_key then raise exception 'dfe_summary_invalid' using errcode='22023'; end if;
 if coalesce(p_summary->'issue_date','null'::jsonb)<>'null'::jsonb then
  if jsonb_typeof(p_summary->'issue_date')<>'string' or p_summary->>'issue_date'!~'^20[0-9]{2}-[0-9]{2}-[0-9]{2}$' then raise exception 'dfe_summary_invalid' using errcode='22023'; end if;
  begin v_date:=(p_summary->>'issue_date')::date;
  exception when others then raise exception 'dfe_summary_invalid' using errcode='22023';
  end;
 end if;
 v_total:=case when jsonb_typeof(p_summary->'total')='string' and p_summary->>'total'~'^[0-9]{1,13}\.[0-9]{2}$' then (p_summary->>'total')::numeric end;
 v_doc:=case when jsonb_typeof(p_summary->'supplier_document')='string' then p_summary->>'supplier_document' end;
 v_name:=case when jsonb_typeof(p_summary->'supplier_name')='string' and length(p_summary->>'supplier_name') between 1 and 200 and p_summary->>'supplier_name'!~'[[:cntrl:]]' then p_summary->>'supplier_name' end;
 v_sit:=case when jsonb_typeof(p_summary->'situation')='string' and p_summary->>'situation' in('1','2','3') then p_summary->>'situation' end;
 -- Every given value must be valid (absent is null); the emitter must be the one inside the access key (CNPJ, or CPF padded with 000).
 if (v_total is null and coalesce(p_summary->'total','null'::jsonb)<>'null'::jsonb) or (v_name is null and coalesce(p_summary->'supplier_name','null'::jsonb)<>'null'::jsonb)
  or (v_sit is null and coalesce(p_summary->'situation','null'::jsonb)<>'null'::jsonb) or (v_doc is null and coalesce(p_summary->'supplier_document','null'::jsonb)<>'null'::jsonb)
  or (v_doc is not null and lpad(v_doc,14,'0') is distinct from substr(d.access_key,7,14)) or (v_doc is not null and v_doc!~'^([0-9]{11}|[0-9]{14})$')
  or (d.kind='invoice' and v_sit is not null) then raise exception 'dfe_summary_invalid' using errcode='22023'; end if;
 insert into erp_dfe.summary(document_id,object_hash,issue_date,total,supplier_name,supplier_document,situation,recorded_by)
 values(d.id,d.object_hash,v_date,v_total,v_name,v_doc,v_sit,p_user_id) on conflict(document_id) do nothing returning true into inserted;
 select * into s from erp_dfe.summary where document_id=d.id;
 return erp_dfe.flags()||jsonb_build_object('summary',erp_dfe.summary_json(s),'recorded',coalesce(inserted,false));
end $$;

-- The stored readings of up to 50 documents of one channel (the page of Notas recebidas).
create function public.erp_dfe_summaries(p_user_id uuid,p_channel_id uuid,p_document_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare c erp_dfe.channel;rows jsonb;
begin
 perform erp_dfe.access(p_user_id,'read');
 if p_document_ids is null or cardinality(p_document_ids) not between 1 and 50 or array_position(p_document_ids,null) is not null then raise exception 'dfe_filter_invalid' using errcode='22023'; end if;
 select * into c from erp_dfe.channel where id=p_channel_id;
 if not found then raise exception 'dfe_channel_missing' using errcode='P0002'; end if;
 perform erp_dfe.check_company(c);
 select coalesce(jsonb_agg(erp_dfe.summary_json(s) order by s.document_id),'[]'::jsonb) into rows
 from erp_dfe.summary s join erp_dfe.document d on d.id=s.document_id where d.channel_id=c.id and s.document_id=any(p_document_ids);
 return erp_dfe.flags()||jsonb_build_object('channel_id',c.id,'items',rows);
end $$;

revoke all on function erp_dfe.summary_json(erp_dfe.summary) from public,anon,authenticated,service_role;
revoke all on function public.erp_dfe_summary_record(uuid,uuid,text,jsonb),public.erp_dfe_summaries(uuid,uuid,uuid[]) from public,anon,authenticated;
grant execute on function public.erp_dfe_summary_record(uuid,uuid,text,jsonb),public.erp_dfe_summaries(uuid,uuid,uuid[]) to service_role;
commit;
