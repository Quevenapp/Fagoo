package br.com.thermalprinterkit

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * A conversão compartilhada, provada **dentro do AAR** e sem aparelho.
 *
 * Por que este teste existe além do instrumentado: a suíte obrigatória do kit roda em JVM, e um
 * gabarito que só o aparelho consegue conferir é um gabarito que ninguém confere no dia a dia.
 * Aqui a fronteira de plataforma é substituída por um leitor de pixels que devolve exatamente os
 * pixels da imagem — que é o que o `Canvas` do Android devolve quando a imagem cabe na largura e
 * é opaca, e é isso que `RasterImagemVetorInstrumentedTest` confere no aparelho de verdade.
 *
 * Os bytes esperados são os MESMOS literais de `ImagemNaJvmTest` e de
 * `RasterImagemVetorInstrumentedTest`, medidos em SM-A075M e SM-X230 com o código anterior a esta
 * frente. Se este teste ficar vermelho, o núcleo compartilhado mudou de bytes — e o caminho de
 * imagem do Android está homologado em papel.
 */
class PixelOneBitRasterSourceTest {
    @Test
    fun `foto opaca vira os bytes medidos no aparelho`() {
        assertArrayEquals(bytesDe(VETOR_FLOYD_STEINBERG), emitir(ThermalImageMode.FLOYD_STEINBERG))
    }

    @Test
    fun `logotipo por limiar vira os bytes medidos no aparelho`() {
        assertArrayEquals(bytesDe(VETOR_LIMIAR), emitir(ThermalImageMode.THRESHOLD))
    }

    @Test
    fun `o erro do floyd-steinberg atravessa a emenda das bandas`() {
        assertArrayEquals(
            bytesDe(VETOR_FLOYD_STEINBERG_BANDA_8),
            emitir(ThermalImageMode.FLOYD_STEINBERG, banda = 8),
        )
    }

    @Test
    fun `a compensacao vertical nao muda a conversao, so repete linha`() {
        assertArrayEquals(
            bytesDe(VETOR_FLOYD_STEINBERG_ESCALA_080),
            emitir(ThermalImageMode.FLOYD_STEINBERG, escala = 0.8),
        )
    }

    @Test
    fun `imagem estreita ganha branco ate o byte e sai centrada`() {
        // 13 dots em 16: sobra 3, e a divisão inteira põe 1 à esquerda e 2 à direita. O
        // preenchimento é o que faz um logotipo estreito não nascer colado na margem.
        val geometria = OneBitRasterGeometry.of(sourceWidth = 13, sourceHeight = 25, printableDots = 16)

        assertEquals(13, geometria.contentWidth)
        assertEquals(16, geometria.widthDots)
        assertEquals(25, geometria.heightDots)
        assertEquals(1, geometria.leftPadding)
    }

    @Test
    fun `imagem mais larga que o papel reduz proporcionalmente e nunca some`() {
        val reduzida = OneBitRasterGeometry.of(sourceWidth = 32, sourceHeight = 20, printableDots = 16)
        assertEquals(16, reduzida.contentWidth)
        assertEquals(10, reduzida.heightDots)

        // Uma tira de 1 dot de altura reduzida a 1/100 arredondaria para zero, e o emissor
        // recusaria a altura. Uma linha é o piso: imagem que existe não pode virar nada.
        val fininha = OneBitRasterGeometry.of(sourceWidth = 800, sourceHeight = 1, printableDots = 8)
        assertEquals(1, fininha.heightDots)
    }

    @Test
    fun `faixa lida fora de ordem e recusada`() {
        val fonte = fonte(ThermalImageMode.FLOYD_STEINBERG, banda = 8)
        val destino = ByteArray(2 * 8)
        fonte.readStripe(0, 8, destino)

        // A ordem não é conveniência: o acumulador de erro da linha 7 é a entrada da linha 8.
        assertThrows(IllegalArgumentException::class.java) { fonte.readStripe(0, 8, destino) }
        assertThrows(IllegalArgumentException::class.java) { fonte.readStripe(16, 8, destino) }
        fonte.clear()
    }

    @Test
    fun `o portao de largura e o mesmo dos dois lados`() {
        assertEquals(true, isPrintableWidthSupported(8))
        assertEquals(true, isPrintableWidthSupported(640))
        assertEquals(false, isPrintableWidthSupported(4))
        assertEquals(false, isPrintableWidthSupported(648))
        // Largura que não fecha em byte não tem como virar `GS v 0`.
        assertEquals(false, isPrintableWidthSupported(12))
    }

    private fun emitir(
        mode: ThermalImageMode,
        banda: Int = DEFAULT_RASTER_STRIPE_HEIGHT_DOTS,
        escala: Double? = null,
    ): ByteArray {
        val fonte = fonte(mode, banda)
        return try {
            EscPosRasterEmitter.emit(fonte, banda, escala)
        } finally {
            fonte.clear()
        }
    }

    private fun fonte(
        mode: ThermalImageMode,
        banda: Int,
    ): PixelOneBitRasterSource {
        val geometria = OneBitRasterGeometry.of(LARGURA, ALTURA, PRINTABLE_DOTS)
        return PixelOneBitRasterSource(geometria, LeitorDoCampoDeTeste, mode, banda)
    }

    private fun bytesDe(hex: String): ByteArray =
        ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    /**
     * O que a plataforma entregaria: os pixels da imagem, sem filtro nenhum.
     *
     * É o comportamento medido do Android quando a imagem cabe na largura imprimível e é opaca —
     * o `drawBitmap` 1:1 é cópia. Fora desse recorte, quem responde é o aparelho, e é o
     * instrumentado que pergunta.
     */
    private object LeitorDoCampoDeTeste : RasterStripePixelReader {
        override fun readPixels(
            startY: Int,
            stripeHeight: Int,
            destination: IntArray,
        ) {
            for (y in 0 until stripeHeight) {
                for (x in 0 until LARGURA) {
                    destination[y * LARGURA + x] = corDoPixel(x, startY + y)
                }
            }
        }

        override fun clear() = Unit
    }

    private companion object {
        const val LARGURA = 13
        const val ALTURA = 25
        const val PRINTABLE_DOTS = 16

        /** Mesma fórmula de `ImagemNaJvmTest` e de `RasterImagemVetorInstrumentedTest`. */
        fun corDoPixel(
            x: Int,
            y: Int,
        ): Int {
            val r = (x * 29 + y * 7) and 0xff
            val g = (x * 11 + y * 23 + 40) and 0xff
            val b = (x * 53 + y * 3 + 90) and 0xff
            return (0xff shl 24) or (r shl 16) or (g shl 8) or b
        }

        // Gabarito medido em SM-A075M e SM-X230 (Android 16) com o código ANTERIOR a esta frente.
        const val VETOR_FLOYD_STEINBERG =
            "1b61011d7630000200180076a85a286950542455542018547c0be84d743ad06d" +
                "a86ad45550554051282944449c127441d407e81ea877a4555056a41d76300002" +
                "0001002a84"

        const val VETOR_LIMIAR =
            "1b61011d763000020018007e307e30742078006004401c007c03fc0ff83ff87e" +
                "f07ce079c0694040004004001c007c01fc07f41fe07fe07fc077801d76300002" +
                "0001004600"

        const val VETOR_FLOYD_STEINBERG_BANDA_8 =
            "1b61011d7630000200080076a85a286950542455542018547c0be81d76300002" +
                "0008004d743ad06da86ad455505540512829441d76300002000800449c127441" +
                "d407e81ea877a4555056a41d763000020001002a84"

        const val VETOR_FLOYD_STEINBERG_ESCALA_080 =
            "1b61011d7630000200180076a876a85a2869505424555455542018547c0be84d" +
                "744d743ad06da86ad455505550554051282944449c449c127441d41d76300002" +
                "00070007e81ea81ea877a4555056a42a84"
    }
}
