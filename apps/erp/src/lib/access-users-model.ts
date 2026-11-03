import type {AccessState,NativeRequestOptions} from './real-access';
import {parseUsersList,parseUser,parseUserResult,parseInvitePending,captureUsersQuery,userName,userPhone,userEmail,ACCESS_ROLES,
 type AccessUser,type AccessRole,type UsersPage,type UserFilter,type UserSaveInput,type UserInviteInput,type UserResult,type InvitePending} from '../../../../packages/erp-domain/src/access-users.mjs';
export {parseUsersList,parseUser,parseUserResult,parseInvitePending,captureUsersQuery,ACCESS_ROLES};
export type {AccessUser,AccessRole,UsersPage,UserFilter,UserSaveInput,UserInviteInput,UserResult,InvitePending};
export interface UsersController{getSnapshot:()=>AccessState;subscribe:(fn:()=>void)=>()=>void;accessUsers:(path:string,options?:NativeRequestOptions)=>Promise<unknown>;listPreferences:(path:string,options?:NativeRequestOptions)=>Promise<unknown>}
export const ROLE_TEXT:Record<AccessRole,string>={admin:'Administrador',consulta:'Consulta',vendas:'Vendas',financeiro:'Financeiro',estoque:'Estoque',fiscal:'Fiscal'};
export const STATUS_TEXT:Record<AccessUser['status'],string>={ativo:'Ativo',inativo:'Inativo',sem_acesso:'Sem acesso'};
export const FILTER_TEXT:Record<UserFilter,string>={todos:'Todos',ativo:'Ativos',inativo:'Inativos',sem_acesso:'Sem acesso à empresa'};
export const USER_COLUMNS=[{id:'nome',label:'Nome'},{id:'login',label:'Login'},{id:'tipo',label:'Tipo'},{id:'perfil',label:'Perfil de acesso'},{id:'situacao',label:'Situação'},{id:'mfa',label:'MFA'},{id:'ultimo_acesso',label:'Último acesso'}] as const;
export const USER_DEFAULT_COLUMNS=['nome','login','tipo','perfil','situacao','mfa'];
export const userLabel=(u:AccessUser)=>u.name??u.email??`Usuário ${u.user_id.slice(0,8)}`;
export const moment=(value:string|null)=>value?new Date(value).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo',dateStyle:'short',timeStyle:'short'}):'—';
export const statusTone=(u:AccessUser)=>u.status==='ativo'?'status-success':u.status==='inativo'?'status-neutral':'status-waiting';
export type Draft={name:string;phone:string;role:AccessRole;active:boolean};
export const draftOf=(u:AccessUser):Draft=>({name:u.name??'',phone:u.phone??'',role:u.role??'consulta',active:u.active});
/** Body of a save, or the reason it cannot be sent. Names and phones are sent trimmed; an empty phone is "não informado". */
export function saveBody(u:AccessUser,draft:Draft,commandId:string):{body?:UserSaveInput;problem?:string}{
 const name=draft.name.replace(/^ +| +$/g,''),phone=draft.phone.replace(/^ +| +$/g,'')||null;
 if(!userName(name))return{problem:'Informe o nome (até 120 caracteres).'};
 if(!userPhone(phone))return{problem:'Informe o celular com DDD (8 a 20 dígitos, parênteses, espaço, + ou hífen).'};
 return{body:{command_id:commandId,expected:{role:u.role,active:u.active,profile_version:u.profile_version},data:{name,phone,role:draft.role,active:draft.active}}};
}
export function inviteBody(email:string,name:string,role:AccessRole,commandId:string):{body?:UserInviteInput;problem?:string}{
 const e=email.replace(/^ +| +$/g,'').toLowerCase(),n=name.replace(/^ +| +$/g,'');
 if(!userName(n))return{problem:'Informe o nome (até 120 caracteres).'};if(!userEmail(e))return{problem:'Informe um e-mail válido.'};
 return{body:{command_id:commandId,email:e,name:n,role}};
}
export function saveFailure(status:number|null):{definitive:boolean;message:string}{
 if(status===409)return{definitive:true,message:'O usuário mudou desde a consulta ou o comando já existe com outros dados. Nada foi salvo; recarregue e confira.'};
 if(status===400)return{definitive:true,message:'Nada foi salvo. Confira os dados informados.'};
 if(status===403)return{definitive:true,message:'Nada foi salvo. Você não pode alterar o próprio perfil de administrador nem desativar a si mesmo, e só administradores alteram usuários.'};
 if(status===404)return{definitive:true,message:'Nada foi salvo. A conta não foi encontrada.'};
 return{definitive:false,message:'Não foi possível confirmar o resultado. Confira o mesmo comando antes de tentar de novo.'};
}
export function inviteFailure(status:number|null):{definitive:boolean;message:string}{
 if(status===409)return{definitive:true,message:'Já existe uma conta com este e-mail, há um convite para ele iniciado há menos de 5 minutos, ou o comando já foi usado com outros dados. Nenhum convite novo foi enviado. Procure a conta na lista para liberar o acesso ou tente de novo em alguns minutos.'};
 if(status===400)return{definitive:true,message:'Nenhum convite foi enviado. Confira o nome, o e-mail e o perfil.'};
 if(status===422)return{definitive:true,message:'O Supabase Auth recusou o convite (por exemplo: envio de e-mail do projeto ainda não configurado ou limite de envios atingido). Nenhuma conta foi criada e nenhum e-mail foi enviado. Tente de novo mais tarde.'};
 if(status===403)return{definitive:true,message:'Nenhum convite foi enviado. Somente administradores convidam usuários.'};
 return{definitive:false,message:'Não foi possível confirmar o convite. Confira o resultado do mesmo comando; ele nunca envia um segundo convite para o mesmo e-mail.'};
}
