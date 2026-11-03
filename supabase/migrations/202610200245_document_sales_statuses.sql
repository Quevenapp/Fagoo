-- 245: Situações do Origin para pedidos de venda: "Venda Agenciada" (agency_sale) e "Faturado parcialmente" (partially_invoiced).
-- * Venda Agenciada (código 4 do Origin, #FF7835): vai e volta de Em digitação, Em aberto, Verificado, Em andamento, Atendido e
--   Cancelado, como no Gerenciador de transições do Origin ("cada uma pode ir para todas as outras"). Editável como Em aberto e sem
--   efeitos de estoque e de contas por padrão: nenhuma regra de lançamento a aceita, e com estoque, contas, reservas ou
--   recebimentos ativos o pedido não muda para ela (estorne antes).
-- * Faturado parcialmente (código 5, #B83147): o Origin chega a ela pela nota fiscal parcial; aqui também por Atendido parcialmente
--   ("de Atendido parcialmente vai para Faturado parcialmente") e dela só para Atendido parcialmente e Cancelado. Fica travada para
--   edição como Atendido; com efeitos ativos, Atendido parcialmente e Faturado parcialmente trocam entre si.
-- * O Gerenciador de transições (148/230) passa a listar as duas situações padrão com os nomes e cores do Origin.
-- Publicação: a Página inicial resume os pedidos por situação a partir desta lista. Publique a API nova logo depois do banco: a
-- API anterior não conhece as duas situações e responde erro no resumo até a troca (a API nova aceita a lista antiga e a nova).
-- Substitui funções das migrações 008, 017 e 129 (conferidas pelo hash; outra versão interrompe a migração).
begin;

do $$declare r record;begin
 for r in select * from(values
  ('erp_documents.transitions()','8a12136c7028d5ffb152d48039c2b58b7fdc5fcf8786308607e27a1002019a31'),
  ('erp_documents.editable(text)','4f12995013740268348b35a79e3e5ac682b75afc4f2afe0c0ddbdde0014a3577'),
  ('erp_documents.effects_transition_allowed(text,text,text)','31e47610ccc0c3d40e4f3d0409502b82573d47076d3e93f32957422e2917f010'))v(sig,expected) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex')from pg_proc where oid=to_regprocedure(r.sig))is distinct from r.expected then
   raise exception 'document_sales_statuses_245_previous_definition_changed' using errcode='55000',detail=r.sig;end if;
 end loop;
end$$;

-- 129 plus Venda Agenciada and Faturado parcialmente (pedidos de venda); the other kinds do not change.
create or replace function erp_documents.transitions()
returns jsonb language sql immutable set search_path=pg_catalog as $$ select '{"sales_proposals":{"draft":["open","pending","waiting","approved","rejected","cancelled"],"open":["draft","pending","waiting","approved","rejected","cancelled"],"pending":["draft","open","waiting","approved","rejected","cancelled"],"waiting":["draft","open","pending","approved","rejected","cancelled"],"approved":["draft","open","pending","waiting","rejected","cancelled"],"rejected":["draft","open","pending","waiting","approved","cancelled"],"cancelled":["draft","open","pending","waiting","approved","rejected"],"completed":[]},"sales_orders":{"draft":["open","verified","in_progress","agency_sale","fulfilled","cancelled"],"open":["draft","verified","in_progress","agency_sale","fulfilled","cancelled"],"verified":["draft","open","in_progress","agency_sale","fulfilled","cancelled"],"in_progress":["draft","open","verified","agency_sale","partially_fulfilled","fulfilled","cancelled"],"agency_sale":["draft","open","verified","in_progress","fulfilled","cancelled"],"partially_fulfilled":["in_progress","partially_invoiced","fulfilled","cancelled"],"partially_invoiced":["partially_fulfilled","cancelled"],"fulfilled":["draft","open","verified","in_progress","agency_sale","cancelled"],"cancelled":["draft","open","verified","in_progress","agency_sale","fulfilled"]},"purchase_orders":{"open":["in_progress","fulfilled","cancelled"],"in_progress":["open","partially_fulfilled","fulfilled","cancelled"],"partially_fulfilled":["in_progress","fulfilled","cancelled"],"fulfilled":["open","in_progress","cancelled"],"cancelled":["open","in_progress","fulfilled"]},"service_orders":{"open":["quoted","approved","rejected","in_progress","waiting_parts","service_done","finalized","no_repair","cancelled"],"quoted":["open","approved","rejected","in_progress","waiting_parts","service_done","finalized","no_repair","cancelled"],"approved":["open","quoted","rejected","in_progress","waiting_parts","service_done","finalized","no_repair","cancelled"],"rejected":["open","quoted","approved","in_progress","waiting_parts","service_done","finalized","no_repair","cancelled"],"in_progress":["open","quoted","approved","rejected","waiting_parts","service_done","finalized","no_repair","cancelled"],"waiting_parts":["open","quoted","approved","rejected","in_progress","service_done","finalized","no_repair","cancelled"],"service_done":["open","quoted","approved","rejected","in_progress","waiting_parts","finalized","no_repair","cancelled"],"finalized":["open","quoted","approved","rejected","in_progress","waiting_parts","service_done","no_repair","cancelled"],"no_repair":["open","quoted","approved","rejected","in_progress","waiting_parts","service_done","finalized","cancelled"],"cancelled":["open","quoted","approved","rejected","in_progress","waiting_parts","service_done","finalized","no_repair"]}}'::jsonb $$;

-- 008 plus Faturado parcialmente (a nota fiscal parcial já foi emitida: como Atendido, o pedido não é mais editado).
create or replace function erp_documents.editable(p_status text)
returns boolean language sql immutable set search_path=pg_catalog as $$
 select coalesce(p_status not in ('approved','completed','fulfilled','finalized','no_repair','cancelled','rejected','service_done','partially_invoiced'),false);
$$;

-- 017 plus Atendido parcialmente <-> Faturado parcialmente with active effects (stock, contas, reservas, recebimentos).
create or replace function erp_documents.effects_transition_allowed(p_kind text,p_from text,p_to text)
returns boolean language sql immutable set search_path=pg_catalog as $$
 select coalesce(p_from=p_to or case p_kind
 when 'sales_orders' then (p_from='verified' and p_to='in_progress') or(p_from='in_progress' and p_to in('partially_fulfilled','fulfilled')) or(p_from='partially_fulfilled' and p_to in('fulfilled','partially_invoiced'))
  or(p_from='partially_invoiced' and p_to='partially_fulfilled')
 when 'purchase_orders' then (p_from='in_progress' and p_to in('partially_fulfilled','fulfilled')) or(p_from='partially_fulfilled' and p_to='fulfilled')
 when 'service_orders' then (p_from='approved' and p_to='in_progress') or(p_from='in_progress' and p_to in('waiting_parts','service_done')) or(p_from='waiting_parts' and p_to='in_progress') or(p_from='service_done' and p_to='finalized')
 else false end,false);
$$;

revoke all on function erp_documents.transitions(),erp_documents.editable(text),erp_documents.effects_transition_allowed(text,text,text) from public,anon,authenticated,service_role;
commit;
