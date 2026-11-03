// Fictional identifiers and addresses only. No source from bank slips or backups.
export function fixture({ dense = false } = {}) {
  return {
    purpose: 'offline-print-preview',
    boleto: {
      purpose: 'offline-validation',
      profile: { bank: '341', wallet: '109', layout: 'itau-cnab400-2017-01', agency: '1234', account: '12345', accountDigit: '1',
        cnpj: '12345678000195', accountId: 'synthetic-account', companyName: 'EMPRESA FICTICIA', contractVerified: true,
        agreementReference: 'SYNTHETIC CONTRACT ONLY', simpleCollectionPolicyVerified: true },
      allocation: { ourNumber: '00000001', confirmed: true, reference: 'SYNTHETIC ALLOCATION ONLY' },
      title: { amountCents: '12345', dueOn: '2025-02-22', referenceOn: '2025-02-22' },
    },
    document: { number: 'TESTE/001', issuedOn: '2025-02-01', processedOn: '2025-02-22' },
    beneficiaryAddress: { address: dense ? 'W'.repeat(60) : 'RUA FICTICIA, 100', neighborhood: dense ? 'W'.repeat(20) : 'BAIRRO TESTE',
      city: dense ? 'W'.repeat(40) : 'CIDADE FICTICIA', state: 'SP', postalCode: '01001000' },
    payer: { type: '01', document: '12345678909', name: dense ? 'W'.repeat(60) : 'PAGADOR FICTICIO PARA TESTES',
      address: dense ? 'W'.repeat(60) : 'AVENIDA DE TESTE, 200', neighborhood: dense ? 'W'.repeat(20) : 'BAIRRO TESTE',
      city: dense ? 'W'.repeat(40) : 'CIDADE FICTICIA', state: 'SP', postalCode: '01001000' },
  };
}
