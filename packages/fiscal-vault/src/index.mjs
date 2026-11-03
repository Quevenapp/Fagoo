export { VaultError } from './common.mjs';
export { createOpenSslLoader } from './openssl-loader.mjs';
export { sealCredential, withCredential, rewrapCredential, envelopeBytes, envelopeHash, parseEnvelope } from './envelope.mjs';
export { openLocalVault } from './local-store.mjs';
