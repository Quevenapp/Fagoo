import type {Storage} from './service.mjs';
export class AuthorizationStorageError extends Error {readonly code:string;}
export function createAuthorizationStorage(configuration:{projectUrl:string;supabaseDeployment?:'hosted'|'self-hosted';serviceKey:string;fetchImpl:typeof fetch}):Storage;
