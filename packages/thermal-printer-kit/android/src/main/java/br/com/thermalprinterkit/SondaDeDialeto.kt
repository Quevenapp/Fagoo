package br.com.thermalprinterkit

/**
 * A tira que tenta separar as duas famílias **sem escolher uma delas antes**.
 *
 * ## O problema
 *
 * Toda pergunta de identidade que o kit sabe fazer é ESC/POS: `GS I` para fabricante, modelo e
 * firmware, `DLE EOT` para status. `GS` é justamente a família que a IM453H não tem, e com a qual
 * ela trava. Perguntar quem ela é, pelo caminho de sempre, é a própria maneira de quebrá-la.
 *
 * ## O único comando com prova nos dois lados
 *
 * `ESC E` (`1B 45`) existe nas duas famílias com **aridade diferente**:
 *
 * - **ESC/POS**: `ESC E n` — consome o byte seguinte, e usa só o bit 0 dele para ligar ou desligar
 *   o negrito.
 * - **Diebold Procomp**: `ESC E` — sem parâmetro. **Medido em papel** em 23/08/2026: o payload M2
 *   levava `1B 45` seguido do texto `ENFASE ESC E`, e a tira saiu com `ENFASE ESC E` inteiro. Se
 *   ele levasse parâmetro, o `E` inicial teria virado parâmetro e o papel diria `NFASE ESC E`.
 *
 * Daí a tira: cada par `1B 45 <a> <b>` faz a Diebold imprimir `ab` e o ESC/POS imprimir só `b`.
 *
 * ## Por que os dois lados imprimem, e nenhum fica em branco
 *
 * A versão óbvia desta ideia — deixar o ESC/POS comer a palavra inteira e sair com a **linha
 * vazia** — está errada, e o erro já custou uma medição aqui: em 21/08 `1F 76` e `1F 4E` deram
 * papel em branco idêntico, e sem marcador não havia como separar "o comando foi engolido" de "a
 * impressora não recebeu byte nenhum". Ver [ThermalWifiProbe]. Ausência não é resposta: uma tira
 * cuja resposta ESC/POS é o branco não distingue dialeto de impressora offline, sem papel, ou de
 * socket morto.
 *
 * Por isso o `a` de cada par é `*` e o `b` é uma letra: os dois lados imprimem, e imprimem coisas
 * **diferentes e legíveis a olho nu**.
 *
 * ## As escolhas de byte, uma a uma
 *
 * - **`*` (`0x2A`) como parâmetro** porque é par: no ESC/POS o bit 0 decide o negrito, e um byte
 *   par desliga. A tira termina sem deixar estado ligado, e sem precisar de `ESC E 0` — que
 *   mandaria um `0x00` à Diebold, fora da faixa `20h`–`7Eh`. Não é que só essa faixa tenha prova
 *   nela — os acentos ABICOMP da tabela alta saíram certos no M2 —, é que ela é a única com prova
 *   **nos dois lados**: no ESC/POS o byte alto depende da página de código, e escolher página aqui
 *   exigiria `ESC t`, cujo endereço não é o mesmo em toda firmware.
 * - **Nada de `ESC F` no fim.** Ele desligaria a ênfase da Diebold, mas não é ESC/POS, e a tabela
 *   de comprimentos do parser do repositório cai numa heurística declarada de 2 bytes que pode
 *   dessincronizar. A ênfase ligada morre no próximo prólogo, que é `ProcompEscP.reset`.
 * - **Nada de corte.** Os comandos de corte diferem nas duas famílias; a tira termina em avanço e
 *   quem estiver na bancada rasga.
 * - **Só ASCII `20h`–`7Eh` e `LF`** no resto. São os dois conjuntos com prova em papel nos dois
 *   lados. Nada de acento: escolher página de código exigiria `ESC t`, cujo endereço não é o mesmo
 *   em toda firmware ESC/POS — a T210 atende CP860 no `n` que a documentação reserva a outra.
 *
 * ## O que esta tira NÃO é, dito com todas as letras
 *
 * 1. **Ela não está provada do lado ESC/POS.** A aridade da Diebold saiu em papel; a do ESC/POS é
 *    leitura da especificação feita pelo próprio kit. **Nenhuma tira de impressora ESC/POS real
 *    neste repositório mediu `ESC E <letra>`.** É por isso que ela nasce como sonda de bancada, e
 *    não como etapa do app.
 * 2. **"ESC/POS" é família, não especificação.** Se a firmware do outro lado não implementar
 *    `ESC E`, ela imprime o `*` também, e as duas tiras ficam iguais — a sonda responde nada. Isso
 *    não é hipótese: a MP-4200 TH não implementa `GS !` e engole só o `GS`, mandando o `!` ao
 *    papel. Uma tira igual nos dois lados é **resposta inválida**, não é "é Diebold".
 * 3. **`ESC E` repetido nunca foi medido.** O M2 tem um só.
 * 4. **A aridade Diebold foi medida em uma unidade**, firmware `PD2.23`, contra um manual da linha
 *    `PD1` que já diverge dela na lista de parâmetros do autoteste.
 * 5. **Ela não dispensa a pergunta.** O prólogo do transporte continua sendo escolhido **por
 *    dialeto** ([EscPosDialectGate.prologue]), e o dialeto é exatamente o que ainda não se sabe.
 *    Na bancada isso se resolve vinculando com o card certo para cada lado — cada um recebe um
 *    prólogo já medido como inofensivo nele. **Não existe hoje caminho neutro**, e enquanto não
 *    existir esta tira não pode virar detecção automática no app.
 *
 * O que responde esta pergunta sem gastar byte nosso continua sendo o autoteste da própria
 * impressora — ver [DialetoNoBalcao.comoDescobrir].
 */
object SondaDeDialeto {

    /** O que sai no papel de uma firmware que **consome** o parâmetro do `ESC E`. */
    const val LEITURA_ESC_POS = "ESC/POS"

    /** O que sai no papel de uma firmware que **não** consome — a Diebold Procomp. */
    const val LEITURA_PROCOMP = "*E*S*C*/*P*O*S"

    /**
     * A tira inteira, pronta para o caminho de bytes crus.
     *
     * Curta de propósito: cabe folgada no teto de 256 bytes do comando cru, e gasta poucos
     * centímetros. Ver [RawHexCommand].
     */
    fun tira(): ByteArray {
        val saida = ArrayList<Byte>(160)
        fun texto(linha: String) {
            require(linha.all { it.code in 0x20..0x7E }) {
                "Sonda de dialeto só aceita ASCII imprimível: é a única faixa medida nas duas."
            }
            linha.forEach { saida += it.code.toByte() }
            saida += LF
        }

        texto("SONDA DE DIALETO")
        texto("LEIA A LINHA MARCADA COM >")
        saida += '>'.code.toByte()
        saida += ' '.code.toByte()
        PALAVRA.forEach { letra ->
            saida += ESC
            saida += ENFASE
            saida += PREENCHIMENTO
            saida += letra.code.toByte()
        }
        saida += LF
        texto("$LEITURA_ESC_POS = PADRAO ESC/POS")
        texto("$LEITURA_PROCOMP = DIEBOLD PROCOMP")
        texto("IGUAIS AOS DOIS = SONDA NAO RESPONDE")
        repeat(AVANCO_FINAL) { saida += LF }
        return saida.toByteArray()
    }

    /** `1Bh`. */
    private const val ESC: Byte = 0x1B

    /** `45h` — o mesmo byte nas duas famílias, com aridade diferente. É esse o discriminador. */
    private const val ENFASE: Byte = 0x45

    /**
     * `2Ah`, o `*`.
     *
     * Par de propósito: no ESC/POS o bit 0 do parâmetro decide o negrito, e par o desliga. Assim a
     * tira não deixa estado ligado atrás de si em nenhuma das duas famílias.
     */
    private const val PREENCHIMENTO: Byte = 0x2A

    private const val LF: Byte = 0x0A

    /** Avanço para a linha marcada sair de dentro do mecanismo antes de alguém rasgar. */
    private const val AVANCO_FINAL = 4

    private const val PALAVRA = "ESC/POS"
}
