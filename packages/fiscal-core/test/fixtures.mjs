// Synthetic identifiers only. No XML, certificate, CSC or real issuer is included.
export const identity = Object.freeze({ cUF: '35', cnpj: '12345678000195', model: '55', environment: '2', series: '1', number: '123', issuedAt: '2026-10-15T23:30:00-03:00', cNF: '12345678', tpEmis: '1' });
export const now = new Date('2026-10-16T02:30:00Z');
export const config = Object.freeze({ cnpj: identity.cnpj, stateRegistration: 'SYNTHETIC-IE', taxRegime: { crt: 3, confirmed: true },
  certificate: { type: 'A1', verified: true, secretRef: 'vault/fake-certificate', cnpj: identity.cnpj, validFrom: '2026-01-01T00:00:00Z', validUntil: '2027-01-01T00:00:00Z' },
  accreditation: { '55': { '1': true, '2': true }, '65': { '1': true, '2': true } },
  schemaProfile: { id: 'test-fixture-not-a-real-schema', reviewed: true, models: ['55', '65'] }, taxRulesReviewed: true,
  csc: { '2': { id: '000001', secretRef: 'vault/fake-csc', verified: true } },
  homologation: { '55': { completed: true, evidenceRef: 'test-only/not-a-sefaz-test' } }, productionEnabled: false,
});
export const documentDigest = 'a'.repeat(64);
export const signedXmlDigest = 'b'.repeat(64);
