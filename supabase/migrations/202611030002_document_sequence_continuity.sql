-- Continue local numbering after documents received from another system.
begin;
create function erp_documents.advance_received_number() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
begin
 if new.number between 1 and 9999999999 then
  update erp_documents.numbering set last_number=new.number
   where kind=new.kind and last_number<new.number;
 end if;
 return null;
end$$;
revoke all on function erp_documents.advance_received_number() from public,anon,authenticated,service_role;
create trigger document_number_continuity after insert or update of kind,number on erp_documents.document
 for each row execute function erp_documents.advance_received_number();

-- Repair an older installation once, including deleted numbers, which must not be reused.
update erp_documents.numbering n set last_number=greatest(n.last_number,
 coalesce((select max(d.number) from erp_documents.document d where d.kind=n.kind and d.number<=9999999999),0));

-- The administrator's minimum and reset validation must include received numbers too.
do $migration$
declare definition text; changed text;
begin
 definition:=pg_get_functiondef('erp_documents.numbering_dto(text)'::regprocedure);
 changed:=replace(definition,'where d.origin=''brufap'' and d.kind=n.kind','where d.kind=n.kind');
 if changed=definition then raise exception 'document_numbering_dto_definition_unexpected'; end if;
 execute changed;
 definition:=pg_get_functiondef('public.erp_document_numbering_set(uuid,text,uuid,text,text)'::regprocedure);
 changed:=replace(definition,'where origin=''brufap'' and kind=p_kind','where kind=p_kind');
 if changed=definition then raise exception 'document_numbering_set_definition_unexpected'; end if;
 execute changed;
end$migration$;
commit;
