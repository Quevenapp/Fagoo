// SQL051 + encrypted041 + real OpenSSL/TLS loader; the HTTPS driver is inert.
// No environment secret, user certificate, socket or external fetch is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {SecureContext} from 'node:tls';
import {serviceFixture, hash} from './service-fixture.mjs';
import {fixture as wireFixture, plan as wirePlan} from './fixtures.mjs';
import {createWsdlService, createWsdlPreparationAuthorizer} from '../src/service.mjs';
import {createWsdlRpc} from '../src/service-rpc.mjs';
import {createWsdlCustodyPort} from '../../fiscal-runtime/src/wsdl-custody.mjs';
import {createSpWsdlTlsLoader} from '../../fiscal-runtime/src/wsdl-server-trust.mjs';
import {createOpenSslLoader, sealCredential, envelopeBytes} from '../../fiscal-vault/src/index.mjs';
import {binary, exportPfx, PASSWORD, KEK, HOLDER} from '../../fiscal-vault/test/fixtures.mjs';
import {trustFixture} from '../../fiscal-vault/test/trust-fixtures.mjs';

const OPERATIONS = ['protocol', 'status', 'authorization', 'receipt'];
const SERVICES = {
  protocol: 'NFeConsultaProtocolo4', status: 'NFeStatusServico4',
  authorization: 'NFeAutorizacao4', receipt: 'NFeRetAutorizacao4',
};
const omit = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
const erased = value => assert.ok(value.every(byte => byte === 0));

test('051 operation matrix keeps the same credential/context and consumes once before each synthetic GET', {timeout: 60000}, async t => {
  const f = await serviceFixture();
  const key = Buffer.from(KEK), captures = [], delivered = [], opened = [];
  let pfx, bytes;
  try {
    const cert = await trustFixture();
    pfx = await exportPfx(cert.leaf, [cert.intermediate, cert.root]);
    const offline = await createOpenSslLoader({binaryPath: binary});
    const tls = await createSpWsdlTlsLoader({binaryPath: binary});
    const scalar = async (sql, args = []) => (await f.db.query(sql, args)).rows[0].value;
    const identity = {legal_name: 'Empresa fictícia da matriz WSDL', trade_name: null, cnpj: HOLDER,
      ie: null, postal_code: '13400000', street: 'Rua Sintética', number: '1', complement: null,
      district: 'Centro', city: 'Piracicaba', municipality_code: '3538709', state: 'SP', phone: null, email: null};
    await scalar('select public.erp_company_save_identity($1::uuid,1,$2::uuid,$3::jsonb) value',
      [f.actor, randomUUID(), JSON.stringify(identity)]);
    const command = randomUUID();
    const reserved = await scalar("select public.erp_a1_reserve($1::uuid,$2::uuid,$3,'configure',1,2,'Certificado fictício de teste') value",
      [f.actor, command, hash(command)]);
    const envelope = await sealCredential({pfxBytes: pfx, passwordBytes: PASSWORD, context: reserved.context,
      kekBytes: key, keyId: 'synthetic-matrix', loader: offline, now: new Date()});
    bytes = envelopeBytes(envelope);
    const digest = hash(bytes), objectPath = `credentials/${reserved.credential_id}/${digest}.json`;
    await f.db.query('insert into storage.objects values($1,$2,$3::jsonb)',
      ['brufap-a1-vault', objectPath, JSON.stringify({size: bytes.length, mimetype: 'application/json'})]);
    await scalar("select public.erp_a1_finalize($1::uuid,$2::uuid,$3::uuid,$4::jsonb,$5,$6,'synthetic-matrix') value",
      [f.actor, command, reserved.lease_id, JSON.stringify(envelope.metadata), digest, bytes.length]);

    for (const model of ['55', '65']) for (const operation of OPERATIONS) {
      await t.test(`${model}/${operation}`, async () => {
        const input = {actor: f.actor, commandId: randomUUID(), model, operation,
          expectedA1Version: 2, expectedIdentityVersion: 2, confirmed: true};
        const trace = [], captured = [], diagnostics = [], consumed = new Set(), wire = wireFixture({plan: wirePlan(model, operation)});
        const host = model === '55' ? 'homologacao.nfe.fazenda.sp.gov.br' : 'homologacao.nfce.fazenda.sp.gov.br';
        const serviceName = model === '55' ? SERVICES[operation].toLowerCase() : SERVICES[operation];
        const expectedPath = `/ws/${serviceName}.asmx?WSDL`, expectedUrl = `https://${host}${expectedPath}`;
        const rpc = createWsdlRpc({projectUrl: 'https://abcdefghijklmnopqrst.supabase.co',
          serviceKey: 'synthetic-service-key-matrix-only', fetchImpl: async (url, options) => {
            assert.match(url, /^https:\/\/abcdefghijklmnopqrst\.supabase\.co\/rest\/v1\/rpc\/erp_fiscal_wsdl_(begin|use|finish|fail|command)$/);
            assert.equal(options.method, 'POST');
            assert.equal(options.redirect, 'manual');
            const name = url.split('/').at(-1), action = name.slice('erp_fiscal_wsdl_'.length);
            const args = JSON.parse(Buffer.from(options.body).toString('utf8'));
            assert.equal(args.p_user_id, f.actor);
            trace.push(`rpc:${action}`);
            try {
              const result = await f.callSql(name, args);
              if (action === 'begin') captured.push(structuredClone(result.execution));
              if (action === 'use') { consumed.add(args.p_attempt_id); trace.push('use:committed'); }
              return Response.json(result);
            } catch (error) { return Response.json({code: error.code, message: 'SYNTHETIC_SQL_ERROR'}, {status: 400}); }
          }});
        const authorize = createWsdlPreparationAuthorizer({rpc});
        let currentCapture;
        const custody = createWsdlCustodyPort({keyring: new Map([['synthetic-matrix', key]]), diagnostic: line => diagnostics.push(line),
          authorizePreparation: async (value, options) => {
            trace.push('authorize');
            assert.equal(value.context.endpoint, expectedUrl);
            assert.equal(value.execution.scope.endpoint, expectedUrl);
            assert.equal(value.context.deadline, options.deadline);
            assert.equal(value.execution.scope.model, model);
            assert.equal(value.execution.scope.operation, operation);
            currentCapture = structuredClone(value);
            return authorize(value, options);
          },
          readObject: async (reference, options) => {
            trace.push('envelope:read');
            assert.equal(options.signal.aborted, false);
            assert.deepEqual(reference, {bucket: 'brufap-a1-vault', path: objectPath,
              hash: digest, size: bytes.length, key_id: 'synthetic-matrix'});
            const copy = Buffer.from(bytes); delivered.push(copy); return copy;
          },
          loader: {async withContext(value, action) {
            trace.push('loader:open'); opened.push(value);
            await tls.withContext(value, async session => {
              trace.push('loader:callback');
              assert.ok(session.secureContext instanceof SecureContext);
              assert.equal(session.metadata.fingerprint_sha256, envelope.metadata.fingerprint_sha256);
              assert.equal(session.deadline, currentCapture.context.deadline);
              await action(session);
            });
          }},
        });
        const service = createWsdlService({rpc, storage: f.ports.storage, withPreparedTlsSession: custody,
          requestImpl(options, callback) {
            trace.push('https:request');
            assert.equal(consumed.has(currentCapture.execution.scope.attempt_id), true);
            assert.equal(options.method, 'GET'); assert.equal(options.hostname, host);
            assert.equal(options.path, expectedPath); assert.equal(options.servername, host);
            assert.equal(options.rejectUnauthorized, true); assert.ok(options.secureContext instanceof SecureContext);
            return wire.requestImpl(options, callback);
          }});
        const result = await service.run(input);
        assert.equal(result.status, 'stored', JSON.stringify({trace, failure: result.failure_code, code: result.error_code}));
        assert.equal(result.receipt.model, model); assert.equal(result.receipt.operation, operation);
        assert.equal(result.artifact.inspection_status, 'supported');
        assert.equal(result.binding_verified, false); assert.equal(result.can_transmit, false);
        assert.equal(wire.calls, 1); assert.equal(wire.writes, 1);
        assert.equal(trace.filter(x => x === 'rpc:use').length, 1);
        assert.deepEqual(captured[0], captured[1], 'Preparation replay must not change execution');
        for (const [before, after] of [['authorize', 'envelope:read'], ['envelope:read', 'loader:open'],
          ['loader:callback', 'use:committed'], ['use:committed', 'https:request'], ['https:request', 'rpc:finish']]) {
          assert.ok(trace.indexOf(before) >= 0 && trace.indexOf(before) < trace.indexOf(after), `${before} before ${after}`);
        }
        const at = trace.length, replay = await service.run(input);
        assert.equal(replay.status, 'stored'); assert.equal(wire.calls, 1);
        assert.deepEqual(trace.slice(at), ['rpc:command']);
        assert.deepEqual(diagnostics, [], 'A successful preparation and terminal replay emit no failure diagnostic');
        captures.push(currentCapture);
      });
    }
    assert.equal(captures.length, 8);
    for (const capture of captures) {
      assert.deepEqual(capture.execution.credential, captures[0].execution.credential,
        'The operation must not alter the encrypted credential or metadata');
      assert.deepEqual(omit(capture.execution.scope, ['model', 'operation', 'endpoint', 'attempt_id', 'command_id', 'nonce', 'expires_at']),
        omit(captures[0].execution.scope, ['model', 'operation', 'endpoint', 'attempt_id', 'command_id', 'nonce', 'expires_at']));
      assert.deepEqual(omit(capture.context, ['model', 'operation', 'endpoint', 'request_id', 'deadline']),
        omit(captures[0].context, ['model', 'operation', 'endpoint', 'request_id', 'deadline']));
      assert.equal(capture.execution.credential.context.purpose, 'offline-homologation');
    }
    assert.equal(new Set(captures.map(x => x.execution.scope.nonce)).size, 8);
    assert.equal(new Set(captures.map(x => x.execution.scope.attempt_id)).size, 8);
    assert.equal(opened.length, 8); assert.equal(delivered.length, 8);
    for (const value of opened) { erased(value.pfxBytes); erased(value.passwordBytes); }
    for (const value of delivered) erased(value);
    assert.deepEqual(key, KEK);
  } finally { bytes?.fill(0); pfx?.fill(0); key.fill(0); await f.close(); }
});
