export type PreferenceRole='admin'|'consulta'|'vendas'|'financeiro'|'estoque'|'fiscal';
export type PreferenceKind='toggle'|'choice'|'multi'|'integer'|'decimal'|'text'|'textarea'|'users'|'keymap'|'documents';
export type PreferenceScope='company'|'user';
export type PreferenceDocument={document:string;name:string};
export type PreferenceValue=boolean|string|number|string[]|Record<string,string>|PreferenceDocument[];
export interface PreferenceKeymapOptions{actions:readonly string[];keys:readonly string[];labels:readonly string[]}
export interface PreferenceField{
 key:string;section:string;label:string;kind:PreferenceKind;status:'stored'|'applied';default:PreferenceValue;migratedDefaults?:readonly PreferenceValue[];
 options?:readonly(readonly[string,string])[]|PreferenceKeymapOptions;min?:number;max?:number;scale?:number;maxLength?:number;maxItems?:number;
 format?:'plain'|'email'|'email_list'|'digits';/** 264: minimum length of a 'digits' field. */minLength?:number;/** 264: migration that changed an applied 'plain' field to its format. */formatSince?:string;widget?:'select'|'radio'|'chips'|'legend';hint?:string;group?:string;note?:string;showIf?:{key:string;equals:PreferenceValue};
 /** Migration that inserts the key when it was added to an applied page (absent: the page's). */since?:string;
 /** 299: a multi field that also offers the custom situações of a document kind; bases maps an option to the base status it covers. */
 situations?:{kind:'sales_orders'|'purchase_orders'|'service_orders';bases:Readonly<Record<string,string>>};
 info?:undefined;
}
export interface PreferenceInfo{id:string;info:true;section:string;label:string;text:string;status:'applied'|'unavailable';group?:string;source?:'stock_negative_policy'|'fiscal_numbering_55'|'fiscal_numbering_65';link?:{label:string;to:string;roles?:readonly PreferenceRole[]}}
export type PreferenceEntry=PreferenceField|PreferenceInfo;
export interface PreferencePageSchema{
 id:string;category:string;path:string;title:string;scope:PreferenceScope;readRoles:readonly PreferenceRole[];subsections:boolean;
 sections:readonly{id:string;title:string}[];fields:readonly PreferenceEntry[];storedKeys:readonly string[];
 /** Migration that inserts the page (absent: 115). */
 since?:string;
}
export const PREFERENCE_ROLES:readonly PreferenceRole[];
export const PREFERENCE_KINDS:readonly PreferenceKind[];
export const PREFERENCE_READERS:Readonly<Record<string,readonly PreferenceRole[]>>;
export const NOT_APPLIED:string;
export function preferenceUuid(value:unknown):value is string;
export function preferenceKey(value:unknown):value is string;
export function preferencePageId(value:unknown):value is string;
export function validCpf(value:unknown):boolean;
export function validCnpj(value:unknown):boolean;
export function validPersonDocument(value:unknown):boolean;
export function preferenceValueValid(field:PreferenceField,value:unknown):boolean;
export const PREFERENCE_SITUATION_KINDS:readonly('sales_orders'|'purchase_orders'|'service_orders')[];
export const PREFERENCE_SITUATION_IDS:number;
export function preferenceSituationIds(field:PreferenceField,value:unknown):string[];
export function preferenceValueEqual(a:unknown,b:unknown):boolean;
export function preferenceClone<T>(value:T):T;
export function storedFields(page:PreferencePageSchema):PreferenceField[];
export function definitionRows(page:PreferencePageSchema,migration?:string):Record<string,unknown>[];
export function fieldAt(field:PreferenceField,migration?:string):PreferenceField;
export function fieldMigration(page:PreferencePageSchema,field:PreferenceField):string;
