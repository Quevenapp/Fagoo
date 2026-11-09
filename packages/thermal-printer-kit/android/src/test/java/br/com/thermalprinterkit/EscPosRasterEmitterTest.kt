package br.com.thermalprinterkit

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class EscPosRasterEmitterTest {
    @Test
    fun `xadrez oito por oito fixa os bytes do emissor GS v 0`() {
        val checkerboard =
            object : OneBitRasterSource {
                override val widthDots = 8
                override val heightDots = 8

                override fun readStripe(
                    startY: Int,
                    stripeHeight: Int,
                    destination: ByteArray,
                ) {
                    for (stripeY in 0 until stripeHeight) {
                        val y = startY + stripeY
                        for (x in 0 until widthDots) {
                            if ((x + y) % 2 == 0) {
                                destination[stripeY] =
                                    (destination[stripeY].toInt() or (0x80 shr x)).toByte()
                            }
                        }
                    }
                }
            }

        assertArrayEquals(
            byteArrayOf(
                0x1b, 0x61, 0x01,
                0x1d, 0x76, 0x30, 0x00,
                0x01, 0x00, 0x08, 0x00,
                0xaa.toByte(), 0x55, 0xaa.toByte(), 0x55,
                0xaa.toByte(), 0x55, 0xaa.toByte(), 0x55,
            ),
            EscPosRasterEmitter.emit(checkerboard),
        )
    }

    @Test
    fun `altura maior que 24 eh solicitada e emitida por faixa`() {
        val calls = mutableListOf<Pair<Int, Int>>()
        val source =
            object : OneBitRasterSource {
                override val widthDots = 8
                override val heightDots = 25

                override fun readStripe(
                    startY: Int,
                    stripeHeight: Int,
                    destination: ByteArray,
                ) {
                    calls += startY to stripeHeight
                    destination.fill(0xff.toByte())
                }
            }

        val command = EscPosRasterEmitter.emit(source)

        assertEquals(listOf(0 to 24, 24 to 1), calls)
        assertEquals(3 + 8 + 24 + 8 + 1, command.size)
        assertArrayEquals(
            byteArrayOf(0x1d, 0x76, 0x30, 0x00, 0x01, 0x00, 0x01, 0x00),
            command.copyOfRange(35, 43),
        )
        command.fill(0)
    }

    /**
     * A altura de banda é parâmetro, e o padrão continua sendo o de sempre.
     *
     * Este é o teste de neutralidade do botão de bancada: sem ninguém pedir altura, os bytes são
     * **os mesmos** de quando o número era constante. Se um dia alguém mudar o padrão, é aqui que
     * a suíte grita.
     */
    @Test
    fun `sem pedir altura, o emissor devolve exatamente os bytes de 24 linhas`() {
        assertEquals(24, DEFAULT_RASTER_STRIPE_HEIGHT_DOTS)
        assertArrayEquals(
            EscPosRasterEmitter.emit(listras(heightDots = 100), 24),
            EscPosRasterEmitter.emit(listras(heightDots = 100)),
        )
    }

    @Test
    fun `banda menor emite mais comandos com os mesmos pontos pretos`() {
        val chamadas = mutableListOf<Pair<Int, Int>>()
        val padrao = EscPosRasterEmitter.emit(listras(heightDots = 96))
        val curta = EscPosRasterEmitter.emit(listras(heightDots = 96, calls = chamadas), 8)

        // Doze bandas de oito no lugar de quatro de vinte e quatro: oito cabeçalhos a mais, e nem um
        // ponto preto a mais. É isto que a bancada troca ao encurtar a banda.
        assertEquals(List(12) { it * 8 to 8 }, chamadas)
        assertEquals(padrao.size + 8 * 8, curta.size)
        assertArrayEquals(pontos(padrao, 24), pontos(curta, 8))
    }

    @Test
    fun `altura de banda fora da faixa e recusada antes de montar byte nenhum`() {
        assertEquals(1..24, RASTER_STRIPE_HEIGHT_RANGE)
        listOf(0, -1, 25).forEach { invalida ->
            assertThrows(IllegalArgumentException::class.java) {
                EscPosRasterEmitter.emit(listras(heightDots = 48), invalida)
            }
        }
    }

    /** Fonte de listras horizontais: o conteúdo depende de `y`, então emenda errada apareceria. */
    private fun listras(
        heightDots: Int,
        calls: MutableList<Pair<Int, Int>>? = null,
    ): OneBitRasterSource =
        object : OneBitRasterSource {
            override val widthDots = 16
            override val heightDots = heightDots

            override fun readStripe(
                startY: Int,
                stripeHeight: Int,
                destination: ByteArray,
            ) {
                calls?.add(startY to stripeHeight)
                for (stripeY in 0 until stripeHeight) {
                    val y = startY + stripeY
                    destination[stripeY * 2] = (y % 251).toByte()
                    destination[stripeY * 2 + 1] = (y % 199).toByte()
                }
            }
        }

    /** Só os pontos pretos, sem alinhamento e sem cabeçalho de banda. */
    private fun pontos(
        command: ByteArray,
        stripeHeightDots: Int,
    ): ByteArray {
        val saida = mutableListOf<Byte>()
        var offset = 3
        while (offset < command.size) {
            val altura = command[offset + 6].toInt() and 0xff
            offset += 8
            val bytes = 2 * altura
            saida += command.copyOfRange(offset, offset + bytes).toList()
            offset += bytes
            assertTrue(altura <= stripeHeightDots)
        }
        return saida.toByteArray()
    }

    /**
     * Neutralidade do fator: sem fator, byte a byte o que já saía.
     *
     * É o teste que protege a impressora que nunca teve defeito. A compensação existe para a
     * firmware que encolhe raster largo — medida em 20/08 na Inico T210 —, e ligar isso para todo
     * mundo esticaria a foto de quem imprime certo.
     */
    @Test
    fun `sem fator, o emissor devolve exatamente os bytes de sempre`() {
        val semFator = EscPosRasterEmitter.emit(listras(heightDots = 100))

        assertArrayEquals(
            semFator,
            EscPosRasterEmitter.emit(listras(heightDots = 100), 24, null),
        )
        // Fator 1,0 é "medi e não encolhe": a conta devolve a mesma altura, e nada é reamostrado.
        assertArrayEquals(
            semFator,
            EscPosRasterEmitter.emit(listras(heightDots = 100), 24, 1.0),
        )
    }

    /**
     * Fator 0,80 manda 1,25x linhas, repetindo linha — e a impressora devolve a altura pretendida.
     *
     * Oito linhas viram dez, e o mapeamento é `outY * 8 / 10`: a primeira e a quinta linhas saem
     * duas vezes, as outras uma. Cada linha da origem é lida **uma** vez e em ordem, que é o que o
     * Floyd–Steinberg exige — o erro de uma linha alimenta a seguinte, e reler quebraria a difusão.
     */
    @Test
    fun `fator 0,8 estica a altura em 1,25x repetindo linha`() {
        val chamadas = mutableListOf<Pair<Int, Int>>()
        val original = EscPosRasterEmitter.emit(listras(heightDots = 8))
        val compensado =
            EscPosRasterEmitter.emit(listras(heightDots = 8, calls = chamadas), 24, 0.8)

        assertEquals(10, compensadoAltura(compensado))
        assertEquals(listOf(0 to 8), chamadas)

        val origem = pontos(original, 24)
        val esperado =
            listOf(0, 0, 1, 2, 3, 4, 4, 5, 6, 7)
                .flatMap { linha -> origem.copyOfRange(linha * 2, linha * 2 + 2).toList() }
        assertArrayEquals(esperado.toByteArray(), pontos(compensado, 24))
    }

    /** A conta é a mesma dos dois lados: 800 linhas com fator 0,80 são 1.000 enviadas. */
    @Test
    fun `a altura compensada é arredondada e nunca encolhe`() {
        assertEquals(1_000, compensatedRasterHeightDots(800, 0.8))
        assertEquals(800, compensatedRasterHeightDots(800, 1.0))
        // 97/100 de 100 linhas dão 103,09; arredondar para baixo devolveria papel curto de novo.
        assertEquals(103, compensatedRasterHeightDots(100, 0.97))
        assertEquals(2, compensatedRasterHeightDots(1, 0.5))
    }

    /** A banda continua sendo a banda: compensar não muda a altura de cada `GS v 0`. */
    @Test
    fun `o fator convive com a altura de banda pedida`() {
        val compensado = EscPosRasterEmitter.emit(listras(heightDots = 96), 8, 0.5)

        assertEquals(192, compensadoAltura(compensado))
        var offset = 3
        var bandas = 0
        while (offset < compensado.size) {
            assertEquals(8, compensado[offset + 6].toInt() and 0xff)
            offset += 8 + 2 * 8
            bandas += 1
        }
        assertEquals(24, bandas)
    }

    @Test
    fun `fator fora da faixa e recusado antes de montar byte nenhum`() {
        assertEquals(0.5..1.0, VERTICAL_RASTER_SCALE_RANGE)
        listOf(0.0, 0.49, 1.01, -0.8).forEach { invalido ->
            assertThrows(IllegalArgumentException::class.java) {
                EscPosRasterEmitter.emit(listras(heightDots = 48), 24, invalido)
            }
        }
    }

    /** Altura total declarada nos cabeçalhos `GS v 0`, somando as bandas. */
    private fun compensadoAltura(command: ByteArray): Int {
        var offset = 3
        var altura = 0
        while (offset < command.size) {
            val bandaAltura = command[offset + 6].toInt() and 0xff
            altura += bandaAltura
            offset += 8 + 2 * bandaAltura
        }
        return altura
    }

    @Test
    fun `scratch da faixa eh zerado mesmo quando a conversao falha`() {
        var scratch: ByteArray? = null
        val source =
            object : OneBitRasterSource {
                override val widthDots = 8
                override val heightDots = 1

                override fun readStripe(
                    startY: Int,
                    stripeHeight: Int,
                    destination: ByteArray,
                ) {
                    scratch = destination
                    destination.fill(0x5a)
                    error("falha sintética")
                }
            }

        assertThrows(IllegalStateException::class.java) { EscPosRasterEmitter.emit(source) }
        assertTrue(requireNotNull(scratch).all { it == 0.toByte() })
    }
}
