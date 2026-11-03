import { itauCutoverNumbers, type CutoverNumber } from '../lib/itau-cutover-model';

const numberText = (number: CutoverNumber) => number.state === 'provided' ? number.value : number.state === 'missing' ? 'Não informado' : 'Confira o formato no campo';

export default function ItauCutoverGuide({ internalSequence, ourNumberBase }: { internalSequence: string; ourNumberBase: string }) {
  const numbers = itauCutoverNumbers(internalSequence, ourNumberBase);
  return <aside className="real-notice" aria-label="Preparar a mudança de cobrança Itaú">
    <h3>Dois números com funções diferentes</h3>
    <dl className="cnab-review">
      <div><dt>Sequência interna inicial FAGOO</dt><dd>{numberText(numbers.internalSequence)}</dd></div>
      <div><dt>Nosso Número inicial · base sem DV</dt><dd>{numberText(numbers.ourNumberBase)}</dd></div>
    </dl>
    <p>A sequência identifica as remessas no FAGOO. Para um perfil novo, você pode escolher começar em 1. Isso não altera nem libera um Nosso Número no banco.</p>
    <p>O Nosso Número precisa estar disponível para esta conta e carteira. Um formato válido ou o maior número de arquivos antigos não comprova disponibilidade.</p>
    <details><summary>Conferir a virada antes de gerar cobranças</summary>
      <ol>
        <li>Combine o momento de parar a numeração no sistema anterior. Confira também cobranças já numeradas e remessas ainda pendentes, antes de informar o início disponível no FAGOO.</li>
        <li>Confira a conta financeira, a data do corte e o saldo inicial em Contas financeiras. Recebimentos antigos já incluídos nesse saldo não devem ser lançados novamente.</li>
        <li>Escolha e aprove o formato de cada remessa em Cobrança operacional. A declaração sem encargos vale para esse formato; juros e multa do formato observado têm uma aprovação separada.</li>
      </ol>
      <p>Se uma geração ficar sem confirmação, confira a operação e retome a reserva existente. Criar outro perfil ou reiniciar números não resolve uma resposta perdida.</p>
      <p>Cobranças antigas do Origin ainda precisam de vínculo bancário comprovado para baixa pelo retorno. A impressão disponível é uma prévia NÃO PAGAR; a aceitação pelo banco precisa de conferência própria.</p>
    </details>
  </aside>;
}
