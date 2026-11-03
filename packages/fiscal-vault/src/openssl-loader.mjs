import {createPkcs12Reader} from './pkcs12-reader.mjs';
import {need} from './common.mjs';

/** Compatibility adapter: this public loader still permits offline homologation only. */
export async function createOpenSslLoader(options = {}) {
  const reader = await createPkcs12Reader(options);
  return Object.freeze({
    async load({pfxBytes, passwordBytes, expectedHolderCnpj, now = new Date(), purpose} = {}) {
      need(purpose === 'offline-homologation', 'VAULT_OFFLINE_ONLY');
      return reader.read({pfxBytes, passwordBytes, expectedHolderCnpj, now},
        ({signer, metadata}) => Object.freeze({signer, metadata}), {retainSigner:true});
    },
  });
}
