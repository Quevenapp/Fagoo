import type {ReceiptQuerySourceHandle} from './receipt-query-source.mjs';
import type {ReceiptQuery} from './receipt-core.mjs';
import type {ReceiptQueryRecovery,ReceiptQueryResultEvidence} from './receipt-query-sql-contract.d.mts';
import type {createReceiptQueryService} from './receipt-query-service.mjs';
type Configuration=Parameters<typeof createReceiptQueryService>[0];
export type ReceiptQueryScope=Readonly<{signal:AbortSignal;deadline:number;check():void;bounded<T>(fn:()=>T|Promise<T>):Promise<T>}>;
export function receiptQueryEvidenceBase(context:ReceiptQueryRecovery):Readonly<Record<string,unknown>>;
export function validateReceiptQueryBytes(port:Configuration['validate'],request:ReceiptQuery,bytes:Uint8Array,kind:'request'|'response',scope:ReceiptQueryScope):ReturnType<Configuration['validate']>;
export function processReceiptQueryResponse(input:{context:ReceiptQueryRecovery;source:ReceiptQuerySourceHandle;request:ReceiptQuery;bytes:Uint8Array;httpStatus:number;observationHash:string;observationSize:number;validate:Configuration['validate'];validateProcessed:Configuration['validateProcessed']},scope:ReceiptQueryScope):Promise<Readonly<{evidence:ReceiptQueryResultEvidence;processed:Uint8Array|null}>>;
