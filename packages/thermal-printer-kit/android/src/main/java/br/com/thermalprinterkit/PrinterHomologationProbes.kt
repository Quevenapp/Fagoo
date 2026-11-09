package br.com.thermalprinterkit

import java.io.ByteArrayOutputStream
import java.nio.charset.StandardCharsets
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * Bytes imutáveis de uma sonda; cada envio recebe uma cópia independente.
 *
 * **A sonda carrega o dialeto em que foi montada, e isso é o cinto de segurança.** Antes, o portão
 * do envio olhava só o alvo: "esta impressora fala ESC/POS?". Ele acertava por acaso, porque só
 * existia um conjunto de sondas. Com dois conjuntos, a pergunta certa é outra — **estes bytes
 * falam a língua desta impressora?** — e ela só é respondível se os bytes souberem de onde vieram.
 *
 * Sem este campo, a sequência Procomp recém-escrita seria recusada pelo mesmo portão que existe
 * para protegê-la, e a de ESC/POS voltaria a poder alcançar a IM453H se alguém trocasse o portão
 * de lugar. Ver [PrinterProbeSession.send].
 */
class PrinterProbe internal constructor(
    bytes: ByteArray,
    val dialect: EscPosDialect,
) {
    private val content = bytes.copyOf()

    val size: Int
        get() = content.size

    fun bytes(): ByteArray = content.copyOf()

    override fun toString(): String = "PrinterProbe(size=$size, dialect=$dialect)"
}

/**
 * Uma linha da tira de página, e a decisão de perfil inteira que escolhê-la grava.
 *
 * [label] é vocabulário da bancada — `sem acentos`, `CP850`, `n=08` — e **não vai ao papel nem à
 * tela**. Quem está com a tira na mão responde por letra; o código só aparece no comprovante
 * final, onde serve ao catálogo.
 *
 * A tira mede modelo de codificação **e** página na mesma pergunta: a etapa separada que perguntava
 * "byte único ou UTF-8?" saiu em 12/08, porque ninguém com o papel na mão responde isso — responde
 * qual linha saiu legível.
 */
class CodePageProbeCandidate internal constructor(
    val letter: Char,
    val label: String,
    val textEncoding: ThermalTextEncoding,
    val codePage: ThermalCodePage?,
    val escT: Int?,
    val isAddress: Boolean,
) {
    /** A linha que sai sem `ESC t` nenhum, na tabela que a firmware já ligou sozinha. */
    val isFirmwareDefault: Boolean
        get() = textEncoding == ThermalTextEncoding.FIRMWARE_DEFAULT_PAGE

    override fun toString(): String = "CodePageProbeCandidate(letter=$letter, label=$label)"
}

class CutProtocolProbeCandidate internal constructor(
    val protocol: CutProtocol,
    val number: Int,
    val label: String,
    private val command: ByteArray?,
) {
    fun commandBytes(): ByteArray? = command?.copyOf()

    override fun toString(): String = "CutProtocolProbeCandidate(protocol=$protocol, number=$number)"
}

data class CutFeedProbeStrip(
    val feedLines: Int,
    val probe: PrinterProbe,
)

/**
 * O custo em papel da homologação inteira, contado das sondas em vez de escrito à mão na tela.
 *
 * Tira aqui é pedaço de papel na mão de quem mede, não envio: a sonda de corte manda um dialeto por
 * vez e a régua de avanço sai num envio só, mas cada corte produz um pedaço, e é pedaço que a
 * pessoa conta antes de dizer se paga.
 *
 * A conta mora ao lado das sondas porque quem sabe quantas tiras saem é a sequência delas. Escrita
 * à mão nas telas ela divergiu: em 20/08 o Android anunciava "de 4 a 17" e o iOS "de 4 a 7" — o
 * literal do iOS ficou parado em 12/08, quando os seis dialetos de corte e a régua de oito avanços
 * entraram, e **nenhum dos dois** contava a tira das réguas de largura, que abre toda medição e já
 * era contada no piso. Etapa nova que gaste papel acrescenta a parcela aqui, e as duas telas
 * mudam junto.
 */
object PrinterHomologationPaperCost {
    /** As réguas de 58 e 80 mm saem juntas, numa tira só, e abrem toda homologação. */
    const val WIDTH_RULERS = 1

    /** A régua completa de 24 a 64 colunas: só quem responde "Nenhum" à comparação a paga. */
    const val FULL_GEOMETRY = 1

    /** Uma tira de meio tom em largura cheia, em toda impressora: encolhimento não se adivinha. */
    const val RASTER_THROUGHPUT = 1

    /**
     * Uma tira com o QR e o código de barras nativos, em toda impressora: firmware não se adivinha.
     *
     * Entra no **piso**, e não só no teto, pelo mesmo argumento da tira de vazão: ela sai em toda
     * medição. Tira opcional foi descartada porque não existe caminho de remedição parcial — quem
     * pulasse pagaria a homologação inteira depois.
     */
    const val NATIVE_CODE = 1

    /** Uma tira só, com todas as candidatas de texto — a etapa separada saiu em 12/08. */
    const val CODE_PAGE = 1

    /** O comprovante final, que é a certidão transcrita da medição. */
    const val FINAL_RECEIPT = 1

    /** Um dialeto por tira: comparar corte exige as tiras lado a lado. */
    val cutProtocolStrips: Int
        get() = PrinterHomologationProbes.cutProtocolCandidates.count { it.commandBytes() != null }

    /** A régua inteira do avanço, um corte por valor medido. */
    val cutFeedStrips: Int
        get() = MeasuredProfile.CUT_FEED_CHOICES.size

    /** Sem guilhotina: largura, vazão, código nativo, texto e comprovante final. */
    val minimumStrips: Int
        get() = WIDTH_RULERS + RASTER_THROUGHPUT + NATIVE_CODE + CODE_PAGE + FINAL_RECEIPT

    /** Com guilhotina, régua de avanço inteira e a régua completa de geometria. */
    val maximumStrips: Int
        get() = minimumStrips + FULL_GEOMETRY + cutProtocolStrips + cutFeedStrips

    /**
     * O mesmo piso, contado pela série que **este dialeto** recebe.
     *
     * As duas propriedades acima continuam sendo a conta da série ESC/POS, byte a byte como antes, e
     * é essa conta que as suítes do iOS e do Mac fixam. Estas duas funções existem porque uma série
     * pode não ter uma etapa inteira — a Procomp não tem tira de código nativo nem tira de página —,
     * e anunciar tira que não vai sair é a mesma divergência de tela que tirou a conta da UI em
     * 20/08, só que ao contrário. Ver [PrinterHomologationProbeSet].
     */
    fun minimumStrips(dialect: EscPosDialect): Int =
        printerHomologationProbeSet(dialect).minimumStrips

    /** O teto da série deste dialeto. Ver [minimumStrips]. */
    fun maximumStrips(dialect: EscPosDialect): Int =
        printerHomologationProbeSet(dialect).maximumStrips
}

/**
 * Sondas puras de produção. Nenhuma usa cronômetro, endpoint ou o comando QR nativo ESC/POS.
 */
object PrinterHomologationProbes {
    const val TEXT_ENCODING_SAMPLE = "café, açúcar, três"

    // Estes acentos ocupam os mesmos bytes em CP437, CP850, CP858 e CP860. A sonda ainda não sabe
    // o endereço de `ESC t` — e a T210 provou que o endereço canônico pode estar errado —, então
    // usa a página padrão após `ESC @` e não seleciona uma tabela em nome da impressora.
    /**
     * Os **cinco bytes que distinguem**, sem `ESC t`: `84 87 94 A0 88`.
     *
     * A amostra anterior era `café, açúcar, três`, montada com bytes comuns a CP437, CP850, CP858 e
     * CP860 — e por isso **cega**: `é ç ú ê` têm o mesmo desenho nas quatro. Ela saía "certa" em
     * qualquer uma das quatro, e "certa" ali não significava nada.
     *
     * A conclusão que se tirou disso em 10/08 — "a tabela padrão da T210 é CP437" — também era da
     * cegueira, e caiu em 12/08: com a impressora **desligada da tomada** e a amostra completa, a
     * linha sem `ESC t` saiu inteira, maiúsculas inclusive. O que a T210 tem de torto é o
     * **endereço**: `ESC t 3` leva a outra tabela, e a CP860 responde em `n=08`.
     *
     * Nestas cinco posições as tabelas discordam onde o português precisa: em CP860 saem
     * `ã ç õ á ê`; em CP437 saem `ä ç ö á ê`. O til é o que separa as duas, e é o que a bancada
     * viu no papel da T210.
     */
    private val TEXT_ENCODING_SINGLE_BYTE_SAMPLE =
        intArrayOf(0x84, 0x87, 0x94, 0xA0, 0x88).map(Int::toByte).toByteArray()

    /**
     * O inventário de acentos da tira de página — **minúsculas e maiúsculas**.
     *
     * A frase `cão, ações, avô, você, água` media só a metade baixa da tabela. Medido no papel da
     * T210 em 12/08: com o endereço que a frase aprovou, `ação` saiu perfeito e `HOMOLOGAÇÃO
     * CONCLUÍDA` saiu `HOMOLOGACÃO CONCLUrDA` — a mesma tabela acerta embaixo e erra em cima, e o
     * `Ç` em `0x80` nunca tinha sido medido em endereço nenhum.
     *
     * A ordem agrupa cada vogal com os acentos dela e espelha minúscula e maiúscula: errado não
     * aparece como palavra torta, aparece como quebra no ritmo — `à ã á â` viram símbolo ou caixa,
     * e a linha inteira deixa de parecer letra.
     *
     * **Só o que a língua usa e o kit imprime.** `ü Ü` entraram e saíram no mesmo dia: o trema caiu
     * do português em 2009 e sobrevive em nome próprio, que não é o que esta bancada mede. `ª º`
     * entraram por especulação — "1ª via", "nº" — e saíram porque **nada no kit nem no app imprime
     * ordinal**; medir o que ninguém imprime é gastar papel e leitura à toa. No papel eles ainda
     * cobravam: a dobra ASCII não os representa, e a linha `a` terminava em `? ?`. Se um dia uma
     * comanda precisar de ordinal, a amostra cresce naquele dia, com o motivo junto.
     */
    const val CODE_PAGE_SAMPLE =
        "à ã á â é ê í ó ô õ ú À Ã Á Â É Ê Í Ó Ô Õ Ú ç Ç"

    /**
     * Único texto de instrução da tira, quebrado à mão para caber em 32 colunas.
     *
     * Sai em ASCII e sem `ESC t`: a página ainda não foi medida, então a instrução não pode
     * depender dela. Nenhum código técnico entra aqui — a resposta é uma letra.
     *
     * A ressalva sobre a linha `a` não é enfeite. Ela é a frase **sem acento nenhum**, e é a única
     * que sai legível em qualquer firmware: sem o aviso, "escolha a linha legível" faria todo mundo
     * parar nela e gravar um perfil que nunca acentua.
     */
    const val CODE_PAGE_INSTRUCTIONS =
        "Escolha a letra da linha em\n" +
            "que TODOS os acentos sairam,\n" +
            "maiusculas tambem.\n" +
            "A linha a) e sem acento:\n" +
            "escolha ela so se nenhuma\n" +
            "outra sair certa.\n\n"

    /**
     * A MP-4200 e a i9 fazem corte parcial; se o bloco do parcial saiu solto, quem falhou foi a
     * medição, não a guilhotina. A sonda não pode induzir a conclusão contrária: ela mede qual
     * comando a impressora obedece e o papel só descreve as duas formas, sem mandar desistir do
     * parcial. O aviso de não puxar vem primeiro porque a aba de um corte parcial rasga na mão
     * igual a picote e a tira passa a parecer corte total.
     */
    const val CUT_PROBE_INSTRUCTIONS =
        "Nao puxe as tiras antes de ver\n" +
            "todas.\n" +
            "Corte total: a tira sai solta.\n" +
            "Corte parcial: a tira fica presa\n" +
            "por um pedaco no meio.\n" +
            "Cada bloco tenta um comando\n" +
            "diferente. Anote o numero do\n" +
            "bloco que deu o corte que voce\n" +
            "quer usar.\n" +
            "Nenhum cortou = rolo inteiro.\n" +
            "O que voce escolher fica salvo e\n" +
            "passa a ser o corte de toda venda.\n\n"

    /**
     * O aviso diz o que vai sair e para quê, e não pede permissão.
     *
     * "Confirme que a bancada está pronta" pedia um compromisso sem dizer o que ia acontecer. Oito
     * tiras é o preço de medir a distância entre a cabeça e a lâmina desta impressora, e quem não
     * quiser pagá-lo agora pula — com o número que sai do palpite da bancada, e sabendo disso.
     */
    const val CUT_FEED_BENCH_WARNING =
        "Vamos imprimir 8 tiras para você escolher o espaçamento."

    /**
     * Resolução das cabeças que este kit homologa: 203 dpi, que arredonda para 8 dots por
     * milímetro. Não é palpite — a bancada de 20/08 mediu 120 dots em 15,0 mm no papel da T210.
     */
    const val RASTER_DOTS_PER_MM = 8

    /** Espessura do traço cheio em cada ponta da tira de vazão: 1 mm, para a régua ter borda. */
    private const val RASTER_THROUGHPUT_RULE_DOTS = RASTER_DOTS_PER_MM

    /**
     * Altura da tira de vazão, em dots. **384**, e o número tem três razões.
     *
     * - É múltiplo de 24, a faixa que [EscPosRasterEmitter] usa para toda foto de venda. A tira sai
     *   com a mesma forma de bytes que a foto que falha; se ela usasse outra banda, mediria outra
     *   coisa.
     * - A 203 dpi dá 48,0 mm de papel — a bancada mediu 120 dots em 15,0 mm, que é a mesma conta de
     *   8 dots por milímetro. 48 mm é comprimento que se lê numa régua comum: o defeito de 22%
     *   encurta a tira em mais de um centímetro, à vista.
     * - É o maior múltiplo de 24 dentro da faixa de 300 a 400 dots. Quanto mais alta a tira, menos
     *   pesa o erro de leitura de ±1 mm, e mais bytes atravessam o buffer da impressora antes do
     *   fim — que é justamente o que precisa acontecer para o descarte de linha aparecer.
     */
    const val RASTER_THROUGHPUT_STRIP_DOTS = 384

    /**
     * O que a tira deve medir na régua quando nada é descartado: 384 dots a 8 dots/mm.
     *
     * Este número **não vai à tira**. Nas outras tiras o número impresso é a identidade da régua
     * — "384 DOTS" nomeia a faixa —, aqui ele seria a resposta da pergunta, e quem lê a resposta
     * antes de medir mede menos.
     *
     * Nos **comprovantes** ele aparece, e a proibição não vale lá: em `Vazão: 38/48 mm` a medição
     * já aconteceu, e sem o denominador "38 mm" não diz se a tira encolheu ou se ela é curta. Ver
     * [verticalRasterScaleLine].
     */
    const val RASTER_THROUGHPUT_STRIP_MM = RASTER_THROUGHPUT_STRIP_DOTS / RASTER_DOTS_PER_MM

    /**
     * Instrução da tira de vazão. ASCII e sem código técnico, como as outras.
     *
     * Não diz quanto a tira deveria medir, de propósito. Ver [RASTER_THROUGHPUT_STRIP_MM].
     */
    const val RASTER_THROUGHPUT_INSTRUCTIONS =
        "Meca a altura do bloco, do traco\n" +
            "de cima ao traco de baixo.\n"

    /**
     * A tira que mede vazão: largura cheia, altura conhecida, trama de meio tom.
     *
     * **O que ela mede.** A firmware da T210 descarta linhas inteiras quando os bytes chegam mais
     * rápido do que a cabeça imprime, e a imagem sai coerente, só menor. Nada no enlace denuncia
     * isso: o ACK do ATT prova recepção no rádio, não papel. O único instrumento honesto é uma
     * altura declarada saindo do outro lado para ser medida com régua.
     *
     * **Por que não é preto sólido.** Os bytes na linha são os mesmos com qualquer padrão — raster
     * `GS v 0` não comprime —, então o preto cheio não acrescentaria um byte à medição e cobraria a
     * cabeça inteira de uma vez. Cabeça castigada aciona proteção térmica, que também encurta a
     * saída e por outro motivo: a medida sairia contaminada por um segundo fenômeno. O xadrez de um
     * dot dá exatamente 50% de cobertura, nunca dispara dois elementos vizinhos na mesma linha e é
     * o que um meio-tom de foto realmente vira no papel.
     *
     * **Os dois traços cheios** de 1 mm nas pontas existem para a régua ter borda: uma trama a 50%
     * some contra o papel na primeira e na última linha, e sem borda não há o que medir. Se o
     * descarte comer parte de um traço, o erro cabe no ±1 mm que a margem de segurança já cobre.
     *
     * As faixas saem com a altura de [EscPosRasterEmitter.RASTER_STRIPE_HEIGHT_DOTS], a mesma de
     * toda foto de venda: a tira é a foto, sem ser foto de ninguém. Sem alinhamento e sem
     * decoração — é instrumento de medida.
     */
    fun rasterThroughput(printableDots: Int): PrinterProbe {
        require(printableDots > 0 && printableDots % 8 == 0) {
            "Largura raster inválida para a sonda de vazão."
        }
        val widthBytes = printableDots / 8
        return probe {
            write(EscPosThermalCommands.initialize())
            write(text("SONDA DE VAZAO\n", ThermalTextAlignment.CENTER, ThermalTextStyle.BOLD, 0))
            write(
                text(
                    RASTER_THROUGHPUT_INSTRUCTIONS,
                    ThermalTextAlignment.LEFT,
                    ThermalTextStyle.NORMAL,
                    0,
                ),
            )
            var startY = 0
            while (startY < RASTER_THROUGHPUT_STRIP_DOTS) {
                val stripeHeight =
                    minOf(
                        EscPosRasterEmitter.RASTER_STRIPE_HEIGHT_DOTS,
                        RASTER_THROUGHPUT_STRIP_DOTS - startY,
                    )
                val pixels = ByteArray(widthBytes * stripeHeight)
                try {
                    for (row in 0 until stripeHeight) {
                        pixels.fill(
                            throughputRowByte(startY + row),
                            row * widthBytes,
                            (row + 1) * widthBytes,
                        )
                    }
                    write(GS.toInt())
                    write(RASTER_IMAGE.toInt())
                    write(RASTER_FUNCTION.toInt())
                    write(RASTER_MODE_NORMAL.toInt())
                    write(widthBytes and 0xFF)
                    write(widthBytes shr 8 and 0xFF)
                    write(stripeHeight and 0xFF)
                    write(stripeHeight shr 8 and 0xFF)
                    write(pixels)
                } finally {
                    pixels.fill(0)
                }
                startY += stripeHeight
            }
            write(requireNotNull(EscPosThermalCommands.advance(PROBE_TEAR_FEED_LINES)))
        }
    }

    /**
     * Traço cheio nas duas pontas; xadrez de um dot no meio, alternando a fase por linha.
     *
     * `internal` porque a régua é o **instrumento**, e instrumento não se duplica por dialeto: a
     * tira Procomp mede a mesma trama, com a mesma altura, trocando só o envelope do raster. Duas
     * cópias da mesma conta divergiriam no papel, que é onde ninguém lê o diff — é o mesmo
     * argumento de [RasterEmission].
     */
    internal fun throughputRowByte(y: Int): Byte =
        when {
            y < RASTER_THROUGHPUT_RULE_DOTS ||
                y >= RASTER_THROUGHPUT_STRIP_DOTS - RASTER_THROUGHPUT_RULE_DOTS -> 0xFF.toByte()
            y % 2 == 0 -> 0xAA.toByte()
            else -> 0x55.toByte()
        }

    /**
     * O conteúdo dos dois códigos da sonda, e a palavra que a tira ensina a procurar.
     *
     * **Não é dado sensível, e essa é a exigência de projeto.** O caso de falha desta sonda é o
     * payload sair impresso como texto legível — é exatamente isso que a pergunta distingue —,
     * então aqui não entra assinatura, identificador de perfil, endereço, URL nem nada real.
     *
     * **É a mesma palavra nos dois blocos, e é a mesma que o rodapé cita.** Quem lê o papel não
     * precisa julgar "isso é um código?": precisa reconhecer uma palavra que a própria tira acabou
     * de ensinar. Dois conteúdos diferentes só dariam duas coisas para procurar sem mudar resposta
     * nenhuma — os blocos já se distinguem pelos rótulos `1)` e `2)`.
     *
     * **Cinco caracteres, e o número tem conta.** No Code 128 um conteúdo de `n` caracteres ocupa
     * `11n + 35` módulos, mais as duas zonas de silêncio de 10 módulos que a norma exige: `SONDA`
     * dá `90 + 20 = 110`. Na geometria mais estreita que este kit homologa — 256 pontos — isso cabe
     * com a largura de módulo mínima confiável, 2 pontos: `220 <= 256`. Um conteúdo mais comprido
     * não caberia lá, e "não coube" sairia truncado, indistinguível de "a firmware não entendeu",
     * que é a única coisa que esta tira existe para medir.
     */
    const val NATIVE_CODE_PAYLOAD = "SONDA"

    /**
     * Correção de erro do QR da sonda, a mesma que o layout usa no cupom.
     *
     * A tira mede se a firmware desenha, e tem de medir o comando que o app vai mesmo mandar: outro
     * nível aqui produziria um símbolo de outro tamanho e mediria um `GS ( k` que ninguém emite.
     */
    private const val NATIVE_CODE_QR_ERROR_CORRECTION = ReceiptLayout.DEFAULT_QR_ERROR_CORRECTION

    /**
     * Instrução da tira de código nativo. ASCII e sem código técnico, como as outras.
     *
     * A pergunta que a tela faz é "saiu um código ou saíram letras?", e o papel precisa preparar
     * essa leitura sem usar vocabulário nosso: nada de `GS ( k`, nada de "nativo" antes da hora.
     */
    const val NATIVE_CODE_INSTRUCTIONS =
        "Duas figuras saem abaixo. Diga o\n" +
            "que voce viu em cada uma.\n\n"

    /**
     * O rodapé, que nomeia o defeito antes de ele acontecer.
     *
     * Sem ele, "saiu um código?" pede um julgamento estético de quem talvez nunca tenha visto um QR
     * de perto. Com ele, a pergunta vira reconhecimento: ou saiu figura, ou saiu a palavra que está
     * escrita aqui. "Não saiu nada" vai junto de "saiu texto" porque as duas significam a mesma
     * coisa para o perfil — o comando não produziu código.
     */
    const val NATIVE_CODE_FOOTER =
        "\nSe no lugar da figura sair a\n" +
            "palavra $NATIVE_CODE_PAYLOAD em letras, ou nao\n" +
            "sair nada, a impressora nao\n" +
            "entende o comando.\n"

    /**
     * A tira que mede se a firmware honra `GS ( k` e `GS k`.
     *
     * **O que ela mede, e o que não mede.** Ela mede se a firmware **desenha**. Não mede
     * legibilidade: ninguém lê o código com câmera, o app não pede câmera e não vai pedir. Um
     * código que sai desenhado e ilegível por um leitor de verdade é assunto de bancada, e está
     * anotado como tal.
     *
     * **Dois blocos, dois comandos, duas respostas.** `GS ( k` e `GS k` são comandos de gerações
     * diferentes e nada obriga uma firmware a atender os dois; medir junto e gravar um número só
     * seria decidir por medição que não existe.
     *
     * **HRI desligada.** Com a legenda ligada, um código de barras correto sai com letras embaixo —
     * e a pergunta é justamente "saiu figura ou saíram letras". A legenda destruiria a única coisa
     * que a sonda mede.
     *
     * **As larguras são medidas, não escolhidas.** A largura de módulo sai da área imprimível pela
     * mesma régua do cupom ([ThermalBarcode.moduleWidthDots] e a divisão por módulos do QR): é essa
     * dependência que põe esta etapa depois da geometria. Um símbolo mais largo que o papel sairia
     * truncado, e truncamento é indistinguível de "a firmware não entendeu".
     *
     * **Nada aqui grava memória não volátil.** É `GS k` e `GS ( k`, não `GS ( E` nem `FS q`: não há
     * a exposição que faz o comando cru exigir confirmação de risco. E `ESC @` sai uma vez só, no
     * começo: o nativo é estado, e estado deixado ligado desalinharia a tira seguinte — por isso os
     * dois emissores devolvem o alinhamento à esquerda no fim.
     */
    fun nativeCode(printableDots: Int): PrinterProbe {
        require(printableDots > 0 && printableDots % 8 == 0) {
            "Largura raster inválida para a sonda de código nativo."
        }
        val moduleWidthDots =
            requireNotNull(
                ThermalBarcode.moduleWidthDots(
                    NATIVE_CODE_PAYLOAD,
                    ThermalBarcodeSymbology.CODE_128,
                    printableDots,
                ),
            ) { "Área imprimível abaixo do mínimo para o código de barras da sonda." }
        val qrModuleSide =
            requireNotNull(
                EscPosThermalCommands.qrModuleSide(
                    NATIVE_CODE_PAYLOAD,
                    NATIVE_CODE_QR_ERROR_CORRECTION,
                ),
            ) { "O conteúdo da sonda não vira símbolo QR." }
        return probe {
            write(EscPosThermalCommands.initialize())
            write(text("SONDA DE CODIGO NATIVO\n", ThermalTextAlignment.CENTER, ThermalTextStyle.BOLD, 0))
            write(text(NATIVE_CODE_INSTRUCTIONS, ThermalTextAlignment.LEFT, ThermalTextStyle.NORMAL, 0))
            write(text("1)\n", ThermalTextAlignment.LEFT, ThermalTextStyle.BOLD, 0))
            write(
                requireNotNull(
                    EscPosThermalCommands.qrNative(
                        value = NATIVE_CODE_PAYLOAD,
                        moduleSizeDots = nativeQrModuleSizeDots(printableDots, qrModuleSide),
                        errorCorrection = NATIVE_CODE_QR_ERROR_CORRECTION,
                    ),
                ) { "Geometria insegura para o QR nativo da sonda." },
            )
            write('\n'.code)
            write(text("2)\n", ThermalTextAlignment.LEFT, ThermalTextStyle.BOLD, 0))
            write(
                requireNotNull(
                    EscPosThermalCommands.barcodeNative(
                        value = NATIVE_CODE_PAYLOAD,
                        symbology = ThermalBarcodeSymbology.CODE_128,
                        moduleWidthDots = moduleWidthDots,
                        heightDots = ThermalBarcode.DEFAULT_HEIGHT_DOTS,
                        // A legenda sairia como letras embaixo de um código correto, e a pergunta
                        // desta sonda é exatamente "saiu figura ou saíram letras".
                        humanReadable = false,
                    ),
                ) { "Geometria insegura para o código de barras nativo da sonda." },
            )
            write('\n'.code)
            write(text(NATIVE_CODE_FOOTER, ThermalTextAlignment.LEFT, ThermalTextStyle.NORMAL, 0))
            write(requireNotNull(EscPosThermalCommands.advance(PROBE_TEAR_FEED_LINES)))
        }
    }

    /**
     * Tamanho de módulo do QR da sonda: a área dividida pelos módulos, como no cupom.
     *
     * O teto é o mesmo 320 pontos que [MeasuredProfile.qrWidthDots] já usa como largura preferida
     * de QR. Sem ele, um símbolo de versão 1 em papel de 80 mm ocuparia oito centímetros de bobina
     * para responder "sim" ou "não". A contagem de colunas não entra na conta porque a sonda recebe
     * só a largura raster — e é a largura raster que decide se o símbolo cabe.
     */
    private fun nativeQrModuleSizeDots(
        printableDots: Int,
        moduleSide: Int,
    ): Int =
        (
            minOf(printableDots, NATIVE_CODE_QR_MAX_DOTS) /
                (moduleSide + 2 * ThermalBarcode.QR_QUIET_ZONE_MODULES)
        ).coerceIn(
            ThermalBarcode.QR_NATIVE_MODULE_SIZE_DOTS_RANGE.first,
            ThermalBarcode.QR_NATIVE_MODULE_SIZE_DOTS_RANGE.last,
        )

    /** A mesma largura preferida de QR que o perfil usa no cupom. */
    private const val NATIVE_CODE_QR_MAX_DOTS = 320

    /**
     * A tira única: sem acento, sem seleção, UTF-8, os nomes e os endereços — nessa ordem.
     *
     * Ela mede modelo de codificação e página de uma vez. A ordem é a medição, e cada posição tem
     * razão:
     *
     * - **`a` é o ASCII**, a frase sem acento nenhum. É a resposta de quem não conseguiu acento em
     *   lugar nenhum, e vem primeira porque é o piso: quem escolher qualquer outra está dizendo que
     *   viu algo melhor que isso. A instrução avisa que ela não é a "linha legível" por padrão.
     * - **`b` é a sem seleção**, a tabela que a firmware liga sozinha. Ela só é honesta enquanto
     *   nenhum `ESC t` a precede na tira, e por isso vem antes dos nomes e dos endereços.
     * - **`c` é o UTF-8**, o modelo da MTP-II. Perguntar "byte único ou UTF-8?" numa tela separada
     *   saiu em 12/08: quem está com o papel na mão responde qual linha saiu legível, não qual
     *   modelo de codificação quer.
     *
     * **Só entra quem consegue imprimir a frase inteira acentuada.** Com as cinco letras soltas,
     * uma página incapaz de desenhar `ã` saía visivelmente errada. Com a frase, a dobra para ASCII
     * imprimiria `cao, acoes, avo` — limpo e sem acento —, e é justamente por isso que esse texto
     * agora existe **uma vez só**, rotulado, na linha `a`. CP437 e CP866 caem por esse critério, e
     * caem sozinhas: a regra é medida na tabela.
     *
     * **A CP858 ficou de fora, e isso custa um caso.** Para esta frase ela emite os mesmos bytes da
     * CP850 — o euro é a única diferença entre as duas —, então a linha dela seria a mesma da CP850
     * num endereço diferente. Sem ela, "firmware com CP850 no endereço 19" não é medido. O que
     * decidiu foi o alfabeto: com a CP858 a lista teria 27 linhas, e a resposta deixaria de ser uma
     * letra. O mesmo vale para a CP860 como nome, cuja linha seria idêntica à do endereço `n=03`.
     */
    val codePageCandidates: List<CodePageProbeCandidate>
        get() {
            var letter = 'a'
            fun next(): Char = letter++
            val fixed =
                listOf(
                    CodePageProbeCandidate(
                        letter = next(),
                        label = "sem acentos",
                        textEncoding = ThermalTextEncoding.ASCII,
                        codePage = null,
                        escT = null,
                        isAddress = false,
                    ),
                    CodePageProbeCandidate(
                        letter = next(),
                        label = "sem seleção",
                        textEncoding = ThermalTextEncoding.FIRMWARE_DEFAULT_PAGE,
                        codePage = ThermalCodePage.CP860,
                        escT = null,
                        isAddress = false,
                    ),
                    CodePageProbeCandidate(
                        letter = next(),
                        label = "UTF-8",
                        textEncoding = ThermalTextEncoding.UTF_8,
                        codePage = null,
                        escT = null,
                        isAddress = false,
                    ),
                )
            val named =
                NAMED_CODE_PAGES.map { page ->
                    CodePageProbeCandidate(
                        letter = next(),
                        label = page.name,
                        textEncoding = ThermalTextEncoding.SINGLE_BYTE_CODE_PAGE,
                        codePage = page,
                        escT = page.escPosValue,
                        isAddress = false,
                    )
                }
            val addresses =
                CODE_PAGE_SELECTOR_RANGE.map { n ->
                    CodePageProbeCandidate(
                        letter = next(),
                        label = "n=%02d".format(n),
                        textEncoding = ThermalTextEncoding.SINGLE_BYTE_CODE_PAGE,
                        codePage = ThermalCodePage.CP860,
                        escT = n,
                        isAddress = true,
                    )
                }
            val candidates = fixed + named + addresses
            check(candidates.last().letter <= 'z') {
                "A tira de página não cabe no alfabeto; a resposta deixaria de ser uma letra."
            }
            return candidates
        }

    /**
     * A letra da tira que produz esta medição, ou `null` quando nenhuma linha produz.
     *
     * A letra não é persistida no perfil: ela é função da tira, e `(codificação, página, seletor)`
     * identifica uma linha só — `b` é a página que a firmware já tinha ligada, `c` é UTF-8, as
     * nomeadas não repetem página e cada endereço carrega o próprio `n`. Configuração manual pode
     * gravar uma combinação que nenhuma linha imprime, e aí o comprovante não inventa letra.
     */
    fun codePageLetter(
        textEncoding: ThermalTextEncoding,
        codePage: ThermalCodePage?,
        codePageSelector: Int?,
    ): Char? =
        codePageCandidates.firstOrNull { candidate ->
            candidate.textEncoding == textEncoding &&
                candidate.codePage == codePage &&
                candidate.escT.takeIf { candidate.isAddress } == codePageSelector
        }?.letter

    val cutProtocolCandidates: List<CutProtocolProbeCandidate>
        get() =
            listOf(
                cutCandidate(CutProtocol.GS_V_0, 1, "GS V 0   (corte total)", 0x1D, 0x56, 0x00),
                cutCandidate(CutProtocol.GS_V_1, 2, "GS V 1   (corte parcial)", 0x1D, 0x56, 0x01),
                cutCandidate(CutProtocol.GS_V_65, 3, "GS V 65  (avanca e corta)", 0x1D, 0x56, 0x41, 0x50),
                cutCandidate(CutProtocol.GS_V_66, 4, "GS V 66  (avanca e corta parcial)", 0x1D, 0x56, 0x42, 0x50),
                cutCandidate(CutProtocol.ESC_I, 5, "ESC i    (total, dialeto antigo)", 0x1B, 0x69),
                cutCandidate(CutProtocol.ESC_M, 6, "ESC m    (parcial, dialeto antigo)", 0x1B, 0x6D),
                CutProtocolProbeCandidate(CutProtocol.NONE, 7, "Nenhum", null),
            )

    fun geometry(paperWidthMm: Int): PrinterProbe {
        val dotCandidates = MeasuredProfile.printableDotCandidates(paperWidthMm)
        require(dotCandidates.isNotEmpty()) { "Largura de papel inválida para a sonda." }
        val lastColumnCandidate = if (paperWidthMm == 58) 48 else 64
        return probe {
            write(EscPosThermalCommands.initialize())
            write(text("REGUA TEXTUAL\n", ThermalTextAlignment.CENTER, ThermalTextStyle.BOLD, 0))
            write(
                text(
                    "A ultima linha inteira manda.\n",
                    ThermalTextAlignment.LEFT,
                    ThermalTextStyle.NORMAL,
                    0,
                ),
            )
            for (columns in 24..lastColumnCandidate) {
                write(textRuler(columns).toByteArray(StandardCharsets.US_ASCII))
                write('\n'.code)
            }
            write(text("\nREGUAS RASTER\n", ThermalTextAlignment.CENTER, ThermalTextStyle.BOLD, 0))
            dotCandidates.forEach { dots ->
                // O número fica fora do raster e continua legível até em firmware sem code page.
                write("$dots DOTS\n".toByteArray(StandardCharsets.US_ASCII))
                write(rasterRuler(dots))
                write('\n'.code)
            }
            write(requireNotNull(EscPosThermalCommands.advance(PROBE_TEAR_FEED_LINES)))
        }
    }

    fun fullGeometry(): PrinterProbe =
        geometryRange(columns = 24..64, dots = (256..640 step 32).toList())

    private fun geometryRange(columns: IntRange, dots: List<Int>): PrinterProbe = probe {
        write(EscPosThermalCommands.initialize())
        write(text("REGUA TEXTUAL 24 A 64\n", ThermalTextAlignment.CENTER, ThermalTextStyle.BOLD, 0))
        columns.forEach { value ->
            write(textRuler(value).toByteArray(StandardCharsets.US_ASCII))
            write('\n'.code)
        }
        write(text("\nREGUA RASTER 256 A 640 DOTS\n", ThermalTextAlignment.CENTER, ThermalTextStyle.BOLD, 0))
        dots.forEach { value ->
            write("$value DOTS\n".toByteArray(StandardCharsets.US_ASCII))
            write(rasterRuler(value))
            write('\n'.code)
        }
        write(requireNotNull(EscPosThermalCommands.advance(PROBE_TEAR_FEED_LINES)))
    }

    /**
     * As duas réguas iniciais permitem reconhecer a bobina pelo papel, sem adivinhar pela conexão.
     *
     * Elas usam os mesmos gabaritos da medição de geometria. As antigas sequências de `-` e `=`
     * eram só desenhos aproximados: a barra anunciada como 32 tinha 24 caracteres, e a de 48 tinha
     * 40. No papel, portanto, nenhuma delas permitia comparar a largura anunciada com a largura que
     * realmente saiu.
     */
    fun paperWidthRulers(): PrinterProbe = probe {
        write(EscPosThermalCommands.initialize())
        listOf(58, 80).forEach { paperWidthMm ->
            val geometry = MeasuredProfile.geometryDefaults(paperWidthMm)
            write("${paperWidthMm}mm\n".toByteArray(StandardCharsets.US_ASCII))
            write(textRuler(geometry.printableColumns).toByteArray(StandardCharsets.US_ASCII))
            write('\n'.code)
            write("${geometry.printableDots} Dots\n".toByteArray(StandardCharsets.US_ASCII))
            write(rasterRuler(geometry.printableDots))
            write("\n\n".toByteArray(StandardCharsets.US_ASCII))
        }
        write(requireNotNull(EscPosThermalCommands.advance(PROBE_TEAR_FEED_LINES)))
    }

    /**
     * Uma tira, duas linhas com a mesma frase. A primeira usa bytes comuns às páginas DOS sem
     * emitir `ESC t`, porque o endereço só será medido na etapa seguinte; a segunda usa UTF-8 e
     * também não emite `ESC t`. Se nenhuma for legível, a resposta conservadora é ASCII.
     */
    fun textEncoding(): PrinterProbe = textEncoding(CutProtocol.NONE, 0)

    fun textEncoding(
        cutProtocol: CutProtocol,
        cutFeedLines: Int,
    ): PrinterProbe =
        probe {
            write(EscPosThermalCommands.initialize())
            write(text("CODIFICACAO DO TEXTO\n", ThermalTextAlignment.CENTER, ThermalTextStyle.BOLD, 0))
            write(
                text(
                    "Devem sair A-TIL C-CEDILHA O-TIL A-AGUDO E-CIRCUNFLEXO\n",
                    ThermalTextAlignment.LEFT,
                    ThermalTextStyle.NORMAL,
                    0,
                ),
            )
            write(text("PAGINA: [", ThermalTextAlignment.LEFT, ThermalTextStyle.NORMAL, 0))
            write(TEXT_ENCODING_SINGLE_BYTE_SAMPLE)
            write(text("]\n", ThermalTextAlignment.LEFT, ThermalTextStyle.NORMAL, 0))
            write(
                EscPosThermalCommands.text(
                    "UTF-8: $TEXT_ENCODING_SAMPLE\n",
                    ThermalTextAlignment.LEFT,
                    ThermalTextStyle.NORMAL,
                    0,
                    codePage = null,
                    textEncoding = ThermalTextEncoding.UTF_8,
                ),
            )
            // Esta tira decide **página ou UTF-8**, e só. Que ela não diga qual página é limitação
            // conhecida — os bytes daqui (82 87 A3 88) valem igual em CP437, CP850, CP858 e CP860,
            // de propósito, para a linha funcionar seja qual for a página que a firmware ligou.
            // Explicar isso no papel foi tentado em 2026-08-12 e piorou: três linhas de ressalva no
            // meio de uma sonda confundem mais que a ambiguidade que elas removem. Quem precisa da
            // ressalva é quem está lendo a tela, e é lá que ela deve estar.
            finishProbe(cutProtocol, cutFeedLines)
        }

    fun codePages(): PrinterProbe = codePages(CutProtocol.NONE, 0)

    fun codePages(
        cutProtocol: CutProtocol,
        cutFeedLines: Int,
    ): PrinterProbe =
        probe {
            // `ESC @` volta a impressora para a página que ela liga sozinha. É o que torna a
            // primeira linha honesta: nenhum `ESC t` foi emitido antes dela nesta tira.
            write(EscPosThermalCommands.initialize())
            write(
                EscPosThermalCommands.text(
                    CODE_PAGE_INSTRUCTIONS,
                    ThermalTextAlignment.LEFT,
                    ThermalTextStyle.NORMAL,
                    0,
                    null,
                ),
            )
            codePageCandidates.forEach { candidate ->
                write(codePageRow(candidate))
            }
            finishProbe(cutProtocol, cutFeedLines)
        }

    /**
     * Uma linha da tira, montada pelo **mesmo encoder da venda**.
     *
     * Não há bytes crus aqui de propósito: a linha é literalmente o que sairia numa comanda com o
     * perfil daquela candidata. Se a linha saiu legível no papel, a venda sai legível — e a
     * pessoa não precisa acreditar em nenhuma tradução nossa entre a sonda e o uso.
     */
    internal fun codePageRow(candidate: CodePageProbeCandidate): ByteArray =
        EscPosThermalCommands.text(
            "${candidate.letter}) $CODE_PAGE_SAMPLE\n",
            ThermalTextAlignment.LEFT,
            ThermalTextStyle.NORMAL,
            0,
            candidate.codePage,
            // O seletor só acompanha quem seleciona: a linha sem seleção e as sem página não podem
            // emitir `ESC t`, e o encoder recusa a combinação em vez de deixar passar.
            candidate.escT.takeIf { candidate.textEncoding == ThermalTextEncoding.SINGLE_BYTE_CODE_PAGE },
            candidate.textEncoding,
        )

    /**
     * Quantas linhas de papel a tira de página ocupa nesta impressora.
     *
     * A frase não cabe em 32 colunas: cada candidata gasta duas linhas em 58 mm e uma em 80 mm. A
     * tela precisa anunciar o número desta impressora, não a contagem de candidatas — foi por
     * isso que "26 linhas" deixou de ser verdade quando a frase entrou.
     */
    fun codePageProbeLineCount(printableColumns: Int): Int {
        require(printableColumns > 0) { "Largura textual inválida para contar a tira." }
        fun wrapped(line: String): Int =
            if (line.isEmpty()) 1 else (line.length + printableColumns - 1) / printableColumns
        // O último `\n` termina a linha anterior em vez de abrir outra; o `\n\n` do fim é que
        // deixa a linha em branco antes da lista, e ela ocupa papel como qualquer outra.
        val instructions = CODE_PAGE_INSTRUCTIONS.split('\n').dropLast(1).sumOf(::wrapped)
        val rows = codePageCandidates.sumOf { wrapped("${it.letter}) $CODE_PAGE_SAMPLE") }
        return instructions + rows
    }

    /**
     * Um comando de corte sozinho, com o payload terminando nele.
     *
     * A tira única de [cutProtocols] não distingue firmware que ignora o parcial de aba que rasgou
     * no manuseio: os seis blocos saem juntos e tudo que é impresso depois de um parcial empurra a
     * tira presa. Aqui não há nada depois do corte, então o papel responde só pela guilhotina.
     *
     * **O papel mostra o número, não o dialeto.** `GS V 1` é vocabulário nosso; quem está com as
     * tiras na mão compara "corte 1, corte 2" e escolhe. O nome do comando aparece no comprovante
     * final, onde serve ao catálogo.
     */
    fun isolatedCut(protocol: CutProtocol): PrinterProbe {
        val command = requireNotNull(commandFor(protocol)) { "Protocolo sem comando de corte." }
        val number =
            cutProtocolCandidates.firstOrNull { it.protocol == protocol }?.number
                ?: cutProtocolCandidates.first { it.protocol == CutProtocol.GS_V_1 }.number
        return probe {
            write(EscPosThermalCommands.initialize())
            write(
                EscPosThermalCommands.text(
                    "CORTE $number\n",
                    ThermalTextAlignment.LEFT,
                    ThermalTextStyle.BOLD,
                    0,
                    null,
                ),
            )
            // O avanço tira o rótulo de baixo da lâmina; o corte é a última coisa do payload.
            if (protocol !in MeasuredProfile.CUTS_WITH_EMBEDDED_FEED) {
                write(requireNotNull(EscPosThermalCommands.advance(PROBE_TEAR_FEED_LINES)))
            }
            write(command)
        }
    }

    fun cutProtocols(): PrinterProbe =
        probe {
            write(EscPosThermalCommands.initialize())
            write(
                EscPosThermalCommands.text(
                    "SONDA DE CORTE\n",
                    ThermalTextAlignment.CENTER,
                    ThermalTextStyle.BOLD,
                    0,
                ),
            )
            write(
                EscPosThermalCommands.text(
                    CUT_PROBE_INSTRUCTIONS,
                    ThermalTextAlignment.LEFT,
                    ThermalTextStyle.NORMAL,
                    0,
                ),
            )
            cutProtocolCandidates.filter { it.commandBytes() != null }.forEach { candidate ->
                write(
                    EscPosThermalCommands.text(
                        "${candidate.number}  ${candidate.label}\n",
                        ThermalTextAlignment.LEFT,
                        ThermalTextStyle.BOLD,
                        0,
                    ),
                )
                candidate.commandBytes()?.let { command ->
                    write(requireNotNull(EscPosThermalCommands.advance(4)))
                    write(command)
                    // Nada de avanço depois do corte: o rótulo do bloco seguinte já começa em linha
                    // nova, e cada linha a mais empurra a tira pendurada pela aba do corte parcial.
                    // A aba é a única prova de que o comando parcial foi obedecido.
                }
            }
            write(
                EscPosThermalCommands.text(
                    "\nFIM. Rolo inteiro = nenhum cortou.\n",
                    ThermalTextAlignment.CENTER,
                    ThermalTextStyle.NORMAL,
                    0,
                ),
            )
            write(requireNotNull(EscPosThermalCommands.advance(PROBE_TEAR_FEED_LINES)))
        }

    /** NONE e comandos 65/66 já concluem com zero e não imprimem oito tiras. */
    fun cutFeedChoices(protocol: CutProtocol): List<Int> =
        if (protocol == CutProtocol.NONE || protocol in MeasuredProfile.CUTS_WITH_EMBEDDED_FEED) {
            listOf(0)
        } else {
            MeasuredProfile.CUT_FEED_CHOICES.toList()
        }

    fun cutFeedStrips(protocol: CutProtocol): List<CutFeedProbeStrip> {
        if (cutFeedChoices(protocol) == listOf(0) &&
            (protocol == CutProtocol.NONE || protocol in MeasuredProfile.CUTS_WITH_EMBEDDED_FEED)
        ) {
            return emptyList()
        }
        val cut = requireNotNull(commandFor(protocol)) { "Protocolo sem comando de corte." }
        return MeasuredProfile.CUT_FEED_CHOICES.map { feedLines ->
            CutFeedProbeStrip(
                feedLines = feedLines,
                probe =
                    probe {
                        write(EscPosThermalCommands.initialize())
                        // O número vai em tamanho normal, emoldurado. `GS !` era o que dobrava a
                        // altura, e a MP-4200 TH não implementa esse comando: ela engole só o `GS`
                        // e imprime o `!` como texto, então a tira saía "!5" e "!!Escolha". Negrito
                        // e moldura ASCII dão o mesmo destaque sem comando que ela não entende.
                        write(
                            text(
                                ">>> $feedLines <<<\n",
                                ThermalTextAlignment.CENTER,
                                ThermalTextStyle.BOLD,
                                0,
                            ),
                        )
                        write(
                            text(
                                "Escolha o menor avanco que nao cortar texto.\n",
                                ThermalTextAlignment.LEFT,
                                ThermalTextStyle.NORMAL,
                                0,
                            ),
                        )
                        write(
                            text(
                                ">>> $feedLines <<<\n",
                                ThermalTextAlignment.CENTER,
                                ThermalTextStyle.BOLD,
                                0,
                            ),
                        )
                        write("---- LINHA DE REFERENCIA ----\n".toByteArray(StandardCharsets.US_ASCII))
                        // O avanço vai impresso, uma linha numerada por linha pedida. O papel anda
                        // exatamente o mesmo — `LF` é `LF`, com ou sem tinta em cima —, mas o
                        // desperdício deixa de ser branco e vira contagem: o último número visível
                        // diz quanto do avanço sobrou antes da lâmina, e o branco que ainda houver
                        // depois dele é o que a firmware alimenta por conta própria.
                        write(feedRuler(feedLines).toByteArray(StandardCharsets.US_ASCII))
                        write(cut)
                    },
            )
        }
    }

    fun cutFeedStrip(
        protocol: CutProtocol,
        feedLines: Int,
    ): PrinterProbe =
        cutFeedStrips(protocol).firstOrNull { it.feedLines == feedLines }?.probe
            ?: error("Avanço não pertence à sonda deste protocolo.")

    fun cutFeed(protocol: CutProtocol): PrinterProbe {
        val strips = cutFeedStrips(protocol)
        require(strips.isNotEmpty()) { "Este protocolo conclui com avanço zero e não exige sonda." }
        return probe {
            strips.forEach { strip ->
                val bytes = strip.probe.bytes()
                try {
                    write(bytes)
                } finally {
                    bytes.fill(0)
                }
            }
        }
    }

    /**
     * @param decoration cabeçalho e rodapé do hospedeiro. O comprovante final é o único papel desta
     *   série que os recebe — ele não mede nada, é o recibo da instalação concluída, e leva a
     *   assinatura do app como qualquer cupom. As tiras acima não têm parâmetro para isso, e essa
     *   ausência é a isenção: um raster no meio da régua desloca justamente o que ela mede. Ver
     *   [ReceiptDecoration].
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
        // O layout leva a decoração porque é dentro de `finish()` que o rodapé entra, imediatamente
        // antes da lâmina; o cabeçalho, esse, é escrito abaixo, na mão.
        val layout = ReceiptLayout.from(profile.toDriverProfile(), decoration)
        // A letra é como a escolha foi feita: quem estava com a tira na mão respondeu `d`, não
        // "CP850". Sem ela, conferir uma pilha de comprovantes contra as tiras exige traduzir o
        // código de volta para a linha — e em `Nenhuma` o código não distingue a linha `a`, que é
        // ASCII, da `c`, que é UTF-8.
        val codePageLetter =
            codePageLetter(profile.textEncoding, profile.codePage, profile.codePageSelector)
        return probe {
            write(EscPosThermalCommands.initialize())
            // **Depois do `ESC @`, nunca antes.** `ESC @` descarta o que estiver no buffer sem ter
            // sido fechado por `LF`, então um cabeçalho prepended aos bytes desta sonda sumiria
            // inteiro — sem erro nenhum, só no papel. Pelo mesmo motivo o cabeçalho do hospedeiro
            // precisa terminar em quebra de linha.
            decoration?.header(layout)?.let { cabecalho ->
                try {
                    write(cabecalho)
                } finally {
                    // Pode ser raster de logotipo: cópia viva no heap é o que o contrato de
                    // `clear()` existe para evitar.
                    cabecalho.fill(0)
                }
            }
            write(
                EscPosThermalCommands.text(
                    // Os rótulos saem acentuados porque a página já foi medida — e a linha de
                    // acentos logo abaixo é a prova disso. Onde não houve página, o encoder dobra
                    // para ASCII sozinho, e o comprovante continua legível.
                    //
                    // **Sem maiúscula acentuada.** A tira mede só minúsculas — `cão, ações, avô` —,
                    // então a metade alta da tabela onde moram `Ç Í Ã` nunca foi medida. Medido no
                    // papel da T210 em 12/08, quando o título ainda era "homologação": em caixa
                    // alta e com a página aprovada por ela, saiu "HOMOLOGACÃO CONCLUrDA". Título em
                    // caixa alta era só estilo; a legibilidade não é, e `Instalação` tem o mesmo
                    // `ç ã` no lugar errado se alguém subir a caixa.
                    "Instalação concluída\n",
                    ThermalTextAlignment.CENTER,
                    ThermalTextStyle.BOLD,
                    0,
                    profile.codePage,
                    textEncoding = profile.textEncoding,
                ),
            )
            write(
                EscPosThermalCommands.text(
                    // **O bloco inteiro passa pela quebra do perfil.** Antes só o nome passava, e
                    // "Codificação: Padrão da impressora" — 33 caracteres — estourava as 32 colunas
                    // da T210: a firmware quebrava na coluna exata e o papel saía "impressor / a".
                    // Palavra partida é a assinatura que a tela ensina a procurar para largura
                    // errada, então um rótulo comprido virava alarme falso justamente no papel que
                    // prova a medição certa.
                    layout.wrap(
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
                            "Página: ${profile.codePage?.name ?: "Nenhuma"}" +
                            codePageLetter?.let { " (letra $it)" }.orEmpty() + "\n" +
                            "Codificação: ${profile.textEncoding.receiptLabel}\n" +
                            "Corte: ${profile.cutProtocol.capabilityName} | avanço ${profile.cutFeedLines}\n" +
                            // Colada na linha do dialeto porque é a outra metade da mesma medição:
                            // qual comando a firmware atende, e se o modo dele sai no papel.
                            cutModeLine(profile.cutProtocol, profile.cutModeHonored) +
                            // A régua da sonda entra aqui, junto das outras capacidades medidas e
                            // antes do carimbo de data: é uma delas, e a única que mudou o
                            // comportamento da impressora sem aparecer no papel até 20/08.
                            verticalRasterScaleLine(profile.verticalRasterScale) +
                            // As duas capacidades da sonda de código nativo entram logo depois, e
                            // antes do carimbo de data, pelo mesmo motivo: são capacidade medida, e
                            // o comprovante lista toda capacidade medida.
                            nativeQrLine(profile.nativeQrHonored) +
                            nativeBarcodeLine(profile.nativeBarcodeHonored) +
                            // A família de configuração de rede fecha o bloco das capacidades
                            // medidas, logo antes do carimbo de data: é a única que não sai da
                            // série de tiras da homologação, e por isso a última — quem lê o papel
                            // de cima para baixo encontra primeiro o que esta bobina mediu. Mesma
                            // posição relativa no iOS.
                            wifiConfigurationFamilyLine(profile.wifiConfigurationFamily) +
                            // Com pilha de tira na mesa, o papel precisa dizer quando saiu: sem
                            // isso, duas medições da mesma impressora em dias diferentes são
                            // indistinguíveis.
                            "Medida em: ${localTimestamp(profile.measuredAtEpochMillis)}\n" +
                            identityLines(identity) +
                            // O literal precisa ter acento de verdade. Sem isso a linha sai igual
                            // em CP850 e em impressora sem página nenhuma, e o comprovante final
                            // não prova a medição que acabou de ser feita — foi o que a i9 mostrou.
                            //
                            // A linha seguinte é a amostra inteira, a mesma da tira: o comprovante
                            // prova exatamente o que foi medido, maiúscula inclusive.
                            "Acentos: ação, opção, São João\n" +
                            CODE_PAGE_SAMPLE,
                    ) + "\n\n",
                    ThermalTextAlignment.LEFT,
                    ThermalTextStyle.NORMAL,
                    0,
                    profile.codePage,
                    // Sem o seletor medido, esta linha sai pelo `n` canônico e desmente o próprio
                    // comprovante. Medido na T210: CP860 no endereço 8, acentos errados aqui.
                    profile.codePageSelector,
                    profile.textEncoding,
                ),
            )
            write(
                requireNotNull(
                    EscPosThermalCommands.qrRaster(
                        value = FINAL_RECEIPT_QR,
                        widthDots = profile.qrWidthDots,
                        errorCorrection = 2,
                        // O comprovante final é o primeiro papel que sai já compensado: se a régua
                        // desta homologação achou fator, o QR aqui precisa sair quadrado.
                        verticalRasterScale = profile.verticalRasterScale,
                    ),
                ) { "Geometria insegura para o QR raster final." },
            )
            write('\n'.code)
            write(layout.finish())
        }
    }

    /**
     * A linha que diz se o **modo** do corte sai como o comando pede. Termina em quebra de linha.
     *
     * **Por que ela é separada da linha `Corte:`.** Aquela diz qual comando a firmware atende;
     * esta diz se o papel sai do jeito que o comando promete. São coisas diferentes, e a bancada
     * mediu a diferença em 10/08: a GoldenSky 80 mm obedeceu aos sete comandos e cortou **sempre
     * parcial**, inclusive nos que pedem total. Comando atendido, modo não. É
     * [MeasuredProfile.cutModeHonored] que impede [MeasuredProfile.withCutMode] de prometer papel
     * solto que nunca vem, e até 20/08 nada disso aparecia no papel — quem transcreve o comprovante
     * para um cadastro um mês depois não tinha como saber que aquela impressora não escolhe modo.
     *
     * Junta na linha `Corte:` não cabia: `Corte: GS_V_0 | avanço 4` já ocupa 24 das 32 colunas da
     * 58 mm.
     *
     * **Sem guilhotina o campo existe e não tem sentido**, e é isso que a terceira redação diz. O
     * perfil guarda `true` por padrão mesmo em `NONE`, e imprimir "sai como pedido" ali seria
     * afirmar sobre um corte que não acontece. A linha continua saindo porque o comprovante virou
     * fonte de transcrição: campo que some da folha vira campo esquecido no cadastro.
     */
    fun cutModeLine(
        cutProtocol: CutProtocol,
        cutModeHonored: Boolean,
    ): String =
        "$CUT_MODE_LABEL: " +
            when {
                cutProtocol == CutProtocol.NONE -> "sem guilhotina"
                cutModeHonored -> "sai como pedido"
                else -> "sai diferente"
            } + "\n"

    /**
     * "Modo do corte", e não "Corte": o rótulo precisa não colidir com a linha do dialeto, que
     * está logo acima e começa com a mesma palavra.
     */
    private const val CUT_MODE_LABEL = "Modo do corte"

    /**
     * A linha da sonda de vazão nos comprovantes: o que a régua leu, contra o que a tira mede, e o
     * fator que essa leitura gravou. Termina em quebra de linha, como as vizinhas.
     *
     * **Por que ela existe.** [MeasuredProfile.verticalRasterScale] muda os bytes de toda imagem
     * daquela impressora, e até 20/08 nenhum papel dizia isso. O comprovante documentava colunas,
     * dots, página e corte — e não a única medição que alterou o comportamento da máquina. Quem
     * pegasse a bobina um mês depois não tinha como saber que aquela impressora imprime compensada,
     * nem por quê. É o mesmo motivo pelo qual a letra da página está no comprovante: capacidade que
     * muda a saída precisa estar escrita no papel que a certifica.
     *
     * **O milímetro é reconstruído do fator, e não guardado à parte.** A máquina grava exatamente
     * `lido / `[RASTER_THROUGHPUT_STRIP_MM], então `fator × 48` devolve o número que a pessoa
     * respondeu — em `Double`, e arredondado, porque a resposta era inteira. Um campo novo só para
     * o milímetro custaria versão de store, chave de Codable e migração nas duas plataformas para
     * carregar um número que o fator já carrega. O único caso em que a conta mente é a leitura
     * abaixo do piso do campo — 24 mm de 48 —, onde o `coerceIn` da máquina já apagou o excedente
     * antes de qualquer gravação; ali o comprovante relata o fator que a impressora vai mesmo usar,
     * que é o que interessa a quem lê o papel depois.
     *
     * **Sem fator a linha continua saindo, e não há milímetro a relatar.** "Usar padrão" e tira na
     * medida gravam `null`, indistinguível de nunca ter medido — e `null` não guarda leitura
     * nenhuma para citar. O que não pode acontecer é a linha sumir: ausência de informação no papel
     * é exatamente a lacuna que ela existe para fechar.
     *
     * **Cabe em 32 colunas** nos dois casos — 28 e 22 caracteres —, que é a largura da 58 mm. O
     * milímetro tem sempre dois dígitos porque o piso do campo é 0,5, ou seja, 24 mm.
     *
     * O iOS emite esta mesma linha em `PrinterProbePayloads.verticalRasterScaleLine`, e as duas
     * suítes fixam os mesmos literais.
     */
    fun verticalRasterScaleLine(verticalRasterScale: Double?): String {
        val fator =
            verticalRasterScale
                ?: return "$VERTICAL_RASTER_SCALE_LABEL: sem compensação\n"
        val lidoMm = Math.round(fator * RASTER_THROUGHPUT_STRIP_MM)
        return "$VERTICAL_RASTER_SCALE_LABEL: $lidoMm/$RASTER_THROUGHPUT_STRIP_MM mm | " +
            "fator ${twoDecimals(fator)}\n"
    }

    /**
     * O rótulo é o nome da tira — "SONDA DE VAZAO" —, e não o do que ela conclui hoje.
     *
     * Quem confere uma pilha de comprovantes contra uma pilha de tiras precisa achar o par pelo
     * nome, do mesmo jeito que a letra da página liga o comprovante à linha respondida. "Vazão"
     * deixou de ser a conclusão em 20/08, mas continua sendo o que está impresso na tira que gerou
     * este número.
     */
    private const val VERTICAL_RASTER_SCALE_LABEL = "Vazão"

    /**
     * A linha do `GS ( k` nos comprovantes. Termina em quebra de linha, como as vizinhas.
     *
     * **Duas linhas, e não uma com dois valores.** São duas capacidades, medidas por dois comandos
     * diferentes; uma linha só daria nove combinações num literal, e o comprovante é certidão para
     * transcrever num cadastro.
     *
     * **Linha nenhuma some quando o valor é ausente.** `não medido` é a terceira redação, como
     * `sem guilhotina` é a terceira do [cutModeLine]: o perfil anterior à sonda existe, e o papel
     * precisa dizer que ali não houve medição em vez de calar. Ausência de informação no papel é a
     * lacuna que estas linhas existem para fechar.
     *
     * **A voz descreve o papel, não a flag** — `sai como código` / `sai como texto` —, do mesmo
     * jeito que a linha do modo de corte descreve o que saiu, e não o valor booleano.
     *
     * **Cabe em 32 colunas** nos três casos: 26, 25 e 20 caracteres aqui; 31, 30 e 26 na irmã.
     *
     * O iOS emite estas mesmas linhas em `PrinterProbePayloads.nativeQRLine` e
     * `nativeBarcodeLine`, e as duas suítes fixam os mesmos literais.
     */
    fun nativeQrLine(honored: Boolean?): String =
        "$NATIVE_QR_LABEL: ${nativeCodeState(honored)}\n"

    /** A mesma linha para o `GS k`. Ver [nativeQrLine]. */
    fun nativeBarcodeLine(honored: Boolean?): String =
        "$NATIVE_BARCODE_LABEL: ${nativeCodeState(honored)}\n"

    private fun nativeCodeState(honored: Boolean?): String =
        when (honored) {
            null -> "não medido"
            true -> "sai como código"
            false -> "sai como texto"
        }

    private const val NATIVE_QR_LABEL = "QR nativo"
    private const val NATIVE_BARCODE_LABEL = "Barras nativas"

    /**
     * A linha que diz como esta impressora aceita configuração de rede, e **de onde isso veio**.
     * Termina em quebra de linha, como as vizinhas.
     *
     * **Por que ela existe.** `AGENTS.md` obriga: o comprovante final é certidão transcrita para
     * cadastro, e por isso lista toda capacidade medida. Esta custou uma tira de papel própria, e
     * sem ela quem pegar a bobina um mês depois não tem como saber que a pergunta já foi respondida
     * — e vai gastar a tira de novo.
     *
     * **As quatro redações separam medido de declarado**, que é a razão de o campo existir. "Não
     * determinada" é o perfil que nunca viu a tela de rede, indistinguível de um perfil anterior ao
     * campo; "escolhida à mão" é a família que nenhuma tira confirma, e dizer "medida" ali seria
     * escrever no papel uma medição que não houve.
     *
     * **A linha continua saindo quando o valor é ausente**, como as duas de cima: a ausência é a
     * informação, e campo que some da folha vira campo esquecido no cadastro.
     *
     * **As quatro redações têm 32 caracteres exatos**, que é a largura da 58 mm — a mais estreita
     * que este kit suporta. Não é coincidência: `medida, recusada` estourava por um caractere e
     * `layout.wrap` a partiria em duas linhas, deslocando tudo o que vem depois no papel que serve
     * de fonte de transcrição. A suíte fixa o comprimento junto com o texto, para a próxima palavra
     * escolhida aqui não caber "quase".
     *
     * Passado nos dois desfechos medidos, e o mesmo tempo verbal: o papel relata o que a impressora
     * fez com a tira, e dois tempos diferentes sugeririam duas naturezas de medição.
     *
     * Nenhuma nomeia marca, modelo ou byte: o papel vai para quem cadastra, não para quem leu a
     * reversão.
     *
     * O iOS emite esta mesma linha em `PrinterProbePayloads.wifiConfigurationFamilyLine`, e as duas
     * suítes fixam os mesmos literais.
     */
    fun wifiConfigurationFamilyLine(family: PrinterWifiConfigurationFamily?): String =
        "$WIFI_CONFIGURATION_FAMILY_LABEL: " +
            when (family) {
                null -> "não determinada"
                PrinterWifiConfigurationFamily.MEASURED_US_W_HONORED -> "medida, aceitou"
                PrinterWifiConfigurationFamily.MEASURED_US_W_ABSENT -> "medida, recusou"
                PrinterWifiConfigurationFamily.CHOSEN_US_ESC_US -> "escolhida à mão"
            } + "\n"

    /**
     * "Config. de rede", e não "Rede": o comprovante já tem `Conexão:`, que é por onde os cupons
     * saem, e as duas linhas ficam a três de distância. Rótulo que se confunde com o vizinho vira
     * campo transcrito no lugar errado.
     */
    private const val WIFI_CONFIGURATION_FAMILY_LABEL = "Config. de rede"

    /**
     * Duas casas com vírgula, em aritmética inteira e sem `Locale`.
     *
     * `String.format` traria a vírgula ou o ponto conforme o aparelho, e o papel de um celular em
     * inglês deixaria de ser comparável ao de outro. Centésimos inteiros também garantem que o iOS
     * escreva o mesmo texto para o mesmo fator, que é o contrato desta linha.
     */
    private fun twoDecimals(value: Double): String {
        val centesimos = Math.round(value * 100)
        return "${centesimos / 100},${(centesimos % 100).toString().padStart(2, '0')}"
    }

    /** Data e hora do aparelho, sem segundos: serve para identificar a tira, não para auditar. */
    internal fun localTimestamp(epochMillis: Long?): String =
        runCatching {
            DateTimeFormatter
                .ofPattern("dd/MM/yyyy HH:mm")
                .withZone(ZoneId.systemDefault())
                .format(Instant.ofEpochMilli(epochMillis ?: System.currentTimeMillis()))
        }.getOrDefault("-")

    /**
     * `internal` desde 26/08/2026: a certidão Procomp reusa estas linhas, e reescrevê-las lá faria
     * duas folhas com o mesmo propósito divergirem no rótulo. Ver [ProcompHomologationProbes].
     */
    internal fun identityLines(identity: PrinterDeclaredIdentity?): String =
        if (identity == null) {
            "Identidade GS I: não respondeu\n"
        } else {
            buildString {
                identity.manufacturer?.let { append("Fabricante: $it\n") }
                identity.model?.let { append("Modelo: $it\n") }
                identity.firmwareVersion?.let { append("Firmware: $it\n") }
            }
        }

    fun commandFor(protocol: CutProtocol): ByteArray? =
        cutProtocolCandidates.firstOrNull { it.protocol == protocol }?.commandBytes()
            ?: if (protocol == CutProtocol.GS_V) {
                cutProtocolCandidates.first { it.protocol == CutProtocol.GS_V_1 }.commandBytes()
            } else {
                null
            }

    /**
     * Endereços varridos por `ESC t`. Começa em zero desde 12/08: com a CP437 fora da lista de
     * nomes, `n=00` só continua medido se algum endereço o cobrir — e a T210 já provou que a
     * página portuguesa pode morar em qualquer `n`.
     */
    val CODE_PAGE_SELECTOR_RANGE = (0..20).toList()

    /**
     * Nomes de página que sobrevivem à frase inteira, derivados da própria tabela.
     *
     * A CP860 fica de fora porque a linha dela seria byte a byte igual à do endereço `n=03` —
     * mesma seleção, mesma tabela —, e duas linhas idênticas na tira são papel gasto e uma
     * escolha ambígua para quem responde.
     */
    private val NAMED_CODE_PAGES: List<ThermalCodePage>
        get() =
            ThermalCodePage.values().filter { page ->
                page != ThermalCodePage.CP860 &&
                    page != ThermalCodePage.CP858 &&
                    CODE_PAGE_SAMPLE.all { it.code < 0x80 || page.encode(it) != null }
            }

    private fun cutCandidate(
        protocol: CutProtocol,
        number: Int,
        label: String,
        vararg command: Int,
    ): CutProtocolProbeCandidate =
        CutProtocolProbeCandidate(protocol, number, label, command.map(Int::toByte).toByteArray())

    /**
     * Régua do avanço: uma linha numerada por linha de avanço pedida.
     *
     * Avança o mesmo que o mesmo número de quebras em branco e ainda deixa a medida legível. Sem
     * ela o operador só via papel em branco depois da linha de referência e não tinha como
     * comparar uma tira com a outra.
     */
    internal fun feedRuler(feedLines: Int): String =
        (1..feedLines).joinToString("") { "$it ---- DESPERDICIO\n" }

    internal fun textRuler(columns: Int): String {
        val suffix = columns.toString()
        return "|" + "-".repeat(columns - suffix.length - 2) + "|" + suffix
    }

    /**
     * As quatro bordas pretas da régua, empacotadas — **só pixels**, sem envelope nenhum.
     *
     * Separado de [rasterRuler] pelo mesmo motivo que [throughputRowByte] é `internal`: o desenho
     * da régua é o instrumento e o comando é o envelope. O Procomp emite estes mesmos bytes por
     * `ESC n`; se ele redesenhasse a moldura, as duas réguas mediriam coisas diferentes com o
     * mesmo nome.
     */
    internal fun rasterRulerPixels(widthDots: Int): ByteArray {
        require(widthDots > 0 && widthDots % 8 == 0)
        val widthBytes = widthDots / 8
        val pixels = ByteArray(widthBytes * RASTER_HEIGHT_DOTS)
        for (y in 0 until RASTER_HEIGHT_DOTS) {
            for (x in 0 until widthDots) {
                if (y == 0 || y == RASTER_HEIGHT_DOTS - 1 || x == 0 || x == widthDots - 1) {
                    val index = y * widthBytes + x / 8
                    pixels[index] = (pixels[index].toInt() or (0x80 shr (x % 8))).toByte()
                }
            }
        }
        return pixels
    }

    /** Faixa `GS v 0` com as quatro bordas pretas; só pixels, nunca payload textual. */
    private fun rasterRuler(widthDots: Int): ByteArray {
        val widthBytes = widthDots / 8
        val pixels = rasterRulerPixels(widthDots)
        return try {
            ByteArrayOutputStream().use { output ->
                output.write(GS.toInt())
                output.write(RASTER_IMAGE.toInt())
                output.write(RASTER_FUNCTION.toInt())
                output.write(RASTER_MODE_NORMAL.toInt())
                output.write(widthBytes and 0xFF)
                output.write(widthBytes shr 8 and 0xFF)
                output.write(RASTER_HEIGHT_DOTS and 0xFF)
                output.write(RASTER_HEIGHT_DOTS shr 8 and 0xFF)
                output.write(pixels)
                output.toByteArray()
            }
        } finally {
            pixels.fill(0)
        }
    }

    private fun probe(block: ByteArrayOutputStream.() -> Unit): PrinterProbe =
        ByteArrayOutputStream().use { output ->
            output.block()
            PrinterProbe(output.toByteArray(), EscPosDialect.EPSON_COMPATIBLE)
        }

    /**
     * Depois que dialeto e avanço foram provados no papel, a própria lâmina entrega cada sonda
     * seguinte com a distância daquela impressora. O intervalo sem avanço medido agora contém só
     * as sondas de corte e do próprio avanço, que concluem nos seus builders; as 12 linhas
     * conservadoras continuam protegendo o corte isolado e o caminho sem guilhotina, mas não vazam
     * para codificação ou página depois que já existe valor medido.
     */
    private fun ByteArrayOutputStream.finishProbe(
        cutProtocol: CutProtocol,
        cutFeedLines: Int,
    ) {
        if (cutProtocol == CutProtocol.NONE) {
            write(requireNotNull(EscPosThermalCommands.advance(PROBE_TEAR_FEED_LINES)))
            return
        }
        if (cutProtocol !in MeasuredProfile.CUTS_WITH_EMBEDDED_FEED) {
            require(cutFeedLines in MeasuredProfile.CUT_FEED_CHOICES) {
                "Avanço medido não pertence ao perfil."
            }
            write(requireNotNull(EscPosThermalCommands.advance(cutFeedLines)))
        }
        write(requireNotNull(commandFor(cutProtocol)))
    }

    private fun text(
        value: String,
        alignment: ThermalTextAlignment,
        style: ThermalTextStyle,
        size: Int,
    ): ByteArray = EscPosThermalCommands.text(value, alignment, style, size, codePage = null)

    private const val GS: Byte = 0x1D
    private const val RASTER_IMAGE: Byte = 0x76
    private const val RASTER_FUNCTION: Byte = 0x30
    private const val RASTER_MODE_NORMAL: Byte = 0x00
    internal const val RASTER_HEIGHT_DOTS = 16

    /**
     * Avanço final das sondas que não cortam, em linhas. Com 4 a MP-4200 e a i9 seguraram as
     * réguas raster e as amostras de página dentro da impressora: a distância entre a cabeça e a
     * serrilha é maior que isso, e o operador não conseguia ler o que a sonda acabara de imprimir.
     * 12 é o maior avanço que o próprio kit aceita como medida de corte, então é o único valor que
     * garante a última linha do lado de fora em toda impressora já suportada.
     */
    internal const val PROBE_TEAR_FEED_LINES = 12
    /** Também usado pelo comprovante de teste da impressora adotada: o QR prova o raster. */
    internal const val FINAL_RECEIPT_QR = "THERMAL-PRINTER-KIT-HOMOLOGATION"
}
