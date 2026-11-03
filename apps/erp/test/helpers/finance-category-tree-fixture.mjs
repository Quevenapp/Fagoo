// Synthetic answers of GET /v1/financeiro/categorias-arvore?kind=… (SQL 135) for the finance UI tests.
export const DEFAULT_KEYS = ['receipt_additions', 'receipt_interest', 'receipt_discounts', 'receipt_fees', 'payment_additions', 'payment_interest', 'payment_discounts', 'sale', 'service', 'transfer_in', 'purchase'];
export const treeNode = (node, kind) => ({ parent_id: null, dre_group: null, active: true, depth: node.parent_id ? 2 : 1, defaults: [], children: 0, in_use: false, version: 1, updated_at: '2026-10-20T10:00:00Z', kind, ...node });
/** Tree of one tab; nodes of the other kind are left out, children counts follow the parents. */
export function categoryTreeResponse(kind, nodes = [], defaults = {}) {
  const items = nodes.filter(node => (node.kind ?? kind) === kind).map(node => treeNode(node, kind));
  for (const item of items) item.children = items.filter(child => child.parent_id === item.id).length;
  return { entity: 'category_tree', kind, items, defaults: Object.fromEntries(DEFAULT_KEYS.map(key => [key, { category_id: null, version: 1, ...(defaults[key] ?? {}) }])), data_mode: 'erp_native' };
}
const textOf = value => Array.isArray(value) ? value.map(textOf).join('') : value && typeof value === 'object' ? textOf(value.props?.children) : value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);
/** Opens the CategoryTreePicker with this id and chooses the category by name (or "Sem categoria"). */
export async function chooseCategory(view, id, name) {
  const picker = view.find(node => node.props.id === id);
  if (picker.disabled) throw new Error(`Disabled category picker: ${id}`);
  if (!picker.props['aria-expanded']) { picker.props.onClick(); await view.flush(); }
  const choice = view.find(node => node.type === 'button' && String(node.props.className ?? '').includes('finance-tree-choice') && textOf(node) === name);
  choice.props.onClick(); await view.flush();
}
