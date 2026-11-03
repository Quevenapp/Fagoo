export type UserType='normal'|'contador';
export type PermissionStatus='applied'|'admin'|'stored';
export const CONTROLS_BODY_BYTES:number;
export const USER_TYPES:readonly UserType[];
export const USER_TYPE_LABELS:Readonly<Record<UserType,string>>;
export const WINDOW_LIMIT:number;
export const WEEKDAYS:readonly string[];
export const WEEKDAY_NAMES:readonly string[];
export interface PermissionSub{key:string;label:string}
export interface PermissionCard{key:string;label:string;ie:boolean;ex:boolean;subs:readonly PermissionSub[];applied:boolean;admin:boolean}
export interface PermissionTab{id:string;label:string;cards:readonly PermissionCard[]}
export const PERMISSION_TABS:readonly PermissionTab[];
export const DASHBOARD_PERMISSIONS:Readonly<Record<string,string>>;
/** Estoque lane (260): the Produtos panels of /painel-produtos-empresa and their Meu Negócio permission. */
export const STOCK_DASHBOARD_PERMISSIONS:Readonly<{estoque:'estoque_produtos';sugestao:'sugestao_compras';'sem-movimentacao':'sem_movimentacao'}>;
export const PERMISSION_KEYS:readonly string[];
export function permissionParent(key:string):string|null;
export function permissionStatus(key:string):PermissionStatus|null;
export function permissionHint(key:string):string;
export function permissionsValid(keys:unknown):boolean;
export function allPermissions():string[];
export class PermissionsContractError extends Error{status:number;code:string;constructor(status:number,code:string);}
export function controlsUuid(value:unknown):value is string;
export interface AccessWindow{start:string;end:string;days:number[]}
export function windowValid(value:unknown):value is AccessWindow;
export interface ControlsData{user_type:UserType;schedule:{enabled:boolean;windows:AccessWindow[]};permissions:string[]|null}
export interface ControlsSaveInput{command_id:string;expected_version:number;data:ControlsData}
export function captureControlsSave(body:unknown):ControlsSaveInput;
export interface UserControls{scope:'access_user_controls';data_mode:'erp_native';target:string;role:string|null;version:number;user_type:UserType;schedule:{enabled:boolean;windows:AccessWindow[]};
 permissions:string[]|null;seller:{name:string;enabled:boolean;windows:AccessWindow[]}|null;updated_at:string|null;gate_required:boolean}
export function parseControls(raw:unknown,target:string):UserControls;
export interface ControlsResult{scope:'access_controls_command';data_mode:'erp_native';replayed:boolean;receipt:{command_id:string;target:string;changed_at:string};controls:UserControls}
export function parseControlsResult(raw:unknown,options:{target:string;input:ControlsSaveInput}):ControlsResult;
export interface MyPermissions{scope:'access_permissions';data_mode:'erp_native';user_id:string;role:string;user_type:UserType;permissions:string[]|null;access:{open:boolean;until:string|null}}
export function parseMyPermissions(raw:unknown):MyPermissions;
export function allowedBy(view:Pick<MyPermissions,'role'|'permissions'>|null,key:string):boolean;
