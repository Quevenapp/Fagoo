import {normalizeCompany,companyDocumentLabel,COMPANY_FIELDS,CRT_LABELS,STATE_CODES,type CompanyIdentity,type CompanyDocumentKind} from '../../../../packages/erp-domain/src/company.mjs';
import type {NativeRequestOptions} from './real-access';
export {CRT_LABELS,STATE_CODES,companyDocumentLabel};export type {CompanyIdentity,CompanyDocumentKind};
/** 302: Tipo da Pessoa of the Dados complementares (151); null while it is not known. */
export type CompanyPersonType='juridica'|'fisica';
export interface CompanyController {company:(path:string,options?:NativeRequestOptions)=>Promise<unknown>;}
export interface CompanyAccess {read_identity:boolean;write_identity:boolean;read_fiscal:boolean;write_fiscal:boolean;data_mode:'erp_native';emission_enabled:false;}
export interface CompanyRecord {version:number;data:CompanyIdentity;created_at:string;updated_at:string;}
export interface CompanyFiscal {version:number;identity_version:number;crt:string|null;confirmed:boolean;confirmed_at:string|null;reason:string|null;updated_at:string;}
export interface CompanyEnvelope<T> {section:'identity'|'fiscal';record:T|null;replayed?:boolean;data_mode:'erp_native';emission_enabled:false;}
export const COMPANY_LABELS:Record<keyof CompanyIdentity,string>={legal_name:'Razão social',trade_name:'Nome fantasia',cnpj:'CNPJ',ie:'Inscrição estadual',postal_code:'CEP',street:'Logradouro',number:'Número',complement:'Complemento',district:'Bairro',city:'Município',municipality_code:'Código IBGE do município',state:'UF',phone:'Telefone',email:'E-mail'};
const REQUIRED=['legal_name','cnpj','postal_code','street','number','district','city','municipality_code','state'];
export const IDENTITY_FIELDS=Object.entries(COMPANY_FIELDS).map(([key,max])=>({key:key as keyof CompanyIdentity,label:COMPANY_LABELS[key as keyof CompanyIdentity],max,required:REQUIRED.includes(key)}));
export const identityValues=(record:CompanyRecord|null):Record<keyof CompanyIdentity,string>=>Object.fromEntries(IDENTITY_FIELDS.map(field=>[field.key,record?.data[field.key]??'']))as Record<keyof CompanyIdentity,string>;
/** 302: the document the identity form checks: CPF for Pessoa Física, CNPJ for Pessoa Jurídica; a document equal to the saved one (or an
 * unknown Tipo da Pessoa) is checked by its own form, as the server does. */
export function identityDocumentKind(person:CompanyPersonType|null,value:string,saved:string|null):CompanyDocumentKind{
 return person===null||saved!==null&&value.replace(/[./-]/g,'').trim().toUpperCase()===saved?'any':person==='fisica'?'cpf':'cnpj';
}
export function companyData(values:Record<string,string>,document:CompanyDocumentKind='cnpj'):CompanyIdentity {
 try{return normalizeCompany(values,{document});}catch(error){const field=(error instanceof Error?error.message:'').replace('COMPANY_INVALID_','').toLowerCase();
  throw new Error(field==='cnpj'?document==='cpf'?'Confira o CPF e seus dígitos verificadores (Tipo da Pessoa: Pessoa Física).':'Confira o CNPJ e seus dígitos verificadores. São aceitos CNPJs numéricos e alfanuméricos.':field==='municipality_code'?'Informe sete dígitos do município IBGE, com prefixo correspondente à UF.':`Confira o campo ${COMPANY_LABELS[field as keyof CompanyIdentity]||'informado'} e seus limites.`);
 }
}
export function fiscalInput(record:CompanyFiscal|null,crt:string,confirmed:boolean,reason:string){
 if(!record)throw new Error('Cadastre a identidade da empresa antes de confirmar o regime.');
 if(crt&&!Object.hasOwn(CRT_LABELS,crt))throw new Error('Escolha um regime válido.');
 if(crt&&!confirmed)throw new Error('Confirme explicitamente que o regime foi conferido.');
 if(reason.trim().length<3||reason.length>1000||/[\x00-\x1f\x7f]/.test(reason))throw new Error('Registre o motivo ou a referência da conferência, entre 3 e 1.000 caracteres.');
 return {expected_version:record.version,expected_identity_version:record.identity_version,crt:crt||null,confirmed:Boolean(crt)&&confirmed,reason:reason.trim()};
}
