import type {Storage} from './service.mjs';
export class ReceiptQueryStorageError extends Error {readonly code:string;}
export function createReceiptQueryStorage(configuration:{projectUrl:string;supabaseDeployment?:'hosted'|'self-hosted';serviceKey:string;fetchImpl:typeof fetch}):Storage;
