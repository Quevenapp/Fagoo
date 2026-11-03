import type {Storage} from './service.mjs';
export class AuthorizationRevalidationStorageError extends Error {readonly code:string;}
export function createAuthorizationRevalidationStorage(configuration:{projectUrl:string;supabaseDeployment?:'hosted'|'self-hosted';serviceKey:string;fetchImpl:typeof fetch}):Storage;
