import type {ResolvedGroup} from './origin-menu';

/** Quick actions and keyboard shortcuts of the workspace. They only point to destinations the menu already
 * resolved for the current access; this layer grants nothing new and every screen keeps its own checks. */
export type WorkspaceAction={id:string;label:string;description:string;to:string;icon:string;keys:readonly string[];create:boolean};
export type GoToShortcut={key:string;label:string;to:string};

const SALES_WRITERS=['admin','vendas'];
const ORDERS='/documentos-empresa?tipo=sales_orders',PROPOSALS='/documentos-empresa?tipo=sales_proposals';

export function menuDestinations(groups:readonly ResolvedGroup[]):Set<string>{
 return new Set(groups.flatMap(group=>[...group.columns.flatMap(column=>column.items),...(group.footer?[group.footer]:[])]).flatMap(item=>item.to?[item.to]:[]));
}

export function workspaceActions(groups:readonly ResolvedGroup[],role?:string):WorkspaceAction[]{
 const destinations=menuDestinations(groups),writer=Boolean(role&&SALES_WRITERS.includes(role)),actions:WorkspaceAction[]=[];
 if(writer&&destinations.has(ORDERS))actions.push({id:'new-sales-order',label:'Novo pedido de venda',description:'Cliente, itens, pagamento e entrega em sequência',to:`${ORDERS}&acao=incluir`,icon:'plus',keys:['N'],create:true});
 if(writer&&destinations.has(PROPOSALS))actions.push({id:'new-proposal',label:'Nova proposta comercial',description:'Orçamento para enviar ao cliente',to:`${PROPOSALS}&acao=incluir`,icon:'file-lines',keys:['O'],create:true});
 if(destinations.has('/frente-caixa-empresa'))actions.push({id:'pdv',label:'Abrir frente de caixa',description:'Venda rápida no balcão',to:'/frente-caixa-empresa',icon:'cash-register',keys:['G','F'],create:false});
 if(destinations.has('/cadastros-reais?cadastro=contacts'))actions.push({id:'customers',label:'Consultar clientes',description:'Cadastro, histórico e contato',to:'/cadastros-reais?cadastro=contacts',icon:'users',keys:['G','C'],create:false});
 if(destinations.has('/cadastros-reais?cadastro=products'))actions.push({id:'products',label:'Consultar produtos e preços',description:'Catálogo, preços e disponibilidade',to:'/cadastros-reais?cadastro=products',icon:'box',keys:['G','A'],create:false});
 if(destinations.has('/estoque-empresa'))actions.push({id:'stock',label:'Consultar estoque',description:'Saldos e lançamentos por depósito',to:'/estoque-empresa',icon:'warehouse',keys:['G','E'],create:false});
 return actions;
}

const GO_TO:readonly GoToShortcut[]=[
 {key:'i',label:'Visão geral',to:'/acesso'},
 {key:'p',label:'Pedidos de venda',to:ORDERS},
 {key:'o',label:'Propostas comerciais',to:PROPOSALS},
 {key:'c',label:'Clientes e fornecedores',to:'/cadastros-reais?cadastro=contacts'},
 {key:'a',label:'Catálogo de produtos',to:'/cadastros-reais?cadastro=products'},
 {key:'e',label:'Estoque',to:'/estoque-empresa'},
 {key:'f',label:'Frente de caixa',to:'/frente-caixa-empresa'},
 {key:'r',label:'Relatórios de vendas',to:`${ORDERS}&acao=relatorios`},
];

/** "G" followed by a letter, limited to the destinations of this access (Visão geral is always available). */
export function goToShortcuts(groups:readonly ResolvedGroup[],homeTo='/acesso'):GoToShortcut[]{
 const destinations=menuDestinations(groups);
 return GO_TO.filter(item=>item.to===homeTo||destinations.has(item.to)).map(item=>item.key==='i'?{...item,to:homeTo}:item);
}

/** Single-key shortcuts never fire while the person types, edits rich text or answers a dialog. */
export function typingTarget(target:unknown):boolean{
 const element=target as {tagName?:string;isContentEditable?:boolean;type?:string}|null;
 if(!element||typeof element!=='object')return false;
 if(element.isContentEditable)return true;
 const tag=String(element.tagName||'').toUpperCase();
 if(tag==='TEXTAREA'||tag==='SELECT')return true;
 if(tag!=='INPUT')return false;
 return !['checkbox','radio','button','submit','reset','range','color','file'].includes(String(element.type||'text').toLowerCase());
}

export type ShortcutIntent={kind:'palette'}|{kind:'help'}|{kind:'go-pending'}|{kind:'navigate';to:string};
type KeyInput={key:string;code?:string;ctrlKey?:boolean;metaKey?:boolean;altKey?:boolean;shiftKey?:boolean;target?:unknown};

/** Pure resolution of a key press. `pendingGo` is true right after a "G". */
export function shortcutIntent(event:KeyInput,{pendingGo,actions,goTo}:{pendingGo:boolean;actions:readonly WorkspaceAction[];goTo:readonly GoToShortcut[]}):ShortcutIntent|null{
 const key=event.key.length===1?event.key.toLowerCase():event.key;
 if((event.ctrlKey||event.metaKey)&&!event.altKey&&!event.shiftKey&&(key==='k'||event.code==='KeyK'))return {kind:'palette'};
 if(event.ctrlKey||event.metaKey||event.altKey||typingTarget(event.target))return null;
 if(pendingGo){const target=goTo.find(item=>item.key===key);return target?{kind:'navigate',to:target.to}:null;}
 if(event.key==='/')return {kind:'palette'};
 if(event.key==='?')return {kind:'help'};
 if(event.shiftKey)return null;
 if(key==='g')return {kind:'go-pending'};
 const action=actions.find(item=>item.keys.length===1&&item.keys[0]!.toLowerCase()===key);
 return action?{kind:'navigate',to:action.to}:null;
}

/** Accent- and case-insensitive matching used by the command search. */
export function normalizeSearch(value:string){return value.normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().trim();}
export function matchesSearch(label:string,query:string){
 const words=normalizeSearch(query).split(/\s+/).filter(Boolean),text=normalizeSearch(label);
 return words.length>0&&words.every(word=>text.includes(word));
}
