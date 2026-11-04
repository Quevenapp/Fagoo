import type {ResolvedGroup} from './origin-menu';

export type WorkspaceModule={name:string;icon:string;columns:{title:string;items:{label:string;to:string}[]}[]};
const MODULES=[
 ['Resultados','chart-line'],['Comercial','receipt'],['Compras','cart-shopping'],
 ['Catálogo','box'],['Estoque','warehouse'],['Financeiro','building-columns'],
 ['Fiscal','file-invoice'],['Pessoas','users'],
] as const;
/** The modules each profile uses all day come first; the others keep the standard order. */
const ROLE_FOCUS:Record<string,readonly string[]>={
 vendas:['Comercial','Catálogo','Pessoas','Resultados'],
 financeiro:['Financeiro','Comercial'],
 estoque:['Estoque','Compras','Catálogo'],
 fiscal:['Fiscal','Comercial','Compras'],
};
/** The module a profile works in when no other is selected. */
export function focusModule(role?:string){return role?ROLE_FOCUS[role]?.[0]:undefined;}
/** Recompose only already-authorized destinations. This layer grants no new access. */
export function workspaceMenu(groups:readonly ResolvedGroup[],role?:string):WorkspaceModule[]{
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
 const focus=role?ROLE_FOCUS[role]??[]:[];
 const ordered=[...MODULES].sort((a,b)=>{const x=focus.indexOf(a[0]),y=focus.indexOf(b[0]);return (x<0?focus.length:x)-(y<0?focus.length:y);});
 return ordered.flatMap(([name,icon])=>buckets.get(name)!.length?[{name,icon,columns:[{title:'',items:buckets.get(name)!}]}]:[]);
}
