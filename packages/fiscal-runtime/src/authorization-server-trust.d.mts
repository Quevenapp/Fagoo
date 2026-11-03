import type {PreparedSession} from '../../fiscal-authorization/src/operational-transport.mjs';
export const SP_AUTHORIZATION_SERVER_TRUST:'node-bundled-plus-iti-ssl-v10-20261016';
export const SP_AUTHORIZATION_ROOT_HASH:'6e0bff069a26994c15de2c4888cc54af84882e5495b7fbf66be9ccffec7489f6';
export function requireAuthorizationServerContext(context:object,expectedClientFingerprint:string):Readonly<{server_trust_profile:typeof SP_AUTHORIZATION_SERVER_TRUST;server_trust_anchor_sha256:typeof SP_AUTHORIZATION_ROOT_HASH}>;
/** The second argument is a local testing seam, never an HTTP/runtime input. */
export function createSpAuthorizationTlsLoader(options?:Readonly<Record<string,unknown>>,testing?:{readFileImpl?:(path:URL)=>Promise<Uint8Array>;createContext?:(options:Readonly<Record<string,unknown>>)=>object;now?:()=>Date}):Promise<Readonly<{withContext:(value:unknown,action:(session:PreparedSession)=>Promise<void>)=>Promise<void>}>>;
