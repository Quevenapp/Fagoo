export const LIST_PREFERENCES_BASE:'/v1/preferencias-listas';
export const LIST_PREFERENCES_MAX_BYTES:number;
export const LIST_PREFERENCES_BODY_BYTES:number;
export class ListPreferencesContractError extends Error{status:number;code:string;constructor(status:number,code:string);}
export type ListFilterValue=string|boolean|number|string[];
export type ListFilters=Record<string,ListFilterValue>;
export interface ListPreferences{scope:'list_preferences';data_mode:'erp_native';list_id:string;version:number;columns:string[]|null;filters:ListFilters|null;updated_at:string|null}
export interface ListPreferencesSaveInput{command_id:string;expected_version:number;columns:readonly string[]|null;filters:ListFilters|null}
export interface ListPreferencesResult{scope:'list_preferences_command';data_mode:'erp_native';replayed:boolean;preference:ListPreferences;receipt:{command_id:string;list_id:string;from_version:number;to_version:number;changed_at:string}}
export function listPreferenceUuid(value:unknown):value is string;
export function listPreferenceId(value:unknown):value is string;
export function listColumnId(value:unknown):value is string;
export function listPreferenceValid(columns:unknown,filters:unknown):boolean;
export function captureListPreferencesSave(raw:unknown,listId:string):ListPreferencesSaveInput;
export function parseListPreferences(raw:unknown,listId:string):ListPreferences;
export function parseListPreferencesResult(raw:unknown,options:{commandId:string;listId?:string|null;input?:unknown;lookup?:boolean}):ListPreferencesResult;
