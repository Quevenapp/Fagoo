import { lazy } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import NativeModuleBoundary from './components/NativeModuleBoundary';

const RealAccess = lazy(() => import('./components/RealAccess'));
const SystemUpdateProgress = lazy(() => import('./components/SystemUpdateProgress'));

export default function App() {
  const { pathname } = useLocation();
  if(pathname==='/atualizacao')return <SystemUpdateProgress/>;
  if (pathname === '/') return <Navigate to="/acesso" replace />;
  return ['/acesso', '/preferencias', '/dados-origin', '/cadastros-reais', '/historico-fiscal', '/documentos-empresa', '/estoque-empresa', '/financeiro-empresa', '/importar-cadastros', '/importar-orcamentos', '/conferir-compras-origin', '/conferir-vendas-origin', '/historico-vendas-origin', '/cobrancas-legadas-itau', '/cobranca-empresa', '/cobranca-operacional', '/retornos-operacionais', '/notas-recebidas', '/numeracao-fiscal', '/certificado-a1', '/conexao-sefaz', '/empresa-configuracoes','/preparacao-virada/depositos/estoque','/preparacao-virada/depositos','/preparacao-virada','/estoque-abertura','/emissor-fiscal','/relatorio-vencimentos','/xmls-sincronizados','/integracao-origin','/painel-produtos-empresa','/conferencia-estoque-empresa','/checkin-recebimentos','/relatorios-estoque',
    '/notas-entrada','/naturezas-operacao','/inutilizacoes-nfe','/cartas-correcao',
    '/categorias-produtos','/grupos-produtos','/tags','/grupos-tags','/exportacao-produtos','/listas-precos','/campos-customizados',
    '/tipos-contatos-empresa','/vendedores-empresa','/formas-pagamento-empresa','/funcionarios-empresa','/importar-contatos','/numeracao-contatos',
    '/meu-negocio','/frente-caixa-empresa'].includes(pathname) || pathname.startsWith('/preferencias/') || pathname === '/ajuda' || pathname.startsWith('/ajuda/')
    ? <NativeModuleBoundary resetKey="company-access" label="Carregando acesso…"><RealAccess /></NativeModuleBoundary>
    : <Navigate to="/acesso" replace />;
}
