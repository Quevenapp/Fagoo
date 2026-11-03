/** Every Preferências page Brufap renders, in Origin order. One schema file per page under ./pages. */
import empresaGeral from'./pages/empresa-geral.mjs';
import sistemaInterface from'./pages/sistema-interface.mjs';
import cadastrosContatos from'./pages/cadastros-contatos.mjs';
import cadastrosLotes from'./pages/cadastros-lotes.mjs';
import cadastrosProdutos from'./pages/cadastros-produtos.mjs';
import suprimentosEstoque from'./pages/suprimentos-estoque.mjs';
import suprimentosCompras from'./pages/suprimentos-compras.mjs';
import vendasFrenteCaixa from'./pages/vendas-frente-caixa.mjs';
import vendasPropostas from'./pages/vendas-propostas.mjs';
import vendasVendas from'./pages/vendas-vendas.mjs';
import notasNfce from'./pages/notas-nfce.mjs';
import notasNfe from'./pages/notas-nfe.mjs';
import certificadoDigital from'./pages/certificado-digital.mjs';
import financasPagar from'./pages/financas-pagar.mjs';
import financasReceber from'./pages/financas-receber.mjs';
import servicosOs from'./pages/servicos-os.mjs';
import contabilidadeContador from'./pages/contabilidade-contador.mjs';
import meuNegocio from'./pages/meu-negocio.mjs';
import centralNotificacoes from'./pages/central-notificacoes.mjs';
import empresaArmazenamento from'./pages/empresa-armazenamento.mjs';
import{storedFields}from'./core.mjs';

export const PREFERENCE_PAGES=Object.freeze([empresaGeral,sistemaInterface,cadastrosContatos,cadastrosLotes,cadastrosProdutos,suprimentosEstoque,suprimentosCompras,
 vendasFrenteCaixa,vendasPropostas,vendasVendas,notasNfce,notasNfe,certificadoDigital,financasPagar,financasReceber,servicosOs,contabilidadeContador,
 // Pages of later migrations come last (their `since`), so the page ordinals of migration 115 never move.
 meuNegocio,centralNotificacoes,empresaArmazenamento]);
/** Pages with at least one stored field; they exist in erp_preferences.page and behind GET/POST /v1/preferencias/:page. */
export const STORED_PREFERENCE_PAGES=Object.freeze(PREFERENCE_PAGES.filter(p=>storedFields(p).length>0));
const byId=new Map(PREFERENCE_PAGES.map(p=>[p.id,p]));
const byRoute=new Map(PREFERENCE_PAGES.map(p=>[`${p.category}/${p.path}`,p]));
if(byId.size!==PREFERENCE_PAGES.length||byRoute.size!==PREFERENCE_PAGES.length)throw new Error('PREFERENCE_PAGE_DUPLICATE');
{const keys=PREFERENCE_PAGES.flatMap(p=>storedFields(p).map(f=>f.key));if(new Set(keys).size!==keys.length)throw new Error('PREFERENCE_KEY_DUPLICATE');}
export const preferencePage=id=>byId.get(id)??null;
export const storedPreferencePage=id=>{const page=byId.get(id);return page&&storedFields(page).length?page:null;};
export const preferencePageByRoute=(category,path)=>byRoute.get(`${category}/${path}`)??null;
/** Browser route of a page: /preferencias/<categoria>/<pagina>[/<subseção>]. */
export const preferencePageHref=(page,section)=>`/preferencias/${page.category}/${page.path}${section&&page.subsections?`/${section}`:''}`;
