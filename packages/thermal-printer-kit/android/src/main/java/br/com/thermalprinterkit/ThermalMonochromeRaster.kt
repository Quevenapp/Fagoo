package br.com.thermalprinterkit

/**
 * Bitmap 1-bit já composto por quem monta o cupom.
 *
 * `blackPixels[y * widthDots + x] == true` significa ponto preto, com a linha 0 no topo — a mesma
 * convenção que [OneBitRasterSource] já usa, que é para onde estes bits vão.
 *
 * **Por que este tipo existe.** Um interpretador de ESC/POS compõe o cupom inteiro em pontos —
 * texto, código de barras, QR e imagem já viraram bits — e precisa emitir isso como faixas
 * `GS v 0`. Sem uma entrada assim, ele reimplementaria o empacotamento de bits por fora do kit, e
 * com ele reimplementaria a compensação de [ReceiptLayout.verticalRasterScale]: passariam a existir
 * duas verdades sobre o único campo medido tardio que muda os bytes emitidos. Este tipo é a porta
 * que faz o cupom já rasterizado atravessar **o mesmo** emissor de sempre.
 *
 * **O que ele não faz.** Não converte cinza, não aplica meio-tom e não redimensiona: quem compôs os
 * pontos já decidiu tudo isso. A largura precisa ser a que o perfil aceita — ver
 * [ReceiptLayout.printableDots] —, porque aqui não há imagem para reamostrar na horizontal.
 *
 * **Memória.** [of] copia o vetor recebido, e a cópia é o que este tipo passa a valer: em Swift o
 * mesmo tipo é `struct` com `[Bool]`, e copy-on-write dá exatamente esse comportamento — mutar o
 * vetor de origem depois de construir não muda o bitmap. O preço é o de lá também: o kit fica com
 * uma cópia dos pontos, e zerar o bitmap de origem continua sendo de quem o compôs. É a mesma
 * divisão que `ThermalImage.clear()` já expressa para foto. A cópia que o emissor cria por faixa,
 * essa sim, ele zera.
 *
 * Espelho de `ios/Sources/ThermalPrinterKit/ThermalMonochromeRaster.swift:25`.
 */
class ThermalMonochromeBitmap private constructor(
    val widthDots: Int,
    val heightDots: Int,
    /**
     * Interno de propósito: o consumidor entrega os pontos, não os lê de volta. Publicar o vetor só
     * aumentaria a superfície e daria uma segunda forma de sair com os bits na mão.
     */
    internal val blackPixels: BooleanArray,
) {
    /**
     * Dois bitmaps são iguais quando os **pontos** são iguais.
     *
     * Escrito à mão, e não por `data class`, porque `BooleanArray` tem igualdade por referência: um
     * `data class` diria que dois bitmaps com os mesmos pontos são diferentes, e o lado Swift, que
     * é `Equatable` de verdade, diria o contrário. Duas plataformas discordando sobre igualdade é
     * como um teste de paridade passa dos dois lados provando coisas diferentes.
     */
    override fun equals(other: Any?): Boolean =
        this === other ||
            (
                other is ThermalMonochromeBitmap &&
                    widthDots == other.widthDots &&
                    heightDots == other.heightDots &&
                    blackPixels.contentEquals(other.blackPixels)
            )

    override fun hashCode(): Int =
        (widthDots * 31 + heightDots) * 31 + blackPixels.contentHashCode()

    companion object {
        /**
         * Devolve `null` quando as dimensões e o vetor não descrevem o mesmo bitmap.
         *
         * É a única regra que este tipo guarda, porque é a única que **ele** promete: sem
         * `blackPixels.size == widthDots * heightDots` o índice `y * widthDots + x` não significa
         * nada. O produto é feito em `Long` para que largura e altura absurdas não deem a volta no
         * `Int` e casem por acidente com o tamanho do vetor.
         *
         * O que é contrato do `GS v 0` — largura múltipla de 8 — é cobrado na emissão, e não aqui:
         * dois lugares decidindo a mesma largura é como um deles envelhece sozinho.
         */
        @JvmStatic
        fun of(
            widthDots: Int,
            heightDots: Int,
            blackPixels: BooleanArray,
        ): ThermalMonochromeBitmap? {
            if (widthDots <= 0 || heightDots <= 0) return null
            if (widthDots.toLong() * heightDots != blackPixels.size.toLong()) return null
            return ThermalMonochromeBitmap(widthDots, heightDots, blackPixels.copyOf())
        }
    }
}

/**
 * Emite faixas `GS v 0` a partir de um bitmap já composto, com os parâmetros **deste** perfil.
 *
 * É [ReceiptLayout.imageRaster] sem a etapa de meio-tom: mesmo emissor, mesmo `ESC a 1` na frente,
 * mesma altura de banda de [ReceiptLayout.rasterStripeHeightDots] e mesmo
 * [ReceiptLayout.verticalRasterScale]. Para o mesmo conteúdo em pontos, os bytes são byte a byte os
 * de sempre — este caminho não inventa nenhum, e é isso que
 * `ThermalMonochromeRasterTest` prova contra `EscPosThermalCommands.qrRaster`.
 *
 * Existe pelo mesmo motivo de [ReceiptLayout.qrRaster]: o caminho compensado é o do layout. Quem
 * tiver o bitmap e emitir por fora fica sem a compensação do perfil, e um cupom inteiro 20% mais
 * curto na Inico T210 é papel errado que nenhuma suíte pega.
 *
 * @return `null` quando a largura do bitmap não é o que o `GS v 0` aceita. Componha em
 *   [ReceiptLayout.printableDots] e isso não acontece.
 */
fun ReceiptLayout.monochromeRaster(bitmap: ThermalMonochromeBitmap): ByteArray? {
    // A largura é conferida AQUI, e essa é a única divergência deliberada em relação ao lado Swift,
    // onde a recusa mora só no emissor. O motivo é a linguagem: os emissores cobram o contrato do
    // comando com `require`, ou seja, lançam — e a assinatura acordada para este caminho é
    // `ByteArray?`. Traduzir exceção em `null` com `runCatching` engoliria junto qualquer bug real
    // do emissor. O preço é uma regra escrita duas vezes, e ele é pago por um teste que prova que as
    // duas concordam: onde este caminho devolve `null`, o emissor daquele dialeto lança.
    //
    // **A regra é do envelope, e não deste arquivo** — ver [RasterEmission.addressesWidth]. Ela
    // morava aqui como um literal de 65535, que é o teto do `GS v 0`, e aplicá-lo ao `ESC n` (teto
    // 255) recusaria tarde ou lançaria onde devia devolver `null`.
    if (!rasterEmission.addressesWidth(bitmap.widthDots)) return null
    return rasterEmission.emit(
        MonochromeBitmapRasterSource(bitmap),
        stripeHeightDots = rasterStripeHeightDots,
        verticalRasterScale = verticalRasterScale,
    )
}

/** `GS v 0` conta a largura em dois bytes; acima disto não há comando a montar. */

/**
 * O bitmap visto como fonte de faixas, sem uma segunda cópia dos pontos.
 *
 * Empacota MSB-first, byte a byte igual ao que `qrRaster`, `barcodeRaster` e a conversão de imagem
 * já fazem — a conta `0x80 shr (x % 8)` é literalmente a mesma, e é ela que faz este caminho não
 * ter bytes próprios. A leitura é sequencial porque o emissor lê em ordem, e porque a fonte
 * esticada de [ReceiptLayout.verticalRasterScale] lê em blocos do tamanho da banda; aqui, ao
 * contrário do Floyd–Steinberg, ler fora de ordem não daria resultado errado — só não é preciso.
 */
/**
 * A ponte entre o bitmap já composto e o emissor do dialeto.
 *
 * Deixou de ser privada com o conserto de 27/08/2026: ela é a fonte que os DOIS emissores recebem, e
 * a prova que fixa a igualdade byte a byte com cada um precisa montá-la do mesmo jeito que este
 * caminho monta. Reimplementá-la no teste faria a prova concordar consigo mesma.
 */
internal class MonochromeBitmapRasterSource(
    private val bitmap: ThermalMonochromeBitmap,
) : OneBitRasterSource {
    override val widthDots: Int = bitmap.widthDots
    override val heightDots: Int = bitmap.heightDots

    private val widthBytes = widthDots / EscPosRasterEmitter.BITS_PER_BYTE

    override fun readStripe(
        startY: Int,
        stripeHeight: Int,
        destination: ByteArray,
    ) {
        require(startY >= 0 && stripeHeight > 0 && startY + stripeHeight <= heightDots) {
            "Faixa raster fora do bitmap."
        }
        require(destination.size == widthBytes * stripeHeight) { "Buffer de faixa raster inválido." }
        for (row in 0 until stripeHeight) {
            val sourceOffset = (startY + row) * widthDots
            val destinationOffset = row * widthBytes
            for (x in 0 until widthDots) {
                if (!bitmap.blackPixels[sourceOffset + x]) continue
                val index = destinationOffset + x / EscPosRasterEmitter.BITS_PER_BYTE
                destination[index] =
                    (
                        destination[index].toInt() or
                            (0x80 shr (x % EscPosRasterEmitter.BITS_PER_BYTE))
                    ).toByte()
            }
        }
    }
}
