// QA_SYNTHETIC_CNAB_RETURN_AMOUNTS: no API, bank file, balance or posting.
import type { ReturnAmountsEvent } from '../lib/cnab-return-amounts';
export function cnabReturnAmountsQa(): ReadonlyArray<{ label: string; historical: boolean; event: ReturnAmountsEvent }> {
  const base: ReturnAmountsEvent = { bank: '341', amount_cents: '12345', paid_cents: '12000', adjustments: { fee: '345', iof: '0', abatement: '0', discount: '0', interest: '0', otherCredits: '0' } };
  return [
    { label: 'Itaú · tarifa no arquivo', historical: false, event: base },
    { label: 'Itaú · mora/multa positiva, sem divisão', historical: false, event: { ...base, paid_cents: '12123', adjustments: { ...base.adjustments!, interest: '123' } } },
    { label: 'Itaú · revisão histórica preservada', historical: true, event: { ...base, amount_cents: '999999999999999', paid_cents: '999999999999654' } },
    { label: 'Inter · sem campos de ajustes nesta projeção', historical: false, event: { bank: '077', amount_cents: '12345', paid_cents: '0', adjustments: null } },
  ];
}
