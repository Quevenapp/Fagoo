// Migrations of the notas fiscais lane in published order (111-190 applied in production; 215 and later are new).
export const FISCAL_LANE = ['202610200111_fiscal_operation_natures.sql', '202610200112_fiscal_invoice_core.sql', '202610200113_fiscal_invoice_list.sql', '202610200114_fiscal_invoice_events.sql',
  '202610200115_erp_preferences.sql', '202610200140_fiscal_invoice_preferences.sql', '202610200141_fiscal_item_groups_nature_review.sql', '202610200142_fiscal_invoice_order_links.sql',
  '202610200143_fiscal_invoice_xml_import.sql', '202610200176_fiscal_invoice_order_generation.sql'];
export const laneUpTo = migration => FISCAL_LANE.slice(0, FISCAL_LANE.findIndex(name => name.startsWith(migration)) + 1);
// Wave D of the notas lane (202610200215-221) needs the product registry of 119 and the contact profile and sellers of 124 (published).
export const WAVE_D_BASE = [...laneUpTo('202610200143'), '202610200116_list_preferences.sql', '202610200117_access_users.sql', '202610200118_activity_files.sql',
  '202610200119_product_registry_v2.sql', '202610200124_contact_profile.sql', '202610200127_payment_methods.sql', '202610200176_fiscal_invoice_order_generation.sql'];
export const WAVE_D_LANE = ['202610200215_fiscal_invoice_seller_order_integrity.sql', '202610200216_fiscal_nature_product_groups.sql', '202610200217_fiscal_import_products.sql', '202610200218_fiscal_item_history.sql', '202610200219_fiscal_payment_methods_references.sql', '202610200220_fiscal_returns_balance.sql'];
export const waveDUpTo = migration => [...WAVE_D_BASE, ...WAVE_D_LANE.slice(0, WAVE_D_LANE.findIndex(name => name.startsWith(migration)) + 1)];
