export interface Env {
  FAGOO_MANAGED?: string;
  FAGOO_ACTOR?: Actor;
  FAGOO_GRANT?: import('./managed').FagooGrant;
  FAGOO_AUTHORITY?: {authorize(args:{userId:string;unitId:string;capability:string}):Promise<import('./managed').FagooGrant>;noticeAllowed?(args:{noticeId:string;claimId:string;deliveryId:string}):Promise<boolean>;projectContact?(args:{unitId:string;namespace:string;sourceId:string;name:string;phone:string}):Promise<any>;subscribeWhatsApp?(args:{unitId:string;token:string;phone:string}):Promise<any>};
  DB: D1Database;
  MEDIA: R2Bucket;
  COORDINATOR: DurableObjectNamespace;
  ASSETS: Fetcher;
  MASTER_KEY: string;
  SETUP_TOKEN: string;
  APP_NAME?: string;
  WABOTIA_ACCOUNT_ID?: string;
  WABOTIA_WORKER_NAME?: string;
  WABOTIA_INSTALLATION_ID?: string;
  WABOTIA_UPDATE_TOKEN?: string;
}
export interface Actor {
  fagoo?: {unitId:string; capabilities:string[]; teamIds:string[]; client?:'web'|'mobile';administrator?:boolean; aliases?:Record<string,string>;people:{id:string;name:string;role:string;team_ids:string[]}[]};
  id: string;
  kind: "user" | "app" | "connector";
  name: string;
  role: "admin" | "operator" | "service";
  profiles: string[];
  scopes: string[];
  bots: string[];
  keyId?: string;
  rate: number;
  runLimit: number;
}
export type Bindings = {
  Bindings: Env;
  Variables: { actor: Actor; requestId: string };
};
export interface Profile {
  id: string;
  name: string;
  settings: string;
  enabled: number;
  created: number;
}
export interface Conversation {
  department_id?: string | null;
  menu_expires_at?: number | null;
  menu_token?: string | null;
  menu_items?: string;
  assigned_bot_id?: string | null;
  menu_active?: number;
  menu_manual?: number;
  menu_parent?: string | null;
  recipient_id?: string | null;
  chat_type: string;
  title: string;
  bot_policy: string;
  id: string;
  profile_id: string;
  connection_id: string | null;
  external_namespace: string;
  external_id: string;
  phone: string | null;
  state: string;
  owner: string | null;
  epoch: number;
  session: string;
  topic: string | null;
  tags: string;
  last_customer: number;
  created: number;
  updated: number;
}
export interface Run {
  request_body?: string;
  completion_handled?: number;
  id: string;
  profile_id: string;
  bot_id: string;
  actor: string;
  conversation_id: string | null;
  epoch: number | null;
  status: string;
  input: string;
  result: string | null;
  remote_id: string | null;
  error: string | null;
  created: number;
  updated: number;
  phase: string;
  context: string;
}
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export const now = () => Date.now();
export const uid = () => crypto.randomUUID();
export const json = (value: any, fallback: any = {}) => {
  try {
    return JSON.parse(value ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
};
export function requireValue(value: any, message: string): asserts value {
  if (!value) throw new ApiError(400, "invalid_request", message);
}
export const defaults = {
  attendant_bot: "",
  instructions: "",
  absence_instructions:
    "Nossa equipe está ausente. Abrimos um protocolo para acompanhar sua solicitação.",
  protocol_response_hours: 24,
  telegram_group: "",
  telegram_connection: "",
  reply_mode: "command",
  names: {},
  team: [],
  capabilities: [],
  departments: [],
  menus: [],
  apps: [],
  surveys_enabled: false,
  jev_enabled: false,
  notifications: { enabled: false, template_name: "", language: "pt_BR" },
};
