import type {AccessState,NativeRequestOptions} from './real-access';
import {SYSTEM_BASE} from '../../../../packages/erp-domain/src/system-profile.mjs';
import {SITUATION_KINDS,SITUATION_KIND_LABELS,TRANSITION_ACTIONS,TRANSITION_ACTION_LABELS,SITUATION_LIMIT,captureSituationsQuery,parseSituationsPage,captureSituationSave,
 captureTransitionSave,captureTransitionsDelete,parseSituationsResult,transitionAllowed,
 type SituationKind,type TransitionAction,type Situation,type Transition,type SituationsPage,type SituationSaveInput,type TransitionSaveInput,type TransitionsDeleteInput} from '../../../../packages/erp-domain/src/system-frameworks.mjs';
export {SITUATION_KINDS,SITUATION_KIND_LABELS,TRANSITION_ACTIONS,TRANSITION_ACTION_LABELS,SITUATION_LIMIT,captureSituationsQuery,parseSituationsPage,captureSituationSave,
 captureTransitionSave,captureTransitionsDelete,parseSituationsResult,transitionAllowed};
export type {SituationKind,TransitionAction,Situation,Transition,SituationsPage,SituationSaveInput,TransitionSaveInput,TransitionsDeleteInput};
export interface FrameworksController{getSnapshot:()=>AccessState;subscribe:(fn:()=>void)=>()=>void;system:(path:string,options?:NativeRequestOptions)=>Promise<unknown>}
export const situationsPath=(kind:SituationKind)=>`${SYSTEM_BASE}/situacoes?tipo=${kind}`;
export const SITUATION_SAVE_PATH=`${SYSTEM_BASE}/situacoes`,TRANSITION_SAVE_PATH=`${SYSTEM_BASE}/transicoes`,TRANSITIONS_DELETE_PATH=`${SYSTEM_BASE}/transicoes/exclusao`;
export const SITUATION_MANAGER='/preferencias/sistema/gerenciador-transicoes';
export const DEFAULT_COLOR='#1e88e5';
/** Destinations a new transition can still use from `from` (allowed by the base rule and not configured yet). */
export function openDestinations(page:SituationsPage,from:string){
 const used=new Set(page.transitions.filter(t=>t.from===from).map(t=>t.to));
 return page.situations.filter(s=>s.key!==from&&!used.has(s.key)&&transitionAllowed(page,from,s.key));
}
/** A transition is effective for the documents only when it is active and both situações are active. */
export const effective=(page:SituationsPage,t:Transition)=>t.active&&page.situations.every(s=>![t.from,t.to].includes(s.key)||s.active);
export const actionsText=(actions:readonly TransitionAction[])=>actions.length?actions.map(a=>TRANSITION_ACTION_LABELS[a]).join(' · '):'Nenhuma ação';
/** Opposite actions exclude each other (Lançar estoque × Estornar estoque, Lançar contas × Estornar contas); kept in SQL order. */
export function toggleAction(actions:readonly TransitionAction[],action:TransitionAction,on:boolean):TransitionAction[]{
 const opposite:Record<TransitionAction,TransitionAction>={post_stock:'reverse_stock',reverse_stock:'post_stock',post_finance:'reverse_finance',reverse_finance:'post_finance'};
 const next=new Set(actions.filter(a=>a!==action&&!(on&&a===opposite[action])));if(on)next.add(action);return [...next].sort() as TransitionAction[];
}
/** Messages of a refused command (the SQL code reaches the browser as the HTTP status). */
export function commandFailure(status:number|null,subject:string){
 if(status===409)return{definitive:true,reload:true,message:`${subject} foi alterado por outra pessoa ou o nome já existe. A tela foi recarregada; confira e tente de novo.`};
 if(status===400)return{definitive:true,reload:false,message:`${subject}: os dados não foram aceitos. Confira o nome, a cor e o destino, e tente de novo.`};
 if(status===403)return{definitive:true,reload:false,message:'Somente administradores alteram estas configurações.'};
 if(status===404)return{definitive:true,reload:true,message:`${subject} não existe mais. A tela foi recarregada.`};
 return{definitive:false,reload:false,message:'Não foi possível confirmar se a alteração foi salva. Use Conferir resultado para reenviar o mesmo comando.'};
}
