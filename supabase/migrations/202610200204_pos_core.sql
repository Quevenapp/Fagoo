-- Vendas > Frente de caixa (PDV) no padrão do Origin (pdv.php), lane frente de caixa, onda D — parte 1: esquema erp_pos.
-- A venda do PDV é um pedido de venda do Brufap (RPCs públicas de documentos), com os pagamentos, o caixa (Controle de caixa
-- do financeiro, migração 173) e a loja (conta financeira do tipo Caixa) guardados aqui. Esta parte cria as tabelas, o acesso
-- (perfis admin e vendas operam; consulta e financeiro leem; o vendedor vinculado ao usuário segue os módulos "Frente de Caixa"
-- do cadastro de vendedores, migração 126), o contexto da tela (preferências de Preferências > Vendas > Frente de caixa, lojas,
-- caixas abertos, formas de pagamento, depósitos, cliente padrão, chave Pix do QR estático e o estado do certificado A1), as
-- configurações do PDV (só administrador), os produtos favoritos e as leituras das vendas. Nada aqui escreve no Origin, emite
-- nota fiscal ou movimenta banco; as vendas, cancelamentos e devoluções ficam nas migrações 205 e 206.
begin;

do $$begin
 if to_regprocedure('public.erp_finance_cash_session_execute(uuid,uuid,text,jsonb)') is null
  or to_regprocedure('public.erp_document_save(uuid,text,uuid,integer,uuid,jsonb)') is null
  or to_regprocedure('erp_preferences.get(text,uuid)') is null or to_regprocedure('erp_activity.actor_label(uuid)') is null
  or to_regclass('erp_catalog.seller') is null or to_regclass('erp_catalog.payment_method') is null or to_regclass('erp_stock.warehouse_default') is null
  or to_regclass('erp_fiscal_invoices.invoice_order') is null or to_regclass('erp_a1.head') is null or to_regclass('erp_catalog.product_detail') is null then
  raise exception 'pos_core_204_requires_190' using errcode='55000'; end if;
end$$;

create schema erp_pos;
revoke all on schema erp_pos from public,anon,authenticated,service_role;

-- Configurações do PDV (uma linha): cliente padrão das vendas sem cliente identificado e a chave Pix do QR estático
-- ("Pix - QR Code Impresso"). O QR estático é um texto (BR Code) montado no navegador; nenhum banco é chamado.
create table erp_pos.settings(
 singleton boolean primary key default true check(singleton),
 consumer_contact_id uuid references erp_catalog.record(id),
 pix_key_type text check(pix_key_type in('cpf','cnpj','email','phone','random')),
 pix_key text check(pix_key is null or(length(pix_key) between 1 and 77 and pix_key=btrim(pix_key) and pix_key!~'[[:cntrl:]]')),
 pix_merchant_name text check(pix_merchant_name is null or(length(pix_merchant_name) between 1 and 25 and pix_merchant_name~'^[A-Za-z0-9 .,&/-]+$' and pix_merchant_name=btrim(pix_merchant_name))),
 pix_merchant_city text check(pix_merchant_city is null or(length(pix_merchant_city) between 1 and 15 and pix_merchant_city~'^[A-Za-z0-9 .-]+$' and pix_merchant_city=btrim(pix_merchant_city))),
 version integer not null default 0 check(version between 0 and 2147483647),
 updated_by uuid references auth.users(id),updated_at timestamptz,
 check((pix_key is null)=(pix_key_type is null) and (pix_key is null)=(pix_merchant_name is null) and (pix_key is null)=(pix_merchant_city is null)),
 check((version=0)=(updated_at is null) and (updated_at is null)=(updated_by is null))
);
insert into erp_pos.settings(singleton) values(true);

-- Produtos favoritos do PDV (Ver favoritos), da empresa.
create table erp_pos.favorite(
 product_id uuid primary key references erp_catalog.product(record_id),
 created_by uuid not null references auth.users(id),created_at timestamptz not null default clock_timestamp()
);

-- Venda do PDV: o pedido de venda (documento) mais o que é do caixa. "open" é a venda guardada sem finalizar (pré-venda,
-- comanda de mesa); "finished" é a venda finalizada (pedido Atendido); "cancelled" é a venda excluída ou cancelada.
create table erp_pos.sale(
 id uuid primary key default gen_random_uuid(),
 document_id uuid not null unique references erp_documents.document(id),
 account_id uuid references erp_finance.account(id),
 cash_session_id uuid references erp_finance.cash_session(id),
 operator_id uuid not null references auth.users(id),
 kind text not null check(kind in('balcao','mesa')),
 table_number integer check(table_number between 1 and 9999),
 state text not null check(state in('open','finished','cancelled')),
 customer_identified boolean not null,
 price_list_id uuid,
 destination_account_id uuid references erp_finance.account(id),
 to_ledger boolean not null default false,
 total_cents bigint not null check(total_cents between 0 and 99999999999999),
 cash_received_cents bigint check(cash_received_cents between 0 and 99999999999999),
 change_cents bigint not null default 0 check(change_cents between 0 and 99999999999999),
 effects jsonb not null default '{}'::jsonb check(jsonb_typeof(effects)='object'),
 version integer not null default 1 check(version between 1 and 2147483647),
 command_id uuid not null,
 created_at timestamptz not null default clock_timestamp(),updated_at timestamptz not null default clock_timestamp(),
 finished_at timestamptz,finished_by uuid references auth.users(id),
 cancelled_at timestamptz,cancelled_by uuid references auth.users(id),
 cancel_reason text check(cancel_reason is null or(length(cancel_reason) between 3 and 1000 and cancel_reason!~'[[:cntrl:]]')),
 check((kind='mesa')=(table_number is not null)),
 check((finished_at is null)=(finished_by is null) and (state<>'finished' or finished_at is not null)),
 check((state='cancelled')=(cancelled_at is not null) and (cancelled_at is null)=(cancelled_by is null) and (cancelled_at is null)=(cancel_reason is null)),
 check(cash_session_id is null or account_id is not null),
 check(not to_ledger or (customer_identified and destination_account_id is null))
);
-- Uma comanda aberta por mesa.
create unique index erp_pos_sale_open_table on erp_pos.sale(table_number) where state='open' and kind='mesa';
create index erp_pos_sale_session on erp_pos.sale(cash_session_id,created_at desc,id) where cash_session_id is not null;
create index erp_pos_sale_created on erp_pos.sale(created_at desc,id);
create index erp_pos_sale_open on erp_pos.sale(state,created_at desc,id) where state='open';

-- Parcelas da venda (aba Pagamento): forma de pagamento do cadastro, dias, vencimento e valor. "title_id"/"settlement_id" ligam
-- a parcela à conta a receber lançada e à baixa no caixa quando o perfil lança esses efeitos.
create table erp_pos.sale_payment(
 sale_id uuid not null references erp_pos.sale(id),
 position integer not null check(position between 1 and 120),
 payment_method_id uuid not null references erp_catalog.payment_method(id),
 method_name text not null check(length(method_name) between 1 and 100),
 payment_type text not null check(payment_type~'^[0-9]{2}$'),
 days integer not null check(days between 0 and 9999),
 due_on date not null check(due_on between date '1900-01-01' and date '2100-12-31'),
 amount_cents bigint not null check(amount_cents between 1 and 99999999999999),
 note text check(note is null or(length(note) between 1 and 2000 and note!~'[\x01-\x08\x0b-\x1f\x7f]')),
 title_id uuid references erp_finance.title(id),
 settlement_id uuid references erp_finance.settlement(id),
 primary key(sale_id,position)
);
create index erp_pos_sale_payment_method on erp_pos.sale_payment(payment_method_id);

create table erp_pos.command(
 id uuid primary key,actor uuid not null references auth.users(id),scope text not null check(scope in('settings','sale','return')),
 request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),result jsonb not null,created_at timestamptz not null default clock_timestamp()
);
create table erp_pos.audit(
 id bigint generated always as identity primary key,actor uuid not null references auth.users(id),command_id uuid not null,
 sale_id uuid references erp_pos.sale(id),action text not null,before_data jsonb,after_data jsonb,created_at timestamptz not null default clock_timestamp()
);
create function erp_pos.immutable_history() returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'erp_pos_history_immutable' using errcode='42501'; end $$;
create trigger immutable_command before update or delete on erp_pos.command for each row execute function erp_pos.immutable_history();
create trigger immutable_audit before update or delete on erp_pos.audit for each row execute function erp_pos.immutable_history();

do $$declare t text;begin foreach t in array array['settings','favorite','sale','sale_payment','command','audit'] loop
 execute format('alter table erp_pos.%I enable row level security',t);
 execute format('revoke all on erp_pos.%I from public,anon,authenticated,service_role',t);
end loop;end$$;
revoke all on all sequences in schema erp_pos from public,anon,authenticated,service_role;
alter default privileges in schema erp_pos revoke all on tables from public,anon,authenticated,service_role;
alter default privileges in schema erp_pos revoke all on functions from public,anon,authenticated,service_role;

-- ---------------------------------------------------------------- Auxiliares
create function erp_pos.today() returns date language sql stable set search_path=pg_catalog as $$
 select (clock_timestamp() at time zone 'America/Sao_Paulo')::date $$;
-- Comandos das outras áreas chamados por um comando do PDV: identificadores derivados, iguais numa nova tentativa.
create function erp_pos.step(p_command uuid,p_step text) returns uuid language sql immutable set search_path=pg_catalog as $$
 select md5(p_command::text||':erp_pos:'||p_step)::uuid $$;
create function erp_pos.keys(p jsonb,p_allowed text[],p_required text[] default array[]::text[]) returns void
language plpgsql immutable set search_path=pg_catalog as $$
begin
 if p is null or jsonb_typeof(p)<>'object' or exists(select 1 from jsonb_object_keys(p) k where not k=any(p_allowed)) or not p ?& p_required then
  raise exception 'erp_pos_invalid_data' using errcode='22023'; end if;
end $$;
create function erp_pos.txt(p jsonb,p_key text,p_max integer,p_required boolean default false,p_multiline boolean default false) returns text
language plpgsql immutable set search_path=pg_catalog as $$
declare v text;
begin
 if p->p_key is null or p->p_key='null'::jsonb then v:=null;
 elsif jsonb_typeof(p->p_key)<>'string' then raise exception 'erp_pos_invalid_text' using errcode='22023';
 else v:=nullif(btrim(p->>p_key),''); end if;
 if (p_required and v is null) or length(v)>p_max or (case when p_multiline then translate(v,E'\n','') else v end)~'[[:cntrl:]]' then
  raise exception 'erp_pos_invalid_text' using errcode='22023'; end if;
 return v;
end $$;
create function erp_pos.uid(p jsonb,p_key text,p_required boolean default false) returns uuid
language plpgsql immutable set search_path=pg_catalog as $$
begin
 if p->p_key is null or p->p_key='null'::jsonb then
  if p_required then raise exception 'erp_pos_invalid_id' using errcode='22023'; end if; return null; end if;
 if jsonb_typeof(p->p_key)<>'string' or p->>p_key!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
  raise exception 'erp_pos_invalid_id' using errcode='22023'; end if;
 return (p->>p_key)::uuid;
end $$;
-- Centavos inteiros em texto (nunca número binário).
create function erp_pos.cents(p jsonb,p_key text,p_positive boolean default false,p_required boolean default true) returns bigint
language plpgsql immutable set search_path=pg_catalog as $$
begin
 if p->p_key is null or p->p_key='null'::jsonb then
  if p_required then raise exception 'erp_pos_invalid_amount' using errcode='22023'; end if; return null; end if;
 if jsonb_typeof(p->p_key)<>'string' or p->>p_key!~'^[0-9]{1,14}$' or (p_positive and (p->>p_key)::bigint=0) then
  raise exception 'erp_pos_invalid_amount' using errcode='22023'; end if;
 return (p->>p_key)::bigint;
end $$;
create function erp_pos.int(p jsonb,p_key text,p_min integer,p_max integer,p_required boolean default true) returns integer
language plpgsql immutable set search_path=pg_catalog as $$
begin
 if p->p_key is null or p->p_key='null'::jsonb then
  if p_required then raise exception 'erp_pos_invalid_number' using errcode='22023'; end if; return null; end if;
 if jsonb_typeof(p->p_key)<>'number' or p->>p_key!~'^-?[0-9]{1,10}$' or (p->>p_key)::bigint not between p_min and p_max then
  raise exception 'erp_pos_invalid_number' using errcode='22023'; end if;
 return (p->>p_key)::integer;
end $$;
create function erp_pos.flag(p jsonb,p_key text) returns boolean language sql immutable set search_path=pg_catalog as $$
 select coalesce(p->p_key='true'::jsonb,false) $$;
create function erp_pos.pref_flag(p_key text) returns boolean language sql stable set search_path=pg_catalog as $$
 select coalesce(erp_preferences.get(p_key)='true'::jsonb,false) $$;

-- Perfis: admin e vendas operam o PDV; consulta e financeiro leem as vendas (o financeiro abre, fecha e confere o caixa no
-- Controle de caixa). O usuário vinculado a um vendedor (perfil vendas) segue os módulos "Frente de Caixa" do vendedor:
-- sem o módulo não opera o PDV; sem cada subpermissão, a ação correspondente é recusada aqui e no Worker.
create function erp_pos.access(p_user uuid,p_write boolean) returns jsonb
language plpgsql stable set search_path=pg_catalog as $$
declare v_role text; s erp_catalog.seller%rowtype; v_seller boolean:=false; m jsonb; v_pdv boolean;
begin
 select role into v_role from erp_access.membership where user_id=p_user and active;
 if p_user is null or v_role is null or not(case when p_write then v_role in('admin','vendas') else v_role in('admin','vendas','consulta','financeiro') end) then
  raise exception 'erp_pos_access_denied' using errcode='42501'; end if;
 if v_role='vendas' then select * into s from erp_catalog.seller where user_id=p_user; v_seller:=found; end if;
 m:=case when v_seller then coalesce(s.modules,'{}'::jsonb) else null end;
 v_pdv:=not v_seller or erp_pos.flag(m,'frente_caixa');
 if p_write and not v_pdv then raise exception 'erp_pos_access_denied' using errcode='42501'; end if;
 return jsonb_build_object('role',v_role,'seller_id',case when v_seller then s.id end,'operate',v_role in('admin','vendas') and v_pdv,
  'items',v_role in('admin','vendas') and v_pdv and(not v_seller or erp_pos.flag(m,'pdv_registro_itens')),
  'payments',v_role in('admin','vendas') and v_pdv and(not v_seller or erp_pos.flag(m,'pdv_registro_pagamento')),
  'finish',v_role in('admin','vendas') and v_pdv and(not v_seller or erp_pos.flag(m,'pdv_fechamento')),
  'edit_price',v_role in('admin','vendas') and v_pdv and(not v_seller or erp_pos.flag(m,'pdv_editar_preco')),
  'remove_items',v_role in('admin','vendas') and v_pdv and(not v_seller or erp_pos.flag(m,'pdv_exclusao_itens')),
  'change_method',v_role in('admin','vendas') and v_pdv and(not v_seller or erp_pos.flag(m,'pdv_alterar_forma_pagamento')));
end $$;

-- Caixas abertos que o usuário usa: sem "Usuários com caixas únicos", o caixa de cada loja é compartilhado pelos operadores
-- que não têm caixa único; com a opção, o usuário marcado só usa o próprio caixa.
create function erp_pos.usable_session(p_user uuid,p_session erp_finance.cash_session) returns boolean
language sql stable set search_path=pg_catalog as $$
 select p_session.state='open' and p_session.deleted_at is null and(p_session.operator_id=p_user
  or(not coalesce(erp_preferences.get('pdv.usuarios_caixa_unico'),'[]'::jsonb)?p_user::text
   and not coalesce(erp_preferences.get('pdv.usuarios_caixa_unico'),'[]'::jsonb)?p_session.operator_id::text))
$$;

-- Estado do certificado A1 em custódia (só o estado, para o aviso "Certificado inválido").
create function erp_pos.certificate_state() returns text language sql stable set search_path=pg_catalog as $$
 select coalesce((select case when c.id is null then 'missing' when (c.metadata->>'not_after') is null then 'unknown'
   when (c.metadata->>'not_after')::timestamptz<clock_timestamp() then 'expired' else 'valid' end
  from erp_a1.head h left join erp_a1.credential c on c.id=h.credential_id where h.singleton),'missing')
$$;

-- ---------------------------------------------------------------- Venda (leitura)
create function erp_pos.nfce(p_document uuid) returns jsonb language sql stable set search_path=pg_catalog as $$
 select (select jsonb_build_object('id',i.id,'model',i.model,'number',i.number::text,'series',i.series::text,'status',i.status)
  from erp_fiscal_invoices.invoice_order o join erp_fiscal_invoices.invoice i on i.id=o.invoice_id
  where o.document_id=p_document and i.deleted_at is null order by (i.model='65') desc,i.created_at desc,i.id limit 1)
$$;
create function erp_pos.sale_view(p_id uuid,p_detail boolean) returns jsonb
language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('id',s.id,'document_id',d.id,'number',d.number::text,'document_version',d.version,'status',d.status,'state',s.state,'kind',s.kind,
  'table_number',s.table_number,'date',d.body->>'date','created_at',s.created_at,'finished_at',s.finished_at,'cancelled_at',s.cancelled_at,
  'operator_id',s.operator_id,'operator_name',erp_activity.actor_label(s.operator_id),'account_id',s.account_id,'account_name',(select left(a.name,200) from erp_finance.account a where a.id=s.account_id),
  'cash_session_id',s.cash_session_id,'contact_id',d.contact_id,'contact_name',left(coalesce(d.contact_snapshot->>'name',''),200),'customer_identified',s.customer_identified,
  -- O total é o do pedido: a venda aberta pode ter sido editada em Pedidos de venda (finalizada, o pedido não muda mais).
  'total_cents',round(coalesce((d.body#>>'{totals,total}')::numeric,d.total)*100)::bigint::text,'cash_received_cents',s.cash_received_cents::text,'change_cents',s.change_cents::text,
  'effects',s.effects,'invoice',erp_pos.nfce(d.id),'version',s.version)
  ||case when not p_detail then '{}'::jsonb else jsonb_build_object(
   'price_list_id',s.price_list_id,'destination_account_id',s.destination_account_id,'to_ledger',s.to_ledger,'cancel_reason',s.cancel_reason,
   'warehouse_id',d.warehouse_id,'warehouse_name',(select left(r.name,200) from erp_catalog.record r where r.id=d.warehouse_id),
   'seller_id',d.body->>'seller_id','seller_name',(select left(r.name,200) from erp_catalog.seller x join erp_catalog.record r on r.id=x.contact_id where x.id::text=d.body->>'seller_id'),
   'category_id',d.body->>'category_id','expected_date',d.body->>'expected_date','notes',d.body->>'notes','internal_notes',d.body->>'internal_notes',
   'discount_mode',d.body->>'discount_mode','discount_value',d.body->>'discount_value','freight',d.body->>'freight','other_expenses',d.body->>'other_expenses',
   'totals',d.body->'totals','contact_document',left(coalesce(d.contact_snapshot->>'document',''),20),
   'items',(select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'position',i.position,'product_id',i.product_id,'description',i.data->>'description','code',i.data->>'code',
     'unit',i.data->>'unit','quantity',i.data->>'quantity','unit_price',i.data->>'unit_price','discount_percent',i.data->>'discount_percent','gross',i.data->>'gross',
     'discount',i.data->>'discount','total',i.data->>'total','comment',i.data->>'detailed_description') order by i.position),'[]'::jsonb) from erp_documents.item i where i.document_id=d.id),
   'payments',(select coalesce(jsonb_agg(jsonb_build_object('position',p.position,'payment_method_id',p.payment_method_id,'method_name',p.method_name,'payment_type',p.payment_type,
     'days',p.days,'due_on',p.due_on,'amount_cents',p.amount_cents::text,'note',p.note,'title_id',p.title_id,'settlement_id',p.settlement_id) order by p.position),'[]'::jsonb)
     from erp_pos.sale_payment p where p.sale_id=s.id)) end
 from erp_pos.sale s join erp_documents.document d on d.id=s.document_id where s.id=p_id
$$;

-- ---------------------------------------------------------------- Contexto da tela
create function public.erp_pos_context(p_user_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare a jsonb; v_role text; st erp_pos.settings%rowtype; v_unique boolean;
begin
 a:=erp_pos.access(p_user_id,false); v_role:=a->>'role';
 v_unique:=coalesce(erp_preferences.get('pdv.usuarios_caixa_unico'),'[]'::jsonb)?p_user_id::text;
 select * into st from erp_pos.settings where singleton;
 return jsonb_build_object('entity','pos_context','data_mode','erp_native','today',erp_pos.today(),'role',v_role,
  'permissions',a-'role'-'seller_id',
  -- Efeitos que o perfil lança ao finalizar (as RPCs de estoque e do financeiro conferem o perfil de novo).
  'effects',jsonb_build_object('stock',v_role in('admin','estoque'),'finance',v_role in('admin','financeiro'),'cash',v_role in('admin','financeiro'),
   'fiscal',v_role in('admin','fiscal'),'settings',v_role='admin','contacts',v_role in('admin','vendas','financeiro')),
  'settings',jsonb_build_object(
   'tables',erp_pos.pref_flag('pdv.controle_mesas'),'cash_control',erp_pos.pref_flag('pdv.controle_caixa'),'cash_check_methods',erp_pos.pref_flag('pdv.dinheiro_cheque'),
   'unique_cash',v_unique,'default_operation',coalesce(erp_preferences.get('pdv.operacao_padrao')#>>'{}','nenhum'),
   'default_method',coalesce(erp_preferences.get('pdv.metodo_pagamento')#>>'{}','nenhum'),'receipt_order',coalesce(erp_preferences.get('pdv.ordem_comprovante')#>>'{}','insercao'),
   'percent_discount',erp_pos.pref_flag('pdv.desconto_percentual'),'closing_statuses',coalesce(erp_preferences.get('pdv.situacoes_fechamento'),'["atendido","verificado"]'::jsonb),
   'negative_stock',erp_pos.pref_flag('pdv.estoque_negativo'),'block_zero',erp_pos.pref_flag('pdv.bloquear_quantidade_zero'),
   'item_discount',erp_pos.pref_flag('pdv.desconto_item'),'group_items',erp_pos.pref_flag('pdv.agrupar_itens'),'shortcuts',erp_preferences.get('pdv.teclas_atalho'),
   'sales_negative_stock',erp_pos.pref_flag('vendas.estoque_negativo'),'free_items',coalesce(erp_preferences.get('vendas.produtos_nao_cadastrados')<>'false'::jsonb,true),
   'seller_required',erp_pos.pref_flag('vendas.vendedor_obrigatorio')),
  'receipt',jsonb_build_object('limit_description',erp_pos.pref_flag('vendas.comprovante_limitar_descricao'),'code',erp_pos.pref_flag('vendas.comprovante_codigo'),
   'notes',erp_pos.pref_flag('vendas.comprovante_observacao'),'comments',erp_pos.pref_flag('vendas.comprovante_comentario'),'discount',erp_pos.pref_flag('vendas.comprovante_desconto'),
   'footer',nullif(btrim(coalesce(erp_preferences.get('vendas.comprovante_rodape')#>>'{}','')),''),'font_size',coalesce((erp_preferences.get('vendas.comprovante_fonte')#>>'{}')::integer,12)),
  'stores',(select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'name',x.name) order by lower(x.name),x.id),'[]'::jsonb)
   from(select a.id,left(a.name,200) name from erp_finance.account a where a.kind='cash' and a.active and a.deleted_at is null order by lower(a.name),a.id limit 100) x),
  'accounts',(select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'name',x.name,'kind',x.kind) order by lower(x.name),x.id),'[]'::jsonb)
   from(select a.id,left(a.name,200) name,a.kind from erp_finance.account a where a.active and a.deleted_at is null order by lower(a.name),a.id limit 200) x),
  'cash_sessions',(select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'account_id',c.account_id,'account_name',left(a.name,200),'operator_id',c.operator_id,
    'operator_name',erp_activity.actor_label(c.operator_id),'opened_at',c.opened_at,'opened_on',c.opened_on,'change_cents',c.change_cents::text,'version',c.version,'own',c.operator_id=p_user_id)
    order by lower(a.name),c.opened_at,c.id),'[]'::jsonb)
   from erp_finance.cash_session c join erp_finance.account a on a.id=c.account_id where c.state='open' and c.deleted_at is null and erp_pos.usable_session(p_user_id,c)),
  'methods',(select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'description',m.description,'payment_type',m.payment_type,'destination',m.destination,'account_id',m.account_id,
    'condition',m.condition,'is_default',m.is_default) order by m.is_default desc,lower(m.description),m.id),'[]'::jsonb)
   from(select * from erp_catalog.payment_method m where m.active and m.deleted_at is null and m.applicable in('recebimentos','ambos') order by m.is_default desc,lower(m.description),m.id limit 200) m),
  'warehouses',(select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'name',x.name) order by lower(x.name),x.id),'[]'::jsonb)
   from(select r.id,left(r.name,200) name from erp_catalog.record r join erp_catalog.warehouse w on w.record_id=r.id where r.active order by lower(r.name),r.id limit 100) x),
  'default_warehouse',(select jsonb_build_object('id',r.id,'name',left(r.name,200)) from erp_stock.warehouse_default x join erp_catalog.record r on r.id=x.warehouse_id where r.active),
  'seller',(select jsonb_build_object('id',x.id,'name',left(r.name,200)) from erp_catalog.seller x join erp_catalog.record r on r.id=x.contact_id where x.user_id=p_user_id),
  'consumer',(select jsonb_build_object('id',r.id,'name',left(r.name,200),'active',r.active) from erp_catalog.record r where r.id=st.consumer_contact_id),
  'pix',case when st.pix_key is null then null else jsonb_build_object('key_type',st.pix_key_type,'key',st.pix_key,'merchant_name',st.pix_merchant_name,'merchant_city',st.pix_merchant_city) end,
  'certificate',erp_pos.certificate_state(),'settings_version',st.version);
end $$;

-- ---------------------------------------------------------------- Configurações e favoritos
create function public.erp_pos_settings_execute(p_user_id uuid,p_command_id uuid,p_action text,p_data jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare a jsonb; v_hash text; c erp_pos.command%rowtype; v_result jsonb; v_before jsonb; st erp_pos.settings%rowtype; v_contact uuid; v_product uuid; v_type text; v_key text;
begin
 a:=erp_pos.access(p_user_id,true);
 if p_command_id is null or p_action is null or p_action not in('settings_save','favorite_add','favorite_remove') or p_data is null or jsonb_typeof(p_data)<>'object' or octet_length(p_data::text)>8192 then
  raise exception 'erp_pos_invalid_action' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'scope','settings','action',p_action,'data',p_data)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(hashtextextended('erp_pos:'||p_command_id::text,0));
 select * into c from erp_pos.command where id=p_command_id;
 if found then
  if c.actor<>p_user_id or c.request_hash<>v_hash then raise exception 'erp_pos_command_conflict' using errcode='40001'; end if;
  return c.result||jsonb_build_object('replayed',true);
 end if;
 if p_action='settings_save' then
  -- Cliente padrão (consumidor não identificado) e chave Pix do QR estático: só o administrador.
  if a->>'role'<>'admin' then raise exception 'erp_pos_access_denied' using errcode='42501'; end if;
  perform erp_pos.keys(p_data,array['expected_version','consumer_contact_id','pix_key_type','pix_key','pix_merchant_name','pix_merchant_city'],
   array['expected_version','consumer_contact_id','pix_key_type','pix_key','pix_merchant_name','pix_merchant_city']);
  select * into st from erp_pos.settings where singleton for update;
  if st.version<>erp_pos.int(p_data,'expected_version',0,2147483646) then raise exception 'erp_pos_version_conflict' using errcode='40001'; end if;
  v_contact:=erp_pos.uid(p_data,'consumer_contact_id');
  if v_contact is not null and v_contact is distinct from st.consumer_contact_id and not exists(select 1 from erp_catalog.record r join erp_catalog.contact x on x.record_id=r.id where r.id=v_contact and r.active) then
   raise exception 'erp_pos_invalid_contact' using errcode='22023'; end if;
  v_type:=erp_pos.txt(p_data,'pix_key_type',10); v_key:=erp_pos.txt(p_data,'pix_key',77);
  if (v_type is null)<>(v_key is null) or (v_type is not null and v_type not in('cpf','cnpj','email','phone','random'))
   or (v_type='cpf' and v_key!~'^[0-9]{11}$') or (v_type='cnpj' and v_key!~'^[0-9]{14}$') or (v_type='phone' and v_key!~'^\+[0-9]{12,13}$')
   or (v_type='email' and(v_key!~'^[^@ ]+@[^@ ]+\.[^@ ]+$' or length(v_key)>77))
   or (v_type='random' and v_key!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
   raise exception 'erp_pos_invalid_pix_key' using errcode='22023'; end if;
  v_before:=to_jsonb(st)-'singleton';
  update erp_pos.settings set consumer_contact_id=v_contact,pix_key_type=v_type,pix_key=v_key,
   pix_merchant_name=case when v_key is null then null else erp_pos.txt(p_data,'pix_merchant_name',25,true) end,
   pix_merchant_city=case when v_key is null then null else erp_pos.txt(p_data,'pix_merchant_city',15,true) end,
   version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where singleton returning * into st;
  v_result:=jsonb_build_object('entity','pos_settings','record',jsonb_build_object('version',st.version,'consumer_contact_id',st.consumer_contact_id,'pix_key_type',st.pix_key_type,
   'pix_key',st.pix_key,'pix_merchant_name',st.pix_merchant_name,'pix_merchant_city',st.pix_merchant_city));
 else
  perform erp_pos.keys(p_data,array['product_id'],array['product_id']);
  v_product:=erp_pos.uid(p_data,'product_id',true);
  perform pg_advisory_xact_lock(hashtextextended('erp_pos:favorites',0));
  if p_action='favorite_add' then
   if not exists(select 1 from erp_catalog.record r join erp_catalog.product x on x.record_id=r.id where r.id=v_product and r.active) then raise exception 'erp_pos_invalid_product' using errcode='22023'; end if;
   if not exists(select 1 from erp_pos.favorite where product_id=v_product) then
    if (select count(*) from erp_pos.favorite)>=200 then raise exception 'erp_pos_favorites_limit' using errcode='22023'; end if;
    insert into erp_pos.favorite(product_id,created_by) values(v_product,p_user_id);
   end if;
  else
   delete from erp_pos.favorite where product_id=v_product;
  end if;
  v_result:=jsonb_build_object('entity','pos_favorites','record',jsonb_build_object('product_id',v_product,'favorite',p_action='favorite_add'));
 end if;
 perform erp_pos.access(p_user_id,true);
 v_result:=v_result||jsonb_build_object('action',p_action,'data_mode','erp_native','replayed',false);
 insert into erp_pos.command(id,actor,scope,request_hash,result) values(p_command_id,p_user_id,'settings',v_hash,v_result);
 insert into erp_pos.audit(actor,command_id,action,before_data,after_data) values(p_user_id,p_command_id,p_action,v_before,v_result);
 return v_result;
end $$;

-- Ver favoritos: Descrição, Código, Unidade, Preço e Estoque (saldo físico do depósito escolhido; sem lançamentos, null).
create function public.erp_pos_favorites(p_user_id uuid,p_warehouse_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 perform erp_pos.access(p_user_id,false);
 return jsonb_build_object('entity','pos_favorites','data_mode','erp_native','warehouse_id',p_warehouse_id,
  'items',(select coalesce(jsonb_agg(jsonb_build_object('product_id',r.id,'name',left(r.name,200),'code',left(r.code,60),'unit',left(p.unit,16),'price',p.price::text,'gtin',left(p.gtin,14),
    'active',r.active,'kind',p.kind,'stock',case when p_warehouse_id is null then (select sum(b.quantity)::numeric(18,6)::text from erp_stock.balance b where b.product_id=r.id)
      else (select b.quantity::numeric(18,6)::text from erp_stock.balance b where b.product_id=r.id and b.warehouse_id=p_warehouse_id) end)
    order by lower(r.name),r.id),'[]'::jsonb)
   from erp_pos.favorite f join erp_catalog.record r on r.id=f.product_id join erp_catalog.product p on p.record_id=r.id));
end $$;

-- Vendas do PDV: as do caixa (coluna "Pedidos" e Buscar venda), as abertas (pré-vendas e mesas) ou por período; pesquisa por
-- número do pedido ou nome do cliente. 50 por página.
create function public.erp_pos_sales(p_user_id uuid,p_session uuid default null,p_state text default 'all',p_query text default null,
 p_from date default null,p_to date default null,p_method uuid default null,p_page integer default 1,p_limit integer default 50) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_query text:=lower(nullif(btrim(p_query),'')); v_total bigint; v_items jsonb;
begin
 perform erp_pos.access(p_user_id,false);
 if p_state is null or p_state not in('all','open','finished','cancelled') or p_page is null or p_page not between 1 and 10000 or p_limit is null or p_limit not between 1 and 50
  or length(p_query)>120 or p_query~'[[:cntrl:]]' or(p_from is not null and p_to is not null and p_from>p_to) or p_from<date '1900-01-01' or p_to>date '2100-12-31' then
  raise exception 'erp_pos_invalid_query' using errcode='22023'; end if;
 with filtered as materialized(
  select s.id,s.created_at from erp_pos.sale s join erp_documents.document d on d.id=s.document_id
  where(p_session is null or s.cash_session_id=p_session) and(p_state='all' or s.state=p_state)
   and(p_from is null or (s.created_at at time zone 'America/Sao_Paulo')::date>=p_from) and(p_to is null or (s.created_at at time zone 'America/Sao_Paulo')::date<=p_to)
   and(p_method is null or exists(select 1 from erp_pos.sale_payment p where p.sale_id=s.id and p.payment_method_id=p_method))
   and(v_query is null or d.number::text=v_query or strpos(lower(coalesce(d.contact_snapshot->>'name','')),v_query)>0 or s.table_number::text=v_query)
 ) select(select count(*) from filtered),(select coalesce(jsonb_agg(erp_pos.sale_view(x.id,false) order by x.created_at desc,x.id),'[]'::jsonb)
   from(select * from filtered order by created_at desc,id limit p_limit offset(p_page-1)*p_limit) x) into v_total,v_items;
 return jsonb_build_object('entity','pos_sales','data_mode','erp_native','session_id',p_session,'state',p_state,'from',p_from,'to',p_to,'method_id',p_method,
  'page',p_page,'limit',p_limit,'total',v_total,'items',v_items);
end $$;

create function public.erp_pos_sale_get(p_user_id uuid,p_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 perform erp_pos.access(p_user_id,false);
 if p_id is null or not exists(select 1 from erp_pos.sale where id=p_id) then raise exception 'erp_pos_not_found' using errcode='P0002'; end if;
 return jsonb_build_object('entity','pos_sale','data_mode','erp_native','record',erp_pos.sale_view(p_id,true));
end $$;

revoke all on all functions in schema erp_pos from public,anon,authenticated,service_role;
do $$declare f text;begin
 foreach f in array array['erp_pos_context(uuid)','erp_pos_settings_execute(uuid,uuid,text,jsonb)','erp_pos_favorites(uuid,uuid)',
  'erp_pos_sales(uuid,uuid,text,text,date,date,uuid,integer,integer)','erp_pos_sale_get(uuid,uuid)'] loop
  execute format('revoke all on function public.%s from public,anon,authenticated',f);
  execute format('grant execute on function public.%s to service_role',f);
 end loop;
end$$;
commit;
