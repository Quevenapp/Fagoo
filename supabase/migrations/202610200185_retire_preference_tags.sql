-- 185: Suprimentos > Gerenciar grupos de tags e Gerenciar tags passam a ser só as telas de tags dos produtos (migração 119,
-- /grupos-tags e /tags), já ligadas aos produtos com filtro, coluna Marcadores e "Incluir tags para selecionados". O cadastro
-- paralelo de tags da 148 (erp_preferences.tag_group e erp_preferences.tag) nunca teve tela no menu depois da junção da onda B;
-- esta migração o retira para não haver dois cadastros de tags.
-- * A migração para (55000) se existir qualquer grupo ou tag gravado na 148: nada é apagado sem conferência.
-- * O histórico fica: os comandos e a auditoria da área 'tags' (erp_preferences.framework_command/framework_audit) são
--   imutáveis e continuam no Registro de atividades (módulo Preferências).
begin;

lock table erp_preferences.tag_group,erp_preferences.tag in access exclusive mode;
do $$begin
 if exists(select 1 from erp_preferences.tag) or exists(select 1 from erp_preferences.tag_group) then
  raise exception 'preferences_tags_185_rows_exist' using errcode='55000';end if;
end$$;

drop function public.erp_preferences_tag_groups(uuid,text,text);
drop function public.erp_preferences_tags(uuid,text,uuid,text);
drop function public.erp_preferences_tag_group_save(uuid,uuid,uuid,integer,jsonb);
drop function public.erp_preferences_tag_save(uuid,uuid,uuid,integer,jsonb);
drop function public.erp_preferences_tags_delete(uuid,uuid,text,jsonb);
drop function erp_preferences.tag_query(text);
drop function erp_preferences.tag_dto(erp_preferences.tag);
drop function erp_preferences.tag_group_dto(erp_preferences.tag_group);
drop table erp_preferences.tag;
drop table erp_preferences.tag_group;

commit;
