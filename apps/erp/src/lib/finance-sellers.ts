// Vendedor das contas a receber (SQL 210): opções do cadastro de vendedores (Cadastros > Vendedores, 126), só leitura.
export type SellerOption = { id: string; name: string; code?: string | null };
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

/** GET /v1/cadastros/vendedores/opcoes: up to 25 active sellers by name (or code). */
export function sellerOptionsPath(query: string): string {
  const text = query.trim().slice(0, 120), params = new URLSearchParams();
  if (text) params.set('q', text);
  const search = params.toString();
  return `/v1/cadastros/vendedores/opcoes${search ? `?${search}` : ''}`;
}
/** The answer of the options route, bound to its contract; anything else reads as no option. */
export function sellerOptions(value: unknown): SellerOption[] {
  const page = value as { scope?: unknown; items?: unknown } | null;
  if (!page || page.scope !== 'seller_options' || !Array.isArray(page.items) || page.items.length > 25) throw new Error('Não foi possível carregar os vendedores.');
  return (page.items as Record<string, unknown>[]).map(item => {
    if (!item || typeof item.id !== 'string' || !UUID.test(item.id) || typeof item.name !== 'string' || !item.name.trim() || (item.code !== null && item.code !== undefined && typeof item.code !== 'string'))
      throw new Error('Não foi possível carregar os vendedores.');
    return { id: item.id.toLowerCase(), name: item.name, code: (item.code as string | null | undefined) ?? null };
  });
}
