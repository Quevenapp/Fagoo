import type{PreferencePageSchema,PreferenceRole,PreferenceScope,PreferenceValue}from'./core.mjs';
export const PREFERENCES_BASE:'/v1/preferencias';
export const PREFERENCES_MAX_BYTES:number;
export const PREFERENCES_BODY_BYTES:number;
export const PREFERENCES_DIRECTORY_LIMIT:number;
export class PreferencesContractError extends Error{status:number;code:string;constructor(status:number,code:string);}
export interface PreferenceChange{key:string;expected_version:number;value:PreferenceValue}
export interface PreferencesSaveInput{command_id:string;changes:readonly PreferenceChange[]}
export interface PreferenceItem{key:string;value:PreferenceValue;version:number;updated_at:string|null}
export interface PreferenceDirectoryEntry{user_id:string;role:PreferenceRole;label:string|null}
/** 299: a custom situação of the Gerenciador de transições offered by a page (Suprimentos › Estoque). */
export interface PreferenceSituation{id:string;kind:'sales_orders'|'purchase_orders'|'service_orders';name:string;base_status:string;base_label:string;color:string;active:boolean}
export interface PreferencesPageView{scope:'preferences_page';data_mode:'erp_native';page:string;owner:PreferenceScope;role:PreferenceRole;can_manage:boolean;items:PreferenceItem[];directory:PreferenceDirectoryEntry[]|null;situations?:PreferenceSituation[]}
export interface PreferenceReceiptChange{key:string;from_version:number;to_version:number;before:PreferenceValue;after:PreferenceValue}
export interface PreferencesResult{scope:'preferences_command';data_mode:'erp_native';replayed:boolean;page:PreferencesPageView;receipt:{command_id:string;page:string;changed_at:string;changes:PreferenceReceiptChange[]}}
export function pageHasDirectory(page:PreferencePageSchema):boolean;
export function pageSituationKinds(page:PreferencePageSchema):string[];
export function capturePreferencesSave(raw:unknown,pageId:string):PreferencesSaveInput;
export function parsePreferencesPage(raw:unknown,pageId:string):PreferencesPageView;
export function parsePreferencesResult(raw:unknown,options:{commandId:string;pageId?:string|null;input?:unknown;lookup?:boolean}):PreferencesResult;
