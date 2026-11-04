export interface IntegrationAccess { capabilities?: { originIntegration?: boolean; originHistory?: boolean; originConnection?: boolean } }

// The server must explicitly enable an optional connector. Older responses and
// fresh installations remain native-only; historical records stay available.
export const originIntegrationEnabled = (access: IntegrationAccess | null | undefined) => access?.capabilities?.originIntegration === true;
export const originConnectionAvailable = (access: IntegrationAccess | null | undefined) => access?.capabilities?.originConnection === true || originIntegrationEnabled(access);

export const originHistoryAvailable = (access: IntegrationAccess | null | undefined) => access?.capabilities?.originHistory === true || originIntegrationEnabled(access);

const ORIGIN_ROUTES = new Set(['/dados-origin', '/integracao-origin', '/historico-vendas-origin', '/conferir-vendas-origin', '/conferir-compras-origin', '/preparacao-virada', '/ajuda/convivencia']);
export const isOriginIntegrationRoute = (path: string) => ORIGIN_ROUTES.has(path.split('?')[0]) || path.startsWith('/preparacao-virada/');
