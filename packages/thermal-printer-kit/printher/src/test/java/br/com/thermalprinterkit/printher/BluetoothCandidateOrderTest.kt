package br.com.thermalprinterkit.printher

import br.com.thermalprinterkit.BluetoothPrinterCandidate
import org.junit.Assert.assertEquals
import org.junit.Test

class BluetoothCandidateOrderTest {
    @Test
    fun `provaveis primeiro, depois quem tem nome, e sem nome por ultimo`() {
        val provavel = BluetoothPrinterCandidate(1, "MTP-II_BD7E")
        val comNome = BluetoothPrinterCandidate(2, "T210_D0E9")
        val semNome = BluetoothPrinterCandidate(3, "Aparelho sem nome 1", named = false)

        val (provaveis, outros) =
            orderBluetoothCandidates(listOf(semNome, comNome, provavel), setOf(1L))

        assertEquals(listOf(provavel), provaveis)
        assertEquals(listOf(comNome, semNome), outros)
    }

    @Test
    fun `sem nenhum provavel a lista ainda separa nomeados de anonimos`() {
        val comNome = BluetoothPrinterCandidate(1, "T210_D0E9")
        val semNome = BluetoothPrinterCandidate(2, "Aparelho sem nome 1", named = false)

        val (provaveis, outros) =
            orderBluetoothCandidates(listOf(semNome, comNome), emptySet())

        assertEquals(emptyList<BluetoothPrinterCandidate>(), provaveis)
        assertEquals(listOf(comNome, semNome), outros)
    }
}
