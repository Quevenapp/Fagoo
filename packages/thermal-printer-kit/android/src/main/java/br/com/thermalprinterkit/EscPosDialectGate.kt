package br.com.thermalprinterkit

/**
 * Um único lugar decide se um dialeto pode usar o caminho ESC/POS.
 *
 * **Por que isto existe, medido em 23/08/2026 numa Diebold IM453H.** O kit mandou a ela o
 * comprovante de teste ESC/POS de sempre. Saíram códigos no papel — o esperado, já que a firmware
 * dela é ESC/P da Diebold Procomp e não tem **nenhum** comando `GS`. O que não era esperado é o
 * resto: a impressora **travou**. A tecla física de avanço de papel parou de responder, e `ESC r` —
 * que o manual dela descreve como "tratado na recepção", isto é, obedecido fora da fila — **não
 * recuperou**. Só desligar e ligar recuperou.
 *
 * É essa a diferença que este arquivo guarda. Mandar o dialeto errado não custa bobina: custa a
 * impressora parada até alguém ir fisicamente até ela. Num balcão, isso é o atendimento parado.
 *
 * **O formato é proposital.** O `when` é exaustivo sobre [EscPosDialect], sem `else`. Um dialeto
 * novo não compila até que alguém responda aqui se ele pode ou não emitir ESC/POS. A resposta
 * padrão não existe — e não pode existir, porque o padrão silencioso seria "emite", que é
 * exatamente o defeito que travou a IM453H.
 */
object EscPosDialectGate {
    /**
     * Se o kit sabe **compor um cupom inteiro** neste dialeto: texto, raster e corte.
     *
     * É esta a pergunta que os caminhos de escrita fazem antes de abrir a porta. Um dialeto sem
     * composição não pode chegar ao fio de jeito nenhum — não porque o cupom sairia feio, mas
     * porque foi assim que a IM453H travou em 23/08/2026, com a tecla de avanço morta e recuperação
     * só no desligar e ligar.
     *
     * Os dois valores respondem `true` hoje. O `when` continua exaustivo e sem `else` pela mesma
     * razão de sempre: **o próximo dialeto não compila até alguém responder aqui**, e o padrão
     * silencioso seria "pode", que é o defeito.
     */
    fun composesReceipt(dialect: EscPosDialect): Boolean =
        when (dialect) {
            EscPosDialect.EPSON_COMPATIBLE -> true
            // Desde 23/08/2026: `ProcompEscP` (texto e atributos), `ProcompRasterEmitter`
            // (`ESC n`) e o `ReceiptLayout` compondo pelo dialeto do perfil.
            EscPosDialect.PROCOMP_ESC_P -> true
        }

    /**
     * Verdadeiro somente para dialetos cujo aparelho entende o ESC/POS que o kit emite — o corpo do
     * recibo **e** o prólogo do transporte (`DLE EOT` de status e `ESC @` de init).
     *
     * **Não** é o mesmo que [composesReceipt]. Esta pergunta decide o **formato dos bytes**; aquela
     * decide se há cupom para compor. Confundir as duas foi o que este arquivo passou a distinguir
     * quando o dialeto Procomp ganhou emissor: "não falamos ESC/POS com ela" deixou de significar
     * "não imprimimos nela".
     *
     * **Desde 26/08/2026 nenhum caminho de produção pergunta isto, e é preciso dizer por quê.** Ela
     * era o portão da homologação — "esta impressora fala ESC/POS?" antes de mandar uma sonda. Com
     * duas séries de sondas essa passou a ser a pergunta errada: quem decide é o dialeto **dos
     * bytes** contra o do alvo, em [PrinterProbeSession.send]. As perguntas concretas que sobraram
     * têm cada uma o seu portão — [usesEscPosStatusQueries] para o `DLE EOT` e
     * [usesEscPosIdentityQuery] para o `GS I`.
     *
     * A propriedade continua verdadeira e continua fixada por teste. **Não a use como trava nova
     * sem antes escrever qual comando ela está protegendo**: foi genérica demais uma vez, e o preço
     * foi uma impressora que só podia ser adotada sem medição.
     */
    fun emitsEscPos(dialect: EscPosDialect): Boolean =
        when (dialect) {
            EscPosDialect.EPSON_COMPATIBLE -> true
            // Este `false` não quer dizer "não sabemos imprimir": quer dizer "**não** emitimos
            // ESC/POS para ela". Desde 23/08/2026 o kit tem o dialeto inteiro — `ProcompEscP` para
            // texto e atributos, `ProcompRasterEmitter` para `ESC n`, e o `ReceiptLayout` compondo
            // pelo dialeto do perfil. O que este portão continua garantindo é que **nenhum byte
            // ESC/POS** alcance uma firmware que trava com eles.
            EscPosDialect.PROCOMP_ESC_P -> false
        }

    /**
     * Os bytes que abrem todo trabalho, **por dialeto**.
     *
     * Antes isto era fixo: `EscPosThermalCommands.initialize()`, isto é `ESC @`, antes de qualquer
     * corpo. Medido em 23/08/2026 na IM453H — `ESC @` não é comando dela, e o `40h` foi parar no
     * papel como um `@` na frente de **todas** as tiras do dia. O prólogo era nosso, não dela.
     *
     * No lugar dele, o dialeto Procomp abre desligando cada atributo com o comando que desliga
     * aquele atributo, todos vistos agindo em papel — em vez de confiar num reset único que só o
     * manual promete. Ver [ProcompEscP.reset].
     */
    fun prologue(dialect: EscPosDialect): ByteArray =
        when (dialect) {
            EscPosDialect.EPSON_COMPATIBLE -> EscPosThermalCommands.initialize()
            EscPosDialect.PROCOMP_ESC_P -> ProcompEscP.reset()
        }

    /**
     * Se vale perguntar status pelo `DLE EOT` do ESC/POS antes de imprimir.
     *
     * A pergunta são seis bytes (`10 04 02` e `10 04 04`) que o transporte manda em todo trabalho.
     * Numa firmware que não os conhece eles são bytes soltos no meio de um fluxo — e nesta
     * impressora byte solto no lugar errado não erra caractere, trava o aparelho. Eles **não**
     * deixaram glifo na bancada, mas "não imprimiu" não é "não teve efeito", e não há por que
     * continuar perguntando a quem não fala essa língua.
     *
     * O recorte é por **dialeto** de propósito, e não pelo `statusProtocol` do perfil. O campo
     * existe e seria o lugar conceitualmente certo, mas hoje o transporte o ignora: consultá-lo
     * mudaria o comportamento de toda impressora com `statusProtocol = NONE`, que é praticamente
     * todo perfil medido — e essas eu não posso medir agora. Ver `docs/diebold-im453h.md`.
     */
    fun usesEscPosStatusQueries(dialect: EscPosDialect): Boolean =
        when (dialect) {
            EscPosDialect.EPSON_COMPATIBLE -> true
            EscPosDialect.PROCOMP_ESC_P -> false
        }

    /**
     * Se vale perguntar fabricante, modelo e firmware pelo `GS I` do ESC/POS.
     *
     * Pergunta separada da do status porque é **outro comando**, e este arquivo responde uma
     * pergunta por vez — juntar as duas faria a resposta de uma decidir a da outra sem que ninguém
     * tivesse medido isso.
     *
     * `GS I` é comando `GS`, e a IM453H não tem nenhum. O leitor de identidade dos transportes
     * dispara as três consultas sem consultar perfil, então até 26/08/2026 esta pergunta era feita a
     * qualquer alvo — o que só não alcançou a Diebold porque a homologação inteira a recusava antes.
     * Com a série Procomp existindo, a recusa saiu de lá e este é o lugar dela.
     *
     * O custo de errar é o de sempre nesta firmware: byte solto no lugar errado não erra caractere,
     * trava o aparelho. Ver [PrinterHomologationTarget.readIdentity].
     */
    fun usesEscPosIdentityQuery(dialect: EscPosDialect): Boolean =
        when (dialect) {
            EscPosDialect.EPSON_COMPATIBLE -> true
            EscPosDialect.PROCOMP_ESC_P -> false
        }
}
