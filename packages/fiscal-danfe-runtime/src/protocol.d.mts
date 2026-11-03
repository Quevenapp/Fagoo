export const MAX_HTML_BYTES: number;
export const MAX_RESPONSE_BYTES: number;
export const MAX_XML_BYTES: number;
export const ERROR_CODES: readonly string[];
export const UUID: RegExp;
export const HASH: RegExp;
export class DanfeRuntimeError extends Error { status: number; code: string; constructor(status: number, code: string); }
export function need(condition: unknown, status: number, code: string): asserts condition;
export function uuid(value: unknown): value is string;
export function sha256(value: unknown): value is string;
export function version(value: unknown, min?: number): value is number;
export function plain(value: unknown): value is Record<string, unknown>;
export function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown>;
export type DanfeRoute = Readonly<{action:'preview'; path:string; method:'GET'; candidateId:string; limit:0}>;
export function route(path: string, method: string, prefix?: string): DanfeRoute;
export function parsePayload(bytes: Uint8Array, selected: DanfeRoute): Readonly<Record<string, never>>;
export function readBounded(message: Request | Response, options: {limit:number; signal?:AbortSignal; deadline:number}): Promise<Uint8Array>;
