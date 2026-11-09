package br.com.thermalprinterkit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * O canal SPP é solto por ociosidade, e não segurado para sempre nem fechado a cada cupom.
 *
 * **O módulo Bluetooth aceita uma conexão só.** Segurar o socket entre as fichas de uma venda tirou
 * o intervalo de reconexão de cada uma — mas segurar indefinidamente monopoliza a impressora: de
 * fora, um aparelho que ainda tem o canal é indistinguível de uma impressora desligada. Foi visto na
 * bancada: com o Android conectado a luz fica azul e os iPhones deixam de encontrar o aparelho.
 *
 * Aqui a política é exercida sem Bluetooth nenhum, mas é a **mesma** [SppOciosidade] que o
 * `AndroidBluetoothThermalPort` usa. A versão anterior deste teste trazia uma cópia da regra, e a
 * cópia marcava atividade a cada escrita enquanto o port marcava só no `drain` — foi assim que a
 * suíte ficou verde enquanto o disparo fechava o socket no meio da sonda.
 */
class SppIdleReleaseTest {

    /**
     * Um relógio que anda quando o teste manda. Tempo real aqui só traria lentidão e intermitência,
     * e o que interessa é a fronteira do prazo.
     */
    private class Relogio(var agora: Long = 0L) {
        fun avanca(millis: Long) {
            agora += millis
        }
    }

    private fun ociosidade(relogio: Relogio) =
        SppOciosidade(AndroidBluetoothThermalPort.DEFAULT_IDLE_RELEASE_MILLIS) { relogio.agora }

    @Test
    fun `as fichas da mesma venda nao pagam reconexao`() {
        val relogio = Relogio()
        val ociosidade = ociosidade(relogio)

        // Cinco cervejas, cinco fichas, com o intervalo de quem destaca e entrega uma a uma.
        repeat(5) {
            ociosidade.tocou()
            relogio.avanca(1_500)
        }

        assertFalse("o canal não pode cair no meio de uma venda", ociosidade.esgotada())
    }

    @Test
    fun `numa pausa de verdade a impressora e devolvida`() {
        val relogio = Relogio()
        val ociosidade = ociosidade(relogio)

        ociosidade.tocou()
        relogio.avanca(AndroidBluetoothThermalPort.DEFAULT_IDLE_RELEASE_MILLIS)

        assertTrue("é nesta pausa que o outro aparelho quer a impressora", ociosidade.esgotada())
    }

    /**
     * O disparo pode chegar depois de a venda seguinte ter começado — ele espera o lock enquanto a
     * escrita acontece. Fechar aí cortaria um cupom no meio.
     */
    @Test
    fun `disparo atrasado nao fecha canal que voltou a ser usado`() {
        val relogio = Relogio()
        val ociosidade = ociosidade(relogio)

        ociosidade.tocou()
        relogio.avanca(AndroidBluetoothThermalPort.DEFAULT_IDLE_RELEASE_MILLIS + 1)
        // A venda seguinte começou enquanto o disparo esperava.
        ociosidade.tocou()

        assertFalse(ociosidade.esgotada())
    }

    /**
     * A homologação é o caso que cobra isto: a pessoa lê a tira, decide e só então responde, e essa
     * pausa encosta nos dez segundos. Medido no A07 com a KPrinter — a sonda de acentuação voltava
     * "A sonda não foi enviada" porque o disparo, armado pelo `drain` da sonda anterior, fechava o
     * socket entre o `open` e a primeira escrita. Abrir é tocar no transporte, e adia o prazo.
     */
    @Test
    fun `abrir para a sonda seguinte adia o disparo armado pela anterior`() {
        val relogio = Relogio()
        val ociosidade = ociosidade(relogio)

        ociosidade.tocou() // drain da sonda anterior
        relogio.avanca(AndroidBluetoothThermalPort.DEFAULT_IDLE_RELEASE_MILLIS - 200)
        ociosidade.tocou() // open da sonda de acentuação, reaproveitando o canal
        relogio.avanca(200) // o disparo antigo chega aqui, no meio do trabalho

        assertFalse("a sonda seguinte já tinha começado", ociosidade.esgotada())
    }

    /** Raster grande demora mais que o prazo; cada bloco escrito precisa adiar a soltura. */
    @Test
    fun `escrita longa nao e interrompida pelo prazo`() {
        val relogio = Relogio()
        val ociosidade = ociosidade(relogio)

        ociosidade.tocou()
        repeat(30) {
            relogio.avanca(500)
            ociosidade.tocou() // um bloco de 256 bytes
        }

        assertEquals(15_000, relogio.agora)
        assertFalse("o cupom ainda estava saindo", ociosidade.esgotada())
    }
}
