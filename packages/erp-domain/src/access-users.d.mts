export type AccessRole='admin'|'consulta'|'vendas'|'financeiro'|'estoque'|'fiscal'|'operacao';
export type UserStatus='ativo'|'inativo'|'sem_acesso';
export type UserFilter='todos'|UserStatus;
export type UserTypeFilter='todos'|'normal'|'contador';
export const USER_TYPE_FILTERS:readonly UserTypeFilter[];
export const USERS_BASE:'/v1/usuarios';
export const USERS_MAX_BYTES:number;
export const USERS_BODY_BYTES:number;
export const ACCESS_ROLES:readonly AccessRole[];
export const USER_STATUSES:readonly UserStatus[];
export const USER_FILTERS:readonly UserFilter[];
export class AccessUsersContractError extends Error{status:number;code:string;constructor(status:number,code:string);}
export interface AccessUser{user_id:string;email:string|null;name:string|null;phone:string|null;profile_version:number;role:AccessRole|null;active:boolean;status:UserStatus;invited:boolean;confirmed:boolean;last_sign_in_at:string|null;created_at:string}
export interface UsersQuery{q:string|null;status:UserFilter;type:UserTypeFilter;limit:number;offset:number}
export interface UsersPage{scope:'access_users';data_mode:'erp_native';status:UserFilter;type:UserTypeFilter;query:string|null;limit:number;offset:number;total:number;has_more:boolean;items:(AccessUser&{user_type:'normal'|'contador';mfa?:boolean})[];counts:Record<UserStatus,number>;actor:string}
export interface UserSaveInput{command_id:string;expected:{role:AccessRole|null;active:boolean;profile_version:number};data:{name:string;phone:string|null;role:AccessRole;active:boolean}}
export interface UserInviteInput{command_id:string;email:string;name:string;role:AccessRole}
export interface UserState{name:string|null;phone:string|null;role:AccessRole|null;active:boolean}
export interface UserResult{scope:'access_user_command';data_mode:'erp_native';replayed:boolean;user:AccessUser;receipt:{command_id:string;kind:'save'|'invite';target:string;changed_at:string;before:UserState;after:UserState}}
export interface InvitePending{scope:'access_invite';data_mode:'erp_native';state:'pending';command_id:string;email:string;existing_user_id:string|null}
export function accessUuid(value:unknown):value is string;
export function userName(value:unknown):value is string;
export function userPhone(value:unknown):boolean;
export function userEmail(value:unknown):value is string;
export function captureUsersQuery(query?:Partial<UsersQuery>):UsersQuery;
export function captureUserSave(raw:unknown):UserSaveInput;
export function captureUserInvite(raw:unknown):UserInviteInput;
export function parseUsersList(raw:unknown,query:UsersQuery):UsersPage;
export function parseUser(raw:unknown,target:string):{scope:'access_user';data_mode:'erp_native';user:AccessUser;actor:string};
export function parseUserResult(raw:unknown,options:{commandId:string;target?:string|null;input?:unknown;invite?:unknown;lookup?:boolean}):UserResult;
export function parseInvitePending(raw:unknown,options:{commandId:string;email?:string|null}):InvitePending;
export function parseAuthInvite(raw:unknown,email:string):{id:string};
