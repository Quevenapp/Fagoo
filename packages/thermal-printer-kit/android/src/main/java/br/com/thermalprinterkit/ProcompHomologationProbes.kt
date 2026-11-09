package br.com.thermalprinterkit

import java.io.ByteArrayOutputStream

/**
 * A sequência de homologação no dialeto da Diebold Procomp — a família da IM453H.
 *
 * **Por que existe um segundo conjunto, e não uma tradução do primeiro.**
 * [PrinterHomologationProbes] monta bytes crus, sem passar por [ReceiptLayout]: são 24 `GS` e 20
 * `ESC` fixos no código, e as 16 sondas são todas ESC/POS. Não há por onde o dialeto entrar. Numa
 * firmware que não tem **nenhum** comando `GS`, a régua raster do passo de geometria sai como dois
 * metros de código e o aparelho para de responder — medido na IM453H em 24/08/2026, gastando a
 * bobina de verdade. Desde então a homologação **recusava** este dialeto, e a impressora só entrava
 * pela configuração manual, que adota sem medir nada.
 *
 * Este arquivo é o que fecha essa lacuna. Ele não traduz comando por comando: **reemite o mesmo
 * instrumento por outro envelope.** A régua textual, a moldura da régua raster, a trama de meio tom
 * e a régua de avanço vêm, byte a byte, das mesmas funções que a sequência ESC/POS usa — por isso
 * elas viraram `internal` lá em vez de nascerem de novo aqui. Duas cópias da mesma régua mediriam
 * coisas diferentes com o mesmo nome, e o diff estaria no papel, onde ninguém o lê. É o mesmo
 * argumento que fez o raster ter [RasterEmission] em vez de duas composições.
 *
 * **Só emite o que saiu em papel nesta impressora.** Cada byte daqui vem de [ProcompEscP] ou de
 * [ProcompRasterEmitter], e os dois só carregam comando visto impresso na bancada de 23 e
 * 24/08/2026: atributos por `ESC E/F`, `ESC SO/DC4`, `ESC SI/DC2`, `ESC ]`; avanço por `LF`; corte
 * por `ESC w`; raster por `ESC n` em bandas de 24 dotlines. Não há `ESC @`, porque `ESC @` não é
 * comando desta firmware e sai como um `@` no papel — foi assim que se descobriu que o prólogo era
 * nosso.
 *
 * ## Duas etapas da sequência ESC/POS **não** têm tira aqui, e a ausência é a medição
 *
 * * **Código nativo.** `ESC ( k` (QR) e `ESC | 0` (barras) existem no manual da linha e **nunca
 *   saíram em papel**. [ReceiptLayout.nativeCodeAllowed] responde `false` para este dialeto pelo
 *   mesmo motivo, e nesta impressora comando não medido não custa uma tira torta: custa o aparelho
 *   travado, com a tecla de avanço morta e recuperação só no desligar e ligar. A máquina pula a
 *   etapa e grava os dois campos **ausentes**, que é exatamente o que
 *   [PrinterHomologationMachine.skipNativeCodeMeasurement] já significa: ninguém mediu.
 * * **Página de código.** [procompText] codifica em [ProcompCodeTable.ABICOMP], a tabela de fábrica
 *   desta firmware, e **não consulta a página do perfil**. Uma tira de páginas aqui produziria uma
 *   resposta que o emissor descarta — papel gasto para decidir o que ninguém emite, que é a mesma
 *   conta que tirou os ordinais da amostra de acentos. No dia em que [procompText] receber a tabela
 *   do perfil, a tira são duas linhas (a de fábrica e uma com `ESC t 2`, ambas medidas) e o lugar
 *   dela é aqui.
 *
 * ## O corte, que é o que fecha toda tira que corta
 *
 * `ESC w` e `ESC US` cortaram os dois na bancada, e os dois cortaram **parcial**: a guilhotina desta
 * unidade está configurada "Somente Parcial". [procompFinish] escolhe `ESC w` — o corte simples,
 * porque o `ESC US` embute avanço próprio, que brigaria com o avanço do perfil — e é ele que sai no
 * comprovante final e no fim de todo cupom de venda.
 *
 * **Por isso a sonda de corte daqui não oferece escolha de comando.** A sequência ESC/POS manda seis
 * dialetos porque a firmware escolhe qual atende; aqui os dois medidos cortam igual, e o emissor
 * manda `ESC w` de qualquer jeito. Oferecer a escolha seria gastar tira numa decisão que o produto
 * ignora. O que esta sonda mede é o que [procompFinish] realmente lê: **tem guilhotina?** e **quanto
 * avanço a lâmina pede?** — nada além disso é perguntado, e nada que ele lê fica sem medida.
 */
object ProcompHomologationProbes {
    /**
     * O aviso da tira de corte, sem a lista de blocos.
     *
     * O texto da sequência ESC/POS ensina a comparar seis blocos numerados e a anotar o número. Aqui
     * há um bloco só, e mandar anotar número de bloco numa tira que tem um seria ensinar a procurar
     * o que não existe.
     */
    const val CUT_PROBE_INSTRUCTIONS =
        "Nao puxe a tira antes de ver o\n" +
            "que ela fez.\n" +
            "Cortou: a tira se separa (aqui o\n" +
            "corte e parcial, entao ela fica\n" +
            "presa por um pedaco no meio).\n" +
            "Nao cortou: sai rolo inteiro.\n\n"

    /**
     * As duas réguas que abrem a medição, e a única tira que sai antes de qualquer largura escolhida.
     *
     * Mesma tira da sequência ESC/POS: 58 e 80 mm, cada uma com a régua textual e a moldura raster
     * da geometria padrão daquela largura. O que muda é o envelope do raster — `ESC n` com margem
     * zero no lugar do `GS v 0`.
     */
    fun paperWidthRulers(): PrinterProbe =
        probe {
            write(prologue())
            listOf(58, 80).forEach { paperWidthMm ->
                val geometry = MeasuredProfile.geometryDefaults(paperWidthMm)
                write(ascii("${paperWidthMm}mm\n"))
                write(ascii(PrinterHomologationProbes.textRuler(geometry.printableColumns) + "\n"))
                write(ascii("${geometry.printableDots} Dots\n"))
                write(rasterRuler(geometry.printableDots))
                write(ascii("\n"))
            }
            write(tearFeed())
        }

    /**
     * A régua completa: 24 a 64 colunas e 256 a 640 dots.
     *
     * **É esta tira que resolve a pendência mais antiga desta impressora.** Os 576 dots do card são
     * convenção de 80 mm, não medição — está escrito assim em `docs/diebold-im453h.md` desde 23/08 —
     * e as 48 colunas foram confirmadas por uma régua de bancada (`lab.texto.regua`) que vive fora
     * do produto. Aqui as duas passam pela mesma tira que toda outra impressora do kit atravessa.
     *
     * As faixas raster acima da área imprimível saem truncadas de propósito: **é o truncamento que
     * responde**. A largura que a impressora tem é a última que sai com as quatro bordas fechadas.
     */
    fun fullGeometry(): PrinterProbe =
        probe {
            write(prologue())
            write(centeredBold("REGUA TEXTUAL 24 A 64\n"))
            (24..64).forEach { columns ->
                write(ascii(PrinterHomologationProbes.textRuler(columns) + "\n"))
            }
            write(centeredBold("\nREGUA RASTER 256 A 640 DOTS\n"))
            (256..640 step 32).forEach { dots ->
                write(ascii("$dots DOTS\n"))
                write(rasterRuler(dots))
                write(ascii("\n"))
            }
            write(tearFeed())
        }

    /**
     * A tira que mede a compensação vertical: largura cheia, altura declarada, trama de meio tom.
     *
     * A trama, a altura de 384 dotlines e os dois traços de borda são os mesmos da sequência
     * ESC/POS — [PrinterHomologationProbes.throughputRowByte] e
     * [PrinterHomologationProbes.RASTER_THROUGHPUT_STRIP_DOTS] —, porque a régua tem de medir a
     * mesma coisa nas duas famílias para os fatores serem comparáveis.
     *
     * **Nesta impressora ela tem alvo conhecido, e mesmo assim é medição.** A densidade de 23/08 deu
     * ~8,4 dotlines/mm na vertical contra 8 na horizontal, o que aponta para um fator perto de 0,95
     * — anotado e **nunca aplicado**, porque veio de contar dotline em foto e não de régua em papel.
     * O QR e o logotipo desta impressora saem hoje ~5% mais altos que largos por causa disso. Esta
     * tira é o que troca a anotação por medida.
     *
     * **A extrapolação que esta tira carregava caiu em 26/08/2026, e caiu para o lado bom.** Em
     * largura cheia de 80 mm ela leva ~28 KB de raster, o dobro do maior bloco então provado nesta
     * firmware — o cupom com logotipo e QR, de 13,3 KB. A forma dos bytes já era a provada (bandas
     * de 24 dotlines, `n2 = 0`, coladas, `larg = 72`); o total, não. **Saiu inteira, e mediu 47 mm
     * de 48 na régua** — ou seja, a firmware engole os 28 KB sem desistir, e a densidade vertical
     * desta impressora é ~8,17 dotlines/mm, não os ~8,4 que uma contagem em foto tinha sugerido. O
     * perfil fica **sem compensação**, e o fator ~0,95 anotado desde 23/08 nunca precisou existir.
     *
     * A leitura ficou a um milímetro do piso do "saiu inteira" (46,6 mm). Se um dia o QR desta
     * impressora sair visivelmente mais alto que largo, remeça: 46 mm gravariam 0,96, e a diferença
     * entre as duas leituras é a espessura do traço da régua.
     */
    fun rasterThroughput(printableDots: Int): PrinterProbe {
        require(printableDots > 0 && printableDots % 8 == 0) {
            "Largura raster inválida para a sonda de vazão."
        }
        val alturaDots = PrinterHomologationProbes.RASTER_THROUGHPUT_STRIP_DOTS
        val larguraBytes = printableDots / 8
        val pixels = ByteArray(larguraBytes * alturaDots)
        for (y in 0 until alturaDots) {
            pixels.fill(
                PrinterHomologationProbes.throughputRowByte(y),
                y * larguraBytes,
                (y + 1) * larguraBytes,
            )
        }
        return probe {
            write(prologue())
            write(centeredBold("SONDA DE VAZAO\n"))
            write(text(PrinterHomologationProbes.RASTER_THROUGHPUT_INSTRUCTIONS))
            write(raster(PackedRasterSource(printableDots, alturaDots, pixels), leftMarginDots = 0))
            write(tearFeed())
        }
    }

    /**
     * A tira do corte: o rótulo, o avanço que tira o rótulo de baixo da lâmina, e `ESC w`.
     *
     * **O comando é o mesmo que o cupom de venda usa**, e essa identidade é o ponto. Uma sonda que
     * medisse um corte e o produto emitisse outro mediria a impressora errada — foi assim que o
     * dialeto inteiro se perdeu em 23/08, com a sonda falando Procomp e o produto falando ESC/POS.
     * Ver [procompFinish].
     *
     * Nada é impresso depois do corte, pelo mesmo motivo da tira isolada da sequência ESC/POS: um
     * corte parcial deixa a tira pendurada pela aba, e qualquer linha depois dela a empurra até
     * parecer corte total.
     */
    fun isolatedCut(): PrinterProbe =
        probe {
            write(prologue())
            write(boldLine("SONDA DE CORTE\n"))
            write(text(CUT_PROBE_INSTRUCTIONS))
            write(tearFeed())
            write(cutCommand())
        }

    /**
     * A régua do avanço: uma tira por valor medido, cada uma terminando na lâmina.
     *
     * É a distância entre a cabeça e a guilhotina desta unidade, e ela é física — não sai de
     * catálogo nem do avanço 4 que a configuração manual gravou em 24/08 sem medir. As linhas de
     * desperdício vão numeradas e impressas: papel andado em branco não se conta depois, papel
     * andado com número se conta.
     */
    fun cutFeedStrips(): List<CutFeedProbeStrip> =
        MeasuredProfile.CUT_FEED_CHOICES.map { feedLines ->
            CutFeedProbeStrip(
                feedLines = feedLines,
                probe =
                    probe {
                        write(prologue())
                        write(centeredBold(">>> $feedLines <<<\n"))
                        write(text("Escolha o menor avanco que nao cortar texto.\n"))
                        write(centeredBold(">>> $feedLines <<<\n"))
                        write(ascii("---- LINHA DE REFERENCIA ----\n"))
                        write(ascii(PrinterHomologationProbes.feedRuler(feedLines)))
                        write(cutCommand())
                    },
            )
        }

    /** As oito tiras num envio só, como a etapa de avanço pede. */
    fun cutFeed(): PrinterProbe =
        probe {
            cutFeedStrips().forEach { strip ->
                val bytes = strip.probe.bytes()
                try {
                    write(bytes)
                } finally {
                    bytes.fill(0)
                }
            }
        }

    /**
     * O comprovante final, e a **única** sonda desta série montada pelo [ReceiptLayout].
     *
     * As tiras acima medem, então elas emitem cru: um raster de hospedeiro no meio de uma régua
     * desloca justamente o que ela mede. O comprovante não mede nada — é o recibo da instalação
     * concluída —, e por isso ele sai **pelo mesmo caminho do cupom de venda**: o texto pelo
     * [procompText] em ABICOMP, o QR pelo `ESC n` centralizado com a compensação que a régua acabou
     * de medir, e o fecho por [ReceiptLayout.finish], que no dialeto Procomp é [procompFinish] — o
     * avanço medido e o `ESC w`.
     *
     * **É por isso que o corte deste papel prova o corte de toda venda.** Não há um segundo caminho
     * que possa divergir: se este comprovante saiu cortado, o cupom de amanhã sai cortado pelos
     * mesmos bytes.
     *
     * As três linhas que a certidão diz diferente da folha ESC/POS estão em [profileLines], e cada
     * uma delas existe para o papel não afirmar medição que ninguém fez nesta impressora.
     */
    fun finalReceipt(
        profile: MeasuredProfile,
        identity: PrinterDeclaredIdentity? = null,
        transport: PrinterTransport? = null,
        decoration: ReceiptDecoration? = null,
    ): PrinterProbe {
        require(profile.source == PrinterProfileSource.MEASURED) {
            "O comprovante final exige uma medição concluída."
        }
        require(profile.dialect == EscPosDialect.PROCOMP_ESC_P) {
            "Este comprovante é do dialeto Procomp."
        }
        val layout = ReceiptLayout.from(profile.toDriverProfile(), decoration)
        return probe {
            write(EscPosDialectGate.prologue(layout.dialect))
            decoration?.header(layout)?.let { cabecalho ->
                try {
                    write(cabecalho)
                } finally {
                    // Pode ser raster de logotipo; cópia viva no heap é o que `clear()` evita.
                    cabecalho.fill(0)
                }
            }
            write(
                layout.text(
                    "Instalação concluída\n",
                    ThermalTextAlignment.CENTER,
                    ThermalTextStyle.BOLD,
                    ThermalTextSize.NORMAL,
                ),
            )
            write(
                layout.text(
                    layout.wrap(profileLines(profile, identity, transport)) + "\n\n",
                    ThermalTextAlignment.LEFT,
                    ThermalTextStyle.NORMAL,
                    ThermalTextSize.NORMAL,
                ),
            )
            write(
                requireNotNull(layout.qrRaster(PrinterHomologationProbes.FINAL_RECEIPT_QR)) {
                    "Geometria insegura para o QR raster final."
                },
            )
            write('\n'.code)
            // O corte. Ver o cabeçalho desta função.
            write(layout.finish())
        }
    }

    /**
     * O corpo da certidão. Três linhas divergem da folha ESC/POS, e as três dizem a mesma coisa:
     * **o campo existe no formato comum e não foi medido nesta impressora.**
     *
     * * **`Corte:`** não sai como `GS_V_1`. O perfil guarda esse valor porque
     *   [MeasuredProfile.hasCutter] exige um protocolo diferente de `NONE` e o enum inteiro é
     *   ESC/POS — mas **nenhum byte `GS` chega a esta impressora**, e [procompFinish] emite `ESC w`
     *   sem consultar o campo. Imprimir o nome do enum aqui faria alguém transcrever para um
     *   cadastro, um mês depois, uma medição que nunca houve. A folha diz o comando que saiu.
     * * **`Tabela:`** no lugar de `Página:` e `Codificação:`. Não há `ESC t` neste caminho: o texto
     *   sai em ABICOMP, tabela de fábrica desta firmware, provada em papel em 23/08/2026. As duas
     *   linhas da folha ESC/POS descrevem uma escolha que este dialeto não faz.
     * * **`Identidade GS I:`** diz **não perguntada**, e não "não respondeu". `GS I` é comando `GS`,
     *   e este dialeto não recebe nenhum: [PrinterHomologationTarget.readIdentity] nem chega a
     *   perguntar. "Não respondeu" afirmaria uma pergunta que ninguém fez.
     *
     * O resto — largura, conexão, compensação, códigos nativos, família de Wi-Fi, carimbo de data e
     * a linha de acentos — sai pelas mesmas funções da folha ESC/POS, para as duas certidões
     * continuarem transcritíveis pelo mesmo par de olhos.
     */
    internal fun profileLines(
        profile: MeasuredProfile,
        identity: PrinterDeclaredIdentity?,
        transport: PrinterTransport?,
    ): String =
        profile.displayName + "\n" +
            "${profile.paperWidthMm} mm | ${profile.printableColumns} colunas | " +
            "${profile.printableDots} dots\n" +
            transport?.let {
                "Conexão: ${when (it) {
                    PrinterTransport.USB -> "USB"
                    PrinterTransport.BLUETOOTH, PrinterTransport.BLUETOOTH_LE -> "Bluetooth"
                    PrinterTransport.LOCAL_WIFI -> "Rede / Wi-Fi"
                }}\n"
            }.orEmpty() +
            "Tabela: ABICOMP (fábrica)\n" +
            cutLine(profile) +
            PrinterHomologationProbes.verticalRasterScaleLine(profile.verticalRasterScale) +
            PrinterHomologationProbes.nativeQrLine(profile.nativeQrHonored) +
            PrinterHomologationProbes.nativeBarcodeLine(profile.nativeBarcodeHonored) +
            PrinterHomologationProbes.wifiConfigurationFamilyLine(profile.wifiConfigurationFamily) +
            "Medida em: ${PrinterHomologationProbes.localTimestamp(profile.measuredAtEpochMillis)}\n" +
            (identity?.let { PrinterHomologationProbes.identityLines(it) } ?: "$IDENTITY_UNASKED\n") +
            "Acentos: ação, opção, São João\n" +
            PrinterHomologationProbes.CODE_PAGE_SAMPLE

    /** O comando que sai, e o avanço que a régua mediu. Ver [profileLines]. */
    private fun cutLine(profile: MeasuredProfile): String =
        if (profile.hasCutter) {
            "Corte: ESC w (parcial) | avanço ${profile.cutFeedLines}\n"
        } else {
            "Corte: sem guilhotina\n"
        }

    internal const val IDENTITY_UNASKED = "Identidade GS I: não perguntada"

    /**
     * A moldura da régua, com os mesmos pixels da sequência ESC/POS e o envelope desta firmware.
     *
     * Margem zero: a régua mede onde o papel acaba, então ela precisa começar na primeira coluna
     * imprimível. Centralizar aqui moveria a borda esquerda e a régua mediria a margem.
     */
    private fun rasterRuler(widthDots: Int): ByteArray {
        val pixels = PrinterHomologationProbes.rasterRulerPixels(widthDots)
        return raster(
            PackedRasterSource(
                widthDots,
                PrinterHomologationProbes.RASTER_HEIGHT_DOTS,
                pixels,
            ),
            leftMarginDots = 0,
        )
    }

    private fun raster(
        source: PackedRasterSource,
        leftMarginDots: Int,
    ): ByteArray =
        try {
            // Sem compensação vertical: a tira **é** o instrumento que a mede. Compensar aqui
            // esticaria a régua pelo fator que ela deveria descobrir, e ela sempre confirmaria o
            // fator que já estivesse gravado.
            ProcompRasterEmitter.emit(source, leftMarginDots, verticalRasterScale = null)
        } finally {
            source.clear()
        }

    private fun prologue(): ByteArray = EscPosDialectGate.prologue(EscPosDialect.PROCOMP_ESC_P)

    private fun cutCommand(): ByteArray = ProcompEscP.cut(ProcompCutCommand.ESC_W)

    /**
     * O avanço que entrega a tira do lado de fora da serrilha.
     *
     * Mesmo número da sequência ESC/POS — 12 linhas —, e pela mesma razão: é a distância entre a
     * cabeça e a barra em toda impressora que o kit já suportou. Nesta ele ainda não foi medido, e
     * quem o mede é a régua de avanço; até lá vale o lado seguro, que é papel a mais.
     */
    private fun tearFeed(): ByteArray =
        ProcompEscP.feed(PrinterHomologationProbes.PROBE_TEAR_FEED_LINES)

    /** Texto corrido, à esquerda e sem atributo: o corpo das instruções de toda tira. */
    private fun text(value: String): ByteArray =
        procompText(
            value,
            ThermalTextAlignment.LEFT,
            ThermalTextStyle.NORMAL,
            ThermalTextSize.NORMAL,
            ProcompEscP.MEASURED_RECEIPT_COLUMNS,
        )

    private fun boldLine(value: String): ByteArray =
        procompText(
            value,
            ThermalTextAlignment.LEFT,
            ThermalTextStyle.BOLD,
            ThermalTextSize.NORMAL,
            ProcompEscP.MEASURED_RECEIPT_COLUMNS,
        )

    private fun centeredBold(value: String): ByteArray =
        procompText(
            value,
            ThermalTextAlignment.CENTER,
            ThermalTextStyle.BOLD,
            ThermalTextSize.NORMAL,
            ProcompEscP.MEASURED_RECEIPT_COLUMNS,
        )

    /**
     * Régua e rótulo de régua saem **sem preenchimento**, e isso não é economia.
     *
     * [procompText] centraliza por espaços, porque não existe `ESC a` nesta firmware. Numa régua
     * isso seria fatal: o espaço à esquerda desloca a barra e ela passa a medir a margem em vez da
     * largura. Aqui o texto vai pelo encoder da tabela e mais nada.
     */
    private fun ascii(value: String): ByteArray =
        ProcompEscP.encode(value, ProcompCodeTable.ABICOMP)

    private fun probe(block: ByteArrayOutputStream.() -> Unit): PrinterProbe =
        ByteArrayOutputStream().use { output ->
            output.block()
            PrinterProbe(output.toByteArray(), EscPosDialect.PROCOMP_ESC_P)
        }
}

/**
 * Pixels já empacotados vistos como fonte de faixas.
 *
 * As réguas e a trama de meio tom nascem empacotadas — MSB primeiro, byte da esquerda para a
 * direita —, que é a mesma convenção que [OneBitRasterSource] pede e a mesma que a IM453H mediu em
 * 23/08/2026. Não há conversão aqui: só o recorte da faixa que o emissor pede por vez.
 */
private class PackedRasterSource(
    override val widthDots: Int,
    override val heightDots: Int,
    private val rows: ByteArray,
) : OneBitRasterSource {
    private val widthBytes = widthDots / 8

    init {
        require(widthDots > 0 && widthDots % 8 == 0) { "Largura raster inválida." }
        require(heightDots > 0) { "Altura raster inválida." }
        require(rows.size == widthBytes * heightDots) { "Buffer de raster empacotado inválido." }
    }

    override fun readStripe(
        startY: Int,
        stripeHeight: Int,
        destination: ByteArray,
    ) {
        require(startY >= 0 && stripeHeight > 0 && startY + stripeHeight <= heightDots) {
            "Faixa raster fora da fonte."
        }
        require(destination.size == widthBytes * stripeHeight) { "Buffer de faixa raster inválido." }
        rows.copyInto(
            destination,
            destinationOffset = 0,
            startIndex = startY * widthBytes,
            endIndex = (startY + stripeHeight) * widthBytes,
        )
    }

    fun clear() = rows.fill(0)
}
