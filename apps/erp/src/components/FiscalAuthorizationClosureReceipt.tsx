import type {ClosureResult} from '../lib/fiscal-authorization-closure-lookup-model';
import {fiscalMoment} from '../lib/fiscal-drafts-model';
export default function FiscalAuthorizationClosureReceipt({value}:{value:ClosureResult}){
 return <section className="reviewed-authorization-closure" aria-label="Recibo de encerramento consultado" aria-live="polite">
  <h5>Recibo de encerramento consultado</h5><p>A preparação foi encerrada antes do envio em {fiscalMoment(value.receipt.closed_at)}. A preparação e a revisão originais foram preservadas.</p>
  <p>O encerramento não autoriza novo envio. Qualquer nova tentativa exige outra conferência e confirmação.</p>
  <h6>Situação consultada agora</h6><p>{value.current.successor_exists?'Há uma tentativa posterior para esta nota. Consulte seu histórico para verificar a situação atual.':'Nenhuma tentativa posterior foi identificada nesta consulta.'}</p>
  {value.current.intent_consumed&&<p>Este recibo não confirma envio ou resposta da tentativa posterior. Confira o resultado no histórico.</p>}
  <details><summary>Identificação do recibo de encerramento</summary><p>Comando de encerramento: <code>{value.command_id}</code></p><p>Comando da tentativa original: <code>{value.receipt.authorization_command_id}</code></p><p>Tentativa: <code>{value.receipt.attempt_id}</code></p></details>
 </section>;
}
