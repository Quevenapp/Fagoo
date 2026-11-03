// Origin "Pesquisa avançada" of the product (Frente de caixa, Alt+A): the active products of Cadastros › Produtos, 10 at a time, over
// the same cursor list the product field reads (código, descrição ou GTIN, Tipo, Formato and Marca).
export type ProductSearchFilters = { q: string; kind: '' | 'P' | 'S'; format: '' | 'S' | 'V' | 'E'; brand: string };
export const EMPTY_PRODUCT_SEARCH: ProductSearchFilters = { q: '', kind: '', format: '', brand: '' };
export const PRODUCT_SEARCH_SIZE = 10;
const CONTROL = /[\x00-\x1f\x7f]/;
/** GET path of one page; throws the user-facing message for an invalid text. */
export function productSearchPath(filters: ProductSearchFilters, after: string | null): string {
  if (filters.q.length > 120 || CONTROL.test(filters.q) || filters.brand.length > 100 || CONTROL.test(filters.brand)) throw new Error('Confira a pesquisa: até 120 caracteres, sem quebras de linha.');
  const params = new URLSearchParams({ limit: String(PRODUCT_SEARCH_SIZE), active: 'true' });
  if (filters.q.trim()) params.set('q', filters.q.trim());
  if (filters.kind) params.set('kind', filters.kind);
  if (filters.format) params.set('format', filters.format);
  if (filters.brand.trim()) params.set('brand', filters.brand.trim());
  if (after) params.set('after', after);
  return `/v1/cadastros/products?${params}`;
}
