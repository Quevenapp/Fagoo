-- Mão dupla (016): a listagem mostra os selos do que foi feito no Origin nos documentos convertidos, como no Origin:
-- N (nota fiscal gerada) e C (contas lançadas). Os campos origin_invoice e origin_finance vêm de erp_sync.origin_effects.
begin;

do $$declare v_def text; v_new text;
begin
 v_def:=replace(pg_get_functiondef('erp_documents.list_row(uuid,boolean,boolean)'::regprocedure),E'\r','');
 v_new:=replace(v_def,'||jsonb_build_object(''origin'',d.origin,''authority'',d.authority,''readonly'',false) end',
  '||jsonb_build_object(''origin'',d.origin,''authority'',d.authority,''readonly'',false)'
  ||'||(select jsonb_build_object(''origin_finance'',(e->>''finance'')::boolean,''origin_invoice'',(e->>''invoice'')::boolean) from erp_sync.origin_effects(d.id) e) end');
 if v_new=v_def then raise exception 'origin_effects_018_list_row_changed'; end if;
 execute v_new;
end$$;

commit;
