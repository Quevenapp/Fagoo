-- Commercial mirrors: database authority, effect barriers, seller scope and origin-aware reads.
-- The NOLOGIN writer can only maintain observations. No posting, receipt, conversion or attachment
-- can reference an externally authoritative document, even through a legacy service-role RPC.
begin;
do $$declare r record;begin
 if to_regclass('erp_documents.origin_mirror')is null then raise exception 'document_mirror_007_requires_006';end if;
 for r in select * from(values
 ('erp_documents.dto(uuid)','33eb58cc253d726c5e7c232f6f1fcd7d63173d8530050131fcde562ddce04431'),
 ('erp_documents.document_view(uuid)','da47a4103c02ce0588664e52c3014ccab01473b5ef1c236734de60b365185ef9'),
 ('erp_documents.summary(uuid)','fc8dea648da00066e719eaaac3dd99156c0a8592fe920049c7dfe7b4cf690fbb'),
 ('erp_documents.list_row(uuid,boolean,boolean)','922b58ff3c239f8e6edb88ed28ba998fdc9f9a83a35291c14058787e5fa6024e'),
 ('public.erp_document_get(uuid,text,uuid)','921f08947dba4d3730c7bc5f3ddba4ac8a8ffee836ea1bae4fde2a7847b76513'),
 ('public.erp_document_copy_origin(uuid,text,uuid)','9c49b90074cc660331acfedf6b8f64c925671457f6441461ef5b69ed79c1283a'),
 ('public.erp_document_finance_get(uuid,text,uuid,uuid)','4a47720c57d36c55e4b14cb680736cbb61c7c0f48bca6bef5858cd18faaf5785'),
 ('public.erp_document_finance_list(uuid,text,uuid,integer,uuid)','ab20f9022ba3447fabd043d6bd9542990ee6eac926c0eea8835b93f7f2152e7b'),
 ('public.erp_document_freight_paid_get(uuid,text,uuid)','a2998a2a680998a77ab20dba2731eec0822282a71e171c1c4935c59b1e667c07'),
 ('public.erp_document_commission_operation(uuid,text,uuid)','f2bb142f1b6f9952b5ef7bcd8590b1608c146d164523d0612e15cd6a064c689d'),
 ('public.erp_document_occurrence_list(uuid,text,uuid)','8216fcc40b7529f7ad67fbb56e8945c582eee9b3c8cf189dc5d3271558619b12'),
 ('public.erp_document_pendencies(uuid,text,uuid)','f9e352ae38b41308a94d9cc2c5453b7d46ad1713ea0d19253913379bb25b7755'),
 ('public.erp_document_invoice_balance(uuid,uuid)','f0e0e224b56989e31cf99f049620f40b8048ae5c4933c918d90099044224327c'),
 ('public.erp_document_stock_get(uuid,text,uuid,integer,uuid)','0cdadc18c2bfd32b5875354d57c344cd84c4dd2959683ea16804ba73930a7b92'),
 ('public.erp_document_structures(uuid,text,uuid)','c7fdcbc892939aa489bacbfe2fe344f8702a92cb431456d2b09cc46b0abc59dc'),
 ('public.erp_document_supplier_descriptions(uuid,text,uuid)','5968d0e47478655a317a8028521fcb7a227e6d9218ebbbb1a3f60cf173fedf4f'),
 ('public.erp_document_checkout_get(uuid,uuid)','56c5aa27e369b21566de606bba5d4a45de710ff61ea2da4b8c087fb31895c852'),
 ('public.erp_fiscal_invoice_order_items(uuid,uuid,uuid)','3cc2c65203643d244fff80214fec7128a81ae0d6bbc0cb1ae16c2f78300dce72'),
 ('public.erp_fiscal_invoice_order_source(uuid,uuid,text)','09b5b19fdeaf7a6a95bcc66c89355ee7dfec9fac3ead7bf0eb08fb9ce49da053'),
 ('public.erp_fiscal_invoice_order_source_v2(uuid,uuid,text)','a3ee9c16c7f286350e4c7cdb269e25b55bd6757d37d01e7a95d0c75108c9e0f4'),
 ('public.erp_fiscal_invoice_order_source_v3(uuid,uuid,text)','fff2afb4b01ae6e03ce44a4cec19252ac763d525cc6910c0e1f418b6370b2b55'),
 ('public.erp_stock_reservation_get(uuid,uuid,integer,uuid)','60ee80af946905a97601a5668732b59685ce6e7c80ba609ac6be8ebea81be22c'),
 ('public.erp_stock_item_components(uuid,uuid,uuid)','2bc6bacc898290f96d7a6ca1a2c8887e5fb0b401941eb9d89412692fdf072f28'),
 ('public.erp_purchase_receipts_get(uuid,uuid,integer,uuid,uuid)','a2f7a53490f71c050620a0b9813b268f81158366de3f72ddc4e40ff739244fc1'),
 ('public.erp_service_event_get(uuid,uuid,uuid)','da3a4e331e7f4f104fa3201cbb66996d1202842095993b76ed2bec7a2c5224b6'),
 ('public.erp_service_event_list(uuid,uuid,integer,text)','553e53544e1d1bdab306821a2974b93f0555ce793ce842e5aaca4c98f5cae77f'),
 ('public.erp_service_journal_get(uuid,uuid,uuid)','86affc2db4eb559770f4e00a5f11afad219ac87d2b588f6f4b198bee1b86993a'),
 ('public.erp_service_journal_list(uuid,uuid,integer,text)','8f90ba6850bbd1b57e3cd01f187869a9f2450a32e28095f154589fe1dabd75dd'),
 ('public.erp_origin_proposal_document_origin(uuid,uuid)','08f294da16a31ee21c8ee32c96073e6e0b0e2d5385997200611d7c95b7c8483d'),
 ('public.erp_document_save(uuid,text,uuid,integer,uuid,jsonb)','b3e5c979ff770ae10103136c87e07646b7fe7be2d227f347eb206c1579d2fdb3'),
 ('public.erp_document_transition(uuid,text,uuid,integer,uuid,text,text)','d672aaea4a0a024371173c854874f6c62c8bdb82758dcb859644b8ea8eb17b97'),
 ('public.erp_document_notes_save(uuid,text,uuid,integer,uuid,text,text)','f5505ba180c944b7063e0405949ee19e6313083d47554f6eccfa18f9132d7ab7'),
 ('public.erp_document_copy(uuid,text,uuid,integer,uuid,jsonb)','0227515dca10e4838fb2127177811cda06ab2729a13eb9824fb8f183d02b96ba'),
 ('public.erp_document_copy_preview(uuid,text,uuid)','879a4eb430cf2d6626623fa70b4bd477e48cc4824ebd72939620c959b884ec35'),
 ('public.erp_document_conversion_preview(uuid,text,uuid)','1411b9f382040ff36d44492a01f21208746f6be79bd95a1d4ce6fe48e4bd247c'),
 ('public.erp_document_proposal_version(uuid,uuid,integer,uuid,jsonb)','4e4bbce615aa21b79d13c2bee7cf351e832aaa5961fb24cbbb7f83cef493b313'),
 ('public.erp_proposal_convert(uuid,uuid,integer,uuid)','4a5738901b89d22d61e0967bedaf48151e3d99c47204f39fb634c4d697ebc61b'),
 ('public.erp_proposal_convert_to_service(uuid,uuid,integer,uuid)','e6963cdf6c9b5951df7842aa626225956a86718a95b35b9f72e41c167280a315'),
 ('public.erp_sales_order_convert_to_service(uuid,uuid,integer,uuid)','6b120a5b4cc0fc34bba52751a555cbcf741db3423081c4a796ed201a3817fb71'),
 ('public.erp_document_finance_post(uuid,text,uuid,integer,uuid,text,uuid,jsonb)','5b4c5bfac4c521dce8439b87ecfe6ae22385d1969ff57601a6e0624d1a133603'),
 ('public.erp_document_finance_preview(uuid,text,uuid,integer,uuid,jsonb)','7482987e989ebd64efcb520542621c94efb719c64b04ab25b296a7028897adbc'),
 ('public.erp_document_finance_reverse(uuid,text,uuid,integer,uuid,integer,uuid,text,jsonb,text)','88f568ca3ff465a0266683ebd6ac721112fc86b1efb87021b633e90c708ae837'),
 ('public.erp_document_finance_reverse_preview(uuid,text,uuid,integer,uuid,integer)','5a062e203e5bb5bbb70ceae5673f5505d4aaef7a62f33c0e179ff465178ff1f1'),
 ('public.erp_document_stock_post(uuid,text,uuid,integer,uuid,text,date,text,jsonb)','81e235150049566af644364c4b12cab1abd79392a329986bd0b34f8c3cd0d3ef'),
 ('public.erp_document_stock_preview(uuid,text,uuid,integer,date,text)','977490b82ef971443b3c28e5dcbb5bb19944052fa01b5524b56a5a47b23ccd26'),
 ('public.erp_document_stock_reverse(uuid,text,uuid,integer,uuid,integer,uuid,text,date,text)','e1126d580f1d37b14635ec7a3f0d8507e7d7c89759ddb9ba9366c70216edafac'),
 ('public.erp_document_stock_reverse_preview(uuid,text,uuid,integer,uuid,integer,date,text)','39582395bc0ea51cddfdf1d2e07cebaa331d6fde2fba96e745385f8398cb87b1'),
 ('public.erp_document_freight_paid_save(uuid,text,uuid,integer,uuid,jsonb)','bc0f7ba3fd78da31f3db47c2c55190b9eb0ddd60925d75cdf665c96a80e1cf91'),
 ('public.erp_document_occurrence_add(uuid,text,uuid,integer,uuid,text,text,text,text,text)','b5895cbc2e1c2fe8e5b85a33525e0f70d424f6204e63fc0b7c27ad394c0394fd'),
 ('public.erp_document_occurrence_remove(uuid,text,uuid,uuid,uuid)','f3b223b16274e17c3810930e39f6ddcfa32b2e2c635abbd5b6f0623bbcfc4c40'),
 ('public.erp_document_checkout_save(uuid,uuid,integer,integer,uuid,jsonb)','b513d3699536e9b2d7eb7465fe2a350823b66e8c97eb3b84ce33ec69821b3e22'),
 ('public.erp_fiscal_invoice_partial_create(uuid,uuid,uuid,jsonb)','5e3f888fc62ae210f34274b5ad28e6e8c1d519230a8069828c3376aef9b99ff6'),
 ('public.erp_stock_document_warehouse_post(uuid,text,uuid,integer,uuid,uuid,text,date,text,jsonb)','376658d25275681539860bc9c89c3636cd5544c866e38acbf7c9bf929cd17db4'),
 ('public.erp_stock_document_warehouse_preview(uuid,text,uuid,integer,uuid,date,text)','48cdec5fbed528656ba92e51e6342cc7db049e53d4e22cdf2e1c37692882a573'),
 ('public.erp_stock_item_components_save(uuid,uuid,uuid,integer,uuid,integer,jsonb)','2f93d235361dfa84231c023ad30aae6d0024e836748408f6e6c3d390157969bb'),
 ('public.erp_stock_purchase_receive_preview(uuid,uuid,integer,uuid,date,text,jsonb)','aa59b05fca89f4ea19c55836f8e10770d0f2c3e9a56cb07f53316c942a6dfe8f'),
 ('public.erp_stock_purchase_reverse_all(uuid,uuid,uuid,integer)','1dbd2d70fa70b11730eea6e9cf7a7bd7b2db436b4e8891da31a0aebcec976abb'),
 ('public.erp_stock_reservation_apply(uuid,uuid,integer,uuid,text,text,date,text,jsonb,uuid,integer)','1067692daa608fcc7c7c985d0b7df7133feb8281039c1d594e0ae27641e5490a'),
 ('public.erp_stock_reservation_preview(uuid,uuid,integer,text,date,text,uuid,integer)','fcf1a9fdf0f0218b185af85235ed082b59ce0e8c39b18a7b42a4c1763feb7afa'),
 ('public.erp_purchase_receipts_receive(uuid,uuid,integer,date,text,jsonb,uuid,text,boolean)','2932ed67ec14d6498010b420adca5bc88d856511e92d2969af76999244b75f17'),
 ('public.erp_purchase_receipts_preview(uuid,uuid,integer,date,text,jsonb)','bb19ffb8ffc4e6129e1124f54bd2f77fcb9aca4ff2404c050a152801eb253b0b'),
 ('public.erp_purchase_receipts_reverse(uuid,uuid,integer,uuid,date,text,uuid,text,boolean)','43784d2c2830d86f20e6bdaabc0a99d163cb8dfa82cf318f0360fe208c570df8'),
 ('public.erp_purchase_receipts_reverse_preview(uuid,uuid,integer,uuid,date,text)','12a7a8e3fce088a9a188cad1636baabeeb04ac8fdb3e9accdbeac258fac65ace'),
 ('public.erp_service_event_append(uuid,uuid,integer,uuid,jsonb)','b23e776ad941f4f53f4878a331031749d999fdb6813b5aaed1c78772178748c0'),
 ('public.erp_service_journal_append(uuid,uuid,integer,uuid,text)','3417fe01d9943b1f60ada817ea59ed94099ea7c0013ba17b1f6e4da1fe7b70d6'),
 ('public.erp_origin_proposal_import_apply(uuid,text,text,uuid,boolean,boolean)','c0bd8a08357f38c55e52c07978882da9158bfc3217e6633613b224569f8c031b'),
 ('public.erp_origin_proposal_import_apply_v2(uuid,text,text,uuid,boolean,boolean)','c11f3ad97e6785c870e4ee43768e55a3cefb58a698b8a36b7374afbd9365050b'),
 ('erp_attachments.authorize(uuid,text,uuid,boolean)','7ba0a1e71536670a2ae702f4daf0f4dee21a0e182055eb972658820b2126b16a'),
 ('erp_documents.service_journal_context(uuid,uuid,boolean)','f447af3307893c4100515575e8c81db1b0307b3562ae8cdc7b92bfecab91390e'),
 ('erp_documents.service_event_context(uuid,uuid)','d5cee4d500085256a047b2426f144006e9eddbf36ee27ad495abd53d3b6fabc4'),
 ('public.erp_document_stock_list(uuid,text,integer,uuid,text)','7160e231f4d66f80d400500b678dec7d3ee56f6038855156fb6bb3aed7b1063b'),
 ('public.erp_fiscal_invoice_order_link_states(uuid,jsonb)','4709c81cb4acab986a248819f2106ef49d58118523c0b22d14c31939580f3b89'),
 ('public.erp_preferences_label_records(uuid,text,text)','83b6f95af2a98457cb8f3c67504a9aa3266376966e6c50f09621aa07f0e77622'),
 ('erp_documents.numbering_dto(text)','8cf14164dcfdb0cf15a78905daf3107b9195570ba797ae6395d51e03010631ad'),
 ('public.erp_document_numbering_set(uuid,text,uuid,text,text)','633746bbb3dbfb73bc262a903b87c69c582519daa0c732909e611f8ebdd23b06'),
 ('erp_preferences.report_source(text)','a4eee98fa52cf69a51ac334aae14139eb2a040f62881a96f1ff76b3a61922cba'),
 ('erp_home.biz_new_customers(date,text[])','929ffb91df1acbf6e2476037c5146a9b58cbac84187e3d94755f03817c00bf79'),
 ('erp_home.notification_digest(text,date)','2046dd5eafc5b1de41f18d97ef131f97d125f86c138859b6d706fb1e6e4e66fa'),
 ('erp_home.biz_unit_cost(uuid)','53b1585de1e1214f483f1ad1ef66744d602c2b918b7a70d786adf1fbc7875f62'),
 ('public.erp_catalog_product_purchase_info(uuid,uuid[],uuid)','908d58e68248841a11436832128c4555ca3f44ad8c1824d53b23dcaf432c8cd2'),
 ('public.erp_document_access(uuid)','8f3d0afee0b4dc252fc2b2600c98755d112f636ab41b7b44efe86b252fd11b12'),
 ('public.erp_stock_source_lots(uuid,text,uuid,uuid)','3c685b73a79b0e6e56b4317e9a84e695a0c670d3fea0edac6019b031ace1d64d'),
 ('public.erp_preferences_report_run(uuid,text,jsonb,jsonb,integer,integer,integer)','cd95c4f13d3c6470834bdfa38a0afbe8c5aa520efb98c93b47d04dd924e1a74f'),
 ('public.erp_fiscal_draft_execute(uuid,uuid,text,jsonb)','9aac2d1a23071d4b30475d18b4a5c6c0d1db5506dbd7a398c4a589da642d0a57'),
 ('public.erp_fiscal_invoice_link(uuid,uuid,jsonb)','e439a18f02408b76b2cbf9455f815adfc4d264a5f897fcac0cd9d5d6bae04dbc'),
 ('public.erp_document_trash(uuid,uuid,text,text,jsonb,text)','9bc3a15b911c6781e891b1d2732edd2062e8840d32c1d638f02c4feebb6b3c32'),
 ('public.erp_finance_grouped_billing_execute(uuid,uuid,text,jsonb)','7b8fcf0b743e84c99ac0bf08a46066cd80d699562a24b49bf66057144969c0f1'),
 ('public.erp_document_history(uuid,text,uuid,uuid,text,integer)','f5a2ef5c0188bf0c1fa9a8a391bf2e268f5cf17e6e31bad31335cbde70bef37e'),
 ('public.erp_document_export(uuid,text,text,text,integer)','8052bf705ba7cfef5b9cbd41a54be62ea413df67371e5a49ca9a5a489d630615'),
 ('public.erp_document_sales_report(uuid,jsonb)','dd9c9251d4c2b2f55c1620475362079a2d51f22e4b240846b1a91c1cd47ea9dd'),
 ('public.erp_document_sales_abc(uuid,text,text)','adb5b07fbb69c5d524b4925a681dfef01d635263f5a8ed5d2b6b16e7cf8acc14'),
 ('public.erp_document_service_report(uuid,jsonb)','70a6519d872e6610c29f08aa64e4f69c82163166ef862c358c21ea11330e9bdc'),
 ('public.erp_document_service_occurrence_report(uuid,text,text,text)','cbcd8cfc94174cd02bfdbe43bd5a97931e14b8662cf16ea35bc5913641a030b1'),
 ('public.erp_document_sales_romaneio(uuid,jsonb)','3d9017449d1c61bee63385698fda4e979124df958d0548f3147fc48f794d970c'),
 ('erp_home.biz_orders(date,date,text[])','dca3ff1e1f007184a6fc133ce62d9baa2ff24fd8f2b8a3b48eb275fac3749048'),
 ('public.erp_home_summary(uuid)','778b63f1b7b3b20de68dafe2eaf941d6ad36e8744e387640f5d4c3eedcd1188b'),
 ('public.erp_home_overview(uuid,text,text,text)','e1cd325616b8c62779d86accd03945b342d18b95440d9528f4ccf3af8f4167e4'),
 ('public.erp_home_top_products(uuid,text,text,text)','eefa928f1421562cf7b636792f2eb14a7a7ec027cc6e25cf5805bd9bac8fc0c7'),
 ('public.erp_home_business_customers(uuid,jsonb,date,date)','5fe5966c3346724fcc87ca2485e4b37d33c2930c37e18e3993658c1ce629f219'),
 ('public.erp_home_business_goals(uuid,text)','34886ab817e99cb9ec6f700ba0ce20ba14cfd78ad48819c1f18c1a7277c77769'),
 ('public.erp_stock_purchase_suggestion(uuid,date,date,integer,uuid,boolean,jsonb,jsonb,text,uuid)','13007013064860460cc4c5e9ab06648017e6f726dbf3589d7a7bf4eceb19b45f'),
 ('public.erp_stock_report_purchase_orders(uuid,date,date,jsonb,text)','69467fc55261bfcd26528b5d4bad44f23674bbafbc5736e46f2f792fd4f6653f'),
 ('public.erp_finance_grouped_billing_candidates(uuid,date,date,uuid[],text,integer,integer)','0c5d796bd7ba1687cd5085b256837d3ee5210b4c239dd5c9741a0f17d1cab84b'),
 ('public.erp_finance_grouped_billing_documents(uuid,uuid,date,date,uuid[])','4c68fda9485cee1c87e4622a594018b5ce8b7b315e5f20d417ad1a2e3ae72a8a'),
 ('public.erp_catalog_contact_history(uuid,uuid,text)','2a17373fc793b013156c77d513b3c8ab7059adf3eba8f249f4a48ab72186c268'),
 ('public.erp_catalog_contact_sales(uuid,uuid)','dfe3b97d8c3a2ebb7c2cbcd7256b2d98c23b96ae6c63f4e17a1eba3947a5ff4e'),
 ('public.erp_home_business_channels(uuid)','0cbf7b192f4515c348d75609d887a1b9d513c2cee6c69265a88a728f2b986766'),
 ('public.erp_home_business_forecast(uuid,date,date,uuid,boolean)','46fc9b4bd1e2e5dca3b9dcfdc5ccc396461437cd73f5b8e6634144ab67cdfd48'),
 ('public.erp_home_business_forecast_v2(uuid,date,date,uuid,boolean,text)','5ab847d9287ebcc3330bc728f071ce0f4be82ba2d5ddcf29c9db3e07696df7ce'),
 ('public.erp_home_business_margin(uuid,jsonb,date,date,text)','8003b73ca1ec0ffcea2508f2d4332486eea8ec1c6d6a01a6c0304f567edd544e'),
 ('public.erp_home_business_monthly(uuid,jsonb,date,date,date,date)','4f8650d2dde7edd5809980ffa5528973f5193c5b4173937ea010662e628fbcf3'),
 ('public.erp_home_business_orders(uuid,jsonb,date,date,text)','290eb8d86f66b4294a8c77031e403c63f721bc247c8cc861d757fc187a182e65'),
 ('public.erp_home_business_portfolio(uuid,date,date,text,integer,jsonb)','4814c1cddeac2bf84c0098361d4fd3b3536291ba86a1ac2f674bf2f741d78749'),
 ('public.erp_home_business_sellers(uuid,jsonb,date,date,text)','873ed43e77c80058408c88e92939a1a7f6f5c31bed82492b0e1291750e5c38d3'),
 ('public.erp_document_list(uuid,text,integer,uuid,text,text,text,text,integer,text,text[],text,uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,boolean,text[],uuid,uuid,uuid,text[],jsonb)','654c7bd89e4ab8361f3ed655dc911ff19d1bf9a34785dbc9f6470069bfc26fe5')
 )v(sig,expected)loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex')from pg_proc where oid=to_regprocedure(r.sig))is distinct from r.expected then
   raise exception 'document_mirror_007_previous_definition_changed %',r.sig using errcode='55000';end if;
 end loop;
end$$;

create function erp_document_mirror.writing() returns boolean
language sql stable set search_path=pg_catalog as $$
 select current_user='erp_document_mirror_writer' and current_setting('erp_mirror.writer',true)='document_mirror'
$$;

create function erp_document_mirror.visible(p_user uuid,p_document uuid) returns boolean
language sql stable set search_path=pg_catalog as $$
 select coalesce((select case when d.origin='origin' then
  erp_catalog.contact_visible_to(erp_catalog.contact_scope(p_user),d.contact_id)
  else erp_documents.contact_usable(p_user,d.contact_id) end
 from erp_documents.document d where d.id=p_document),false)
$$;

-- Native readers retain their existing rules. Mirror checks run before idempotent replay as well.
create function erp_document_mirror.require_visible(p_user uuid,p_document uuid,p_write boolean default false) returns void
language plpgsql stable set search_path=pg_catalog as $$
begin
 if exists(select 1 from erp_documents.document d where d.id=p_document and d.origin='origin') then
  if not erp_document_mirror.visible(p_user,p_document) then raise exception 'erp_document_not_found' using errcode='P0002';end if;
  if p_write then raise exception 'erp_document_mirror_readonly' using errcode='42501';end if;
 end if;
end$$;

create function erp_document_mirror.guard_document() returns trigger
language plpgsql set search_path=pg_catalog as $$
begin
 if tg_op='DELETE' then
  if old.origin='origin' or old.authority='origin' then raise exception 'erp_document_mirror_readonly' using errcode='42501';end if;
  return old;
 end if;
 if tg_op='UPDATE' and old.origin='origin' and (new.origin<>old.origin or new.authority<>old.authority or new.id<>old.id or new.kind<>old.kind) then
  raise exception 'erp_document_mirror_identity_immutable' using errcode='42501';end if;
 if new.origin='origin' or new.authority='origin' or (tg_op='UPDATE' and old.authority='origin') then
  if not coalesce(erp_document_mirror.writing(),false) or new.origin<>'origin' or new.authority<>'origin' then
   raise exception 'erp_document_mirror_readonly' using errcode='42501';end if;
 elsif coalesce(erp_document_mirror.writing(),false) then
  raise exception 'erp_document_mirror_writer_native_denied' using errcode='42501';
 end if;
 if new.source_proposal_id is not null and exists(select 1 from erp_documents.document d where d.id=new.source_proposal_id and d.authority='origin') then
  raise exception 'erp_document_mirror_effect_forbidden' using errcode='42501';end if;
 return new;
end$$;
create trigger aa_mirror_authority before insert or update or delete on erp_documents.document for each row execute function erp_document_mirror.guard_document();

create function erp_document_mirror.guard_item() returns trigger
language plpgsql set search_path=pg_catalog as $$
declare old_mirror boolean:=false;new_mirror boolean:=false;
begin
 if tg_op<>'INSERT' then select d.authority='origin' into old_mirror from erp_documents.document d where d.id=old.document_id;end if;
 if tg_op<>'DELETE' then select d.authority='origin' into new_mirror from erp_documents.document d where d.id=new.document_id;end if;
 if coalesce(old_mirror,false) or coalesce(new_mirror,false) then
  if not coalesce(erp_document_mirror.writing(),false) or (tg_op='UPDATE' and old.document_id<>new.document_id) then
   raise exception 'erp_document_mirror_readonly' using errcode='42501';end if;
 elsif coalesce(erp_document_mirror.writing(),false) then raise exception 'erp_document_mirror_writer_native_denied' using errcode='42501';end if;
 if tg_op='DELETE' then return old;end if;return new;
end$$;
create trigger aa_mirror_authority before insert or update or delete on erp_documents.item for each row execute function erp_document_mirror.guard_item();

-- Every direct document FK is covered below, including old/new IDs on reassignment or removal.
-- SECURITY DEFINER only performs the authority lookup; it grants no writer exception.
create function erp_document_mirror.guard_effect() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare j jsonb;k text;v_document uuid;
begin
 for j in select x from unnest(case tg_op when 'INSERT' then array[to_jsonb(new)] when 'DELETE' then array[to_jsonb(old)] else array[to_jsonb(old),to_jsonb(new)] end) x loop
  foreach k in array tg_argv loop
   v_document:=nullif(j->>k,'')::uuid;
   if exists(select 1 from erp_documents.document d where d.id=v_document and d.authority='origin') then
    raise exception 'erp_document_mirror_effect_forbidden' using errcode='42501';end if;
  end loop;
 end loop;
 if tg_op='DELETE' then return old;end if;return new;
end$$;

create function erp_document_mirror.guard_import() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
begin
 if exists(select 1 from erp_documents.origin_mirror m where m.entity='sales_proposals' and m.source_id=new.source_id)
  or exists(select 1 from erp_documents.document d where d.id=new.document_id and d.authority='origin') then
  raise exception 'erp_document_mirror_import_forbidden' using errcode='42501';end if;
 return new;
end$$;
create trigger aa_mirror_authority before insert or update on erp_documents.origin_import_origin for each row execute function erp_document_mirror.guard_import();

create function erp_document_mirror.detail(p_id uuid) returns jsonb
language sql stable set search_path=pg_catalog as $$
 select d.body||jsonb_build_object('id',d.id,'kind',d.kind,'number',m.source_number,'version',d.version,'status',d.status,
  'contact_id',d.contact_id,'contact_snapshot',d.contact_snapshot,'warehouse_id',d.warehouse_id,'total',m.reconciliation->>'source_total',
  'origin',d.origin,'authority',d.authority,'readonly',true,'mirror',erp_document_mirror.metadata(d.id),
  'created_at',d.created_at,'updated_at',d.updated_at,
  'items',(select coalesce(jsonb_agg(i.data||jsonb_build_object('id',i.id,'position',i.position,'product_id',i.product_id)
    order by i.position),'[]'::jsonb) from erp_documents.item i where i.document_id=d.id))
 from erp_documents.document d join erp_documents.origin_mirror m on m.document_id=d.id where d.id=p_id
$$;

create function erp_document_mirror.list_row(p_id uuid) returns jsonb
language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('id',d.id,'kind',d.kind,'number',m.source_number,'version',d.version,'status',d.status,
  'date',d.body->>'date','expected_date',d.body->>'expected_date','next_contact',d.body->>'next_contact',
  'contact_id',d.contact_id,'contact_name',d.contact_snapshot->>'name','warehouse_id',d.warehouse_id,
  'total',m.reconciliation->>'source_total','origin',d.origin,'authority',d.authority,'readonly',true,'mirror',erp_document_mirror.metadata(d.id),
  'created_at',d.created_at,'updated_at',d.updated_at,'internal_notes',left(d.body->>'internal_notes',1000),
  'finance_active',false,'stock_active',false,'receipt_active',false,'reservation_active',false,'fiscal_draft',false,
  'template',false,'first_sale',false,'pendencies',false,'invoice_linked',false,'invoice',null,'situation',null)
 from erp_documents.document d join erp_documents.origin_mirror m on m.document_id=d.id where d.id=p_id
$$;

create function erp_document_mirror.report_coverage(p_user uuid,p_kind text,p_from text default null,p_to text default null,p_contact uuid default null) returns jsonb
language sql stable set search_path=pg_catalog as $$
 with reader as materialized(select membership.role,erp_catalog.contact_scope(p_user)scope from erp_access.membership membership where membership.user_id=p_user and membership.active),
 readable_kinds as materialized(select k.kind from(values('sales_orders'),('sales_proposals'),('purchase_orders'),('service_orders'))k(kind)cross join reader r
  where(p_kind is null or k.kind=p_kind)and erp_documents.allowed(r.role,k.kind,false)
   and case when k.kind='service_orders'then erp_documents.os_permitted(p_user,null)
    else erp_access.permitted(p_user,case k.kind when'sales_orders'then'vendas.pedidos_venda'when'sales_proposals'then'vendas.propostas'else'suprimentos.pedidos_compra'end)end)
 select jsonb_build_object('origin','brufap','mirror_excluded_count',count(*),'coverage',jsonb_build_object('partial',count(*)>0,'reason','native_effects_only'))
 from erp_documents.document d join erp_documents.origin_mirror m on m.document_id=d.id join readable_kinds k on k.kind=d.kind cross join reader r
 left join erp_catalog.contact_profile cp on cp.record_id=d.contact_id
 where not m.source_deleted and(r.scope is null or cp.seller_id=r.scope)and(p_contact is null or d.contact_id=p_contact)
  and(p_from is null or d.body->>'date'>=p_from)and(p_to is null or d.body->>'date'<=p_to)
$$;

-- erp_documents.document.commission_operation_capture: preserve the legacy predicate and event, skip only the NOLOGIN writer.
do $$begin
 if(select encode(sha256(convert_to(pg_get_triggerdef(t.oid),'UTF8')),'hex')from pg_trigger t where t.tgrelid='erp_documents.document'::regclass and t.tgname='commission_operation_capture')is distinct from '53e1c0ccb55deb9bd4470dac6dd3a5ce6d8f00b7724009f4d176770741cc3735' then raise exception 'document_mirror_007_previous_trigger_changed commission_operation_capture';end if;
end$$;
drop trigger commission_operation_capture on erp_documents.document;
CREATE CONSTRAINT TRIGGER commission_operation_capture AFTER INSERT OR UPDATE ON erp_documents.document DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NOT coalesce(erp_document_mirror.writing(),false) AND ((new.kind = ANY (ARRAY['sales_orders'::text, 'service_orders'::text])))) EXECUTE FUNCTION erp_finance.commission_operation_capture();

-- erp_documents.document.cost_apply_capture: preserve the legacy predicate and event, skip only the NOLOGIN writer.
do $$begin
 if(select encode(sha256(convert_to(pg_get_triggerdef(t.oid),'UTF8')),'hex')from pg_trigger t where t.tgrelid='erp_documents.document'::regclass and t.tgname='cost_apply_capture')is distinct from '230fabd954a4601cd2c8f3d385a058ec5beba440710e63bb8ae1b4b83a5c9bf2' then raise exception 'document_mirror_007_previous_trigger_changed cost_apply_capture';end if;
end$$;
drop trigger cost_apply_capture on erp_documents.document;
CREATE CONSTRAINT TRIGGER cost_apply_capture AFTER INSERT OR UPDATE ON erp_documents.document DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NOT coalesce(erp_document_mirror.writing(),false) AND ((new.kind = 'sales_orders'::text))) EXECUTE FUNCTION erp_documents.cost_apply_capture();

-- erp_documents.document.guard_trash: preserve the legacy predicate and event, skip only the NOLOGIN writer.
do $$begin
 if(select encode(sha256(convert_to(pg_get_triggerdef(t.oid),'UTF8')),'hex')from pg_trigger t where t.tgrelid='erp_documents.document'::regclass and t.tgname='guard_trash')is distinct from '7a4dc901ab094d60a6726c4e7620e1d4b054754b263d3c2e35dcfd8fa97bb056' then raise exception 'document_mirror_007_previous_trigger_changed guard_trash';end if;
end$$;
drop trigger guard_trash on erp_documents.document;
CREATE TRIGGER guard_trash BEFORE UPDATE ON erp_documents.document FOR EACH ROW WHEN (NOT coalesce(erp_document_mirror.writing(),false)) EXECUTE FUNCTION erp_documents.guard_trash();

-- erp_documents.document.protect_document_finance: preserve the legacy predicate and event, skip only the NOLOGIN writer.
do $$begin
 if(select encode(sha256(convert_to(pg_get_triggerdef(t.oid),'UTF8')),'hex')from pg_trigger t where t.tgrelid='erp_documents.document'::regclass and t.tgname='protect_document_finance')is distinct from '3dcac3844c7233d7cdb294cbe54b7509348c095a469d28ea5595e6e359f1af61' then raise exception 'document_mirror_007_previous_trigger_changed protect_document_finance';end if;
end$$;
drop trigger protect_document_finance on erp_documents.document;
CREATE TRIGGER protect_document_finance BEFORE DELETE OR UPDATE ON erp_documents.document FOR EACH ROW WHEN (NOT coalesce(erp_document_mirror.writing(),false)) EXECUTE FUNCTION erp_finance.guard_posted_document();

-- erp_documents.document.protect_document_stock: preserve the legacy predicate and event, skip only the NOLOGIN writer.
do $$begin
 if(select encode(sha256(convert_to(pg_get_triggerdef(t.oid),'UTF8')),'hex')from pg_trigger t where t.tgrelid='erp_documents.document'::regclass and t.tgname='protect_document_stock')is distinct from 'b90812bbb517a5005f1ee5bc2ad05b96f9b252a1cf90e1dbfb728379887b9a8b' then raise exception 'document_mirror_007_previous_trigger_changed protect_document_stock';end if;
end$$;
drop trigger protect_document_stock on erp_documents.document;
CREATE TRIGGER protect_document_stock BEFORE DELETE OR UPDATE ON erp_documents.document FOR EACH ROW WHEN (NOT coalesce(erp_document_mirror.writing(),false)) EXECUTE FUNCTION erp_stock.guard_posted_document();

-- erp_documents.document.protect_purchase_receipt_document: preserve the legacy predicate and event, skip only the NOLOGIN writer.
do $$begin
 if(select encode(sha256(convert_to(pg_get_triggerdef(t.oid),'UTF8')),'hex')from pg_trigger t where t.tgrelid='erp_documents.document'::regclass and t.tgname='protect_purchase_receipt_document')is distinct from 'bff13f8cae8cf2ef2314d197170bb4102249891ff21f92fc4047b08ddce8770b' then raise exception 'document_mirror_007_previous_trigger_changed protect_purchase_receipt_document';end if;
end$$;
drop trigger protect_purchase_receipt_document on erp_documents.document;
CREATE TRIGGER protect_purchase_receipt_document BEFORE DELETE OR UPDATE ON erp_documents.document FOR EACH ROW WHEN (NOT coalesce(erp_document_mirror.writing(),false)) EXECUTE FUNCTION erp_purchase_receipts.guard_document();

-- erp_documents.document.protect_reserved_document: preserve the legacy predicate and event, skip only the NOLOGIN writer.
do $$begin
 if(select encode(sha256(convert_to(pg_get_triggerdef(t.oid),'UTF8')),'hex')from pg_trigger t where t.tgrelid='erp_documents.document'::regclass and t.tgname='protect_reserved_document')is distinct from '3a49f2dbf711c8a9ac2c7d097559768f12cf13972e5a5bc04aef3c95e1b47624' then raise exception 'document_mirror_007_previous_trigger_changed protect_reserved_document';end if;
end$$;
drop trigger protect_reserved_document on erp_documents.document;
CREATE TRIGGER protect_reserved_document BEFORE DELETE OR UPDATE ON erp_documents.document FOR EACH ROW WHEN (NOT coalesce(erp_document_mirror.writing(),false)) EXECUTE FUNCTION erp_stock.guard_reserved_document();

-- erp_documents.document.situation_follow_status: preserve the legacy predicate and event, skip only the NOLOGIN writer.
do $$begin
 if(select encode(sha256(convert_to(pg_get_triggerdef(t.oid),'UTF8')),'hex')from pg_trigger t where t.tgrelid='erp_documents.document'::regclass and t.tgname='situation_follow_status')is distinct from 'afb23794476c7206cbbd1fa6fd27a42638f8d1ca4c9b24329b234ceaeec8e709' then raise exception 'document_mirror_007_previous_trigger_changed situation_follow_status';end if;
end$$;
drop trigger situation_follow_status on erp_documents.document;
CREATE TRIGGER situation_follow_status AFTER UPDATE OF status ON erp_documents.document FOR EACH ROW WHEN (NOT coalesce(erp_document_mirror.writing(),false)) EXECUTE FUNCTION erp_documents.situation_follow_status();

-- erp_documents.item.forget_stock_item_components: preserve the legacy predicate and event, skip only the NOLOGIN writer.
do $$begin
 if(select encode(sha256(convert_to(pg_get_triggerdef(t.oid),'UTF8')),'hex')from pg_trigger t where t.tgrelid='erp_documents.item'::regclass and t.tgname='forget_stock_item_components')is distinct from '1ad641cc9b5752ae28720a333f248ec881599093b640f66ce73e9d18929ad328' then raise exception 'document_mirror_007_previous_trigger_changed forget_stock_item_components';end if;
end$$;
drop trigger forget_stock_item_components on erp_documents.item;
CREATE TRIGGER forget_stock_item_components AFTER DELETE OR UPDATE OF product_id ON erp_documents.item FOR EACH ROW WHEN (NOT coalesce(erp_document_mirror.writing(),false)) EXECUTE FUNCTION erp_stock.forget_item_components();

-- erp_documents.item.guard_trash: preserve the legacy predicate and event, skip only the NOLOGIN writer.
do $$begin
 if(select encode(sha256(convert_to(pg_get_triggerdef(t.oid),'UTF8')),'hex')from pg_trigger t where t.tgrelid='erp_documents.item'::regclass and t.tgname='guard_trash')is distinct from 'b213196e3a6343e84ade08dac81ff2dd89ae6893ac06cb6289159c39257e35b2' then raise exception 'document_mirror_007_previous_trigger_changed guard_trash';end if;
end$$;
drop trigger guard_trash on erp_documents.item;
CREATE TRIGGER guard_trash BEFORE INSERT OR DELETE OR UPDATE ON erp_documents.item FOR EACH ROW WHEN (NOT coalesce(erp_document_mirror.writing(),false)) EXECUTE FUNCTION erp_documents.guard_trash_child();

-- erp_documents.item.guard_variation_item: preserve the legacy predicate and event, skip only the NOLOGIN writer.
do $$begin
 if(select encode(sha256(convert_to(pg_get_triggerdef(t.oid),'UTF8')),'hex')from pg_trigger t where t.tgrelid='erp_documents.item'::regclass and t.tgname='guard_variation_item')is distinct from '2a01dde65f3b4c3bae5d99647ee76e2091adeee6b5d749a7ae2987244a49a09b' then raise exception 'document_mirror_007_previous_trigger_changed guard_variation_item';end if;
end$$;
drop trigger guard_variation_item on erp_documents.item;
CREATE TRIGGER guard_variation_item BEFORE INSERT OR UPDATE ON erp_documents.item FOR EACH ROW WHEN (NOT coalesce(erp_document_mirror.writing(),false)) EXECUTE FUNCTION erp_documents.guard_variation_item();

-- erp_documents.item.protect_document_item_finance: preserve the legacy predicate and event, skip only the NOLOGIN writer.
do $$begin
 if(select encode(sha256(convert_to(pg_get_triggerdef(t.oid),'UTF8')),'hex')from pg_trigger t where t.tgrelid='erp_documents.item'::regclass and t.tgname='protect_document_item_finance')is distinct from 'c245f2f3b163934f5411304e306cfa22341a0aa0e4554a2850e4659d991ed81e' then raise exception 'document_mirror_007_previous_trigger_changed protect_document_item_finance';end if;
end$$;
drop trigger protect_document_item_finance on erp_documents.item;
CREATE TRIGGER protect_document_item_finance BEFORE INSERT OR DELETE OR UPDATE ON erp_documents.item FOR EACH ROW WHEN (NOT coalesce(erp_document_mirror.writing(),false)) EXECUTE FUNCTION erp_finance.guard_posted_item();

-- erp_documents.item.protect_document_item_stock: preserve the legacy predicate and event, skip only the NOLOGIN writer.
do $$begin
 if(select encode(sha256(convert_to(pg_get_triggerdef(t.oid),'UTF8')),'hex')from pg_trigger t where t.tgrelid='erp_documents.item'::regclass and t.tgname='protect_document_item_stock')is distinct from 'f803f730f69527f92fad09071199dee10d9c55d82c4d90a33292e29603efe6d2' then raise exception 'document_mirror_007_previous_trigger_changed protect_document_item_stock';end if;
end$$;
drop trigger protect_document_item_stock on erp_documents.item;
CREATE TRIGGER protect_document_item_stock BEFORE INSERT OR DELETE OR UPDATE ON erp_documents.item FOR EACH ROW WHEN (NOT coalesce(erp_document_mirror.writing(),false)) EXECUTE FUNCTION erp_stock.guard_posted_item();

-- erp_documents.item.protect_purchase_receipt_item: preserve the legacy predicate and event, skip only the NOLOGIN writer.
do $$begin
 if(select encode(sha256(convert_to(pg_get_triggerdef(t.oid),'UTF8')),'hex')from pg_trigger t where t.tgrelid='erp_documents.item'::regclass and t.tgname='protect_purchase_receipt_item')is distinct from '39b943da48db4c24ddbec807fbaa8793c34fbf81e1393b87a1eae5dec524013e' then raise exception 'document_mirror_007_previous_trigger_changed protect_purchase_receipt_item';end if;
end$$;
drop trigger protect_purchase_receipt_item on erp_documents.item;
CREATE TRIGGER protect_purchase_receipt_item BEFORE INSERT OR DELETE OR UPDATE ON erp_documents.item FOR EACH ROW WHEN (NOT coalesce(erp_document_mirror.writing(),false)) EXECUTE FUNCTION erp_purchase_receipts.guard_item();

-- erp_documents.item.protect_reserved_item: preserve the legacy predicate and event, skip only the NOLOGIN writer.
do $$begin
 if(select encode(sha256(convert_to(pg_get_triggerdef(t.oid),'UTF8')),'hex')from pg_trigger t where t.tgrelid='erp_documents.item'::regclass and t.tgname='protect_reserved_item')is distinct from 'c76be0bc7e041472efef8527ba6264fc561688b45a54f41e29d76c6d0228720c' then raise exception 'document_mirror_007_previous_trigger_changed protect_reserved_item';end if;
end$$;
drop trigger protect_reserved_item on erp_documents.item;
CREATE TRIGGER protect_reserved_item BEFORE INSERT OR DELETE OR UPDATE ON erp_documents.item FOR EACH ROW WHEN (NOT coalesce(erp_document_mirror.writing(),false)) EXECUTE FUNCTION erp_stock.guard_reserved_item();
create trigger aa_mirror_authority before insert or update or delete on erp_attachments.attachment for each row execute function erp_document_mirror.guard_effect('document_id');
create trigger aa_mirror_authority before insert or update or delete on erp_documents.audit for each row execute function erp_document_mirror.guard_effect('document_id');
create trigger aa_mirror_authority before insert or update or delete on erp_documents.checkout for each row execute function erp_document_mirror.guard_effect('document_id');
create trigger aa_mirror_authority before insert or update or delete on erp_documents.copy_source for each row execute function erp_document_mirror.guard_effect('destination_id','source_id');
create trigger aa_mirror_authority before insert or update or delete on erp_documents.document_situation for each row execute function erp_document_mirror.guard_effect('document_id');
create trigger aa_mirror_authority before insert or update or delete on erp_documents.freight_paid for each row execute function erp_document_mirror.guard_effect('document_id');
create trigger aa_mirror_authority before insert or update or delete on erp_documents.item_cost_applied for each row execute function erp_document_mirror.guard_effect('document_id');
create trigger aa_mirror_authority before insert or update or delete on erp_documents.occurrence for each row execute function erp_document_mirror.guard_effect('document_id');
create trigger aa_mirror_authority before insert or update or delete on erp_documents.occurrence_removal for each row execute function erp_document_mirror.guard_effect('document_id');
create trigger aa_mirror_authority before insert or update or delete on erp_documents.proposal_version for each row execute function erp_document_mirror.guard_effect('base_id','document_id','source_id');
create trigger aa_mirror_authority before insert or update or delete on erp_documents.sales_service_link for each row execute function erp_document_mirror.guard_effect('sales_order_id','service_order_id');
create trigger aa_mirror_authority before insert or update or delete on erp_documents.service_event for each row execute function erp_document_mirror.guard_effect('document_id');
create trigger aa_mirror_authority before insert or update or delete on erp_documents.service_journal_entry for each row execute function erp_document_mirror.guard_effect('document_id');
create trigger aa_mirror_authority before insert or update or delete on erp_finance.commission for each row execute function erp_document_mirror.guard_effect('document_id');
create trigger aa_mirror_authority before insert or update or delete on erp_finance.commission_operation for each row execute function erp_document_mirror.guard_effect('document_id');
create trigger aa_mirror_authority before insert or update or delete on erp_finance.document_posting for each row execute function erp_document_mirror.guard_effect('document_id');
create trigger aa_mirror_authority before insert or update or delete on erp_finance.grouped_billing_document for each row execute function erp_document_mirror.guard_effect('document_id');
create trigger aa_mirror_authority before insert or update or delete on erp_fiscal_drafts.draft for each row execute function erp_document_mirror.guard_effect('source_document_id');
create trigger aa_mirror_authority before insert or update or delete on erp_fiscal_invoices.invoice_order for each row execute function erp_document_mirror.guard_effect('document_id');
create trigger aa_mirror_authority before insert or update or delete on erp_fiscal_invoices.invoice_order_item for each row execute function erp_document_mirror.guard_effect('document_id');
create trigger aa_mirror_authority before insert or update or delete on erp_fiscal_numbering.reservation for each row execute function erp_document_mirror.guard_effect('source_document_id');
create trigger aa_mirror_authority before insert or update or delete on erp_pos.sale for each row execute function erp_document_mirror.guard_effect('document_id');
create trigger aa_mirror_authority before insert or update or delete on erp_purchase_receipts.command for each row execute function erp_document_mirror.guard_effect('document_id');
create trigger aa_mirror_authority before insert or update or delete on erp_purchase_receipts.receipt for each row execute function erp_document_mirror.guard_effect('document_id');
create trigger aa_mirror_authority before insert or update or delete on erp_purchase_receipts.reversal for each row execute function erp_document_mirror.guard_effect('document_id');
create trigger aa_mirror_authority before insert or update or delete on erp_stock.document_audit for each row execute function erp_document_mirror.guard_effect('document_id');
create trigger aa_mirror_authority before insert or update or delete on erp_stock.document_posting for each row execute function erp_document_mirror.guard_effect('document_id');
create trigger aa_mirror_authority before insert or update or delete on erp_stock.item_component for each row execute function erp_document_mirror.guard_effect('document_id');
create trigger aa_mirror_authority before insert or update or delete on erp_stock.item_component_command for each row execute function erp_document_mirror.guard_effect('document_id');
create trigger aa_mirror_authority before insert or update or delete on erp_stock.reservation for each row execute function erp_document_mirror.guard_effect('document_id');
create trigger aa_mirror_authority before insert or update or delete on erp_stock.reservation_command for each row execute function erp_document_mirror.guard_effect('document_id');

-- erp_documents.dto
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('erp_documents.dto(uuid)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$
 select d.body||jsonb_build_object('id',d.id,'kind',d.kind,'number',d.number::text,'status',d.status,'version',d.version,
  'effect_flags',erp_documents.effect_flags(d.id),'contact_snapshot',d.contact_snapshot,'source_proposal_id',d.source_proposal_id,'created_at',d.created_at,'updated_at',d.updated_at,
  'items',(select coalesce(jsonb_agg(i.data||jsonb_build_object('product_snapshot',i.product_snapshot) order by position),'[]'::jsonb)
    from erp_documents.item i where document_id=d.id)) from erp_documents.document d where id=p_id;
$previous$,$updated$
 select case when d.origin='origin' then erp_document_mirror.detail(p_id) else (select d.body||jsonb_build_object('id',d.id,'kind',d.kind,'number',d.number::text,'status',d.status,'version',d.version,
  'effect_flags',erp_documents.effect_flags(d.id),'contact_snapshot',d.contact_snapshot,'source_proposal_id',d.source_proposal_id,'created_at',d.created_at,'updated_at',d.updated_at,
  'items',(select coalesce(jsonb_agg(i.data||jsonb_build_object('product_snapshot',i.product_snapshot) order by position),'[]'::jsonb)
    from erp_documents.item i where document_id=d.id)) from erp_documents.document d where id=p_id)||jsonb_build_object('origin',d.origin,'authority',d.authority,'readonly',false) end from erp_documents.document d where d.id=p_id;
$updated$);
 execute definition;
end$migration$;

-- erp_documents.document_view
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('erp_documents.document_view(uuid)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$
 select erp_documents.dto(p_id)||jsonb_build_object('situation',erp_documents.document_situation_json(p_id),
  'seller_name',(select left(r.name,200) from erp_documents.document d join erp_catalog.seller s on s.id::text=d.body->>'seller_id' join erp_catalog.record r on r.id=s.contact_id where d.id=p_id),
$previous$,$updated$
 select case when d.origin='origin' then erp_document_mirror.detail(p_id) else (select erp_documents.dto(p_id)||jsonb_build_object('situation',erp_documents.document_situation_json(p_id),
  'seller_name',(select left(r.name,200) from erp_documents.document d join erp_catalog.seller s on s.id::text=d.body->>'seller_id' join erp_catalog.record r on r.id=s.contact_id where d.id=p_id),
$updated$);
 definition:=replace(definition,$previous$  -- 269: the versions of the proposta.
  ||case when (select d.kind from erp_documents.document d where d.id=p_id)='sales_proposals' then jsonb_build_object('proposal_version',erp_documents.proposal_version_json(p_id)) else '{}'::jsonb end
$previous$,$updated$  -- 269: the versions of the proposta.
  ||case when (select d.kind from erp_documents.document d where d.id=p_id)='sales_proposals' then jsonb_build_object('proposal_version',erp_documents.proposal_version_json(p_id)) else '{}'::jsonb end)||jsonb_build_object('origin',d.origin,'authority',d.authority,'readonly',false) end from erp_documents.document d where d.id=p_id;
$updated$);
 execute definition;
end$migration$;

-- erp_documents.summary
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('erp_documents.summary(uuid)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$
 select jsonb_build_object('id',id,'kind',kind,'number',number::text,'status',status,'version',version,
  'date',body->>'date','total',total::text,'contact_id',contact_id,'contact_name',contact_snapshot->>'name',
  'created_at',created_at,'updated_at',updated_at) from erp_documents.document where id=p_id;
$previous$,$updated$
 select case when d.origin='origin' then erp_document_mirror.list_row(p_id) else (select jsonb_build_object('id',id,'kind',kind,'number',number::text,'status',status,'version',version,
  'date',body->>'date','total',total::text,'contact_id',contact_id,'contact_name',contact_snapshot->>'name',
  'created_at',created_at,'updated_at',updated_at) from erp_documents.document where id=p_id)||jsonb_build_object('origin',d.origin,'authority',d.authority,'readonly',false) end from erp_documents.document d where d.id=p_id;
$updated$);
 execute definition;
end$migration$;

-- erp_documents.list_row
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('erp_documents.list_row(uuid,boolean,boolean)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$
 select jsonb_build_object('id',d.id,'kind',d.kind,'number',d.number::text,'status',d.status,'version',d.version,
  'date',d.body->>'date','expected_date',d.body->>'expected_date','next_contact',d.body->>'next_contact',
$previous$,$updated$
 select case when d.origin='origin' then erp_document_mirror.list_row(p_id) else (select jsonb_build_object('id',d.id,'kind',d.kind,'number',d.number::text,'status',d.status,'version',d.version,
  'date',d.body->>'date','expected_date',d.body->>'expected_date','next_contact',d.body->>'next_contact',
$updated$);
 definition:=replace(definition,$previous$  'first_sale',d.kind='sales_orders' and d.status<>'cancelled' and not exists(select 1 from erp_documents.document o
    where o.kind='sales_orders' and o.contact_id=d.contact_id and o.status<>'cancelled' and o.id<>d.id
     and (o.body->>'date',o.number)<(d.body->>'date',d.number)),
$previous$,$updated$  'first_sale',d.kind='sales_orders' and d.status<>'cancelled' and not exists(select 1 from erp_documents.document o
    where o.origin='brufap'and o.kind='sales_orders' and o.contact_id=d.contact_id and o.status<>'cancelled' and o.id<>d.id
     and (o.body->>'date',o.number)<(d.body->>'date',d.number)),
$updated$);
 definition:=replace(definition,$previous$ left join erp_documents.document_situation ds on ds.document_id=d.id
 where d.id=p_id;
$previous$,$updated$ left join erp_documents.document_situation ds on ds.document_id=d.id
 where d.id=p_id)||jsonb_build_object('origin',d.origin,'authority',d.authority,'readonly',false) end from erp_documents.document d where d.id=p_id;
$updated$);
 execute definition;
end$migration$;

-- public.erp_document_get
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_document_get(uuid,text,uuid)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$ begin
 perform erp_documents.require_access(p_user_id,p_kind,false);
$previous$,$updated$ begin
 perform erp_document_mirror.require_visible(p_user_id,p_id,false);

 perform erp_documents.require_access(p_user_id,p_kind,false);
$updated$);
 execute definition;
end$migration$;

-- public.erp_document_copy_origin
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_document_copy_origin(uuid,text,uuid)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$begin
 perform erp_documents.require_access(p_user_id,p_kind,false);
$previous$,$updated$begin
 perform erp_document_mirror.require_visible(p_user_id,p_document_id,false);

 perform erp_documents.require_access(p_user_id,p_kind,false);
$updated$);
 execute definition;
end$migration$;

-- public.erp_document_finance_get
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_document_finance_get(uuid,text,uuid,uuid)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$ declare d erp_documents.document;begin
 perform erp_finance.require_access(p_user_id,false);perform erp_documents.require_access(p_user_id,p_kind,false);
$previous$,$updated$ declare d erp_documents.document;begin
 perform erp_document_mirror.require_visible(p_user_id,p_document_id,false);

 perform erp_finance.require_access(p_user_id,false);perform erp_documents.require_access(p_user_id,p_kind,false);
$updated$);
 execute definition;
end$migration$;

-- public.erp_document_finance_list
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_document_finance_list(uuid,text,uuid,integer,uuid)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$ declare d erp_documents.document;rows jsonb;more boolean;cursor uuid;begin
 perform erp_finance.require_access(p_user_id,false);perform erp_documents.require_access(p_user_id,p_kind,false);
$previous$,$updated$ declare d erp_documents.document;rows jsonb;more boolean;cursor uuid;begin
 perform erp_document_mirror.require_visible(p_user_id,p_document_id,false);

 perform erp_finance.require_access(p_user_id,false);perform erp_documents.require_access(p_user_id,p_kind,false);
$updated$);
 execute definition;
end$migration$;

-- public.erp_document_freight_paid_get
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_document_freight_paid_get(uuid,text,uuid)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$begin
  if p_kind is distinct from 'sales_orders' or p_document_id is null then raise exception 'erp_document_query_invalid' using errcode='22023'; end if;
$previous$,$updated$begin
 perform erp_document_mirror.require_visible(p_user_id,p_document_id,false);

  if p_kind is distinct from 'sales_orders' or p_document_id is null then raise exception 'erp_document_query_invalid' using errcode='22023'; end if;
$updated$);
 execute definition;
end$migration$;

-- public.erp_document_commission_operation
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_document_commission_operation(uuid,text,uuid)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$begin
 if p_kind is null or p_kind not in('sales_orders','service_orders') or p_document_id is null then raise exception 'erp_document_query_invalid' using errcode='22023'; end if;
$previous$,$updated$begin
 perform erp_document_mirror.require_visible(p_user_id,p_document_id,false);

 if p_kind is null or p_kind not in('sales_orders','service_orders') or p_document_id is null then raise exception 'erp_document_query_invalid' using errcode='22023'; end if;
$updated$);
 execute definition;
end$migration$;

-- public.erp_document_occurrence_list
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_document_occurrence_list(uuid,text,uuid)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$begin
 perform erp_documents.require_access(p_user_id,p_kind,false);
$previous$,$updated$begin
 perform erp_document_mirror.require_visible(p_user_id,p_document_id,false);

 perform erp_documents.require_access(p_user_id,p_kind,false);
$updated$);
 execute definition;
end$migration$;

-- public.erp_document_pendencies
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_document_pendencies(uuid,text,uuid)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$begin
 perform erp_documents.require_access(p_user_id,p_kind,false);
$previous$,$updated$begin
 perform erp_document_mirror.require_visible(p_user_id,p_id,false);

 perform erp_documents.require_access(p_user_id,p_kind,false);
$updated$);
 execute definition;
end$migration$;

-- public.erp_document_invoice_balance
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_document_invoice_balance(uuid,uuid)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$begin
 perform erp_documents.require_access(p_user_id,'sales_orders',false);
$previous$,$updated$begin
 perform erp_document_mirror.require_visible(p_user_id,p_document_id,false);

 perform erp_documents.require_access(p_user_id,'sales_orders',false);
$updated$);
 execute definition;
end$migration$;

-- public.erp_document_stock_get
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_document_stock_get(uuid,text,uuid,integer,uuid)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$ declare rows jsonb;more boolean;cursor uuid;begin
 perform erp_stock.document_access(p_user_id,p_kind);
$previous$,$updated$ declare rows jsonb;more boolean;cursor uuid;begin
 perform erp_document_mirror.require_visible(p_user_id,p_document_id,false);

 perform erp_stock.document_access(p_user_id,p_kind);
$updated$);
 execute definition;
end$migration$;

-- public.erp_document_structures
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_document_structures(uuid,text,uuid)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$begin
 perform erp_documents.require_access(p_user_id,p_kind,false);
$previous$,$updated$begin
 perform erp_document_mirror.require_visible(p_user_id,p_document_id,false);

 perform erp_documents.require_access(p_user_id,p_kind,false);
$updated$);
 execute definition;
end$migration$;

-- public.erp_document_supplier_descriptions
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_document_supplier_descriptions(uuid,text,uuid)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$begin
 perform erp_documents.require_access(p_user_id,p_kind,false);
$previous$,$updated$begin
 perform erp_document_mirror.require_visible(p_user_id,p_document_id,false);

 perform erp_documents.require_access(p_user_id,p_kind,false);
$updated$);
 execute definition;
end$migration$;

-- public.erp_document_checkout_get
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_document_checkout_get(uuid,uuid)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$begin
 perform erp_documents.require_access(p_user_id,'sales_orders',true);
$previous$,$updated$begin
 perform erp_document_mirror.require_visible(p_user_id,p_id,false);

 perform erp_documents.require_access(p_user_id,'sales_orders',true);
$updated$);
 execute definition;
end$migration$;

-- public.erp_fiscal_invoice_order_items
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_fiscal_invoice_order_items(uuid,uuid,uuid)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$begin
 if p_invoice_id is null or p_document_id is null then raise exception 'erp_fiscal_query_invalid' using errcode='22023'; end if;
$previous$,$updated$begin
 perform erp_document_mirror.require_visible(p_user_id,p_document_id,false);

 if p_invoice_id is null or p_document_id is null then raise exception 'erp_fiscal_query_invalid' using errcode='22023'; end if;
$updated$);
 execute definition;
end$migration$;

-- public.erp_fiscal_invoice_order_source
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_fiscal_invoice_order_source(uuid,uuid,text)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$begin
 if p_document_id is null or p_model is null or p_model not in('55','65') then raise exception 'erp_fiscal_query_invalid' using errcode='22023'; end if;
$previous$,$updated$begin
 perform erp_document_mirror.require_visible(p_user_id,p_document_id,false);

 if p_document_id is null or p_model is null or p_model not in('55','65') then raise exception 'erp_fiscal_query_invalid' using errcode='22023'; end if;
$updated$);
 execute definition;
end$migration$;

-- public.erp_fiscal_invoice_order_source_v2
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_fiscal_invoice_order_source_v2(uuid,uuid,text)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$begin
 if p_document_id is null or p_model is null or p_model not in('55','65') then raise exception 'erp_fiscal_query_invalid' using errcode='22023'; end if;
$previous$,$updated$begin
 perform erp_document_mirror.require_visible(p_user_id,p_document_id,false);

 if p_document_id is null or p_model is null or p_model not in('55','65') then raise exception 'erp_fiscal_query_invalid' using errcode='22023'; end if;
$updated$);
 execute definition;
end$migration$;

-- public.erp_fiscal_invoice_order_source_v3
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_fiscal_invoice_order_source_v3(uuid,uuid,text)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$begin
 if p_document_id is null or p_model is null or p_model not in('55','65') then raise exception 'erp_fiscal_query_invalid' using errcode='22023'; end if;
$previous$,$updated$begin
 perform erp_document_mirror.require_visible(p_user_id,p_document_id,false);

 if p_document_id is null or p_model is null or p_model not in('55','65') then raise exception 'erp_fiscal_query_invalid' using errcode='22023'; end if;
$updated$);
 execute definition;
end$migration$;

-- public.erp_stock_reservation_get
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_stock_reservation_get(uuid,uuid,integer,uuid)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$declare items jsonb;more boolean;cursor uuid;begin
 perform erp_stock.require_access(p_user_id,false);
$previous$,$updated$declare items jsonb;more boolean;cursor uuid;begin
 perform erp_document_mirror.require_visible(p_user_id,p_document_id,false);

 perform erp_stock.require_access(p_user_id,false);
$updated$);
 execute definition;
end$migration$;

-- public.erp_stock_item_components
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_stock_item_components(uuid,uuid,uuid)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$declare d erp_documents.document;begin
 if p_document_id is null or p_item_id is null then raise exception 'erp_stock_invalid_query' using errcode='22023';end if;
$previous$,$updated$declare d erp_documents.document;begin
 perform erp_document_mirror.require_visible(p_user_id,p_document_id,false);

 if p_document_id is null or p_item_id is null then raise exception 'erp_stock_invalid_query' using errcode='22023';end if;
$updated$);
 execute definition;
end$migration$;

-- public.erp_purchase_receipts_get
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_purchase_receipts_get(uuid,uuid,integer,uuid,uuid)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$declare page jsonb;more boolean;cursor uuid;selected jsonb;begin
 perform erp_purchase_receipts.access(p_user_id);
$previous$,$updated$declare page jsonb;more boolean;cursor uuid;selected jsonb;begin
 perform erp_document_mirror.require_visible(p_user_id,p_document_id,false);

 perform erp_purchase_receipts.access(p_user_id);
$updated$);
 execute definition;
end$migration$;

-- public.erp_service_event_get
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_service_event_get(uuid,uuid,uuid)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$declare context jsonb;e erp_documents.service_event;begin
 context:=erp_documents.service_event_context(p_user_id,p_document_id);
$previous$,$updated$declare context jsonb;e erp_documents.service_event;begin
 perform erp_document_mirror.require_visible(p_user_id,p_document_id,false);

 context:=erp_documents.service_event_context(p_user_id,p_document_id);
$updated$);
 execute definition;
end$migration$;

-- public.erp_service_event_list
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_service_event_list(uuid,uuid,integer,text)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$declare context jsonb;result jsonb;begin
 context:=erp_documents.service_event_context(p_user_id,p_document_id);
$previous$,$updated$declare context jsonb;result jsonb;begin
 perform erp_document_mirror.require_visible(p_user_id,p_document_id,false);

 context:=erp_documents.service_event_context(p_user_id,p_document_id);
$updated$);
 execute definition;
end$migration$;

-- public.erp_service_journal_get
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_service_journal_get(uuid,uuid,uuid)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$begin
 context:=erp_documents.service_journal_context(p_user_id,p_document_id);
$previous$,$updated$begin
 perform erp_document_mirror.require_visible(p_user_id,p_document_id,false);

 context:=erp_documents.service_journal_context(p_user_id,p_document_id);
$updated$);
 execute definition;
end$migration$;

-- public.erp_service_journal_list
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_service_journal_list(uuid,uuid,integer,text)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$begin
 context:=erp_documents.service_journal_context(p_user_id,p_document_id);
$previous$,$updated$begin
 perform erp_document_mirror.require_visible(p_user_id,p_document_id,false);

 context:=erp_documents.service_journal_context(p_user_id,p_document_id);
$updated$);
 execute definition;
end$migration$;

-- public.erp_origin_proposal_document_origin
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_origin_proposal_document_origin(uuid,uuid)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$begin
 select d.kind into kind from erp_documents.document d where d.id=p_document_id;
$previous$,$updated$begin
 perform erp_document_mirror.require_visible(p_user_id,p_document_id,false);

 select d.kind into kind from erp_documents.document d where d.id=p_document_id;
$updated$);
 execute definition;
end$migration$;

-- public.erp_document_save
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_document_save(uuid,text,uuid,integer,uuid,jsonb)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$begin
 perform erp_documents.require_access(p_user_id,p_kind,true);
$previous$,$updated$begin
 perform erp_document_mirror.require_visible(p_user_id,p_id,true);

 perform erp_documents.require_access(p_user_id,p_kind,true);
$updated$);
 execute definition;
end$migration$;

-- public.erp_document_transition
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_document_transition(uuid,text,uuid,integer,uuid,text,text)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$begin
 -- 239: the profile writes the kind; the OS also needs "Gerenciar situações" (checked below with the approval rule).
$previous$,$updated$begin
 perform erp_document_mirror.require_visible(p_user_id,p_id,true);

 -- 239: the profile writes the kind; the OS also needs "Gerenciar situações" (checked below with the approval rule).
$updated$);
 execute definition;
end$migration$;

-- public.erp_document_notes_save
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_document_notes_save(uuid,text,uuid,integer,uuid,text,text)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$begin
 if p_kind is null or p_kind not in('sales_orders','service_orders','purchase_orders') or p_id is null then raise exception 'erp_document_query_invalid' using errcode='22023'; end if;
$previous$,$updated$begin
 perform erp_document_mirror.require_visible(p_user_id,p_id,true);

 if p_kind is null or p_kind not in('sales_orders','service_orders','purchase_orders') or p_id is null then raise exception 'erp_document_query_invalid' using errcode='22023'; end if;
$updated$);
 execute definition;
end$migration$;

-- public.erp_document_copy
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_document_copy(uuid,text,uuid,integer,uuid,jsonb)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$begin
 perform erp_documents.require_access(p_user_id,p_kind,false);
$previous$,$updated$begin
 perform erp_document_mirror.require_visible(p_user_id,p_source_id,true);

 perform erp_documents.require_access(p_user_id,p_kind,false);
$updated$);
 execute definition;
end$migration$;

-- public.erp_document_copy_preview
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_document_copy_preview(uuid,text,uuid)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$begin
 perform erp_documents.require_access(p_user_id,p_kind,false);
$previous$,$updated$begin
 perform erp_document_mirror.require_visible(p_user_id,p_source_id,true);

 perform erp_documents.require_access(p_user_id,p_kind,false);
$updated$);
 execute definition;
end$migration$;

-- public.erp_document_conversion_preview
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_document_conversion_preview(uuid,text,uuid)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$begin
 if p_kind is null or p_kind not in('sales_orders','service_orders') then raise exception 'erp_document_query_invalid' using errcode='22023'; end if;
$previous$,$updated$begin
 perform erp_document_mirror.require_visible(p_user_id,p_proposal_id,true);

 if p_kind is null or p_kind not in('sales_orders','service_orders') then raise exception 'erp_document_query_invalid' using errcode='22023'; end if;
$updated$);
 execute definition;
end$migration$;

-- public.erp_document_proposal_version
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_document_proposal_version(uuid,uuid,integer,uuid,jsonb)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$begin
 perform erp_documents.require_access(p_user_id,'sales_proposals',true);
$previous$,$updated$begin
 perform erp_document_mirror.require_visible(p_user_id,p_id,true);

 perform erp_documents.require_access(p_user_id,'sales_proposals',true);
$updated$);
 execute definition;
end$migration$;

-- public.erp_proposal_convert
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_proposal_convert(uuid,uuid,integer,uuid)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$begin
 perform erp_documents.require_access(p_user_id,'sales_proposals',true);
$previous$,$updated$begin
 perform erp_document_mirror.require_visible(p_user_id,p_id,true);

 perform erp_documents.require_access(p_user_id,'sales_proposals',true);
$updated$);
 execute definition;
end$migration$;

-- public.erp_proposal_convert_to_service
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_proposal_convert_to_service(uuid,uuid,integer,uuid)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$begin
 perform erp_documents.require_access(p_user_id,'sales_proposals',true);
$previous$,$updated$begin
 perform erp_document_mirror.require_visible(p_user_id,p_id,true);

 perform erp_documents.require_access(p_user_id,'sales_proposals',true);
$updated$);
 execute definition;
end$migration$;

-- public.erp_sales_order_convert_to_service
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_sales_order_convert_to_service(uuid,uuid,integer,uuid)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$begin
 perform erp_documents.require_access(p_user_id,'sales_orders',true);
$previous$,$updated$begin
 perform erp_document_mirror.require_visible(p_user_id,p_id,true);

 perform erp_documents.require_access(p_user_id,'sales_orders',true);
$updated$);
 execute definition;
end$migration$;

-- public.erp_document_finance_post
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_document_finance_post(uuid,text,uuid,integer,uuid,text,uuid,jsonb)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$declare d erp_documents.document;data jsonb;replay jsonb;preview jsonb;pid uuid;gid uuid:=gen_random_uuid();tid uuid;part jsonb;label text;result jsonb;before_doc jsonb;v_category uuid;begin
 -- 239: Sistema › Usuários › Serviços › Ordem de Serviço "Lançar contas".
$previous$,$updated$declare d erp_documents.document;data jsonb;replay jsonb;preview jsonb;pid uuid;gid uuid:=gen_random_uuid();tid uuid;part jsonb;label text;result jsonb;before_doc jsonb;v_category uuid;begin
 perform erp_document_mirror.require_visible(p_user_id,p_document_id,true);

 -- 239: Sistema › Usuários › Serviços › Ordem de Serviço "Lançar contas".
$updated$);
 execute definition;
end$migration$;

-- public.erp_document_finance_preview
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_document_finance_preview(uuid,text,uuid,integer,uuid,jsonb)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$ declare d erp_documents.document;begin
 -- 239: Sistema › Usuários › Serviços › Ordem de Serviço "Lançar contas".
$previous$,$updated$ declare d erp_documents.document;begin
 perform erp_document_mirror.require_visible(p_user_id,p_document_id,true);

 -- 239: Sistema › Usuários › Serviços › Ordem de Serviço "Lançar contas".
$updated$);
 execute definition;
end$migration$;

-- public.erp_document_finance_reverse
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_document_finance_reverse(uuid,text,uuid,integer,uuid,integer,uuid,text,jsonb,text)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$declare d erp_documents.document;data jsonb;replay jsonb;preview jsonb;expected jsonb;actual jsonb;part jsonb;note text;result jsonb;before_doc jsonb;begin
 -- 239: Sistema › Usuários › Serviços › Ordem de Serviço "Lançar contas".
$previous$,$updated$declare d erp_documents.document;data jsonb;replay jsonb;preview jsonb;expected jsonb;actual jsonb;part jsonb;note text;result jsonb;before_doc jsonb;begin
 perform erp_document_mirror.require_visible(p_user_id,p_document_id,true);

 -- 239: Sistema › Usuários › Serviços › Ordem de Serviço "Lançar contas".
$updated$);
 execute definition;
end$migration$;

-- public.erp_document_finance_reverse_preview
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_document_finance_reverse_preview(uuid,text,uuid,integer,uuid,integer)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$ declare d erp_documents.document;begin
 -- 239: Sistema › Usuários › Serviços › Ordem de Serviço "Lançar contas".
$previous$,$updated$ declare d erp_documents.document;begin
 perform erp_document_mirror.require_visible(p_user_id,p_document_id,true);

 -- 239: Sistema › Usuários › Serviços › Ordem de Serviço "Lançar contas".
$updated$);
 execute definition;
end$migration$;

-- public.erp_document_stock_post
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_document_stock_post(uuid,text,uuid,integer,uuid,text,date,text,jsonb)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$declare d erp_documents.document;data jsonb;replay jsonb;preview jsonb;items jsonb;movement jsonb;pid uuid;result jsonb;ack jsonb;wanted jsonb;begin
 -- 239: Sistema › Usuários › Serviços › Ordem de Serviço "Lançar estoque".
$previous$,$updated$declare d erp_documents.document;data jsonb;replay jsonb;preview jsonb;items jsonb;movement jsonb;pid uuid;result jsonb;ack jsonb;wanted jsonb;begin
 perform erp_document_mirror.require_visible(p_user_id,p_document_id,true);

 -- 239: Sistema › Usuários › Serviços › Ordem de Serviço "Lançar estoque".
$updated$);
 execute definition;
end$migration$;

-- public.erp_document_stock_preview
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_document_stock_preview(uuid,text,uuid,integer,date,text)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$ declare d erp_documents.document;begin
 -- 239: Sistema › Usuários › Serviços › Ordem de Serviço "Lançar estoque".
$previous$,$updated$ declare d erp_documents.document;begin
 perform erp_document_mirror.require_visible(p_user_id,p_document_id,true);

 -- 239: Sistema › Usuários › Serviços › Ordem de Serviço "Lançar estoque".
$updated$);
 execute definition;
end$migration$;

-- public.erp_document_stock_reverse
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_document_stock_reverse(uuid,text,uuid,integer,uuid,integer,uuid,text,date,text)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$declare d erp_documents.document;data jsonb;replay jsonb;preview jsonb;items jsonb;movement jsonb;result jsonb;begin
 -- 239: Sistema › Usuários › Serviços › Ordem de Serviço "Lançar estoque".
$previous$,$updated$declare d erp_documents.document;data jsonb;replay jsonb;preview jsonb;items jsonb;movement jsonb;result jsonb;begin
 perform erp_document_mirror.require_visible(p_user_id,p_document_id,true);

 -- 239: Sistema › Usuários › Serviços › Ordem de Serviço "Lançar estoque".
$updated$);
 execute definition;
end$migration$;

-- public.erp_document_stock_reverse_preview
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_document_stock_reverse_preview(uuid,text,uuid,integer,uuid,integer,date,text)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$ declare d erp_documents.document;begin
 -- 239: Sistema › Usuários › Serviços › Ordem de Serviço "Lançar estoque".
$previous$,$updated$ declare d erp_documents.document;begin
 perform erp_document_mirror.require_visible(p_user_id,p_document_id,true);

 -- 239: Sistema › Usuários › Serviços › Ordem de Serviço "Lançar estoque".
$updated$);
 execute definition;
end$migration$;

-- public.erp_document_freight_paid_save
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_document_freight_paid_save(uuid,text,uuid,integer,uuid,jsonb)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$begin
  if p_kind is distinct from 'sales_orders' or p_document_id is null or p_command_id is null or p_expected_version is null or p_expected_version not between 0 and 2147483646
$previous$,$updated$begin
 perform erp_document_mirror.require_visible(p_user_id,p_document_id,true);

  if p_kind is distinct from 'sales_orders' or p_document_id is null or p_command_id is null or p_expected_version is null or p_expected_version not between 0 and 2147483646
$updated$);
 execute definition;
end$migration$;

-- public.erp_document_occurrence_add
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_document_occurrence_add(uuid,text,uuid,integer,uuid,text,text,text,text,text)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$begin
 -- 239: a change of situação is checked by erp_document_transition (Gerenciar situações, approval); a note needs the edit permission.
$previous$,$updated$begin
 perform erp_document_mirror.require_visible(p_user_id,p_document_id,true);

 -- 239: a change of situação is checked by erp_document_transition (Gerenciar situações, approval); a note needs the edit permission.
$updated$);
 execute definition;
end$migration$;

-- public.erp_document_occurrence_remove
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_document_occurrence_remove(uuid,text,uuid,uuid,uuid)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$begin
 perform erp_documents.require_access(p_user_id,p_kind,true);
$previous$,$updated$begin
 perform erp_document_mirror.require_visible(p_user_id,p_document_id,true);

 perform erp_documents.require_access(p_user_id,p_kind,true);
$updated$);
 execute definition;
end$migration$;

-- public.erp_document_checkout_save
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_document_checkout_save(uuid,uuid,integer,integer,uuid,jsonb)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$begin
 perform erp_documents.require_access(p_user_id,'sales_orders',true);
$previous$,$updated$begin
 perform erp_document_mirror.require_visible(p_user_id,p_id,true);

 perform erp_documents.require_access(p_user_id,'sales_orders',true);
$updated$);
 execute definition;
end$migration$;

-- public.erp_fiscal_invoice_partial_create
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_fiscal_invoice_partial_create(uuid,uuid,uuid,jsonb)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$begin
 perform erp_fiscal_invoices.require_write(p_user_id);
$previous$,$updated$begin
 perform erp_document_mirror.require_visible(p_user_id,p_document_id,true);

 perform erp_fiscal_invoices.require_write(p_user_id);
$updated$);
 execute definition;
end$migration$;

-- public.erp_stock_document_warehouse_post
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_stock_document_warehouse_post(uuid,text,uuid,integer,uuid,uuid,text,date,text,jsonb)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$declare d erp_documents.document;data jsonb;replay jsonb;preview jsonb;items jsonb;movement jsonb;pid uuid;result jsonb;ack jsonb;wanted jsonb;begin
 data:=jsonb_build_object('kind',p_kind,'id',p_document_id,'version',p_expected_version,'warehouse_id',p_warehouse_id,'hash',p_preview_hash,'date',p_occurred_on,'reason',p_reason,'ignored',p_ignored_item_ids);
$previous$,$updated$declare d erp_documents.document;data jsonb;replay jsonb;preview jsonb;items jsonb;movement jsonb;pid uuid;result jsonb;ack jsonb;wanted jsonb;begin
 perform erp_document_mirror.require_visible(p_user_id,p_document_id,true);

 data:=jsonb_build_object('kind',p_kind,'id',p_document_id,'version',p_expected_version,'warehouse_id',p_warehouse_id,'hash',p_preview_hash,'date',p_occurred_on,'reason',p_reason,'ignored',p_ignored_item_ids);
$updated$);
 execute definition;
end$migration$;

-- public.erp_stock_document_warehouse_preview
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_stock_document_warehouse_preview(uuid,text,uuid,integer,uuid,date,text)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$ declare d erp_documents.document;begin
 if p_warehouse_id is null then raise exception 'erp_document_stock_warehouse_required' using errcode='22023';end if;
$previous$,$updated$ declare d erp_documents.document;begin
 perform erp_document_mirror.require_visible(p_user_id,p_document_id,true);

 if p_warehouse_id is null then raise exception 'erp_document_stock_warehouse_required' using errcode='22023';end if;
$updated$);
 execute definition;
end$migration$;

-- public.erp_stock_item_components_save
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_stock_item_components_save(uuid,uuid,uuid,integer,uuid,integer,jsonb)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$declare h text;c erp_stock.item_component_command;d erp_documents.document;v_kind text;v_view jsonb;k erp_stock.item_component;v_before jsonb;v_after jsonb;v_result jsonb;v_clean jsonb;begin
 if p_command_id is null or p_document_id is null or p_item_id is null or p_expected_document_version is null or p_expected_document_version not between 1 and 2147483646
$previous$,$updated$declare h text;c erp_stock.item_component_command;d erp_documents.document;v_kind text;v_view jsonb;k erp_stock.item_component;v_before jsonb;v_after jsonb;v_result jsonb;v_clean jsonb;begin
 perform erp_document_mirror.require_visible(p_user_id,p_document_id,true);

 if p_command_id is null or p_document_id is null or p_item_id is null or p_expected_document_version is null or p_expected_document_version not between 1 and 2147483646
$updated$);
 execute definition;
end$migration$;

-- public.erp_stock_purchase_receive_preview
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_stock_purchase_receive_preview(uuid,uuid,integer,uuid,date,text,jsonb)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$declare d erp_documents.document;begin
 d:=erp_purchase_receipts.lock_document(p_user_id,p_document_id,p_expected_version);
$previous$,$updated$declare d erp_documents.document;begin
 perform erp_document_mirror.require_visible(p_user_id,p_document_id,true);

 d:=erp_purchase_receipts.lock_document(p_user_id,p_document_id,p_expected_version);
$updated$);
 execute definition;
end$migration$;

-- public.erp_stock_purchase_reverse_all
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_stock_purchase_reverse_all(uuid,uuid,uuid,integer)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$declare h text;c erp_stock.supply_command;d erp_documents.document;v_day date;v_reason text;v_version integer;r record;v_preview jsonb;v_applied jsonb;v_lines jsonb:='[]'::jsonb;v_result jsonb;begin
 perform erp_purchase_receipts.access(p_user_id);
$previous$,$updated$declare h text;c erp_stock.supply_command;d erp_documents.document;v_day date;v_reason text;v_version integer;r record;v_preview jsonb;v_applied jsonb;v_lines jsonb:='[]'::jsonb;v_result jsonb;begin
 perform erp_document_mirror.require_visible(p_user_id,p_document_id,true);

 perform erp_purchase_receipts.access(p_user_id);
$updated$);
 execute definition;
end$migration$;

-- public.erp_stock_reservation_apply
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_stock_reservation_apply(uuid,uuid,integer,uuid,text,text,date,text,jsonb,uuid,integer)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$declare d erp_documents.document;data jsonb;receipt jsonb;preview jsonb;rid uuid;ack jsonb;wanted jsonb;physical jsonb;posted jsonb;begin
 if p_action is null or p_action not in('reserve','release','consume') then raise exception 'erp_stock_reservation_invalid_action' using errcode='22023';end if;
$previous$,$updated$declare d erp_documents.document;data jsonb;receipt jsonb;preview jsonb;rid uuid;ack jsonb;wanted jsonb;physical jsonb;posted jsonb;begin
 perform erp_document_mirror.require_visible(p_user_id,p_document_id,true);

 if p_action is null or p_action not in('reserve','release','consume') then raise exception 'erp_stock_reservation_invalid_action' using errcode='22023';end if;
$updated$);
 execute definition;
end$migration$;

-- public.erp_stock_reservation_preview
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_stock_reservation_preview(uuid,uuid,integer,text,date,text,uuid,integer)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$declare d erp_documents.document;preview jsonb;begin
 if p_action is null or p_action not in('reserve','release','consume') or(p_action='reserve')<>(p_reservation_id is null) or(p_reservation_id is null and p_reservation_version is not null) then raise exception 'erp_stock_reservation_invalid_action' using errcode='22023';end if;
$previous$,$updated$declare d erp_documents.document;preview jsonb;begin
 perform erp_document_mirror.require_visible(p_user_id,p_document_id,true);

 if p_action is null or p_action not in('reserve','release','consume') or(p_action='reserve')<>(p_reservation_id is null) or(p_reservation_id is null and p_reservation_version is not null) then raise exception 'erp_stock_reservation_invalid_action' using errcode='22023';end if;
$updated$);
 execute definition;
end$migration$;

-- public.erp_purchase_receipts_receive
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_purchase_receipts_receive(uuid,uuid,integer,date,text,jsonb,uuid,text,boolean)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$
 select erp_purchase_receipts.apply(p_user_id,p_document_id,p_expected_version,'receive',p_occurred_on,p_reason,p_items,null,p_command_id,p_preview_hash,p_confirm)
$previous$,$updated$begin
 perform erp_document_mirror.require_visible(p_user_id,p_document_id,true);
 return (select erp_purchase_receipts.apply(p_user_id,p_document_id,p_expected_version,'receive',p_occurred_on,p_reason,p_items,null,p_command_id,p_preview_hash,p_confirm));
end$updated$);
 definition:=replace(definition,'LANGUAGE sql','LANGUAGE plpgsql');
 execute definition;
end$migration$;

-- public.erp_purchase_receipts_preview
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_purchase_receipts_preview(uuid,uuid,integer,date,text,jsonb)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$declare d erp_documents.document;begin
 d:=erp_purchase_receipts.lock_document(p_user_id,p_document_id,p_expected_version);
$previous$,$updated$declare d erp_documents.document;begin
 perform erp_document_mirror.require_visible(p_user_id,p_document_id,true);

 d:=erp_purchase_receipts.lock_document(p_user_id,p_document_id,p_expected_version);
$updated$);
 execute definition;
end$migration$;

-- public.erp_purchase_receipts_reverse
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_purchase_receipts_reverse(uuid,uuid,integer,uuid,date,text,uuid,text,boolean)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$
 select erp_purchase_receipts.apply(p_user_id,p_document_id,p_expected_version,'reverse',p_occurred_on,p_reason,null,p_receipt_id,p_command_id,p_preview_hash,p_confirm)
$previous$,$updated$begin
 perform erp_document_mirror.require_visible(p_user_id,p_document_id,true);
 return (select erp_purchase_receipts.apply(p_user_id,p_document_id,p_expected_version,'reverse',p_occurred_on,p_reason,null,p_receipt_id,p_command_id,p_preview_hash,p_confirm));
end$updated$);
 definition:=replace(definition,'LANGUAGE sql','LANGUAGE plpgsql');
 execute definition;
end$migration$;

-- public.erp_purchase_receipts_reverse_preview
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_purchase_receipts_reverse_preview(uuid,uuid,integer,uuid,date,text)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$declare d erp_documents.document;begin
 d:=erp_purchase_receipts.lock_document(p_user_id,p_document_id,p_expected_version);
$previous$,$updated$declare d erp_documents.document;begin
 perform erp_document_mirror.require_visible(p_user_id,p_document_id,true);

 d:=erp_purchase_receipts.lock_document(p_user_id,p_document_id,p_expected_version);
$updated$);
 execute definition;
end$migration$;

-- public.erp_service_event_append
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_service_event_append(uuid,uuid,integer,uuid,jsonb)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$ v_attachment uuid;correction uuid;reason text;seq bigint;snapshot jsonb;attachment_snapshot jsonb;begin
 perform erp_documents.require_access(p_user_id,'service_orders',true);
$previous$,$updated$ v_attachment uuid;correction uuid;reason text;seq bigint;snapshot jsonb;attachment_snapshot jsonb;begin
 perform erp_document_mirror.require_visible(p_user_id,p_document_id,true);

 perform erp_documents.require_access(p_user_id,'service_orders',true);
$updated$);
 execute definition;
end$migration$;

-- public.erp_service_journal_append
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_service_journal_append(uuid,uuid,integer,uuid,text)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$begin
 context:=erp_documents.service_journal_context(p_user_id,p_document_id,true);
$previous$,$updated$begin
 perform erp_document_mirror.require_visible(p_user_id,p_document_id,true);

 context:=erp_documents.service_journal_context(p_user_id,p_document_id,true);
$updated$);
 execute definition;
end$migration$;

-- public.erp_origin_proposal_import_apply
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_origin_proposal_import_apply(uuid,text,text,uuid,boolean,boolean)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$begin
 perform erp_cutover.require_admin(p_user_id);
$previous$,$updated$begin
 if exists(select 1 from erp_documents.origin_mirror where entity='sales_proposals'and source_id=p_source_id) then raise exception 'erp_document_mirror_import_forbidden' using errcode='42501';end if;

 perform erp_cutover.require_admin(p_user_id);
$updated$);
 execute definition;
end$migration$;

-- public.erp_origin_proposal_import_apply_v2
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_origin_proposal_import_apply_v2(uuid,text,text,uuid,boolean,boolean)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$begin
 perform erp_cutover.require_admin(p_user_id);
$previous$,$updated$begin
 if exists(select 1 from erp_documents.origin_mirror where entity='sales_proposals'and source_id=p_source_id) then raise exception 'erp_document_mirror_import_forbidden' using errcode='42501';end if;

 perform erp_cutover.require_admin(p_user_id);
$updated$);
 execute definition;
end$migration$;

-- erp_attachments.authorize
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('erp_attachments.authorize(uuid,text,uuid,boolean)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$begin
  perform erp_documents.require_access(p_user_id,p_kind,p_write);
$previous$,$updated$begin
 perform erp_document_mirror.require_visible(p_user_id,p_document_id,p_write);

  perform erp_documents.require_access(p_user_id,p_kind,p_write);
$updated$);
 execute definition;
end$migration$;

-- erp_documents.service_journal_context
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('erp_documents.service_journal_context(uuid,uuid,boolean)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$begin
 perform erp_documents.require_access(p_user_id,'service_orders',p_write);
$previous$,$updated$begin
 perform erp_document_mirror.require_visible(p_user_id,p_document_id,p_write);

 perform erp_documents.require_access(p_user_id,'service_orders',p_write);
$updated$);
 definition:=replace(definition,$previous$ return jsonb_build_object('scope','service_order_journal','document_id',d.id,'document_version',d.version,
  'can_write',erp_documents.allowed(r,'service_orders',true),'data_mode','erp_native','operational_effects',false);
end $previous$,$updated$ return jsonb_build_object('scope','service_order_journal','document_id',d.id,'document_version',d.version,
  'can_write',d.authority<>'origin' and erp_documents.allowed(r,'service_orders',true),'data_mode','erp_native','operational_effects',false);
end $updated$);
 execute definition;
end$migration$;

-- erp_documents.service_event_context
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('erp_documents.service_event_context(uuid,uuid)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$declare d erp_documents.document;r text;write_allowed boolean;begin
 perform erp_documents.require_access(p_actor,'service_orders',false);
$previous$,$updated$declare d erp_documents.document;r text;write_allowed boolean;begin
 perform erp_document_mirror.require_visible(p_actor,p_document_id,false);

 perform erp_documents.require_access(p_actor,'service_orders',false);
$updated$);
 definition:=replace(definition,$previous$ select role into r from erp_access.membership where user_id=p_actor and active;
 write_allowed:=erp_documents.allowed(r,'service_orders',true) and d.status<>'cancelled' and not coalesce((d.body->>'template')::boolean,false);
 return jsonb_build_object('scope','service_order_events','data_mode','erp_native','signature_verified',false,'consent_verified',false,
$previous$,$updated$ select role into r from erp_access.membership where user_id=p_actor and active;
 write_allowed:=d.authority<>'origin' and erp_documents.allowed(r,'service_orders',true) and d.status<>'cancelled' and not coalesce((d.body->>'template')::boolean,false);
 return jsonb_build_object('scope','service_order_events','data_mode','erp_native','signature_verified',false,'consent_verified',false,
$updated$);
 execute definition;
end$migration$;

-- public.erp_document_stock_list
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_document_stock_list(uuid,text,integer,uuid,text)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$ if p_limit is null or p_limit not between 1 and 100 or length(p_query)>100 or p_query~'[[:cntrl:]]' then raise exception 'erp_document_stock_invalid_query' using errcode='22023';end if;
 with page as materialized(select d.id from erp_documents.document d where d.kind=p_kind and(p_after is null or d.id>p_after)
  and(erp_stock.document_eligible(d.kind,d.status) or exists(select 1 from erp_stock.document_posting where document_id=d.id))
$previous$,$updated$ if p_limit is null or p_limit not between 1 and 100 or length(p_query)>100 or p_query~'[[:cntrl:]]' then raise exception 'erp_document_stock_invalid_query' using errcode='22023';end if;
 with page as materialized(select d.id from erp_documents.document d where d.origin='brufap' and d.kind=p_kind and(p_after is null or d.id>p_after)
  and(erp_stock.document_eligible(d.kind,d.status) or exists(select 1 from erp_stock.document_posting where document_id=d.id))
$updated$);
 execute definition;
end$migration$;

-- public.erp_fiscal_invoice_order_link_states
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_fiscal_invoice_order_link_states(uuid,jsonb)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$ select coalesce(jsonb_agg(jsonb_build_object('document_id',d.id,'state',erp_fiscal_invoices.order_link_state(d.id)) order by d.id),'[]'::jsonb)
 into v_items from erp_documents.document d where d.id=any(v_ids) and d.kind='purchase_orders';
 return jsonb_build_object('items',v_items,'data_mode','erp_native');
$previous$,$updated$ select coalesce(jsonb_agg(jsonb_build_object('document_id',d.id,'state',erp_fiscal_invoices.order_link_state(d.id)) order by d.id),'[]'::jsonb)
 into v_items from erp_documents.document d where erp_document_mirror.visible(p_user_id,d.id) and d.id=any(v_ids) and d.kind='purchase_orders';
 return jsonb_build_object('items',v_items,'data_mode','erp_native');
$updated$);
 execute definition;
end$migration$;

-- public.erp_preferences_label_records
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_preferences_label_records(uuid,text,text)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$  union all
  select lpad(d.number::text,12,'0'),jsonb_build_object('id',d.id,'values',jsonb_build_object('numero',d.number::text,'data',case when(d.body->>'date')~'^\d{4}-\d{2}-\d{2}$' then d.body->>'date' end,
   'cliente',erp_preferences.report_clean(d.contact_snapshot->>'name',200),
$previous$,$updated$  union all
  select lpad(d.number::text,12,'0'),jsonb_build_object('id',d.id,'origin',d.origin,'authority',d.authority,'values',jsonb_build_object('numero',d.number::text,'data',case when(d.body->>'date')~'^\d{4}-\d{2}-\d{2}$' then d.body->>'date' end,
   'cliente',erp_preferences.report_clean(d.contact_snapshot->>'name',200),
$updated$);
 definition:=replace(definition,$previous$   -(case when p_type='ordem_servico' then array['endereco_cliente','cidade_uf','cep'] else array[]::text[] end))
  from erp_documents.document d where d.kind=v_kind and(v_like is null or d.number::text like v_like or lower(coalesce(d.contact_snapshot->>'name','')) like v_like)
  union all
$previous$,$updated$   -(case when p_type='ordem_servico' then array['endereco_cliente','cidade_uf','cep'] else array[]::text[] end))
  from erp_documents.document d where erp_document_mirror.visible(p_user_id,d.id) and not exists(select 1 from erp_documents.origin_mirror bm where bm.document_id=d.id and bm.source_deleted) and d.kind=v_kind and(v_like is null or d.number::text like v_like or lower(coalesce(d.contact_snapshot->>'name','')) like v_like)
  union all
$updated$);
 execute definition;
end$migration$;

-- erp_documents.numbering_dto
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('erp_documents.numbering_dto(text)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$ select jsonb_build_object('kind',n.kind,'next_number',case when n.last_number<9999999999 then (n.last_number+1)::text end,'reserved',false,
  'minimum_next_number',(select case when coalesce(max(d.number),0)<9999999999 then (coalesce(max(d.number),0)+1)::text end from erp_documents.document d where d.kind=n.kind),
  'data_mode','erp_native','operational_effects',false)
$previous$,$updated$ select jsonb_build_object('kind',n.kind,'next_number',case when n.last_number<9999999999 then (n.last_number+1)::text end,'reserved',false,
  'minimum_next_number',(select case when coalesce(max(d.number),0)<9999999999 then (coalesce(max(d.number),0)+1)::text end from erp_documents.document d where d.origin='brufap' and d.kind=n.kind),
  'data_mode','erp_native','operational_effects',false)
$updated$);
 execute definition;
end$migration$;

-- public.erp_document_numbering_set
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_document_numbering_set(uuid,text,uuid,text,text)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$ v_next:=p_next_number::bigint;
 select coalesce(max(number),0) into v_max from erp_documents.document where kind=p_kind;
 if v_next<=v_max then raise exception 'erp_document_number_taken' using errcode='23505'; end if;
$previous$,$updated$ v_next:=p_next_number::bigint;
 select coalesce(max(number),0) into v_max from erp_documents.document where origin='brufap' and kind=p_kind;
 if v_next<=v_max then raise exception 'erp_document_number_taken' using errcode='23505'; end if;
$updated$);
 execute definition;
end$migration$;

-- erp_preferences.report_source
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('erp_preferences.report_source(text)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$ from erp_documents.document d
 where d.kind=case p_base when 'vendas' then 'sales_orders' when 'propostas' then 'sales_proposals' when 'pedidos_compra' then 'purchase_orders' when 'ordens_servico' then 'service_orders' end
 union all
$previous$,$updated$ from erp_documents.document d
 where d.origin='brufap' and d.kind=case p_base when 'vendas' then 'sales_orders' when 'propostas' then 'sales_proposals' when 'pedidos_compra' then 'purchase_orders' when 'ordens_servico' then 'service_orders' end
 union all
$updated$);
 definition:=replace(definition,$previous$  from erp_documents.document d cross join lateral jsonb_array_elements(case when jsonb_typeof(d.body->'installments')='array' then d.body->'installments' else '[]'::jsonb end) with ordinality i(p,n)
  where d.kind='sales_orders';
 elsif p_base='comissoes' then
$previous$,$updated$  from erp_documents.document d cross join lateral jsonb_array_elements(case when jsonb_typeof(d.body->'installments')='array' then d.body->'installments' else '[]'::jsonb end) with ordinality i(p,n)
  where d.origin='brufap' and d.kind='sales_orders';
 elsif p_base='comissoes' then
$updated$);
 definition:=replace(definition,$previous$    from erp_documents.document d join erp_documents.item i on i.document_id=d.id
    where d.kind='sales_orders' and d.status not in('draft','cancelled') and i.product_id is not null group by i.product_id),
   ranked as materialized(select s.*,r.code,r.name,row_number() over(order by s.amount desc,s.product_id) n,
$previous$,$updated$    from erp_documents.document d join erp_documents.item i on i.document_id=d.id
    where d.origin='brufap' and d.kind='sales_orders' and d.status not in('draft','cancelled') and i.product_id is not null group by i.product_id),
   ranked as materialized(select s.*,r.code,r.name,row_number() over(order by s.amount desc,s.product_id) n,
$updated$);
 definition:=replace(definition,$previous$  from erp_documents.occurrence o join erp_documents.document d on d.id=o.document_id
  where d.kind=case p_base when 'ocorrencias_propostas' then 'sales_proposals' when 'ocorrencias_os' then 'service_orders' else 'sales_orders' end
   and not exists(select 1 from erp_documents.occurrence_removal x where x.occurrence_id=o.id);
$previous$,$updated$  from erp_documents.occurrence o join erp_documents.document d on d.id=o.document_id
  where d.origin='brufap' and d.kind=case p_base when 'ocorrencias_propostas' then 'sales_proposals' when 'ocorrencias_os' then 'service_orders' else 'sales_orders' end
   and not exists(select 1 from erp_documents.occurrence_removal x where x.occurrence_id=o.id);
$updated$);
 definition:=replace(definition,$previous$   'rastreamento',erp_preferences.report_clean(d.body#>>'{commercial,transport,tracking_code}',200))
  from erp_documents.document d where d.kind='sales_orders';
 elsif p_base='transporte_nota' then
$previous$,$updated$   'rastreamento',erp_preferences.report_clean(d.body#>>'{commercial,transport,tracking_code}',200))
  from erp_documents.document d where d.origin='brufap' and d.kind='sales_orders';
 elsif p_base='transporte_nota' then
$updated$);
 execute definition;
end$migration$;

-- erp_home.biz_new_customers
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('erp_home.biz_new_customers(date,text[])'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$ select count(distinct o.contact_id)::integer from erp_home.biz_orders(p_day,p_day,p_statuses) o
 where not exists(select 1 from erp_documents.document d where d.kind='sales_orders' and d.contact_id=o.contact_id and d.status=any(p_statuses)
  and(d.body->>'date')~'^\d{4}-\d{2}-\d{2}$' and(d.body->>'date')::date<p_day)
$previous$,$updated$ select count(distinct o.contact_id)::integer from erp_home.biz_orders(p_day,p_day,p_statuses) o
 where not exists(select 1 from erp_documents.document d where d.origin='brufap' and d.kind='sales_orders' and d.contact_id=o.contact_id and d.status=any(p_statuses)
  and(d.body->>'date')~'^\d{4}-\d{2}-\d{2}$' and(d.body->>'date')::date<p_day)
$updated$);
 execute definition;
end$migration$;

-- erp_home.notification_digest
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('erp_home.notification_digest(text,date)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$ select count(*)::integer,null from erp_documents.document d
  where p_type='proximo_contato' and d.kind='sales_proposals' and d.status not in('completed','cancelled','rejected') and d.body->>'next_contact'=to_char(p_today,'YYYY-MM-DD')
 union all
$previous$,$updated$ select count(*)::integer,null from erp_documents.document d
  where d.origin='brufap' and p_type='proximo_contato' and d.kind='sales_proposals' and d.status not in('completed','cancelled','rejected') and d.body->>'next_contact'=to_char(p_today,'YYYY-MM-DD')
 union all
$updated$);
 execute definition;
end$migration$;

-- erp_home.biz_unit_cost
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('erp_home.biz_unit_cost(uuid)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$ select i.unit_price from erp_documents.document d join erp_documents.item i on i.document_id=d.id
 where d.kind='purchase_orders' and d.status<>'cancelled' and i.product_id=p_product
 order by d.body->>'date' desc nulls last,d.created_at desc,i.position limit 1
$previous$,$updated$ select i.unit_price from erp_documents.document d join erp_documents.item i on i.document_id=d.id
 where d.origin='brufap'and d.kind='purchase_orders' and d.status<>'cancelled' and i.product_id=p_product
 order by d.body->>'date' desc nulls last,d.created_at desc,i.position limit 1
$updated$);
 execute definition;
end$migration$;

-- public.erp_catalog_product_purchase_info
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_catalog_product_purchase_info(uuid,uuid[],uuid)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$  left join lateral(select i.unit_price raw,erp_catalog.unit_price_numeric(i.unit_price,14) price from erp_documents.item i join erp_documents.document o on o.id=i.document_id
    where v_orders and i.product_id=u.id and o.kind='purchase_orders' and o.status<>'cancelled' order by o.body->>'date' desc nulls last,o.created_at desc,i.position limit 1) lp on true) x),'[]'::jsonb));
end $previous$,$updated$  left join lateral(select i.unit_price raw,erp_catalog.unit_price_numeric(i.unit_price,14) price from erp_documents.item i join erp_documents.document o on o.id=i.document_id
    where o.origin='brufap'and v_orders and i.product_id=u.id and o.kind='purchase_orders' and o.status<>'cancelled' order by o.body->>'date' desc nulls last,o.created_at desc,i.position limit 1) lp on true) x),'[]'::jsonb));
end $updated$);
 execute definition;
end$migration$;

-- public.erp_document_access
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_document_access(uuid)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$ if not found then raise exception 'erp_document_access_denied' using errcode='42501'; end if;
 return jsonb_build_object('read',(select coalesce(jsonb_agg(k order by k),'[]'::jsonb) from jsonb_object_keys(erp_documents.transitions()) k where erp_documents.kind_allowed(p_user_id,v_role,k,false)),
  'write',(select coalesce(jsonb_agg(k order by k),'[]'::jsonb) from jsonb_object_keys(erp_documents.transitions()) k where erp_documents.kind_allowed(p_user_id,v_role,k,true)),
$previous$,$updated$ if not found then raise exception 'erp_document_access_denied' using errcode='42501'; end if;
 return (jsonb_build_object('read',(select coalesce(jsonb_agg(k order by k),'[]'::jsonb) from jsonb_object_keys(erp_documents.transitions()) k where erp_documents.kind_allowed(p_user_id,v_role,k,false)),
  'write',(select coalesce(jsonb_agg(k order by k),'[]'::jsonb) from jsonb_object_keys(erp_documents.transitions()) k where erp_documents.kind_allowed(p_user_id,v_role,k,true)),
$updated$);
 definition:=replace(definition,$previous$    'approval_situations',to_jsonb(erp_documents.approval_situations()))),
  'data_mode','erp_native','operational_effects',false);
end $previous$,$updated$    'approval_situations',to_jsonb(erp_documents.approval_situations()))),
  'data_mode','erp_native','operational_effects',false))||jsonb_build_object('mirror_available',true);
end $updated$);
 execute definition;
end$migration$;

-- public.erp_stock_source_lots
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_stock_source_lots(uuid,text,uuid,uuid)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$ if p_source='document' then
  select * into d from erp_documents.document where id=p_source_id and kind in('sales_orders','purchase_orders','service_orders');
$previous$,$updated$ if p_source='document' then
  perform erp_document_mirror.require_visible(p_user_id,p_source_id,false);
  select * into d from erp_documents.document where id=p_source_id and kind in('sales_orders','purchase_orders','service_orders');
$updated$);
 definition:=replace(definition,$previous$   from erp_catalog.record r join erp_catalog.product p on p.record_id=r.id where r.id=p_product_id),
  'lines',v_lines,'settings',erp_stock.lot_settings(),'can_write',coalesce(v_role in('admin','estoque'),false));
end$previous$,$updated$   from erp_catalog.record r join erp_catalog.product p on p.record_id=r.id where r.id=p_product_id),
  'lines',v_lines,'settings',erp_stock.lot_settings(),'can_write',coalesce(v_role in('admin','estoque'),false)and not exists(select 1 from erp_documents.document mirror where mirror.id=v_doc and mirror.authority='origin'));
end$updated$);
 execute definition;
end$migration$;

-- public.erp_preferences_report_run
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_preferences_report_run(uuid,text,jsonb,jsonb,integer,integer,integer)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$ into v_count,v_rows,v_totals;
 return jsonb_build_object('scope','report_rows','data_mode','erp_native','base',p_base,'columns',p_columns,'rows',v_rows,'offset',p_offset,
  'total_rows',least(v_count,p_view_limit),'truncated',v_count>p_view_limit,'totals',v_totals);
end $previous$,$updated$ into v_count,v_rows,v_totals;
 return (jsonb_build_object('scope','report_rows','data_mode','erp_native','base',p_base,'columns',p_columns,'rows',v_rows,'offset',p_offset,
  'total_rows',least(v_count,p_view_limit),'truncated',v_count>p_view_limit,'totals',v_totals))||case when(case when p_base in('vendas','venda_parcela','curva_abc','ocorrencias_vendas','transporte_venda')then'sales_orders'when p_base in('propostas','ocorrencias_propostas')then'sales_proposals'when p_base='pedidos_compra'then'purchase_orders'when p_base in('ordens_servico','ocorrencias_os')then'service_orders'end)is not null then erp_document_mirror.report_coverage(p_user_id,case when p_base in('vendas','venda_parcela','curva_abc','ocorrencias_vendas','transporte_venda')then'sales_orders'when p_base in('propostas','ocorrencias_propostas')then'sales_proposals'when p_base='pedidos_compra'then'purchase_orders'when p_base in('ordens_servico','ocorrencias_os')then'service_orders'end,null,null)else'{}'::jsonb end;
end $updated$);
 execute definition;
end$migration$;

-- public.erp_fiscal_draft_execute
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_fiscal_draft_execute(uuid,uuid,text,jsonb)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$begin
 perform erp_fiscal_drafts.require_access(p_user_id);
$previous$,$updated$begin
 if jsonb_typeof(p_data->'source_document_id')='string'and(p_data->>'source_document_id')~'^[0-9a-fA-F-]{36}$'then perform erp_document_mirror.require_visible(p_user_id,(p_data->>'source_document_id')::uuid,true);end if;

 perform erp_fiscal_drafts.require_access(p_user_id);
$updated$);
 execute definition;
end$migration$;

-- public.erp_fiscal_invoice_link
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_fiscal_invoice_link(uuid,uuid,jsonb)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$begin
 role:=erp_fiscal_invoices.require_write(p_user_id);
$previous$,$updated$begin
 if jsonb_typeof(p_data->'document_id')='string'and(p_data->>'document_id')~'^[0-9a-fA-F-]{36}$'then perform erp_document_mirror.require_visible(p_user_id,(p_data->>'document_id')::uuid,true);end if;

 role:=erp_fiscal_invoices.require_write(p_user_id);
$updated$);
 execute definition;
end$migration$;

-- public.erp_document_trash
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_document_trash(uuid,uuid,text,text,jsonb,text)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$ select array_agg(distinct (x#>>'{}')::uuid order by (x#>>'{}')::uuid) into v_ids from jsonb_array_elements(p_ids) x;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('kind',p_kind,'action',p_action,'ids',to_jsonb(v_ids),'reason',v_reason)::text,'UTF8')),'hex');
$previous$,$updated$ select array_agg(distinct (x#>>'{}')::uuid order by (x#>>'{}')::uuid) into v_ids from jsonb_array_elements(p_ids) x;
 perform erp_document_mirror.require_visible(p_user_id,x,true)from unnest(v_ids)x;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('kind',p_kind,'action',p_action,'ids',to_jsonb(v_ids),'reason',v_reason)::text,'UTF8')),'hex');
$updated$);
 execute definition;
end$migration$;

-- public.erp_finance_grouped_billing_execute
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_finance_grouped_billing_execute(uuid,uuid,text,jsonb)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$  if p_data is null or jsonb_typeof(p_data)<>'object' or octet_length(p_data::text)>262144 then raise exception 'erp_finance_invalid_data' using errcode='22023'; end if;
  v_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'action',p_action,'data',p_data)::text,'UTF8')),'hex');
$previous$,$updated$  if p_data is null or jsonb_typeof(p_data)<>'object' or octet_length(p_data::text)>262144 then raise exception 'erp_finance_invalid_data' using errcode='22023'; end if;
  perform erp_document_mirror.require_visible(p_user_id,(x#>>'{}')::uuid,true)from jsonb_path_query(p_data,'$.items[*].document_ids[*]')x where jsonb_typeof(x)='string'and(x#>>'{}')~'^[0-9a-fA-F-]{36}$';
  v_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'action',p_action,'data',p_data)::text,'UTF8')),'hex');
$updated$);
 execute definition;
end$migration$;

-- public.erp_document_history
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_document_history(uuid,text,uuid,uuid,text,integer)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$ with lines as (
  select case when v_purchase then 'purchase' else 'sale' end as type,d.id as document_id,d.number::bigint as num,(d.body->>'date')::date as day,i.position,
   coalesce(i.data->>'description','') as description,nullif(i.data->>'code','') as code,i.product_id,coalesce(i.data->>'unit','') as unit,
   i.quantity::numeric(24,6) as quantity,i.unit_price
  from erp_documents.document d join erp_documents.item i on i.document_id=d.id
  where d.kind=case when v_purchase then 'purchase_orders' else 'sales_orders' end and d.status<>'cancelled'
   and (p_contact_id is null or d.contact_id=p_contact_id) and (p_product_id is null or i.product_id=p_product_id) and erp_catalog.contact_visible_to(v_scope,d.contact_id)
  union all
  select 'invoice',v.id,v.number::bigint,v.issue_date,t.position,coalesce(t.data->>'description',''),nullif(t.data->>'code',''),t.product_id,
   coalesce(t.data->>'unit',''),t.quantity::numeric(24,6),t.unit_price
  from erp_fiscal_invoices.invoice v join erp_fiscal_invoices.invoice_item t on t.invoice_id=v.id
$previous$,$updated$ with lines as (
  select case when v_purchase then 'purchase' else 'sale' end as type,d.origin as origin,d.id as document_id,d.number::bigint as num,(d.body->>'date')::date as day,i.position,
   coalesce(i.data->>'description','') as description,nullif(i.data->>'code','') as code,i.product_id,coalesce(i.data->>'unit','') as unit,
   i.quantity::numeric(24,6) as quantity,i.unit_price,i.data->>'quantity' observed_quantity,i.data->>'unit_price' observed_price
  from erp_documents.document d join erp_documents.item i on i.document_id=d.id
  where not exists(select 1 from erp_documents.origin_mirror bm where bm.document_id=d.id and bm.source_deleted) and d.kind=case when v_purchase then 'purchase_orders' else 'sales_orders' end and d.status<>'cancelled'
   and (p_contact_id is null or d.contact_id=p_contact_id) and (p_product_id is null or i.product_id=p_product_id) and erp_catalog.contact_visible_to(v_scope,d.contact_id)
  union all
  select 'invoice','brufap',v.id,v.number::bigint,v.issue_date,t.position,coalesce(t.data->>'description',''),nullif(t.data->>'code',''),t.product_id,
   coalesce(t.data->>'unit',''),t.quantity::numeric(24,6),t.unit_price,null::text,null::text
  from erp_fiscal_invoices.invoice v join erp_fiscal_invoices.invoice_item t on t.invoice_id=v.id
$updated$);
 definition:=replace(definition,$previous$  -- 239: manual entries (Lançar estoque, entrada) not reversed, for the purchases of a product from every fornecedor.
  select 'stock',m.id,null::bigint,m.occurred_on,e.ordinal,left(coalesce(r.name,''),200),nullif(r.code,''),e.product_id,coalesce(e.unit,''),e.quantity::numeric(24,6),
   coalesce((select coalesce(md.unit_price,md.unit_cost) from erp_stock.movement_detail md where md.movement_id=m.id and md.product_id=e.product_id order by md.revision desc limit 1),0)
  from erp_stock.movement m join erp_stock.entry e on e.movement_id=m.id join erp_catalog.record r on r.id=e.product_id
$previous$,$updated$  -- 239: manual entries (Lançar estoque, entrada) not reversed, for the purchases of a product from every fornecedor.
  select 'stock','brufap',m.id,null::bigint,m.occurred_on,e.ordinal,left(coalesce(r.name,''),200),nullif(r.code,''),e.product_id,coalesce(e.unit,''),e.quantity::numeric(24,6),
   coalesce((select coalesce(md.unit_price,md.unit_cost) from erp_stock.movement_detail md where md.movement_id=m.id and md.product_id=e.product_id order by md.revision desc limit 1),0),null::text,null::text
  from erp_stock.movement m join erp_stock.entry e on e.movement_id=m.id join erp_catalog.record r on r.id=e.product_id
$updated$);
 definition:=replace(definition,$previous$ )
 select count(*)::integer,coalesce(jsonb_agg(jsonb_build_object('type',type,'document_id',document_id,'number',num::text,'date',day::text,'position',position,
   'description',left(description,200),'code',left(code,100),'product_id',product_id,'unit',left(unit,16),'quantity',quantity::text,
   'unit_price',erp_catalog.unit_price_numeric(unit_price,14)) order by day desc,num desc nulls last,position) filter (where rn<=p_limit),'[]'::jsonb)
 into v_count,v_items
$previous$,$updated$ )
 select count(*)::integer,coalesce(jsonb_agg(jsonb_build_object('type',type,'origin',origin,'document_id',document_id,'number',num::text,'date',day::text,'position',position,
   'description',left(description,200),'code',left(code,100),'product_id',product_id,'unit',left(unit,16),'quantity',case when origin='origin'then observed_quantity else quantity::text end,
   'unit_price',case when origin='origin'then observed_price else erp_catalog.unit_price_numeric(unit_price,14)end) order by day desc,num desc nulls last,position) filter (where rn<=p_limit),'[]'::jsonb)
 into v_count,v_items
$updated$);
 execute definition;
end$migration$;

-- public.erp_document_export
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_document_export(uuid,text,text,text,integer)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$ if v_from>v_to or v_to-v_from>366 then raise exception 'erp_document_period_invalid' using errcode='22023'; end if;
 select count(*) into v_count from erp_documents.document d where d.kind=p_kind and d.body->>'date' between p_date_from and p_date_to
  and erp_catalog.contact_visible_to(v_scope,d.contact_id);
$previous$,$updated$ if v_from>v_to or v_to-v_from>366 then raise exception 'erp_document_period_invalid' using errcode='22023'; end if;
 select count(*) into v_count from erp_documents.document d where not exists(select 1 from erp_documents.origin_mirror bm where bm.document_id=d.id and bm.source_deleted) and d.kind=p_kind and d.body->>'date' between p_date_from and p_date_to
  and erp_catalog.contact_visible_to(v_scope,d.contact_id);
$updated$);
 definition:=replace(definition,$previous$  select d.*,row_number() over(order by d.body->>'date',d.number,d.id) n from erp_documents.document d
  where d.kind=p_kind and d.body->>'date' between p_date_from and p_date_to and erp_catalog.contact_visible_to(v_scope,d.contact_id)
  order by d.body->>'date',d.number,d.id offset (p_page-1)*v_size limit v_size)
 select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'number',p.number::text,'date',p.body->>'date','expected_date',p.body->>'expected_date','status',p.status,
   'situation_name',(erp_documents.situation_json(p.kind,p.status,(select s.situation_id from erp_documents.document_situation s where s.document_id=p.id)))->>'name',
$previous$,$updated$  select d.*,row_number() over(order by d.body->>'date',d.number,d.id) n from erp_documents.document d
  where not exists(select 1 from erp_documents.origin_mirror bm where bm.document_id=d.id and bm.source_deleted) and d.kind=p_kind and d.body->>'date' between p_date_from and p_date_to and erp_catalog.contact_visible_to(v_scope,d.contact_id)
  order by d.body->>'date',d.number,d.id offset (p_page-1)*v_size limit v_size)
 select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'origin',p.origin,'authority',p.authority,'readonly',p.authority='origin','mirror',case when p.origin='origin' then erp_document_mirror.metadata(p.id) end,'number',case when p.origin='origin' then(select bm.source_number from erp_documents.origin_mirror bm where bm.document_id=p.id)else p.number::text end,'date',p.body->>'date','expected_date',p.body->>'expected_date','status',p.status,
   'situation_name',(erp_documents.situation_json(p.kind,p.status,(select s.situation_id from erp_documents.document_situation s where s.document_id=p.id)))->>'name',
$updated$);
 definition:=replace(definition,$previous$   'order_reference',case when p.kind='purchase_orders' then p.body->>'order_reference' end,'internal_notes',left(p.body->>'internal_notes',4000),
   'freight',(p.body->>'freight'),'discount',(p.body#>>'{totals,discount}'),'total',p.total::text,
   'items',(select coalesce(jsonb_agg(jsonb_build_object('position',i.position,'code',i.data->>'code','description',i.data->>'description','unit',i.data->>'unit',
     'quantity',i.quantity::text,'unit_price',erp_catalog.unit_price_numeric(i.unit_price,10),'discount_percent',i.discount_percent::text,'total',i.total::text) order by i.position),'[]'::jsonb)
    from erp_documents.item i where i.document_id=p.id)) order by p.n),'[]'::jsonb) into v_items from page p;
$previous$,$updated$   'order_reference',case when p.kind='purchase_orders' then p.body->>'order_reference' end,'internal_notes',left(p.body->>'internal_notes',4000),
   'freight',(p.body->>'freight'),'discount',(p.body#>>'{totals,discount}'),'total',case when p.origin='origin'then(select bm.reconciliation->>'source_total'from erp_documents.origin_mirror bm where bm.document_id=p.id)else p.total::text end,
   'items',(select coalesce(jsonb_agg(jsonb_build_object('position',i.position,'code',i.data->>'code','description',i.data->>'description','unit',i.data->>'unit',
     'quantity',case when p.origin='origin'then i.data->>'quantity'else i.quantity::text end,'unit_price',case when p.origin='origin' then i.data->>'unit_price' else erp_catalog.unit_price_numeric(i.unit_price,10) end,'discount_percent',case when p.origin='origin'then i.data->>'discount_percent'else i.discount_percent::text end,'total',case when p.origin='origin'then i.data->>'total'else i.total::text end) order by i.position),'[]'::jsonb)
    from erp_documents.item i where i.document_id=p.id)) order by p.n),'[]'::jsonb) into v_items from page p;
$updated$);
 execute definition;
end$migration$;

-- public.erp_document_sales_report
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_document_sales_report(uuid,jsonb)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$  from erp_documents.document d
  where d.kind='sales_orders' and (v_statuses is null or d.status=any(v_statuses))
   -- 267: only the contacts of the seller of the user (Contato acessível somente ao vendedor vinculado).
$previous$,$updated$  from erp_documents.document d
  where d.origin='brufap' and d.kind='sales_orders' and (v_statuses is null or d.status=any(v_statuses))
   -- 267: only the contacts of the seller of the user (Contato acessível somente ao vendedor vinculado).
$updated$);
 definition:=replace(definition,$previous$    and not exists(select 1 from erp_fiscal_invoices.invoice_order o join erp_fiscal_invoices.invoice n on n.id=o.invoice_id where o.document_id=d.id and n.deleted_at is null)))
   and (not v_first or (d.status<>'cancelled' and not exists(select 1 from erp_documents.document f where f.kind='sales_orders' and f.contact_id=d.contact_id and f.status<>'cancelled'
    and f.id<>d.id and (f.body->>'date',f.number)<(d.body->>'date',d.number))))
$previous$,$updated$    and not exists(select 1 from erp_fiscal_invoices.invoice_order o join erp_fiscal_invoices.invoice n on n.id=o.invoice_id where o.document_id=d.id and n.deleted_at is null)))
   and (not v_first or (d.status<>'cancelled' and not exists(select 1 from erp_documents.document f where f.origin='brufap' and f.kind='sales_orders' and f.contact_id=d.contact_id and f.status<>'cancelled'
    and f.id<>d.id and (f.body->>'date',f.number)<(d.body->>'date',d.number))))
$updated$);
 definition:=replace(definition,$previous$ return jsonb_build_object('report','sales','group',v_group,'subgroup',v_sub,'from',v_from::text,'to',v_to::text,'date_type',v_date,'item_values',v_items,'include_freight',v_freight,
  'show_profit',v_profit,'profit_base',v_base,'groups',v_groups,'group_count',v_count,'truncated',v_count>2000,'totals',v_totals,'data_mode','erp_native','operational_effects',false);
end $previous$,$updated$ return jsonb_build_object('report','sales','group',v_group,'subgroup',v_sub,'from',v_from::text,'to',v_to::text,'date_type',v_date,'item_values',v_items,'include_freight',v_freight,
  'show_profit',v_profit,'profit_base',v_base,'groups',v_groups,'group_count',v_count,'truncated',v_count>2000,'totals',v_totals,'data_mode','erp_native','operational_effects',false)||erp_document_mirror.report_coverage(p_user_id,'sales_orders',v_from::text,v_to::text);
end $updated$);
 execute definition;
end$migration$;

-- public.erp_document_sales_abc
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_document_sales_abc(uuid,text,text)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$  from erp_documents.document d join erp_documents.item i on i.document_id=d.id
  where d.kind='sales_orders' and d.status<>'cancelled' and d.body->>'date' between v_from::text and v_to::text
   and erp_catalog.contact_visible_to(v_scope,d.contact_id)
$previous$,$updated$  from erp_documents.document d join erp_documents.item i on i.document_id=d.id
  where d.origin='brufap' and d.kind='sales_orders' and d.status<>'cancelled' and d.body->>'date' between v_from::text and v_to::text
   and erp_catalog.contact_visible_to(v_scope,d.contact_id)
$updated$);
 definition:=replace(definition,$previous$ return jsonb_build_object('report','abc','from',v_from::text,'to',v_to::text,'items',v_rows,'item_count',v_count,'truncated',v_count>5000,
  'total',coalesce(v_total,0)::numeric(20,2)::text,'data_mode','erp_native','operational_effects',false);
end $previous$,$updated$ return jsonb_build_object('report','abc','from',v_from::text,'to',v_to::text,'items',v_rows,'item_count',v_count,'truncated',v_count>5000,
  'total',coalesce(v_total,0)::numeric(20,2)::text,'data_mode','erp_native','operational_effects',false)||erp_document_mirror.report_coverage(p_user_id,'sales_orders',v_from::text,v_to::text);
end $updated$);
 execute definition;
end$migration$;

-- public.erp_document_service_report
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_document_service_report(uuid,jsonb)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$   coalesce((select sum(i.total) from erp_documents.item i where i.document_id=d.id and case when i.data?'group' then i.data->>'group'='part' else coalesce(i.product_snapshot->>'kind','')<>'S' end),0) parts
  from erp_documents.document d where d.kind='service_orders' and erp_catalog.contact_visible_to(v_scope,d.contact_id)
 ), filtered as(
$previous$,$updated$   coalesce((select sum(i.total) from erp_documents.item i where i.document_id=d.id and case when i.data?'group' then i.data->>'group'='part' else coalesce(i.product_snapshot->>'kind','')<>'S' end),0) parts
  from erp_documents.document d where d.origin='brufap' and d.kind='service_orders' and erp_catalog.contact_visible_to(v_scope,d.contact_id)
 ), filtered as(
$updated$);
 definition:=replace(definition,$previous$ into v_rows,v_count from (select f.*,row_number() over(order by f.day desc,f.number desc) rn from filtered f) f;
 return jsonb_build_object('report','service_orders','rows',v_rows,'row_count',v_count,'truncated',v_count>5000,'data_mode','erp_native','operational_effects',false);
end $previous$,$updated$ into v_rows,v_count from (select f.*,row_number() over(order by f.day desc,f.number desc) rn from filtered f) f;
 return jsonb_build_object('report','service_orders','rows',v_rows,'row_count',v_count,'truncated',v_count>5000,'data_mode','erp_native','operational_effects',false)||erp_document_mirror.report_coverage(p_user_id,'service_orders',null,null);
end $updated$);
 execute definition;
end$migration$;

-- public.erp_document_service_occurrence_report
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_document_service_occurrence_report(uuid,text,text,text)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$  from erp_documents.occurrence o join erp_documents.document d on d.id=o.document_id
  where d.kind='service_orders' and o.occurred_on between v_from and v_to and erp_catalog.contact_visible_to(v_scope,d.contact_id) and (p_status is null or coalesce(o.status_after,o.status_before)=p_status)
   and not exists(select 1 from erp_documents.occurrence_removal r where r.occurrence_id=o.id)) x;
 return jsonb_build_object('report','service_occurrences','from',v_from::text,'to',v_to::text,'rows',v_rows,'row_count',v_count,'truncated',v_count>5000,'data_mode','erp_native','operational_effects',false);
end $previous$,$updated$  from erp_documents.occurrence o join erp_documents.document d on d.id=o.document_id
  where d.origin='brufap' and d.kind='service_orders' and o.occurred_on between v_from and v_to and erp_catalog.contact_visible_to(v_scope,d.contact_id) and (p_status is null or coalesce(o.status_after,o.status_before)=p_status)
   and not exists(select 1 from erp_documents.occurrence_removal r where r.occurrence_id=o.id)) x;
 return jsonb_build_object('report','service_occurrences','from',v_from::text,'to',v_to::text,'rows',v_rows,'row_count',v_count,'truncated',v_count>5000,'data_mode','erp_native','operational_effects',false)||erp_document_mirror.report_coverage(p_user_id,'service_orders',v_from::text,v_to::text);
end $updated$);
 execute definition;
end$migration$;

-- public.erp_document_sales_romaneio
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_document_sales_romaneio(uuid,jsonb)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$  -- Without a chosen situação, the cancelled pedidos stay out of the romaneio.
  where d.kind='sales_orders' and (case when v_statuses is null then d.status<>'cancelled' else d.status=any(v_statuses) end)
   and erp_catalog.contact_visible_to(v_scope,d.contact_id)
$previous$,$updated$  -- Without a chosen situação, the cancelled pedidos stay out of the romaneio.
  where d.origin='brufap' and d.kind='sales_orders' and (case when v_statuses is null then d.status<>'cancelled' else d.status=any(v_statuses) end)
   and erp_catalog.contact_visible_to(v_scope,d.contact_id)
$updated$);
 definition:=replace(definition,$previous$ return jsonb_build_object('report','romaneio','from',v_from::text,'to',v_to::text,'date_type',v_date,'rows',v_rows,'row_count',v_count,'truncated',v_count>100,'totals',v_totals,
  'data_mode','erp_native','operational_effects',false);
end $previous$,$updated$ return jsonb_build_object('report','romaneio','from',v_from::text,'to',v_to::text,'date_type',v_date,'rows',v_rows,'row_count',v_count,'truncated',v_count>100,'totals',v_totals,
  'data_mode','erp_native','operational_effects',false)||erp_document_mirror.report_coverage(p_user_id,'sales_orders',v_from::text,v_to::text);
end $updated$);
 execute definition;
end$migration$;

-- erp_home.biz_orders
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('erp_home.biz_orders(date,date,text[])'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$ from erp_documents.document d
 where d.kind='sales_orders' and d.deleted_at is null and d.status=any(p_statuses) and(d.body->>'date')~'^\d{4}-\d{2}-\d{2}$' and(d.body->>'date')::date between p_from and p_to
$previous$,$updated$ from erp_documents.document d
 where d.origin='brufap' and d.kind='sales_orders' and d.deleted_at is null and d.status=any(p_statuses) and(d.body->>'date')~'^\d{4}-\d{2}-\d{2}$' and(d.body->>'date')::date between p_from and p_to
$updated$);
 execute definition;
end$migration$;

-- public.erp_home_summary
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_home_summary(uuid)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$  select coalesce(jsonb_agg(jsonb_build_object('kind',k,'count',
    (select count(*) from erp_documents.document d where d.kind=k),
    'statuses',(select coalesce(jsonb_agg(jsonb_build_object('status',s,'count',
      (select count(*) from erp_documents.document d where d.kind=k and d.status=s)) order by s),'[]'::jsonb)
      from jsonb_object_keys(erp_documents.transitions()->k) s)) order by k),'[]'::jsonb)
$previous$,$updated$  select coalesce(jsonb_agg(jsonb_build_object('kind',k,'count',
    (select count(*) from erp_documents.document d where d.origin='brufap' and d.kind=k),
    'statuses',(select coalesce(jsonb_agg(jsonb_build_object('status',s,'count',
      (select count(*) from erp_documents.document d where d.origin='brufap' and d.kind=k and d.status=s)) order by s),'[]'::jsonb)
      from jsonb_object_keys(erp_documents.transitions()->k) s)) order by k),'[]'::jsonb)
$updated$);
 definition:=replace(definition,$previous$  end if;
  return jsonb_build_object('data_mode','erp_native','as_of',statement_timestamp(),'business_date',v_today,
    'timezone','America/Sao_Paulo','role',v_role,'catalog',v_catalog,'documents',v_documents,'stock',v_stock,'finance',v_finance);
end $previous$,$updated$  end if;
  return (jsonb_build_object('data_mode','erp_native','as_of',statement_timestamp(),'business_date',v_today,
    'timezone','America/Sao_Paulo','role',v_role,'catalog',v_catalog,'documents',v_documents,'stock',v_stock,'finance',v_finance))||erp_document_mirror.report_coverage(p_user_id,null,null,null);
end $updated$);
 execute definition;
end$migration$;

-- public.erp_home_overview
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_home_overview(uuid,text,text,text)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$   select d.status,d.total from erp_documents.document d
   where d.kind='sales_orders' and d.body->>'date'>=v_from_text and d.body->>'date'<=v_to_text
  ) select jsonb_build_object('count',(select count(*) from orders),
$previous$,$updated$   select d.status,d.total from erp_documents.document d
   where d.origin='brufap' and d.kind='sales_orders' and d.body->>'date'>=v_from_text and d.body->>'date'<=v_to_text
  ) select jsonb_build_object('count',(select count(*) from orders),
$updated$);
 definition:=replace(definition,$previous$
 return v_base||jsonb_build_object('period',jsonb_build_object('key',p_period,'from',v_from_text,'to',v_to_text,
  'day_count',v_to-v_from+1,'grain',v_grain,'points',v_points,
  'sales',v_sales,'receivable',v_receivable,'payable',v_payable,'invoices',v_invoices));
end $previous$,$updated$
 return (v_base||jsonb_build_object('period',jsonb_build_object('key',p_period,'from',v_from_text,'to',v_to_text,
  'day_count',v_to-v_from+1,'grain',v_grain,'points',v_points,
  'sales',v_sales,'receivable',v_receivable,'payable',v_payable,'invoices',v_invoices)))||erp_document_mirror.report_coverage(p_user_id,null,null,null);
end $updated$);
 execute definition;
end$migration$;

-- public.erp_home_top_products
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_home_top_products(uuid,text,text,text)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$  from erp_documents.document d join erp_documents.item i on i.document_id=d.id join erp_catalog.record r on r.id=i.product_id
  where d.kind='sales_orders' and d.status<>'cancelled' and d.body->>'date'>=to_char(v_from,'YYYY-MM-DD') and d.body->>'date'<=to_char(v_to,'YYYY-MM-DD')
  group by i.product_id order by sum(i.quantity) desc,sum(i.total) desc,max(r.name),i.product_id limit 5) x;
 return jsonb_build_object('scope','home_top_products','data_mode','erp_native','key',p_period,'from',to_char(v_from,'YYYY-MM-DD'),'to',to_char(v_to,'YYYY-MM-DD'),'items',v_items);
end $previous$,$updated$  from erp_documents.document d join erp_documents.item i on i.document_id=d.id join erp_catalog.record r on r.id=i.product_id
  where d.origin='brufap' and d.kind='sales_orders' and d.status<>'cancelled' and d.body->>'date'>=to_char(v_from,'YYYY-MM-DD') and d.body->>'date'<=to_char(v_to,'YYYY-MM-DD')
  group by i.product_id order by sum(i.quantity) desc,sum(i.total) desc,max(r.name),i.product_id limit 5) x;
 return (jsonb_build_object('scope','home_top_products','data_mode','erp_native','key',p_period,'from',to_char(v_from,'YYYY-MM-DD'),'to',to_char(v_to,'YYYY-MM-DD'),'items',v_items))||erp_document_mirror.report_coverage(p_user_id,null,null,null);
end $updated$);
 execute definition;
end$migration$;

-- public.erp_home_business_customers
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_home_business_customers(uuid,jsonb,date,date)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$ v_role:=erp_home.biz_role(p_user_id);v_s:=erp_home.biz_statuses_json(p_statuses);perform erp_home.biz_period(p_from,p_to);v_cost:=erp_home.biz_cost_visible(v_role);
 return erp_home.biz_envelope('novos-recorrentes',v_role,jsonb_build_object('statuses',to_jsonb(v_s),'from',to_char(p_from,'YYYY-MM-DD'),'to',to_char(p_to,'YYYY-MM-DD')))
  ||(with o as materialized(select o.*,not exists(select 1 from erp_documents.document d where d.kind='sales_orders' and d.contact_id=o.contact_id and d.status=any(v_s)
      and(d.body->>'date')~'^\d{4}-\d{2}-\d{2}$' and(d.body->>'date')::date<p_from) is_new from erp_home.biz_orders(p_from,p_to,v_s) o),
$previous$,$updated$ v_role:=erp_home.biz_role(p_user_id);v_s:=erp_home.biz_statuses_json(p_statuses);perform erp_home.biz_period(p_from,p_to);v_cost:=erp_home.biz_cost_visible(v_role);
 return (erp_home.biz_envelope('novos-recorrentes',v_role,jsonb_build_object('statuses',to_jsonb(v_s),'from',to_char(p_from,'YYYY-MM-DD'),'to',to_char(p_to,'YYYY-MM-DD')))
  ||(with o as materialized(select o.*,not exists(select 1 from erp_documents.document d where d.origin='brufap' and d.kind='sales_orders' and d.contact_id=o.contact_id and d.status=any(v_s)
      and(d.body->>'date')~'^\d{4}-\d{2}-\d{2}$' and(d.body->>'date')::date<p_from) is_new from erp_home.biz_orders(p_from,p_to,v_s) o),
$updated$);
 definition:=replace(definition,$previous$       'profit',case when v_cost and lc.missing is false then erp_home.money(cu.revenue-lc.cost) end,'mobile',erp_home.biz_text(coalesce(nullif(c.mobile,''),c.phone),40)) order by cu.total desc,cu.name,cu.contact_id),'[]'::jsonb)
      from(select * from cu order by total desc,name,contact_id limit 300) cu left join lc on lc.contact_id=cu.contact_id left join erp_catalog.contact c on c.record_id=cu.contact_id),160000)));
end $previous$,$updated$       'profit',case when v_cost and lc.missing is false then erp_home.money(cu.revenue-lc.cost) end,'mobile',erp_home.biz_text(coalesce(nullif(c.mobile,''),c.phone),40)) order by cu.total desc,cu.name,cu.contact_id),'[]'::jsonb)
      from(select * from cu order by total desc,name,contact_id limit 300) cu left join lc on lc.contact_id=cu.contact_id left join erp_catalog.contact c on c.record_id=cu.contact_id),160000))))||erp_document_mirror.report_coverage(p_user_id,null,null,null);
end $updated$);
 execute definition;
end$migration$;

-- public.erp_home_business_goals
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_home_business_goals(uuid,text)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$ if p_tab is null or p_tab not in('andamento','inativas') then raise exception 'erp_home_business_input_invalid' using errcode='22023'; end if;
 return jsonb_build_object('scope','business_goals','data_mode','erp_native','role',v_role,'tab',p_tab,'can_manage',v_role='admin',
  'business_date',to_char(erp_home.biz_today(),'YYYY-MM-DD'),'statuses',to_jsonb(erp_home.biz_finished()),
  'total',(select count(*)::integer from erp_home.goal g where erp_home.goal_running(g)=(p_tab='andamento')),'items',erp_home.goals_json(p_tab='andamento',200),
  'sellers',(select coalesce(jsonb_agg(s order by s),'[]'::jsonb) from(select distinct erp_home.biz_seller(d.body) s from erp_documents.document d where d.kind='sales_orders' and erp_home.biz_seller(d.body) is not null order by 1 limit 200) x));
end $previous$,$updated$ if p_tab is null or p_tab not in('andamento','inativas') then raise exception 'erp_home_business_input_invalid' using errcode='22023'; end if;
 return (jsonb_build_object('scope','business_goals','data_mode','erp_native','role',v_role,'tab',p_tab,'can_manage',v_role='admin',
  'business_date',to_char(erp_home.biz_today(),'YYYY-MM-DD'),'statuses',to_jsonb(erp_home.biz_finished()),
  'total',(select count(*)::integer from erp_home.goal g where erp_home.goal_running(g)=(p_tab='andamento')),'items',erp_home.goals_json(p_tab='andamento',200),
  'sellers',(select coalesce(jsonb_agg(s order by s),'[]'::jsonb) from(select distinct erp_home.biz_seller(d.body) s from erp_documents.document d where d.origin='brufap' and d.kind='sales_orders' and erp_home.biz_seller(d.body) is not null order by 1 limit 200) x)))||erp_document_mirror.report_coverage(p_user_id,null,null,null);
end $updated$);
 execute definition;
end$migration$;

-- public.erp_stock_purchase_suggestion
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_stock_purchase_suggestion(uuid,date,date,integer,uuid,boolean,jsonb,jsonb,text,uuid)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$   join erp_catalog.product p on p.record_id=i.product_id
   where d.kind='sales_orders' and d.status=any(sales) and(d.body->>'date')~'^\d{4}-\d{2}-\d{2}$' and(d.body->>'date')::date between p_date_from and p_date_to
    and(p_warehouse_id is null or d.warehouse_id=p_warehouse_id) and p.kind='P'
$previous$,$updated$   join erp_catalog.product p on p.record_id=i.product_id
   where d.origin='brufap' and d.kind='sales_orders' and d.status=any(sales) and(d.body->>'date')~'^\d{4}-\d{2}-\d{2}$' and(d.body->>'date')::date between p_date_from and p_date_to
    and(p_warehouse_id is null or d.warehouse_id=p_warehouse_id) and p.kind='P'
$updated$);
 definition:=replace(definition,$previous$  ordered as materialized(select i.product_id,sum(greatest(i.quantity-erp_purchase_receipts.received(d.id,i.id),0)) quantity from erp_documents.document d join erp_documents.item i on i.document_id=d.id
   where d.kind='purchase_orders' and d.status=any(purchase) and(p_warehouse_id is null or d.warehouse_id=p_warehouse_id) and i.product_id in(select product_id from sold)
    and not exists(select 1 from erp_stock.document_posting dp where dp.document_id=d.id and dp.state='active')
$previous$,$updated$  ordered as materialized(select i.product_id,sum(greatest(i.quantity-erp_purchase_receipts.received(d.id,i.id),0)) quantity from erp_documents.document d join erp_documents.item i on i.document_id=d.id
   where d.origin='brufap' and d.kind='purchase_orders' and d.status=any(purchase) and(p_warehouse_id is null or d.warehouse_id=p_warehouse_id) and i.product_id in(select product_id from sold)
    and not exists(select 1 from erp_stock.document_posting dp where dp.document_id=d.id and dp.state='active')
$updated$);
 definition:=replace(definition,$previous$  last_purchase as materialized(select distinct on(i.product_id) i.product_id,i.unit_price from erp_documents.document d join erp_documents.item i on i.document_id=d.id
   where d.kind='purchase_orders' and d.status<>'cancelled' and i.product_id in(select product_id from sold) order by i.product_id,d.body->>'date' desc nulls last,d.created_at desc,i.position),
  -- The supplier of each product: the filtered one or, without a filter, the default one.
$previous$,$updated$  last_purchase as materialized(select distinct on(i.product_id) i.product_id,i.unit_price from erp_documents.document d join erp_documents.item i on i.document_id=d.id
   where d.origin='brufap' and d.kind='purchase_orders' and d.status<>'cancelled' and i.product_id in(select product_id from sold) order by i.product_id,d.body->>'date' desc nulls last,d.created_at desc,i.position),
  -- The supplier of each product: the filtered one or, without a filter, the default one.
$updated$);
 definition:=replace(definition,$previous$   order by suggestion desc,erp_catalog.fold(name),product_id)from(select * from computed order by suggestion desc,erp_catalog.fold(name),product_id limit 2000)c),'[]'::jsonb)) into v_result;
 return v_result;
end$previous$,$updated$   order by suggestion desc,erp_catalog.fold(name),product_id)from(select * from computed order by suggestion desc,erp_catalog.fold(name),product_id limit 2000)c),'[]'::jsonb)) into v_result;
 return (v_result)||erp_document_mirror.report_coverage(p_user_id,null,p_date_from::text,p_date_to::text);
end$updated$);
 execute definition;
end$migration$;

-- public.erp_stock_report_purchase_orders
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_stock_report_purchase_orders(uuid,date,date,jsonb,text)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$ with docs as materialized(select d.id,d.contact_id,d.contact_snapshot->>'name' contact_name,d.total from erp_documents.document d
   where d.kind='purchase_orders' and d.status=any(statuses) and(d.body->>'date')~'^\d{4}-\d{2}-\d{2}$' and(d.body->>'date')::date between p_date_from and p_date_to),
  items as materialized(select i.document_id,i.product_id,coalesce(r.name,nullif(btrim(i.data->>'description'),''),'Item sem descrição') name,r.code,i.quantity,i.total from erp_documents.item i join docs on docs.id=i.document_id
$previous$,$updated$ with docs as materialized(select d.id,d.contact_id,d.contact_snapshot->>'name' contact_name,d.total from erp_documents.document d
   where d.origin='brufap' and d.kind='purchase_orders' and d.status=any(statuses) and(d.body->>'date')~'^\d{4}-\d{2}-\d{2}$' and(d.body->>'date')::date between p_date_from and p_date_to),
  items as materialized(select i.document_id,i.product_id,coalesce(r.name,nullif(btrim(i.data->>'description'),''),'Item sem descrição') name,r.code,i.quantity,i.total from erp_documents.item i join docs on docs.id=i.document_id
$updated$);
 definition:=replace(definition,$previous$  'totals',jsonb_build_object('orders',(select count(*)from docs)::integer,'quantity',(select coalesce(sum(quantity),0)from items)::numeric(38,6)::text,'value',(select coalesce(sum(total),0)from docs)::numeric(38,2)::text)) into v;
 return v;
end$previous$,$updated$  'totals',jsonb_build_object('orders',(select count(*)from docs)::integer,'quantity',(select coalesce(sum(quantity),0)from items)::numeric(38,6)::text,'value',(select coalesce(sum(total),0)from docs)::numeric(38,2)::text)) into v;
 return (v)||erp_document_mirror.report_coverage(p_user_id,'purchase_orders',p_date_from::text,p_date_to::text);
end$updated$);
 execute definition;
end$migration$;

-- public.erp_finance_grouped_billing_candidates
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_finance_grouped_billing_candidates(uuid,date,date,uuid[],text,integer,integer)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$    from erp_documents.document d
    where d.kind='sales_orders' and erp_finance.grouped_billing_eligible(d)
      and (case when p_documents is not null then d.id=any(p_documents) else (d.body->>'date') between p_from::text and p_to::text end)
$previous$,$updated$    from erp_documents.document d
    where d.origin='brufap' and d.kind='sales_orders' and erp_finance.grouped_billing_eligible(d)
      and (case when p_documents is not null then d.id=any(p_documents) else (d.body->>'date') between p_from::text and p_to::text end)
$updated$);
 execute definition;
end$migration$;

-- public.erp_finance_grouped_billing_documents
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_finance_grouped_billing_documents(uuid,uuid,date,date,uuid[])'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$    select d.id,'sales_orders'::text as kind,d.number::text as number,d.number::bigint as number_sort,d.body->>'date' as day,(d.total*100)::bigint as cents,d.version,null::jsonb as orders from erp_documents.document d
    where d.kind='sales_orders' and d.contact_id=p_contact and erp_finance.grouped_billing_eligible(d)
      and (case when p_documents is not null then d.id=any(p_documents) else (d.body->>'date') between p_from::text and p_to::text end)
$previous$,$updated$    select d.id,'sales_orders'::text as kind,d.number::text as number,d.number::bigint as number_sort,d.body->>'date' as day,(d.total*100)::bigint as cents,d.version,null::jsonb as orders from erp_documents.document d
    where d.origin='brufap' and d.kind='sales_orders' and d.contact_id=p_contact and erp_finance.grouped_billing_eligible(d)
      and (case when p_documents is not null then d.id=any(p_documents) else (d.body->>'date') between p_from::text and p_to::text end)
$updated$);
 execute definition;
end$migration$;

-- public.erp_catalog_contact_history
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_catalog_contact_history(uuid,uuid,text)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$ exception when insufficient_privilege then v_visible:=false; end;
 return jsonb_build_object('scope','contact_history','data_mode','erp_native','contact_id',p_contact_id,'kind',p_kind,'visible',v_visible,
  'items',case when v_visible then(select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'number',d.number::text,'date',d.body->>'date','status',d.status,'total',d.total::text)
    order by d.body->>'date' desc,d.number desc),'[]'::jsonb)
   from(select * from erp_documents.document where kind=p_kind and contact_id=p_contact_id order by body->>'date' desc,number desc limit 10) d) else '[]'::jsonb end);
end $previous$,$updated$ exception when insufficient_privilege then v_visible:=false; end;
 return (jsonb_build_object('scope','contact_history','data_mode','erp_native','contact_id',p_contact_id,'kind',p_kind,'visible',v_visible,
  'items',case when v_visible then(select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'number',d.number::text,'date',d.body->>'date','status',d.status,'total',d.total::text)
    order by d.body->>'date' desc,d.number desc),'[]'::jsonb)
   from(select * from erp_documents.document where origin='brufap'and kind=p_kind and contact_id=p_contact_id order by body->>'date' desc,number desc limit 10) d) else '[]'::jsonb end))||erp_document_mirror.report_coverage(p_user_id,p_kind,null,null,p_contact_id);
end $updated$);
 execute definition;
end$migration$;

-- public.erp_catalog_contact_sales
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_catalog_contact_sales(uuid,uuid)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$ exception when insufficient_privilege then v_visible:=false; end;
 return jsonb_build_object('scope','contact_sales','data_mode','erp_native','contact_id',p_contact_id,'visible',v_visible,
  'items',case when v_visible then(select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'number',d.number::text,'date',d.body->>'date','status',d.status,'total',d.total::text)
    order by d.body->>'date' desc,d.number desc),'[]'::jsonb)
   from(select * from erp_documents.document where kind='sales_orders' and contact_id=p_contact_id order by body->>'date' desc,number desc limit 10) d) else '[]'::jsonb end);
end $previous$,$updated$ exception when insufficient_privilege then v_visible:=false; end;
 return (jsonb_build_object('scope','contact_sales','data_mode','erp_native','contact_id',p_contact_id,'visible',v_visible,
  'items',case when v_visible then(select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'number',d.number::text,'date',d.body->>'date','status',d.status,'total',d.total::text)
    order by d.body->>'date' desc,d.number desc),'[]'::jsonb)
   from(select * from erp_documents.document where origin='brufap'and kind='sales_orders' and contact_id=p_contact_id order by body->>'date' desc,number desc limit 10) d) else '[]'::jsonb end))||erp_document_mirror.report_coverage(p_user_id,'sales_orders',null,null,p_contact_id);
end $updated$);
 execute definition;
end$migration$;

-- public.erp_home_business_channels
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_home_business_channels(uuid)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$ v_role:=erp_home.biz_role(p_user_id);v_s:=erp_home.biz_finished();v_end:=date_trunc('month',erp_home.biz_today()::timestamp)::date;v_start:=(v_end-interval '23 months')::date;
 return erp_home.biz_envelope('venda-canal',v_role,jsonb_build_object('statuses',to_jsonb(v_s),'from',to_char(v_start,'YYYY-MM-DD'),'to',to_char((v_end+interval '1 month'-interval '1 day')::date,'YYYY-MM-DD')))
  ||(with o as materialized(select * from erp_home.biz_orders(v_start,(v_end+interval '1 month'-interval '1 day')::date,v_s)),
$previous$,$updated$ v_role:=erp_home.biz_role(p_user_id);v_s:=erp_home.biz_finished();v_end:=date_trunc('month',erp_home.biz_today()::timestamp)::date;v_start:=(v_end-interval '23 months')::date;
 return (erp_home.biz_envelope('venda-canal',v_role,jsonb_build_object('statuses',to_jsonb(v_s),'from',to_char(v_start,'YYYY-MM-DD'),'to',to_char((v_end+interval '1 month'-interval '1 day')::date,'YYYY-MM-DD')))
  ||(with o as materialized(select * from erp_home.biz_orders(v_start,(v_end+interval '1 month'-interval '1 day')::date,v_s)),
$updated$);
 definition:=replace(definition,$previous$      'total',erp_home.money((select sum(o.total) from o where o.channel=c.channel and date_trunc('month',o.day::timestamp)=g.m))) order by c.n),'[]'::jsonb) from c)) order by g.m)
     from generate_series(v_start::timestamp,v_end::timestamp,interval '1 month') g(m))));
end $previous$,$updated$      'total',erp_home.money((select sum(o.total) from o where o.channel=c.channel and date_trunc('month',o.day::timestamp)=g.m))) order by c.n),'[]'::jsonb) from c)) order by g.m)
     from generate_series(v_start::timestamp,v_end::timestamp,interval '1 month') g(m)))))||erp_document_mirror.report_coverage(p_user_id,null,null,null);
end $updated$);
 execute definition;
end$migration$;

-- public.erp_home_business_forecast
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_home_business_forecast(uuid,date,date,uuid,boolean)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$ v_s:=erp_home.biz_finished();v_days:=p_to-p_from+1;
 return erp_home.biz_envelope('previsao-estoque',v_role,jsonb_build_object('statuses',to_jsonb(v_s),'from',to_char(p_from,'YYYY-MM-DD'),'to',to_char(p_to,'YYYY-MM-DD'),'warehouse_id',p_warehouse_id,'reserve',p_reserve))
  ||(with o as materialized(select * from erp_home.biz_orders(p_from,p_to,v_s) where p_warehouse_id is null or warehouse_id=p_warehouse_id),
$previous$,$updated$ v_s:=erp_home.biz_finished();v_days:=p_to-p_from+1;
 return (erp_home.biz_envelope('previsao-estoque',v_role,jsonb_build_object('statuses',to_jsonb(v_s),'from',to_char(p_from,'YYYY-MM-DD'),'to',to_char(p_to,'YYYY-MM-DD'),'warehouse_id',p_warehouse_id,'reserve',p_reserve))
  ||(with o as materialized(select * from erp_home.biz_orders(p_from,p_to,v_s) where p_warehouse_id is null or warehouse_id=p_warehouse_id),
$updated$);
 definition:=replace(definition,$previous$    'by_day',(select coalesce(jsonb_agg(jsonb_build_object('day',to_char(g.d,'YYYY-MM-DD'),'units',erp_home.qty((select sum(units) from o where o.day=g.d::date)),
       'total',erp_home.money((select sum(total) from o where o.day=g.d::date))) order by g.d),'[]'::jsonb) from generate_series(p_from::timestamp,least(p_to,p_from+365)::timestamp,interval '1 day') g(d))));
end $previous$,$updated$    'by_day',(select coalesce(jsonb_agg(jsonb_build_object('day',to_char(g.d,'YYYY-MM-DD'),'units',erp_home.qty((select sum(units) from o where o.day=g.d::date)),
       'total',erp_home.money((select sum(total) from o where o.day=g.d::date))) order by g.d),'[]'::jsonb) from generate_series(p_from::timestamp,least(p_to,p_from+365)::timestamp,interval '1 day') g(d)))))||erp_document_mirror.report_coverage(p_user_id,null,null,null);
end $updated$);
 execute definition;
end$migration$;

-- public.erp_home_business_forecast_v2
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_home_business_forecast_v2(uuid,date,date,uuid,boolean,text)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$ v_s:=erp_home.biz_finished();v_days:=p_to-p_from+1;
 return erp_home.biz_envelope('previsao-estoque',v_role,jsonb_build_object('statuses',to_jsonb(v_s),'from',to_char(p_from,'YYYY-MM-DD'),'to',to_char(p_to,'YYYY-MM-DD'),'warehouse_id',p_warehouse_id,'reserve',p_reserve,'mode',p_mode))
  ||(with o as materialized(select * from erp_home.biz_orders(p_from,p_to,v_s) where p_warehouse_id is null or warehouse_id=p_warehouse_id),
$previous$,$updated$ v_s:=erp_home.biz_finished();v_days:=p_to-p_from+1;
 return (erp_home.biz_envelope('previsao-estoque',v_role,jsonb_build_object('statuses',to_jsonb(v_s),'from',to_char(p_from,'YYYY-MM-DD'),'to',to_char(p_to,'YYYY-MM-DD'),'warehouse_id',p_warehouse_id,'reserve',p_reserve,'mode',p_mode))
  ||(with o as materialized(select * from erp_home.biz_orders(p_from,p_to,v_s) where p_warehouse_id is null or warehouse_id=p_warehouse_id),
$updated$);
 definition:=replace(definition,$previous$    'by_day',(select coalesce(jsonb_agg(jsonb_build_object('day',to_char(g.d,'YYYY-MM-DD'),'units',erp_home.qty((select sum(units) from o where o.day=g.d::date)),
       'total',erp_home.money((select sum(total) from o where o.day=g.d::date))) order by g.d),'[]'::jsonb) from generate_series(p_from::timestamp,least(p_to,p_from+365)::timestamp,interval '1 day') g(d))));
end $previous$,$updated$    'by_day',(select coalesce(jsonb_agg(jsonb_build_object('day',to_char(g.d,'YYYY-MM-DD'),'units',erp_home.qty((select sum(units) from o where o.day=g.d::date)),
       'total',erp_home.money((select sum(total) from o where o.day=g.d::date))) order by g.d),'[]'::jsonb) from generate_series(p_from::timestamp,least(p_to,p_from+365)::timestamp,interval '1 day') g(d)))))||erp_document_mirror.report_coverage(p_user_id,null,null,null);
end $updated$);
 execute definition;
end$migration$;

-- public.erp_home_business_margin
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_home_business_margin(uuid,jsonb,date,date,text)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$ if p_tab is null or p_tab not in('todos','lucro','prejuizo') then raise exception 'erp_home_business_input_invalid' using errcode='22023'; end if;
 return erp_home.biz_envelope('margem-pedido',v_role,jsonb_build_object('statuses',to_jsonb(v_s),'from',to_char(p_from,'YYYY-MM-DD'),'to',to_char(p_to,'YYYY-MM-DD'),'tab',p_tab))
  ||(with o as materialized(select * from erp_home.biz_orders(p_from,p_to,v_s)),
$previous$,$updated$ if p_tab is null or p_tab not in('todos','lucro','prejuizo') then raise exception 'erp_home_business_input_invalid' using errcode='22023'; end if;
 return (erp_home.biz_envelope('margem-pedido',v_role,jsonb_build_object('statuses',to_jsonb(v_s),'from',to_char(p_from,'YYYY-MM-DD'),'to',to_char(p_to,'YYYY-MM-DD'),'tab',p_tab))
  ||(with o as materialized(select * from erp_home.biz_orders(p_from,p_to,v_s)),
$updated$);
 definition:=replace(definition,$previous$       'contribution_pct',case when missing then null else erp_home.pct(contribution,revenue) end) order by day desc,number desc),'[]'::jsonb)
      from(select * from k where p_tab='todos' or p_tab='lucro' and contribution>=0 or p_tab='prejuizo' and contribution<0 order by day desc,number desc limit 500) x),160000)));
end $previous$,$updated$       'contribution_pct',case when missing then null else erp_home.pct(contribution,revenue) end) order by day desc,number desc),'[]'::jsonb)
      from(select * from k where p_tab='todos' or p_tab='lucro' and contribution>=0 or p_tab='prejuizo' and contribution<0 order by day desc,number desc limit 500) x),160000))))||erp_document_mirror.report_coverage(p_user_id,null,null,null);
end $updated$);
 execute definition;
end$migration$;

-- public.erp_home_business_monthly
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_home_business_monthly(uuid,jsonb,date,date,date,date)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$ v_cost:=erp_home.biz_cost_visible(v_role);v_stock:=erp_home.biz_stock_visible(v_role);v_year:=date_trunc('year',p_to::timestamp)::date;v_days:=p_to-p_from+1;
 return erp_home.biz_envelope('mensal',v_role,jsonb_build_object('statuses',to_jsonb(v_s),'from',to_char(p_from,'YYYY-MM-DD'),'to',to_char(p_to,'YYYY-MM-DD'),
   'compare_from',to_char(p_compare_from,'YYYY-MM-DD'),'compare_to',to_char(p_compare_to,'YYYY-MM-DD')))
$previous$,$updated$ v_cost:=erp_home.biz_cost_visible(v_role);v_stock:=erp_home.biz_stock_visible(v_role);v_year:=date_trunc('year',p_to::timestamp)::date;v_days:=p_to-p_from+1;
 return (erp_home.biz_envelope('mensal',v_role,jsonb_build_object('statuses',to_jsonb(v_s),'from',to_char(p_from,'YYYY-MM-DD'),'to',to_char(p_to,'YYYY-MM-DD'),
   'compare_from',to_char(p_compare_from,'YYYY-MM-DD'),'compare_to',to_char(p_compare_to,'YYYY-MM-DD')))
$updated$);
 definition:=replace(definition,$previous$   'annual',erp_home.biz_kpis(v_year,(v_year+interval '1 year'-interval '1 day')::date,v_s),
   'goals',erp_home.goals_json(true,20));
end $previous$,$updated$   'annual',erp_home.biz_kpis(v_year,(v_year+interval '1 year'-interval '1 day')::date,v_s),
   'goals',erp_home.goals_json(true,20)))||erp_document_mirror.report_coverage(p_user_id,null,null,null);
end $updated$);
 execute definition;
end$migration$;

-- public.erp_home_business_orders
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_home_business_orders(uuid,jsonb,date,date,text)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$ v_cost:=erp_home.biz_cost_visible(v_role);
 return erp_home.biz_envelope('pedidos-venda',v_role,jsonb_build_object('statuses',to_jsonb(v_s),'from',to_char(p_from,'YYYY-MM-DD'),'to',to_char(p_to,'YYYY-MM-DD'),'state',p_state))
  ||(with o as materialized(select * from erp_home.biz_orders(p_from,p_to,v_s) where p_state is null or state=p_state),
$previous$,$updated$ v_cost:=erp_home.biz_cost_visible(v_role);
 return (erp_home.biz_envelope('pedidos-venda',v_role,jsonb_build_object('statuses',to_jsonb(v_s),'from',to_char(p_from,'YYYY-MM-DD'),'to',to_char(p_to,'YYYY-MM-DD'),'state',p_state))
  ||(with o as materialized(select * from erp_home.biz_orders(p_from,p_to,v_s) where p_state is null or state=p_state),
$updated$);
 definition:=replace(definition,$previous$        coalesce((select bool_or(l.unit_cost is null) from l where l.channel=o.channel),false) missing from o group by o.channel) c))
   );
end $previous$,$updated$        coalesce((select bool_or(l.unit_cost is null) from l where l.channel=o.channel),false) missing from o group by o.channel) c))
   ))||erp_document_mirror.report_coverage(p_user_id,null,null,null);
end $updated$);
 execute definition;
end$migration$;

-- public.erp_home_business_portfolio
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_home_business_portfolio(uuid,date,date,text,integer,jsonb)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$ v_s:=erp_home.biz_finished();
 return erp_home.biz_envelope('atividade-carteira',v_role,jsonb_build_object('statuses',to_jsonb(v_s),'from',to_char(p_from,'YYYY-MM-DD'),'to',to_char(p_to,'YYYY-MM-DD'),
   'brand',nullif(btrim(coalesce(p_brand,'')),''),'min_days',p_min_days,'keywords',to_jsonb(v_keywords)))
$previous$,$updated$ v_s:=erp_home.biz_finished();
 return (erp_home.biz_envelope('atividade-carteira',v_role,jsonb_build_object('statuses',to_jsonb(v_s),'from',to_char(p_from,'YYYY-MM-DD'),'to',to_char(p_to,'YYYY-MM-DD'),
   'brand',nullif(btrim(coalesce(p_brand,'')),''),'min_days',p_min_days,'keywords',to_jsonb(v_keywords)))
$updated$);
 definition:=replace(definition,$previous$       order by f.total desc,f.name,f.contact_id),'[]'::jsonb)
      from(select * from f order by total desc,name,contact_id limit 500) f left join erp_catalog.contact c on c.record_id=f.contact_id),160000)));
end $previous$,$updated$       order by f.total desc,f.name,f.contact_id),'[]'::jsonb)
      from(select * from f order by total desc,name,contact_id limit 500) f left join erp_catalog.contact c on c.record_id=f.contact_id),160000))))||erp_document_mirror.report_coverage(p_user_id,null,null,null);
end $updated$);
 execute definition;
end$migration$;

-- public.erp_home_business_sellers
do $migration$declare definition text;begin
 select replace(pg_get_functiondef('public.erp_home_business_sellers(uuid,jsonb,date,date,text)'::regprocedure),E'\r','')into definition;
 definition:=replace(definition,$previous$ v_cost:=erp_home.biz_cost_visible(v_role);v_days:=p_to-p_from+1;
 return erp_home.biz_envelope('vendas-vendedor',v_role,jsonb_build_object('statuses',to_jsonb(v_s),'from',to_char(p_from,'YYYY-MM-DD'),'to',to_char(p_to,'YYYY-MM-DD'),'seller',v_seller))
  ||(with o as materialized(select * from erp_home.biz_orders(p_from,p_to,v_s) where v_seller is null or seller=v_seller),
$previous$,$updated$ v_cost:=erp_home.biz_cost_visible(v_role);v_days:=p_to-p_from+1;
 return (erp_home.biz_envelope('vendas-vendedor',v_role,jsonb_build_object('statuses',to_jsonb(v_s),'from',to_char(p_from,'YYYY-MM-DD'),'to',to_char(p_to,'YYYY-MM-DD'),'seller',v_seller))
  ||(with o as materialized(select * from erp_home.biz_orders(p_from,p_to,v_s) where v_seller is null or seller=v_seller),
$updated$);
 definition:=replace(definition,$previous$      from unnest(v_s) with ordinality u(s,n) left join(select status,count(*)::integer orders,sum(total) total from o group by status) x on x.status=u.s))
   );
end $previous$,$updated$      from unnest(v_s) with ordinality u(s,n) left join(select status,count(*)::integer orders,sum(total) total from o group by status) x on x.status=u.s))
   ))||erp_document_mirror.report_coverage(p_user_id,null,null,null);
end $updated$);
 execute definition;
end$migration$;

drop function public.erp_document_list(uuid,text,integer,uuid,text,text,text,text,integer,text,text[],text,uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,boolean,text[],uuid,uuid,uuid,text[],jsonb);
CREATE OR REPLACE FUNCTION public.erp_document_list(p_user_id uuid, p_kind text, p_limit integer DEFAULT 25, p_after uuid DEFAULT NULL::uuid, p_status text DEFAULT NULL::text, p_query text DEFAULT NULL::text, p_date_from text DEFAULT NULL::text, p_date_to text DEFAULT NULL::text, p_page integer DEFAULT NULL::integer, p_order text DEFAULT 'id'::text, p_statuses text[] DEFAULT NULL::text[], p_date_type text DEFAULT 'date'::text, p_warehouse_id uuid DEFAULT NULL::uuid, p_product_id uuid DEFAULT NULL::uuid, p_city text DEFAULT NULL::text, p_state text DEFAULT NULL::text, p_technician text DEFAULT NULL::text, p_equipment text DEFAULT NULL::text, p_serial_number text DEFAULT NULL::text, p_internal_note text DEFAULT NULL::text, p_postal_code text DEFAULT NULL::text, p_district text DEFAULT NULL::text, p_tracking_code text DEFAULT NULL::text, p_customer_po_number text DEFAULT NULL::text, p_carrier text DEFAULT NULL::text, p_contact_email text DEFAULT NULL::text, p_template boolean DEFAULT NULL::boolean, p_situations text[] DEFAULT NULL::text[], p_seller_id uuid DEFAULT NULL::uuid, p_component_id uuid DEFAULT NULL::uuid, p_service_id uuid DEFAULT NULL::uuid, p_lots text[] DEFAULT NULL::text[], p_custom jsonb DEFAULT NULL::jsonb, p_origin text DEFAULT 'all'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare v_role text; v_fiscal boolean; v_stock boolean; v_statuses text[]; v_query text; v_digits text; v_from date; v_to date; v_offset bigint;
 v_cursor erp_documents.document%rowtype; v_cursor_day text; v_items jsonb; v_more boolean; v_last uuid; v_count bigint; v_amount numeric; v_origin_totals jsonb;
 v_city text; v_technician text; v_equipment text; v_serial text; v_note text;
 v_postal text; v_district text; v_tracking text; v_po text; v_carrier text; v_email text;
 v_warranty text:=coalesce(erp_documents.preference('os.garantia_base')#>>'{}','nao_utilizar');
 v_scope uuid:=erp_catalog.contact_scope(p_user_id);
 -- 289: Lote (até 50 lotes separados por ;) and Busca customizada (Adicionar filtros).
 v_lots text[]; v_conditions jsonb;
begin
 perform erp_documents.require_access(p_user_id,p_kind,false);
 select role into v_role from erp_access.membership where user_id=p_user_id and active;
 v_fiscal:=v_role in ('admin','fiscal');
 v_stock:=v_role in ('admin','consulta','estoque','vendas','fiscal');
 v_statuses:=case when p_statuses is not null then p_statuses when p_status is not null then array[p_status] end;
 if p_origin is null or p_origin not in('all','origin','brufap') or p_limit is null or p_limit not between 1 and 100
  or (p_status is not null and p_statuses is not null)
  or (v_statuses is not null and (coalesce(cardinality(v_statuses),0) not between 1 and 20 or array_position(v_statuses,null) is not null
   or exists(select 1 from unnest(v_statuses) s where not ((erp_documents.transitions()->p_kind)?s or s in('deleted','source_unknown')))
   or (select count(distinct s) from unnest(v_statuses) s)<>cardinality(v_statuses)))
  or (p_situations is not null and (v_statuses is not null or not erp_documents.situation_adopted(p_kind) or coalesce(cardinality(p_situations),0) not between 1 and 50
   or array_position(p_situations,null) is not null or exists(select 1 from unnest(p_situations) s where not erp_documents.situation_key_valid(p_kind,s))
   or (select count(distinct s) from unnest(p_situations) s)<>cardinality(p_situations)))
  or length(p_query)>120 or p_query ~ '[[:cntrl:]]'
  or (p_date_from is not null and p_date_from !~ '^(19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}$')
  or (p_date_to is not null and p_date_to !~ '^(19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}$')
  or (p_page is not null and (p_page not between 1 and 100000 or p_after is not null))
  or p_order is null or p_order not in ('date_desc','date_asc','number_desc','number_asc','id')
  or p_date_type is null or p_date_type not in ('date','expected_date','next_contact','ship_date','finish_date','warranty_until')
  or (p_date_type='next_contact' and p_kind<>'sales_proposals')
  or (p_date_type='ship_date' and p_kind not in ('sales_orders','service_orders'))
  or (p_date_type in ('finish_date','warranty_until') and p_kind<>'service_orders')
  or ((p_city is not null or p_state is not null) and p_kind not in ('sales_orders','sales_proposals'))
  or ((p_technician is not null or p_equipment is not null or p_serial_number is not null) and p_kind<>'service_orders')
  or (p_internal_note is not null and p_kind<>'purchase_orders')
  or ((p_postal_code is not null or p_district is not null or p_tracking_code is not null or p_customer_po_number is not null or p_carrier is not null) and p_kind<>'sales_orders')
  or ((p_contact_email is not null or p_template is not null) and p_kind<>'sales_proposals')
  or (p_seller_id is not null and p_kind not in ('sales_orders','sales_proposals','service_orders'))
  or (p_component_id is not null and p_kind<>'sales_orders')
  -- 268: the filters Peça (p_product_id) and Serviço (p_service_id) of the ordens de serviço.
  or (p_service_id is not null and p_kind<>'service_orders')
  -- 289: Lote of the pedidos de venda and of the OS: 1 to 50 codes.
  or (p_lots is not null and (p_kind not in('sales_orders','service_orders') or coalesce(cardinality(p_lots),0) not between 1 and 50 or array_position(p_lots,null) is not null
   or exists(select 1 from unnest(p_lots) x where char_length(btrim(x)) not between 1 and 60 or x~'[[:cntrl:]]')))
  or length(p_city)>100 or length(p_technician)>200 or length(p_equipment)>200 or length(p_serial_number)>100 or length(p_internal_note)>200
  or length(p_district)>100 or length(p_tracking_code)>200 or length(p_customer_po_number)>60 or length(p_carrier)>200 or length(p_contact_email)>254
  or (p_postal_code is not null and p_postal_code!~'^[0-9]{1,8}$')
  or concat(p_city,p_technician,p_equipment,p_serial_number,p_internal_note,p_district,p_tracking_code,p_customer_po_number,p_carrier,p_contact_email) ~ '[[:cntrl:]]'
  or (p_state is not null and p_state !~ '^(AC|AL|AM|AP|BA|CE|DF|ES|EX|GO|MA|MG|MS|MT|PA|PB|PE|PI|PR|RJ|RN|RO|RR|RS|SC|SE|SP|TO)$') then
  raise exception 'erp_document_query_invalid' using errcode='22023';
 end if;
 v_city:=lower(nullif(btrim(p_city),''));v_technician:=lower(nullif(btrim(p_technician),''));v_equipment:=lower(nullif(btrim(p_equipment),''));
 v_serial:=lower(nullif(btrim(p_serial_number),''));v_note:=lower(nullif(btrim(p_internal_note),''));
 v_postal:=p_postal_code;v_district:=lower(nullif(btrim(p_district),''));v_tracking:=lower(nullif(btrim(p_tracking_code),''));
 v_po:=lower(nullif(btrim(p_customer_po_number),''));v_carrier:=lower(nullif(btrim(p_carrier),''));v_email:=lower(nullif(btrim(p_contact_email),''));
 if (p_city is not null and v_city is null) or (p_technician is not null and v_technician is null) or (p_equipment is not null and v_equipment is null)
  or (p_serial_number is not null and v_serial is null) or (p_internal_note is not null and v_note is null)
  or (p_district is not null and v_district is null) or (p_tracking_code is not null and v_tracking is null) or (p_customer_po_number is not null and v_po is null)
  or (p_carrier is not null and v_carrier is null) or (p_contact_email is not null and v_email is null) then
  raise exception 'erp_document_query_invalid' using errcode='22023';
 end if;
 v_lots:=case when p_lots is not null then array(select distinct lower(btrim(x)) from unnest(p_lots) x) end;
 v_conditions:=erp_documents.list_conditions(p_kind,p_custom);
 v_from:=erp_documents.date_value(to_jsonb(p_date_from));
 v_to:=erp_documents.date_value(to_jsonb(p_date_to));
 if v_from>v_to then raise exception 'erp_document_period_invalid' using errcode='22023'; end if;
 v_query:=lower(nullif(btrim(p_query),''));
 v_digits:=case when v_query ~ '^[0-9./ -]+$' then regexp_replace(v_query,'[^0-9]','','g') end;
 if length(v_digits)<5 then v_digits:=null; end if;
 if p_after is not null and p_order<>'id' then
  select * into v_cursor from erp_documents.document where id=p_after and kind=p_kind and erp_document_mirror.visible(p_user_id,id) and(p_origin='all' or origin=p_origin);
  if not found then raise exception 'erp_document_cursor_invalid' using errcode='22023'; end if;
  v_cursor_day:=v_cursor.body->>'date';
 end if;
 v_offset:=case when p_page is null then 0 else (p_page-1)::bigint*p_limit end;
 with filtered as materialized(
  select d.id,d.number,d.origin,d.body->>'date' as day,case when d.origin='origin' then(select (bm.reconciliation->>'source_total')::numeric from erp_documents.origin_mirror bm where bm.document_id=d.id)else d.total end total from erp_documents.document d
  left join erp_documents.document_situation ds on ds.document_id=d.id
  where d.kind=p_kind and(p_origin='all' or d.origin=p_origin) and not exists(select 1 from erp_documents.origin_mirror bm where bm.document_id=d.id and bm.source_deleted)
   -- Leva H (392): "Excluídos" (deleted) lists the lixeira; every other filter leaves the excluded documents out.
   and (case when v_statuses is not null and 'deleted'=any(v_statuses) then d.deleted_at is not null else d.deleted_at is null and (v_statuses is null or d.status=any(v_statuses)) end)
   and (p_situations is null or coalesce(ds.situation_id::text,d.status)=any(p_situations))
   and (p_seller_id is null or d.body->>'seller_id'=p_seller_id::text)
   -- 238: Preferências › Contatos "Contato acessível somente ao vendedor vinculado": the documents of the contacts of the seller.
   and (v_scope is null or exists(select 1 from erp_catalog.contact_profile cp where cp.record_id=d.contact_id and cp.seller_id=v_scope))
   -- 238: Origin "Componente": pedidos with a product whose current structure (Estoque › composições) has the component.
   and (p_component_id is null or exists(select 1 from erp_documents.item i join erp_stock.composition_current c on c.product_id=i.product_id
    where i.document_id=d.id and c.component_id=p_component_id))
   and (v_from is null and v_to is null
    or p_date_type='date' and (v_from is null or d.body->>'date'>=p_date_from) and (v_to is null or d.body->>'date'<=p_date_to)
    or p_date_type='expected_date' and (v_from is null or d.body->>'expected_date'>=p_date_from) and (v_to is null or d.body->>'expected_date'<=p_date_to)
    or p_date_type='next_contact' and (v_from is null or d.body->>'next_contact'>=p_date_from) and (v_to is null or d.body->>'next_contact'<=p_date_to)
    or p_date_type='ship_date' and (v_from is null or d.body->>'ship_date'>=p_date_from) and (v_to is null or d.body->>'ship_date'<=p_date_to)
    or p_date_type='finish_date' and (v_from is null or d.body->>'finish_date'>=p_date_from) and (v_to is null or d.body->>'finish_date'<=p_date_to)
    or p_date_type='warranty_until' and d.body->>'warranty_days' is not null
     and (v_from is null or erp_documents.warranty_until(d.body,v_warranty)>=v_from)
     and (v_to is null or erp_documents.warranty_until(d.body,v_warranty)<=v_to))
   and (p_warehouse_id is null or d.warehouse_id=p_warehouse_id)
   and (p_product_id is null or exists(select 1 from erp_documents.item i where i.document_id=d.id and i.product_id=p_product_id))
   and (p_service_id is null or exists(select 1 from erp_documents.item i where i.document_id=d.id and i.product_id=p_service_id))
   -- 289: Lote: a lot informed in an item (Informar lotes) or posted by the stock of the document (Informar lotes of the line, 278).
   and (v_lots is null or exists(select 1 from erp_documents.item i cross join jsonb_array_elements(case when jsonb_typeof(i.data->'lots')='array' then i.data->'lots' else '[]'::jsonb end) l
     join erp_stock.lot x on x.id::text=l->>'lot_id' where i.document_id=d.id and lower(x.code)=any(v_lots))
    or exists(select 1 from erp_stock.document_posting sp join erp_stock.lot_entry e on e.movement_id=sp.movement_id join erp_stock.lot x on x.id=e.lot_id
     where sp.document_id=d.id and sp.state='active' and lower(x.code)=any(v_lots)))
   -- 289: Busca customizada: every condition of Adicionar filtros.
   and (v_conditions is null or erp_documents.list_conditions_match(d,v_conditions))
   and (v_city is null or strpos(lower(coalesce(d.contact_snapshot->>'city','')),v_city)>0)
   and (p_state is null or upper(coalesce(d.contact_snapshot->>'state',''))=p_state)
   and (v_technician is null or strpos(lower(coalesce(d.body->>'technician','')),v_technician)>0)
   and (v_equipment is null or strpos(lower(coalesce(d.body->>'equipment','')),v_equipment)>0)
   and (v_serial is null or strpos(lower(coalesce(d.body->>'serial_number','')),v_serial)>0)
   and (v_note is null or strpos(lower(coalesce(d.body->>'internal_notes','')),v_note)>0)
   and (v_postal is null or strpos(regexp_replace(coalesce(d.contact_snapshot->>'postal_code',''),'[^0-9]','','g'),v_postal)=1
    or strpos(coalesce(d.body#>>'{delivery_address,postal_code}',''),v_postal)=1)
   and (v_district is null or strpos(lower(coalesce(d.contact_snapshot->>'district','')),v_district)>0
    or strpos(lower(coalesce(d.body#>>'{delivery_address,district}','')),v_district)>0)
   and (v_tracking is null or strpos(lower(coalesce(d.body#>>'{commercial,transport,tracking_code}','')),v_tracking)>0)
   and (v_po is null or strpos(lower(coalesce(d.body->>'customer_po_number','')),v_po)>0)
   and (v_carrier is null or strpos(lower(coalesce(d.body#>>'{commercial,transport,carrier_reference,label}','')),v_carrier)>0
    or exists(select 1 from erp_catalog.record r where r.id::text=d.body->>'carrier_id' and strpos(lower(r.name),v_carrier)>0))
   and (v_email is null or strpos(lower(coalesce(d.contact_snapshot->>'email','')),v_email)>0)
   and (p_template is null or coalesce(d.body->'template'='true'::jsonb,false)=p_template)
   and (v_query is null or strpos(d.number::text,v_query)>0 or d.id::text=v_query
    or exists(select 1 from erp_documents.origin_mirror source where source.document_id=d.id and(
     source.source_id=v_query or source.source_status=v_query
     or strpos(lower(coalesce(source.source_number,'')),v_query)>0
     or strpos(lower(coalesce(source.source_status_label,'')),v_query)>0))
    or strpos(lower(coalesce(d.contact_snapshot->>'name','')),v_query)>0
    or strpos(lower(coalesce(d.contact_snapshot->>'trade_name','')),v_query)>0
    or strpos(lower(coalesce(d.contact_snapshot->>'code','')),v_query)>0
    or strpos(lower(coalesce(d.contact_snapshot->>'email','')),v_query)>0
    or (p_kind='purchase_orders' and strpos(lower(coalesce(d.body->>'order_reference','')),v_query)>0)
    or (v_digits is not null and strpos(regexp_replace(coalesce(d.contact_snapshot->>'document',''),'[^0-9]','','g'),v_digits)>0)
    or (v_digits is not null and p_kind='service_orders' and strpos(regexp_replace(coalesce(d.contact_snapshot->>'postal_code',''),'[^0-9]','','g'),v_digits)>0))
 ), ordered as materialized(
  select f.id,row_number() over(order by
    case when p_order='id' then f.id end,
    case when p_order='date_desc' then f.day end desc,
    case when p_order='date_asc' then f.day end,
    case when p_order in ('date_desc','number_desc') then f.number end desc,
    case when p_order in ('date_asc','number_asc') then f.number end,case when p_order in('date_desc','number_desc')then f.id end desc,f.id) as position
  from filtered f
  where p_after is null
   or (p_order='id' and f.id>p_after)
   or (p_order='date_desc' and (coalesce(f.day,'9999-12-31'),coalesce(f.number,9223372036854775807),f.id)<(coalesce(v_cursor_day,'9999-12-31'),coalesce(v_cursor.number,9223372036854775807),p_after))
   or (p_order='date_asc' and (coalesce(f.day,'9999-12-31'),coalesce(f.number,9223372036854775807),f.id)>(coalesce(v_cursor_day,'9999-12-31'),coalesce(v_cursor.number,9223372036854775807),p_after))
   or (p_order='number_desc' and (coalesce(f.number,9223372036854775807),f.id)<(coalesce(v_cursor.number,9223372036854775807),p_after))
   or (p_order='number_asc' and (coalesce(f.number,9223372036854775807),f.id)>(coalesce(v_cursor.number,9223372036854775807),p_after))
 ), page as materialized(
  select id,position from ordered where position>v_offset and position<=v_offset+p_limit+1
 )
 select coalesce((select jsonb_agg(erp_documents.list_row(id,v_fiscal,v_stock) order by position) from page where position<=v_offset+p_limit),'[]'::jsonb),
  (select count(*) from page)>p_limit,
  (select id from page where position<=v_offset+p_limit order by position desc limit 1),
  (select count(*) from filtered),(select case when count(*)filter(where origin='origin')=0 and count(total)=count(*) then coalesce(sum(total),0) end from filtered),
  (select jsonb_object_agg(o.origin,jsonb_build_object('count',o.n,'known_total_count',o.known,'total',case when o.n=o.known then o.total::text end))from(
    select origins.origin,count(f.id)n,count(f.total)known,coalesce(sum(f.total),0)total
    from(values('brufap'),('origin'))origins(origin)left join filtered f on f.origin=origins.origin group by origins.origin)o)
 into v_items,v_more,v_last,v_count,v_amount,v_origin_totals;
 return jsonb_build_object('kind',p_kind,'items',v_items,'limit',p_limit,'page',p_page,
  'order',p_order,'has_more',v_more,'next_cursor',case when v_more then v_last end,
  'total_count',v_count,'origin',p_origin,'origin_totals',case when erp_documents.list_totals_visible(p_user_id,p_kind)then v_origin_totals end,'total_amount',case when erp_documents.list_totals_visible(p_user_id,p_kind) then v_amount::numeric(20,2)::text end,
  'data_mode','erp_native','operational_effects',false);
end $function$
;
revoke all on function public.erp_document_list(uuid,text,integer,uuid,text,text,text,text,integer,text,text[],text,uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,boolean,text[],uuid,uuid,uuid,text[],jsonb,text) from public,anon,authenticated;
grant execute on function public.erp_document_list(uuid,text,integer,uuid,text,text,text,text,integer,text,text[],text,uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,boolean,text[],uuid,uuid,uuid,text[],jsonb,text) to service_role;

revoke all on all functions in schema erp_document_mirror from public,anon,authenticated,service_role;
grant execute on function erp_document_mirror.writing(),erp_document_mirror.guard_document(),erp_document_mirror.guard_item() to erp_document_mirror_writer;
commit;
