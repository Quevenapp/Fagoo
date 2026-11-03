export type SituationKind='sales_orders'|'purchase_orders'|'service_orders';
export type TransitionAction='reverse_stock'|'reverse_finance'|'post_stock'|'post_finance';
export const SITUATION_KINDS:readonly SituationKind[];
export const SITUATION_KIND_LABELS:Readonly<Record<SituationKind,string>>;
export const TRANSITION_ACTIONS:readonly TransitionAction[];
export const TRANSITION_ACTION_LABELS:Readonly<Record<TransitionAction,string>>;
export const SITUATION_LIMIT:number;
export const FRAMEWORK_BODY_BYTES:number;
export class FrameworkContractError extends Error{status:number;code:string;constructor(status:number,code:string);}
export function frameworkUuid(value:unknown):value is string;
export interface SituationsQuery{kind:SituationKind}
export interface Situation{key:string;base_status:string;name:string;color:string;default:boolean;active:boolean;version:number}
export interface Transition{from:string;to:string;default:boolean;active:boolean;actions:TransitionAction[];version:number}
export interface SituationsPage{scope:'situations_page';data_mode:'erp_native';kind:SituationKind;adopted:boolean;situations:Situation[];rules:Record<string,string[]>;transitions:Transition[]}
export interface SituationData{base_status:string;name:string;color:string;active:boolean}
export interface SituationSaveInput{command_id:string;kind:SituationKind;id:string|null;expected_version:number;data:SituationData}
export interface TransitionSaveInput{command_id:string;kind:SituationKind;from:string;to:string;expected_version:number;data:{active:boolean;actions:readonly TransitionAction[]}}
export interface TransitionsDeleteInput{command_id:string;kind:SituationKind;items:readonly{from:string;to:string;expected_version:number}[]}
export interface SituationsResult{scope:'situations_command';data_mode:'erp_native';receipt:{command_id:string;action:'situation_create'|'situation_update'|'transition_save'|'transitions_delete';kind:SituationKind;target:string|null;count:number;changed_at:string};replayed:boolean}
export function captureSituationsQuery(raw?:{tipo?:string}):SituationsQuery;
export function transitionAllowed(page:Pick<SituationsPage,'situations'|'rules'>,from:string,to:string):boolean;
export function parseSituationsPage(raw:unknown,query:SituationsQuery):SituationsPage;
export function captureSituationSave(raw:unknown):SituationSaveInput;
export function captureTransitionSave(raw:unknown):TransitionSaveInput;
export function captureTransitionsDelete(raw:unknown):TransitionsDeleteInput;
export function parseSituationsResult(raw:unknown,sent:SituationSaveInput|TransitionSaveInput|TransitionsDeleteInput,action:'situation'|'transition'|'delete'):SituationsResult;
