export type AuthorizationVaultReader=(reference:Readonly<{bucket:'brufap-a1-vault';key:string;sha256:string;maxBytes:1500000}>,options:{signal:AbortSignal;deadline:number})=>Promise<Uint8Array>;
export function createAuthorizationVaultReader(configuration:{projectUrl:string;supabaseDeployment?:'hosted'|'self-hosted';serviceKey:string;fetchImpl:typeof fetch}):AuthorizationVaultReader;
