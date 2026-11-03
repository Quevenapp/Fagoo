import type {ReceiptQueryService} from '../../fiscal-authorization/src/receipt-query-service.mjs';
export type ReceiptQueryCompositionConfiguration=Readonly<{
 projectUrl:string;supabaseDeployment?:'hosted'|'self-hosted';serviceKey:string;fetchImpl:typeof fetch;keyring:Map<string,Uint8Array>;
 binaryPath:string;allowLegacy?:boolean;enabled?:boolean;
}>;
/** Trusted local factory substitutions for tests, never parsed from HTTP or environment. */
export type ReceiptQueryCompositionFactories=Readonly<{
 rpc?:typeof import('../../fiscal-authorization/src/receipt-query-rpc.mjs').createReceiptQueryRpc;
 authorizationStorage?:typeof import('../../fiscal-authorization/src/storage.mjs').createAuthorizationStorage;
 authorizationValidator?:typeof import('../../fiscal-authorization/src/validator.mjs').createAuthorizationValidator;
 source?:typeof import('../../fiscal-authorization/src/receipt-query-source.mjs').createReceiptQuerySource;
 queryStorage?:typeof import('../../fiscal-authorization/src/receipt-query-storage.mjs').createReceiptQueryStorage;
 receiptValidator?:typeof import('../../fiscal-authorization/src/receipt-validator.mjs').createReceiptValidator;
 tlsLoader?:typeof import('../../fiscal-authorization/src/receipt-query-server-trust.mjs').createSpReceiptQueryTlsLoader;
 vaultReader?:typeof import('./authorization-vault-read.mjs').createAuthorizationVaultReader;
 preparation?:typeof import('../../fiscal-authorization/src/receipt-query-preparation.mjs').createReceiptQueryPreparationAuthorizer;
 custody?:typeof import('../../fiscal-authorization/src/receipt-query-custody.mjs').createReceiptQueryCustodyPort;
 transport?:typeof import('../../fiscal-authorization/src/receipt-query-transport.mjs').createReceiptQueryTransport;
 service?:typeof import('../../fiscal-authorization/src/receipt-query-service.mjs').createReceiptQueryService;
}>;
export function createReceiptQueryComposition(configuration:ReceiptQueryCompositionConfiguration,trustedFactories?:ReceiptQueryCompositionFactories):Promise<Readonly<{service:ReceiptQueryService;enabled:boolean}>>;
