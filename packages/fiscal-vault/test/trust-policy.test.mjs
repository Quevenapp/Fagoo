import test from'node:test';import assert from'node:assert/strict';import{mkdtemp,writeFile,rm,readdir,chmod}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';
import{createTrustPolicy}from'../src/trust-policy.mjs';import{trustFixture,HOLDER,OTHER,NOW,binary}from'./trust-fixtures.mjs';
const base=await trustFixture();const privatePolicy=()=>createTrustPolicy({binaryPath:binary,customTrustAnchors:[base.root.certificate]});
test('a complete synthetic chain validates X.509 and A1 declaration without claiming ICP, revocation or operational permission',async()=>{
 const policy=await privatePolicy(),report=await policy.evaluate(base.input);assert.equal(report.trust.chain_validated,true);assert.equal(report.trust.icp_brasil_chain_validated,false);assert.equal(report.profile.state,'supported_declaration');assert.equal(report.profile.tls_client_purpose_validated,true);assert.equal(report.profile.client_auth_usage,'explicit_client_auth');assert.equal(report.trust.chain_sha256.length,3);assert.equal(report.revocation.state,'unknown_offline');assert.equal(report.gates.revocation,false);assert.equal(report.can_emit,false);assert.equal(report.can_transmit,false);assert.equal(report.profile.policy_allocation_independently_checked,false);assert.doesNotMatch(JSON.stringify(report),new RegExp(`${HOLDER}|SYNTHETIC A1 LEAF|PRIVATE KEY|https?://|brufap-public-trust`));assert.ok(Object.isFrozen(report.profile.a1_policy_oids));
});
test('official snapshot is pinned, excludes revoked roots and reports unsupported v7 rather than trusting a supplied self-signed chain',async()=>{
 const policy=await createTrustPolicy({binaryPath:binary});assert.equal(policy.trustStore.anchors,7);assert.deepEqual(policy.trustStore.unsupported_anchors,['icp-brasil-v7']);const report=await policy.evaluate({...base.input,intermediates:[base.intermediate.certificate,base.root.certificate]});assert.equal(report.trust.chain_validated,false);assert.equal(report.trust.icp_brasil_chain_validated,false);assert.equal(report.trust.snapshot_fresh,true);assert.equal(report.profile.state,'supported_declaration');assert.ok(report.blockers.includes('TRUST_CHAIN_NOT_VALIDATED'));
 const old=await policy.evaluate({...base.input,now:new Date('2027-02-01T12:00:00Z')});assert.equal(old.trust.snapshot_fresh,false);assert.ok(old.blockers.includes('TRUST_SNAPSHOT_REVIEW_REQUIRED'));
});
test('root CA trust never comes from the leaf input, missing intermediates, or an unrelated trusted root',async()=>{
 const policy=await privatePolicy();let report=await policy.evaluate({...base.input,intermediates:[]});assert.equal(report.trust.chain_validated,false);
 const unrelated=await trustFixture();report=await policy.evaluate(unrelated.input);assert.equal(report.trust.chain_validated,false);
 await assert.rejects(()=>createTrustPolicy({binaryPath:binary,customTrustAnchors:[base.intermediate.certificate]}),/TRUST_ANCHOR_INVALID/);
});
test('tampered signatures and duplicated extensions cannot be converted into a valid chain',async()=>{
 const f=await trustFixture(),policy=await createTrustPolicy({binaryPath:binary,customTrustAnchors:[f.root.certificate]});
 f.leaf.pkijsCertificate.notAfter.value=new Date('2028-01-01T00:00:00Z');
 const tampered=new Uint8Array(f.leaf.pkijsCertificate.toSchema(true).toBER(false));
 assert.equal((await policy.evaluate({...f.input,certificate:tampered})).trust.chain_validated,false);
 f.leaf.pkijsCertificate.extensions.push(f.leaf.pkijsCertificate.extensions[0]);
 await assert.rejects(()=>policy.evaluate({...f.input,certificate:new Uint8Array(f.leaf.pkijsCertificate.toSchema(true).toBER(false))}),/TRUST_DUPLICATE_OR_EXCESS_EXTENSIONS/);
});
test('strict PKIX rejects path-length violation, expired root and unrecognized critical extensions',async()=>{
 for(const options of [{rootPathLen:0},{rootNotAfter:'2025-01-01T00:00:00Z'},{unknownCritical:true},{omitAki:true}]){const f=await trustFixture(options),policy=await createTrustPolicy({binaryPath:binary,customTrustAnchors:[f.root.certificate]}),report=await policy.evaluate(f.input);assert.equal(report.trust.chain_validated,false,JSON.stringify(options));assert.ok(report.trust.openssl_error_codes.length>0);assert.equal(report.can_transmit,false);}
});
test('name constraints and non-CA issuers are enforced by path/PKIX validation',async()=>{
 for(const options of [{excludeDns:'.synthetic.invalid',dns:'host.synthetic.invalid'},{intermediateCa:false}]){const f=await trustFixture(options),policy=await createTrustPolicy({binaryPath:binary,customTrustAnchors:[f.root.certificate]}),report=await policy.evaluate(f.input);assert.equal(report.trust.chain_validated,false);}
});
test('a cryptographically trusted certificate with server-only EKU is not accepted for client authentication',async()=>{
 const f=await trustFixture({eku:['1.3.6.1.5.5.7.3.1']}),policy=await createTrustPolicy({binaryPath:binary,customTrustAnchors:[f.root.certificate]}),report=await policy.evaluate(f.input);assert.equal(report.trust.chain_validated,true);assert.equal(report.profile.client_auth_usage,'client_auth_excluded');assert.equal(report.profile.tls_client_purpose_validated,false);assert.ok(report.blockers.includes('TLS_CLIENT_PURPOSE_NOT_VALIDATED'));
});
test('legacy absence of EKU is reported as unrestricted, never misrepresented as an explicit clientAuth extension',async()=>{
 const f=await trustFixture({eku:null}),policy=await createTrustPolicy({binaryPath:binary,customTrustAnchors:[f.root.certificate]}),report=await policy.evaluate(f.input);assert.equal(report.trust.chain_validated,true);assert.equal(report.profile.client_auth_usage,'unrestricted_absent');assert.equal(report.profile.tls_client_purpose_validated,true);
});
test('A1 OID checks are arc-exact and conflicting certificate types remain unsupported',async()=>{
 for(const policies of [null,['2.16.76.1.2.10.1'],['2.16.76.1.2.1'],['2.16.76.1.2.1.999','2.16.76.1.2.3.999']]){const f=await trustFixture({policies});const policy=await createTrustPolicy({binaryPath:binary,customTrustAnchors:[f.root.certificate]}),report=await policy.evaluate(f.input);assert.equal(report.profile.state,'unsupported',JSON.stringify(policies));assert.equal(report.gates.declared_a1_profile,false);}
});
test('holder mismatch, expired leaf and missing digitalSignature cannot pass the declared A1 profile',async()=>{
 const policy=await privatePolicy();let report=await policy.evaluate({...base.input,expectedHolderCnpj:OTHER});assert.equal(report.profile.state,'unsupported');assert.ok(report.profile.issues.includes('CERTIFICATE_HOLDER_MISMATCH'));assert.equal(report.gates.declared_a1_profile,false);
 for(const options of [{leafNotAfter:'2025-01-01T00:00:00Z'},{signature:false}]){const f=await trustFixture(options),p=await createTrustPolicy({binaryPath:binary,customTrustAnchors:[f.root.certificate]});report=await p.evaluate(f.input);assert.equal(report.profile.state,'unsupported');}
});
test('boundaries reject coercion, URLs, concatenated PEM, duplicate certificates, oversized input and invented revocation evidence',async()=>{
 const policy=await privatePolicy();for(const input of [{...base.input,certificate:[base.leaf.certificate]},{...base.input,certificate:'https://issuer.invalid/cert'},{...base.input,certificate:base.leaf.certificate+base.root.certificate},{...base.input,intermediates:Array(11).fill(base.intermediate.certificate)},{...base.input,intermediates:[base.leaf.certificate]},{...base.input,certificate:new Uint8Array(32769)},{...base.input,now:'2026-10-16'},{...base.input,revocation:{checked:true}}])await assert.rejects(()=>policy.evaluate(input));
 await assert.rejects(()=>createTrustPolicy({binaryPath:'openssl'}));await assert.rejects(()=>createTrustPolicy({binaryPath:binary,customTrustAnchors:[base.root.certificate,base.root.certificate]}));
});
test('temporary public-certificate files are cleaned after successful and failed evaluations',async()=>{
 const names=async()=>new Set((await readdir(tmpdir())).filter(v=>v.startsWith(`brufap-public-trust-${process.pid}-`))),before=await names(),policy=await privatePolicy();await policy.evaluate(base.input);const after=await names();assert.deepEqual([...after].sort(),[...before].sort());
 const directory=await mkdtemp(join(tmpdir(),'brufap-trust-timeout-fixture-'));try{const script=join(directory,'openssl-fixture');await writeFile(script,'#!/bin/sh\nif [ "$1" = version ]; then echo "OpenSSL 3.0.0 synthetic"; else sleep 2; fi\n',{mode:0o700});await chmod(script,0o700);const slow=await createTrustPolicy({binaryPath:script,timeoutMs:500,customTrustAnchors:[base.root.certificate]});await assert.rejects(()=>slow.evaluate(base.input),/TRUST_OPENSSL_UNAVAILABLE_TIMEOUT_OR_OUTPUT_LIMIT/);assert.deepEqual([...(await names())].sort(),[...before].sort());}finally{await rm(directory,{recursive:true,force:true});}
});
