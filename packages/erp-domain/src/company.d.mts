export interface CompanyIdentity {legal_name:string;trade_name:string|null;cnpj:string;ie:string|null;postal_code:string;street:string;number:string;complement:string|null;district:string;city:string;municipality_code:string;state:string;phone:string|null;email:string|null;}
export const STATE_CODES:Record<string,string>;
export const COMPANY_FIELDS:Record<keyof CompanyIdentity,number>;
export const CRT_LABELS:Record<string,string>;
export function normalizeCnpj(input:unknown):string;
/** 302: 'cnpj' (Pessoa Jurídica, default), 'cpf' (Pessoa Física) or 'any' (a stored identity of either kind). */
export type CompanyDocumentKind='cnpj'|'cpf'|'any';
export function normalizeCompanyCpf(input:unknown):string;
export function normalizeCompanyDocument(input:unknown,document?:CompanyDocumentKind):string;
export function companyDocumentLabel(value:unknown):'CPF'|'CNPJ';
export function normalizeCompany(input:unknown,options?:{document?:CompanyDocumentKind}):CompanyIdentity;
