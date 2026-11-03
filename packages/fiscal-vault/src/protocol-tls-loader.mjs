import {createSecureContext, SecureContext} from 'node:tls';
import {createPkcs12Reader} from './pkcs12-reader.mjs';
import {need, safe, inputs, clock, HASH, VaultError} from './common.mjs';

const PURPOSE = 'sefaz-sp-protocol-homologation-v1';
const CLIENT_AUTH = '1.3.6.1.5.5.7.3.2', ANY_USAGE = '2.5.29.37.0';
const KEYS = ['pfxBytes', 'passwordBytes', 'expectedHolderCnpj', 'expectedFingerprint', 'now', 'purpose', 'signal', 'deadline'];
function capture(value) {
  need(value && [Object.prototype, null].includes(Object.getPrototypeOf(value)), 'VAULT_TLS_INPUT_INVALID');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  need(Reflect.ownKeys(descriptors).every(k => typeof k === 'string' && KEYS.includes(k) && Object.hasOwn(descriptors[k], 'value')), 'VAULT_TLS_INPUT_INVALID');
  return Object.fromEntries(Object.entries(descriptors).map(([k, d]) => [k, d.value]));
}

/**
 * Server-only cryptographic adapter. It does not open an envelope, authorize a
 * grant, choose a destination or perform a network request. The custody port
 * must consume its current protocol grant before using this temporary context.
 */
export async function createProtocolTlsLoader(options = {}, {createContext = createSecureContext} = {}) {
  need(typeof createContext === 'function', 'VAULT_TLS_CONTEXT_FACTORY_INVALID');
  const reader = await createPkcs12Reader(options);
  return Object.freeze({
    async withContext(input, action) {
      let file, password, controller, timer, onAbort, inputSignal, context, abortListener, stopCode = 'VAULT_TLS_TIMEOUT';
      try {
        const value = capture(input);
        need(value.purpose === PURPOSE && typeof action === 'function', 'VAULT_TLS_PURPOSE_INVALID');
        inputs(value.pfxBytes, value.passwordBytes);
        need(typeof value.expectedFingerprint === 'string' && HASH.test(value.expectedFingerprint), 'VAULT_TLS_FINGERPRINT_REQUIRED');
        const at = value.now ?? new Date(); clock(at);
        const now = new Date(at.getTime()), deadline = value.deadline ?? Date.now() + 20000;
        need(Number.isSafeInteger(deadline) && deadline > Date.now() && deadline <= Date.now() + 20000, 'VAULT_TLS_DEADLINE_INVALID');
        need(value.signal === undefined || value.signal instanceof AbortSignal, 'VAULT_TLS_SIGNAL_INVALID');
        inputSignal = value.signal;
        file = Buffer.from(value.pfxBytes); password = Buffer.from(value.passwordBytes);
        controller = new AbortController();
        onAbort = () => { stopCode = 'VAULT_TLS_ABORTED'; controller.abort(); };
        inputSignal?.addEventListener('abort', onAbort, {once:true});
        if (inputSignal?.aborted) onAbort();
        timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
        const check = () => {
          need(!controller.signal.aborted, stopCode);
          need(Date.now() < deadline, 'VAULT_TLS_TIMEOUT');
        };
        check();
        const loaded = await reader.read({pfxBytes:file, passwordBytes:password, expectedHolderCnpj:value.expectedHolderCnpj, now}, material => {
          check();
          need(material.metadata.fingerprint_sha256 === value.expectedFingerprint, 'VAULT_TLS_CERTIFICATE_MISMATCH');
          const leaf = material.certificateChain[0], eku = leaf.keyUsage;
          need(eku === undefined || Array.isArray(eku) && (eku.includes(CLIENT_AUTH) || eku.includes(ANY_USAGE)), 'VAULT_TLS_CLIENT_USAGE_EXCLUDED');
          // The default trust store validates the remote TLS server. The A1's
          // presented issuer chain is not installed as a server trust anchor.
          const certificates = material.certificateChain
            .filter((cert, index) => index === 0 || !(cert.ca && cert.checkIssued(cert) && cert.verify(cert.publicKey)))
            .map(cert => cert.toString()).join('\n');
          const candidate = createContext({key:material.privateKeyPem, cert:certificates, minVersion:'TLSv1.2', maxVersion:'TLSv1.3'});
          need(candidate instanceof SecureContext, 'VAULT_TLS_CONTEXT_FACTORY_INVALID');
          return {context:candidate, metadata:Object.freeze({
            fingerprint_sha256:material.metadata.fingerprint_sha256,
            holder_cnpj:material.metadata.holder_cnpj,
            not_before:material.metadata.not_before, not_after:material.metadata.not_after,
            client_auth_usage:eku === undefined ? 'unrestricted_absent' : eku.includes(CLIENT_AUTH) ? 'explicit_client_auth' : 'unrestricted_any',
            presented_chain_links_checked:true, icp_brasil_chain_validated:false,
            revocation_checked:false, a1_policy_verified:false, can_emit:false, can_transmit:false,
          })};
        }, {signal:controller.signal, deadline});
        file.fill(0); password.fill(0);
        context = loaded.context; check();
        const stopped = new Promise((_, reject) => {
          abortListener = () => { try { check(); } catch (error) { reject(error); } };
          controller.signal.addEventListener('abort', abortListener, {once:true});
          if (controller.signal.aborted) abortListener();
        });
        const execution = Promise.resolve().then(() => {
          check();
          return action(Object.freeze({secureContext:context, metadata:loaded.metadata, signal:controller.signal, deadline}));
        });
        const result = await Promise.race([execution, stopped]);
        check();
        need(result === undefined, 'VAULT_TLS_ACTION_MUST_RETURN_VOID');
      } catch (error) {
        if (controller?.signal.aborted) throw new VaultError(stopCode);
        throw safe(error, 'VAULT_TLS_CONTEXT_FAILED');
      } finally {
        clearTimeout(timer); inputSignal?.removeEventListener('abort', onAbort);
        controller?.signal.removeEventListener('abort', abortListener);
        controller?.abort(); context = undefined;
        file?.fill(0); password?.fill(0);
      }
    },
  });
}
