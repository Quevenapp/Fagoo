import type {ProcessedBinding} from './processed-dto.mjs';
export {DanfeRuntimeError,ERROR_CODES} from './protocol.mjs';
export const MAX_XML_BYTES:512000,MAX_XML_RESPONSE_BYTES:1048576,MAX_HTML_BYTES:4194304,MAX_RESPONSE_BYTES:8388608;
export type ProcessedRoute=ProcessedBinding&Readonly<{path:string;method:'GET';limit:0;responseLimit:number}>;
export function route(path:string,method:string,prefix?:'/internal/v1/fiscal-danfe'|'/v1/fiscal-danfe'):ProcessedRoute;
export function parsePayload(bytes:Uint8Array,route:ProcessedRoute):Readonly<Record<string,never>>;
