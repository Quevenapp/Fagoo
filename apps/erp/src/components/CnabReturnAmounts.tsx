import { returnAmountRows, type ReturnAmountsEvent } from '../lib/cnab-return-amounts';
import './cnab-return-amounts.css';

export default function CnabReturnAmounts({ event, historical = false }: { event: ReturnAmountsEvent; historical?: boolean }) {
  const rows = returnAmountRows(event);
  return <section className="cnab-return-amounts" aria-label="Valores informados pelo arquivo">
    <h4>Valores informados pelo arquivo</h4>
    <p className="real-help">{historical ? 'Valores preservados no contexto desta revisão.' : 'Valores desta ocorrência do retorno.'} Esta leitura não confirma baixa no FAGOO nem conciliação do saldo bancário.</p>
    <dl>{rows.map(row => <div key={row.field}><dt>{row.label}</dt><dd>{row.formatted}</dd></div>)}</dl>
    {event.bank === '341' && <p className="real-help">Mora/multa é um único valor do retorno. O arquivo não separa juros de multa; esta conferência não calcula taxas nem distribui o agregado.</p>}
  </section>;
}
