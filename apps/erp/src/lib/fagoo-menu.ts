import type {ResolvedGroup} from './origin-menu';

export type WorkspaceModule={name:string;icon:string;columns:{title:string;items:{label:string;to:string}[]}[]};
const MODULES=[
 ['Resultados','chart-line'],['Comercial','receipt'],['Compras','cart-shopping'],
 ['Catálogo','box'],['Estoque','warehouse'],['Financeiro','building-columns'],
 ['Fiscal','file-invoice'],['Pessoas','users'],
] as const;
/** Recompose only already-authorized destinations. This layer grants no new access. */
export function workspaceMenu(groups:readonly ResolvedGroup[]):WorkspaceModule[]{
 const buckets=new Map<string,{label:string;to:string}[]>(MODULES.map(([name])=>[name,[]]));
 for(const group of groups){
  const entries=[...group.columns.flatMap(column=>column.items),...(group.footer?[group.footer]:[])];
  for(const entry of entries){
   if(!entry.to)continue;
   const route=new URL(entry.to,'https://fagoo.invalid'),p=route.pathname,q=route.searchParams;
   let target:string;
   if(/fiscal|nfce|notas-/.test(p))target='Fiscal';
   else if(q.get('tipo')==='purchase_orders'||/compras|recebimentos/.test(p)||q.get('painel')==='sugestao')target='Compras';
   else if(p==='/cadastros-reais')target=q.get('cadastro')==='products'?'Catálogo':q.get('cadastro')==='warehouses'?'Estoque':'Pessoas';
   else if(/contatos|vendedores|funcionarios|funcionários/.test(p)||entry.label==='Fornecedores')target='Pessoas';
   else if(/produtos|listas-precos/.test(p)&&group.name==='Cadastros')target='Catálogo';
   else if(/estoque|depositos/.test(p))target='Estoque';
   else if(/financeir|pagamento|cobranca|caixas-bancos|remessas|comissoes|controle-caixa|faturamento/.test(p))target='Financeiro';
   else target=group.name==='Meu Negócio'?'Resultados':group.name==='Cadastros'?'Catálogo':group.name==='Estoque'?'Compras':group.name==='Financeiro'?'Financeiro':'Comercial';
   const items=buckets.get(target)!;
   if(!items.some(item=>item.to===entry.to))items.push({label:entry.label,to:entry.to});
  }
 }
 return MODULES.flatMap(([name,icon])=>buckets.get(name)!.length?[{name,icon,columns:[{title:'',items:buckets.get(name)!}]}]:[]);
}
