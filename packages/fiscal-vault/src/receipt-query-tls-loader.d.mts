import type {PreparedSession} from '../../fiscal-authorization/src/operational-transport.mjs';
export function createReceiptQueryTlsLoader(options?:Readonly<Record<string,unknown>>,testing?:{createContext?:(options:Readonly<Record<string,unknown>>)=>object}):Promise<Readonly<{withContext:(value:unknown,action:(session:PreparedSession)=>Promise<void>)=>Promise<void>}>>;
