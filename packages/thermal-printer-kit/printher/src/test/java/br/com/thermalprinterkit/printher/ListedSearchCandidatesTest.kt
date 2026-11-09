package br.com.thermalprinterkit.printher

import br.com.thermalprinterkit.BluetoothPrinterCandidate
import br.com.thermalprinterkit.ThermalPrinterState
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * A busca por Wi-Fi, por rede local e por USB listava as candidatas de Bluetooth encontradas antes,
 * porque as três listas eram desenhadas sem condição e só se calam quando estão vazias. A tela
 * dizia "Procurando por Wi-Fi da impressora" acima de `MTP-II_BD7E` e `T210_D0E9`.
 */
class ListedSearchCandidatesTest {
    private val bluetooth = listOf("MTP-II_BD7E", "T210_D0E9")
    private val usb = listOf(1L, 2L)
    private val wifi = listOf("192.168.1.50")

    @Test
    fun `cada transporte mostra apenas a própria lista`() {
        val esperado =
            mapOf(
                PrinterConnectionChoice.BLUETOOTH to Triple(bluetooth, emptyList<Long>(), emptyList<String>()),
                PrinterConnectionChoice.USB to Triple(emptyList(), usb, emptyList()),
                PrinterConnectionChoice.DIRECT_WIFI to Triple(emptyList(), emptyList(), wifi),
                PrinterConnectionChoice.LOCAL_NETWORK to Triple(emptyList(), emptyList(), wifi),
            )

        esperado.forEach { (connection, alvo) ->
            val listadas = candidatesOfSelectedConnection(connection, bluetooth, usb, wifi)
            assertEquals(
                "Transporte $connection",
                alvo,
                Triple(listadas.bluetooth, listadas.usb, listadas.wifi),
            )
        }
    }

    /**
     * A lista sumiu e a tela continuou mentindo: sob "Procurando por Wi-Fi da impressora" ficaram a
     * pílula "Escolha uma Bluetooth" e "29 aparelhos encontrados" — e, como a tela achava que já
     * tinha achado algo, o botão de procurar sumia junto.
     */
    @Test
    fun `estado de busca de outro transporte não descreve a tela atual`() {
        val bluetoothEncontrou =
            ThermalPrinterState.BluetoothCandidatesFound(
                listOf(BluetoothPrinterCandidate(id = 1, label = "MTP-II_BD7E")),
            )

        assertEquals(
            true,
            bluetoothEncontrou.belongsToSearchOf(PrinterConnectionChoice.BLUETOOTH),
        )
        listOf(
            PrinterConnectionChoice.USB,
            PrinterConnectionChoice.DIRECT_WIFI,
            PrinterConnectionChoice.LOCAL_NETWORK,
            null,
        ).forEach { connection ->
            assertEquals(
                "Bluetooth não descreve $connection",
                false,
                bluetoothEncontrou.belongsToSearchOf(connection),
            )
        }
    }

    @Test
    fun `os dois modos de rede compartilham o estado de busca, e Pronta vale em qualquer um`() {
        val rede = ThermalPrinterState.LocalWifiSearching

        assertEquals(true, rede.belongsToSearchOf(PrinterConnectionChoice.DIRECT_WIFI))
        assertEquals(true, rede.belongsToSearchOf(PrinterConnectionChoice.LOCAL_NETWORK))
        assertEquals(false, rede.belongsToSearchOf(PrinterConnectionChoice.USB))

        PrinterConnectionChoice.entries.forEach { connection ->
            assertEquals(
                "Pronta vale em $connection",
                true,
                ThermalPrinterState.Ready.belongsToSearchOf(connection),
            )
        }
    }

    @Test
    fun `sem transporte escolhido não sobra lista de busca anterior`() {
        val listadas = candidatesOfSelectedConnection(null, bluetooth, usb, wifi)

        assertEquals(emptyList<String>(), listadas.bluetooth)
        assertEquals(emptyList<Long>(), listadas.usb)
        assertEquals(emptyList<String>(), listadas.wifi)
    }
}
