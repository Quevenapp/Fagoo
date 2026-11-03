export const mirrorProduct = '61000000-0000-4000-8000-000000000001';
export const otherMirrorProduct = '61000000-0000-4000-8000-000000000002';
export const mirrorActor = '61000000-0000-4000-8000-000000000003';
export function mirrorPosition(id = 1, patch = {}) {
  return { id, product_source_id: `90000000000000${id}`, product_id: mirrorProduct, product_name: `Produto sintético ${id}`, product_code: `SKU-${id}`, unit: 'UN',
    warehouse_source_id: '123', warehouse_id: null, warehouse_name: 'Depósito observado', physical: '-2.125000', virtual: '-3.125000', reserved: '1.000000',
    physical_state: 'value', virtual_state: 'value', issues: ['WAREHOUSE_UNLINKED'], source_version: 2, source_hash: 'a'.repeat(64), source_deleted: false,
    observed_at: '2026-10-22T14:20:30+00:00', origin: 'origin', read_only: true, ...patch };
}
export function mirrorPage(patch = {}) {
  return { scope: 'stock_mirror', data_mode: 'origin_mirror', items: [mirrorPosition()], limit: 50, next_after: null, has_more: false,
    coverage: { positions: 1, products: 1, raw_products: 2, pending_products: 1, partial: true },
    warehouses: [{ source_id: '123', id: null, name: 'Depósito observado' }], native: { positions: 0, movements: 0 }, ...patch };
}
