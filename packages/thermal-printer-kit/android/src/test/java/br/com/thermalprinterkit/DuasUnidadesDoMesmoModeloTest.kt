package br.com.thermalprinterkit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Duas unidades do mesmo modelo são duas instalações.
 *
 * O defeito que estes testes fixam foi observado no A07 em 18/08: instalar a T210 fez a MTP-II
 * desaparecer da lista, sem confirmação e sem aviso. A causa era a instalação ser chaveada só pelo
 * perfil — duas impressoras que compartilhassem perfil não podiam coexistir, e a segunda evictava
 * a primeira levando junto uma instalação que uma pessoa tinha confirmado olhando o papel.
 */
class DuasUnidadesDoMesmoModeloTest {
    private val perfil = "generic.portable58.escpos"
    private val balcao = "aa:bb:cc:dd:ee:01"
    private val reserva = "aa:bb:cc:dd:ee:02"

    private fun ble(address: String?, profileId: String = perfil) =
        PersistedPrinterSelection.BluetoothLe(profileId = profileId, address = address)

    @Test
    fun `duas unidades do mesmo modelo coexistem`() {
        val depois = PersistedPrinterSelections().with(ble(balcao)).with(ble(reserva))

        assertEquals(
            "A segunda unidade apagou a primeira.",
            2,
            depois.selections.size,
        )
    }

    /** Readotar a MESMA unidade substitui: a lista não pode encher de duplicatas da mesma máquina. */
    @Test
    fun `readotar a mesma unidade substitui em vez de duplicar`() {
        val depois = PersistedPrinterSelections().with(ble(balcao)).with(ble(balcao))

        assertEquals(1, depois.selections.size)
    }

    /** Sem endereço conhecido não há como distinguir unidade; volta a valer o perfil sozinho. */
    @Test
    fun `sem identidade fisica a chave continua sendo o perfil`() {
        val depois = PersistedPrinterSelections().with(ble(null)).with(ble(null))

        assertEquals(1, depois.selections.size)
        assertEquals(perfil, depois.selections.single().installationId)
    }

    @Test
    fun `a instalacao ativa e a unidade, nao o modelo`() {
        val depois = PersistedPrinterSelections().with(ble(balcao)).with(ble(reserva))

        assertEquals(ble(reserva).installationId, depois.activeSelection?.installationId)
        assertNotEquals(ble(balcao).installationId, depois.activeSelection?.installationId)
    }

    @Test
    fun `remover uma unidade preserva a irma`() {
        val duas = PersistedPrinterSelections().with(ble(balcao)).with(ble(reserva))

        val restante = duas.withoutInstallation(ble(reserva).installationId)

        assertEquals(1, restante.selections.size)
        assertEquals(ble(balcao).installationId, restante.selections.single().installationId)
    }

    /** Removida a ativa, a irmã assume — a instalação não pode ficar sem quem receba o cupom. */
    @Test
    fun `removida a ativa, a irma assume`() {
        val duas = PersistedPrinterSelections().with(ble(balcao)).with(ble(reserva))

        val restante = duas.withoutInstallation(duas.activeSelection!!.installationId)

        assertEquals(ble(balcao).installationId, restante.activeSelection?.installationId)
    }

    /**
     * O id da instalação não pode reconstruir o endereço.
     *
     * Ele atravessa a superfície e chega ao app hospedeiro; o `AGENTS.md` proíbe MAC, endereço e
     * serial fora do store cifrado.
     */
    @Test
    fun `o id da instalacao nao carrega o endereco`() {
        val id = ble(balcao).installationId

        assertTrue("O id precisa começar pelo perfil.", id.startsWith(perfil))
        assertTrue(
            "O endereço vazou no id da instalação: $id",
            !id.contains(balcao) && !id.contains(balcao.replace(":", "")),
        )
    }

    /** Unidades diferentes precisam de ids diferentes, senão a coexistência não se sustenta. */
    @Test
    fun `unidades diferentes tem ids diferentes`() {
        assertNotEquals(ble(balcao).installationId, ble(reserva).installationId)
    }

    /** Mesma unidade, mesmo id — é o que faz a readoção substituir em vez de duplicar. */
    @Test
    fun `a mesma unidade produz sempre o mesmo id`() {
        assertEquals(ble(balcao).installationId, ble(balcao).installationId)
    }

    /** O mesmo endereço em transportes diferentes é a mesma máquina por dois caminhos. */
    @Test
    fun `transportes diferentes nao colidem`() {
        val porBle = PersistedPrinterSelection.BluetoothLe(perfil, balcao)
        val porSpp = PersistedPrinterSelection.Bluetooth(perfil, balcao)

        assertNotEquals(porBle.installationId, porSpp.installationId)
    }

    @Test
    fun `duas USB do mesmo modelo se distinguem pelo serial`() {
        val primeira =
            PersistedPrinterSelection.Usb(perfil, UsbConnectionIdentity(0x1234, 0x5678, "A1"))
        val segunda =
            PersistedPrinterSelection.Usb(perfil, UsbConnectionIdentity(0x1234, 0x5678, "B2"))

        assertEquals(2, PersistedPrinterSelections().with(primeira).with(segunda).selections.size)
    }

    @Test
    fun `duas Wi-Fi do mesmo modelo se distinguem pelo endpoint`() {
        val primeira =
            PersistedPrinterSelection.LocalWifi(perfil, PersistedNetworkEndpoint("192.168.1.10", 9100))
        val segunda =
            PersistedPrinterSelection.LocalWifi(perfil, PersistedNetworkEndpoint("192.168.1.11", 9100))

        assertEquals(2, PersistedPrinterSelections().with(primeira).with(segunda).selections.size)
    }
}
