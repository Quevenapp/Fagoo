package br.com.thermalprinterkit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * O ritmo do raster, exercido sem impressora e sem dormir de verdade.
 *
 * É a **mesma** [RasterThroughputPacer] que o `AndroidBleThermalPort` e o
 * `AndroidBluetoothThermalPort` usam. Uma cópia da regra aqui deixaria a suíte verde enquanto o
 * transporte solta a foto na velocidade do enlace — que é exatamente o defeito medido na T210 em
 * 20/08, onde a foto de 28 KB saía 22% mais curta e coerente, só encolhida.
 */
class RasterThroughputPacerTest {
    /** Relógio em microssegundos que só anda quando alguém dorme. */
    private class Bancada(var agoraMicros: Long = 0L) {
        val esperasMillis = mutableListOf<Long>()

        fun pacer(bytesPerSecond: Int?) =
            RasterThroughputPacer(
                bytesPerSecond = bytesPerSecond,
                nowMicros = { agoraMicros },
                sleepMillis = { millis ->
                    esperasMillis += millis
                    agoraMicros += millis * 1_000
                },
            )

        /** Só o que o transporte gasta por conta própria, sem o freio. */
        fun trabalhou(millis: Long) {
            agoraMicros += millis * 1_000
        }
    }

    @Test
    fun `sem teto ninguem espera`() {
        val bancada = Bancada()
        val pacer = bancada.pacer(null)

        repeat(200) { pacer.pace(244) }

        assertTrue("Perfil sem medição precisa sair byte a byte como sempre saiu.", bancada.esperasMillis.isEmpty())
        assertEquals(0L, bancada.agoraMicros)
    }

    @Test
    fun `o primeiro bloco sai na hora`() {
        val bancada = Bancada()

        bancada.pacer(8_192).pace(244)

        assertTrue(bancada.esperasMillis.isEmpty())
    }

    /**
     * A foto do cachorro, em blocos de MTU, com o teto que a bancada quer experimentar.
     *
     * A conta que interessa é uma só: bytes por segundo efetivos não podem passar do teto.
     */
    @Test
    fun `a foto inteira respeita o teto declarado`() {
        val bancada = Bancada()
        val teto = 8_192
        val pacer = bancada.pacer(teto)
        val bloco = 244
        val blocos = 120

        repeat(blocos) { pacer.pace(bloco) }

        val bytes = (bloco * blocos).toLong()
        val decorridoMicros = bancada.agoraMicros
        // O primeiro bloco não espera, então a taxa se mede sobre o que veio depois dele.
        val vazao = (bytes - bloco) * 1_000_000 / decorridoMicros
        assertTrue("Vazão de $vazao B/s passou do teto de $teto B/s.", vazao <= teto)
    }

    /** Baixar o teto precisa custar tempo proporcional; é isso que a bancada vai enxergar. */
    @Test
    fun `metade do teto custa o dobro do tempo`() {
        val rapido = Bancada()
        val lento = Bancada()
        val comRapido = rapido.pacer(16_384)
        val comLento = lento.pacer(8_192)

        repeat(64) {
            comRapido.pace(256)
            comLento.pace(256)
        }

        assertEquals(2 * rapido.agoraMicros, lento.agoraMicros)
    }

    /**
     * Transporte já lento não vira crédito.
     *
     * Se o atraso do rádio fosse guardado como saldo, o bloco seguinte sairia em rajada — e rajada
     * é o próprio defeito que o teto existe para conter.
     */
    @Test
    fun `atraso do transporte nao vira rajada depois`() {
        val bancada = Bancada()
        val pacer = bancada.pacer(8_192)

        pacer.pace(256)
        bancada.trabalhou(500) // o rádio demorou muito mais que os 31 ms do teto
        pacer.pace(256)
        val esperasAteAqui = bancada.esperasMillis.size
        pacer.pace(256)

        assertEquals("O bloco após o atraso não podia esperar.", 0, esperasAteAqui)
        assertEquals("O bloco seguinte volta a pagar o teto inteiro.", listOf(32L), bancada.esperasMillis)
    }

    @Test
    fun `teto fora da faixa e recusado em vez de virar espera absurda`() {
        assertThrows(IllegalArgumentException::class.java) { Bancada().pacer(0) }
        assertThrows(IllegalArgumentException::class.java) { Bancada().pacer(-1) }
        assertThrows(IllegalArgumentException::class.java) {
            Bancada().pacer(RASTER_BYTES_PER_SECOND_RANGE.last + 1)
        }
    }
}
