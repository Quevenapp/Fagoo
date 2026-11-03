import type {PreparedSession} from './operational-transport.mjs';
import type {ReviewedReceiptSoapRequest} from './receipt-soap-binding.mjs';
import type {ReceiptQueryLedgerGrant} from './receipt-query-ledger-dto.mjs';
export type ReceiptQueryTransport=(input:Readonly<{request:ReviewedReceiptSoapRequest;used:ReceiptQueryLedgerGrant}>,session:PreparedSession,options:Readonly<{signal:AbortSignal;deadline:number}>)=>Promise<Readonly<{response:Response;tls:Readonly<{origin:'operational';protocol:'TLSv1.2'|'TLSv1.3';server_identity_verified:true;server_trust_profile:'node-bundled-plus-iti-ssl-v10-20261016';server_trust_anchor_sha256:string}>}>>;
export function createReceiptQueryTransport(configuration:{requestImpl:(options:Readonly<Record<string,unknown>>,callback:(response:unknown)=>void)=>unknown}):ReceiptQueryTransport;
