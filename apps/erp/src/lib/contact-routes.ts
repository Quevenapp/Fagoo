// Rotas das telas auxiliares de Cadastros da lane contatos (ContactModules.tsx, carregado sob demanda).
export const CONTACT_MODULE_PATHS = ['/tipos-contatos-empresa', '/vendedores-empresa', '/formas-pagamento-empresa', '/funcionarios-empresa', '/importar-contatos', '/numeracao-contatos'] as const;
export const contactModuleRoute = (pathname: string) => (CONTACT_MODULE_PATHS as readonly string[]).includes(pathname);
