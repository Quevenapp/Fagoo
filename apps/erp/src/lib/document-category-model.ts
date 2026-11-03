// 202610200168: categorias financeiras of the Categoria of pedidos and OS (`/v1/documentos/{tipo}/categorias`).
export type CategoryOption = { id: string; name: string; parent_id: string | null; depth: number };
export type CategoryChoices = { items: CategoryOption[]; default: { id: string; name: string } | null; has_more: boolean };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const name = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '' && [...value].length <= 200;

/** `/v1/documentos/{tipo}/categorias` (202610200168): receita for vendas and OS, despesa for compras, in tree order. */
export function readCategoryChoices(value: unknown): CategoryChoices {
  const page = value as { items?: unknown; default?: unknown; has_more?: unknown } | null;
  if (!page || !Array.isArray(page.items) || page.items.length > 500 || typeof page.has_more !== 'boolean') throw new Error('CATEGORIES_INVALID');
  const fallback = page.default as { id?: unknown; name?: unknown } | null;
  if (fallback !== null && (!fallback || typeof fallback.id !== 'string' || !UUID.test(fallback.id) || !name(fallback.name))) throw new Error('CATEGORIES_INVALID');
  const items = page.items.map(item => {
    const row = item as CategoryOption;
    if (!row || typeof row.id !== 'string' || !UUID.test(row.id) || !name(row.name) || !Number.isInteger(row.depth) || row.depth < 1 || row.depth > 5
      || (row.parent_id !== null && (typeof row.parent_id !== 'string' || !UUID.test(row.parent_id)))) throw new Error('CATEGORIES_INVALID');
    return { id: row.id, name: row.name, parent_id: row.parent_id, depth: row.depth };
  });
  return { items, default: fallback === null ? null : { id: fallback.id as string, name: fallback.name as string }, has_more: page.has_more };
}

