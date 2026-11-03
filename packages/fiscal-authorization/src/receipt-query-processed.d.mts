import type {ReceiptQuerySourceHandle} from './receipt-query-source.mjs';
import type {ReceiptQuery,ReceiptResponse} from './receipt-core.mjs';
import type {ReceiptProcessedCandidate} from './receipt-processed.mjs';
export function composeReceiptQueryProcessedNfe(input:{source:ReceiptQuerySourceHandle;request:ReceiptQuery;response:ReceiptResponse;responseBytes:Uint8Array}):ReceiptProcessedCandidate&Readonly<{selectedSourceKind:'authorization'|'revalidation';selectedSourceCommandId:string;authorizationAttemptId:string;sourceBindingHash:string;sourceProfile:'receipt-query-source-089-v1';sourceManifestHash:string}>;
