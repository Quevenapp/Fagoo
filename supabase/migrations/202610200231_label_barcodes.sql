-- 231: Etiquetas customizadas aceitam os formatos de código UPC-E, C93 e QR CODE do Origin (gerados no navegador, sem
-- biblioteca e sem rede). DATA MATRIX, PDF417 e EBCT (Correios) continuam indisponíveis e são recusados.
-- Substitui erp_preferences.label_check (149), conferida pelo hash; outra versão interrompe a migração. Nenhuma tabela nova
-- e nenhuma escrita: os modelos gravados continuam válidos.
begin;

do $$begin
 if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') from pg_proc where oid=to_regprocedure('erp_preferences.label_check(text,jsonb)'))
  is distinct from '9fb5d0fee433ec140a53f8049fbb6e70a35b1ae103936d0e4977567e8063377f' then
  raise exception 'labels_231_previous_definition_changed erp_preferences.label_check(text,jsonb)' using errcode='55000';end if;
end$$;

-- Etiqueta, Página and Campos of a model; numbers in millimeters as decimal strings (one decimal place).
create or replace function erp_preferences.label_check(p_type text,p_config jsonb) returns void language plpgsql immutable set search_path=pg_catalog as $$
declare l jsonb:=p_config->'label';g jsonb:=p_config->'page';f jsonb;v_width numeric;v_height numeric;v_fields text[]:=erp_preferences.label_fields(p_type);
begin
 if v_fields is null or not erp_preferences.framework_keys(p_config,array['fields','label','page'])
  or not erp_preferences.framework_keys(l,array['barcode','barcode_text','columns_gap','currency','font','font_size','height','rows_gap','show_labels','width'])
  or not erp_preferences.framework_keys(g,array['height','margin_left','margin_top','orientation','size','width'])
  or jsonb_typeof(l->'font')<>'string' or l->>'font' not in('helvetica','courier','monospace','times')
  or jsonb_typeof(l->'barcode')<>'string' or l->>'barcode' not in('c128','ean13','upca','msi','upce','c93','qr')
  or jsonb_typeof(l->'barcode_text')<>'boolean' or jsonb_typeof(l->'currency')<>'boolean' or jsonb_typeof(l->'show_labels')<>'boolean'
  or jsonb_typeof(g->'size')<>'string' or g->>'size' not in('A2','A3','A4','A5','custom') or jsonb_typeof(g->'orientation')<>'string' or g->>'orientation' not in('portrait','landscape')
  or jsonb_typeof(p_config->'fields')<>'array' or jsonb_array_length(p_config->'fields') not between 1 and 20 then
  raise exception 'erp_preferences_label_config_invalid' using errcode='22023'; end if;
 v_width:=erp_preferences.label_mm(l->'width',5,300);v_height:=erp_preferences.label_mm(l->'height',5,300);
 perform erp_preferences.label_mm(l->'font_size',4,72),erp_preferences.label_mm(l->'columns_gap',0,100),erp_preferences.label_mm(l->'rows_gap',0,100),
  erp_preferences.label_mm(g->'margin_left',0,100),erp_preferences.label_mm(g->'margin_top',0,100);
 if g->>'size'='custom' then perform erp_preferences.label_mm(g->'width',20,999),erp_preferences.label_mm(g->'height',20,999);
 elsif jsonb_typeof(g->'width')<>'null' or jsonb_typeof(g->'height')<>'null' then raise exception 'erp_preferences_label_config_invalid' using errcode='22023'; end if;
 for f in select x from jsonb_array_elements(p_config->'fields') x loop
  if not erp_preferences.framework_keys(f,array['barcode','bold','field','size','x','y']) or jsonb_typeof(f->'field')<>'string' or not(f->>'field'=any(v_fields))
   or jsonb_typeof(f->'bold')<>'boolean' or jsonb_typeof(f->'barcode')<>'boolean' then raise exception 'erp_preferences_label_config_invalid' using errcode='22023'; end if;
  perform erp_preferences.label_mm(f->'x',0,v_width),erp_preferences.label_mm(f->'y',0,v_height),erp_preferences.label_mm(f->'size',4,72);
 end loop;
end $$;
revoke all on function erp_preferences.label_check(text,jsonb) from public,anon,authenticated,service_role;
commit;
