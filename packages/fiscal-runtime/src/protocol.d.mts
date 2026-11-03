export const MAX_CONFIGURE_BYTES:number;
export const CONFIGURE_TYPE:string;
export function parseConfigure(value:Uint8Array):{command_id:string;expected_version:number;expected_identity_version:number;reason:string;pfxBytes:Uint8Array;passwordBytes:Uint8Array};
export function encodeConfigure(input:{command_id:string;expected_version:number;expected_identity_version:number;reason:string;pfxBytes:Uint8Array;passwordBytes:Uint8Array}):Uint8Array;
export function uuid(value:unknown):value is string;
export function reason(value:unknown):value is string;
